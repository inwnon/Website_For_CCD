// Sample data for development — npm run db:seed   (npm run db:seed -- --remove deletes it)
// Stories (slug "seed-…", generated images), imported stories, 60 days of reads, and a few submissions in the queue
// (refs "…-S…"). Running again replaces them.
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { pool, query, registerEnumArrays } from './db.mjs';
import { abs } from './files.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('db:seed ใช้กับฐานข้อมูลพัฒนาเท่านั้น');
  process.exit(1);
}

const PUBLIC = ['public', 'student', 'staff'];
const STORIES = [
  { unit: 'สำนักงานอธิการบดี', ago: 2, hour: 10.5, title: 'มรส. ลงนามความร่วมมือทางวิชาการกับเครือข่ายโรงเรียนภาคใต้ตอนบน', en: 'SRU signs academic partnership with upper-southern school network', photos: 12, featured: true, album: 'https://www.facebook.com/media/set/?set=a.100000000000001', cats: ['ข่าวความร่วมมือ/MOU', 'ข่าวผู้บริหาร'], colors: ['#2A3B9C', '#C8A6FF'] },
  { unit: 'คณะวิทยาศาสตร์และเทคโนโลยี', ago: 3, hour: 14, title: 'นักศึกษาคว้ารางวัลชนะเลิศการประกวดนวัตกรรมระดับประเทศ', en: 'Students win first prize at national innovation contest', photos: 8, featured: true, video: 'https://www.facebook.com/watch/?v=100000000000001', cats: ['รางวัล/ความสำเร็จ', 'ข่าววิจัย/นวัตกรรม'], colors: ['#7A3CE2', '#F5F4FF'] },
  { unit: 'คณะครุศาสตร์', ago: 4, hour: 9, title: 'อบรมเชิงปฏิบัติการออกแบบการเรียนรู้สำหรับครูประจำการ', photos: 6, featured: true, album: 'https://drive.google.com/drive/folders/1SeedAlbumFolder', cats: ['ข่าวบริการวิชาการ'], colors: ['#1B2560', '#00AEEF'] },
  { unit: 'คณะมนุษยศาสตร์และสังคมศาสตร์', ago: 3, hour: 16, title: 'ร่วมสืบสานประเพณีชักพระและทอดผ้าป่า ประจำปี 2569', en: 'Keeping the Chak Phra and Pha Pa traditions alive, 2026', photos: 10, featured: true, video: 'https://www.tiktok.com/@sru/video/7400000000000000001', cats: ['ข่าวกิจกรรมเพื่อชุมชน/ท้องถิ่น'], colors: ['#DE142A', '#FFE8EC'] },
  { unit: 'สำนักวิทยบริการและเทคโนโลยีสารสนเทศ', ago: 0, hour: 8.5, title: 'เปิดพื้นที่อ่านหนังสือ 24 ชั่วโมง ช่วงสอบกลางภาค', photos: 4, cats: ['ข่าวการศึกษา'], colors: ['#2642C8', '#F5F4FF'] },
  { unit: 'คณะวิทยาการจัดการ', ago: 0, hour: 7.5, title: 'ตลาดนัดผู้ประกอบการรุ่นใหม่ นักศึกษาร่วมออกร้านกว่า 60 บูธ', en: 'Young entrepreneurs market: students run more than 60 stalls', photos: 9, cats: ['ข่าวกิจกรรมนักศึกษา'], colors: ['#DE142A', '#F5F4FF'] },
  { unit: 'กองบริหารงานบุคคล', ago: 1, hour: 11, title: 'ประกาศหลักเกณฑ์การประเมินผลการปฏิบัติงานบุคลากร รอบที่ 1/2570', photos: 1, audience: ['staff'], cats: ['ข่าวผู้บริหาร'], colors: ['#1B2560', '#C8A6FF'] },
  { unit: 'คณะพยาบาลศาสตร์', ago: 3, hour: 13, title: 'ออกหน่วยบริการตรวจสุขภาพเบื้องต้นแก่ผู้สูงอายุในชุมชน', photos: 7, cats: ['ข่าวบริการวิชาการ', 'ข่าวกิจกรรมเพื่อชุมชน/ท้องถิ่น'], colors: ['#1B2560', '#C8A6FF'] },
  { unit: 'กองพัฒนานักศึกษา', ago: 5, hour: 15, title: 'กำหนดการลงทะเบียนกิจกรรมเสริมหลักสูตร ภาคเรียนที่ 2/2569', photos: 1, audience: ['student'], cats: ['ข่าวกิจกรรมนักศึกษา'], colors: ['#B3218F', '#FFF4D0'] },
  { unit: 'คณะวิทยาศาสตร์และเทคโนโลยี', ago: 4, hour: 10, title: 'แปลงสาธิตเกษตรอัจฉริยะ เปิดให้ชุมชนเข้าเรียนรู้ทุกวันเสาร์', en: 'Smart farming demo plot opens to the community every Saturday', photos: 6, video: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view', cats: ['ข่าววิศวกรสังคม'], colors: ['#0096D7', '#1B2560'] },
  { unit: 'คณะนิติศาสตร์', ago: 7, hour: 9.5, title: 'ค่ายกฎหมายสัญจร ให้ความรู้กฎหมายใกล้ตัวแก่นักเรียนมัธยม', photos: 5, cats: ['ข่าวบริการวิชาการ'], colors: ['#7A3CE2', '#FFE8EC'] },
  { unit: 'กองพัฒนานักศึกษา', ago: 10, hour: 13.5, title: 'ปฐมนิเทศนักศึกษาทุนเรียนดี ภาคเรียนที่ 2/2569', en: 'Orientation for merit scholarship students, semester 2/2026', photos: 8, cats: ['ข่าวกิจกรรมนักศึกษา'], colors: ['#2A3B9C', '#FFF4D0'] },
  { unit: 'สถาบันวิจัยและพัฒนา', ago: 14, hour: 10, title: 'เปิดรับข้อเสนอโครงการวิจัยรับใช้สังคม ประจำปีงบประมาณ 2570', en: 'Call for community research proposals, fiscal year 2027', photos: 2, cats: ['ข่าววิจัย/นวัตกรรม'], colors: ['#B3218F', '#F5F4FF'] },
  { unit: 'กองพัฒนานักศึกษา', ago: 6, hour: 9, kind: 'banner', title: 'อินโฟกราฟิก ขั้นตอนขอทุนการศึกษา ภาคเรียนที่ 2/2569', photos: 2, cats: [], colors: ['#B07000', '#FFF4D0'] },
  { unit: 'คณะวิทยาการจัดการ', ago: 15, hour: 11, imported: true, title: 'อบรมการตลาดออนไลน์ให้วิสาหกิจชุมชนตำบลขุนทะเล', photos: 5, cats: ['ข่าวบริการวิชาการ'], colors: ['#DE142A', '#FFE8EC'] },
  { unit: 'คณะครุศาสตร์', ago: 13, hour: 14, imported: true, title: 'นักศึกษาครูออกค่ายอาสาพัฒนาโรงเรียนขนาดเล็ก', photos: 6, cats: ['ข่าวกิจกรรมนักศึกษา', 'ข่าวกิจกรรมเพื่อชุมชน/ท้องถิ่น'], colors: ['#1B2560', '#00AEEF'] },
  { unit: 'สำนักศิลปะและวัฒนธรรม', ago: 12, hour: 10, imported: true, title: 'สืบสานประเพณีลากพระ ร่วมกับชุมชนรอบมหาวิทยาลัย', photos: 4, cats: ['ข่าวกิจกรรมเพื่อชุมชน/ท้องถิ่น'], colors: ['#7A3CE2', '#FFE8EC'] },
];

const body = (s) => [
  `มหาวิทยาลัยราชภัฏสุราษฎร์ธานี โดย${s.unit} จัดกิจกรรม "${s.title}" ณ มหาวิทยาลัยราชภัฏสุราษฎร์ธานี มีผู้บริหาร คณาจารย์ บุคลากร และนักศึกษาเข้าร่วมเป็นจำนวนมาก`,
  'กิจกรรมครั้งนี้มีวัตถุประสงค์เพื่อส่งเสริมการเรียนรู้และการมีส่วนร่วมของชุมชน ตลอดจนเปิดโอกาสให้ผู้เข้าร่วมได้แลกเปลี่ยนประสบการณ์ซึ่งกันและกัน และนำความรู้ที่ได้ไปต่อยอดในการทำงานและการเรียน',
  'ทั้งนี้ หน่วยงานมีแผนจัดกิจกรรมลักษณะเดียวกันอย่างต่อเนื่องตลอดปีการศึกษา ผู้ที่สนใจสามารถติดตามข่าวสารได้ทางเว็บไซต์คลังข่าว มรส. และเพจของหน่วยงาน',
].join('\n\n');
const bodyEn = (s) => [
  `Suratthani Rajabhat University, through the ${s.unit}, held this event at the university with executives, lecturers, staff and students taking part.`,
  'The event aimed to promote learning and community engagement, and gave participants the chance to share experience and carry what they learned into their work and studies.',
].join('\n\n');

// A gradient "photo" in the story's colours (no text: the server's fonts may not cover Thai)
/** @param {string} dir @param {string} name @param {string[]} colors @param {number} i */
async function photo(dir, name, [a, b], i) {
  const w = 1600, h = 1067;
  const cx = 20 + ((i * 37) % 60), cy = 25 + ((i * 53) % 50);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <radialGradient id="g" cx="${cx}%" cy="${cy}%" r="75%"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></radialGradient>
      <radialGradient id="h" cx="${100 - cx}%" cy="${100 - cy}%" r="45%"><stop offset="0" stop-color="#ffffff" stop-opacity=".35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#h)"/>
    <circle cx="${w * 0.72}" cy="${h * 0.38}" r="${150 + (i % 4) * 30}" fill="#ffffff" fill-opacity=".14"/>
    <rect x="${w * 0.12}" y="${h * 0.62}" width="${w * 0.5}" height="${h * 0.22}" rx="40" fill="#000000" fill-opacity=".12"/>
  </svg>`;
  const img = sharp(Buffer.from(svg));
  await img.clone().webp({ quality: 80 }).toFile(abs(join(dir, `${name}.webp`)));
  await img.clone().jpeg({ quality: 88 }).toFile(abs(join(dir, `${name}.full.jpg`)));
  return `${dir.replace(/^media[\\/]/, '').replaceAll('\\', '/')}/${name}.webp`;
}

async function remove() {
  await query("delete from submissions where ref like '%-S%'");
  const { rows } = await query("delete from news where slug like 'seed-%' returning id");
  await Promise.all(rows.map((r) => rm(abs(join('media', r.id)), { recursive: true, force: true })));
  return rows.length;
}

// Reads per day since each story went live: busiest on day one, then tailing off (same numbers every run)
async function seedReads(ids) {
  let r = 7;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  /** @type {[string, number][]} */
  const SOURCES = [['facebook', 0.42], ['direct', 0.2], ['search', 0.16], ['line', 0.12], ['internal', 0.07], ['other', 0.03]];
  /** @type {[string, number][]} */
  const DEVICES = [['mobile', 0.71], ['desktop', 0.24], ['tablet', 0.05]];
  const today = new Date();
  for (const { id, at, s } of ids) {
    let total = 0;
    const days = Math.min(60, Math.floor((today.getTime() - at.getTime()) / 86400000));
    for (let d = 0; d <= days; d++) {
      const base = (s.featured ? 420 : 160) * Math.exp(-d / 3.5) + 3;
      const n = Math.round(base * (0.7 + rand() * 0.6));
      if (!n) continue;
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(at.getTime() + d * 86400000));
      for (const [src, ps] of SOURCES) for (const [dev, pd] of DEVICES) {
        const k = Math.round(n * ps * pd);
        if (!k) continue;
        total += k;
        await query('insert into news_reads_daily (news_id, day, source, device, n) values ($1, $2, $3, $4, $5)', [id, day, src, dev, k]);
      }
    }
    await query('update news set views = $2 where id = $1', [id, total]);
  }
}

// A few submissions from the sample staff account: waiting, being written, waiting for documents, and published ones
async function seedQueue(ids) {
  const sender = (await query(`insert into users (email, name, role, unit, sub_unit, position, consent_at)
    values ('user@sru.ac.th', 'ผู้ใช้ตัวอย่าง', 'staff', 'สำนักงานอธิการบดี', 'กองกลาง', 'นักประชาสัมพันธ์', now())
    on conflict (email) do update set email = excluded.email returning id`)).rows[0].id;
  const hours = (h) => new Date(Date.now() - h * 3600000);
  /** @type {any[]} */
  const items = [
    { ref: 'NW-2569-S001', title: 'โครงการอบรมภาษาอังกฤษเพื่อการสื่อสารสำหรับบุคลากร', unit: 'กองการเจ้าหน้าที่', status: 'review', sent: 100 },
    { ref: 'NW-2569-S002', title: 'พิธีมอบเกียรติบัตรนักศึกษาจิตอาสา', unit: 'คณะครุศาสตร์', status: 'review', sent: 20 },
    { ref: 'NW-2569-S003', title: 'ประชุมเครือข่ายวิจัยภาคใต้ตอนบน', unit: 'สถาบันวิจัยและพัฒนา', status: 'writing', sent: 30, mode: 'pr' },
    { ref: 'VD-2569-S004', title: 'คลิปแนะนำหลักสูตรพยาบาลศาสตร์', unit: 'คณะพยาบาลศาสตร์', status: 'revise', sent: 70, type: 'video' },
  ];
  // Published ones: the first few public seed stories, sent some hours before they went live
  for (const [k, { id, at, s }] of ids.filter((x) => !x.s.imported && !x.s.audience && x.s.kind !== 'banner').slice(0, 6).entries()) {
    items.push({ ref: `NW-2569-S1${String(k).padStart(2, '0')}`, title: s.title, unit: s.unit, status: 'published', sentAt: new Date(at.getTime() - (6 + k * 7) * 3600000), at, newsId: id });
  }
  for (const it of items) {
    const sentAt = it.sentAt || hours(it.sent);
    const type = it.type || 'news';
    const sub = (await query(`insert into submissions (ref, type, status, sender_id, unit, title, lead, body, event_date, categories, content_mode,
        audience, video_mode, video_url, video_platform, news_id, sent_at, pr_unread)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id`,
      [it.ref, type, it.status, sender, it.unit, it.title, type === 'news' ? 'สรุปข่าวสั้น ๆ' : null, type === 'news' && it.mode !== 'pr' ? 'ก'.repeat(200) : null,
        sentAt.toISOString().slice(0, 10), ['ข่าวการศึกษา'], type === 'news' ? it.mode || 'own' : null, PUBLIC,
        type === 'video' ? 'link' : null, type === 'video' ? 'https://youtu.be/abcdefghijk' : null, type === 'video' ? 'youtube' : null,
        it.newsId || null, sentAt, it.status === 'review'])).rows[0].id;
    await query("insert into submission_events (submission_id, status, at) values ($1, 'sent', $2), ($1, $3, $4)",
      [sub, sentAt, it.status === 'published' ? 'review' : it.status, sentAt]);
    if (it.status === 'published') {
      await query("insert into submission_events (submission_id, status, at) values ($1, 'published', $2)", [sub, it.at]);
      await query('update news set submission_id = $2 where id = $1', [it.newsId, sub]);
    }
  }
  return items.filter((x) => x.status !== 'published').length;
}

await registerEnumArrays();
const removed = await remove();
if (process.argv.includes('--remove')) {
  console.log(`ลบข่าวตัวอย่าง ${removed} ข่าว`);
} else {
  const ids = [];
  for (const [i, s] of STORIES.entries()) {
    const id = (await query('select gen_random_uuid() id')).rows[0].id;
    const dir = join('media', id);
    await mkdir(abs(dir), { recursive: true });
    const images = [];
    for (let p = 0; p < s.photos; p++) images.push(await photo(dir, randomUUID(), s.colors, i + p));
    const at = new Date(Date.now() - s.ago * 86400000);
    at.setHours(Math.floor(s.hour), (s.hour % 1) * 60, 0, 0);
    if (at > new Date()) at.setTime(Date.now() - 10 * 60000);
    await query(
      `insert into news (id, slug, title, title_en, lead, body, body_en, unit, categories, audience, cover_path, gallery,
         video_url, credit, event_date, place, featured, views, published_at, kind, imported, source_url, album_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [id, `seed-${i + 1}`, s.title, s.en || null,
        'สรุปข่าวสั้น ๆ สำหรับหน้าแรก บอกว่าใคร ทำอะไร ที่ไหน และเกิดประโยชน์กับใคร',
        body(s), s.en ? bodyEn(s) : null, s.unit, s.cats, s.audience || PUBLIC, images[0], images.slice(1), s.video || null,
        'งานประชาสัมพันธ์ มรส.', at.toISOString().slice(0, 10), 'มหาวิทยาลัยราชภัฏสุราษฎร์ธานี', !!s.featured,
        0, at, s.kind || 'news', !!s.imported, s.imported ? `https://www.facebook.com/sru.pr/posts/seed${i + 1}` : null, s.album || null],
    );
    ids.push({ id, at, s, i });
  }
  await seedReads(ids);
  const queued = await seedQueue(ids);
  console.log(`เพิ่มข่าวตัวอย่าง ${STORIES.length} ข่าว (นำเข้าย้อนหลัง ${STORIES.filter((x) => x.imported).length}) งานในคิว ${queued} งาน${removed ? ` (แทนชุดเดิม)` : ''}`);
}
await pool.end();
