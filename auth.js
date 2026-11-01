// Signed-in state shared by every page
// - window.api(path, { method, body }): calls /api, returns the JSON or throws an Error with .status and .details
// - window.ME: Promise of { user, unread, devLogin } from the server session (user is null when signed out)
// - Header: an element with id="login" becomes the account menu (profile, inbox, PR tools, settings, theme, sign out)
// - window.loginUrl(next), window.devLogin(as)
// Pages not yet connected to the server (submit, inbox, login) still use the prototype parts below:
// - window.PROFILE: the profile saved in localStorage by login.html, or null
// - window.SUBS: read/write the prototype's submissions in localStorage
// Connected pages set window.SERVER_AUTH = true before this script so the header ignores the prototype profile.
(function () {
  async function api(path, opts = {}) {
    /** @type {RequestInit & { headers: Record<string, string> }} */
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch('/api' + path, init); } catch (e) { throw Object.assign(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง'), { status: 0 }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง'), { status: res.status, details: data.details });
    return data;
  }
  window.api = api;
  window.ME = api('/me').catch(() => ({ user: null, unread: 0 }));
  // login.html comes back to this page (or `next`) after signing in
  window.loginUrl = (next = location.pathname.replace(/^\//, '') + location.search) => `login.html?next=${encodeURIComponent(next || 'index.html')}`;
  // Development sign-in (server has ALLOW_DEV_LOGIN=1): as = staff | student | external | pr | admin | coordinator | intern
  window.devLogin = async (as) => { await api('/auth/dev', { method: 'POST', body: { as } }); location.reload(); };

  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const profile = read('profile');
  window.PROFILE = profile;

  // ---- Submissions ----
  // status: review (รอ PR ตรวจ) · writing (PR กำลังเขียนข่าว) · revise (ขอให้แก้ไข) · published
  const KEY = 'submissions';
  const daysAgo = (d, h = 10, m = 0) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, m, 0, 0); return t.toISOString(); };
  function seed(p) {
    const unit = p.subUnit || p.unit || '';
    return [
      {
        ref: 'NW-2569-1077', type: 'news', title: 'ค่ายนักวิทยาศาสตร์น้อย ประจำปี 2569', unit, audience: 'บุคคลทั่วไป',
        status: 'revise', unread: true, sentAt: daysAgo(2, 9, 40),
        history: [{ status: 'sent', at: daysAgo(2, 9, 40) }, { status: 'review', at: daysAgo(2, 9, 40) }, { status: 'revise', at: daysAgo(0, 8, 15) }],
        thread: [{ from: 'pr', name: 'งานประชาสัมพันธ์', at: daysAgo(0, 8, 15), text: 'ภาพชุดนี้ความละเอียดต่ำเกินไปสำหรับภาพปก ขอภาพต้นฉบับเพิ่ม 3–5 ภาพ และช่วยยืนยันชื่อ-ตำแหน่งของประธานในพิธีด้วย' }],
      },
      {
        ref: 'NW-2569-1081', type: 'news', title: 'อบรมเชิงปฏิบัติการออกแบบการเรียนรู้สำหรับครูประจำการ', unit, audience: 'บุคคลทั่วไป',
        status: 'writing', unread: true, sentAt: daysAgo(1, 14, 5), prWrites: true,
        history: [{ status: 'sent', at: daysAgo(1, 14, 5) }, { status: 'writing', at: daysAgo(0, 9, 30) }],
        thread: [{ from: 'pr', name: 'งานประชาสัมพันธ์', at: daysAgo(0, 9, 30), text: 'ได้รับคำกล่าวรายงานและกำหนดการแล้ว ทีม PR กำลังเขียนข่าว จะส่งร่างให้ตรวจทานภายในวันพรุ่งนี้' }],
      },
      {
        ref: 'VD-2569-2210', type: 'video', title: 'บรรยากาศพิธีไหว้ครู ประจำปีการศึกษา 2569', unit, audience: 'ภายในมหาวิทยาลัย',
        status: 'review', unread: false, sentAt: daysAgo(0, 7, 50),
        history: [{ status: 'sent', at: daysAgo(0, 7, 50) }, { status: 'review', at: daysAgo(0, 7, 50) }],
        thread: [],
      },
      {
        ref: 'NW-2569-1042', type: 'news', title: 'มรส. ลงนามความร่วมมือทางวิชาการกับเครือข่ายโรงเรียนภาคใต้ตอนบน', unit, audience: 'บุคคลทั่วไป',
        status: 'published', unread: false, sentAt: daysAgo(4, 11, 0), url: 'news.html',
        history: [{ status: 'sent', at: daysAgo(4, 11, 0) }, { status: 'review', at: daysAgo(4, 11, 0) }, { status: 'published', at: daysAgo(3, 10, 30) }],
        thread: [{ from: 'pr', name: 'งานประชาสัมพันธ์', at: daysAgo(3, 10, 30), text: 'เผยแพร่ข่าวบนเว็บไซต์และเพจมหาวิทยาลัยแล้ว ขอบคุณที่ส่งข่าวมาครับ' }],
      },
    ];
  }
  // Only university accounts send work, so only they get sample data
  const canSubmit = !!profile && profile.role !== 'external';
  window.SUBS = {
    all() {
      if (!profile) return [];
      let list = read(KEY);
      if (!Array.isArray(list)) { list = canSubmit ? seed(profile) : []; write(KEY, list); }
      return list;
    },
    save(list) { write(KEY, list); },
    add(item) { const list = this.all(); list.unshift(item); this.save(list); },
    unread() { return this.all().filter((s) => s.unread).length; },
  };

  // ---- Header account menu (re-run with window.renderAccountButton() after marking items read) ----
  // The page's <a id="login"> becomes a button that opens a menu: profile, inbox, PR tools, settings, theme, sign out.
  const ROLE_TH = { pr: 'ทีม PR', admin: 'ผู้ดูแลระบบ', coordinator: 'ผู้ประสานงานหน่วยงาน', intern: 'นักศึกษาฝึกงาน สสอ.', secretary: 'เลขานุการผู้บริหาร', executive: 'ผู้บริหาร', staff: 'บุคลากร', student: 'นักศึกษา', external: 'บุคคลภายนอก' };
  // Developer accounts switch between these two (POST /api/me/role); ผู้พัฒนาระบบ has the highest rights
  const SWITCH = [['pr', 'ทีม PR งานสื่อสารองค์กร'], ['admin', 'ผู้พัฒนาระบบ']];
  const roleName = (u) => (u.developer ? Object.fromEntries(SWITCH)[u.role] : ROLE_TH[u.role]) || '';
  window.roleName = roleName;
  // Back-office modules (SPEC.md): the account menu here and the side menu in desk.js show those in me.modules (server/access.mjs).
  // soon: the page is not built yet, so nobody sees the entry; remove the flag when it goes live (and add the page to pr.html's menu).
  window.MODULE_PAGES = [
    { id: 'calendar', href: 'calendar.html', label: 'ปฏิทินงาน', icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>' },
    { id: 'requests', href: 'requests.html', label: 'คำขอใช้บริการ', icon: '<path d="M9 4h6v3H9z"/><path d="M9 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-3"/><path d="m9 14 2 2 4-4"/>' },
    { id: 'documents', href: 'documents.html', label: 'คลังเอกสาร', soon: true, icon: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>' },
    { id: 'equipment', href: 'equipment.html', label: 'อุปกรณ์', soon: true, icon: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>' },
    { id: 'phonebook', href: 'phonebook.html', label: 'สมุดโทรศัพท์', icon: '<path d="M21 16.5v3a1.5 1.5 0 0 1-1.6 1.5A17 17 0 0 1 3 4.6 1.5 1.5 0 0 1 4.5 3h3a1 1 0 0 1 1 .8l.8 3.4a1 1 0 0 1-.3 1L7.3 9.7a14 14 0 0 0 7 7l1.5-1.7a1 1 0 0 1 1-.3l3.4.8a1 1 0 0 1 .8 1z"/>' },
    { id: 'students', href: 'students.html', label: 'ทีมนักศึกษา', soon: true, icon: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.5a6 6 0 0 1 3 5.5"/>' },
  ];
  // นักศึกษาฝึกงาน สสอ. are what their email makes them (a student, usually) everywhere but the import page
  window.baseRole = (u) => u?.baseRole || u?.role;
  // After switching: the PR team cannot open the settings page, so go to the PR desk instead of a "no access" page
  const afterSwitch = (role) => { if (role === 'pr' && /(^|\/)admin\.html$/.test(location.pathname)) location.href = 'pr.html'; else location.reload(); };
  async function switchRole(role, buttons) {
    buttons.forEach((b) => { b.disabled = true; });
    try { await api('/me/role', { method: 'POST', body: { role } }); afterSwitch(role); } catch (err) { buttons.forEach((b) => { b.disabled = false; }); alert(err.message); }
  }
  // The two buttons in a back-office side bar (#roleSwitch); shown for developer accounts only
  /** @param {HTMLElement} box */
  window.mountRoleSwitch = (box, u) => {
    if (!box || !u?.developer) return;
    box.hidden = false;
    box.innerHTML = SWITCH.map(([k, l]) => {
      const on = u.role === k;
      return `<button type="button" data-switch-role="${k}" aria-pressed="${on}" class="press t-quick min-h-10 rounded-xl px-2 py-1.5 font-display text-[12px] leading-tight ${on ? 'bg-shell font-semibold text-purple shadow-raised' : 'font-medium text-ink2 hover:text-ink'}">${l}</button>`;
    }).join('');
    box.addEventListener('click', (e) => {
      const b = /** @type {HTMLButtonElement} */ ((/** @type {Element} */ (e.target)).closest('[data-switch-role]'));
      if (b && b.getAttribute('aria-pressed') !== 'true' && !b.disabled) switchRole(b.dataset.switchRole, [...box.querySelectorAll('button')]);
    });
  };
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const svg = (d, w = 18) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const IC = {
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    inbox: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    send: '<path d="M12 5v14M5 12h14"/>',
    desk: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
    news: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
    book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5a2.5 2.5 0 0 0 0 5H20"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    out: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l-5-5 5-5M5 12h12"/>',
    in: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  };
  const CSS = `
    .acct { position: relative; }
    .acct-btn { position: relative; display: grid; place-items: center; height: 44px; width: 44px; border-radius: 999px; background: rgb(var(--purple-soft)); color: rgb(var(--purple)); transition: transform .45s var(--spring); }
    .acct-btn:hover { transform: translateY(-2px); }
    .acct-btn:active { transform: scale(.94); }
    .acct-btn:focus-visible, .acct-item:focus-visible, .acct-seg button:focus-visible, .acct-cta:focus-visible { outline: 2px solid rgb(var(--focus)); outline-offset: 2px; }
    .acct-btn[aria-expanded="true"] { box-shadow: 0 0 0 2px rgb(var(--shell)), 0 0 0 4px rgb(var(--purple) / .55); }
    .acct-av { display: grid; place-items: center; overflow: hidden; border-radius: 999px; font-family: Kanit, "Noto Sans Thai", sans-serif; font-weight: 600; color: #fff; background: var(--grad); }
    .acct-av img { height: 100%; width: 100%; object-fit: cover; }
    .acct-btn .acct-av { height: 38px; width: 38px; font-size: 16px; }
    .acct-dot { position: absolute; right: -3px; top: -3px; display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 999px; background: rgb(var(--red)); color: rgb(var(--shell)); font: 600 11px/1 Kanit, sans-serif; box-shadow: 0 0 0 2px rgb(var(--shell)); }
    .acct-panel { position: absolute; right: 0; top: calc(100% + 10px); z-index: 70; width: min(336px, calc(100vw - 24px)); max-height: calc(100dvh - 96px); overflow-y: auto; overscroll-behavior: contain; text-align: left;
      border: 1px solid rgb(var(--line)); border-radius: 22px; background: rgb(var(--shell)); color: rgb(var(--ink)); box-shadow: var(--shadow-float);
      transform-origin: calc(100% - 22px) -6px; opacity: 0; transform: translateY(-6px) scale(.96); pointer-events: none; visibility: hidden;
      transition: opacity .18s ease-out, transform .4s var(--spring), visibility 0s .4s; }
    .acct-panel.open { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition: opacity .18s ease-out, transform .4s var(--spring), visibility 0s; }
    .acct-id { display: flex; gap: 12px; align-items: center; padding: 16px; background: rgb(var(--surface-2) / .7); border-bottom: 1px solid rgb(var(--line)); }
    .acct-id .acct-av { height: 48px; width: 48px; flex-shrink: 0; font-size: 20px; }
    .acct-name { font: 600 16px/1.35 Kanit, "Noto Sans Thai", sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .acct-mail { font-size: 13px; color: rgb(var(--ink-2)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .acct-role { margin-top: 6px; display: inline-block; max-width: 100%; border-radius: 999px; background: rgb(var(--purple-soft)); color: rgb(var(--purple)); padding: 0 10px; font: 600 12px/22px Kanit, sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: top; }
    .acct-grp { padding: 6px; }
    .acct-grp + .acct-grp { border-top: 1px solid rgb(var(--line)); }
    .acct-label { padding: 8px 10px 4px; font-size: 12px; color: rgb(var(--ink-2)); }
    .acct-item { position: relative; display: flex; width: 100%; align-items: center; gap: 12px; min-height: 42px; padding: 0 10px; border-radius: 12px; font: 500 15px/1.3 Kanit, "Noto Sans Thai", sans-serif; text-align: left; color: rgb(var(--ink)); isolation: isolate; transition: transform .3s var(--spring); }
    .acct-item::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: rgb(var(--surface-2)); opacity: 0; transition: opacity .2s ease-out; }
    .acct-item:hover::before, .acct-item:focus-visible::before { opacity: 1; }
    .acct-item:active { transform: scale(.98); }
    .acct-item > svg { flex-shrink: 0; color: rgb(var(--ink-2)); }
    .acct-n { margin-left: auto; min-width: 22px; border-radius: 999px; background: rgb(var(--red)); color: rgb(var(--shell)); padding: 0 7px; font: 600 12px/22px Kanit, sans-serif; text-align: center; }
    .acct-item[aria-current="page"], .acct-item[aria-current="page"] > svg { color: rgb(var(--purple)); }
    .acct-item.danger, .acct-item.danger > svg { color: rgb(var(--red)); }
    .acct-theme { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px 8px; font: 500 15px Kanit, "Noto Sans Thai", sans-serif; }
    .acct-seg { display: inline-flex; padding: 3px; border-radius: 999px; background: rgb(var(--surface-2)); border: 1px solid rgb(var(--line)); }
    .acct-seg button { height: 30px; padding: 0 10px; border-radius: 999px; font-size: 13px; color: rgb(var(--ink-2)); transition: transform .35s var(--spring); }
    .acct-seg button:hover { color: rgb(var(--ink)); }
    .acct-seg button:active { transform: scale(.94); }
    .acct-seg button[aria-pressed="true"] { background: rgb(var(--shell)); color: rgb(var(--ink)); box-shadow: var(--shadow-raised); }
    .acct-roles { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 2px 4px 6px; padding: 4px; border-radius: 16px; background: rgb(var(--surface-2)); border: 1px solid rgb(var(--line)); }
    .acct-roles button { min-height: 44px; padding: 6px 8px; border-radius: 12px; font: 500 13px/1.35 Kanit, "Noto Sans Thai", sans-serif; color: rgb(var(--ink-2)); transition: transform .35s var(--spring); }
    .acct-roles button:hover { color: rgb(var(--ink)); }
    .acct-roles button:active { transform: scale(.96); }
    .acct-roles button:focus-visible { outline: 2px solid rgb(var(--focus)); outline-offset: 2px; }
    .acct-roles button[aria-pressed="true"] { background: rgb(var(--shell)); color: rgb(var(--purple)); font-weight: 600; box-shadow: var(--shadow-raised); }
    .acct-roles button:disabled { opacity: .6; }
    .acct-intro { padding: 18px 16px 4px; }
    .acct-intro p + p { font-size: 14px; line-height: 1.6; color: rgb(var(--ink-2)); margin-top: 4px; }
    .acct-cta { margin: 12px 16px 14px; display: flex; height: 46px; align-items: center; justify-content: center; gap: 8px; border-radius: 999px; background: var(--grad); color: #fff; font: 600 15px Kanit, sans-serif; box-shadow: var(--shadow-glow); transition: transform .45s var(--spring); }
    .acct-cta:hover { transform: translateY(-2px); }
    .acct-cta:active { transform: scale(.97); }
    @media (prefers-reduced-motion: reduce) { .acct-panel, .acct-panel.open, .acct-btn, .acct-cta, .acct-item, .acct-seg button, .acct-roles button { transition: none; } }
  `;

  // Theme: light | dark | system (no saved choice). The header switch and this menu stay in step.
  const themeNow = () => { try { return localStorage.getItem('theme') || 'system'; } catch (e) { return 'system'; } };
  function setTheme(t) {
    try { if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t); } catch (e) {}
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.getElementById('themeToggle')?.setAttribute('aria-checked', String(dark));
  }

  const here = location.pathname.replace(/^\//, '') || 'index.html';
  const item = (href, icon, label, extra = '') => `<a class="acct-item" href="${href}"${href.split(/[?#]/)[0] === here && !/[?#]/.test(href) ? ' aria-current="page"' : ''}>${svg(IC[icon])}<span>${label}</span>${extra}</a>`;
  const avatar = (u) => (u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="" referrerpolicy="no-referrer">` : esc(([...(u.name || u.email || '?').trim()][0] || '?').toUpperCase()));
  const affiliation = (u) => (u.role === 'external' ? u.org : u.role === 'student' ? u.major || u.unit : u.subUnit || u.unit) || '';

  // เพิ่มข่าว (pr-import.html?mode=add) in place of ส่งข่าว in the header and the menu bar, for the PR team only
  const ADD_NEWS = 'pr-import.html?mode=add';
  const isDesk = (u) => u?.role === 'pr' || u?.role === 'admin';
  function addNewsButtons(u) {
    if (!isDesk(u)) return;
    /** @type {NodeListOf<HTMLAnchorElement>} */ (document.querySelectorAll('header a[href="submit.html"], nav a[href="submit.html"]')).forEach((a) => {
      a.href = ADD_NEWS;
      a.removeAttribute('aria-current');
      const w = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      for (let t; (t = w.nextNode());) if (t.nodeValue.includes('ส่งข่าว')) t.nodeValue = t.nodeValue.replace('ส่งข่าว', 'เพิ่มข่าว');
      if (a.getAttribute('aria-label')) a.setAttribute('aria-label', 'เพิ่มข่าว');
    });
  }

  function menuHtml(me) {
    const u = me.user;
    const theme = themeNow();
    const themeRow = `<div class="acct-theme"><span>ธีม</span><div class="acct-seg" role="group" aria-label="ธีมของหน้าเว็บ">${[['light', 'สว่าง'], ['dark', 'มืด'], ['system', 'ตามเครื่อง']].map(([v, l]) => `<button type="button" data-theme="${v}" aria-pressed="${theme === v}">${l}</button>`).join('')}</div></div>`;
    if (!u) {
      return `<div class="acct-intro"><p class="acct-name">ยังไม่ได้เข้าสู่ระบบ</p><p>เข้าสู่ระบบด้วยบัญชี Google เพื่อส่งข่าวถึงงานประชาสัมพันธ์ ติดตามงานที่ส่ง และอ่านข่าวภายในมหาวิทยาลัย</p></div>
        <a class="acct-cta" href="${esc(window.loginUrl())}">${svg(IC.in)}เข้าสู่ระบบ</a>
        <div class="acct-grp">${themeRow}${item('privacy.html', 'shield', 'นโยบายความเป็นส่วนตัว')}</div>`;
    }
    const aff = affiliation(u);
    const modules = window.MODULE_PAGES.filter((m) => !m.soon && me.modules?.includes(m.id));
    const moduleTools = modules.length ? `<div class="acct-grp"><p class="acct-label">งานสื่อสารองค์กร</p>${modules.map((m) => `<a class="acct-item" href="${m.href}">${svg(m.icon)}<span>${m.label}</span></a>`).join('')}</div>` : '';
    const prTools = u.role === 'pr' || u.role === 'admin'
      ? `<div class="acct-grp"><p class="acct-label">งานประชาสัมพันธ์</p>${item('pr.html', 'desk', 'งานที่ส่งเข้ามา')}${item('pr-news.html', 'news', 'จัดการข่าว')}${item('pr-collections.html', 'book', 'อัลบั้มข่าว')}${item('report.html', 'chart', 'รายงาน')}${u.role === 'admin' ? item('chanon.html', 'gear', 'ตั้งค่าระบบ') : ''}</div>`
      : u.role === 'coordinator' ? `<div class="acct-grp">${item('report.html', 'chart', 'รายงานของหน่วยงาน')}</div>`
      : u.role === 'intern' ? `<div class="acct-grp"><p class="acct-label">งานประชาสัมพันธ์</p>${item('pr-import.html', 'news', 'นำเข้าข่าวย้อนหลัง')}</div>` : '';
    return `<div class="acct-id"><span class="acct-av">${avatar(u)}</span><div style="min-width:0"><p class="acct-name">${esc(u.name || u.email)}</p>${u.name ? `<p class="acct-mail">${esc(u.email)}</p>` : ''}<span class="acct-role">${esc(roleName(u))}${aff ? ` ${esc(aff)}` : ''}</span></div></div>
      ${u.developer ? `<div class="acct-grp"><p class="acct-label" id="acctRoleLabel">สลับบทบาท</p><div class="acct-roles" role="group" aria-labelledby="acctRoleLabel">${SWITCH.map(([k, l]) => `<button type="button" data-switch-role="${k}" aria-pressed="${u.role === k}">${l}</button>`).join('')}</div></div>` : ''}
      <div class="acct-grp">${item('inbox.html', 'inbox', 'ข่าวของฉัน', me.unread ? `<span class="acct-n">${me.unread}<span class="sr-only"> รายการใหม่</span></span>` : '')}${isDesk(u) ? item(ADD_NEWS, 'send', 'เพิ่มข่าว') : window.baseRole(u) !== 'external' ? item('submit.html', 'send', 'ส่งข่าว') : ''}</div>
      ${prTools}
      ${moduleTools}
      <div class="acct-grp"><p class="acct-label">บัญชีและการตั้งค่า</p>${item('login.html?profile=1', 'edit', 'แก้ไขโปรไฟล์และสังกัด')}${item('inbox.html#notify', 'bell', 'การแจ้งเตือนทางอีเมล')}${item('privacy.html#rights', 'shield', 'ข้อมูลส่วนบุคคลของฉัน')}${themeRow}</div>
      <div class="acct-grp"><button type="button" class="acct-item danger" data-signout>${svg(IC.out)}<span>ออกจากระบบ</span></button></div>`;
  }

  let wired = false;
  async function renderAccountButton() {
    const old = document.getElementById('login');
    if (!old) return;
    if (!document.getElementById('acctCss')) document.head.insertAdjacentHTML('beforeend', `<style id="acctCss">${CSS}</style>`);
    const me = await window.ME;
    const u = me.user;
    let wrap = document.getElementById('acct');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'acct';
      wrap.className = 'acct';
      wrap.innerHTML = '<button type="button" id="login" class="acct-btn" aria-expanded="false" aria-controls="acctPanel"></button><div id="acctPanel" class="acct-panel" role="dialog" aria-label="เมนูบัญชี"></div>';
      old.replaceWith(wrap);
    }
    const btn = /** @type {HTMLElement} */ (wrap.querySelector('#login'));
    const panel = /** @type {HTMLElement} */ (wrap.querySelector('#acctPanel'));
    addNewsButtons(u);
    btn.innerHTML = (u ? `<span class="acct-av">${avatar(u)}</span>` : svg(IC.person, 20)) + (u && me.unread ? `<span class="acct-dot" aria-hidden="true">${me.unread}</span>` : '');
    btn.setAttribute('aria-label', u ? `บัญชีของ ${u.name || u.email}${me.unread ? ` มีข้อความใหม่ ${me.unread} รายการ` : ''}` : 'เมนูบัญชี ยังไม่ได้เข้าสู่ระบบ');
    panel.innerHTML = menuHtml(me);
    if (wired) return;
    wired = true;

    const focusables = () => [.../** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('a, button'))];
    const isOpen = () => panel.classList.contains('open');
    const open = (focusFirst) => { panel.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); if (focusFirst) focusables()[0]?.focus(); };
    const close = (back) => { if (!isOpen()) return; panel.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); if (back) btn.focus(); };
    btn.addEventListener('click', () => (isOpen() ? close() : open(false)));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(true); } });
    document.addEventListener('pointerdown', (e) => { if (!wrap.contains(/** @type {Node} */ (e.target))) close(); });
    wrap.addEventListener('focusout', (e) => { if (e.relatedTarget && !wrap.contains(/** @type {Node} */ (e.relatedTarget))) close(); });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(true); return; }
      if (!panel.contains(/** @type {Node} */ (e.target)) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const l = focusables();
      const i = l.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      l[e.key === 'Home' ? 0 : e.key === 'End' ? l.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + l.length) % l.length].focus();
    });
    panel.addEventListener('click', async (e) => {
      const t = /** @type {HTMLElement} */ ((/** @type {Element} */ (e.target)).closest('[data-theme]'));
      if (t) { setTheme(t.dataset.theme); panel.querySelectorAll('[data-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b === t))); return; }
      const sw = /** @type {HTMLElement} */ ((/** @type {Element} */ (e.target)).closest('[data-switch-role]'));
      if (sw) {
        if (sw.getAttribute('aria-pressed') !== 'true') switchRole(sw.dataset.switchRole, [...panel.querySelectorAll('[data-switch-role]')]);
        return;
      }
      if ((/** @type {Element} */ (e.target)).closest('[data-signout]')) {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        location.href = 'index.html';
        return;
      }
      if ((/** @type {Element} */ (e.target)).closest('a')) close();
    });
    // The header switch changes the theme too: keep the menu's choice in step
    document.getElementById('themeToggle')?.addEventListener('click', () => setTimeout(() => /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('[data-theme]')).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === themeNow()))), 0));
  }
  window.renderAccountButton = renderAccountButton;
  renderAccountButton();
})();
