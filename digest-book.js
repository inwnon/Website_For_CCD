// Digest books: page rules, page layout, page renderers and PDF pages.
// Shared by index.html, digest.html (shelf + reader) and digest-studio.html (PR team). Needs auth.js (window.api).
// Data comes from the server (server/digests.mjs):
//   DigestBook.shelf()          → { published, waiting }               GET /api/digests
//   DigestBook.issue(id, {pr})  → { d, st, stories, pages, count, coverURL, pdf, images }   GET /api/digests/:id (or /api/pr/digests/:id)
//     images: the pages as pictures made when the issue was approved ([{ no, src, thumb, text, links }]), or null:
//     then the pages are drawn here from the stories (renderPage)
//   DigestBook.rasterize(iss, onProgress) → { files, meta }   every page as a 1240 × 1754 WebP, its text and its links
//   DigestBook.uploadPages(id, r)                              PUT /api/pr/digests/:id/pages
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
    st.groups.filter((g) => g.ids.length).forEach((g, sec) => {
      const parts = pagesOfCat(g.ids.length, d.kind);
      pages[1].toc.push({ cat: g.cat, page: pages.length + 1, end: pages.length + parts, n: g.ids.length });
      for (let p = 0; p < parts; p++) {
        const list = g.ids.slice(p * R.perPage, (p + 1) * R.perPage).map((id) => byId.get(id)).filter(Boolean).map((s, i) => ({ ...s, seq: out.length + i + 1 }));
        pages.push({ kind: 'cat', cat: g.cat, part: p + 1, parts, stories: list, sec });
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
      async webp(n, width) {
        const p = await doc.getPage(n);
        const v = p.getViewport({ scale: width / p.getViewport({ scale: 1 }).width });
        const c = document.createElement('canvas');
        c.width = Math.round(v.width); c.height = Math.round(v.height);
        await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
        return new Promise((res) => c.toBlob(res, 'image/webp', 0.9));
      },
      async text(n) { return (await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(); },
      async links(n) {
        const p = await doc.getPage(n);
        const v = p.getViewport({ scale: 1 });
        return (await p.getAnnotations()).filter((a) => a.subtype === 'Link' && /^https:\/\//.test(a.url || '')).map((a) => {
          const [x1, y1, x2, y2] = a.rect;
          return { x: x1 / v.width, y: (v.height - y2) / v.height, w: (x2 - x1) / v.width, h: (y2 - y1) / v.height, href: a.url, label: 'ลิงก์ในหน้า' };
        });
      },
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
    const out = { d, st, all: r.stories, ...build(d, st, r.stories), coverURL: d.mode === 'pdf' ? null : d.cover?.url || null, pdf: null, images: r.pages || null };
    // Pictures of the pages are there: the PDF itself is needed only to make them again
    if (st.mode === 'pdf' && st.pdf && opts.pdf !== false && !(out.images && opts.pdf !== 'always')) { try { out.pdf = await openPdf(st.pdf.url); } catch (e) {} }
    return out;
  }

  // ---- Page renderers (sizes in cqw so text scales with the page) ----
  const year = (d) => (d.range.match(/(\d{4})$/) || [])[1] || '';
  const shortRange = (d) => d.range.replace(/\s*\d{4}$/, '');
  // On the cover: a day and its month on one line ("28 ก.ย. – 4 ต.ค.", never "4" and "ต.ค." apart)
  const coverRange = (d) => shortRange(d).replace(/(\d{1,2}) (?=\D)/g, '$1\u00a0');
  // A story's picture with its number in the issue (the stories are read in this order)
  const photo = (st, w, h) => `
    <div class="relative overflow-hidden rounded-[1.4cqw] bg-[#ECE7DF]" style="aspect-ratio:${w}/${h}">
      ${st.img ? `<img src="${esc(st.img)}" alt="" class="h-full w-full object-cover" loading="lazy">` : '<div class="absolute inset-0 grid place-items-center text-[2.4cqw] text-[#6E685D]">ภาพข่าว</div>'}
      ${st.img ? '<div class="absolute inset-0 bg-[rgb(58_33_143/.10)] mix-blend-multiply"></div><div class="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent opacity-40"></div>' : ''}
      ${st.seq ? `<span class="absolute left-[1.8cqw] top-[1.8cqw] rounded-full bg-[#6C3BD6] px-[1.8cqw] font-display text-[2.3cqw] font-semibold leading-[4.2cqw] text-white">${String(st.seq).padStart(2, '0')}</span>` : ''}
    </div>`;
  const issueName = (d) => `สรุปข่าว${KIND[d.kind].label} ${d.range}`;
  const runHead = (d) => `<p class="page-head"><span>คลังข่าว มรส.</span><span>${esc(issueName(d))}</span></p>`;
  const pageNo = (no, side) => `<p class="page-no ${side === 'left' ? '' : 'text-right'}">${no}</p>`;
  // Like the coloured tabs on the edge of a printed magazine: one per section, each a step lower than the one before,
  // on the outer edge, so a section is found by the edge of its pages (and in the page strip)
  const TAB_COLORS = ['#DE142A', '#2642C8', '#7A3CE2', '#0070A1', '#945E00', '#B3218F'];
  const secTab = (pg, side) => {
    const top = 14 + (pg.sec % 8) * 9; // % of the page height
    return `<span class="sec-tab" style="top:${top}%;${side === 'left' ? 'left:0;border-radius:0 1.4cqw 1.4cqw 0' : 'right:0;border-radius:1.4cqw 0 0 1.4cqw'};background:${TAB_COLORS[pg.sec % TAB_COLORS.length]}" aria-hidden="true">${pg.sec + 1}</span>`;
  };
  const readMore = (st, size = '2.6cqw') => `<a href="news.html?id=${encodeURIComponent(st.id)}" class="page-link font-display font-semibold" style="font-size:${size}">อ่านข่าวเต็ม<span class="sr-only">: ${esc(st.title)}</span></a>`;
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
    // สารบัญ: each category and its pages; in the reader a row goes to that page (data-goto)
    if (pg.kind === 'toc') return `
      <div class="page">
        <div class="flex h-full flex-col px-[7cqw] pb-[5cqw] pt-[6cqw]">
          ${runHead(d)}
          <div class="min-h-0 flex-1 overflow-hidden">
            <h3 class="mt-[5cqw] font-display text-[6.6cqw] font-bold leading-[1.2] tracking-[-0.03em]">สารบัญ</h3>
            <p class="mt-[1.6cqw] text-[2.9cqw] text-[#6B6458]">ฉบับนี้มี ${iss.pages.length} หน้า รวมปกหน้าและปกหลัง</p>
            <ol class="mt-[4cqw]">
              ${pg.toc.map((t) => `<li><button type="button" data-goto="${t.page}" class="toc-row"><span>${esc(t.cat)}</span><span class="tabular-nums">${t.end > t.page ? `${t.page}–${t.end}` : t.page}</span></button></li>`).join('')}
            </ol>
          </div>
          ${pageNo(pg.no, side)}
        </div>
      </div>`;
    if (pg.kind === 'cat') {
      const list = pg.stories;
      const label = `<p class="mt-[4cqw] font-display text-[2.9cqw] font-semibold text-[#6C3BD6]">${esc(pg.cat)}${pg.parts > 1 ? ` · ส่วน ${pg.part}/${pg.parts}` : ''}</p>`;
      const tab = secTab(pg, side);
      // One story: the whole page is that story (picture, headline, the lead, a link to read it all)
      if (list.length === 1) {
        const st = list[0];
        return `
      <div class="page">${tab}
        <div class="flex h-full flex-col px-[7cqw] pb-[5cqw] pt-[6cqw]">
          ${runHead(d)}
          ${label}
          <article class="flex min-h-0 flex-1 flex-col overflow-hidden pt-[2.6cqw]">
            ${photo(st, 1600, 1000)}
            <h4 class="mt-[3.4cqw] line-clamp-3 font-display text-[4.6cqw] font-bold leading-[1.3]">${esc(st.title)}</h4>
            ${st.lead ? `<p class="mt-[2cqw] line-clamp-5 text-[3.1cqw] leading-[1.7] text-[#3A3A52]">${esc(st.lead)}</p>` : ''}
            <p class="mt-[1.6cqw] text-[2.6cqw] text-[#6B6458]">${esc(st.unit)}</p>
            <div class="mt-auto pt-[3cqw]">${readMore(st, '3.1cqw')}</div>
          </article>
          ${pageNo(pg.no, side)}
        </div>
      </div>`;
      }
      const lead = list.length % 2 ? list[0] : null;
      const rest = lead ? list.slice(1) : list;
      return `
      <div class="page">${tab}
        <div class="flex h-full flex-col px-[6.5cqw] pb-[5cqw] pt-[6cqw]">
          ${runHead(d)}
          ${label}
          <div class="min-h-0 flex-1 overflow-hidden pt-[2.6cqw]">
            ${lead ? `
            <article class="grid grid-cols-[46%_1fr] items-start gap-[3cqw] ${rest.length ? 'mb-[3.4cqw] border-b border-dotted border-[#CFC7BA] pb-[3.4cqw]' : ''}">
              ${photo(lead, 900, 600)}
              <div class="min-w-0">
                <h4 class="line-clamp-3 font-display text-[3.7cqw] font-bold leading-[1.3]">${esc(lead.title)}</h4>
                ${lead.lead ? `<p class="mt-[1.2cqw] line-clamp-3 text-[2.5cqw] leading-[1.6] text-[#3A3A52]">${esc(lead.lead)}</p>` : ''}
                <p class="mt-[1cqw] text-[2.2cqw] text-[#6B6458]">${esc(lead.unit)}</p>
                <p class="mt-[1cqw]">${readMore(lead, '2.4cqw')}</p>
              </div>
            </article>` : ''}
            <div class="grid grid-cols-2 gap-x-[3.4cqw] gap-y-[3cqw]">
              ${rest.map((st) => `
              <article class="min-w-0">
                ${photo(st, 900, 420)}
                <h4 class="mt-[1.2cqw] line-clamp-2 font-display text-[3cqw] font-semibold leading-[1.3]">${esc(st.title)}</h4>
                <p class="mt-[0.4cqw] flex items-baseline justify-between gap-[1.5cqw] text-[2.2cqw] text-[#6B6458]"><span class="truncate">${esc(st.unit)}</span>${readMore(st, '2.2cqw')}</p>
              </article>`).join('')}
            </div>
          </div>
          ${pageNo(pg.no, side)}
        </div>
      </div>`;
    }
    return `
      <div class="page page-cover" style="background:#1B2560">
        <div class="absolute inset-0" style="background: radial-gradient(80% 60% at 0% 0%, rgb(222 20 42 / .45), transparent 65%), radial-gradient(80% 60% at 100% 100%, rgb(122 60 226 / .6), transparent 70%);"></div>
        <div class="grain-abs"></div>
        <div class="relative flex h-full flex-col items-center justify-center gap-[4cqw] p-[8cqw] text-center text-white">
          <span class="logo-crop h-[22cqw] w-[22cqw]"><img src="/assets/img/logo-192.webp" alt=""></span>
          <p class="font-display text-[6cqw] font-bold leading-[1.2]">คลังข่าว มรส.</p>
          <p class="text-[3.2cqw] leading-[1.6] text-white/80">จัดทำโดยงานประชาสัมพันธ์<br>มหาวิทยาลัยราชภัฏสุราษฎร์ธานี</p>
          <p class="mt-[4cqw] rounded-full bg-white/15 px-[5cqw] py-[1.6cqw] text-[3cqw]">อ่านข่าวฉบับเต็มบนเว็บไซต์ คลังข่าว มรส.</p>
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

  // ---- Pages as pictures (the studio, when the PR team approves an issue) ----
  // A page is drawn by the browser: its HTML inside an SVG foreignObject, with the site's CSS, the fonts and every picture
  // inlined (an SVG image may load nothing), onto a canvas, saved as WebP. The text and the links are read from the same page.
  const W = COVER_SIZE.w, H = COVER_SIZE.h;
  const PAGE_CSS = `.page{position:absolute;inset:0;overflow:hidden;container-type:inline-size;background:#FCFBF7;color:#23233A;line-height:1.6;font-family:"Noto Sans Thai",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    .font-display{font-family:Kanit,"Noto Sans Thai",sans-serif;line-height:1.3}
    .logo-crop{overflow:hidden;border-radius:9999px;background:rgb(200 160 255)}.logo-crop img{width:100%;height:100%;object-fit:cover;transform:scale(1.42) translateY(3%)}
    .grain-abs{position:absolute;inset:0;pointer-events:none;opacity:.12;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}`;
  const dataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  let cssP = null;
  function rasterCss() {
    return cssP || (cssP = (async () => {
      let css = await (await fetch('/assets/app.css', { credentials: 'same-origin' })).text();
      for (const u of [...new Set([...css.matchAll(/url\((\/assets\/fonts\/[^)]+)\)/g)].map((m) => m[1]))]) {
        css = css.split(`url(${u})`).join(`url(${await dataUrl(await (await fetch(u)).blob())})`);
      }
      return css + PAGE_CSS;
    })().catch((e) => { cssP = null; throw e; }));
  }
  // A picture at most as wide as the page, as a data: URL
  const pics = new Map();
  function inlinePic(src) {
    if (!pics.has(src)) pics.set(src, (async () => {
      const blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, W / bmp.width);
      if (scale === 1 && blob.size < 400 * 1024) { bmp.close?.(); return dataUrl(blob); }
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      return c.toDataURL('image/jpeg', 0.86);
    })());
    return pics.get(src);
  }
  async function rasterPage(iss, pg, side, css, stageEl) {
    stageEl.innerHTML = renderPage(iss, pg, side);
    const page = stageEl.firstElementChild;
    page.querySelectorAll('img').forEach((im) => { im.removeAttribute('srcset'); im.removeAttribute('sizes'); im.removeAttribute('loading'); });
    await Promise.all([...page.querySelectorAll('img')].map(async (im) => {
      try { im.src = await inlinePic(im.getAttribute('src')); } catch (e) { im.remove(); }
    }));
    await document.fonts.ready;
    // Links: where they are on the page (0–1), to be put back over the picture
    const box = page.getBoundingClientRect();
    const links = [...page.querySelectorAll('a[href], [data-goto]')].map((el) => {
      const r = el.getBoundingClientRect();
      const at = { x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height };
      const label = el.textContent.replace(/\s+/g, ' ').trim();
      return el.dataset.goto ? { ...at, goto: Number(el.dataset.goto), label: `ไปหน้า ${el.dataset.goto} ${label}` } : { ...at, href: el.getAttribute('href'), label };
    }).filter((l) => l.w > 0 && l.h > 0);
    // The page's own words (not the running head, the page number or the tab, the same on every page)
    const skip = [...page.querySelectorAll('.page-head, .page-no, .sec-tab')];
    skip.forEach((x) => { x.style.display = 'none'; });
    const body = page.innerText.replace(/\s+/g, ' ').trim();
    skip.forEach((x) => { x.style.display = ''; });
    const html = new XMLSerializer().serializeToString(page);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${W}px;height:${H}px"><style><![CDATA[${css}]]></style>${html}</div></foreignObject></svg>`;
    const im = new Image();
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await im.decode();
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#FCFBF7'; g.fillRect(0, 0, W, H);
    g.drawImage(im, 0, 0, W, H);
    const blob = await new Promise((res) => c.toBlob(res, 'image/webp', 0.9));
    if (!blob || blob.type !== 'image/webp') throw new Error('เบราว์เซอร์นี้บันทึกภาพ WebP ไม่ได้ ใช้ Chrome หรือ Edge');
    return { blob, body, links };
  }
  async function rasterize(iss, onProgress = () => {}) {
    const files = [], meta = [];
    const total = iss.pages.length;
    if (iss.st.mode === 'pdf') {
      const pdf = iss.pdf || await openPdf(iss.st.pdf.url);
      for (let n = 1; n <= total; n++) {
        onProgress(n, total);
        files.push(await pdf.webp(n, W));
        meta.push({ body: await pdf.text(n).catch(() => ''), links: await pdf.links(n).catch(() => []) });
      }
      return { files, meta };
    }
    const css = await rasterCss();
    // Off screen at full size: the text and the link positions are measured as on paper
    const stageEl = document.createElement('div');
    stageEl.setAttribute('aria-hidden', 'true');
    stageEl.style.cssText = `position:fixed;left:-20000px;top:0;width:${W}px;height:${H}px;pointer-events:none`;
    document.body.appendChild(stageEl);
    try {
      for (const [i, pg] of iss.pages.entries()) {
        onProgress(i + 1, total);
        const r = await rasterPage(iss, pg, i % 2 ? 'left' : 'right', css, stageEl);
        files.push(r.blob);
        meta.push({ body: r.body, links: r.links });
      }
    } finally { stageEl.remove(); }
    return { files, meta };
  }
  async function uploadPages(id, r) {
    const fd = new FormData();
    r.files.forEach((b, i) => fd.append('page', b, `page-${String(i + 1).padStart(2, '0')}.webp`));
    fd.append('meta', JSON.stringify(r.meta));
    const res = await fetch(`/api/pr/digests/${encodeURIComponent(id)}/pages`, { method: 'PUT', body: fd, credentials: 'same-origin' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'อัปโหลดภาพหน้าไม่สำเร็จ');
    return j;
  }

  const thaiDate = (iso, opts = {}) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok', ...opts });

  window.DigestBook = {
    KIND, RULES, FIXED_PAGES, COVER_SIZE, MAX_COVER_MB, MAX_PDF_MB,
    esc, addBlock, pageCount, pagesOfCat, build, openPdf, hydrate, shelf, issue, fromServer, renderPage, coverMini, coverName, thaiDate, shortRange,
    rasterize, uploadPages,
  };
})();
