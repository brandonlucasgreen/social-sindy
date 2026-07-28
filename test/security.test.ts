/**
 * HTTPS enforcement, legacy-host consolidation, and baseline security headers.
 *
 * These exist because `wrangler dev` cannot exercise this logic realistically:
 * it rewrites the request URL's host to match the configured custom-domain
 * route for local testing, and always serves plain HTTP locally, so the raw
 * `request.url` protocol can't distinguish a real plain-HTTP visitor from an
 * ordinary local dev request. Driving `worker.fetch` directly with a crafted
 * `Request` — origin, headers, and all — is the only way to exercise both
 * branches (the `cf-visitor` check and the legacy-host set) without either
 * false positive.
 */

import { describe, expect, it } from 'vitest';

import worker from '../src/index.jsx';

const ORIGIN = 'https://socialsindy.com';

const env = {
  APP_BASE_URL: ORIGIN,
  DB: null,
  FEED_CACHE: null,
  ENCRYPTION_KEY: '',
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

function request(url: string, headers?: Record<string, string>): Request {
  return new Request(url, { headers });
}

async function fetch(url: string, headers?: Record<string, string>): Promise<Response> {
  return worker.fetch(request(url, headers), env as never, ctx);
}

describe('HTTPS enforcement', () => {
  it('does not redirect when there is no cf-visitor header (local dev, and any non-Cloudflare request)', async () => {
    const response = await fetch(`${ORIGIN}/faq`);
    expect(response.status).toBe(200);
  });

  it('redirects to HTTPS when cf-visitor reports the original request was plain HTTP', async () => {
    const response = await fetch(`${ORIGIN}/faq`, { 'cf-visitor': '{"scheme":"http"}' });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/faq`);
  });

  it('does not redirect when cf-visitor already reports https', async () => {
    const response = await fetch(`${ORIGIN}/faq`, { 'cf-visitor': '{"scheme":"https"}' });
    expect(response.status).toBe(200);
  });

  it('ignores a malformed cf-visitor header rather than misfiring a redirect', async () => {
    const response = await fetch(`${ORIGIN}/faq`, { 'cf-visitor': 'not json' });
    expect(response.status).toBe(200);
  });

  it('still upgrades a feed request over plain HTTP — tokens must never travel in cleartext', async () => {
    const response = await fetch(`${ORIGIN}/feed/sometoken.ics`, { 'cf-visitor': '{"scheme":"http"}' });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/feed/sometoken.ics`);
  });
});

describe('legacy-host consolidation', () => {
  const LEGACY_ORIGINS = ['https://social-sindy.bgreen.lol', 'https://social-cally.bgreen.lol'];

  it.each(LEGACY_ORIGINS)('redirects an HTML page on %s to the canonical host', async (origin) => {
    const response = await fetch(`${origin}/faq`, { 'cf-visitor': '{"scheme":"https"}' });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/faq`);
  });

  it.each(LEGACY_ORIGINS)(
    'leaves a feed path on %s alone — existing subscribers must keep working',
    async (origin) => {
      const response = await fetch(`${origin}/feed/sometoken.ics`, { 'cf-visitor': '{"scheme":"https"}' });
      expect(response.status).not.toBe(308);
    },
  );

  it.each(LEGACY_ORIGINS)('leaves /healthz on %s alone — an uptime monitor wants that host, not a redirect', async (origin) => {
    const response = await fetch(`${origin}/healthz`, { 'cf-visitor': '{"scheme":"https"}' });
    expect(response.status).toBe(200);
  });

  it('does not touch the canonical host itself', async () => {
    const response = await fetch(`${ORIGIN}/faq`, { 'cf-visitor': '{"scheme":"https"}' });
    expect(response.status).toBe(200);
  });
});

describe('security headers', () => {
  it('sets HSTS, a scoped CSP, and the standard hardening set on an ordinary page', async () => {
    const response = await fetch(`${ORIGIN}/faq`, { 'cf-visitor': '{"scheme":"https"}' });
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('permissions-policy')).toContain('geolocation=()');

    const csp = response.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://gc.zgo.at');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('still sets security headers on a redirect response, not only on a terminal 200', async () => {
    // Guards the registration order: secureHeaders() must run even when a
    // later middleware short-circuits with a redirect instead of calling
    // next() — HSTS matters most on the very response upgrading someone to
    // HTTPS, and is easy to lose silently if these two get reordered.
    const response = await fetch(`${ORIGIN}/faq`, { 'cf-visitor': '{"scheme":"http"}' });
    expect(response.status).toBe(308);
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });
});
