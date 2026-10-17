// News digests (placeholder data) — shared by index.html, digest.html and digest-studio.html
// `news` = news published in the issue's date range; digest-book.js decides what fits in the book
// and fills in `count` (stories in the book) and `pages`.
window.DIGESTS = [
  { id: 'w-2569-10-01', kind: 'weekly', no: '01', range: '1–4 ต.ค. 2569', published: '5 ต.ค. 2569', news: 14, bg: '#1B2560', glow: 'rgb(222 20 42 / .55)', soft: 'bg-red-soft' },
  { id: 'm-2569-09', kind: 'monthly', no: '09', range: 'กันยายน 2569', published: '3 ต.ค. 2569', news: 118, bg: '#7A3CE2', glow: 'rgb(255 206 96 / .5)', soft: 'bg-purple-soft' },
  { id: 'w-2569-09-04', kind: 'weekly', no: '04', range: '22–30 ก.ย. 2569', published: '1 ต.ค. 2569', news: 27, bg: '#B3218F', glow: 'rgb(0 174 239 / .45)', soft: 'bg-purple-soft' },
  { id: 'w-2569-09-03', kind: 'weekly', no: '03', range: '15–21 ก.ย. 2569', published: '22 ก.ย. 2569', news: 33, bg: '#0A6A94', glow: 'rgb(222 20 42 / .5)', soft: 'bg-sky-soft' },
  { id: 'm-2569-08', kind: 'monthly', no: '08', range: 'สิงหาคม 2569', published: '2 ก.ย. 2569', news: 104, bg: '#DE142A', glow: 'rgb(122 60 226 / .6)', soft: 'bg-red-soft' },
  { id: 'm-2569-07', kind: 'monthly', no: '07', range: 'กรกฎาคม 2569', published: '4 ส.ค. 2569', news: 96, bg: '#1B2560', glow: 'rgb(255 206 96 / .45)', soft: 'bg-gold-soft' },
];

// Issues the system assembles on its own; none goes public until the PR team approves it.
// draftedAt: when the system builds the book (weekly: Monday 06:00, monthly: the 1st at 06:00)
window.DIGEST_DRAFTS = [
  { id: 'w-2569-10-02', kind: 'weekly', no: '02', range: '5–11 ต.ค. 2569', news: 31, draftedAt: '2026-10-12T06:00:00+07:00', bg: '#2A3B9C', glow: 'rgb(0 174 239 / .5)', soft: 'bg-royal-soft' },
  { id: 'm-2569-10', kind: 'monthly', no: '10', range: 'ตุลาคม 2569', news: 64, draftedAt: '2026-11-01T06:00:00+07:00', bg: '#B3218F', glow: 'rgb(255 206 96 / .5)', soft: 'bg-purple-soft' },
];

window.DIGEST_KIND = {
  weekly: { label: 'รายสัปดาห์', masthead: 'PR.SRU WEEKLY' },
  monthly: { label: 'รายเดือน', masthead: 'PR.SRU MONTHLY' },
};

// Who gets the morning reminder while an issue waits for approval
window.DIGEST_REMINDER = { hour: 8, to: ['pr@sru.ac.th', 'pr-editor@sru.ac.th'] };
