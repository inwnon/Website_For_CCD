// จัดรูปแบบเนื้อหา: the story text box with its toolbar (submit.html, pr.html, pr-import.html).
// The text box shows the text as it will read: bold, font size and line spacing where they were chosen.
// - ตัวหนา (B or Ctrl/⌘+B) and ขนาดตัวอักษร 16, 17 (ปกติ) or 18 px work on the selected words
//   (19 and 20 from before are read as 18).
// - ระยะบรรทัด (แคบ 1.6, ปกติ 1.75, กว้าง 2.3; the space after the paragraph goes with it) works on the paragraphs the selection (or the cursor) is in:
//   spacing belongs to whole lines, so a word's paragraph gets it.
// The text is still kept as plain text, one line per paragraph, with marks the story page turns into formatting:
//   **ข้อความ** = bold, [size=18]ข้อความ[/size] = 18 px, [lh=loose] at the start of a paragraph = its line spacing
//   (the same rules in news.html and server/pages.mjs).
// The page's own <textarea> stays the field: hidden, but its value is always the marked text, setting its value
// fills the editor, and it fires "input" as the text changes, so the page code around it works as before.
// TextTools.attach(textareas, { onChange }) → { get() → { size: null, leading: null }, set() } (settings for the whole story are gone;
// stories that still have one show it on the story page)
// TextTools.html(text) → the paragraphs as HTML (for showing a text elsewhere, e.g. the PR desk)
(function () {
  const SIZES = [16, 17, 18];
  const sizeOf = (v) => { const n = Number(v); return n >= 16 && n <= 20 ? Math.min(n, 18) : null; };
  const BASE = 17;
  const LEADINGS = [['tight', 'แคบ', 1.6], ['normal', 'ปกติ', 1.75], ['loose', 'กว้าง', 2.3]];
  const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|TR)$/;
  let seq = 0;

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // One paragraph's marks → HTML
  const inline = (line) => esc(line)
    .replace(/\[size=(1[6-9]|20)\]([\s\S]*?)\[\/size\]/g, (m, n, t) => `<span data-size="${sizeOf(n)}">${t}</span>`)
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>');
  const lines = (t) => String(t || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
  const LH = /^\[lh=(tight|normal|loose)\]\s*/;
  const para = (l) => { const m = l.match(LH); return m && m[1] !== 'normal' ? `<p data-leading="${m[1]}">${inline(l.replace(LH, ''))}</p>` : `<p>${inline(l.replace(LH, ''))}</p>`; };
  const html = (t) => lines(t).map(para).join('');

  // ---- Editor → marked text ----
  // The editor's content as runs of text with bold / size, one list per paragraph, then marked up.
  function toText(root) {
    const out = [];
    let runs = [];
    const flush = () => { out.push(runs); runs = []; };
    const walk = (node, st) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { runs.push({ t: n.nodeValue.replace(/[\u00a0\n\r\t]/g, ' '), b: st.b, s: st.s, lh: st.lh }); continue; }
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'BR') { flush(); continue; }
        const next = { ...st };
        if (n.tagName === 'P' || n.tagName === 'DIV') next.lh = n.dataset.leading || null;
        if (/^(B|STRONG)$/.test(n.tagName) || Number(n.style?.fontWeight) >= 600 || n.style?.fontWeight === 'bold') next.b = true;
        if (n.style?.fontWeight === 'normal' || n.style?.fontWeight === '400') next.b = false;
        if (n.dataset?.size && sizeOf(n.dataset.size)) next.s = sizeOf(n.dataset.size);
        const block = BLOCK.test(n.tagName);
        if (block && runs.length) flush();
        walk(n, next);
        if (block && runs.length) flush();
      }
    };
    walk(root, { b: false, s: BASE, lh: null });
    if (runs.length) flush();
    return out.map((rs) => {
      const text = mark(rs).replace(/ {2,}/g, ' ').trim();
      const lh = rs.find((r) => r.t.trim())?.lh;
      return text && lh && lh !== 'normal' ? `[lh=${lh}]${text}` : text;
    }).filter(Boolean).join('\n');
  }
  function mark(runs) {
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.b === r.b && last.s === r.s) last.t += r.t; else merged.push({ ...r });
    }
    return merged.map(({ t, b, s }) => {
      const m = t.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!m[2] || (!b && s === BASE)) return t;
      let x = b ? `**${m[2]}**` : m[2];
      if (s !== BASE) x = `[size=${s}]${x}[/size]`;
      return m[1] + x + m[3];
    }).join('');
  }

  function attach(list, opts = {}) {
    const boxes = (Array.isArray(list) ? list : [list]).filter(Boolean);
    const editors = [];

    boxes.forEach((ta) => {
      const n = ++seq;
      const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      // ---- Toolbar ----
      const bar = document.createElement('div');
      bar.className = 'tt-bar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'จัดรูปแบบเนื้อหา');
      bar.innerHTML = `
        <button type="button" class="tt-btn" data-tt="bold" aria-pressed="false" aria-label="ตัวหนา (Ctrl+B)" title="ตัวหนา: เลือกข้อความแล้วกด (Ctrl+B)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5h6.5a3.5 3.5 0 0 1 0 7H7zM7 12h7.5a3.5 3.5 0 0 1 0 7H7z"/></svg>
        </button>
        <span class="tt-sep" aria-hidden="true"></span>
        <label class="tt-group"><span class="tt-label">ขนาดตัวอักษร</span>
          <select class="tt-select" aria-label="ขนาดตัวอักษรของข้อความที่เลือก">${SIZES.map((s) => `<option value="${s}">${s} px${s === BASE ? ' (ปกติ)' : ''}</option>`).join('')}</select>
        </label>
        <span class="tt-sep" aria-hidden="true"></span>
        <span class="tt-group" role="radiogroup" aria-labelledby="tt-lh-${n}" aria-describedby="tt-lh-${n}-d"><span id="tt-lh-${n}" class="tt-label">ระยะบรรทัด</span><span id="tt-lh-${n}-d" class="sr-only">ใช้กับย่อหน้าที่เลือก</span>
          <span class="tt-seg">${LEADINGS.map(([k, label]) => `<label><input type="radio" name="tt-lh-${n}" value="${k}"><span>${label}</span></label>`).join('')}</span>
        </span>
        <span class="tt-note" aria-live="polite">เลือกข้อความแล้วกด B เลือกขนาด หรือระยะบรรทัด</span>`;

      // ---- The editor, in the textarea's place ----
      const ed = document.createElement('div');
      ed.className = `${ta.className.replace(/\bresize(-\S+)?\b/g, '')} tt-editor`;
      ed.contentEditable = 'true';
      ed.setAttribute('role', 'textbox');
      ed.setAttribute('aria-multiline', 'true');
      ed.spellcheck = true;
      ed.lang = 'th';
      ed.style.fontSize = `${BASE}px`; // as the story page reads
      ed.style.lineHeight = '1.75';
      if (!/\bmin-h-/.test(ta.className)) ed.style.minHeight = `${Math.max(Number(ta.getAttribute('rows')) || 6, 4) * 1.75 + 1.6}em`;
      if (ta.placeholder) ed.dataset.placeholder = ta.placeholder.split('\n')[0];
      const label = ta.id && document.querySelector(`label[for="${ta.id}"]`);
      if (label) {
        if (!label.id) label.id = `${ta.id}-label`;
        ed.setAttribute('aria-labelledby', label.id);
        label.addEventListener('click', (e) => { e.preventDefault(); ed.focus(); });
      }
      ['aria-describedby', 'aria-invalid'].forEach((a) => { if (ta.hasAttribute(a)) ed.setAttribute(a, ta.getAttribute(a)); });
      new MutationObserver(() => {
        ['aria-describedby', 'aria-invalid'].forEach((a) => { if (ta.hasAttribute(a)) ed.setAttribute(a, ta.getAttribute(a)); else ed.removeAttribute(a); });
      }).observe(ta, { attributes: true, attributeFilter: ['aria-describedby', 'aria-invalid'] });
      bar.setAttribute('aria-controls', ta.id ? `${ta.id}-editor` : '');
      if (ta.id) ed.id = `${ta.id}-editor`;
      ta.before(bar);
      ta.after(ed);
      ta.hidden = true;
      ta.tabIndex = -1;

      const empty = () => ed.classList.toggle('is-empty', !native.get.call(ta));
      const render = (text) => { ed.innerHTML = html(text) || '<p><br></p>'; empty(); };
      // The page sets the textarea's value: the editor shows it
      Object.defineProperty(ta, 'value', {
        configurable: true,
        get() { return native.get.call(this); },
        set(v) { native.set.call(this, v ?? ''); render(v); },
      });
      ta.focus = (o) => ed.focus(o);
      ta.scrollIntoView = (...a) => ed.scrollIntoView(...a);
      ta.form?.addEventListener('reset', () => setTimeout(() => render(native.get.call(ta)), 0));
      // The editor changes: the textarea keeps the marked text and tells the page
      const sync = () => {
        const text = toText(ed);
        if (text !== native.get.call(ta)) {
          native.set.call(ta, text);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        empty();
      };
      render(native.get.call(ta));

      // ---- Selection: kept for the toolbar (choosing a size moves the focus to the list) ----
      let saved = null;
      const within = (node) => node && ed.contains(node.nodeType === 1 ? node : node.parentNode);
      const note = bar.querySelector('.tt-note');
      const select = bar.querySelector('select');
      select.value = String(BASE);
      const boldBtn = bar.querySelector('[data-tt=bold]');
      const say = (t) => { note.textContent = t; };
      document.addEventListener('selectionchange', () => {
        const s = getSelection();
        if (!s.rangeCount || !within(s.anchorNode)) return;
        saved = s.getRangeAt(0).cloneRange();
        const el = /** @type {HTMLElement} */ (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
        select.value = String(el.closest('[data-size]') && ed.contains(el.closest('[data-size]')) ? sizeOf(/** @type {HTMLElement} */ (el.closest('[data-size]')).dataset.size) || BASE : BASE);
        boldBtn.setAttribute('aria-pressed', String(document.queryCommandState('bold')));
        const p = /** @type {HTMLElement} */ (el.closest('p, div:not(.tt-editor)'));
        const lh = (p && ed.contains(p) && p.dataset.leading) || 'normal';
        /** @type {NodeListOf<HTMLInputElement>} */ (bar.querySelectorAll('input[type=radio]')).forEach((r) => { r.checked = r.value === lh; });
      });
      const restore = () => {
        ed.focus({ preventScroll: true });
        if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved); }
        return saved && !saved.collapsed;
      };

      document.execCommand('defaultParagraphSeparator', false, 'p');
      ed.addEventListener('input', sync);
      ed.addEventListener('blur', sync);
      // Text only: what is pasted or dropped comes in as plain text (no fonts or colours from other programs)
      ed.addEventListener('paste', (e) => {
        e.preventDefault();
        document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
      });
      ed.addEventListener('drop', (e) => {
        e.preventDefault();
        const t = e.dataTransfer.getData('text/plain');
        const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
        if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        if (t) document.execCommand('insertText', false, t);
      });
      ed.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const k = e.key.toLowerCase();
          if (k === 'b') { e.preventDefault(); document.execCommand('bold'); sync(); boldBtn.setAttribute('aria-pressed', String(document.queryCommandState('bold'))); }
          if (k === 'i' || k === 'u') e.preventDefault(); // only bold and size reach the story page
        }
      });

      boldBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
      boldBtn.addEventListener('click', () => {
        if (!restore()) { say('เลือกข้อความที่ต้องการทำตัวหนาก่อน'); return; }
        document.execCommand('styleWithCSS', false, 'false');
        document.execCommand('bold');
        sync();
        boldBtn.setAttribute('aria-pressed', String(document.queryCommandState('bold')));
        say('เลือกข้อความแล้วกด B หรือเลือกขนาด');
      });
      select.addEventListener('change', () => {
        const size = Number(select.value);
        if (!restore()) { say('เลือกข้อความที่ต้องการเปลี่ยนขนาดก่อน'); select.value = String(BASE); return; }
        // The browser marks the selection with <font size="7">; each becomes a span with the size chosen
        document.execCommand('styleWithCSS', false, 'false');
        document.execCommand('fontSize', false, '7');
        ed.querySelectorAll('font[size="7"]').forEach((f) => {
          const sp = document.createElement('span');
          sp.dataset.size = String(size);
          while (f.firstChild) sp.appendChild(f.firstChild);
          sp.querySelectorAll('[data-size]').forEach((inner) => inner.replaceWith(...inner.childNodes));
          f.replaceWith(sp);
        });
        sync();
        say(`ขนาด ${size} px`);
      });
      bar.addEventListener('change', (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        if (target.type !== 'radio') return;
        restore();
        if (!saved) { say('วางเคอร์เซอร์หรือเลือกข้อความในย่อหน้าที่ต้องการก่อน'); return; }
        // Text typed straight into an empty box is not in a paragraph yet
        if (![...ed.children].some((p) => saved.intersectsNode(p))) { document.execCommand('formatBlock', false, 'p'); saved = getSelection().getRangeAt(0).cloneRange(); }
        const chosen = [.../** @type {HTMLCollectionOf<HTMLElement>} */ (ed.children)].filter((p) => saved.intersectsNode(p));
        chosen.forEach((p) => { if (target.value === 'normal') delete p.dataset.leading; else p.dataset.leading = target.value; });
        sync();
        say(`ระยะบรรทัด${LEADINGS.find(([k]) => k === target.value)[1]} ${chosen.length} ย่อหน้า`);
        if (opts.onChange) opts.onChange({ size: null, leading: null });
      });
      editors.push({ ed, bar });
    });
    editors.forEach(({ bar }) => { bar.querySelector('input[value=normal]').checked = true; });
    return { get: () => ({ size: null, leading: null }), set() {} };
  }

  window.TextTools = { attach, html, SIZES, LEADINGS };
})();
