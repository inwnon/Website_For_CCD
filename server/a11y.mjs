// npm run a11y — WCAG 2.1 A/AA check of every page with axe-core, in light and dark mode. Needs `npm run dev` running.
// Opens the local Chrome headless (CHROME_PATH, or the usual install folders) and injects axe from node_modules,
// so the pages still load nothing from other sites. Exits 1 when any page has a violation.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = process.env.TEST_BASE ||'http://localhost:3000';
const PORT = 9339;
const AXE = readFileSync(join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
// [page, who is signed in]: null = public visitor. news.html and collection.html need a record id, so they are left out.
const PAGES = [
  ['index.html', null], ['search.html', null], ['contact.html', null], ['privacy.html', null], ['login.html', null], ['status.html', null], ['404.html', null],
  ['submit.html', 'staff'], ['inbox.html', 'pr'], ['pr.html', 'pr'], ['pr-news.html', 'pr'], ['pr-import.html', 'pr'], ['pr-collections.html', 'pr'],
  ['report.html', 'pr'], ['calendar.html', 'pr'], ['requests.html', 'secretary'], ['requests.html', 'staff'], ['requests.html', 'pr'], ['documents.html', 'pr'], ['phonebook.html', 'pr'], ['chanon.html', 'admin'],
];
const CHROMES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

const chromePath = CHROMES.find((p) => existsSync(p));
if (!chromePath) { console.error('ไม่พบ Chrome: ตั้ง CHROME_PATH ให้ชี้ไปที่ chrome.exe'); process.exit(2); }
if (!(await fetch(BASE).then((r) => r.ok, () => false))) { console.error(`เปิด ${BASE} ไม่ได้: รัน npm run dev ก่อน`); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'a11y-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
let targets = null;
for (let i = 0; i < 40 && !targets; i++) { await wait(250); targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json(), () => null); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const calls = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && calls.has(d.id)) { calls.get(d.id)(d); calls.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const n = ++seq; calls.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const run = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const open = async (path) => { await cdp('Page.navigate', { url: `${BASE}/${path}` }); await wait(1500); };

let failed = 0;
try {
  await cdp('Page.enable');
  let signedIn;
  for (const [page, as] of PAGES) {
    if (as !== signedIn) {
      await cdp('Network.clearBrowserCookies');
      await open('login.html');
      if (as) await run(`fetch('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: '${as}' }) }).then((r) => r.status)`);
      signedIn = as;
    }
    for (const scheme of ['light', 'dark']) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await open(page);
      await run(AXE);
      const { at, passes, found } = await run(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }).then((r) => ({
        at: location.pathname, passes: r.passes.length,
        found: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ')) })),
      }))`);
      const label = `${page} (${as || 'public'}, ${scheme})`;
      // A redirect (e.g. to login.html) would check the wrong page
      if (at !== `/${page}` || !passes) { failed++; console.log(`FAIL  ${label}: ended on ${at}, ${passes} rules ran`); continue; }
      if (!found.length) { console.log(`ok    ${label}`); continue; }
      failed += found.length;
      console.log(`FAIL  ${label}`);
      for (const v of found) console.log(`      ${v.impact} ${v.id}: ${v.help}\n        ${v.nodes.slice(0, 3).join('\n        ')}${v.nodes.length > 3 ? `\n        … ${v.nodes.length - 3} more` : ''}`);
    }
  }
} finally {
  await cdp('Browser.close').catch(() => {});
  chrome.kill();
  await wait(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failed ? `\n${failed} violation(s)` : '\nno violations');
process.exit(failed ? 1 : 0);
