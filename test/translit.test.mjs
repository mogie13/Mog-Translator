// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLatin, parseWord, fromLatin, latinKey, detectScript, toLatinCandidates, anyToLatin } from '../translit.js';
import { readFileSync } from 'node:fs';

const lexicon = JSON.parse(readFileSync(new URL('../data/lexicon.json', import.meta.url)));

test('IPA from Mahanta & Gope (2019) normalises to the ASCII scheme', () => {
  assert.equal(normalizeLatin('ŋâ'), 'nga1');      // five
  assert.equal(normalizeLatin('ŋǎ'), 'nga2');      // fish
  assert.equal(normalizeLatin('ŋa᷅'), 'nga3');     // I
  assert.equal(normalizeLatin('l̥ǐ'), 'hli2');      // boat
  assert.equal(normalizeLatin('m̥ia'), 'hmia');     // fishing hook
  assert.equal(normalizeLatin('ākʰá'), 'akha');     // level-tone marks dropped
});

test('every word in the seed lexicon parses into syllables', () => {
  for (const e of lexicon.entries) {
    const word = normalizeLatin(e.mog).replace(/\s+/g, '');
    assert.ok(parseWord(word), `could not parse ${e.mog}`);
  }
});

test('syllabification keeps consonant + vowel together', () => {
  const s = parseWord('agong').map((x) => x.onset + x.nucleus + x.final);
  assert.deepEqual(s, ['a', 'gong']);
  const t = parseWord('thoing')[0];
  assert.deepEqual([t.onset, t.nucleus, t.final], ['th', 'oi', 'ng']);
  const b = parseWord('bro')[0];
  assert.deepEqual([b.onset, b.medial, b.nucleus], ['b', 'r', 'o']);
});

test('voiceless sonorants are kept distinct in every script', () => {
  for (const sc of ['beng', 'mymr']) {
    assert.notEqual(fromLatin('mia', sc), fromLatin('hmia', sc), sc);
    assert.notEqual(fromLatin('li', sc), fromLatin('hli', sc), sc);
  }
  assert.equal(fromLatin('hmia', 'mymr'), 'မျှာ');
  assert.equal(fromLatin('nga', 'mymr'), 'ငါ'); // tall aa after round letters
  assert.equal(fromLatin('hli', 'mymr'), 'လှီ');
});

test('tones show in precise Latin and Myanmar, never break plain Latin', () => {
  assert.equal(fromLatin('nga1', 'latn'), 'nga');
  assert.equal(fromLatin('nga1', 'latn-precise'), 'ngâ');
  assert.equal(fromLatin('nga2', 'latn-precise'), 'ngǎ');
  assert.notEqual(fromLatin('nga1', 'mymr'), fromLatin('nga3', 'mymr'));
});

test('round trip: Bengali and Myanmar output finds the original word', () => {
  for (const e of lexicon.entries) {
    const key = latinKey(e.mog);
    for (const sc of ['beng', 'mymr']) {
      const shown = fromLatin(e.mog, sc).replace(/\s+/g, '');
      const back = toLatinCandidates(shown, sc, 50).map(latinKey);
      assert.ok(back.includes(key), `${e.mog} -> ${sc} ${shown} -> ${back.slice(0, 5)}`);
    }
  }
});

test('script detection', () => {
  assert.equal(detectScript('agong'), 'latn');
  assert.equal(detectScript('আগোং'), 'beng');
  assert.equal(detectScript('အဂေါင်'), 'mymr');
  assert.deepEqual(anyToLatin('Agong'), ['agong']);
});

test('aspirated onsets are not split into final + h', () => {
  const s = parseWord('akha').map((x) => x.onset + x.nucleus + x.final);
  assert.deepEqual(s, ['a', 'kha']);
  assert.deepEqual(parseWord('apho').map((x) => x.onset), ['', 'ph']);
});
