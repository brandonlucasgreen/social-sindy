/**
 * Same-origin proxy for Buffer channel avatars.
 *
 * WHY THIS EXISTS: Buffer hands back avatar URLs on whatever host happens to
 * own the image — `buffer-channel-avatars-bucket.s3.amazonaws.com`,
 * `cdn.bsky.app`, `media.licdn.com`, `yt3.ggpht.com`, `i.pinimg.com`, and any
 * Mastodon instance a user has an account on. That host set is open-ended, so
 * it cannot be enumerated in a CSP `img-src` allowlist, and the strict
 * `img-src 'self' data:` this app ships broke every single avatar in the
 * channel picker.
 *
 * Rather than widen the CSP, avatars are fetched by the Worker and re-served
 * from our own origin. That keeps `img-src 'self'` intact, and as a bonus the
 * visitor's browser never talks to LinkedIn's or Meta's CDN at all, so their IP
 * address is not handed to a dozen third parties just to render a page.
 *
 * Nothing is stored. Each URL is signed with an HMAC derived from
 * `ENCRYPTION_KEY` and verified on the way back in, so the proxy will only ever
 * fetch a URL this app itself minted — it is not an open relay.
 */

import { base64ToBytes } from './crypto.js';
import type { Env } from './env.js';

/** Path the proxy is mounted at. Mirrored in `src/index.tsx`. */
export const AVATAR_PATH = '/avatar';

/**
 * Domain separator baked into every signature. Prevents a signature minted for
 * some other purpose under the same key from being replayed here, and gives us
 * a lever to invalidate every outstanding avatar URL at once if the scheme ever
 * needs to change.
 */
const SIGNING_CONTEXT = 'avatar:v1:';

/**
 * Full HMAC-SHA-256 tag length. Kept untruncated on purpose: `crypto.subtle`
 * will then do the comparison itself, in constant time, and we avoid
 * hand-rolling a compare over a shortened tag.
 */
const SIGNATURE_BYTES = 32;

/** Avatars are thumbnails. Anything larger is a mistake or an attack. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** How long a browser may reuse an avatar before revalidating. */
const BROWSER_CACHE_SECONDS = 86_400;

/**
 * Upstream fetch budget. A slow third-party CDN must not hold a Worker request
 * open — the fallback initial renders instantly, so failing fast is cheap.
 */
const UPSTREAM_TIMEOUT_MS = 5_000;

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

async function signingKey(env: Pick<Env, 'ENCRYPTION_KEY'>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    base64ToBytes(env.ENCRYPTION_KEY) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(env: Pick<Env, 'ENCRYPTION_KEY'>, url: string): Promise<Uint8Array> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await signingKey(env),
    encoder.encode(SIGNING_CONTEXT + url) as BufferSource,
  );
  return new Uint8Array(mac);
}

/**
 * Only `https` upstreams. Credentials in the URL are rejected outright: they
 * would be forwarded to the upstream host, and a legitimate Buffer avatar URL
 * never carries them.
 */
function isProxyableUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password;
}

/**
 * Turns an upstream avatar URL into a signed same-origin path.
 *
 * Returns null when there is no avatar to proxy, which the caller renders as
 * the initial-and-brand-colour fallback instead.
 */
export async function proxiedAvatarUrl(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  avatar: string | null | undefined,
): Promise<string | null> {
  const upstream = avatar?.trim();
  if (!upstream || !isProxyableUrl(upstream)) return null;

  const signature = bytesToBase64Url(await sign(env, upstream));
  const params = new URLSearchParams({ u: bytesToBase64Url(encoder.encode(upstream)), s: signature });
  return `${AVATAR_PATH}?${params.toString()}`;
}

/**
 * Wraps a proxied avatar path as a CSS `url()` value, for the `--photo` custom
 * property the avatar disc reads.
 *
 * The disc uses a `background-image` rather than an `<img>` so that a failed
 * load renders nothing instead of a broken-image glyph — which means the URL
 * has to survive a trip through a `style` attribute. Everything
 * `proxiedAvatarUrl` produces is drawn from the base64url alphabet plus the
 * fixed path and separators, so the assertion below should never fire; it is
 * here so that a future change to the URL shape fails loudly rather than
 * quietly emitting something that could terminate the `url()` early.
 */
export function avatarCssValue(proxiedPath: string): string {
  if (!/^\/avatar\?u=[A-Za-z0-9_-]+&s=[A-Za-z0-9_-]+$/.test(proxiedPath)) {
    throw new Error('Refusing to inline an unexpected avatar path into CSS');
  }
  return `url('${proxiedPath}')`;
}

/**
 * Recovers the upstream URL from a signed request, or null if the signature
 * does not check out.
 *
 * Verification goes through `crypto.subtle.verify` rather than comparing
 * strings, so a wrong signature cannot be narrowed down a byte at a time by
 * timing the response.
 */
export async function verifiedAvatarTarget(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  params: URLSearchParams,
): Promise<string | null> {
  const encoded = params.get('u');
  const signature = params.get('s');
  if (!encoded || !signature) return null;

  let upstream: string;
  let mac: Uint8Array;
  try {
    upstream = new TextDecoder().decode(base64UrlToBytes(encoded));
    mac = base64UrlToBytes(signature);
  } catch {
    return null;
  }

  if (mac.length !== SIGNATURE_BYTES || !isProxyableUrl(upstream)) return null;

  const ok = await crypto.subtle.verify(
    'HMAC',
    await signingKey(env),
    mac as BufferSource,
    encoder.encode(SIGNING_CONTEXT + upstream) as BufferSource,
  );

  return ok ? upstream : null;
}

/**
 * Fetches an avatar and re-serves it from this origin.
 *
 * A failure here is not an error state worth surfacing: the picker's fallback
 * already renders something good, so every failure path returns a small,
 * briefly-cacheable 404 and lets the page swap in the initial.
 */
export async function fetchAvatar(upstream: string): Promise<Response> {
  const notFound = () =>
    new Response('', {
      status: 404,
      headers: { 'cache-control': 'public, max-age=300' },
    });

  let response: Response;
  try {
    response = await fetch(upstream, {
      // No cookies, no Referer, and no credentials of any kind travel to the
      // upstream CDN — this is an anonymous read of a public image.
      redirect: 'follow',
      headers: { accept: 'image/*' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return notFound();
  }

  if (!response.ok) return notFound();

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  // SVG is an image that can carry script, and this endpoint serves whatever
  // a third-party host hands back. Raster only.
  if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') return notFound();

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) return notFound();

  const body = await response.arrayBuffer().catch(() => null);
  if (!body || body.byteLength > MAX_AVATAR_BYTES) return notFound();

  // Deliberately not a pass-through of the upstream response: its headers are
  // third-party controlled, and only the content type is worth keeping.
  //
  // No CSP or CORP set here on purpose — the app-wide `secureHeaders()` in
  // src/index.tsx runs after every handler and overwrites both with `.set()`,
  // so anything written here would be silently discarded. `nosniff` is stated
  // anyway because it is the one header this endpoint genuinely depends on:
  // it serves bytes chosen by a third party under a content type they also
  // chose. (secureHeaders happens to set the same value.)
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': `public, max-age=${BROWSER_CACHE_SECONDS}, stale-while-revalidate=604800`,
      'x-content-type-options': 'nosniff',
    },
  });
}
