// Back-office shell shared by pr-news.html, pr-collections.html, pr-import.html, report.html and admin.html (pr.html has its own copy of the menu).
// Needs auth.js (window.api, window.ME). The page provides:
//   <aside id="side"></aside>  <header id="mbar"></header>  <main id="main"> … <section id="gate" hidden></section> … </main>
// DESK.start({ page, allow }) fills the menu, checks the role and resolves to the signed-in user (or null: the gate is shown).
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TZ = 'Asia/Bangkok';
  const ROLE_TH = { pr: 'ทีม PR', admin: 'ผู้ดูแลระบบ', coordinator: 'ผู้ประสานงานหน่วยงาน', intern: 'นักศึกษาฝึกงาน สสอ.', staff: 'บุคลากร', student: 'นักศึกษา', external: 'บุคคลภายนอก' };
  const I = {
    inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
    news: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
    collections: '<path d="M4 6h16M4 6v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6M4 6l2-3h12l2 3"/><path d="M9 11h6M9 15h4"/>',
    add: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
    import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    admin: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    digest: '<path d="M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2zM22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z"/>',
    site: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  };
  // Menu: who sees each item
  const MENU = [
    { id: 'inbox', href: 'pr.html', label: 'งานที่ส่งเข้ามา', roles: ['pr', 'admin'] },
    { id: 'news', href: 'pr-news.html', label: 'ข่าวที่เผยแพร่', roles: ['pr', 'admin'] },
    { id: 'collections', href: 'pr-collections.html', label: 'อัลบั้มข่าว', roles: ['pr', 'admin'] },
    // เพิ่มข่าว: the PR team's own story of the day, live at once (pr-import.html?mode=add)
    { id: 'add', href: 'pr-import.html?mode=add', label: 'เพิ่มข่าว', roles: ['pr', 'admin'] },
    { id: 'import', href: 'pr-import.html', label: 'นำเข้าข่าวย้อนหลัง', roles: ['pr', 'admin', 'intern'] },
    { id: 'report', href: 'report.html', label: 'รายงาน', roles: ['pr', 'admin', 'coordinator'] },
    { id: 'admin', href: 'admin.html', label: 'ตั้งค่าระบบ', roles: ['admin'] },
    { sep: true },
    { id: 'digest', href: 'digest-studio.html', label: 'จัดทำเล่มสรุปข่าว', roles: ['pr', 'admin'] },
    { id: 'site', href: 'index.html', label: 'ไปหน้าเว็บไซต์', roles: ['pr', 'admin', 'coordinator', 'intern'] },
  ];
  const icon = (k, size = 19) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;

  function side(page, role) {
    const items = MENU.filter((m) => m.sep || (role && m.roles.includes(role)));
    return `
      <a href="index.html" class="press t-quick flex items-center gap-3 rounded-2xl px-2 hover:opacity-90"><span class="sr-only">ไปหน้าเว็บไซต์ </span>
        <span class="logo-crop h-11 w-11 shrink-0"><img src="/assets/img/logo-192.webp" alt=""></span>
        <span class="leading-tight">
          <span class="block font-display text-[19px] font-semibold"><span class="text-brand">คลังข่าว</span> <span class="text-royal">มรส.</span></span>
          <span class="block text-[12px] text-ink2">${role === 'coordinator' ? 'รายงานของหน่วยงาน' : 'หลังบ้านทีม PR'}</span>
        </span>
      </a>
      <nav class="mt-7 grid gap-1" aria-label="เมนูหลังบ้าน">
        ${role ? items.map((m) => m.sep ? '<span class="my-3 border-t border-line" aria-hidden="true"></span>' : `
          <a href="${m.href}" class="nav-item t-quick flex h-11 items-center gap-3 rounded-2xl px-3 font-display text-[15px] font-medium" ${m.id === page ? 'aria-current="true"' : ''}>${icon(m.id)}<span class="flex-1">${m.label}</span>${m.id === 'inbox' ? '<span data-arrivals-badge class="rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-5 text-white dark:text-bg" hidden></span>' : ''}</a>`).join('') : ''}
      </nav>
      <div class="mt-auto grid gap-3 pt-6">
        <div id="alertSlot"></div>
        <button id="themeToggle" type="button" role="switch" aria-checked="false" aria-label="โหมดมืด" class="group press t-quick relative inline-flex h-11 w-[78px] shrink-0 items-center rounded-full border border-line bg-surface2 p-1 hover:border-[rgb(var(--purple)/.45)]">
          <span class="t-spring absolute left-1 top-1 h-[34px] w-[34px] rounded-full bg-grad shadow-glow group-hover:scale-[1.06] dark:translate-x-[34px]" aria-hidden="true"></span>
          <span class="relative grid h-[34px] w-[34px] place-items-center text-white dark:text-ink2" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></span>
          <span class="relative grid h-[34px] w-[34px] place-items-center text-ink2 dark:text-white" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg></span>
        </button>
        <!-- Developer accounts: work as the PR team or as ผู้พัฒนาระบบ (POST /api/me/role) -->
        <div id="roleSwitch" class="grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface2 p-1" role="group" aria-label="สลับบทบาท" hidden></div>
        <div id="who" class="flex items-center gap-2 rounded-2xl bg-shell p-2 shadow-raised" hidden>
          <span id="whoAvatar" class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-purple-soft font-display text-[15px] font-semibold text-purple"></span>
          <span class="min-w-0 flex-1 leading-tight"><span id="whoName" class="block truncate font-display text-[14px] font-semibold"></span><span id="whoRole" class="block truncate text-[12px] text-ink2"></span></span>
          <button id="logout" type="button" class="icon-btn grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink2 hover:text-ink" aria-label="ออกจากระบบ">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l-5-5 5-5M5 12h12"/></svg>
          </button>
        </div>
      </div>`;
  }

  // ---- Toast ----
  function toast(msg, bad) {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      box.className = 'pointer-events-none fixed inset-x-0 bottom-4 z-[90] flex flex-col items-center gap-2 px-4';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = `toast-box flex max-w-[520px] items-center gap-3 rounded-2xl px-5 py-3 font-display text-[15px] font-medium shadow-float ${bad ? 'bg-brand text-white dark:text-bg' : 'bg-ink text-shell'}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, bad ? 6000 : 3200);
  }

  // ---- Gate: signed out, or a role that may not use this page ----
  function gate(me, allow) {
    const g = document.getElementById('gate');
    if (!g) return;
    const signedIn = !!me.user;
    const canReports = signedIn && me.user.role === 'coordinator';
    const canImport = signedIn && me.user.role === 'intern';
    const title = !signedIn ? 'เข้าสู่ระบบเพื่อใช้หลังบ้าน' : allow.includes('admin') && allow.length === 1 ? 'หน้านี้สำหรับผู้ดูแลระบบ' : 'หน้านี้สำหรับทีมงานประชาสัมพันธ์';
    const text = !signedIn ? 'ใช้บัญชีที่ได้รับสิทธิ์ในทีม PR หรือผู้ประสานงานหน่วยงาน'
      : canReports ? 'บัญชีผู้ประสานงานหน่วยงานเปิดได้เฉพาะหน้ารายงานของหน่วยงานตน'
      : canImport ? 'บัญชีนักศึกษาฝึกงาน สสอ. เปิดได้เฉพาะหน้านำเข้าข่าวย้อนหลัง'
      : `บัญชี ${me.user.email} ยังไม่มีสิทธิ์ใช้หน้านี้ ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์`;
    g.innerHTML = `
      <img src="/assets/img/hawky-480.webp" alt="" class="bob w-[140px] drop-shadow-[0_20px_28px_rgb(38_66_200/.22)]" width="1254" height="1254">
      <h1 class="font-display text-[22px] font-semibold">${title}</h1>
      <p class="max-w-[460px] text-[15px] text-ink2">${esc(text)}</p>
      <a href="${canReports ? 'report.html' : canImport ? 'pr-import.html' : signedIn ? 'index.html' : 'login.html'}" class="bg-grad press t-spring inline-flex h-12 items-center rounded-2xl px-6 font-display text-[16px] font-semibold text-white shadow-glow hover:-translate-y-0.5">${canReports ? 'ไปหน้ารายงาน' : canImport ? 'ไปหน้านำเข้าข่าวย้อนหลัง' : signedIn ? 'กลับหน้าเว็บไซต์' : 'เข้าสู่ระบบ'}</a>
      ${me.devLogin && !signedIn ? `<div class="flex flex-wrap justify-center gap-2">
        <span class="w-full text-[13px] text-ink2">โหมดพัฒนา: ทดลองเข้าสู่ระบบโดยไม่ใช้ Google</span>
        ${[['pr', 'ทีม PR'], ['admin', 'ผู้ดูแลระบบ'], ['coordinator', 'ผู้ประสานงาน (คณะครุศาสตร์)'], ['intern', 'นักศึกษาฝึกงาน สสอ.']].map(([k, l]) => `<button type="button" data-dev="${k}" class="press t-spring inline-flex h-11 items-center rounded-full border border-line bg-shell px-5 font-display text-[15px] font-medium shadow-raised hover:-translate-y-0.5">${l}</button>`).join('')}
      </div>` : ''}`;
    g.hidden = false;
    g.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-dev]');
      if (!b) return;
      try { await api('/auth/dev', { method: 'POST', body: { as: b.dataset.dev } }); location.reload(); } catch (err) { toast(err.message, true); }
    });
  }

  async function start({ page, allow }) {
    const me = await window.ME;
    const role = me.user?.role;
    const ok = !!me.user && allow.includes(role);
    document.getElementById('side').innerHTML = side(page, ok || role === 'coordinator' || role === 'intern' ? role : null);
    const item = MENU.find((m) => m.id === page);
    const mbar = document.getElementById('mbar');
    if (mbar) mbar.innerHTML = `
      <button id="menuBtn" type="button" class="hover-fill press t-quick grid h-11 w-11 shrink-0 place-items-center rounded-full" aria-label="เปิดเมนู" aria-controls="side" aria-expanded="false">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
      <span class="logo-crop h-9 w-9 shrink-0"><img src="/assets/img/logo-192.webp" alt=""></span>
      <span class="min-w-0 truncate font-display text-[17px] font-semibold">${item?.label || ''}</span>`;

    // Theme
    const sw = document.getElementById('themeToggle');
    sw.setAttribute('aria-checked', document.documentElement.classList.contains('dark'));
    sw.addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      sw.setAttribute('aria-checked', dark);
      try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
    });
    // Mobile drawer
    const sideEl = document.getElementById('side'), scrim = document.getElementById('scrim');
    const setMenu = (open) => {
      sideEl.classList.toggle('is-open', open);
      scrim?.classList.toggle('is-open', open);
      document.getElementById('menuBtn')?.setAttribute('aria-expanded', String(open));
    };
    document.getElementById('menuBtn')?.addEventListener('click', () => setMenu(!sideEl.classList.contains('is-open')));
    scrim?.addEventListener('click', () => setMenu(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

    if (me.user) {
      document.getElementById('who').hidden = false;
      document.getElementById('whoAvatar').textContent = (me.user.name || me.user.email).trim().charAt(0);
      document.getElementById('whoName').textContent = me.user.name || me.user.email;
      document.getElementById('whoRole').textContent = role === 'coordinator' && me.user.coordUnit ? `ผู้ประสานงาน ${me.user.coordUnit}` : window.roleName?.(me.user) || ROLE_TH[role] || '';
      document.getElementById('logout').addEventListener('click', async () => {
        try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
        location.href = 'index.html';
      });
      window.mountRoleSwitch?.(document.getElementById('roleSwitch'), me.user);
    }
    window.arrivalsRepaint?.();
    if (!ok) { gate(me, allow); return null; }
    return me.user;
  }

  // ---- Formatting ----
  const day = (d) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }).format(new Date(d));
  const dayTime = (d) => `${day(d)} ${new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(d))} น.`;
  const isoDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d ? new Date(d) : new Date());
  const num = (n) => Number(n || 0).toLocaleString('th-TH');

  window.DESK = { start, toast, esc, day, dayTime, isoDay, num, icon, ROLE_TH };
})();
