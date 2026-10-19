// Finding stories to add (pr-news.html ข่าวที่เกี่ยวข้อง, pr-collections.html อัลบั้มข่าว): the newest first, or those whose
// title or unit has the words typed; 20 at a time with "แสดงเพิ่ม" for the next ones, so every story can be reached.
// Needs desk.js (DESK) and auth.js (api).
// StoryPick({ input, list, more, note, has(id), full(), self, onAdd(story) }) → { reset(), paint() }
//   has(id): already picked · full(): no room for more · self: the story being edited (shown, cannot be added)
(function () {
  const PAGE = 20;
  window.StoryPick = function ({ input, list, more, note, has, full = () => false, self = () => null, onAdd }) {
    const { esc, day, num } = DESK;
    const KIND = { news: 'ข่าวพร้อมภาพ', video: 'วิดีโอ', banner: 'อินโฟกราฟิก' };
    let items = [], total = 0, seq = 0, timer = null;

    function paint() {
      const q = input.value.trim();
      list.innerHTML = items.length ? items.map((r) => {
        const mine = r.id === self(), on = has(r.id), off = mine || on || full();
        const label = mine ? 'ข่าวนี้' : on ? 'เลือกแล้ว' : 'เพิ่ม';
        return `<li class="flex items-center gap-3 rounded-2xl border border-line px-3 py-2">
          <span class="min-w-0 flex-1 text-[14px]"><span class="clamp-2 font-medium">${esc(r.title)}</span>
            <span class="block text-[12px] text-ink2">${esc(r.unit)}, ${day(r.publishedAt)}, ${KIND[r.kind] || ''}</span></span>
          <button type="button" data-add="${r.id}" class="press t-quick h-9 shrink-0 rounded-full border border-line px-4 font-display text-[13px] font-medium hover:-translate-y-0.5 disabled:opacity-40" aria-label="${label}: ${esc(r.title)}"${off ? ' disabled' : ''}>${label}</button>
        </li>`;
      }).join('') : `<li class="px-1 text-[14px] text-ink2">${q ? 'ไม่พบข่าวที่ตรงกับคำค้น ลองใช้คำที่สั้นลง' : 'ยังไม่มีข่าวที่เผยแพร่'}</li>`;
      note.textContent = items.length ? `แสดง ${num(items.length)} จาก ${num(total)} ข่าว${q ? ` ที่ตรงกับ “${q}”` : ' เรียงจากใหม่ไปเก่า'}` : '';
      more.hidden = items.length >= total;
    }
    async function load(append) {
      const my = ++seq;
      const p = new URLSearchParams({ show: 'live', limit: PAGE, offset: append ? items.length : 0 });
      const q = input.value.trim();
      if (q) p.set('q', q);
      more.disabled = true;
      try {
        const r = await api('/pr/news?' + p);
        if (my !== seq) return;
        items = append ? [...items, ...r.items.filter((x) => !items.some((y) => y.id === x.id))] : r.items;
        total = r.total;
        paint();
      } catch (err) {
        if (my === seq) DESK.toast(err.message, true);
      } finally {
        if (my === seq) more.disabled = false;
      }
    }

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(false), 250); });
    // Enter in the search box searches at once (it would send the dialog's form)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); load(false); } });
    more.addEventListener('click', async () => {
      const at = items.length;
      await load(true);
      // Focus: the first of the new ones that can be added, else stay on the button (or the list when it is gone)
      (list.children[at]?.querySelector('[data-add]:not([disabled])') || (more.hidden ? input : more)).focus();
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-add]');
      if (!b || b.disabled) return;
      const r = items.find((x) => x.id === b.dataset.add);
      const next = b.closest('li').nextElementSibling?.querySelector('[data-add]');
      onAdd(r);
      paint();
      // Focus: the next story that can still be added, else the search box
      const n = next && list.querySelector(`[data-add="${next.dataset.add}"]:not([disabled])`);
      (n || input).focus();
    });

    return {
      reset() { input.value = ''; items = []; total = 0; list.innerHTML = ''; note.textContent = ''; more.hidden = true; load(false); },
      paint,
    };
  };
})();
