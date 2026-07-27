/**
 * Frequently asked questions — public, no auth required.
 */

import { Hono } from 'hono';
import type { AppBindings } from '../session.js';
import { Layout } from '../ui/layout.jsx';
import { withUser } from '../session.js';

export const faqRoutes = new Hono<AppBindings>();

faqRoutes.use('*', withUser);

const USE_CASES = [
  {
    icon: '📅',
    title: 'Team calendar',
    desc: 'Add your content schedule to a shared Google Calendar or Outlook so the whole team can see what\'s coming up — without logging into Buffer.',
  },
  {
    icon: '✉️',
    title: 'RSS to email',
    desc: 'Pipe the feed into Buttondown, Mailchimp, or FeedMail and every post becomes an email send. No manual work.',
  },
  {
    icon: '📖',
    title: 'Personal journal',
    desc: 'Subscribe in Reeder, NetNewsWire, or your favorite RSS app and revisit your posts in a clean, reader-like view.',
  },
  {
    icon: '🌐',
    title: 'Website widget',
    desc: 'Embed a cross-network feed on your site — every channel in one place, not separate widgets for each social network.',
  },
];

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
    q: 'What\'s the difference between ICS and Atom?',
    a: `ICS is for calendars — each post becomes a timed event on your calendar with a start time and duration. Atom is for feeds — each post becomes an entry with the full text and links, readable in any RSS app or email tool. You can create both from the same Buffer connection.`,
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
    a: `Yes. From your dashboard, there\'s a "Delete account" option that removes everything immediately. You can also revoke the connection from your Buffer settings at any time.`,
  },
  {
    q: 'Who made this?',
    a: `Social Sindy is made by <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer">Brandon Lucas Green</a>. It\'s not affiliated with Buffer, Inc.`,
  },
];

faqRoutes.get('/faq', (c) => {
  const user = c.get('user');
  return c.html(
    <Layout title="FAQ — social sindy" user={user}>
      <h1>Who is it for?</h1>
      <p class="lede" style="margin-bottom:2rem">
        Anyone who publishes through Buffer and wants their posts somewhere other than Buffer's dashboard.
      </p>
      <div class="use-cases">
        {USE_CASES.map((uc) => (
          <div class="use-case">
            <div class="use-case-icon">{uc.icon}</div>
            <h3>{uc.title}</h3>
            <p>{uc.desc}</p>
          </div>
        ))}
      </div>

      <h2>Frequently asked questions</h2>
      {FAQ.map((item, index) => (
        <div class="faq-item">
          <h3 id={`q${index + 1}`}>
            <a href={`#q${index + 1}`}>{item.q}</a>
          </h3>
          <div dangerouslySetInnerHTML={{ __html: item.a }} />
        </div>
      ))}
    </Layout>,
  );
});