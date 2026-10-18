// Drag to reorder a list of pictures (pr-import.html, pr.html), the same way as the photos on submit.html:
// the mouse starts after a few pixels, touch after holding still (a swipe still scrolls), arrow keys move the focused
// picture, Home / End to the first / last place. The others slide out of the way (transform only); moves are announced.
// Sortable(list, { item: 'selector of an item (with data-id)', ids: () => current order, move(id, to), noun, first })
//   move(id, to) changes the page's own order and draws the list again; Sortable animates and keeps the focus.
//   first: what the first place is called (e.g. 'ภาพปก'), or nothing
(function () {
  let live = null;
  const say = (t) => {
    if (!live) {
      live = document.createElement('div');
      live.className = 'sr-only';
      live.setAttribute('aria-live', 'polite');
      document.body.appendChild(live);
    }
    live.textContent = '';
    setTimeout(() => { live.textContent = t; }, 30);
  };

  window.Sortable = function (list, { item, ids, move, noun = 'ภาพ', first = '' }) {
    if (getComputedStyle(list).position === 'static') list.style.position = 'relative';
    const items = () => [...list.querySelectorAll(item)];
    const told = (to) => say(`ย้าย${noun}ไปลำดับที่ ${to + 1}${to === 0 && first ? ` เป็น${first}` : ''}`);

    // Moves an item; FLIP so the others slide into their new places
    function shift(id, to) {
      const order = ids();
      const from = order.indexOf(id);
      to = Math.max(0, Math.min(order.length - 1, to));
      if (from < 0 || from === to) return false;
      const before = new Map(items().map((el) => [el.dataset.id, el.getBoundingClientRect()]));
      move(id, to);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const el of items()) {
          const was = before.get(el.dataset.id), now = el.getBoundingClientRect();
          if (!was) continue;
          el.style.transition = 'none';
          el.style.transform = `translate(${was.left - now.left}px, ${was.top - now.top}px)`;
          requestAnimationFrame(() => { el.style.transition = 'transform .4s cubic-bezier(.34, 1.56, .64, 1)'; el.style.transform = ''; });
        }
      }
      if (drag?.on) list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('is-dragging');
      return true;
    }
    // The element that had the focus is drawn again: focus the same control in the new one
    function refocus(id, sel) {
      const el = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
      (sel ? el?.querySelector(sel) : el)?.focus();
    }

    // ---- Keyboard: on the item itself, or on a checkbox in it (radios keep their own arrow keys) ----
    list.addEventListener('keydown', (e) => {
      const el = e.target.closest(item);
      if (!el || (e.target !== el && !e.target.matches('input[type=checkbox]'))) return;
      const id = el.dataset.id, i = ids().indexOf(id);
      const to = { ArrowLeft: i - 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowDown: i + 1, Home: 0, End: ids().length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault();
      const sel = e.target === el ? null : `input[type=checkbox]`;
      if (shift(id, to)) { refocus(id, sel); told(Math.max(0, Math.min(ids().length - 1, to))); }
    });

    // ---- Drag ----
    let drag = null;
    let justDragged = false;
    const end = (dropped) => {
      if (!drag) return;
      clearTimeout(drag.timer);
      const d = drag; drag = null;
      if (!d.on) return;
      d.ghost.remove();
      document.body.classList.remove('photo-dragging');
      list.querySelector(`[data-id="${CSS.escape(d.id)}"]`)?.classList.remove('is-dragging');
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 0);
      const at = ids().indexOf(d.id);
      if (dropped && at !== d.start) told(at);
    };
    const start = () => {
      const el = list.querySelector(`[data-id="${CSS.escape(drag.id)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const ghost = el.cloneNode(true);
      ghost.querySelectorAll('input, [tabindex], [id]').forEach((x) => { x.removeAttribute('id'); x.removeAttribute('name'); x.tabIndex = -1; });
      ghost.removeAttribute('data-id');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.classList.add('drag-ghost');
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, transform: 'scale(1.04)', transition: 'none' });
      document.body.appendChild(ghost);
      Object.assign(drag, { on: true, ghost, dx: drag.x - r.left, dy: drag.y - r.top, start: ids().indexOf(drag.id) });
      // Held only now, when it is a drag: a press that is a click must still reach the picture (to tick or untick it)
      try { list.setPointerCapture(drag.pointer); } catch (err) {}
      el.classList.add('is-dragging');
      document.body.classList.add('photo-dragging');
      navigator.vibrate?.(10);
    };
    list.addEventListener('pointerdown', (e) => {
      // The controls on a picture (ปก, ✓) are pressed, not dragged
      if (e.button > 0 || e.target.closest('button, .pick')) return;
      const el = e.target.closest(item);
      if (!el || ids().length < 2) return;
      drag = { id: el.dataset.id, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse', on: false, pointer: e.pointerId };
      if (!drag.mouse) drag.timer = setTimeout(() => drag && start(), 260);
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.on) {
        const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
        if (drag.mouse && far > 6) start();
        else if (!drag.mouse && far > 10) end(false); // a swipe: let the page scroll
        if (!drag?.on) return;
      }
      drag.ghost.style.left = `${e.clientX - drag.dx}px`;
      drag.ghost.style.top = `${e.clientY - drag.dy}px`;
      const lr = list.getBoundingClientRect();
      // A list that scrolls (pr.html): near its edge it scrolls on
      if (list.scrollHeight > list.clientHeight) {
        if (e.clientY < lr.top + 28) list.scrollTop -= 10;
        else if (e.clientY > lr.bottom - 28) list.scrollTop += 10;
      }
      // The slot under the pointer, by layout position (pictures still sliding into place must not count)
      const px = e.clientX - lr.left - list.clientLeft + list.scrollLeft, py = e.clientY - lr.top - list.clientTop + list.scrollTop;
      const over = items().find((el) => px >= el.offsetLeft && px < el.offsetLeft + el.offsetWidth && py >= el.offsetTop && py < el.offsetTop + el.offsetHeight);
      if (over && over.dataset.id !== drag.id) shift(drag.id, ids().indexOf(over.dataset.id));
    });
    window.addEventListener('pointerup', () => end(true));
    window.addEventListener('pointercancel', () => end(true));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag?.on) end(true); });
    list.addEventListener('touchend', () => end(true));
    // The click that ends a drag does not tick or untick the picture
    list.addEventListener('click', (e) => { if (justDragged) { e.preventDefault(); e.stopPropagation(); } }, true);
    list.addEventListener('touchmove', (e) => { if (drag?.on) e.preventDefault(); }, { passive: false });
    list.addEventListener('contextmenu', (e) => { if (drag) e.preventDefault(); });
    list.addEventListener('dragstart', (e) => e.preventDefault());
  };
})();
