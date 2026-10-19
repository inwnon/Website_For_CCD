// Digest books: page rules, page layout, page renderers and PDF pages.
// Shared by index.html, digest.html (shelf + reader) and digest-studio.html (PR team). Needs auth.js (window.api).
// Data comes from the server (server/digests.mjs):
//   DigestBook.shelf()          → { published, waiting }               GET /api/digests
//   DigestBook.issue(id, {pr})  → { d, st, stories, pages, count, coverURL, pdf }   GET /api/digests/:id (or /api/pr/digests/:id)
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  // Labels; mastheads come from the settings page (server) and replace these defaults
  const KIND = window.DIGEST_KIND = {
    weekly: { label: 'รายสัปดาห์', masthead: 'PR.SRU WEEKLY' },
    monthly: { label: 'รายเดือน', masthead: 'PR.SRU MONTHLY' },
  };
  const setMastheads = (m) => { if (m) Object.keys(KIND).forEach((k) => { if (m[k]) KIND[k].masthead = m[k]; }); };

  // ---- Rules (same as server/digests.mjs) ----
  // Pages count the cover. Fixed pages: cover, contents, back cover.
  const RULES = {
    weekly: { maxPages: 12, perPage: 6, maxPagesPerCat: 2 },
    monthly: { maxPages: 48, perPage: 6, maxPagesPerCat: Infinity },
  };
  const FIXED_PAGES = 3;
  const COVER_SIZE = { w: 1240, h: 1754 }; // A4 portrait at 150 dpi
  const MAX_COVER_MB = 10, MAX_PDF_MB = 50;

  const pagesOfCat = (n, kind) => Math.ceil(n / RULES[kind].perPage);
  const pageCount = (kind, groups) => FIXED_PAGES + groups.reduce((a, g) => a + pagesOfCat(g.ids.length, kind), 0);

  // Why a story of this category can't be added right now ('' = it can)
  function addBlock(kind, groups, cat) {
    const R = RULES[kind];
    const g = groups.find((x) => x.cat === cat);
    const n = (g ? g.ids.length : 0) + 1;
    if (pagesOfCat(n, kind) > R.maxPagesPerCat) return `ประเภทนี้ครบ ${R.maxPagesPerCat} หน้าแล้ว`;
    const after = groups.map((x) => (x.cat === cat ? { ids: { length: n } } : x));
    if (!g) after.push({ ids: { length: 1 } });
    if (pageCount(kind, after) > R.maxPages) return `เล่มครบ ${R.maxPages} หน้าแล้ว`;
    return '';
  }

  // ---- Server data → what the renderers use ----
  // d: { id, kind, no, range, bg, glow, soft, published, coverURL, ... } as sent by the server
  const issueOut = (d) => ({ ...d, coverURL: d.mode === 'pdf' ? d.shelf : d.cover?.url || null });
  const stateOf = (d, groups, excluded) => ({
    mode: d.mode, groups: groups.map((g) => ({ cat: g.cat, ids: [...g.ids] })), excluded: [...(excluded || [])],
    cover: d.cover, pdf: d.pdf, status: d.status, publishedAt: d.publishedAt,
  });

  // ---- Build an issue's pages ----
  function build(d, st, stories) {
    if (st.mode === 'pdf') {
      const n = st.pdf?.pages || 0;
      const pages = Array.from({ length: n }, (_, i) => ({ kind: 'pdf', n: i + 1, no: i + 1 }));
      return { pages, stories: [], count: null };
    }
    const byId = new Map(stories.map((s) => [s.id, s]));
    const R = RULES[d.kind];
    const pages = [{ kind: 'cover' }, { kind: 'toc', toc: [] }];
    const out = [];
    st.groups.filter((g) => g.ids.length).forEach((g) => {
      const parts = pagesOfCat(g.ids.length, d.kind);
      pages[1].toc.push({ cat: g.cat, page: pages.length + 1, n: g.ids.length });
      for (let p = 0; p < parts; p++) {
        const list = g.ids.slice(p * R.perPage, (p + 1) * R.perPage).map((id) => byId.get(id)).filter(Boolean);
        pages.push({ kind: 'cat', cat: g.cat, part: p + 1, parts, stories: list });
        list.forEach((s) => out.push({ ...s, page: pages.length }));
      }
    });
    pages.push({ kind: 'back' });
    pages.forEach((pg, i) => { pg.no = i + 1; });
    return { pages, stories: out, count: out.length };
  }

  // ---- PDF (pdf.js 3.11.174, served from this site, loaded on first use) ----
  const PDFJS = '/assets/vendor/pdfjs/';
  let libP = null;
  function pdfLib() {
    return libP || (libP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
        res(window.pdfjsLib);
      };
      s.onerror = () => { libP = null; rej(new Error('pdf.js')); };
      document.head.appendChild(s);
    }));
  }
  // blob: a File / Blob, or the URL of a PDF on this site
  async function openPdf(blob) {
    const lib = await pdfLib();
    const data = typeof blob === 'string' ? await (await fetch(blob, { credentials: 'same-origin' })).arrayBuffer() : await blob.arrayBuffer();
    const doc = await lib.getDocument({ data }).promise;
    const cache = new Map();
    return {
      pages: doc.numPages,
      async size(n) { const v = (await doc.getPage(n)).getViewport({ scale: 1 }); return { w: v.width, h: v.height }; },
      url(n, width) {
        const k = `${n}:${width}`;
        if (!cache.has(k)) cache.set(k, (async () => {
          const p = await doc.getPage(n);
          const v = p.getViewport({ scale: width / p.getViewport({ scale: 1 }).width });
          const c = document.createElement('canvas');
          c.width = Math.round(v.width); c.height = Math.round(v.height);
          await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
          return c.toDataURL('image/jpeg', 0.86);
        })());
        return cache.get(k);
      },
      async blob(n, width) { return (await fetch(await this.url(n, width))).blob(); },
    };
  }
  // Fill <img data-pdf-page="n"> placeholders once their page is drawn
  function hydrate(root, pdf, width) {
    if (!pdf) return;
    root.querySelectorAll('img[data-pdf-page]').forEach((img) => {
      pdf.url(Number(img.dataset.pdfPage), width).then((src) => { img.src = src; img.closest('.page')?.classList.remove('is-loading'); }).catch(() => {});
    });
  }

  // ---- Load ----
  async function shelf() {
    const r = await window.api('/digests');
    setMastheads(r.mastheads);
    return { published: r.published.map(issueOut), waiting: r.waiting };
  }
  // One issue ready to render. pr: the studio's view (all stories of the range, what is left out)
  async function issue(id, opts = {}) {
    let r;
    try { r = await window.api(`${opts.pr ? '/pr' : ''}/digests/${encodeURIComponent(id)}`); } catch (e) { return null; }
    setMastheads(r.mastheads);
    return fromServer(r, opts);
  }
  async function fromServer(r, opts = {}) {
    const d = issueOut(r.digest);
    const st = stateOf(r.digest, r.groups, r.excluded);
    const out = { d, st, all: r.stories, ...build(d, st, r.stories), coverURL: d.mode === 'pdf' ? null : d.cover?.url || null, pdf: null };
    if (st.mode === 'pdf' && st.pdf && opts.pdf !== false) { try { out.pdf = await openPdf(st.pdf.url); } catch (e) {} }
    return out;
  }

  // ---- Page renderers (sizes in cqw so text scales with the page) ----
  const year = (d) => (d.range.match(/(\d{4})$/) || [])[1] || '';
  const shortRange = (d) => d.range.replace(/\s*\d{4}$/, '');
  // On the cover: a day and its month on one line ("28 ก.ย. – 4 ต.ค.", never "4" and "ต.ค." apart)
  const coverRange = (d) => shortRange(d).replace(/(\d{1,2}) (?=\D)/g, '$1\u00a0');
  const photo = (st, w, h) => `
    <div class="relative overflow-hidden rounded-[1.4cqw] bg-[#E8EDFF]" style="aspect-ratio:${w}/${h}">
      ${st.img ? `<img src="${esc(st.img)}" alt="" class="h-full w-full object-cover" loading="lazy">` : '<div class="absolute inset-0" style="background:radial-gradient(70% 90% at 80% 10%,rgb(122 60 226/.85),transparent 70%),radial-gradient(70% 90% at 10% 100%,rgb(222 20 42/.8),transparent 70%),#1B2560"></div>'}
      <div class="absolute inset-0 bg-[rgb(38_66_200/.12)] mix-blend-multiply"></div>
      <div class="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent opacity-50"></div>
    </div>`;
  const foot = (d, no, side) => `<p class="page-foot ${side === 'left' ? 'flex-row-reverse' : ''}"><span>${esc(KIND[d.kind].masthead)} · ${esc(d.range)}</span><span>${no}</span></p>`;
  const glow = (d) => `radial-gradient(90% 60% at 100% 0%, ${d.glow}, transparent 65%), radial-gradient(80% 50% at 0% 100%, rgb(122 60 226 / .55), transparent 70%)`;

  function renderPage(iss, pg, side) {
    if (!pg) return '<div class="page page-blank" aria-hidden="true"></div>';
    const d = iss.d;
    if (pg.kind === 'pdf') return `
      <div class="page is-loading"><img data-pdf-page="${pg.n}" alt="หน้า ${pg.n}" class="absolute inset-0 h-full w-full object-contain"></div>`;
    if (pg.kind === 'cover' && iss.coverURL) return `
      <div class="page page-cover"><img src="${esc(iss.coverURL)}" alt="ปกเล่ม" class="absolute inset-0 h-full w-full object-cover"></div>`;
    if (pg.kind === 'cover') return `
      <div class="page page-cover" style="background:${d.bg}">
        <div class="absolute inset-0" style="background:${glow(d)}"></div>
        <div class="grain-abs"></div>
        <div class="relative flex h-full flex-col p-[7cqw] text-white">
          <p class="flex justify-between font-display text-[3cqw] font-semibold tracking-[.18em]"><span>${esc(KIND[d.kind].masthead)}</span> <span>No.${esc(d.no)}</span></p>
          <p class="mt-[8cqw] font-display text-[13cqw] font-bold leading-[1.05] tracking-[-0.03em]">${esc(coverRange(d))}</p>
          <p class="mt-[1.5cqw] font-display text-[4cqw] font-medium text-white/80">${year(d)} · ${iss.count} ข่าว</p>
          <ol class="mt-[7cqw] grid gap-[2.4cqw] border-t border-white/25 pt-[4cqw]">
            ${iss.stories.slice(0, 3).map((st) => `<li class="text-[3.4cqw] leading-[1.35]"><span class="block font-display text-[2.6cqw] font-semibold text-white/70">${esc(st.cat)}</span>${esc(st.title)}</li>`).join('')}
          </ol>
          <img src="/assets/img/hawky-960.webp" srcset="/assets/img/hawky-480.webp 480w, /assets/img/hawky-640.webp 640w, /assets/img/hawky-960.webp 960w" sizes="(min-width: 768px) 380px, (min-width: 640px) 300px, 245px" alt="" class="absolute bottom-[-2cqw] right-[-4cqw] h-auto w-[52cqw] drop-shadow-[0_2cqw_3cqw_rgb(0_0_0/.35)]">
        </div>
      </div>`;
    if (pg.kind === 'toc') return `
      <div class="page">
        <div class="flex h-full flex-col p-[7cqw]"><div class="min-h-0 flex-1 overflow-hidden">
          <p class="font-display text-[3cqw] font-semibold text-[#DE142A]">สารบัญ</p>
          <h3 class="mt-[1cqw] font-display text-[7.5cqw] font-bold leading-[1.15] tracking-[-0.03em] text-[#2642C8]">ในฉบับนี้</h3>
          <ol class="mt-[4cqw] grid gap-[2cqw]">
            ${pg.toc.map((t) => `<li class="grid grid-cols-[8cqw_1fr_auto] items-baseline gap-[2cqw] border-b border-[#1B2560]/10 pb-[2cqw]"><span class="font-display text-[4cqw] font-bold text-[#7A3CE2]">${t.page}</span><span class="font-display text-[3.4cqw] font-semibold leading-[1.35]">${esc(t.cat)}</span><span class="text-[2.6cqw] text-[#5C6694]">${t.n} ข่าว</span></li>`).join('')}
          </ol>
          </div><div class="shrink-0 pt-[3cqw]">${foot(d, pg.no, side)}</div>
        </div>
      </div>`;
    if (pg.kind === 'cat') {
      const list = pg.stories;
      const lead = list.length % 2 ? list[0] : null;
      const rest = lead ? list.slice(1) : list;
      return `
      <div class="page">
        <div class="flex h-full flex-col p-[6cqw]">
          <header class="flex items-baseline justify-between gap-[2cqw] border-b-[0.5cqw] border-[#DE142A] pb-[1.6cqw]">
            <h3 class="font-display text-[5cqw] font-bold leading-[1.2] tracking-[-0.02em] text-[#1B2560]">${esc(pg.cat)}</h3>
            <span class="shrink-0 font-display text-[2.4cqw] font-medium text-[#5C6694]">${pg.parts > 1 ? `ส่วน ${pg.part}/${pg.parts}` : `${list.length} ข่าว`}</span>
          </header>
          <div class="min-h-0 flex-1 overflow-hidden pt-[3.5cqw]">
            ${lead ? `
            <article class="grid grid-cols-[46%_1fr] items-start gap-[3cqw] ${rest.length ? 'mb-[3.5cqw] border-b border-[#1B2560]/10 pb-[3.5cqw]' : ''}">
              ${photo(lead, 900, 600)}
              <div class="min-w-0">
                <h4 class="line-clamp-3 font-display text-[3.8cqw] font-bold leading-[1.3] text-[#1B2560]">${esc(lead.title)}</h4>
                ${lead.lead ? `<p class="mt-[1.2cqw] line-clamp-3 text-[2.5cqw] leading-[1.6] text-[#1B2560]/80">${esc(lead.lead)}</p>` : ''}
                <p class="mt-[1cqw] text-[2.2cqw] text-[#5C6694]">${esc(lead.unit)}</p>
              </div>
            </article>` : ''}
            <div class="grid grid-cols-2 gap-[3.5cqw]">
              ${rest.map((st) => `
              <article class="min-w-0">
                ${photo(st, 900, 400)}
                <h4 class="mt-[1.2cqw] line-clamp-2 font-display text-[3.1cqw] font-semibold leading-[1.3] text-[#1B2560]">${esc(st.title)}</h4>
                <p class="mt-[0.6cqw] truncate text-[2.2cqw] text-[#5C6694]">${esc(st.unit)}</p>
              </article>`).join('')}
            </div>
          </div>
          <div class="shrink-0 pt-[3cqw]">${foot(d, pg.no, side)}</div>
        </div>
      </div>`;
    }
    return `
      <div class="page page-cover" style="background:#1B2560">
        <div class="absolute inset-0" style="background: radial-gradient(80% 60% at 0% 0%, rgb(222 20 42 / .45), transparent 65%), radial-gradient(80% 60% at 100% 100%, rgb(122 60 226 / .6), transparent 70%);"></div>
        <div class="grain-abs"></div>
        <div class="relative flex h-full flex-col items-center justify-center gap-[4cqw] p-[8cqw] text-center text-white">
          <span class="logo-crop h-[22cqw] w-[22cqw]"><img src="/assets/img/logo-192.webp" alt=""></span>
          <p class="font-display text-[6cqw] font-bold leading-[1.2]">ข่าว มรส.</p>
          <p class="text-[3.2cqw] leading-[1.6] text-white/80">จัดทำโดยงานประชาสัมพันธ์<br>มหาวิทยาลัยราชภัฏสุราษฎร์ธานี</p>
          <p class="mt-[4cqw] rounded-full bg-white/15 px-[5cqw] py-[1.6cqw] text-[3cqw]">อ่านข่าวฉบับเต็มบนเว็บไซต์ ข่าว มรส.</p>
        </div>
      </div>`;
  }

  // Small cover for shelves: the uploaded image (or the PDF's first page) if there is one, else the generated design
  function coverMini(d) {
    if (d.coverURL) return `<span class="book-cover"><img src="${esc(d.coverURL)}" alt="" class="absolute inset-0 h-full w-full object-cover"></span>`;
    return `<span class="book-cover" style="background:${d.bg}">
      <span class="absolute inset-0" style="background:${glow(d)}"></span>
      <span class="grain-abs"></span>
      <span class="relative flex h-full flex-col p-[8cqw] text-left text-white">
        <span class="flex justify-between font-display text-[4cqw] font-semibold tracking-[.16em]"><span>${esc(KIND[d.kind].masthead)}</span> <span>No.${esc(d.no)}</span></span>
        <span class="mt-[8cqw] font-display text-[15cqw] font-bold leading-[1.05] tracking-[-0.03em]">${esc(coverRange(d))}</span>
        <span class="mt-[2cqw] font-display text-[5cqw] font-medium text-white/80">${year(d)}</span>
        <img src="/assets/img/hawky-960.webp" srcset="/assets/img/hawky-480.webp 480w, /assets/img/hawky-640.webp 640w, /assets/img/hawky-960.webp 960w" sizes="(min-width: 768px) 380px, (min-width: 640px) 300px, 245px" alt="" class="absolute bottom-[-3cqw] right-[-6cqw] h-auto w-[62cqw] drop-shadow-[0_3cqw_4cqw_rgb(0_0_0/.35)]">
      </span>
    </span>`;
  }

  // Name for a button or link around coverMini: starts with the action and contains the text printed on the cover,
  // so voice control users can say what they see (WCAG 2.5.3)
  const coverName = (d, action) => (d.coverURL ? `${action} ${d.range}` : `${action} ${KIND[d.kind].masthead} No.${d.no} ${shortRange(d)} ${year(d)}`);

  const thaiDate = (iso, opts = {}) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok', ...opts });

  window.DigestBook = {
    KIND, RULES, FIXED_PAGES, COVER_SIZE, MAX_COVER_MB, MAX_PDF_MB,
    esc, addBlock, pageCount, pagesOfCat, build, openPdf, hydrate, shelf, issue, fromServer, renderPage, coverMini, coverName, thaiDate, shortRange,
  };
})();
