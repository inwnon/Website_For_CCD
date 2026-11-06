// แบนเนอร์กำหนดการ of a calendar event, full size in a dialog (index.html, calendar.html). The dialog is added on first use.
// BannerView.button(event): a "ดูแบนเนอร์กำหนดการ" button for an event with banners, else null.
// BannerView.open(event): shows event.banners ([{ id, url }]); Esc or ปิด closes it and focus goes back to the button.
// A tap on a picture shows it at twice the dialog width, scrollable both ways (pinch zoom on a phone cannot pan inside a modal).
(function () {
  const CSS = `
    .bv-dlg::backdrop { background: rgb(10 11 32 / .7); }
    .bv-dlg { overscroll-behavior: contain; overflow-y: auto; }
    .bv-zoom { cursor: zoom-in; }
    .bv-zoom[aria-pressed="true"] { cursor: zoom-out; }
    .bv-zoom[aria-pressed="true"] img { width: 200%; max-width: none; max-height: none; }
  `;
  const HTML = `
  <dialog id="bvDlg" class="bv-dlg max-h-[calc(100dvh-24px)] w-[min(960px,calc(100vw-24px))] rounded-card border border-line bg-shell p-0 text-ink shadow-float" aria-labelledby="bvTitle">
    <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-shell px-5 py-3">
      <h2 id="bvTitle" class="min-w-0 font-display text-[17px] font-semibold leading-[1.6]"></h2>
      <button id="bvClose" type="button" class="press t-quick h-11 shrink-0 rounded-2xl bg-brand px-5 font-display text-[15px] font-semibold text-white hover:-translate-y-0.5 dark:text-bg">ปิด</button>
    </div>
    <ul id="bvList" class="grid gap-4 p-4 sm:p-5"></ul>
  </dialog>`;
  const $ = (s) => document.querySelector(s);
  let ready = false;

  function prepare() {
    if (ready) return;
    ready = true;
    document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
    document.body.insertAdjacentHTML('beforeend', HTML);
    $('#bvClose').addEventListener('click', () => $('#bvDlg').close());
    // A click on the dimmed area around the dialog closes it too
    $('#bvDlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  }

  function open(event) {
    prepare();
    $('#bvTitle').textContent = `แบนเนอร์กำหนดการ · ${event.title}`;
    const many = event.banners.length > 1;
    $('#bvList').replaceChildren(...event.banners.map((b, i) => {
      const li = document.createElement('li');
      li.className = 'grid justify-items-center gap-2';
      const img = document.createElement('img');
      img.src = b.url;
      img.alt = `แบนเนอร์กำหนดการ ${event.title}${many ? ` ภาพที่ ${i + 1}` : ''}`;
      img.decoding = 'async';
      // The whole picture fits the screen, also on a phone turned sideways; the link below opens it full size for zooming
      img.className = 'block h-auto max-h-[calc(100dvh-140px)] w-auto max-w-full rounded-2xl bg-surface2 object-contain';
      const box = document.createElement('div');
      box.className = 'w-full overflow-x-auto overscroll-x-contain';
      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.className = 'bv-zoom press t-quick mx-auto block rounded-2xl';
      zoom.setAttribute('aria-pressed', 'false');
      zoom.setAttribute('aria-label', `ขยาย${img.alt}`);
      zoom.title = 'แตะเพื่อขยายหรือย่อภาพ';
      zoom.addEventListener('click', () => {
        const on = zoom.getAttribute('aria-pressed') !== 'true';
        zoom.setAttribute('aria-pressed', String(on));
        zoom.classList.toggle('mx-auto', !on);
        box.scrollLeft = on ? (box.scrollWidth - box.clientWidth) / 2 : 0;
      });
      zoom.append(img);
      box.append(zoom);
      const full = document.createElement('a');
      full.href = b.url;
      full.target = '_blank';
      full.rel = 'noopener';
      full.className = 'press t-quick inline-flex min-h-11 items-center rounded-xl px-3 text-[14px] font-medium text-sky underline-offset-4 hover:underline';
      full.textContent = many ? `เปิดภาพที่ ${i + 1} ขนาดเต็ม` : 'เปิดภาพขนาดเต็ม';
      li.append(box, full);
      return li;
    }));
    $('#bvDlg').showModal();
    $('#bvList').scrollTop = 0;
  }

  function button(event) {
    if (!event.banners?.length) return null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'press t-quick inline-flex h-9 items-center gap-1.5 rounded-xl border border-sky/40 bg-sky-soft px-3 font-display text-[14px] font-semibold text-sky hover:-translate-y-0.5 hover:border-sky';
    b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';
    b.append(event.banners.length > 1 ? `ดูแบนเนอร์กำหนดการ (${event.banners.length} ภาพ)` : 'ดูแบนเนอร์กำหนดการ');
    b.addEventListener('click', () => open(event));
    return b;
  }

  window.BannerView = { open, button };
})();
