// แจ้งเตือนงานใหม่ on every back-office page of the PR team (pr.html, pr-news.html, pr-collections.html, pr-import.html,
// report.html, chanon.html): when someone sends work in (or sends it again after fixing it), a short chime,
// a notice with the work's title and a "ดูงาน" link, the count in the tab title while the tab is in the background,
// and a system notification if the browser allows it. Needs auth.js (window.api, window.ME).
//   <div id="alertSlot"></div> in the side bar gets the on/off switch (kept in this browser)
//   [data-arrivals-badge] gets the number of work the PR team has not read yet (the menu item งานที่ส่งเข้ามา);
//   the red dot on the account button follows the same number
//   window.onArrivals(items) is called with the new work (pr.html refreshes its list)
// A new คำขอใช้บริการ is the most urgent: a card in the middle of the screen with a louder chime that rings again until
// it is closed; window.onRequestArrivals(requests) is called with them (requests.html refreshes its list)
(function () {
  const KEY = 'deskAlerts';
  const EVERY = 20000;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let on = true;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) {}
  let since = null, unseen = 0, unread = 0, timer = null;
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
          ${more > 0 ? '<a href="pr.html?status=review" class="press t-spring inline-flex h-10 items-center rounded-full border border-line-strong px-4 font-display text-[14px] font-medium hover:-translate-y-0.5">ดูทั้งหมด</a>' : ''}
        </div>
        <button type="button" data-close-arrivals class="icon-btn absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full text-ink2 hover:text-ink" aria-label="ปิดการแจ้งเตือน">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>`;
    box.querySelector('[data-close-arrivals]').addEventListener('click', () => { box.innerHTML = ''; });
  }
  const BELL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>';

  // ---- คำขอใช้บริการใหม่: the most urgent, so a card in the middle of the screen and a louder chime that rings
  // again every few seconds until someone closes the card (at most RING_FOR) ----
  const ASK = { photo: 'ถ่ายภาพ', video: 'ถ่ายวิดีโอ', news: 'เขียนข่าว', other: 'อื่น ๆ' };
  const RING_EVERY = 4000, RING_FOR = 30000;
  let asked = [], ring = null, ringStop = null;
  function urgentChime() {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    [[987.8, 0], [1318.5, 0.14], [1760, 0.28]].forEach(([f, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t + d); o.stop(t + d + 0.55);
    });
  }
  function stopRing() { clearInterval(ring); clearTimeout(ringStop); ring = ringStop = null; }
  function startRing() {
    stopRing();
    urgentChime();
    ring = setInterval(urgentChime, RING_EVERY);
    ringStop = setTimeout(stopRing, RING_FOR);
  }
  const when = (s) => { try { return new Date(s).toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' น.'; } catch (e) { return ''; } };
  const BTN = 'press t-spring inline-flex h-11 w-full items-center sm:w-auto sm:flex-1 justify-center rounded-full px-5 font-display text-[15px] font-semibold hover:-translate-y-0.5';

  let dlg = null;
  function requestAlert(list) {
    asked = [...list, ...asked.filter((a) => !list.some((n) => n.id === a.id))];
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'request-alert w-[min(460px,calc(100vw-24px))] max-h-[calc(100dvh-24px)] overflow-hidden rounded-card border border-line bg-shell p-0 text-ink shadow-float';
      dlg.setAttribute('role', 'alertdialog');
      dlg.setAttribute('aria-labelledby', 'raTitle');
      dlg.setAttribute('aria-describedby', 'raWhat');
      dlg.innerHTML = `
        <span class="block h-1.5 bg-grad" aria-hidden="true"></span>
        <div class="p-6 text-center">
          <span class="arrivals-bell mx-auto grid h-16 w-16 place-items-center rounded-full bg-red-soft text-brand" aria-hidden="true">${BELL.replace(/"16"/g, '"30"')}</span>
          <h2 id="raTitle" class="mt-3 font-display text-[22px] font-semibold leading-snug tracking-[-0.02em] text-brand">มีคำขอใช้บริการใหม่</h2>
          <p data-ra-more class="mt-1 text-[14px] leading-relaxed text-ink2" hidden></p>
          <div id="raWhat" class="mt-4 rounded-2xl bg-surface2 p-4 text-left">
            <p data-ra="title" class="font-display text-[18px] font-semibold leading-snug [overflow-wrap:anywhere]"></p>
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[14px] leading-relaxed">
              <dt class="text-ink2">ประเภท</dt><dd data-ra="type"></dd>
              <dt class="text-ink2">วันเวลา</dt><dd data-ra="when"></dd>
              <dt class="text-ink2">สถานที่</dt><dd data-ra="location" class="[overflow-wrap:anywhere]"></dd>
              <dt class="text-ink2">ผู้ขอ</dt><dd data-ra="requester" class="[overflow-wrap:anywhere]"></dd>
            </dl>
          </div>
          <div class="mt-5 flex flex-col gap-2 sm:flex-row">
            <a data-ra-go class="bg-grad shadow-glow text-white ${BTN}">ดูคำขอ</a>
            <button type="button" data-ra-ok class="border border-line-strong bg-surface ${BTN} font-medium">รับทราบ</button>
          </div>
        </div>`;
      document.body.appendChild(dlg);
      dlg.querySelector('[data-ra-ok]').addEventListener('click', () => dlg.close());
      dlg.addEventListener('close', () => { stopRing(); asked = []; });
    }
    const first = asked[0], more = asked.length - 1;
    const set = (k, v) => { dlg.querySelector(`[data-ra="${k}"]`).textContent = v || '-'; };
    set('title', first.title); set('type', ASK[first.type]); set('when', when(first.startAt)); set('location', first.location); set('requester', first.requester);
    const moreEl = /** @type {HTMLElement} */ (dlg.querySelector('[data-ra-more]'));
    moreEl.hidden = more < 1;
    moreEl.textContent = more > 0 ? `และอีก ${more} คำขอที่รอพิจารณา` : '';
    /** @type {HTMLAnchorElement} */ (dlg.querySelector('[data-ra-go]')).href = more > 0 ? 'requests.html' : `requests.html?id=${encodeURIComponent(first.id)}`;
    if (!dlg.open) dlg.showModal();
  }

  // ---- Count: the unread work in the menu badge and, while the tab is in the background, the work that came in
  // since the page opened in the tab title ----
  function paintCount() {
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-arrivals-badge]')).forEach((b) => {
      b.textContent = String(unread);
      b.hidden = !unread;
      b.setAttribute('aria-label', `งานใหม่ ${unread} งาน`);
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
      const asks = since ? r.requests || [] : [];
      since = r.now;
      if (asks.length) {
        unseen += asks.length;
        paintCount();
        window.onRequestArrivals?.(asks);
        requestAlert(asks); // shown even with the switch off: nothing is more urgent; the switch only mutes it
        if (on) {
          startRing();
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            try {
              const n = new Notification(asks.length > 1 ? `มีคำขอใช้บริการใหม่ ${asks.length} คำขอ` : 'มีคำขอใช้บริการใหม่',
                { body: `${asks[0].title}\n${asks[0].requester || ''}`, tag: 'pr-requests', icon: '/assets/img/icon-180.png', requireInteraction: true });
              n.onclick = () => { window.focus(); n.close(); };
            } catch (e) {}
          }
        }
      }
      if (r.unread !== unread) {
        unread = r.unread;
        paintCount();
        const me = await window.ME;
        if (me && me.prUnread !== unread) { me.prUnread = unread; window.renderAccountButton?.(); }
      }
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
    slot.innerHTML = `<button type="button" id="alertSwitch" role="switch" aria-checked="${on}" class="alert-switch press t-quick flex min-h-11 w-full items-center gap-3 rounded-2xl border border-line-strong bg-surface2 px-3 py-1 text-left font-display text-[14px] font-medium">
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
