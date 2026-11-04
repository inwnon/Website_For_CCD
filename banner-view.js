// แบนเนอร์กำหนดการ of a calendar event, full size in a dialog (index.html, calendar.html). The dialog is added on first use.
// BannerView.button(event): a "ดูแบนเนอร์กำหนดการ" button for an event with banners, else null.
// BannerView.open(event): shows event.banners ([{ id, url }]); Esc or ปิด closes it and focus goes back to the button.
(function () {
  const CSS = `
    .bv-dlg::backdrop { background: rgb(10 11 32 / .7); }
    .bv-dlg { overscroll-behavior: contain; }
  `;
  const HTML = `
  <dialog id="bvDlg" class="bv-dlg max-h-[calc(100dvh-24px)] w-[min(960px,calc(100vw-24px))] rounded-card border border-line bg-shell p-0 text-ink shadow-float" aria-labelledby="bvTitle">
    <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-shell px-5 py-3">
      <h2 id="bvTitle" class="min-w-0 font-display text-[17px] font-semibold leading-[1.6]"></h2>
      <button id="bvClose" type="button" class="press t-quick h-11 shrink-0 rounded-2xl px-4 font-display text-[15px] font-medium hover:-translate-y-0.5">ปิด</button>
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
      const img = document.createElement('img');
      img.src = b.url;
      img.alt = `แบนเนอร์กำหนดการ ${event.title}${many ? ` ภาพที่ ${i + 1}` : ''}`;
      img.decoding = 'async';
      img.className = 'mx-auto block h-auto max-w-full rounded-2xl bg-surface2';
      li.append(img);
      return li;
    }));
    $('#bvDlg').showModal();
    $('#bvList').scrollTop = 0;
  }

  function button(event) {
    if (!event.banners?.length) return null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'press t-quick h-9 rounded-xl border border-line px-3 font-display text-[14px] font-medium hover:-translate-y-0.5';
    b.textContent = event.banners.length > 1 ? `ดูแบนเนอร์กำหนดการ (${event.banners.length} ภาพ)` : 'ดูแบนเนอร์กำหนดการ';
    b.addEventListener('click', () => open(event));
    return b;
  }

  window.BannerView = { open, button };
})();
