// Thai text for search: Thai is written without spaces between words, so a query is cut into words with the
// dictionary in ICU (Intl.Segmenter, built into Node) before it is matched.
//   searchTerms('ค่ายอาสาชนบท 2569') → [{ phrase: 'ค่ายอาสาชนบท', words: ['ค่าย', 'อาสา', 'ชนบท'] }, { phrase: '2569', words: [] }]
// A story matches a term when it contains the phrase as typed, or else every one of its words (in any order or place).
const seg = new Intl.Segmenter('th', { granularity: 'word' });
const THAI = /[฀-๿]/;

// Small words that appear in nearly every story: on their own they would match everything
const STOP = new Set(['การ', 'ความ', 'ของ', 'และ', 'ที่', 'ใน', 'กับ', 'ให้', 'ได้', 'เป็น', 'มี', 'จาก', 'โดย', 'เพื่อ', 'แก่', 'ต่อ', 'ซึ่ง', 'หรือ',
  'ว่า', 'จะ', 'ไป', 'มา', 'นี้', 'นั้น', 'แล้ว', 'อยู่', 'คือ', 'ทั้ง', 'ด้วย', 'เมื่อ', 'ไว้', 'ถึง', 'แต่', 'ก็', 'อย่าง', 'ๆ']);

// Thai words; numbers and Latin letters glued to Thai become words of their own ("ชนะเลิศ2569" → ชนะ, เลิศ, 2569)
export function thaiWords(text) {
  const out = [];
  for (const part of text.split(/([฀-๿]+)/).filter(Boolean)) {
    if (!THAI.test(part)) { for (const w of part.split(/[^\p{L}\p{N}]+/u)) if (w) out.push(w); continue; }
    for (const s of seg.segment(part)) if (s.isWordLike) out.push(s.segment);
  }
  return out;
}

export function searchTerms(q, max = 5) {
  const chunks = [...new Set(q.trim().split(/\s+/).filter(Boolean))].slice(0, max);
  return chunks.map((phrase) => {
    if (!THAI.test(phrase)) return { phrase, words: [] };
    const words = [...new Set(thaiWords(phrase).filter((w) => !STOP.has(w)))];
    // One word, or the phrase itself: nothing to add
    return { phrase, words: words.length > 1 || (words[0] && words[0] !== phrase) ? words.slice(0, 8) : [] };
  });
}
