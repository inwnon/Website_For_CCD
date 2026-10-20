// ลิงก์วิดีโอเพิ่มเติม (submit.html, pr-import.html): a video that comes in more than one link (episodes, other platforms).
// Up to `max` boxes after the main link, each with a bin button; "เพิ่มลิงก์วิดีโอ" adds one. The server checks the same
// (rules.mjs videoLinks): each link from one of the platforms, at most `max`.
// VideoLinks(box, { max, placeholder, onChange, label, add }) → { get(), set(links), inputs(), focus() }
//   label / add: what a box and the add button are called (ลิงก์ภาพเพิ่มเติม uses it too: "ลิงก์ภาพเพิ่มเติม", "เพิ่มลิงก์ภาพ")
//   get(): the links typed, in order, empty boxes left out
(function () {
  const BIN = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  const PLUS = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

  window.VideoLinks = function (box, { max = 5, placeholder = 'https://', onChange = () => {}, label = 'ลิงก์วิดีโอเพิ่มเติม', add: addText = 'เพิ่มลิงก์วิดีโอ' } = {}) {
    box.innerHTML = `
      <ol class="grid gap-2" data-vl-list></ol>
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" data-vl-add class="press t-spring inline-flex h-11 items-center gap-2 rounded-2xl border border-dashed border-line bg-surface px-4 font-display text-[15px] font-medium text-purple hover:-translate-y-0.5 hover:border-[rgb(var(--purple)/.5)]">${PLUS}${addText}</button>
        <span data-vl-count class="text-[13px] text-ink2"></span>
      </div>`;
    const list = box.querySelector('[data-vl-list]'), add = box.querySelector('[data-vl-add]'), count = box.querySelector('[data-vl-count]');
    const rows = () => [...list.children];
    const inputs = () => rows().map((li) => li.querySelector('input'));

    function paint() {
      rows().forEach((li, i) => {
        li.querySelector('[data-vl-no]').textContent = i + 1;
        li.querySelector('input').setAttribute('aria-label', `${label}ที่ ${i + 1}`);
        li.querySelector('[data-vl-remove]').setAttribute('aria-label', `ลบ${label}ที่ ${i + 1}`);
      });
      const n = rows().length;
      add.hidden = n >= max;
      count.textContent = n >= max ? `ครบ ${max} ลิงก์แล้ว` : `เพิ่มได้อีก ${max - n} ลิงก์`;
    }
    function addRow(value = '') {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2';
      li.innerHTML = `
        <span data-vl-no class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-purple-soft font-display text-[14px] font-semibold text-purple" aria-hidden="true"></span>
        <input type="url" inputmode="url" class="field h-12 min-w-0 flex-1 rounded-2xl px-4 text-[15px]" placeholder="${placeholder}">
        <button type="button" data-vl-remove class="press t-quick grid h-11 w-11 shrink-0 place-items-center rounded-full text-brand hover:bg-red-soft">${BIN}</button>`;
      li.querySelector('input').value = value;
      list.appendChild(li);
      return li;
    }

    add.addEventListener('click', () => {
      if (rows().length >= max) return;
      const li = addRow();
      paint();
      li.querySelector('input').focus();
      onChange();
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-vl-remove]');
      if (!b) return;
      const li = b.closest('li'), i = rows().indexOf(li);
      li.remove();
      paint();
      // Focus: the box that took its place, else the one before, else the add button
      const next = inputs()[i] || inputs()[i - 1];
      (next || add).focus();
      onChange();
    });
    list.addEventListener('input', () => onChange());
    paint();

    return {
      get: () => inputs().map((x) => x.value.trim()).filter(Boolean),
      set(links) { list.innerHTML = ''; (links || []).slice(0, max).forEach((l) => addRow(l)); paint(); },
      inputs,
      focus() { (inputs()[0] || add).focus(); },
    };
  };
})();
