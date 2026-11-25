import { fromLatin, latinKey, detectScript, anyToLatin, normalizeLatin, TONES } from './translit.js';
{
// ---------- small helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('mog.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mog.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- IndexedDB for contributions (audio blobs need it) ----------
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('mog-translator', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('contrib', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('contrib', mode); const s = t.objectStore('contrib');
      const out = fn(s); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
    });
  };
  const memory = new Map(); // fallback when IndexedDB is blocked
  return {
    async all() { try { return await tx('readonly', (s) => s.getAll()); } catch { return [...memory.values()]; } },
    async put(v) { try { await tx('readwrite', (s) => s.put(v)); } catch { memory.set(v.id, v); } },
    async del(id) { try { await tx('readwrite', (s) => s.delete(id)); } catch { memory.delete(id); } },
  };
})();

// ---------- state ----------
const state = {
  script: store.get('script', 'latn'),
  tones: store.get('tones', false),
  favs: new Set(store.get('favs', [])),
  history: store.get('history', []),
  lex: null,
  community: [], // approved contributions merged into the dictionary
  tr: store.get('tr', { from: 'mog', to: 'en', text: 'nga3 akong' }),
};
const LANGS = { mog: 'Mog', bn: 'Bengali · বাংলা', en: 'English' };
const SCRIPT_NAMES = { latn: 'Latin', beng: 'Bengali script', mymr: 'Myanmar script' };

const showScript = () => (state.script === 'latn' ? (state.tones ? 'latn-precise' : 'latn') : state.script);
const mog = (latin, script = showScript()) => fromLatin(latin, script);
const draftTag = (script = state.script) => (script === 'latn' ? '' : '<span class="tag" title="Spelling made by draft rules; not yet checked by a Mog writer">draft spelling</span>');

// ---------- data ----------
async function loadData() {
  const res = await fetch('data/lexicon.json');
  state.lex = await res.json();
  await refreshCommunity();
}
async function refreshCommunity() {
  const all = await idb.all();
  state.community = all.filter((c) => c.status === 'approved' && c.mog).map((c) => ({
    id: 'c-' + c.id, mog: normalizeLatin(c.mog), en: c.en || '', bn: c.bn || '', pos: c.pos || '',
    domains: c.category ? [c.category] : [], source: 'community', note: c.note || '', audio: c.audio || null,
    speaker: c.speaker || '', kind: c.kind,
  }));
}
const entries = () => [...state.lex.entries, ...state.community.filter((c) => c.kind !== 'phrase')];
const phrases = () => [...state.lex.phrases, ...state.community.filter((c) => c.kind === 'phrase')];
const byId = (id) => entries().find((e) => e.id === id) || phrases().find((e) => e.id === id);
const glossParts = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').split(/[,;/]/).map((x) => x.trim()).filter(Boolean);

// Mog token -> entries. If the user typed tones, prefer entries with the same tones.
function matchMog(token) {
  const cands = anyToLatin(token);
  const keys = cands.map(latinKey);
  const es = entries().filter((e) => keys.includes(latinKey(e.mog)));
  const toned = cands.filter((c) => /[123]/.test(c));
  if (toned.length) {
    const exact = es.filter((e) => toned.includes(normalizeLatin(e.mog)));
    if (exact.length) return exact;
  }
  return es;
}
const firstGloss = (s) => String(s || '').replace(/\(.*?\)/g, '').split(/[,;/]/)[0].trim();

// ---------- search ----------
function search(q) {
  q = q.trim();
  if (!q) return [];
  const sc = detectScript(q);
  const ql = q.toLowerCase();
  const keys = sc === 'other' ? [] : anyToLatin(q).map(latinKey);
  const scored = [];
  for (const e of entries()) {
    let score = 0;
    const k = latinKey(e.mog);
    if (keys.includes(k)) score = 100;
    else if (keys.some((x) => x && k.startsWith(x))) score = 60;
    if (sc === 'latn' || sc === 'other') {
      if (glossParts(e.en).includes(ql)) score = Math.max(score, 90);
      else if (e.en.toLowerCase().includes(ql)) score = Math.max(score, 50);
    }
    if (sc === 'beng') {
      if (glossParts(e.bn).includes(q)) score = Math.max(score, 95);
      else if (e.bn.includes(q)) score = Math.max(score, 55);
    }
    if (score) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map((x) => x[1]);
}

// ---------- translation (tier 1 phrase match, tier 2 word by word) ----------
function translate(text, from, to) {
  const clean = text.trim();
  if (!clean) return null;
  if (from === to) {
    return { tier: 'Same language', out: from === 'mog' ? mog(anyToLatin(clean)[0] || clean) : clean, words: [] };
  }
  // tier 1: phrasebook
  const field = (p, l) => (l === 'mog' ? latinKey(p.mog) : (p[l] || '').toLowerCase().trim());
  const probe = from === 'mog' ? anyToLatin(clean).map(latinKey) : [clean.toLowerCase()];
  const hit = phrases().find((p) => probe.includes(field(p, from)));
  if (hit) return { tier: 'Phrasebook match', out: to === 'mog' ? mog(hit.mog) : hit[to], words: [{ token: clean, entries: [hit] }] };

  // tier 2: word by word, longest gloss match first for Bengali and English
  const tokens = clean.split(/\s+/);
  const words = [];
  for (let i = 0; i < tokens.length;) {
    let matched = null; let used = 1;
    if (from === 'mog') {
      const es = matchMog(tokens[i]);
      if (es.length) matched = es;
    } else {
      for (let n = Math.min(4, tokens.length - i); n >= 1 && !matched; n--) {
        const piece = tokens.slice(i, i + n).join(' ').toLowerCase().replace(/[.,!?।]/g, '');
        const es = entries().filter((e) => glossParts(e[from]).includes(piece) || (from === 'en' && glossParts(e.en).includes(piece.replace(/^(a|an|the|to) /, ''))));
        if (es.length) { matched = es; used = n; }
      }
    }
    words.push({ token: tokens.slice(i, i + used).join(' '), entries: matched || [] });
    i += used;
  }
  const render = (w) => {
    if (!w.entries.length) return '[' + w.token + ']';
    const vals = [...new Set(w.entries.map((e) => (to === 'mog' ? mog(e.mog) : firstGloss(e[to]) || e[to])))];
    return vals.length > 1 ? vals.join(' / ') : vals[0];
  };
  return { tier: 'Word by word from the dictionary, not a full sentence translation', out: words.map(render).join(' '), words };
}

// ---------- on-screen phonetic keyboard ----------
const KEYS = [
  ['a', 'i', 'u', 'e', 'o', 'aw', 'ae', 'eu', 'ai', 'oi', 'ei', 'au'],
  ['p', 'ph', 'b', 't', 'th', 'd', 'k', 'kh', 'g', 's', 'sh', 'ch', 'z', 'h', 'w', 'y'],
  ['m', 'hm', 'n', 'hn', 'ng', 'hng', 'l', 'hl', 'r', 'hr'],
];
function keyboard(target, onChange) {
  const box = document.createElement('div');
  box.className = 'kbd';
  const hint = (k) => {
    if (state.script === 'latn') return '';
    const v = /^[aeiou]/.test(k) ? k : k + 'a';
    return '<small>' + esc(fromLatin(v, state.script)) + '</small>';
  };
  box.innerHTML = KEYS.map((row) => '<div class="krow">' + row.map((k) => `<button type="button" data-k="${k}">${k}${hint(k)}</button>`).join('') + '</div>').join('')
    + '<div class="krow">' + Object.entries(TONES).map(([d, t]) => `<button type="button" data-k="${d}" title="${t.name}">${('a' + t.mark).normalize('NFC')}<small>${t.name}</small></button>`).join('')
    + '<button type="button" class="wide" data-k=" ">space</button><button type="button" data-k="⌫" aria-label="Delete">⌫</button></div>';
  box.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const k = b.dataset.k; const el = target;
    const s = el.selectionStart ?? el.value.length; const e = el.selectionEnd ?? el.value.length;
    if (k === '⌫') {
      const cut = s === e ? Math.max(0, s - 1) : s;
      el.value = el.value.slice(0, cut) + el.value.slice(e); el.setSelectionRange(cut, cut);
    } else {
      el.value = el.value.slice(0, s) + k + el.value.slice(e); el.setSelectionRange(s + k.length, s + k.length);
    }
    el.focus({ preventScroll: true }); onChange && onChange();
  });
  return box;
}
function previewHTML(text) {
  const latin = anyToLatin(text)[0];
  if (!text.trim() || !latin) return '';
  return `<div><span>Latin</span> <b>${esc(fromLatin(latin, state.tones ? 'latn-precise' : 'latn'))}</b></div>`
    + `<div><span>বাংলা</span> <b>${esc(fromLatin(latin, 'beng'))}</b> ${draftTag('beng')}</div>`
    + `<div><span>မြန်မာ</span> <b>${esc(fromLatin(latin, 'mymr'))}</b> ${draftTag('mymr')}</div>`;
}
function attachMogInput(input, previewEl, kbdBtn, onChange) {
  const update = () => { if (previewEl) previewEl.innerHTML = previewHTML(input.value); onChange && onChange(); };
  input.addEventListener('input', update);
  let kb = null;
  kbdBtn && kbdBtn.addEventListener('click', () => {
    if (kb) { kb.remove(); kb = null; kbdBtn.setAttribute('aria-pressed', 'false'); return; }
    kb = keyboard(input, update); kbdBtn.closest('.field, .card').append(kb); kbdBtn.setAttribute('aria-pressed', 'true');
  });
  update();
}

// ---------- views ----------
const view = $('#view');
const views = {};

views.translate = () => {
  const t = state.tr;
  const opts = (sel) => Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v}</option>`).join('');
  view.innerHTML = `
  <h2>Translate</h2>
  <div class="card">
    <div class="langs">
      <select id="from" aria-label="From">${opts(t.from)}</select>
      <button class="iconbtn" id="swap" type="button" aria-label="Swap languages">⇄</button>
      <select id="to" aria-label="To">${opts(t.to)}</select>
    </div>
    <div class="field">
      <textarea id="src" aria-label="Text to translate" placeholder="Type a word or short sentence"></textarea>
      <div class="row"><button class="btn small" id="kbtn" type="button" aria-pressed="false">Mog keyboard</button><span class="note" id="hintline"></span></div>
      <div class="preview" id="pv"></div>
    </div>
    <div id="res"></div>
  </div>
  <p class="note">Full sentence translation needs thousands of checked Mog sentences. Until then the app matches the phrasebook first, then translates word by word. Every result says which method was used.</p>`;
  const src = $('#src'); src.value = t.text;
  const from = $('#from'); const to = $('#to');
  const run = () => {
    state.tr = { from: from.value, to: to.value, text: src.value }; store.set('tr', state.tr);
    $('#kbtn').hidden = from.value !== 'mog';
    $('#hintline').textContent = from.value === 'mog' ? 'Type Mog in Latin, বাংলা or မြန်မာ letters' : '';
    $('#pv').hidden = from.value !== 'mog';
    const r = translate(src.value, from.value, to.value);
    if (!r) { $('#res').innerHTML = ''; return; }
    const isMogOut = to.value === 'mog';
    $('#res').innerHTML = `<div class="result"><div class="tier">${esc(r.tier)}</div>
      <div class="out" lang="${to.value === 'bn' ? 'bn' : to.value === 'en' ? 'en' : ''}">${esc(r.out)}${isMogOut ? draftTag() : ''}</div>
      ${r.words.length ? '<div class="chips">' + r.words.map((w) => (w.entries.length
        ? w.entries.map((e) => `<a class="chip" href="#entry-${esc(e.id)}">${esc(mog(e.mog))} · ${esc(firstGloss(e.en) || e.en)}</a>`).join('')
        : `<span class="chip unknown" title="Not in the dictionary yet">${esc(w.token)}: not found</span>`)).join('') + '</div>' : ''}
      ${r.words.some((w) => !w.entries.length) ? '<p class="note">Missing words? <a href="#contribute">Add them in Contribute</a>.</p>' : ''}
    </div>`;
  };
  attachMogInput(src, $('#pv'), $('#kbtn'), run);
  from.onchange = run; to.onchange = run;
  $('#swap').onclick = () => { const a = from.value; from.value = to.value; to.value = a; run(); };
  let timer; src.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => addHistory(src.value, from.value), 1500); });
  run();
};

function addHistory(text, lang) {
  text = text.trim(); if (!text) return;
  state.history = [{ text, lang, at: Date.now() }, ...state.history.filter((h) => h.text !== text)].slice(0, 50);
  store.set('history', state.history);
}

const entryRow = (e) => `<li><a href="#entry-${esc(e.id)}"><span><span class="mogw">${esc(mog(e.mog))}</span><br><span class="gloss">${esc(e.en)} · ${esc(e.bn)}</span></span><span class="pos">${esc(e.pos || '')}</span></a></li>`;

views.dictionary = () => {
  view.innerHTML = `
  <h2>Dictionary</h2>
  <div class="field"><input type="search" id="q" placeholder="Search Mog, বাংলা or English" aria-label="Search"></div>
  <p class="note" id="count"></p>
  <ul class="list" id="results"></ul>
  <details style="margin-top:16px"><summary>About this data</summary><p class="note">${esc(state.lex.notice)}</p></details>`;
  const q = $('#q'); q.value = store.get('lastq', '');
  const draw = () => {
    store.set('lastq', q.value);
    const list = q.value.trim() ? search(q.value) : [...entries()].sort((a, b) => latinKey(a.mog).localeCompare(latinKey(b.mog)));
    $('#count').textContent = q.value.trim() ? `${list.length} match${list.length === 1 ? '' : 'es'}` : `${list.length} words, A to Z`;
    $('#results').innerHTML = list.length ? list.map(entryRow).join('') : `<li class="empty">No match. <a href="#contribute">Suggest this word</a></li>`;
  };
  q.addEventListener('input', draw);
  q.addEventListener('change', () => addHistory(q.value, detectScript(q.value)));
  draw();
};

views.entry = (id) => {
  const e = byId(id);
  if (!e) { view.innerHTML = '<p class="empty">Entry not found.</p>'; return; }
  const src = state.lex.sources[e.source];
  const fav = state.favs.has(e.id);
  const homographs = entries().filter((x) => x.id !== e.id && latinKey(x.mog) === latinKey(e.mog));
  view.innerHTML = `
  <p><a href="#dictionary">← Dictionary</a></p>
  <div class="row" style="justify-content:space-between;align-items:flex-start">
    <div><div class="entry-head">${esc(mog(e.mog))}</div>${draftTag()}</div>
    <button class="iconbtn" id="fav" aria-pressed="${fav}" aria-label="Save to favourites" title="Save"><svg width="26" height="26" viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></button>
  </div>
  <p style="font-size:20px;margin:6px 0">${esc(e.en)} <span class="gloss">· ${esc(e.bn)}</span> <span class="pos">${esc(e.pos || '')}</span></p>
  <dl class="scripts">
    <dt>Latin</dt><dd>${esc(fromLatin(e.mog, 'latn-precise'))}${e.ipa ? ` <span class="gloss">IPA /${esc(e.ipa)}/</span>` : ''}</dd>
    <dt>বাংলা</dt><dd>${esc(fromLatin(e.mog, 'beng'))} ${draftTag('beng')}</dd>
    <dt>မြန်မာ</dt><dd>${esc(fromLatin(e.mog, 'mymr'))} ${draftTag('mymr')}</dd>
  </dl>
  ${e.note ? `<p>${esc(e.note)}</p>` : ''}
  ${homographs.length ? `<p class="note">Same spelling, different word: ${homographs.map((h) => `<a href="#entry-${esc(h.id)}">${esc(h.en)}</a>`).join(', ')}. Tone tells them apart.</p>` : ''}
  <h3>Pronunciation</h3>
  <div id="audio">${e.audio ? '<audio controls preload="none"></audio>' : `<p class="note">No recording yet.${e.source === 'iitg' || e.source === 'iitg+icphs' ? ` You can hear this word on the <a href="${esc(state.lex.sources.iitg.url)}" target="_blank" rel="noopener">IIT Guwahati database</a>.` : ''}</p>`}</div>
  <div class="row" style="margin-top:12px">
    <a class="btn" href="#contribute" id="rec">Record pronunciation</a>
    <a class="btn" href="#contribute" id="fix">Suggest a correction</a>
  </div>
  <h3>Source</h3>
  <p class="note">${src ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.title)}</a>, ${esc(src.by)}.` : e.source === 'community' ? `Community contribution${e.speaker ? ', speaker ' + esc(e.speaker) : ''}, approved on this device.` : ''}
  English gloss as printed by the source. Bengali gloss and part of speech added for this prototype; please check.</p>`;
  if (e.audio) { const a = $('#audio audio'); a.src = URL.createObjectURL(e.audio); }
  $('#fav').onclick = () => { state.favs.has(e.id) ? state.favs.delete(e.id) : state.favs.add(e.id); store.set('favs', [...state.favs]); views.entry(id); };
  const prefill = (kind) => () => store.set('prefill', { kind, mog: fromLatin(e.mog, 'latn-precise'), en: e.en, bn: e.bn, target: e.id });
  $('#rec').onclick = prefill('audio'); $('#fix').onclick = prefill('correction');
};

views.phrases = (cat) => {
  const cats = state.lex.categories;
  if (!cat) {
    view.innerHTML = `<h2>Phrasebook</h2><div class="grid2">${cats.map((c) => {
      const n = entries().filter((e) => (e.domains || []).includes(c.id)).length + phrases().filter((p) => (p.domains || []).includes(c.id)).length;
      return `<a class="cat" href="#phrases-${c.id}"><b>${esc(c.en)}</b><span>${esc(c.bn)} · ${n} item${n === 1 ? '' : 's'}</span></a>`;
    }).join('')}</div>
    <p class="note" style="margin-top:14px">There are no checked Mog phrases in any source we found yet, so each category lists its words for now. Speakers can add phrases in Contribute.</p>`;
    return;
  }
  const c = cats.find((x) => x.id === cat) || cats[0];
  const ps = phrases().filter((p) => (p.domains || []).includes(c.id));
  const ws = entries().filter((e) => (e.domains || []).includes(c.id));
  view.innerHTML = `<p><a href="#phrases">← Phrasebook</a></p><h2>${esc(c.en)} <span class="gloss">${esc(c.bn)}</span></h2>
  <h3>Phrases</h3>
  ${ps.length ? '<ul class="list">' + ps.map(entryRow).join('') + '</ul>' : `<div class="empty">No checked phrases yet.<br><a class="btn primary" style="margin-top:10px;display:inline-block;text-decoration:none" href="#contribute" id="addp">Add a ${esc(c.en.toLowerCase())} phrase</a></div>`}
  <h3>Words</h3>
  ${ws.length ? '<ul class="list">' + ws.map(entryRow).join('') + '</ul>' : '<p class="empty">No words in this category yet.</p>'}`;
  const addp = $('#addp'); if (addp) addp.onclick = () => store.set('prefill', { kind: 'phrase', category: c.id });
};

views.saved = () => {
  const favs = [...state.favs].map(byId).filter(Boolean);
  view.innerHTML = `<h2>Saved</h2>
  <h3>Favourites</h3>
  ${favs.length ? '<ul class="list">' + favs.map(entryRow).join('') + '</ul>' : '<p class="empty">Tap the star on any word to keep it here.</p>'}
  <h3>Recent searches</h3>
  ${state.history.length ? '<ul class="list">' + state.history.slice(0, 20).map((h, i) => `<li><a href="#dictionary" data-h="${i}"><span>${esc(h.text)}</span><span class="pos">${new Date(h.at).toLocaleDateString()}</span></a></li>`).join('') + '</ul><p><button class="btn small" id="clearh" type="button">Clear history</button></p>' : '<p class="empty">Nothing searched yet.</p>'}`;
  view.querySelectorAll('[data-h]').forEach((a) => (a.onclick = () => store.set('lastq', state.history[a.dataset.h].text)));
  const ch = $('#clearh'); if (ch) ch.onclick = () => { state.history = []; store.set('history', []); views.saved(); };
};

// ---------- contribute and moderate ----------
let recorder = null; let chunks = []; let recordedBlob = null;
views.contribute = async () => {
  const pre = store.get('prefill', null); store.set('prefill', null);
  const mod = store.get('moderator', false);
  const cats = state.lex.categories;
  view.innerHTML = `<h2>Contribute</h2>
  <div class="banner">Suggestions are saved on this phone first and work offline. Export them to send to a moderator. Nothing appears in the dictionary until a moderator approves it.</div>
  <form id="cform" class="card" autocomplete="off">
    <div class="field"><label for="kind">What are you adding?</label>
      <select id="kind"><option value="word">A new word</option><option value="phrase">A phrase</option><option value="correction">A correction</option><option value="audio">A pronunciation recording</option></select></div>
    <div class="field"><label for="cmog">Mog (any script)</label>
      <input type="text" id="cmog" placeholder="e.g. akong, আকোং or Myanmar letters">
      <div class="row"><button class="btn small" id="ckb" type="button" aria-pressed="false">Mog keyboard</button></div>
      <div class="preview" id="cpv"></div></div>
    <div class="field"><label for="cbn">Bengali meaning</label><input type="text" id="cbn" lang="bn"></div>
    <div class="field"><label for="cen">English meaning</label><input type="text" id="cen"></div>
    <div class="field"><label for="ccat">Category</label><select id="ccat"><option value="">None</option>${cats.map((c) => `<option value="${c.id}">${esc(c.en)}</option>`).join('')}</select></div>
    <div class="field"><label for="cnote">Note (village, usage, what to correct)</label><textarea id="cnote" style="min-height:70px"></textarea></div>
    <div class="field"><label>Recording (up to 10 seconds)</label>
      <div class="rec" id="recbox"></div></div>
    <div class="field"><label for="cspk">Speaker name or code</label><input type="text" id="cspk" placeholder="Can be left blank"></div>
    <label class="check"><input type="checkbox" id="consent"> The speaker agrees that this recording and text can be used in the Mog dictionary and shared with credit.</label>
    <p><button class="btn primary" type="submit">Save suggestion</button></p>
  </form>
  <h3>My suggestions</h3><div id="queue"></div>
  <div class="row" style="margin-top:10px"><button class="btn small" id="exp" type="button">Export for moderator</button>
  <label class="btn small" for="imp" style="display:inline-flex;align-items:center">Import file</label><input type="file" id="imp" accept="application/json" hidden></div>
  <h3>Moderator</h3>
  <label class="check"><input type="checkbox" id="modt"${mod ? ' checked' : ''}> I am a moderator on this device</label>
  <div id="review"></div>`;
  if (pre) {
    $('#kind').value = pre.kind || 'word';
    if (pre.mog) $('#cmog').value = pre.mog;
    if (pre.en) $('#cen').value = pre.en;
    if (pre.bn) $('#cbn').value = pre.bn;
    if (pre.category) $('#ccat').value = pre.category;
    if (pre.target) $('#cform').dataset.target = pre.target;
  }
  attachMogInput($('#cmog'), $('#cpv'), $('#ckb'));
  drawRecorder();
  $('#cform').onsubmit = async (ev) => {
    ev.preventDefault();
    const m = $('#cmog').value.trim();
    if (!m && $('#kind').value !== 'audio') { toast('Add the Mog word or phrase first'); return; }
    if (recordedBlob && !$('#consent').checked) { toast('Please confirm the speaker agrees'); return; }
    const latin = anyToLatin(m)[0] || m;
    await idb.put({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: $('#kind').value, mog: latin, typed: m, bn: $('#cbn').value.trim(), en: $('#cen').value.trim(),
      category: $('#ccat').value, note: $('#cnote').value.trim(), speaker: $('#cspk').value.trim(),
      consent: $('#consent').checked, audio: recordedBlob, target: $('#cform').dataset.target || '',
      status: 'pending', created: new Date().toISOString(),
    });
    recordedBlob = null; toast('Saved. A moderator will review it.');
    views.contribute();
  };
  $('#exp').onclick = exportQueue;
  $('#imp').onchange = importQueue;
  $('#modt').onchange = (e) => { store.set('moderator', e.target.checked); drawQueue(); };
  drawQueue();
};

function drawRecorder() {
  const box = $('#recbox'); if (!box) return;
  const can = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!can) { box.innerHTML = '<span class="note">Recording isn\'t available in this browser or preview. Install the app from Chrome on Android to record.</span>'; return; }
  if (recorder) { box.innerHTML = '<span class="dot"></span> Recording… <button class="btn small" type="button" id="stop">Stop</button>'; $('#stop').onclick = () => recorder.stop(); return; }
  box.innerHTML = `<button class="btn" type="button" id="start">● Record</button>${recordedBlob ? ' <audio controls id="playback"></audio> <button class="btn small" type="button" id="discard">Discard</button>' : ''}`;
  if (recordedBlob) { $('#playback').src = URL.createObjectURL(recordedBlob); $('#discard').onclick = () => { recordedBlob = null; drawRecorder(); }; }
  $('#start').onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = []; recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => { recordedBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }); stream.getTracks().forEach((t) => t.stop()); recorder = null; drawRecorder(); };
      recorder.start(); setTimeout(() => recorder && recorder.state === 'recording' && recorder.stop(), 10000);
      drawRecorder();
    } catch { toast('Microphone permission was not given'); }
  };
}

async function drawQueue() {
  const all = (await idb.all()).sort((a, b) => b.created.localeCompare(a.created));
  const mine = all.filter((c) => !c.imported);
  const row = (c, actions) => `<li><div class="item"><span><span class="mogw">${esc(c.mog ? mog(c.mog) : '(recording only)')}</span><br><span class="gloss">${esc(c.kind)} · ${esc(c.en || '')}${c.bn ? ' · ' + esc(c.bn) : ''}${c.audio ? ' · with audio' : ''}${c.note ? ' · ' + esc(c.note) : ''}</span></span>
    <span class="row" style="justify-content:flex-end">${actions ? `<button class="btn small" data-a="approve" data-id="${esc(c.id)}">Approve</button><button class="btn small" data-a="reject" data-id="${esc(c.id)}">Reject</button>` : `<span class="status ${esc(c.status)}">${esc(c.status)}</span>`}</span></div></li>`;
  $('#queue').innerHTML = mine.length ? '<ul class="list">' + mine.map((c) => row(c, false)).join('') + '</ul>' : '<p class="empty">No suggestions yet.</p>';
  if (!store.get('moderator', false)) { $('#review').innerHTML = ''; return; }
  const pending = all.filter((c) => c.status === 'pending');
  $('#review').innerHTML = pending.length ? '<p class="note">Approve only what a second speaker has confirmed. Approved items join the dictionary on this device; export them to share.</p><ul class="list">' + pending.map((c) => row(c, true)).join('') + '</ul>' : '<p class="empty">Nothing waiting for review. Import a file a contributor sent you.</p>';
  $('#review').querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const c = all.find((x) => x.id === b.dataset.id);
    c.status = b.dataset.a === 'approve' ? 'approved' : 'rejected'; c.reviewed = new Date().toISOString();
    await idb.put(c); await refreshCommunity(); toast(c.status === 'approved' ? 'Approved and added to the dictionary' : 'Rejected'); drawQueue();
  }));
}

const blobToData = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
async function exportQueue() {
  const all = await idb.all();
  const out = await Promise.all(all.map(async (c) => ({ ...c, audio: c.audio ? await blobToData(c.audio) : null })));
  const blob = new Blob([JSON.stringify({ app: 'mog-translator', exported: new Date().toISOString(), items: out }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mog-contributions-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  toast(`Exported ${all.length} item${all.length === 1 ? '' : 's'}`);
}
async function importQueue(ev) {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    let n = 0;
    for (const c of data.items || []) {
      if (!c.id || typeof c.id !== 'string') continue;
      const audio = typeof c.audio === 'string' && c.audio.startsWith('data:audio') ? await (await fetch(c.audio)).blob() : null;
      await idb.put({ ...c, audio, imported: true, mog: typeof c.mog === 'string' ? c.mog : '' }); n++;
    }
    await refreshCommunity(); toast(`Imported ${n} item${n === 1 ? '' : 's'}`); drawQueue();
  } catch { toast('That file could not be read'); }
}

// ---------- routing and settings ----------
function route() {
  const h = (location.hash || '#translate').slice(1);
  const [name, ...rest] = h.split('-');
  const arg = rest.join('-');
  const tab = name === 'entry' ? 'dictionary' : name;
  document.querySelectorAll('nav.tabs a').forEach((a) => (a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  (views[name] || views.translate)(arg);
  window.scrollTo(0, 0);
}
function syncHeader() {
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.script === state.script)));
  $('#tones').checked = state.tones;
}
document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { state.script = b.dataset.script; store.set('script', state.script); syncHeader(); route(); }));
$('#tones').onchange = (e) => { state.tones = e.target.checked; store.set('tones', state.tones); route(); };

addEventListener('hashchange', route);
loadData().then(() => { syncHeader(); route(); }).catch(() => { view.innerHTML = '<p class="empty">Could not load the dictionary. Check your connection and reload once; after that it works offline.</p>'; });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* not available in previews */ });
}
}
