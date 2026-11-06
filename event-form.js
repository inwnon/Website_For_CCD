// The form to create, edit and cancel a calendar event, shared by calendar.html and index.html.
// Needs auth.js (window.api). Dates need thai-date.js. The dialogs are added to the page on first use.
// EventForm.open({ event, day, showNote, notify, onSaved }): event is null for a new one; day (YYYY-MM-DD) is where a new one starts;
//   showNote offers the internal note (PR and admin); notify(text) reports success; onSaved(event) runs after saving.
//   Banners picked in the form are uploaded (and removed ones deleted) right after the event is saved.
// EventForm.cancel({ event, notify, onDone }): asks first, then cancels.
// EventForm.picker({ list, search, found, onError }): the people picker alone, for requests.html (selectors of its two <ul>s and <input>).
// Rights are the server's: this only offers what it was told to.
(function () {
  const TZ = 'Asia/Bangkok';
  const TYPES = { meeting: 'ประชุม', activity: 'กิจกรรม', media: 'ถ่ายภาพ/วิดีโอ', other: 'อื่น ๆ' };
  const ROLES = { pr: 'ทีม PR', admin: 'ผู้ดูแลระบบ' };
  const MAX_BANNERS = 2;
  const MAX_BANNER_BYTES = 10 * 1024 * 1024;
  const BANNER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const CSS = `
    .ef-dlg::backdrop { background: rgb(10 11 32 / .55); }
    .ef-field { border: 1px solid rgb(var(--line-strong)); background: rgb(var(--surface-2)); color: rgb(var(--ink)); }
    .ef-field::placeholder { color: rgb(var(--ink-2) / .8); }
    .ef-field:hover { border-color: rgb(var(--purple) / .45); }
    .ef-field:focus { border-color: rgb(var(--purple)); outline: none; }
    .ef-field:focus-visible { outline: 3px solid rgb(var(--focus) / .35); outline-offset: 0; }
    .ef-field[aria-invalid="true"] { border-color: rgb(var(--red)); }
    .ef-sel { appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='%235C6694' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 16px center; }
  `;
  const LABEL = 'font-display text-[15px] font-semibold';
  const ERROR = 'text-[14px] font-medium text-brand';
  const STAR = '<span class="text-brand">*</span>';
  const HTML = `
  <dialog id="evDlg" class="ef-dlg max-h-[calc(100dvh-24px)] w-[min(640px,calc(100vw-24px))] rounded-card border border-line bg-shell p-0 text-ink shadow-float" aria-labelledby="evTitle">
    <form id="evForm" class="grid gap-4 p-5 sm:p-6" novalidate>
      <h2 id="evTitle" class="font-display text-[21px] font-semibold">สร้างกิจกรรม</h2>
      <label class="grid gap-1.5">
        <span class="${LABEL}">ชื่อกิจกรรม ${STAR}</span>
        <input id="fTitle" maxlength="200" class="ef-field h-12 rounded-2xl px-4 text-[15px]" aria-describedby="titleErr">
        <span id="titleErr" data-err="title" class="${ERROR}" hidden></span>
      </label>
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="grid gap-1.5">
          <span class="${LABEL}">ประเภท ${STAR}</span>
          <select id="fType" class="ef-field ef-sel h-12 rounded-2xl pl-4 pr-10 text-[15px]" aria-describedby="typeErr">${Object.entries(TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <span id="typeErr" data-err="type" class="${ERROR}" hidden></span>
        </label>
        <label class="grid gap-1.5">
          <span class="${LABEL}">สถานที่</span>
          <input id="fLocation" maxlength="200" class="ef-field h-12 rounded-2xl px-4 text-[15px]">
        </label>
      </div>
      <div class="grid gap-4">
        <label class="grid min-w-0 gap-1.5">
          <span class="${LABEL}">เริ่ม ${STAR}</span>
          <input id="fStart" type="datetime-local" class="ef-field h-12 w-full rounded-2xl px-4 text-[15px]" aria-describedby="startErr">
          <span id="startErr" data-err="startAt" class="${ERROR}" hidden></span>
        </label>
        <label class="grid min-w-0 gap-1.5">
          <span class="${LABEL}">สิ้นสุด ${STAR}</span>
          <input id="fEnd" type="datetime-local" class="ef-field h-12 w-full rounded-2xl px-4 text-[15px]" aria-describedby="endErr">
          <span id="endErr" data-err="endAt" class="${ERROR}" hidden></span>
        </label>
      </div>
      <fieldset class="grid gap-1.5">
        <legend class="${LABEL}">ใครเห็นกิจกรรมนี้</legend>
        <label class="flex min-h-11 items-center gap-3 text-[15px]"><input type="radio" name="visibility" value="internal" class="h-5 w-5" checked>ภายในทีมเท่านั้น</label>
        <label class="flex min-h-11 items-center gap-3 text-[15px]"><input type="radio" name="visibility" value="public" class="h-5 w-5">สาธารณะ แสดงชื่อ เวลา สถานที่ และแบนเนอร์บนหน้าแรก</label>
        <span data-err="visibility" class="${ERROR}" hidden></span>
      </fieldset>
      <label class="grid gap-1.5">
        <span class="${LABEL}">รายละเอียด</span>
        <textarea id="fDescription" rows="3" maxlength="2000" class="ef-field rounded-2xl px-4 py-3 text-[15px] leading-[1.7]"></textarea>
      </label>
      <section aria-labelledby="bnTitle" aria-describedby="bnHint" class="grid gap-2">
        <h3 id="bnTitle" class="${LABEL}">แบนเนอร์กำหนดการ</h3>
        <p id="bnHint" class="-mt-1 text-[13px] text-ink2">ภาพ JPG, PNG หรือ WebP ไม่เกิน ${MAX_BANNERS} ภาพ ภาพละไม่เกิน 10 MB แสดงคู่กับกิจกรรมให้ทุกคนที่เห็นกิจกรรมนี้</p>
        <ul id="bnList" class="grid grid-cols-2 gap-2 empty:hidden"></ul>
        <input id="fBanner" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>
        <button id="bnPick" type="button" class="hover-fill press t-quick h-11 justify-self-start rounded-2xl border border-line-strong px-4 font-display text-[15px] font-medium hover:-translate-y-0.5 disabled:opacity-60">เลือกภาพแบนเนอร์</button>
        <span data-err="banner" class="${ERROR}" role="alert" hidden></span>
      </section>
      <label id="fNoteBox" class="grid gap-1.5">
        <span class="${LABEL}">โน้ตภายใน <span class="font-sans text-[13px] font-normal text-ink2">(เห็นเฉพาะทีม PR)</span></span>
        <textarea id="fNote" rows="2" maxlength="2000" class="ef-field rounded-2xl px-4 py-3 text-[15px] leading-[1.7]"></textarea>
      </label>
      <section aria-labelledby="whoTitle" class="grid gap-2">
        <label id="whoTitle" for="fWho" class="${LABEL}">มอบหมายคนรับผิดชอบ</label>
        <ul id="chosen" class="grid gap-2"></ul>
        <input id="fWho" type="search" autocomplete="off" placeholder="ค้นหาชื่อทีม PR หรือนักศึกษา" class="ef-field h-12 rounded-2xl px-4 text-[15px]">
        <ul id="whoList" class="grid gap-1" aria-label="คนที่มอบหมายได้"></ul>
        <span data-err="assignees" class="${ERROR}" hidden></span>
      </section>
      <p data-err="form" class="${ERROR}" role="alert" hidden></p>
      <div class="flex flex-wrap justify-end gap-2">
        <button id="evClose" type="button" class="press t-quick h-11 rounded-2xl px-5 font-display text-[15px] font-medium hover:-translate-y-0.5">ปิด</button>
        <button id="evSave" type="submit" class="bg-grad press t-spring h-11 rounded-2xl px-6 font-display text-[15px] font-semibold text-white shadow-glow hover:-translate-y-0.5 disabled:opacity-60">บันทึก</button>
      </div>
    </form>
  </dialog>
  <dialog id="offDlg" class="ef-dlg w-[min(480px,calc(100vw-24px))] rounded-card border border-line bg-shell p-0 text-ink shadow-float" aria-labelledby="offTitle">
    <div class="grid gap-4 p-6">
      <div>
        <h2 id="offTitle" class="font-display text-[21px] font-semibold">ยกเลิกกิจกรรมนี้?</h2>
        <p id="offName" class="mt-1 text-[14px] font-medium"></p>
        <p class="mt-2 text-[14px] text-ink2">คนที่ได้รับมอบหมายจะได้รับแจ้งเตือน กิจกรรมยังอยู่ในประวัติ แต่นำกลับมาใช้ไม่ได้</p>
      </div>
      <p id="offErr" class="${ERROR}" role="alert" hidden></p>
      <div class="flex justify-end gap-2">
        <button id="offClose" type="button" class="press t-quick h-11 rounded-2xl px-5 font-display text-[15px] font-medium hover:-translate-y-0.5">ไม่ยกเลิก</button>
        <button id="offGo" type="button" class="press t-spring h-11 rounded-2xl bg-brand px-5 font-display text-[15px] font-semibold text-white hover:-translate-y-0.5 disabled:opacity-60 dark:text-bg">ยกเลิกกิจกรรม</button>
      </div>
    </div>
  </dialog>`;

  const $ = (s) => document.querySelector(s);
  const FIELDS = { title: '#fTitle', type: '#fType', startAt: '#fStart', endAt: '#fEnd' };
  let ready = false, opts = {}, off = {}, who = null;
  // Banners change only when the event is saved: keep (on the server), drop (ids to delete), add ({ file, url } to upload)
  let bn = { keep: [], drop: [], add: [] };

  // People's names go in as text nodes, never as HTML
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  }
  const local = (d) => {
    const at = new Date(d);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(at);
    return `${day}T${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(at)}`;
  };
  function clearErrors() {
    document.querySelectorAll('#evForm [data-err]').forEach((x) => x.setAttribute('hidden', ''));
    document.querySelectorAll('#evForm [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
  }
  function showError(key, text) {
    const box = $(`#evForm [data-err="${key}"]`);
    box.textContent = text;
    box.hidden = false;
  }

  const addCss = () => { if (!$('#eventFormCss')) document.head.insertAdjacentHTML('beforeend', `<style id="eventFormCss">${CSS}</style>`); };

  function picker({ list, search, found, onError }) {
    let chosen = [], timer = null;
    addCss();
    function paint() {
      $(list).replaceChildren(...chosen.map((a) => {
        const name = a.name || a.email || 'ไม่ระบุชื่อ';
        return el('li', { class: 'grid gap-2 rounded-2xl bg-surface2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-center' },
          el('span', { class: 'text-[14px] font-medium' }, name),
          el('input', { maxlength: '120', value: a.duty, placeholder: 'หน้าที่ เช่น ช่างภาพ', 'aria-label': `หน้าที่ของ ${name}`, 'data-duty': a.id, class: 'ef-field h-11 min-w-0 rounded-xl px-3 text-[14px]', oninput: (e) => { a.duty = e.target.value; } }),
          el('button', { type: 'button', class: 'press t-quick h-11 rounded-xl px-3 text-[14px] font-medium text-brand', 'aria-label': `เอา ${name} ออก`, onclick: () => { chosen = chosen.filter((x) => x !== a); paint(); find(); } }, 'เอาออก'));
      }));
    }
    async function find() {
      try {
        const { items } = await window.api(`/calendar/people?q=${encodeURIComponent($(search).value.trim())}`);
        const left = items.filter((p) => !chosen.some((a) => a.id === p.id)).slice(0, 6);
        $(found).replaceChildren(...left.map((p) => el('li', {}, el('button', {
          type: 'button', class: 'hover-fill press t-quick flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-[14px]',
          onclick: () => {
            chosen.push({ id: p.id, name: p.name, email: p.email, duty: '' });
            paint();
            find();
            $(`[data-duty="${p.id}"]`)?.focus();
          },
        }, el('span', { class: 'min-w-0 truncate font-medium' }, p.name || p.email || 'ไม่ระบุชื่อ'), el('span', { class: 'shrink-0 text-[13px] text-ink2' }, ROLES[p.role] || 'นักศึกษา')))));
      } catch (err) { onError(err.message); }
    }
    $(search).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(find, 250); });
    return {
      set(people) { chosen = people.map((a) => ({ ...a })); $(search).value = ''; paint(); find(); },
      get: () => chosen.map((a) => ({ userId: a.id, duty: a.duty })),
    };
  }

  function paintBanners() {
    const tile = (src, alt, onRemove) => el('li', { class: 'grid gap-1.5 rounded-2xl bg-surface2 p-2' },
      el('img', { src, alt, class: 'aspect-[4/3] w-full rounded-xl object-contain' }),
      el('button', { type: 'button', class: 'press t-quick h-11 rounded-xl text-[14px] font-medium text-brand', 'aria-label': `เอาออก ${alt}`, onclick: onRemove }, 'เอาออก'));
    let n = 0;
    $('#bnList').replaceChildren(
      ...bn.keep.map((b) => tile(b.url, `แบนเนอร์ภาพที่ ${++n}`, () => { bn.keep = bn.keep.filter((x) => x !== b); bn.drop.push(b.id); paintBanners(); $('#bnPick').focus(); })),
      ...bn.add.map((a) => tile(a.url, `แบนเนอร์ภาพที่ ${++n}`, () => { URL.revokeObjectURL(a.url); bn.add = bn.add.filter((x) => x !== a); paintBanners(); $('#bnPick').focus(); })));
    $('#bnPick').disabled = bn.keep.length + bn.add.length >= MAX_BANNERS;
  }
  function pickBanners() {
    const input = $('#fBanner');
    const files = [...input.files];
    input.value = '';
    $('#evForm [data-err="banner"]').hidden = true;
    for (const file of files) {
      if (bn.keep.length + bn.add.length >= MAX_BANNERS) return showError('banner', `แนบแบนเนอร์ได้ไม่เกิน ${MAX_BANNERS} ภาพ`);
      if (!BANNER_TYPES.includes(file.type)) return showError('banner', 'รับเฉพาะภาพ JPG, PNG และ WebP');
      if (file.size > MAX_BANNER_BYTES) return showError('banner', `${file.name} ใหญ่เกิน 10 MB`);
      bn.add.push({ file, url: URL.createObjectURL(file) });
      paintBanners();
    }
  }
  function setBanners(list) {
    bn.add.forEach((a) => URL.revokeObjectURL(a.url));
    bn = { keep: [...list], drop: [], add: [] };
    paintBanners();
  }
  async function sendBanner(id, file) {
    const body = new FormData();
    body.append('file', file);
    let res;
    try { res = await fetch(`/api/calendar/events/${encodeURIComponent(id)}/banners`, { method: 'POST', body, credentials: 'same-origin' }); } catch (e) { throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง', { cause: e }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.details?.banner || data.error || 'แนบแบนเนอร์ไม่สำเร็จ');
    return data.event;
  }
  // After the event itself is saved; returns the event as it is now. On failure the form stays open on the saved event.
  async function saveBanners(event) {
    let now = event;
    try {
      while (bn.drop.length) {
        now = (await window.api(`/calendar/events/${encodeURIComponent(now.id)}/banners/${encodeURIComponent(bn.drop[0])}`, { method: 'DELETE' })).event;
        bn.drop.shift();
      }
      while (bn.add.length) {
        now = await sendBanner(now.id, bn.add[0].file);
        URL.revokeObjectURL(bn.add.shift().url);
      }
      return now;
    } catch (err) {
      opts.event = now;
      $('#evTitle').textContent = 'แก้ไขกิจกรรม';
      bn.keep = now.banners || [];
      paintBanners();
      showError('banner', `บันทึกกิจกรรมแล้ว แต่${err.message}`);
      await opts.onSaved?.(now);
      return null;
    }
  }

  async function save(ev) {
    ev.preventDefault();
    clearErrors();
    const when = (v) => (v ? `${v}:00+07:00` : null);
    const body = {
      title: $('#fTitle').value, type: $('#fType').value, location: $('#fLocation').value, startAt: when($('#fStart').value), endAt: when($('#fEnd').value),
      visibility: $('[name="visibility"]:checked').value, description: $('#fDescription').value, internalNote: $('#fNote').value,
      assignees: who.get(),
    };
    const btn = $('#evSave');
    btn.disabled = true;
    try {
      const was = opts.event;
      const saved = (await window.api(was ? `/calendar/events/${was.id}` : '/calendar/events', { method: was ? 'PUT' : 'POST', body })).event;
      const event = await saveBanners(saved);
      if (!event) return;
      $('#evDlg').close();
      opts.notify?.(was ? 'บันทึกการแก้ไขแล้ว' : 'สร้างกิจกรรมแล้ว');
      await opts.onSaved?.(event);
    } catch (err) {
      const d = err.details || {};
      let first = null;
      for (const [k, msg] of Object.entries(d)) {
        if ($(`#evForm [data-err="${k}"]`)) showError(k, msg);
        if (FIELDS[k]) { $(FIELDS[k]).setAttribute('aria-invalid', 'true'); first ||= $(FIELDS[k]); }
      }
      if (first) first.focus();
      if (!Object.keys(d).length) showError('form', err.message);
    } finally { btn.disabled = false; }
  }
  async function confirmCancel() {
    const btn = $('#offGo');
    btn.disabled = true;
    try {
      const { event } = await window.api(`/calendar/events/${off.event.id}/cancel`, { method: 'POST', body: {} });
      $('#offDlg').close();
      off.notify?.('ยกเลิกกิจกรรมแล้ว');
      await off.onDone?.(event);
    } catch (err) {
      $('#offErr').textContent = err.message;
      $('#offErr').hidden = false;
    } finally { btn.disabled = false; }
  }

  function prepare() {
    if (ready) return;
    ready = true;
    document.body.insertAdjacentHTML('beforeend', HTML);
    who = picker({ list: '#chosen', search: '#fWho', found: '#whoList', onError: (text) => showError('assignees', text) });
    $('#evForm').addEventListener('submit', save);
    $('#evClose').addEventListener('click', () => $('#evDlg').close());
    $('#bnPick').addEventListener('click', () => $('#fBanner').click());
    $('#fBanner').addEventListener('change', pickBanners);
    $('#offClose').addEventListener('click', () => $('#offDlg').close());
    $('#offGo').addEventListener('click', confirmCancel);
  }

  function open(o) {
    prepare();
    opts = o;
    const e = o.event;
    clearErrors();
    $('#evTitle').textContent = e ? 'แก้ไขกิจกรรม' : 'สร้างกิจกรรม';
    $('#fTitle').value = e?.title || '';
    $('#fType').value = e?.type || 'media';
    $('#fLocation').value = e?.location || '';
    $('#fStart').value = e ? local(e.startAt) : `${o.day}T09:00`;
    $('#fEnd').value = e ? local(e.endAt) : `${o.day}T10:00`;
    $(`[name="visibility"][value="${e?.visibility || 'internal'}"]`).checked = true;
    $('#fDescription').value = e?.description || '';
    $('#fNote').value = e?.internalNote || '';
    $('#fNoteBox').hidden = !o.showNote;
    who.set(e?.assignees || []);
    setBanners(e?.banners || []);
    $('#evDlg').showModal();
  }
  function cancel(o) {
    prepare();
    off = o;
    $('#offName').textContent = o.event.title;
    $('#offErr').hidden = true;
    $('#offDlg').showModal();
  }

  window.EventForm = { open, cancel, picker, TYPES };
})();
