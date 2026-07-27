/**
 * Frequently asked questions — public, no auth required.
 */

import { Hono } from 'hono';
import type { AppBindings } from '../session.js';
import { Layout } from '../ui/layout.jsx';
import { withUser } from '../session.js';

export const faqRoutes = new Hono<AppBindings>();

faqRoutes.use('*', withUser);

const FAQ = [
  {
    q: 'What does it do?',
    a: `Connect your Buffer account, pick your channels, and get a private URL. Subscribe to it in your calendar app (ICS) or RSS reader (Atom) — your posts show up automatically, updated in the background.`,
  },
  {
    q: 'Does it have access to my whole Buffer account?',
    a: `Only your channels and your scheduled or published posts. Nothing else — no analytics, no comments, no DMs. And the OAuth scope is read-only, so it can never post on your behalf.`,
  },
  {
    q: "What's the difference between ICS and Atom?",
    a: `ICS is for calendars — each post becomes a timed event with a start time and duration. Atom is for feeds — each post becomes an entry with the full text and links, readable in any RSS app or email tool. You can create both from the same Buffer connection.`,
  },
  {
    q: 'How often does it refresh?',
    a: `You pick the interval when you create a sindy — every hour, every 6 hours, or once a day. Calendar apps and RSS readers also have their own refresh schedules, so updates may take a bit longer to appear depending on the app.`,
  },
  {
    q: 'Is the feed URL private?',
    a: `Yes. Anyone with the URL can read the feed, so keep it to yourself. You can generate a new URL at any time, which immediately invalidates the old one.`,
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
    <Layout title="FAQ — social sindy" user={user}>
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