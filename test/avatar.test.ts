import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AVATAR_PATH,
  avatarCssValue,
  fetchAvatar,
  proxiedAvatarUrl,
  verifiedAvatarTarget,
} from '../src/avatar.js';
import { generateEncryptionKey } from '../src/crypto.js';

const env = { ENCRYPTION_KEY: generateEncryptionKey() };
const OTHER_ENV = { ENCRYPTION_KEY: generateEncryptionKey() };

/** A real Buffer avatar URL shape, complete with the signed-expiry query. */
const LINKEDIN_AVATAR =
  'https://media.licdn.com/dms/image/v2/D4E03AQE9Yjhrt72krw/profile-displayphoto-crop_800_800/B4EZ6oLOdJHoAM-/0/1780937975922?e=1784764800&v=beta&t=aX_ggrSWBFUI';

function paramsOf(url: string): URLSearchParams {
  return new URL(url, 'https://socialsindy.com').searchParams;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('proxiedAvatarUrl', () => {
  it('signs an upstream URL onto a same-origin path', async () => {
    const signed = await proxiedAvatarUrl(env, LINKEDIN_AVATAR);
    expect(signed).toBeTruthy();
    expect(signed!.startsWith(`${AVATAR_PATH}?`)).toBe(true);
    // The raw third-party host must not leak into the page as a fetchable URL.
    expect(signed).not.toContain('media.licdn.com');
  });

  it('round-trips through verification', async () => {
    const signed = await proxiedAvatarUrl(env, LINKEDIN_AVATAR);
    expect(await verifiedAvatarTarget(env, paramsOf(signed!))).toBe(LINKEDIN_AVATAR);
  });

  it('returns null for a channel with no avatar', async () => {
    expect(await proxiedAvatarUrl(env, null)).toBeNull();
    expect(await proxiedAvatarUrl(env, undefined)).toBeNull();
    expect(await proxiedAvatarUrl(env, '   ')).toBeNull();
  });

  it('refuses upstreams that are not plain https', async () => {
    expect(await proxiedAvatarUrl(env, 'http://cdn.example.com/a.jpg')).toBeNull();
    expect(await proxiedAvatarUrl(env, 'data:image/png;base64,AAAA')).toBeNull();
    expect(await proxiedAvatarUrl(env, 'file:///etc/passwd')).toBeNull();
    expect(await proxiedAvatarUrl(env, 'not a url at all')).toBeNull();
    // Credentials would be forwarded to the upstream host.
    expect(await proxiedAvatarUrl(env, 'https://user:pw@cdn.example.com/a.jpg')).toBeNull();
  });
});

describe('avatarCssValue', () => {
  it('wraps a freshly signed path, so the two stay in step', async () => {
    const signed = await proxiedAvatarUrl(env, LINKEDIN_AVATAR);
    expect(avatarCssValue(signed!)).toBe(`url('${signed}')`);
  });

  it('refuses anything that could terminate the url() early', () => {
    // The disc inlines this into a style attribute, so a stray quote or paren
    // would be a CSS injection. Nothing proxiedAvatarUrl emits looks like this,
    // and the assertion exists to keep that true.
    expect(() => avatarCssValue("/avatar?u=a&s=b'); background:url('x")).toThrow();
    expect(() => avatarCssValue('https://evil.example.com/x.jpg')).toThrow();
    expect(() => avatarCssValue('/avatar?u=a')).toThrow();
  });
});

describe('verifiedAvatarTarget', () => {
  it('rejects an unsigned URL, so the proxy is not an open relay', async () => {
    const forged = new URLSearchParams({ u: btoa('https://evil.example.com/probe') });
    expect(await verifiedAvatarTarget(env, forged)).toBeNull();
  });

  it('rejects a signature minted under a different key', async () => {
    const signed = await proxiedAvatarUrl(OTHER_ENV, LINKEDIN_AVATAR);
    expect(await verifiedAvatarTarget(env, paramsOf(signed!))).toBeNull();
  });

  it('rejects a swapped upstream kept alongside a valid signature', async () => {
    const signed = await proxiedAvatarUrl(env, LINKEDIN_AVATAR);
    const params = paramsOf(signed!);
    params.set('u', btoa('https://evil.example.com/probe').replace(/=+$/, ''));
    expect(await verifiedAvatarTarget(env, params)).toBeNull();
  });

  it('rejects malformed and missing parameters without throwing', async () => {
    expect(await verifiedAvatarTarget(env, new URLSearchParams())).toBeNull();
    expect(await verifiedAvatarTarget(env, new URLSearchParams({ u: '%%%', s: '%%%' }))).toBeNull();
  });
});

describe('fetchAvatar', () => {
  function stubFetch(response: Response | Error) {
    const impl = vi.fn(async (_url: string, _init?: RequestInit) => {
      if (response instanceof Error) throw response;
      return response;
    });
    vi.stubGlobal('fetch', impl);
    return impl;
  }

  const jpeg = () =>
    new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: { 'content-type': 'image/jpeg', 'set-cookie': 'upstream=1' },
    });

  it('re-serves an image from our own origin', async () => {
    stubFetch(jpeg());
    const response = await fetchAvatar(LINKEDIN_AVATAR);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toContain('max-age=86400');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // Upstream headers are not passed through.
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(4);
  });

  it('sends no credentials to the upstream CDN', async () => {
    const impl = stubFetch(jpeg());
    await fetchAvatar(LINKEDIN_AVATAR);

    const init = impl.mock.calls[0]![1]!;
    expect(init.headers).toEqual({ accept: 'image/*' });
    expect('credentials' in init).toBe(false);
  });

  it('404s a non-image response rather than proxying it', async () => {
    stubFetch(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    expect((await fetchAvatar(LINKEDIN_AVATAR)).status).toBe(404);
  });

  it('404s an SVG, which can carry script', async () => {
    stubFetch(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }));
    expect((await fetchAvatar(LINKEDIN_AVATAR)).status).toBe(404);
  });

  it('404s an oversized image on its declared length', async () => {
    stubFetch(
      new Response('x', {
        headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) },
      }),
    );
    expect((await fetchAvatar(LINKEDIN_AVATAR)).status).toBe(404);
  });

  it('404s an upstream error status', async () => {
    stubFetch(new Response('gone', { status: 403 }));
    expect((await fetchAvatar(LINKEDIN_AVATAR)).status).toBe(404);
  });

  it('404s when the upstream is unreachable, instead of throwing', async () => {
    stubFetch(new Error('ECONNREFUSED'));
    const response = await fetchAvatar(LINKEDIN_AVATAR);
    expect(response.status).toBe(404);
    // Briefly cacheable: a dead CDN should not be re-dialled on every render.
    expect(response.headers.get('cache-control')).toContain('max-age=300');
  });
});
