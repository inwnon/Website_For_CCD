// แจ้งเตือนงานใหม่ on every back-office page of the PR team (pr.html, pr-news.html, pr-collections.html, pr-import.html,
// report.html, admin.html, digest-studio.html): when someone sends work in (or sends it again after fixing it), a short chime,
// a notice with the work's title and a "ดูงาน" link, the count in the tab title while the tab is in the background,
// and a system notification if the browser allows it. Needs auth.js (window.api, window.ME).
//   <div id="alertSlot"></div> in the side bar gets the on/off switch (kept in this browser)
//   [data-arrivals-badge] gets the number of new work since the page opened (the menu item งานที่ส่งเข้ามา)
//   window.onArrivals(items) is called with the new work (pr.html refreshes its list)
(function () {
  const KEY = 'deskAlerts';
  const EVERY = 20000;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let on = true;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) {}
  let since = null, unseen = 0, timer = null;
  const TYPE = { news: 'ข่าวพร้อมภาพ', video: 'วิดีโอ', banner: 'แบนเนอร์ / อินโฟกราฟิก' };

  // ---- Chime: two soft notes made in the browser (no sound file). Browsers allow sound only after the page was used
  // once (a click or a key), so the audio is unlocked on the first one.
  let ctx = null;
  const unlock = () => {
    try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
  };
  addEventListener('pointerdown', unlock, { once: true, capture: true });
  addEventListener('keydown', unlock, { once: true, capture: true });
  function chime() {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    [[880, 0], [1318.5, 0.16]].forEach(([f, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.22, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.55);
      o.connect(g).connect(ctx.destination);
      o.start(t + d); o.stop(t + d + 0.6);
    });
  }

  // ---- The notice (bottom right; a phone: bottom, full width) ----
  let box = null;
  function notice(items) {
    if (!box) {
      box = document.createElement('section');
      box.id = 'arrivals';
      box.setAttribute('aria-label', 'แจ้งเตือนงานใหม่');
      box.className = 'arrivals fixed inset-x-3 bottom-3 z-[95] sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[380px]';
      document.body.appendChild(box);
    }
    const first = items[0], more = items.length - 1;
    const href = `pr.html?status=review&ref=${encodeURIComponent(first.ref)}`;
    box.innerHTML = `
      <div class="arrivals-card relative overflow-hidden rounded-card border border-line bg-shell p-4 pr-12 shadow-float" role="status">
        <span class="absolute inset-y-0 left-0 w-1.5 bg-grad" aria-hidden="true"></span>
        <p class="flex items-center gap-2 pl-2 font-display text-[14px] font-semibold text-brand">
          <span class="arrivals-bell grid h-8 w-8 shrink-0 place-items-center rounded-full bg-red-soft" aria-hidden="true">${BELL}</span>
          ${first.again ? 'ผู้ส่งแก้ไขงานแล้วส่งกลับมา' : 'มีงานใหม่ส่งเข้ามา'}${more > 0 ? ` และอีก ${more} งาน` : ''}
        </p>
        <p class="clamp-2 mt-2 pl-2 font-display text-[16px] font-semibold leading-snug text-ink">${esc(first.title)}</p>
        <p class="mt-0.5 pl-2 text-[13px] text-ink2">${esc(TYPE[first.type] || '')} จาก ${esc(first.unit)} โดย ${esc(first.sender)}</p>
        <div class="mt-3 flex gap-2 pl-2">
          <a href="${href}" class="bg-grad press t-spring inline-flex h-10 items-center rounded-full px-5 font-display text-[14px] font-semibold text-white shadow-glow hover:-translate-y-0.5">ดูงาน</a>
          ${more > 0 ? '<a href="pr.html?status=review" class="press t-spring inline-flex h-10 items-center rounded-full border border-line px-4 font-display text-[14px] font-medium hover:-translate-y-0.5">ดูทั้งหมด</a>' : ''}
        </div>
        <button type="button" data-close-arrivals class="icon-btn absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full text-ink2 hover:text-ink" aria-label="ปิดการแจ้งเตือน">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>`;
    box.querySelector('[data-close-arrivals]').addEventListener('click', () => { box.innerHTML = ''; });
  }
  const BELL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>';

  // ---- Count: the badge in the menu and, while the tab is in the background, the tab title ----
  function paintCount() {
    document.querySelectorAll('[data-arrivals-badge]').forEach((b) => {
      b.textContent = unseen;
      b.hidden = !unseen;
      b.setAttribute('aria-label', `งานใหม่ ${unseen} งาน`);
    });
    const plain = document.title.replace(/^\(\d+\) /, '');
    document.title = unseen && document.hidden ? `(${unseen}) ${plain}` : plain;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { document.title = document.title.replace(/^\(\d+\) /, ''); check(); }
  });

  // ---- Asking the server ----
  async function check() {
    clearTimeout(timer);
    try {
      const r = await api('/pr/arrivals' + (since ? `?since=${encodeURIComponent(since)}` : ''));
      const fresh = since ? r.items : []; // the first answer only sets the time to ask from
      since = r.now;
      if (fresh.length) {
        unseen += fresh.length;
        paintCount();
        window.onArrivals?.(fresh);
        if (on) {
          notice(fresh);
          chime();
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            try {
              const n = new Notification(fresh.length > 1 ? `มีงานใหม่ส่งเข้ามา ${fresh.length} งาน` : fresh[0].again ? 'ผู้ส่งแก้ไขงานแล้วส่งกลับมา' : 'มีงานใหม่ส่งเข้ามา',
                { body: `${fresh[0].title}\n${fresh[0].unit}`, tag: 'pr-arrivals', icon: '/assets/img/icon-180.png' });
              n.onclick = () => { window.focus(); location.href = `pr.html?status=review&ref=${encodeURIComponent(fresh[0].ref)}`; };
            } catch (e) {}
          }
        }
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) return; // signed out or not the PR team: stop
    }
    timer = setTimeout(check, document.hidden ? EVERY * 3 : EVERY);
  }

  // ---- On / off, in the side bar ----
  function paintSwitch() {
    const slot = document.getElementById('alertSlot');
    if (!slot) return;
    slot.innerHTML = `<button type="button" id="alertSwitch" role="switch" aria-checked="${on}" class="alert-switch press t-quick flex h-11 w-full items-center gap-3 rounded-2xl border border-line bg-surface2 px-3 text-left font-display text-[14px] font-medium">
      <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full ${on ? 'bg-red-soft text-brand' : 'bg-shell text-ink2'}" aria-hidden="true">${BELL}</span>
      <span class="min-w-0 flex-1 leading-tight">แจ้งเตือนงานใหม่<span class="block text-[12px] font-normal text-ink2">${on ? 'เปิดอยู่ มีเสียงเตือน' : 'ปิดอยู่'}</span></span>
      <span class="alert-track relative h-6 w-10 shrink-0 rounded-full ${on ? 'bg-grad' : 'bg-line'}" aria-hidden="true"><span class="t-spring absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-raised ${on ? 'translate-x-4' : ''}"></span></span>
    </button>`;
    slot.querySelector('button').addEventListener('click', () => {
      on = !on;
      try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {}
      unlock();
      // Turning it on: ask once whether the browser may show notifications while the page is in the background
      if (on && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      if (on) chime();
      paintSwitch();
      document.getElementById('alertSwitch')?.focus();
    });
  }

  // Start for the PR team only, once the side bar is on the page
  Promise.resolve(window.ME).then((me) => {
    const role = me?.user?.role;
    if (role !== 'pr' && role !== 'admin') return;
    const go = () => { paintSwitch(); paintCount(); check(); };
    if (document.readyState === 'complete') setTimeout(go, 0); else addEventListener('load', go, { once: true });
  });
  window.arrivalsRepaint = () => { paintSwitch(); paintCount(); };
})();
