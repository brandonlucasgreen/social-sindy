import type { FC, PropsWithChildren } from 'hono/jsx';

/**
 * Styles are inlined rather than served as an asset: the whole app is a handful
 * of server-rendered pages, and this keeps the Worker a single deployable with
 * no build step or extra request per page.
 */
const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfd;
  --surface: #ffffff;
  --surface-2: #f4f4f7;
  --border: #e3e3ea;
  --text: #17171c;
  --text-dim: #63636e;
  --accent: #2c4bff;
  --accent-text: #ffffff;
  --danger: #c2334d;
  --warn-bg: #fff8e6;
  --warn-border: #f0d9a0;
  --warn-text: #6b5312;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(20, 20, 40, 0.05), 0 4px 16px rgba(20, 20, 40, 0.04);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101014;
    --surface: #18181e;
    --surface-2: #202028;
    --border: #2e2e38;
    --text: #f2f2f5;
    --text-dim: #9a9aa8;
    --accent: #7b8cff;
    --accent-text: #10101a;
    --danger: #ff8098;
    --warn-bg: #2a2312;
    --warn-border: #4d4023;
    --warn-text: #f0dca8;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.3);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 72px; }

header.site { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
header.site a.brand { font-weight: 650; letter-spacing: -0.01em; color: var(--text); text-decoration: none; font-size: 17px; }
header.site .who { color: var(--text-dim); font-size: 13.5px; display: flex; align-items: center; gap: 12px; }

h1 { font-size: 26px; line-height: 1.25; letter-spacing: -0.02em; margin: 0 0 8px; }
h2 { font-size: 18px; letter-spacing: -0.01em; margin: 32px 0 12px; }
h3 { font-size: 15px; margin: 0 0 4px; }
p { margin: 0 0 14px; }
p.lede { color: var(--text-dim); font-size: 15.5px; margin-bottom: 28px; }
small, .small { font-size: 13px; color: var(--text-dim); }
a { color: var(--accent); }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  box-shadow: var(--shadow);
  margin-bottom: 16px;
}

label { display: block; font-weight: 550; font-size: 14px; margin-bottom: 6px; }
.field { margin-bottom: 18px; }
.field > small { display: block; margin-top: 5px; }

input[type=text], input[type=password], input[type=number], select {
  width: 100%;
  padding: 9px 11px;
  font: inherit;
  font-size: 14.5px;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 7px;
}
input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.row { display: flex; gap: 14px; flex-wrap: wrap; }
.row > .field { flex: 1 1 180px; margin-bottom: 18px; }

button, .btn {
  display: inline-block;
  font: inherit;
  font-size: 14.5px;
  font-weight: 550;
  padding: 9px 16px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: var(--accent);
  color: var(--accent-text);
  cursor: pointer;
  text-decoration: none;
}
.btn-secondary { background: var(--surface-2); color: var(--text); border-color: var(--border); }
.btn-danger { background: transparent; color: var(--danger); border-color: transparent; padding-left: 0; }
.btn-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 4px; }

.channels { display: grid; gap: 2px; }
.channel {
  display: flex; align-items: center; gap: 11px;
  padding: 9px 11px; border-radius: 7px; cursor: pointer;
}
.channel:hover { background: var(--surface-2); }
.channel input { width: auto; margin: 0; accent-color: var(--accent); }
.channel img { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; background: var(--surface-2); flex: none; }
.channel .meta { min-width: 0; }
.channel .meta strong { display: block; font-weight: 550; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.channel .meta small { display: block; }
.channel.off { opacity: 0.55; }

.checkline { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 10px; }
.checkline input { width: auto; margin: 3px 0 0; accent-color: var(--accent); }
.checkline label { margin: 0; font-weight: 450; font-size: 14.5px; }

.url-box {
  display: flex; gap: 8px; align-items: stretch;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 7px; padding: 8px 8px 8px 12px; margin-bottom: 8px;
}
.url-box code {
  flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all; align-self: center;
}
.url-box button { flex: none; padding: 6px 12px; font-size: 13px; }

.notice {
  background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text);
  border-radius: var(--radius); padding: 14px 16px; margin-bottom: 20px; font-size: 14.5px;
}
.notice strong { font-weight: 600; }
.notice p:last-child { margin-bottom: 0; }
.error { background: var(--surface); border-color: var(--danger); color: var(--danger); }

.cal-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.cal-item .tags { color: var(--text-dim); font-size: 13px; margin-top: 3px; }
.status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #2f9e5f; margin-right: 5px; vertical-align: 1px; }
.status-dot.stale { background: #d0a02a; }
.status-dot.bad { background: var(--danger); }

.empty { text-align: center; padding: 36px 20px; color: var(--text-dim); }
.steps { display: flex; gap: 8px; font-size: 13px; color: var(--text-dim); margin-bottom: 24px; flex-wrap: wrap; }
.steps span.on { color: var(--text); font-weight: 550; }
footer.site { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 13px; color: var(--text-dim); }
`;

const COPY_SCRIPT = `
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.getAttribute('data-copy'));
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1600);
  } catch {
    button.textContent = 'Press ⌘C';
  }
});
`;

export interface LayoutProps {
  title: string;
  user?: { email: string } | null;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, user, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title}</title>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    </head>
    <body>
      <div class="wrap">
        <header class="site">
          <a class="brand" href="/">
            Buffer → Calendar
          </a>
          {user ? (
            <span class="who">
              {user.email}
              <form method="post" action="/signout" style="display:inline">
                <button class="btn-danger" type="submit">
                  Sign out
                </button>
              </form>
            </span>
          ) : null}
        </header>
        {children}
        <footer class="site">
          Unofficial tool. Your Buffer API key is encrypted at rest and used only to read your
          posting schedule.
        </footer>
      </div>
      <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
    </body>
  </html>
);

export const Notice: FC<PropsWithChildren<{ kind?: 'warn' | 'error' }>> = ({ kind, children }) => (
  <div class={kind === 'error' ? 'notice error' : 'notice'}>{children}</div>
);
