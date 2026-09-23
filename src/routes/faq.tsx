/**
 * Frequently asked questions — public, no auth required.
 */

import { Hono } from 'hono';
import { appOrigin } from '../env.js';
import type { AppBindings } from '../session.js';
import { Layout } from '../ui/layout.jsx';
import { withUser } from '../session.js';

export const faqRoutes = new Hono<AppBindings>();

faqRoutes.use('*', withUser);

const FAQ = [
  {
    q: 'What does it do?',
    a: `Connect your Buffer account, pick your channels, and choose a format: a widget you embed on your website, a content feed (Atom/RSS) for your reader or newsletter tool, or a calendar feed (ICS) for Google Calendar, Apple Calendar, or Outlook. Your posts show up automatically and stay up to date.`,
  },
  {
    q: 'Does it have access to my whole Buffer account?',
    a: `Only your channels and your scheduled or published posts. Nothing else — no analytics, no comments, no DMs. And the OAuth scope is read-only, so it can never post on your behalf.`,
  },
  {
    q: "What's the difference between the formats?",
    a: `A widget shows your latest published posts on a web page. Atom is a feed: each post becomes an entry with the full text and links, readable in any RSS app or email tool. ICS is for calendars: each post becomes a timed event, so you can see your schedule. You can create all three from the same Buffer connection.`,
  },
  {
    q: 'Can I show my posts on my own website?',
    a: `Yes — create a widget sindy. You pick the channels, how many posts to show, and how it looks (colors, font, size, dimensions), then paste the embed code into your site or link-in-bio page. Widgets only ever show published posts, since the embed code is meant to be public.`,
  },
  {
    q: 'How often does it refresh?',
    a: `You pick the interval when you create a sindy — every hour, every 6 hours, or once a day. Calendar apps and RSS readers also have their own refresh schedules, so updates may take a bit longer to appear depending on the app.`,
  },
  {
    q: 'Is the feed URL private?',
    a: `Calendar and feed URLs are. Anyone with one can read it, so keep it to yourself. Widgets are the exception: their embed code is meant to be public, so they only ever show posts that are already published. You can replace any URL at any time, which immediately stops the old one working.`,
  },
  {
    q: 'Can I delete my account?',
    a: `Yes. From your dashboard, there's a "Delete account" option that removes everything immediately. You can also revoke the connection from your Buffer settings at any time.`,
  },
  {
    q: 'Who made this?',
    a: `Social Sindy is made by <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer">Brandon Lucas Green</a>. It's not affiliated with Buffer, Inc.`,
  },
];

faqRoutes.get('/faq', (c) => {
  const user = c.get('user');
  return c.html(
    <Layout
      title="FAQ — social sindy"
      description="How social sindy works: what it reads from Buffer, the difference between the website widget, the Atom/RSS content feed, and the ICS calendar feed, how often they refresh, and which URLs are private."
      canonical={`${appOrigin(c.env)}/faq`}
      indexable
      user={user}
    >
      <h1>Frequently asked questions</h1>
      {FAQ.map((item, index) => (
        <div class="faq-item">
          <h2>{item.q}</h2>
          <div dangerouslySetInnerHTML={{ __html: item.a }} />
        </div>
      ))}
    </Layout>,
  );
});