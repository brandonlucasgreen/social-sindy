/**
 * Indexability.
 *
 * The bug these tests exist to prevent already shipped once: `noindex` lived in
 * the shared `Layout`, so it applied to the marketing pages it was never meant
 * for and the whole site was uncrawlable. The fix makes indexing an explicit
 * per-page decision, which is only safe if two properties hold — the public
 * pages opt in, and everything else stays out by default. Both are asserted
 * here, because the failure mode is silent: nothing breaks, the site just
 * disappears from search.
 */

import { describe, expect, it } from 'vitest';

import worker from '../src/index.jsx';

const ORIGIN = 'https://socialsindy.com';

const env = {
  APP_BASE_URL: ORIGIN,
  // Anonymous requests carry no session cookie, so `withUser` never reaches the
  // database and these pages render without one.
  DB: null,
  FEED_CACHE: null,
  ENCRYPTION_KEY: '',
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

async function get(path: string, override?: Partial<typeof env>): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`), { ...env, ...override } as never, ctx);
}

async function body(path: string): Promise<string> {
  const response = await get(path);
  expect(response.status).toBe(200);
  return response.text();
}

describe('public pages', () => {
  const PUBLIC_PAGES = [
    { path: '/', canonical: `${ORIGIN}/` },
    { path: '/faq', canonical: `${ORIGIN}/faq` },
    { path: '/privacy', canonical: `${ORIGIN}/privacy` },
  ];

  it.each(PUBLIC_PAGES)('$path is indexable', async ({ path }) => {
    expect(await body(path)).not.toContain('name="robots"');
  });

  it.each(PUBLIC_PAGES)('$path names $canonical as canonical', async ({ path, canonical }) => {
    // Three hostnames serve this HTML; only one may be the indexed one.
    expect(await body(path)).toContain(`<link rel="canonical" href="${canonical}"/>`);
  });

  it.each(PUBLIC_PAGES)('$path carries a description and an OG title', async ({ path }) => {
    const html = await body(path);
    expect(html).toMatch(/<meta name="description" content="[^"]{50,}"\/>/);
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
  });
});

describe('non-public pages', () => {
  /**
   * A page is private unless it says otherwise. These are the cheap anonymous
   * cases — an authed page would need a session — and they cover the two that
   * render a full `Layout` without one.
   */
  it('the 404 page is noindex', async () => {
    const response = await get('/no-such-page');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('<meta name="robots" content="noindex"/>');
  });

  it('an authed page redirects rather than rendering something indexable', async () => {
    const response = await get('/sindies');
    expect(response.status).toBe(302);
  });
});

describe('robots.txt', () => {
  it('points at the sitemap on the canonical origin', async () => {
    expect(await body('/robots.txt')).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it('keeps crawlers out of the private and machine paths', async () => {
    const text = await body('/robots.txt');
    for (const path of ['/sindies', '/auth', '/google', '/healthz']) {
      expect(text).toContain(`Disallow: ${path}`);
    }
  });

  it('does not disallow /feed, which robots-respecting aggregators would honour', async () => {
    // Blocking it would break real Atom subscribers and protect nothing: the
    // tokens are unguessable and never linked.
    expect(await body('/robots.txt')).not.toContain('Disallow: /feed');
  });

  it('is served as plain text', async () => {
    const response = await get('/robots.txt');
    expect(response.headers.get('content-type')).toContain('text/plain');
  });
});

describe('sitemap.xml', () => {
  it('lists exactly the indexable pages, absolute', async () => {
    const xml = await body('/sitemap.xml');
    expect(xml.match(/<loc>/g)).toHaveLength(3);
    for (const path of ['/', '/faq', '/privacy']) {
      expect(xml).toContain(`<loc>${ORIGIN}${path}</loc>`);
    }
  });

  it('lists nothing private or machine-facing', async () => {
    const xml = await body('/sitemap.xml');
    for (const path of ['/sindies', '/auth', '/google', '/feed', '/healthz']) {
      expect(xml).not.toContain(path);
    }
  });

  it('is served as XML', async () => {
    const response = await get('/sitemap.xml');
    expect(response.headers.get('content-type')).toContain('xml');
  });
});

describe('trailing slash in APP_BASE_URL', () => {
  /**
   * The var is operator-set and has carried a trailing slash before. A canonical
   * URL that disagrees with the sitemap by one character defeats the point of
   * having either.
   */
  it('does not produce a doubled slash', async () => {
    const response = await get('/sitemap.xml', { APP_BASE_URL: `${ORIGIN}/` });
    const xml = await response.text();
    expect(xml).toContain(`<loc>${ORIGIN}/faq</loc>`);
    expect(xml).not.toContain('//faq');
  });
});
