// Thai date picker: every <input type="date"> (and type="datetime-local") on the page shows its date in the Buddhist era
// (17 ต.ค. 2569) and opens a Thai calendar. Browsers' own date fields show Christian-era years (17/10/2026).
// The page's own code keeps working on the original input: .value stays YYYY-MM-DD (or YYYY-MM-DDTHH:MM), min/max,
// hidden, disabled and aria-invalid still apply, and picking a date fires the usual input and change events.
// Inputs added later (e.g. rendered with innerHTML) are picked up too.
// Keyboard: Enter/Space or ↓ opens; arrows move a day/week, PageUp/PageDown a month (+Shift: a year), Home/End the week,
// Enter picks, Esc closes.
(function () {
  const MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const DAYS = [['อา', 'อาทิตย์'], ['จ', 'จันทร์'], ['อ', 'อังคาร'], ['พ', 'พุธ'], ['พฤ', 'พฤหัสบดี'], ['ศ', 'ศุกร์'], ['ส', 'เสาร์']];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const thai = (d) => `${d.getDate()} ${SHORT[d.getMonth()]} ${d.getFullYear() + 543}`;
  const longThai = (d) => `วัน${DAYS[d.getDay()][1]}ที่ ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => { const t = new Date(d.getFullYear(), d.getMonth() + n, 1); return new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate())); };
  const same = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const svg = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

  const CSS = `
    .tdp { position: relative; display: inline-flex; gap: 8px; align-items: stretch; max-width: 100%; }
    .tdp.block { display: flex; }
    .tdp[hidden] { display: none; }
    .tdp-btn { display: inline-flex; align-items: center; justify-content: space-between; gap: 10px; text-align: left; cursor: pointer; min-width: 0; }
    .tdp-btn .tdp-ph { color: rgb(var(--ink-2)); }
    .tdp-btn svg { flex-shrink: 0; color: rgb(var(--ink-2)); }
    .tdp-btn:focus-visible, .tdp-pop button:focus-visible, .tdp-pop select:focus-visible { outline: 3px solid rgb(var(--focus)); outline-offset: 2px; }
    .tdp-btn[aria-expanded="true"] { border-color: rgb(var(--purple) / .55); }
    .tdp-btn[aria-invalid="true"] { border-color: rgb(var(--red)); }
    .tdp-btn:disabled { opacity: .55; cursor: not-allowed; }
    .tdp-time { min-width: 0; }
    .tdp-pop { position: absolute; z-index: 80; top: calc(100% + 8px); left: 0; width: 304px; max-width: calc(100vw - 24px); padding: 12px;
      border: 1px solid rgb(var(--line)); border-radius: 18px; background: rgb(var(--shell)); color: rgb(var(--ink)); box-shadow: var(--shadow-float);
      transform-origin: 24px -6px; animation: tdpIn .35s var(--spring, cubic-bezier(.34,1.56,.64,1)); font-family: "Noto Sans Thai", system-ui, sans-serif; line-height: 1.5; }
    .tdp-pop.up { top: auto; bottom: calc(100% + 8px); transform-origin: 24px calc(100% + 6px); }
    .tdp-pop.right { left: auto; right: 0; }
    @keyframes tdpIn { from { opacity: 0; transform: translateY(-4px) scale(.97); } to { opacity: 1; transform: none; } }
    .tdp-head { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
    .tdp-head select { min-width: 0; height: 36px; border-radius: 10px; border: 1px solid rgb(var(--line-strong)); background: rgb(var(--surface-2)); color: rgb(var(--ink)); padding: 0 6px; font: 600 14px Prompt, "Noto Sans Thai", sans-serif; }
    .tdp-head .tdp-m { flex: 1; }
    .tdp-nav { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 999px; color: rgb(var(--ink-2)); transition: transform .3s var(--spring, ease); }
    .tdp-nav:hover { color: rgb(var(--ink)); background: rgb(var(--surface-2)); }
    .tdp-nav:active { transform: scale(.92); }
    .tdp-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .tdp-grid th { padding: 4px 0; font-size: 12px; font-weight: 500; color: rgb(var(--ink-2)); }
    .tdp-grid td { padding: 1px; text-align: center; }
    .tdp-day { width: 100%; aspect-ratio: 1; max-height: 38px; border-radius: 999px; font-size: 14px; color: rgb(var(--ink)); transition: transform .25s var(--spring, ease); }
    .tdp-day:hover:not(:disabled) { background: rgb(var(--surface-2)); }
    .tdp-day:active:not(:disabled) { transform: scale(.9); }
    .tdp-day.out { color: rgb(var(--ink-2)); }
    .tdp-day.today { box-shadow: inset 0 0 0 1.5px rgb(var(--purple) / .6); font-weight: 600; }
    [aria-selected="true"] > .tdp-day { background: rgb(var(--purple)); color: rgb(var(--shell)); font-weight: 600; }
    .tdp-day:disabled { color: rgb(var(--ink-2) / .45); cursor: not-allowed; text-decoration: line-through; }
    .tdp-foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgb(var(--line)); }
    .tdp-foot button { height: 34px; padding: 0 12px; border-radius: 999px; font: 500 14px Prompt, "Noto Sans Thai", sans-serif; color: rgb(var(--purple)); transition: transform .3s var(--spring, ease); }
    .tdp-foot button:hover:not(:disabled) { background: rgb(var(--purple-soft)); }
    .tdp-foot button:active:not(:disabled) { transform: scale(.95); }
    .tdp-foot button:disabled { color: rgb(var(--ink-2) / .5); cursor: not-allowed; }
    @media (prefers-reduced-motion: reduce) { .tdp-pop { animation: none; } }
  `;

  let uid = 0;
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  function enhance(input) {
    if (input.dataset.tdp) return;
    const withTime = input.type === 'datetime-local';
    input.dataset.tdp = withTime ? 'datetime' : 'date';
    const id = input.id || `tdp${++uid}`;
    const labels = [...(input.labels || [])];
    const classes = input.className.replace(/(^|\s)focus:outline-none(?=\s|$)/g, ' ');
    const block = /(^|\s)w-full(\s|$)/.test(classes);

    const wrap = document.createElement('span');
    wrap.className = 'tdp' + (block ? ' block' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `${id}-tdp`;
    btn.className = `tdp-btn ${classes}`;
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    if (withTime) btn.classList.remove('w-full');
    wrap.appendChild(btn);
    let time = null;
    if (withTime) {
      time = document.createElement('input');
      time.type = 'time';
      time.className = `tdp-time ${classes}`.replace(/(^|\s)w-full(\s|$)/, ' ');
      time.setAttribute('aria-label', 'เวลา');
      wrap.appendChild(time);
    }
    input.before(wrap);
    wrap.appendChild(input);
    // The original stays in the form with its value; the button is what people see and use
    input.type = 'hidden';
    // Labels and descriptions point at the button now
    for (const l of labels) if (l.htmlFor === input.id) l.htmlFor = btn.id;
    // Read now, while the label holds only its text (later it also wraps the button and the calendar)
    const LABEL = labels.map((l) => l.textContent.trim()).join(' ') || input.getAttribute('aria-label') || 'วันที่';
    const labelText = () => LABEL;
    if (input.hasAttribute('aria-describedby')) btn.setAttribute('aria-describedby', input.getAttribute('aria-describedby'));
    // A button can't carry aria-required: a required date says so in its name instead
    const required = input.required || input.getAttribute('aria-required') === 'true';

    const datePart = () => (desc.get.call(input) || '').slice(0, 10);
    function paint() {
      const d = parse(datePart());
      btn.innerHTML = `<span class="${d ? '' : 'tdp-ph'}">${d ? thai(d) : 'เลือกวันที่'}</span>${svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>')}`;
      // (the name contains what the button shows, so voice control can say it: WCAG 2.5.3)
      btn.setAttribute('aria-label', `${labelText()}${required ? ' (จำเป็น)' : ''} ${d ? `${thai(d)} (${longThai(d)})` : 'เลือกวันที่ (ยังไม่ได้เลือก)'}`);
      if (time) time.value = (desc.get.call(input) || '').slice(11, 16);
    }
    // Page code that sets .value (or reads it) still talks to the input; the button follows
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return desc.get.call(input); },
      set(v) { desc.set.call(input, v ?? ''); paint(); },
    });
    input.focus = () => btn.focus();
    input.showPicker = () => open();
    // hidden / disabled / aria-invalid set on the input by the page apply to what is shown
    const mirror = () => {
      wrap.hidden = input.hidden;
      btn.disabled = input.disabled; if (time) time.disabled = input.disabled;
      if (input.hasAttribute('aria-invalid')) btn.setAttribute('aria-invalid', input.getAttribute('aria-invalid')); else btn.removeAttribute('aria-invalid');
    };
    new MutationObserver(mirror).observe(input, { attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-invalid'] });
    mirror();
    paint();

    function commit(dateIso) {
      let v = dateIso;
      if (withTime && dateIso) v = `${dateIso}T${time.value || '09:00'}`;
      desc.set.call(input, v);
      paint();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (time) {
      time.addEventListener('change', () => { const d = datePart(); if (d) commit(d); });
    }

    // ---- The calendar ----
    let pop = null, view = null, focusDay = null;
    const bounds = () => [parse(input.min), parse(input.max)];
    const allowed = (d) => { const [lo, hi] = bounds(); return (!lo || d >= lo) && (!hi || d <= hi); };
    function open() {
      if (pop || btn.disabled) return;
      const sel = parse(datePart());
      const [lo, hi] = bounds();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      focusDay = sel || (allowed(today) ? today : hi && today > hi ? hi : lo || today);
      pop = document.createElement('div');
      pop.className = 'tdp-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', `เลือก${labelText()}`);
      pop.innerHTML = `<div class="tdp-head">
          <button type="button" class="tdp-nav" data-step="-1" aria-label="เดือนก่อน">${svg('<path d="m15 18-6-6 6-6"/>')}</button>
          <select class="tdp-m" aria-label="เดือน">${MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('')}</select>
          <select class="tdp-y" aria-label="ปี พ.ศ."></select>
          <button type="button" class="tdp-nav" data-step="1" aria-label="เดือนถัดไป">${svg('<path d="m9 18 6-6-6-6"/>')}</button>
        </div>
        <table class="tdp-grid" role="grid"><thead><tr>${DAYS.map(([s, l]) => `<th scope="col" abbr="${l}">${s}</th>`).join('')}</tr></thead><tbody></tbody></table>
        <div class="tdp-foot"><button type="button" data-act="today">วันนี้</button>${input.required ? '' : '<button type="button" data-act="clear">ล้างวันที่</button>'}</div>`;
      wrap.appendChild(pop);
      const r = btn.getBoundingClientRect();
      if (r.left + 304 > innerWidth - 12) pop.classList.add('right');
      if (r.bottom + 380 > innerHeight && r.top > 380) pop.classList.add('up');
      // Years: from min (or 10 years back) to max (or 2 years ahead)
      const y0 = (lo || addMonths(today, -120)).getFullYear(), y1 = (hi || addMonths(today, 24)).getFullYear();
      pop.querySelector('.tdp-y').innerHTML = Array.from({ length: Math.max(1, y1 - y0 + 1) }, (_, i) => y1 - i).map((y) => `<option value="${y}">${y + 543}</option>`).join('');
      pop.querySelector('[data-act=today]').disabled = !allowed(today);
      btn.setAttribute('aria-expanded', 'true');
      draw(true);
      pop.addEventListener('keydown', onKey);
      pop.addEventListener('click', onClick);
      pop.querySelector('.tdp-m').addEventListener('change', (e) => { focusDay = addMonths(focusDay, +e.target.value - focusDay.getMonth()); draw(false); });
      pop.querySelector('.tdp-y').addEventListener('change', (e) => { focusDay = addMonths(focusDay, (+e.target.value - focusDay.getFullYear()) * 12); draw(false); });
      document.addEventListener('pointerdown', outside, true);
      wrap.addEventListener('focusout', leave);
    }
    function close(back) {
      if (!pop) return;
      document.removeEventListener('pointerdown', outside, true);
      wrap.removeEventListener('focusout', leave);
      // Focus moves to the button before the calendar goes: removing the focused day first would drop focus to
      // <body> for a moment, which panels that close when focus leaves them (search filters) take as leaving
      if (back || pop.contains(document.activeElement)) btn.focus();
      pop.remove(); pop = null;
      btn.setAttribute('aria-expanded', 'false');
    }
    const outside = (e) => { if (!wrap.contains(e.target)) close(false); };
    const leave = (e) => { if (e.relatedTarget && !wrap.contains(e.relatedTarget)) close(false); };
    function draw(focusGrid) {
      const sel = parse(datePart());
      const today = new Date(); today.setHours(0, 0, 0, 0);
      view = new Date(focusDay.getFullYear(), focusDay.getMonth(), 1);
      pop.querySelector('.tdp-m').value = view.getMonth();
      const ys = pop.querySelector('.tdp-y');
      if (![...ys.options].some((o) => +o.value === view.getFullYear())) ys.insertAdjacentHTML('beforeend', `<option value="${view.getFullYear()}">${view.getFullYear() + 543}</option>`);
      ys.value = view.getFullYear();
      const start = addDays(view, -view.getDay());
      let rows = '';
      for (let w = 0; w < 6; w++) {
        rows += '<tr>';
        for (let i = 0; i < 7; i++) {
          const d = addDays(start, w * 7 + i);
          const cls = ['tdp-day', d.getMonth() !== view.getMonth() ? 'out' : '', same(d, today) ? 'today' : ''].join(' ');
          rows += `<td role="gridcell" aria-selected="${!!same(d, sel)}"><button type="button" class="${cls}" data-d="${iso(d)}" tabindex="${same(d, focusDay) ? 0 : -1}"
            aria-label="${longThai(d)}${same(d, today) ? ' (วันนี้)' : ''}"${allowed(d) ? '' : ' disabled'}>${d.getDate()}</button></td>`;
        }
        rows += '</tr>';
      }
      pop.querySelector('tbody').innerHTML = rows;
      if (focusGrid) pop.querySelector(`[data-d="${iso(focusDay)}"]`)?.focus();
    }
    function moveTo(d) {
      focusDay = d;
      const inView = view && d.getMonth() === view.getMonth() && d.getFullYear() === view.getFullYear();
      if (inView) {
        pop.querySelectorAll('.tdp-day').forEach((b) => { b.tabIndex = b.dataset.d === iso(d) ? 0 : -1; });
        pop.querySelector(`[data-d="${iso(d)}"]`)?.focus();
      } else draw(true);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (!e.target.classList.contains('tdp-day')) return;
      const k = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (k) { e.preventDefault(); moveTo(addDays(focusDay, k)); return; }
      if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); moveTo(addMonths(focusDay, (e.key === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1))); return; }
      if (e.key === 'Home') { e.preventDefault(); moveTo(addDays(focusDay, -focusDay.getDay())); return; }
      if (e.key === 'End') { e.preventDefault(); moveTo(addDays(focusDay, 6 - focusDay.getDay())); }
    }
    function onClick(e) {
      // Clicks inside the calendar stay here: the calendar may be gone by the time a page-level "click outside closes
      // the menu" handler (search filters) sees the click, and a detached target looks like a click outside
      e.stopPropagation();
      const day = e.target.closest('.tdp-day');
      if (day && !day.disabled) { commit(day.dataset.d); close(true); return; }
      const nav = e.target.closest('.tdp-nav');
      if (nav) { focusDay = addMonths(focusDay, +nav.dataset.step); draw(false); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'today') { commit(iso(new Date())); close(true); }
      if (act === 'clear') { desc.set.call(input, ''); paint(); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); close(true); }
    }
    btn.addEventListener('click', () => (pop ? close(false) : open()));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !pop) { e.preventDefault(); open(); } });
  }

  function scan(root) {
    (root.matches?.('input[type=date], input[type=datetime-local]') ? [root] : []).concat([...(root.querySelectorAll?.('input[type=date], input[type=datetime-local]') || [])]).forEach(enhance);
  }
  function start() {
    if (!document.getElementById('tdpCss')) document.head.insertAdjacentHTML('beforeend', `<style id="tdpCss">${CSS}</style>`);
    scan(document);
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n)))).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.ThaiDate = { thai, longThai };
})();
