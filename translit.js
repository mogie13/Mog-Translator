// Mog transliteration engine (draft).
//
// The pivot is a phonemic Latin spelling built from the inventory in
// Mahanta & Gope (2019), "Voiceless sonorants and lexical tone in Mog":
//   25 consonants incl. aspirated stops and voiceless m, n, ng, l, r
//   7 vowels /i ɛ ə a ɔ o u/, 3 tones (high-falling, mid-rising, low-rising)
//
// Latin  -> Bengali script and Myanmar script are rule-driven from the tables
// below. The Bengali and Myanmar outputs are MECHANICAL DRAFTS: they are not
// yet checked against Mog school textbooks or native writers, and the app
// labels them "unverified" everywhere they appear.
//
// Tones in Latin: optional digit after a syllable (1 high-falling,
// 2 mid-rising, 3 low-rising), or the diacritics used by the paper
// (â = 1, ǎ = 2, a᷅ = 3). Plain spelling without tones is always accepted.

export const TONES = {
  1: { name: 'high-falling', mark: '̂' }, // â
  2: { name: 'mid-rising', mark: '̌' },   // ǎ
  3: { name: 'low-rising', mark: '᷅' },   // a᷅
};

// Onsets: base consonant, plus whether it is voiceless (ha-htoe in Myanmar).
// Order matters only for display; parsing uses longest match.
const ONSETS = {
  p: { my: 'ပ', bn: 'প' }, ph: { my: 'ဖ', bn: 'ফ' }, b: { my: 'ဗ', bn: 'ব' },
  t: { my: 'တ', bn: 'ত' }, th: { my: 'ထ', bn: 'থ' }, d: { my: 'ဒ', bn: 'দ' },
  k: { my: 'က', bn: 'ক' }, kh: { my: 'ခ', bn: 'খ' }, g: { my: 'ဂ', bn: 'গ' },
  m: { my: 'မ', bn: 'ম' }, hm: { my: 'မ', h: 1, bn: 'হ্ম' },
  n: { my: 'န', bn: 'ন' }, hn: { my: 'န', h: 1, bn: 'হ্ন' },
  ng: { my: 'င', bn: 'ঙ' }, hng: { my: 'င', h: 1, bn: 'হ্ঙ' },
  r: { my: 'ရ', bn: 'র' }, hr: { my: 'ရ', h: 1, bn: 'হ্র' },
  l: { my: 'လ', bn: 'ল' }, hl: { my: 'လ', h: 1, bn: 'হ্ল' },
  s: { my: 'စ', bn: 'স' }, sh: { my: 'သ', y: 1, h: 1, bn: 'শ' },
  ch: { my: 'ခ', y: 1, bn: 'চ' }, z: { my: 'ဇ', bn: 'জ' }, j: { my: 'ဂ', y: 1, bn: 'জ' },
  h: { my: 'ဟ', bn: 'হ' }, w: { my: 'ဝ', bn: 'ওয়' }, y: { my: 'ယ', bn: 'য়' },
};
// Consonants that can take a medial y, r or w (e.g. "bro" ice, "pro" cricket).
const MEDIAL_HOSTS = new Set(['p', 'ph', 'b', 'm', 'hm', 'k', 'kh', 'g', 't', 'th', 'd', 'l', 'hl', 'n', 'hn']);
const MEDIALS = {
  y: { my: 'ျ', bn: '্য' },
  r: { my: 'ြ', bn: '্র' },
  w: { my: 'ွ', bn: '্ব' },
};

// Nuclei. bnDep/bnInd = Bengali dependent / independent vowel.
// myOpen = Myanmar spelling in an open syllable, myClosed = before a final.
const NUCLEI = {
  a: { bnDep: 'া', bnInd: 'আ', myOpen: 'ာ', myClosed: '' },
  i: { bnDep: 'ি', bnInd: 'ই', myOpen: 'ီ', myClosed: 'ိ' },
  u: { bnDep: 'ু', bnInd: 'উ', myOpen: 'ူ', myClosed: 'ု' },
  e: { bnDep: 'ে', bnInd: 'এ', myOpen: 'ေ', myClosed: 'ေ' },
  o: { bnDep: 'ো', bnInd: 'ও', myOpen: 'ို', myClosed: 'ို' },
  aw: { bnDep: '', bnInd: 'অ', myOpen: 'ော', myClosed: 'ော' },   // /ɔ/
  ae: { bnDep: '্যা', bnInd: 'অ্যা', myOpen: 'ယ်', myClosed: 'ဲ' }, // /ɛ/
  eu: { bnDep: 'ে', bnInd: 'এ', myOpen: '', myClosed: '' },      // /ə/
  ia: { bnDep: 'িয়া', bnInd: 'ইয়া', myOpen: 'ာ', myClosed: '', myMedialY: 1 },
  ai: { bnDep: 'ৈ', bnInd: 'ঐ', myOpen: 'ဲ', myClosed: 'ဲ' },
  au: { bnDep: 'ৌ', bnInd: 'ঔ', myOpen: 'ော်', myClosed: 'ော' },
  ei: { bnDep: 'েই', bnInd: 'এই', myOpen: 'ေ', myClosed: 'ိ' },
  oi: { bnDep: 'োই', bnInd: 'ওই', myOpen: 'ိုယ်', myClosed: 'ို' },
  ou: { bnDep: 'োউ', bnInd: 'ওউ', myOpen: 'ို', myClosed: 'ို' },
};
const FINALS = {
  ng: { my: 'င်', bn: 'ং' }, n: { my: 'န်', bn: 'ন্' }, m: { my: 'မ်', bn: 'ম্' },
  k: { my: 'က်', bn: 'ক্' }, t: { my: 'တ်', bn: 'ত্' }, p: { my: 'ပ်', bn: 'প্' },
  h: { my: 'ဟ်', bn: 'ঃ' },
};
// Draft tone spelling in Myanmar script (Burmese convention guessed).
const TALL_AA = new Set(['ခ', 'ဂ', 'င', 'ဒ', 'ပ', 'ဝ']);
const MY_TONE = { 1: 'း', 2: '', 3: '့' };

const byLength = (o) => Object.keys(o).sort((a, b) => b.length - a.length);
const ONSET_KEYS = byLength(ONSETS);
const NUCLEUS_KEYS = byLength(NUCLEI);
const FINAL_KEYS = byLength(FINALS);
const VOWEL_START = /^(a|e|i|o|u)/;

const MARK_TO_TONE = { '̂': 1, '̌': 2, '᷅': 3 };

// Normalise free Latin input: lower case, IPA letters mapped to the ASCII
// scheme, voiceless rings -> h prefix, and tone diacritics (â ǎ a᷅) moved to
// a digit at the end of their syllable. Other diacritics are dropped.
export function normalizeLatin(input) {
  let s = input.normalize('NFD').toLowerCase();
  const ipa = { 'ŋ': 'ng', 'ɛ': 'ae', 'ə': 'eu', 'ɔ': 'aw', 'ʃ': 'sh', 'ɾ': 'r', 'ʰ': 'h', 'ɡ': 'g' };
  s = s.replace(/[ŋɛəɔʃɾʰɡ]/g, (c) => ipa[c]);
  s = s.replace(/(ng|[mnlr])[\u0325\u030A]/g, 'h$1');
  return s.replace(/[a-z0-9\u0300-\u036f\u1dc0-\u1dff]+/g, placeTones);
}
function placeTones(word) {
  let bare = '';
  const toneAt = [];
  for (const ch of word) {
    if (MARK_TO_TONE[ch]) { toneAt[bare.length - 1] = MARK_TO_TONE[ch]; continue; }
    if (/[\u0300-\u036f\u1dc0-\u1dff]/.test(ch)) continue;
    bare += ch;
  }
  if (!toneAt.length) return bare;
  const sylls = parseWord(bare.replace(/[123]/g, ''));
  if (!sylls) return bare;
  let out = '';
  let pos = 0;
  for (const syl of sylls) {
    const len = syl.onset.length + syl.medial.length + syl.nucleus.length + syl.final.length;
    let tone = 0;
    for (let j = pos; j < pos + len; j++) if (toneAt[j]) tone = toneAt[j];
    out += bare.slice(pos, pos + len) + (tone || '');
    pos += len;
  }
  return out;
}

function canStartSyllable(str) {
  for (const k of ONSET_KEYS) {
    if (!str.startsWith(k)) continue;
    const after = str.slice(k.length);
    if (VOWEL_START.test(after)) return true;
    if (MEDIALS[after[0]] && MEDIAL_HOSTS.has(k) && VOWEL_START.test(after.slice(1))) return true;
  }
  return false;
}

// Parse one Latin word into syllables. Returns null if it does not fit.
export function parseWord(word) {
  const w = word;
  const sylls = [];
  let i = 0;
  while (i < w.length) {
    const syl = { onset: '', medial: '', nucleus: '', final: '', tone: 0 };
    const rest = w.slice(i);
    // onset (only if a vowel follows, possibly after a medial)
    for (const k of ONSET_KEYS) {
      if (!rest.startsWith(k)) continue;
      const after = rest.slice(k.length);
      if (VOWEL_START.test(after)) { syl.onset = k; break; }
      const m = after[0];
      if (MEDIALS[m] && MEDIAL_HOSTS.has(k) && VOWEL_START.test(after.slice(1))) { syl.onset = k; syl.medial = m; break; }
    }
    i += syl.onset.length + syl.medial.length;
    const r2 = w.slice(i);
    for (const k of NUCLEUS_KEYS) { if (r2.startsWith(k)) { syl.nucleus = k; break; } }
    if (!syl.nucleus) return null;
    i += syl.nucleus.length;
    const r3 = w.slice(i);
    // a consonant that can open the next syllable belongs to it ("a-kha")
    if (!canStartSyllable(r3)) {
      for (const k of FINAL_KEYS) {
        if (!r3.startsWith(k)) continue;
        const after = r3.slice(k.length).replace(/^[123]/, '');
        if (VOWEL_START.test(after)) continue;
        syl.final = k; break;
      }
    }
    i += syl.final.length;
    if (/[123]/.test(w[i] || '')) { syl.tone = Number(w[i]); i += 1; }
    sylls.push(syl);
  }
  return sylls;
}

function sylToBengali(s, first) {
  const n = NUCLEI[s.nucleus];
  let out = '';
  if (s.onset) {
    out += ONSETS[s.onset].bn + (s.medial ? MEDIALS[s.medial].bn : '') + n.bnDep;
  } else {
    out += n.bnInd;
  }
  if (s.final) out += FINALS[s.final].bn;
  return out;
}

function sylToMyanmar(s) {
  const n = NUCLEI[s.nucleus];
  const on = s.onset ? ONSETS[s.onset] : { my: 'အ' };
  const y = on.y || s.medial === 'y' || n.myMedialY;
  let out = on.my;
  if (y) out += 'ျ';
  if (s.medial === 'r') out += 'ြ';
  if (s.medial === 'w') out += 'ွ';
  if (on.h) out += 'ှ';
  let v = s.final ? n.myClosed + FINALS[s.final].my : n.myOpen;
  // Burmese spelling uses the tall aa (ါ) after round letters with no medial.
  if (TALL_AA.has(on.my) && !y && s.medial !== 'r' && !on.h) v = v.replace('ာ', 'ါ');
  out += v;
  if (s.tone) out += MY_TONE[s.tone];
  return out;
}

function sylToLatin(s, precise) {
  let nuc = s.nucleus;
  if (precise && s.tone) nuc = nuc[0] + TONES[s.tone].mark + nuc.slice(1);
  return (s.onset + s.medial + nuc + s.final).normalize('NFC');
}

// Convert a Latin Mog string (any number of words) to one script.
// script: 'latn' | 'latn-precise' | 'beng' | 'mymr'
export function fromLatin(text, script) {
  const norm = normalizeLatin(text);
  return norm.replace(/[a-z123]+/g, (word) => {
    const sylls = parseWord(word);
    if (!sylls) return script.startsWith('latn') ? word.replace(/[123]/g, '') : '⟨' + word + '⟩';
    if (script === 'beng') return sylls.map((s, i) => sylToBengali(s, i === 0)).join('');
    if (script === 'mymr') return sylls.map(sylToMyanmar).join('');
    return sylls.map((s) => sylToLatin(s, script === 'latn-precise')).join('');
  });
}

// Plain search key: Latin without tones or spaces.
export function latinKey(text) {
  return normalizeLatin(text).replace(/[123\s\-'.]/g, '');
}

export function detectScript(text) {
  if (/[က-႟ꩠ-ꩿꧠ-꧿]/.test(text)) return 'mymr';
  if (/[ঀ-৿]/.test(text)) return 'beng';
  if (/[a-zA-ZÀ-ɏɐ-ʯ]/.test(text)) return 'latn';
  return 'other';
}

// ---- Reverse direction (Bengali or Myanmar script -> Latin candidates) ----
// We enumerate every syllable the rules can produce, index its spelling in
// each script, and segment input with dynamic programming. Ambiguous input
// yields several candidates; the app ranks them against the dictionary.
let reverseIndex = null;
function buildReverse() {
  const idx = { beng: new Map(), mymr: new Map() };
  const add = (script, form, latin) => {
    if (!form) return;
    if (!idx[script].has(form)) idx[script].set(form, []);
    const list = idx[script].get(form);
    if (!list.includes(latin)) list.push(latin);
  };
  const onsets = ['', ...Object.keys(ONSETS)];
  for (const on of onsets) {
    const meds = on && MEDIAL_HOSTS.has(on) ? ['', 'y', 'r', 'w'] : [''];
    for (const med of meds) {
      for (const nu of Object.keys(NUCLEI)) {
        for (const fi of ['', ...Object.keys(FINALS)]) {
          for (const tone of [0, 1, 2, 3]) {
            const s = { onset: on, medial: med, nucleus: nu, final: fi, tone };
            const latin = sylToLatin({ ...s, tone: 0 }, false) + (tone || '');
            if (!tone) add('beng', sylToBengali(s), latin);
            add('mymr', sylToMyanmar(s), latin);
          }
        }
      }
    }
  }
  idx.maxLen = 12;
  return idx;
}

export function toLatinCandidates(text, script, limit = 6) {
  if (!reverseIndex) reverseIndex = buildReverse();
  const map = reverseIndex[script];
  const src = text.normalize('NFC').replace(/\s+/g, '');
  const n = src.length;
  // best[i] = list of {latin, syllables} for prefix of length i (keep a few)
  const best = Array.from({ length: n + 1 }, () => []);
  best[0] = [{ latin: '', count: 0 }];
  for (let i = 0; i < n; i++) {
    if (!best[i].length) continue;
    for (let L = Math.min(reverseIndex.maxLen, n - i); L >= 1; L--) {
      const piece = src.slice(i, i + L);
      const hits = map.get(piece);
      if (!hits) continue;
      for (const prev of best[i]) {
        for (const h of hits) {
          best[i + L].push({ latin: prev.latin + h, count: prev.count + 1 });
        }
      }
      best[i + L].sort((a, b) => a.count - b.count);
      best[i + L] = dedupe(best[i + L]).slice(0, 24);
    }
  }
  return best[n].map((c) => c.latin).slice(0, limit);
}
function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => (seen.has(c.latin) ? false : (seen.add(c.latin), true)));
}

// Convenience: any-script Mog input -> Latin candidates.
export function anyToLatin(text) {
  const sc = detectScript(text);
  if (sc === 'latn') return [normalizeLatin(text)];
  if (sc === 'beng' || sc === 'mymr') return toLatinCandidates(text, sc);
  return [];
}
