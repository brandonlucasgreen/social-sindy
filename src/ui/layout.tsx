/**
 * THESIS: This surface owns "your posts, everywhere, in feeds you subscribe to."
 * It leads with the artifact itself — a sample week of posts as network-tinted
 * chips — and connects Buffer to get a real one. One connection produces both
 * calendar (ICS) and content (Atom/RSS) feeds.
 *
 * OWN-WORLD: Warm cream ground with amber accent, sharing Buffer's structural
 * language (pill geometry, offset depth, SN Pro) in a warm colour family. The
 * broadcast-signal icon says "syndication" where cally's calendar pegs said
 * "schedule."
 *
 * STORY: A cold visitor sees their own posting week rendered as feed items,
 * understands this is read-only, and connects Buffer.
 *
 * FIRST VIEWPORT: Large regular-weight headline; beneath it a live week strip
 * of network-coloured post chips; then a pill button to connect Buffer; then
 * what it can and cannot see.
 */

import type { FC, PropsWithChildren } from 'hono/jsx';

import { Mark } from './mark.jsx';

const STYLES = `
:root {
  color-scheme: light dark;

  --ground: hsl(40 33% 97%);
  --raised: hsl(0 0% 100%);
  --sunken: hsl(40 26% 94%);
  --text: hsl(30 10% 16%);
  --text-dim: hsl(30 8% 44%);
  --border: hsl(30 12% 80%);
  --border-soft: hsl(30 16% 88%);
  --accent: hsl(35 85% 68%);
  --accent-deep: hsl(35 75% 55%);
  --link: hsl(25 80% 38%);
  --edge: hsl(30 20% 18%);

  --warn-bg: hsl(40 100% 88%);
  --warn-edge: hsl(40 70% 41%);
  --warn-text: hsl(40 87% 24%);
  --danger: hsl(7 62% 44%);

  --radius-sm: 0.625rem;
  --radius-md: 1.25rem;
  --radius-lg: 2.5rem;
  --pill: 100vmax;

  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --dur: 150ms;

  --shadow-card:
    0 -0.25rem 1.5rem -0.5rem hsl(30 15% 9% / 0.10),
    0 0.25rem 0.5rem -0.25rem hsl(30 15% 9% / 0.10),
    0 0.5rem 0 0 var(--edge);
  --shadow-raised:
    0 0.25rem 0.75rem -0.125rem hsl(30 15% 9% / 0.10),
    0 0 0.0625rem 0.0625rem hsl(30 15% 9% / 0.05);
}

@media (prefers-color-scheme: dark) {
  :root {
    --ground: hsl(30 10% 14%);
    --raised: hsl(30 8% 18%);
    --sunken: hsl(30 12% 11%);
    --text: hsl(40 30% 96%);
    --text-dim: hsl(30 10% 70%);
    --border: hsl(30 8% 30%);
    --border-soft: hsl(30 6% 24%);
    --accent: hsl(35 85% 68%);
    --accent-deep: hsl(35 80% 58%);
    --link: hsl(35 85% 68%);
    --edge: hsl(30 15% 8%);

    --warn-bg: hsl(40 25% 18%);
    --warn-edge: hsl(40 45% 40%);
    --warn-text: hsl(40 90% 82%);
    --danger: hsl(7 100% 80%);
  }
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--text);
  font-family: "SN Pro", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: clamp(1rem, 0.96rem + 0.22vi, 1.125rem);
  line-height: 1.5;
  letter-spacing: 0.0075em;
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 47rem; margin: 0 auto; padding: clamp(1.25rem, 0.6rem + 2vi, 2.25rem); }
.wrap.narrow { max-width: 38rem; }

/* --- masthead ----------------------------------------------------------- */

.masthead {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap; margin-bottom: clamp(2rem, 1.5rem + 2vi, 3.25rem);
}
.brand {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-weight: 600; font-size: 1.0625rem; letter-spacing: -0.01em;
  color: var(--text); text-decoration: none;
}
/* Our own mark, deliberately not Buffer's. Drawn in src/ui/mark.tsx. */
.brand-mark { display: block; width: 1.5rem; height: 1.5rem; flex: none; }
.brand-mark svg { display: block; width: 100%; height: 100%; }

.who { display: flex; align-items: center; gap: 0.75rem; font-size: 0.875rem; color: var(--text-dim); }
.who form { display: contents; }

/* --- type --------------------------------------------------------------- */

h1 {
  font-size: clamp(2rem, 1.35rem + 2.9vi, 3.25rem);
  font-weight: 500; letter-spacing: -0.025em; line-height: 1.08;
  margin: 0 0 0.75rem; text-wrap: balance;
}
h2 {
  font-size: clamp(1.1875rem, 1.1rem + 0.4vi, 1.375rem);
  font-weight: 500; letter-spacing: -0.015em; line-height: 1.2;
  margin: 2.5rem 0 0.875rem;
}
h3 { font-size: 1rem; font-weight: 600; letter-spacing: -0.005em; margin: 0 0 0.25rem; }
p { margin: 0 0 0.875rem; max-width: 68ch; }
.lede {
  font-size: clamp(1.0625rem, 1rem + 0.35vi, 1.1875rem);
  color: var(--text-dim); margin-bottom: 2rem; max-width: 60ch;
}
small, .small { font-size: 0.875rem; color: var(--text-dim); line-height: 1.45; }
a { color: var(--link); text-underline-offset: 0.15em; }

ul { max-width: 68ch; margin: 0 0 1rem; padding-left: 1.25rem; }
li { margin-bottom: 0.5rem; }
li::marker { color: var(--text-dim); }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875em;
  background: var(--sunken);
  border-radius: 0.25rem;
  padding: 0.0625rem 0.3125rem;
}

/* --- surfaces ----------------------------------------------------------- */

.panel {
  background: var(--raised);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  padding: clamp(1.125rem, 0.9rem + 0.9vi, 1.625rem);
  box-shadow: var(--shadow-raised);
  margin-bottom: 1.125rem;
}
.panel.flat { box-shadow: none; background: transparent; }
.panel > :last-child { margin-bottom: 0; }

/* --- controls ----------------------------------------------------------- */

label { display: block; font-weight: 500; font-size: 0.9375rem; margin-bottom: 0.375rem; }
.field { margin-bottom: 1.125rem; }
.field > small { display: block; margin-top: 0.375rem; }

input[type=text], input[type=password], input[type=number], select {
  width: 100%; padding: 0.6875rem 0.9375rem;
  font: inherit; font-size: 0.9375rem; color: var(--text);
  background: var(--sunken);
  border: 1px solid var(--border);
  border-radius: var(--pill);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
select {
  border-radius: var(--radius-sm);
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 1.0625rem) 55%, calc(100% - 0.75rem) 55%;
  background-size: 0.3125rem 0.3125rem, 0.3125rem 0.3125rem;
  background-repeat: no-repeat;
  padding-right: 2.25rem;
}
input::placeholder { color: var(--text-dim); opacity: 0.75; }
input:hover, select:hover { border-color: var(--border); background: var(--raised); }
:focus-visible { outline: 0.125rem solid var(--link); outline-offset: 0.125rem; }

button, .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.4375rem;
  font: inherit; font-size: 0.9375rem; font-weight: 600; letter-spacing: 0.0075em;
  padding: 0.6875rem 1.375rem;
  border: 1px solid transparent; border-radius: var(--pill);
  /* Amber with DARK text — the warm palette's signature. */
  background: var(--accent); color: hsl(30 10% 16%);
  cursor: pointer; text-decoration: none; white-space: nowrap;
  transition: transform var(--dur) var(--ease), background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
button:hover, .btn:hover { background: var(--accent-deep); }
button:active, .btn:active { transform: translateY(1px); }
button[disabled], .btn[disabled] { opacity: 0.45; cursor: not-allowed; transform: none; }

.btn-quiet { background: var(--raised); color: var(--text); border-color: var(--border); }
.btn-quiet:hover { background: var(--sunken); }
.btn-plain {
  background: transparent; color: var(--text-dim); border-color: transparent;
  padding-inline: 0.25rem; font-weight: 500;
}
.btn-plain:hover { background: transparent; color: var(--text); }
.btn-danger { background: transparent; color: var(--danger); border-color: transparent; padding-inline: 0.25rem; }
.btn-danger:hover { background: transparent; text-decoration: underline; }
.btn-row { display: flex; gap: 0.625rem; align-items: center; flex-wrap: wrap; }
.btn-row form { display: contents; }

/* --- format toggle (ICS / Atom) ---------------------------------------- */

.format-toggle { display: inline-flex; gap: 0; border-radius: var(--pill); overflow: hidden; border: 1px solid var(--border); }
.fmt-btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0.5rem 1.25rem; font: inherit; font-size: 0.9375rem; font-weight: 600;
  color: var(--text-dim); background: var(--raised); text-decoration: none;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.fmt-btn + .fmt-btn { border-left: 1px solid var(--border); }
.fmt-btn:hover { background: var(--sunken); color: var(--text); }
.fmt-btn.active {
  background: var(--accent); color: hsl(30 10% 16%);
  box-shadow: inset 0 0 0 0; /* override any inset */
}

/* Buffer's email-capture shape: one pill holding field and action together. */
.inline-form {
  display: flex; gap: 0.5rem; align-items: center;
  background: var(--raised); border: 1px solid var(--border);
  border-radius: var(--pill); padding: 0.3125rem 0.3125rem 0.3125rem 0.25rem;
}
.inline-form input { border: none; background: transparent; padding-left: 1rem; }
.inline-form input:hover { background: transparent; }
.inline-form button { flex: none; }
@media (max-width: 30rem) {
  .inline-form { flex-direction: column; align-items: stretch; border-radius: var(--radius-md); padding: 0.75rem; }
  .inline-form input { border: 1px solid var(--border); background: var(--sunken); padding-left: 0.9375rem; }
  .inline-form button { width: 100%; }
}

.row { display: flex; gap: 1rem; flex-wrap: wrap; }
.row > .field { flex: 1 1 12rem; }

.checkline { display: flex; align-items: flex-start; gap: 0.5625rem; margin-bottom: 0.625rem; }
.checkline input { width: auto; margin: 0.3125rem 0 0; accent-color: var(--link); flex: none; }
.checkline label { margin: 0; font-weight: 400; font-size: 0.9375rem; }
.checkline label small { color: var(--text-dim); }

/* --- steps -------------------------------------------------------------- */

.steps { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.step {
  display: inline-flex; align-items: center; gap: 0.4375rem;
  font-size: 0.8125rem; font-weight: 500; color: var(--text-dim);
  background: var(--sunken); border-radius: var(--pill); padding: 0.25rem 0.75rem 0.25rem 0.4375rem;
}
.step i {
  font-style: normal; display: grid; place-items: center;
  width: 1.125rem; height: 1.125rem; border-radius: 50%;
  background: var(--border-soft); color: var(--text); font-size: 0.6875rem; font-weight: 600;
}
.step.on { color: var(--text); background: var(--accent); }
.step.on i { background: hsl(30 10% 16%); color: var(--accent); }
.step.done i { background: var(--link); color: var(--ground); }

/* --- channels ----------------------------------------------------------- */

.channels { display: grid; gap: 0.25rem; }
.channel {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.625rem 0.75rem; border-radius: var(--radius-sm);
  cursor: pointer; border: 1px solid transparent;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.channel:hover { background: var(--sunken); }
.channel:has(input:checked) { background: var(--sunken); border-color: var(--border-soft); }
.channel:has(input:focus-visible) { outline: 0.125rem solid var(--link); outline-offset: 0.125rem; }
/* The selection control, not an afterthought: default 13px checkboxes are an
   awkward target for the page's primary decision. */
.channel input {
  width: 1.125rem; height: 1.125rem; margin: 0; flex: none;
  accent-color: var(--link);
}
.channel .avatar {
  width: 1.75rem; height: 1.75rem; border-radius: 50%; flex: none;
  object-fit: cover; background: var(--sunken);
}
/* Buffer does not always return an avatar. Rather than an empty gray blob, fall
   back to the channel's initial on its network's own tint. */
.channel .avatar.fallback {
  display: grid; place-items: center;
  background: color-mix(in oklab, var(--net, var(--border)) 22%, var(--raised));
  color: var(--text); font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
}
.channel .meta { min-width: 0; }
.channel .meta strong { display: block; font-weight: 500; font-size: 0.9375rem; }
.channel .meta small { display: flex; align-items: center; gap: 0.375rem; }
.channel.off { opacity: 0.6; }

/* Network colour is identity, never the only signal — always beside the name. */
.dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; flex: none; background: var(--net, var(--border)); }

/* --- notices ------------------------------------------------------------ */

.notice {
  background: var(--warn-bg); color: var(--warn-text);
  border: 1px solid var(--warn-edge);
  border-radius: var(--radius-md); padding: 1rem 1.125rem;
  margin-bottom: 1.25rem; font-size: 0.9375rem;
}
.notice strong { font-weight: 600; }
.notice > :last-child { margin-bottom: 0; }
.notice.bad { background: var(--raised); border-color: var(--danger); color: var(--danger); }
.notice.good { background: var(--sunken); border-color: var(--border); color: var(--text); }

/* --- feed url ----------------------------------------------------------- */

.url {
  display: flex; gap: 0.5rem; align-items: center;
  background: var(--sunken); border: 1px solid var(--border);
  border-radius: var(--pill); padding: 0.3125rem 0.3125rem 0.3125rem 1rem;
  margin-bottom: 0.875rem;
}
.url code {
  flex: 1; min-width: 0; font-size: 0.8125rem; line-height: 1.4;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-x: auto; white-space: nowrap; scrollbar-width: none;
}
.url code::-webkit-scrollbar { display: none; }
.url button { flex: none; padding: 0.5rem 1rem; font-size: 0.8125rem; }
@media (max-width: 30rem) {
  .url { flex-direction: column; align-items: stretch; border-radius: var(--radius-md); padding: 0.75rem; }
  .url code { white-space: normal; word-break: break-all; }
}

/* --- calendar list ------------------------------------------------------ */

.cal {
  display: flex; justify-content: space-between; align-items: center;
  gap: 1rem; flex-wrap: wrap;
}
.cal-title { text-decoration: none; color: var(--text); }
.cal-title:hover { text-decoration: underline; }
.meta-line { color: var(--text-dim); font-size: 0.875rem; display: flex; align-items: center; gap: 0.4375rem; flex-wrap: wrap; }
.state { display: inline-flex; align-items: center; gap: 0.4375rem; }
.state::before {
  content: ''; width: 0.4375rem; height: 0.4375rem; border-radius: 50%;
  background: var(--link); flex: none;
}
.state.stale::before { background: hsl(40 75% 45%); }
.state.bad::before { background: var(--danger); }

.empty { text-align: center; padding: 2.25rem 1.25rem; }
.empty p { max-width: none; }

/* --- hero demo ---------------------------------------------------------- */

/* Shows the actual output rather than describing it: a week of post chips in
   network colours. Illustrative sample content, not real account data. */
.demo {
  background: var(--raised);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  padding: 1rem;
  /* <figure> carries a default 40px inline margin that would inset this from
     the text column it should align with. */
  margin: 0 0 2.5rem;
}
.demo-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 0.75rem; margin-bottom: 0.875rem; padding-inline: 0.125rem;
}
.demo-head b { font-size: 0.875rem; font-weight: 600; letter-spacing: -0.005em; }
.demo-head span { font-size: 0.8125rem; color: var(--text-dim); }

.week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.25rem; }
.day { display: flex; flex-direction: column; gap: 0.25rem; min-height: 5.5rem; }
.day > b {
  font-size: 0.75rem; font-weight: 500; color: var(--text-dim);
  text-align: center; padding-block: 0.1875rem;
}
.day.today { background: var(--sunken); border-radius: var(--radius-sm); }
.day.today > b { color: var(--text); font-weight: 600; }

/* Rendered the way a calendar renders an event: a block tinted from the
   network's own colour, with a solid dot so the hue is never the only signal. */
.chip {
  display: flex; align-items: center; gap: 0.3125rem;
  font-size: 0.6875rem; line-height: 1.3; font-weight: 500;
  padding: 0.3125rem 0.375rem; border-radius: 0.375rem;
  /* Kept low because several networks are pure black, and a heavier mix renders
     those as a muddy gray that reads as "disabled" and outweighs the hues. */
  background: color-mix(in oklab, var(--net, var(--border)) 11%, var(--raised));
  color: var(--text);
  min-width: 0;
}
.chip::before {
  content: ''; flex: none; width: 0.375rem; height: 0.375rem;
  border-radius: 50%; background: var(--net, var(--border));
}
.chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Seven columns on a phone leaves ~40px per day, too narrow for any legible
   label. Below that, the week becomes a readable day-by-day list instead of
   colour-only bars. */
@media (max-width: 36rem) {
  .week { grid-template-columns: 1fr; gap: 0.375rem; }
  .day {
    flex-direction: row; align-items: center; gap: 0.5rem;
    min-height: 0; padding: 0.25rem 0.375rem;
  }
  .day > b { text-align: left; width: 2.25rem; flex: none; }
  .day:not(.today) { border-bottom: 1px solid var(--border-soft); }
  .day > .chip { flex: 1 1 auto; }
  .day:has(> b:only-child) { display: none; }
}

/* --- trust grid --------------------------------------------------------- */

.trust { display: grid; gap: 0.875rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
.trust div { background: var(--sunken); border-radius: var(--radius-sm); padding: 0.875rem 1rem; }
.trust h3 { display: flex; align-items: center; gap: 0.4375rem; font-size: 0.875rem; }
.trust p { margin: 0; font-size: 0.875rem; color: var(--text-dim); }
.tick { color: var(--link); font-weight: 700; }

footer.site {
  margin-top: 3rem; padding-top: 1.25rem;
  border-top: 1px solid var(--border-soft);
  font-size: 0.8125rem; color: var(--text-dim);
}
footer.site p { max-width: 60ch; margin-bottom: 0.5rem; }

@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.01ms !important; }
}
`;

const COPY_SCRIPT = `
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(button.getAttribute('data-copy'));
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Press \\u2318C';
  }
  setTimeout(() => { button.textContent = original; }, 1600);
});
`;

export interface LayoutProps {
  title: string;
  user?: { email: string } | null;
  /** Narrower measure for single-column task pages. */
  narrow?: boolean;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, user, narrow, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title}</title>
      <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=SN+Pro:wght@400;500;600;700&display=swap"
      />
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    </head>
    <body>
      <div class={narrow ? 'wrap narrow' : 'wrap'}>
        <header class="masthead">
          {/* The product is called "social sindy" wherever a person reads it —
              this wordmark, page titles, the privacy policy. The hyphenated
              `social-sindy` is kept everywhere it is load-bearing: the package,
              Worker, D1 database, repo, and the ICS UID domain in
              src/ics/generate.ts. */}
          <a class="brand" href="/">
            <Mark />
            social sindy
          </a>
          {user ? (
            <span class="who">
              {user.email}
              <form method="post" action="/signout">
                <button class="btn-plain" type="submit">
                  Sign out
                </button>
              </form>
            </span>
          ) : null}
        </header>
        {children}
        <footer class="site">
          <p>
            Made with love in Massachusetts, USA. An independent tool, not made by or affiliated
            with Buffer. It never posts on your behalf.
          </p>
          <p>
            <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer">
              By @bgreenlol
            </a>{' '}
            &middot;{' '}
            <a
              href="https://liberapay.com/brandonlucasgreen"
              target="_blank"
              rel="noopener noreferrer"
            >
              Donate
            </a>{' '}
            &middot;{' '}
            <a href="/privacy" target="_blank" rel="noopener noreferrer">
              Privacy policy
            </a>
          </p>
        </footer>
      </div>
      <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
      <script
        data-goatcounter="https://social-cally.goatcounter.com/count"
        async
        src="//gc.zgo.at/count.js"
      />
    </body>
  </html>
);

export const Notice: FC<PropsWithChildren<{ kind?: 'warn' | 'error' | 'good' }>> = ({
  kind,
  children,
}) => (
  <div class={kind === 'error' ? 'notice bad' : kind === 'good' ? 'notice good' : 'notice'}>
    {children}
  </div>
);

/** Progress across the three setup steps. */
export const Steps: FC<{ at: 1 | 2 | 3 }> = ({ at }) => {
  const labels = ['Organization', 'Channels', 'Subscribe'];
  return (
    <nav class="steps" aria-label="Setup progress">
      {labels.map((label, index) => {
        const step = index + 1;
        const cls = step === at ? 'step on' : step < at ? 'step done' : 'step';
        return (
          <span class={cls} aria-current={step === at ? 'step' : undefined}>
            <i aria-hidden="true">{step < at ? '✓' : step}</i>
            {label}
          </span>
        );
      })}
    </nav>
  );
};
