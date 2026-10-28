// ทางลัด (PR team and admins only): a dropdown at the end of the main menu (nav "เมนูหลัก", every page that has it).
// Each person chooses and orders their own desk pages ("ปรับทางลัด"); kept on the account (PUT /api/me/shortcuts,
// which pages exist and who may have them: server/auth.mjs SHORTCUTS). Needs auth.js (window.ME, window.api).
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    review: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
    inbox: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 15h4"/>',
    add: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
    import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    news: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
    scheduled: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    collections: '<path d="M4 6h16M4 6v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6M4 6l2-3h12l2 3"/><path d="M9 11h6M9 15h4"/>',
    report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  };
  // [label, link, tile colour] (tokens of the page)
  const SC = {
    review: ['งานรอตรวจ', 'pr.html?status=review', 'var(--red-soft)', 'var(--red)'],
    inbox: ['งานที่ส่งเข้ามาทั้งหมด', 'pr.html', 'var(--royal-soft)', 'var(--royal)'],
    add: ['เพิ่มข่าว', 'pr-import.html?mode=add', 'var(--purple-soft)', 'var(--purple)'],
    import: ['นำเข้าข่าวย้อนหลัง', 'pr-import.html', 'var(--sky-soft)', 'var(--sky)'],
    news: ['จัดการข่าว', 'pr-news.html', 'var(--royal-soft)', 'var(--royal)'],
    scheduled: ['ข่าวที่ตั้งเวลาไว้', 'pr-news.html?show=scheduled', 'var(--gold-soft)', 'var(--gold)'],
    collections: ['อัลบั้มข่าว', 'pr-collections.html', 'var(--purple-soft)', 'var(--purple)'],
    report: ['รายงาน', 'report.html', 'var(--sky-soft)', 'var(--sky)'],
    admin: ['ตั้งค่าระบบ', 'admin.html', 'var(--surface-2)', 'var(--ink)'],
  };
  const icon = (k, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  const tile = (id, size = 36) => `<span class="scx-ic" style="width:${size}px;height:${size}px;background:rgb(${SC[id][2]});color:rgb(${SC[id][3]})">${icon(id, size > 32 ? 18 : 16)}</span>`;

  const CSS = `
    .scx-trigger[aria-expanded="true"] { background: rgb(var(--purple-soft)); color: rgb(var(--purple)); }
    .scx-trigger .scx-chev { transition: transform .35s var(--spring); }
    .scx-trigger[aria-expanded="true"] .scx-chev { transform: rotate(180deg); }
    .scx-dot { min-width: 20px; border-radius: 9999px; background: rgb(var(--red)); padding: 0 6px; color: rgb(var(--shell)); font: 600 11px/20px Kanit, sans-serif; text-align: center; }
    .scx-panel { position: fixed; z-index: 70; width: 320px; max-width: calc(100vw - 24px); max-height: min(70dvh, 560px); overflow-y: auto; padding: 8px;
      border-radius: 22px; border: 1px solid rgb(var(--line)); background: rgb(var(--shell)); color: rgb(var(--ink)); box-shadow: var(--shadow-float);
      transform-origin: top; animation: scxIn .3s var(--spring); }
    @keyframes scxIn { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: none; } }
    .scx-label { padding: 8px 12px 6px; font: 600 13px Kanit, "Noto Sans Thai", sans-serif; color: rgb(var(--ink-2)); }
    .scx-item { position: relative; isolation: isolate; display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 6px 10px; border-radius: 14px;
      font: 500 15px/1.3 Kanit, "Noto Sans Thai", sans-serif; color: rgb(var(--ink)); text-align: left; width: 100%; transition: transform .35s var(--spring); }
    .scx-item:hover, .scx-item:focus-visible { background: rgb(var(--surface-2)); }
    .scx-item:active { transform: scale(.98); }
    .scx-item:focus-visible { outline: 3px solid rgb(var(--focus)); outline-offset: 1px; }
    .scx-item .scx-dot { margin-left: auto; }
    .scx-ic { display: grid; flex-shrink: 0; place-items: center; border-radius: 11px; }
    .scx-sep { height: 1px; margin: 6px 8px; background: rgb(var(--line)); }
    .scx-empty { padding: 8px 12px 10px; font-size: 14px; line-height: 1.6; color: rgb(var(--ink-2)); }
    .scx-dlg { width: min(520px, calc(100vw - 24px)); padding: 0; border: 1px solid rgb(var(--line)); border-radius: 28px; background: rgb(var(--shell)); color: rgb(var(--ink)); box-shadow: var(--shadow-float); }
    .scx-dlg::backdrop { background: rgb(10 11 32 / .45); }
    .scx-row { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 16px; }
    .scx-row:hover { background: rgb(var(--surface-2)); }
    .scx-row input { width: 20px; height: 20px; accent-color: rgb(var(--purple)); }
    .scx-move { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 9999px; color: rgb(var(--ink-2)); transition: transform .35s var(--spring); }
    .scx-move:hover { background: rgb(var(--surface-2)); color: rgb(var(--ink)); }
    .scx-move:active { transform: scale(.9); }
    .scx-move:disabled { opacity: .3; pointer-events: none; }
    .scx-move:focus-visible, .scx-btn:focus-visible { outline: 3px solid rgb(var(--focus)); outline-offset: 2px; }
    .scx-btn { display: inline-flex; height: 44px; align-items: center; border-radius: 16px; padding: 0 20px; font: 500 15px Kanit, "Noto Sans Thai", sans-serif; transition: transform .4s var(--spring); }
    .scx-btn:hover { background: rgb(var(--surface-2)); }
    .scx-btn:active { transform: scale(.96); }
    .scx-btn.go { background: var(--grad); color: #fff; font-weight: 600; box-shadow: var(--shadow-glow); }
    .scx-btn.go:hover { transform: translateY(-2px); }
    @media (prefers-reduced-motion: reduce) { .scx-panel { animation: none; } .scx-trigger .scx-chev, .scx-item, .scx-move, .scx-btn { transition: none; } }
  `;

  let me = null, mine = [], counts = {}, trigger = null, panel = null;
  const allowed = () => Object.keys(SC).filter((id) => id !== 'admin' || me.user?.role === 'admin');
  const waiting = () => Object.values(counts).reduce((a, n) => a + (n || 0), 0);

  // ---- The button at the end of the main menu ----
  function addTrigger(nav) {
    if (nav.querySelector('.scx-trigger')) return;
    trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'scx-trigger hover-fill press t-quick inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 font-display text-[15px] font-medium';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'scxPanel');
    trigger.innerHTML = `${icon('bolt')}<span>ทางลัด</span><span class="scx-dot" data-scx-total hidden></span><svg class="scx-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
    nav.appendChild(trigger);
    trigger.addEventListener('click', () => (panel ? close() : open()));
    trigger.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(true); } });
    paintTotal();
  }
  function paintTotal() {
    const dot = trigger?.querySelector('[data-scx-total]');
    if (!dot) return;
    const n = waiting();
    dot.hidden = !n;
    // Said after the word shown: ทางลัด, then how many are waiting
    dot.innerHTML = n ? `<span class="sr-only"> งานรอ </span>${n}<span class="sr-only"> รายการ</span>` : '';
  }

  // ---- The dropdown: my shortcuts, then "ปรับทางลัด" ----
  function open(focusFirst = false) {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'scxPanel';
    panel.className = 'scx-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'ทางลัดของฉัน');
    paintPanel();
    document.body.appendChild(panel);
    place();
    trigger.setAttribute('aria-expanded', 'true');
    if (focusFirst) panel.querySelector('a, button')?.focus();
    loadCounts();
  }
  function close(back = false) {
    if (!panel) return;
    panel.remove();
    panel = null;
    trigger.setAttribute('aria-expanded', 'false');
    if (back) trigger.focus();
  }
  // Under the button, kept on screen (the menu bar scrolls sideways on phones, so the list is not inside it)
  function place() {
    if (!panel) return;
    const r = trigger.getBoundingClientRect();
    const w = panel.offsetWidth;
    const left = Math.max(12, Math.min(r.right - w, innerWidth - w - 12));
    panel.style.left = `${left}px`;
    panel.style.top = `${r.bottom + 8}px`;
  }
  function paintPanel() {
    if (!panel) return;
    panel.innerHTML = `<p class="scx-label">ทางลัดของฉัน</p>
      ${mine.length ? mine.map((id) => `<a class="scx-item" href="${SC[id][1]}">${tile(id)}<span>${esc(SC[id][0])}</span>${counts[id] ? `<span class="scx-dot">${counts[id]}<span class="sr-only"> รายการ</span></span>` : ''}</a>`).join('')
        : '<p class="scx-empty">ยังไม่มีทางลัด เลือกหน้าที่ใช้บ่อยได้จาก "ปรับทางลัด"</p>'}
      <div class="scx-sep" aria-hidden="true"></div>
      <button type="button" class="scx-item" data-scx-edit><span class="scx-ic" style="width:36px;height:36px;color:rgb(var(--purple))">${icon('edit')}</span><span>ปรับทางลัด</span></button>`;
  }
  // Work waiting for someone: to review, stories set for later
  let countsAt = 0;
  async function loadCounts() {
    if (Date.now() - countsAt < 30000) return;
    countsAt = Date.now();
    const jobs = [];
    if (mine.includes('review')) jobs.push(window.api('/pr/submissions?status=review&limit=1').then((r) => { counts.review = r.counts?.review?.total || 0; }).catch(() => {}));
    if (mine.includes('scheduled')) jobs.push(window.api('/pr/news?show=scheduled&limit=1').then((r) => { counts.scheduled = r.counts?.scheduled || 0; }).catch(() => {}));
    await Promise.all(jobs);
    Object.keys(counts).forEach((k) => { if (!mine.includes(k)) delete counts[k]; });
    paintTotal();
    paintPanel();
  }
  document.addEventListener('click', (e) => {
    if (!panel) return;
    if ((/** @type {Element} */ (e.target)).closest('[data-scx-edit]')) { close(); openEditor(); return; }
    if (!panel.contains(e.target) && !trigger.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (!panel) return;
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (!panel.contains(document.activeElement) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const l = [...panel.querySelectorAll('a, button')];
    const i = l.indexOf(document.activeElement);
    l[e.key === 'Home' ? 0 : e.key === 'End' ? l.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + l.length) % l.length].focus();
  });
  document.addEventListener('focusout', (e) => { if (panel && e.relatedTarget && !panel.contains(e.relatedTarget) && e.relatedTarget !== trigger) close(); });
  addEventListener('resize', () => close());
  addEventListener('scroll', place, { passive: true });

  // ---- ปรับทางลัด: every page there may be, ticked ones first in my order; ↑ ↓ move a ticked one ----
  let dlg = null, draft = [];
  function openEditor() {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'scx-dlg';
      dlg.setAttribute('aria-labelledby', 'scxTitle');
      dlg.innerHTML = `<form method="dialog" style="display:grid;gap:16px;padding:24px">
          <div><h2 id="scxTitle" class="font-display" style="font-size:21px;font-weight:600">ปรับทางลัดของฉัน</h2>
            <p style="margin-top:4px;font-size:14px;line-height:1.6;color:rgb(var(--ink-2))">เลือกหน้าที่ใช้บ่อย แล้วเรียงลำดับด้วยลูกศร ทางลัดนี้เห็นเฉพาะคุณ และใช้ได้ทุกเครื่องที่เข้าสู่ระบบ</p></div>
          <ol data-scx-pick class="scroll-thin" style="display:grid;gap:2px;max-height:55dvh;overflow-y:auto;margin:0 -8px;padding:0 8px"></ol>
          <p data-scx-err role="alert" style="font-size:14px;font-weight:500;color:rgb(var(--red))" hidden></p>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button value="cancel" formnovalidate class="scx-btn">ยกเลิก</button>
            <button type="button" data-scx-save class="scx-btn go">บันทึกทางลัด</button>
          </div></form>`;
      document.body.appendChild(dlg);
      dlg.addEventListener('change', (e) => {
        const id = e.target.dataset.sc;
        if (!id) return;
        draft = e.target.checked ? [...draft, id] : draft.filter((x) => x !== id);
        paintPick(id, 'box');
      });
      dlg.addEventListener('click', async (e) => {
        const m = e.target.closest('[data-up], [data-down]');
        if (m) {
          const id = m.dataset.up || m.dataset.down, i = draft.indexOf(id), j = m.dataset.up ? i - 1 : i + 1;
          if (i < 0 || j < 0 || j >= draft.length) return;
          [draft[i], draft[j]] = [draft[j], draft[i]];
          paintPick(id, m.dataset.up ? 'up' : 'down');
          return;
        }
        if (e.target.closest('[data-scx-save]')) save(e.target.closest('[data-scx-save]'));
      });
      dlg.addEventListener('close', () => trigger?.focus());
    }
    draft = [...mine];
    dlg.querySelector('[data-scx-err]').hidden = true;
    paintPick();
    dlg.showModal();
  }
  function paintPick(focusId, what) {
    const rest = allowed().filter((id) => !draft.includes(id));
    dlg.querySelector('[data-scx-pick]').innerHTML = [...draft, ...rest].map((id) => {
      const on = draft.includes(id), i = draft.indexOf(id), label = SC[id][0];
      return `<li class="scx-row">
        <input type="checkbox" id="scx-${id}" data-sc="${id}" ${on ? 'checked' : ''}>
        <label for="scx-${id}" style="display:flex;min-width:0;cursor:pointer;align-items:center;gap:12px">${tile(id, 32)}<span class="font-display" style="font-size:15px;font-weight:500">${esc(label)}</span></label>
        <button type="button" class="scx-move" data-up="${id}" aria-label="เลื่อน ${esc(label)} ขึ้น" ${!on || i === 0 ? 'disabled' : ''}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button>
        <button type="button" class="scx-move" data-down="${id}" aria-label="เลื่อน ${esc(label)} ลง" ${!on || i === draft.length - 1 ? 'disabled' : ''}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      </li>`;
    }).join('');
    if (!focusId) return;
    const q = (s) => dlg.querySelector(s);
    // A moved one at the top or the bottom: its other arrow keeps the focus
    const first = what === 'box' ? q(`#scx-${focusId}`) : q(`[data-${what}="${focusId}"]`);
    const other = what === 'up' ? q(`[data-down="${focusId}"]`) : what === 'down' ? q(`[data-up="${focusId}"]`) : null;
    [first, other, q(`#scx-${focusId}`)].find((x) => x && !x.disabled)?.focus();
  }
  async function save(btn) {
    btn.disabled = true;
    try {
      const r = await window.api('/me/shortcuts', { method: 'PUT', body: { ids: draft } });
      mine = r.shortcuts;
      countsAt = 0;
      counts = {};
      dlg.close();
      loadCounts();
      const live = document.getElementById('liveMsg');
      if (live) live.textContent = 'บันทึกทางลัดแล้ว';
    } catch (err) {
      const el = dlg.querySelector('[data-scx-err]');
      el.textContent = `บันทึกไม่สำเร็จ: ${err.message}`;
      el.hidden = false;
    } finally { btn.disabled = false; }
  }

  // ---- Start: PR team and admins only; a menu drawn by the page later gets the button when it is there ----
  window.ME?.then((m) => {
    me = m;
    if (!m.shortcuts || !['pr', 'admin'].includes(m.user?.role)) return;
    mine = m.shortcuts.filter((id) => SC[id]);
    if (!document.getElementById('scxCss')) document.head.insertAdjacentHTML('beforeend', `<style id="scxCss">${CSS}</style>`);
    const nav = document.querySelector('nav[aria-label="เมนูหลัก"]');
    if (!nav) return;
    const attach = () => { if (nav.children.length && !nav.querySelector('.scx-trigger')) addTrigger(nav); };
    attach();
    new MutationObserver(attach).observe(nav, { childList: true });
    loadCounts();
  });
})();
