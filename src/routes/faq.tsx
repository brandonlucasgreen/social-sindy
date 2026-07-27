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
    q: 'What is Social Sindy?',
    a: `Social Sindy turns your Buffer publishing schedule into subscribable feeds — a calendar feed (ICS) that appears in Google Calendar, Apple Calendar, or Outlook, and a content feed (Atom/RSS) that works in any RSS reader. Connect Buffer once, choose your channels and format, and you get a private URL that stays up to date automatically.`,
  },
  {
    q: 'Who is it for?',
    a: `Anyone who publishes through Buffer and wants their schedule visible somewhere other than Buffer's own dashboard. That includes:

Teams who need visibility in a shared calendar. Add the ICS feed to a team Google Calendar or Outlook and everyone can see what's scheduled without logging into Buffer.

Writers who want their social posts in their RSS reader. Subscribe to the Atom feed in Reeder, NetNewsWire, or any reader, and your posts show up alongside everything else you read.

Creators who want a cross-network feed on their website. Embed the Atom feed using an RSS widget and your latest posts appear on your site automatically — not just one network, but everything you publish through Buffer.

Newsletter authors who pipe their feed into Buttondown, Mailchimp, or FeedMail. New posts become new email sends, no manual work required.`,
  },
  {
    q: 'What does it read from my Buffer account?',
    a: `Your organization name, your channels (name, service, and avatar), and your scheduled and published posts. Nothing else — no drafts without dates, no analytics, no comments.`,
  },
  {
    q: 'Does it publish anything to my Buffer account?',
    a: `No. It only reads. No post is ever created, edited, or deleted in your Buffer account. The read-only OAuth scope makes this explicit — Buffer itself confirms that the connection cannot write.`,
  },
  {
    q: 'How is my credential stored?',
    a: `Your Buffer refresh token is sealed with AES-256-GCM and stored in a Cloudflare D1 database. It is never written to a log, never sent to a third party, and can be revoked at any time from your Buffer settings or by deleting your account here.`,
  },
  {
    q: 'How quickly does the feed update?',
    a: `Calendar clients (Google Calendar, Apple Calendar, Outlook) follow the refresh interval you choose when creating a sindy — every hour, every 6 hours, or once a day. Google Calendar may refresh less frequently on its own schedule (8–24 hours). RSS readers poll on their own schedule, but the feed content is refreshed at the interval you set.`,
  },
  {
    q: 'What is the difference between the ICS and Atom formats?',
    a: `ICS is a calendar format — each post becomes a timed event on your calendar, with a start time and duration. It works in any calendar app.

Atom (RSS) is a content feed format — each post becomes an entry in a feed, with the full text, links, and media attachments. It works in any RSS reader, email tool, or website widget that accepts a feed URL.

You can create both from the same Buffer connection, with different channels and settings for each.`,
  },
  {
    q: 'What does the Atom feed include?',
    a: `By default, only published (sent) posts. You can optionally include scheduled drafts that have a date set. Each entry shows the post text, the channel it was published on, and a link to view it on the social network (when available). Cross-posts — the same content published to multiple channels — are grouped into a single entry by default.`,
  },
  {
    q: 'Is the feed URL private?',
    a: `Yes. Anyone with the URL can read the feed, so treat it like a password. You can generate a new URL at any time, which immediately invalidates the old one.`,
  },
  {
    q: 'Is it free?',
    a: `Yes. Social Sindy runs entirely on Cloudflare's free tier — Workers, D1, and KV. There are no paid services involved and no usage-based costs. The service can sustain many thousands of users before any paid tier would be needed. See the next question for the specifics.`,
  },
  {
    q: 'What are the cost limits?',
    a: `Cloudflare's free tier includes 100,000 Worker requests per day, 5 million D1 row reads per day, and 100,000 KV reads per day. Each feed fetch uses roughly one Worker request, one D1 read, and one KV read. Even a sindy refreshed every hour by 1,000 subscribers would use only about 24,000 requests per day — well within the free limits. At scale, the first paid tier (Workers Paid, $5/month) raises the request limit to 10 million per month and adds more D1 and KV capacity.`,
  },
  {
    q: 'Can I delete my account?',
    a: `Yes. From your sindies dashboard, there is a "Delete account and stored credential" option. This removes your Buffer credential and all your sindies immediately. You can also revoke the connection from your Buffer account settings at any time.`,
  },
  {
    q: 'Who made this?',
    a: `Social Sindy is made by <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer">Brandon Lucas Green</a> as an independent tool. It is not affiliated with Buffer, Inc.`,
  },
];

faqRoutes.get('/faq', (c) => {
  const user = c.get('user');
  return c.html(
    <Layout title="FAQ — social sindy" user={user}>
      <h1>Frequently asked questions</h1>
      {FAQ.map((item, index) => (
        <div class="faq-item">
          <h2 id={`q${index + 1}`}>
            <a href={`#q${index + 1}`}>{item.q}</a>
          </h2>
          <div dangerouslySetInnerHTML={{ __html: item.a }} />
        </div>
      ))}
    </Layout>,
  );
});