// Reports and dashboard (report.html). PR and admin see every unit; a coordinator sees only their own unit.
// - GET /api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD&unit=     the dashboard data
// - GET /api/reports/export.xlsx?from=&to=&unit=             the same as an Excel workbook
// Stories count by their published date (imported stories by their original date); withdrawn stories are left out.
import ExcelJS from 'exceljs';
import { Router } from 'express';
import { isCoordinator, requireReports } from './auth.mjs';
import { one, query } from './db.mjs';
import { HttpError } from './http.mjs';
import { LOCAL_DAY } from './news.mjs';
import { unitFamily } from './org.mjs';
import { CHANNELS } from './rules.mjs';
import { get } from './settings.mjs';

export const KIND_TH = { news: 'ข่าวพร้อมภาพ', video: 'วิดีโอ', banner: 'แบนเนอร์ / อินโฟกราฟิก' };
export const SOURCE_TH = { search: 'เครื่องมือค้นหา', facebook: 'Facebook', line: 'LINE', internal: 'ในเว็บคลังข่าว มรส.', direct: 'เปิดลิงก์ตรง', other: 'เว็บอื่น ๆ' };
export const DEVICE_TH = { mobile: 'มือถือ', tablet: 'แท็บเล็ต', desktop: 'คอมพิวเตอร์' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const router = Router();
router.use('/reports', requireReports);

// The range and the units the viewer may see
async function scope(req) {
  const today = (await one("select to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM-DD') d")).d;
  const from = DAY.test(req.query.from || '') ? req.query.from : `${today.slice(0, 8)}01`;
  const to = DAY.test(req.query.to || '') ? req.query.to : today;
  if (from > to) throw new HttpError(400, 'วันเริ่มต้องไม่หลังวันสิ้นสุด');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 3 * 366) throw new HttpError(400, 'เลือกช่วงได้ไม่เกิน 3 ปี');
  let unit = typeof req.query.unit === 'string' && req.query.unit.trim() ? req.query.unit.trim() : null;
  if (isCoordinator(req.user)) unit = req.user.coord_unit; // coordinators: own unit only, whatever they ask for
  return { from, to, today, unit, units: unit ? unitFamily(unit) : null };
}

export async function report(sc) {
  const { from, to, units } = sc;
  const params = [from, to, units];
  const inRange = `${LOCAL_DAY} between $1::date and $2::date and n.withdrawn_at is null and n.published_at <= now() and ($3::text[] is null or n.unit = any($3))`;
  const reads = `r.day between $1::date and $2::date and n.withdrawn_at is null and ($3::text[] is null or n.unit = any($3))`;

  const [matrix, totals, top, sources, devices, byDay, queue, flow, oldest, channels] = await Promise.all([
    query(`select n.unit, n.kind, to_char(${LOCAL_DAY}, 'YYYY-MM') as month, count(*)::int n, count(*) filter (where n.imported)::int imported
      from news n where ${inRange} group by 1, 2, 3 order by 1, 2, 3`, params),
    query(`select count(*)::int stories, count(*) filter (where n.imported)::int imported, count(distinct n.unit)::int units
      from news n where ${inRange}`, params),
    query(`select n.id, n.title, n.unit, n.published_at, n.imported, sum(r.n)::int reads
      from news_reads_daily r join news n on n.id = r.news_id where ${reads}
      group by n.id order by reads desc, n.published_at desc limit 10`, params),
    query(`select r.source key, sum(r.n)::int n from news_reads_daily r join news n on n.id = r.news_id where ${reads} group by 1`, params),
    query(`select r.device key, sum(r.n)::int n from news_reads_daily r join news n on n.id = r.news_id where ${reads} group by 1`, params),
    query(`select to_char(r.day, 'YYYY-MM-DD') as day, sum(r.n)::int n from news_reads_daily r join news n on n.id = r.news_id where ${reads} group by 1 order by 1`, params),
    // Queue now (not limited to the range): waiting for PR, PR writing, waiting for the sender's documents
    query(`select s.status, count(*)::int n from submissions s
      where s.status in ('review', 'writing', 'revise') and ($1::text[] is null or s.unit = any($1)) group by 1`, [units]),
    // Decisions within the range
    query(`select count(*) filter (where e.status = 'published')::int published, count(*) filter (where e.status = 'rejected')::int rejected,
        round(avg(extract(epoch from e.at - s.sent_at) / 3600) filter (where e.status = 'published'))::int avg_hours,
        round(percentile_cont(0.5) within group (order by extract(epoch from e.at - s.sent_at) / 3600) filter (where e.status = 'published'))::int median_hours
      from submission_events e join submissions s on s.id = e.submission_id
      where e.status in ('published', 'rejected') and (e.at at time zone 'Asia/Bangkok')::date between $1::date and $2::date
        and ($3::text[] is null or s.unit = any($3))`, params),
    // Oldest item waiting on PR, and how many are past the promised review time (working days)
    query(`select s.ref, s.title, s.unit, s.status, s.sent_at, round(extract(epoch from now() - s.sent_at) / 3600)::int age_hours,
        (select count(*)::int - 1 from generate_series(s.sent_at::date, now()::date, '1 day') d where extract(isodow from d) < 6) work_days
      from submissions s where s.status in ('review', 'writing') and ($1::text[] is null or s.unit = any($1))
      order by s.sent_at`, [units]),
    // A story counts once per channel; 'none' = nothing ticked
    query(`select c key, count(*)::int n from news n
      cross join lateral unnest(case when cardinality(n.channels) = 0 then array['none'] else n.channels end) c
      where ${inRange} group by 1`, params),
  ]);

  const count = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.n]));
  const q = Object.fromEntries(queue.rows.map((r) => [r.status, r.n]));
  const reviewDays = get('review').days;
  const readTotal = sources.rows.reduce((a, r) => a + r.n, 0);
  return {
    range: { from, to }, unit: sc.unit,
    totals: { ...totals.rows[0], reads: readTotal },
    matrix: matrix.rows,
    channels: { counts: count(channels.rows), labels: { ...CHANNELS, none: 'ยังไม่ระบุ' } },
    reads: {
      top: top.rows.map((r) => ({ id: r.id, title: r.title, unit: r.unit, publishedAt: r.published_at, imported: r.imported, reads: r.reads })),
      sources: count(sources.rows), devices: count(devices.rows), byDay: byDay.rows,
    },
    approval: {
      review: q.review || 0, writing: q.writing || 0, revise: q.revise || 0,
      published: flow.rows[0].published, rejected: flow.rows[0].rejected,
      avgHours: flow.rows[0].avg_hours, medianHours: flow.rows[0].median_hours,
      reviewDays, late: oldest.rows.filter((r) => r.work_days > reviewDays).length,
      oldest: oldest.rows[0] ? { ref: oldest.rows[0].ref, title: oldest.rows[0].title, unit: oldest.rows[0].unit, status: oldest.rows[0].status,
        sentAt: oldest.rows[0].sent_at, ageHours: oldest.rows[0].age_hours, workDays: oldest.rows[0].work_days } : null,
    },
  };
}

router.get('/reports', async (req, res) => {
  res.json(await report(await scope(req)));
});

// ---- Excel ----
const thDate = (d) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(new Date(d.length === 10 ? `${d}T12:00:00+07:00` : d));
const thMonth = (m) => new Intl.DateTimeFormat('th-TH', { month: 'short', year: '2-digit', timeZone: 'Asia/Bangkok' }).format(new Date(`${m}-15T12:00:00+07:00`));
const hours = (h) => (h == null ? '—' : h < 48 ? `${h} ชั่วโมง` : `${Math.round(h / 24)} วัน`);

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  ws.addRows(rows);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2642C8' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  ws.eachRow((row, i) => { if (i > 1) row.font = { name: 'Tahoma', size: 10 }; });
  return ws;
}

router.get('/reports/export.xlsx', async (req, res) => {
  const sc = await scope(req);
  const r = await report(sc);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'คลังข่าว มรส.';
  wb.created = new Date();
  const title = `รายงานคลังข่าว มรส. ${thDate(sc.from)} – ${thDate(sc.to)}${sc.unit ? ` · ${sc.unit}` : ' · ทุกหน่วยงาน'}`;

  const a = r.approval;
  const summary = sheet(wb, 'สรุป', [{ header: 'หัวข้อ', key: 'k', width: 36 }, { header: 'ค่า', key: 'v', width: 30 }], [
    { k: 'ช่วงเวลา', v: `${thDate(sc.from)} – ${thDate(sc.to)}` },
    { k: 'หน่วยงาน', v: sc.unit || 'ทุกหน่วยงาน' },
    { k: 'ข่าวที่เผยแพร่', v: r.totals.stories },
    { k: '  ในจำนวนนี้ นำเข้าย้อนหลัง', v: r.totals.imported },
    ...Object.entries(r.channels.labels).map(([key, label]) => ({ k: `  ช่องทางเผยแพร่: ${label}`, v: r.channels.counts[key] || 0 })),
    { k: 'ยอดอ่านรวม', v: r.totals.reads },
    { k: 'ค้างตรวจ (รอ PR ตรวจ)', v: a.review },
    { k: 'PR กำลังเขียนข่าว', v: a.writing },
    { k: 'รอเอกสาร / รอผู้ส่งแก้ไข', v: a.revise },
    { k: `เกินเวลาตรวจ ${a.reviewDays} วันทำการ`, v: a.late },
    { k: 'เผยแพร่จากงานที่ส่งในช่วงนี้', v: a.published },
    { k: 'ทีม PR ลบงาน', v: a.rejected },
    { k: 'เวลาเฉลี่ยตั้งแต่ส่งถึงเผยแพร่', v: hours(a.avgHours) },
    { k: 'มัธยฐานเวลาถึงเผยแพร่', v: hours(a.medianHours) },
    { k: 'อายุคิวสูงสุด', v: a.oldest ? `${hours(a.oldest.ageHours)} (${a.oldest.ref} ${a.oldest.title})` : 'ไม่มีงานค้าง' },
  ]);
  summary.spliceRows(1, 0, [title]);
  summary.getRow(1).font = { bold: true, size: 13 };
  summary.views = [{ state: 'frozen', ySplit: 2 }];

  // Unit × type × month
  const months = [];
  for (let d = new Date(`${sc.from.slice(0, 7)}-01T00:00:00Z`); d <= new Date(`${sc.to}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const keyed = new Map();
  for (const m of r.matrix) {
    const k = `${m.unit}|${m.kind}`;
    if (!keyed.has(k)) keyed.set(k, { unit: m.unit, kind: KIND_TH[m.kind], total: 0 });
    keyed.get(k)[m.month] = m.n;
    keyed.get(k).total += m.n;
  }
  sheet(wb, 'หน่วยงาน×ประเภท×เดือน', [
    { header: 'หน่วยงาน', key: 'unit', width: 40 }, { header: 'ประเภท', key: 'kind', width: 22 },
    ...months.map((m) => ({ header: thMonth(m), key: m, width: 10 })), { header: 'รวม', key: 'total', width: 10 },
  ], [...keyed.values()].map((row) => ({ ...Object.fromEntries(months.map((m) => [m, 0])), ...row })));

  sheet(wb, 'ยอดอ่าน 10 อันดับ', [
    { header: 'อันดับ', key: 'i', width: 8 }, { header: 'ข่าว', key: 'title', width: 60 }, { header: 'หน่วยงาน', key: 'unit', width: 34 },
    { header: 'วันที่เผยแพร่', key: 'date', width: 16 }, { header: 'ยอดอ่านในช่วงนี้', key: 'reads', width: 16 },
  ], r.reads.top.map((t, i) => ({ i: i + 1, title: t.title + (t.imported ? ' (นำเข้าย้อนหลัง)' : ''), unit: t.unit, date: thDate(t.publishedAt), reads: t.reads })));

  sheet(wb, 'แหล่งที่มาและอุปกรณ์', [{ header: 'กลุ่ม', key: 'g', width: 14 }, { header: 'รายการ', key: 'k', width: 24 }, { header: 'ยอดอ่าน', key: 'n', width: 12 }], [
    ...Object.entries(SOURCE_TH).map(([k, t]) => ({ g: 'แหล่งที่มา', k: t, n: r.reads.sources[k] || 0 })),
    ...Object.entries(DEVICE_TH).map(([k, t]) => ({ g: 'อุปกรณ์', k: t, n: r.reads.devices[k] || 0 })),
  ]);

  const name = `report-${sc.from}-${sc.to}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(`รายงานข่าว-${sc.from}-ถึง-${sc.to}.xlsx`)}`,
  });
  await wb.xlsx.write(res);
  res.end();
});
