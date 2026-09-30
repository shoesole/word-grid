import assert from "node:assert/strict";
import { parseEntry, cleanHtml } from "../public/define.js";

assert.equal(cleanHtml('<a href="/wiki/x">Reverence</a> &amp; devotion&#39;s  <i>test</i>'), "Reverence & devotion's test");

// Skips symbol entries (ISO codes) and blank definitions.
const hae = { en: [
  { partOfSpeech: "Symbol", definitions: [{ definition: "ISO 639-3 language code for Harar Oromo." }] },
  { partOfSpeech: "Verb", definitions: [{ definition: "" }, { definition: "<i>(Scotland)</i> To have." }] },
] };
assert.deepEqual(parseEntry(hae), { pos: "verb", text: "(Scotland) To have.", baseOf: null });

// Inflections point at their base word.
const bets = { en: [{ partOfSpeech: "Noun", definitions: [{ definition: '<span class="form-of-definition">plural of <a href="/wiki/bet">bet</a></span>' }] }] };
assert.deepEqual(parseEntry(bets), { pos: "noun", text: "plural of bet", baseOf: "bet" });
const eroded = { en: [{ partOfSpeech: "Verb", definitions: [{ definition: "simple past and past participle of <a>erode</a>" }] }] };
assert.equal(parseEntry(eroded).baseOf, "erode");

// Nothing usable.
assert.equal(parseEntry({}), null);
assert.equal(parseEntry({ en: [{ partOfSpeech: "Symbol", definitions: [{ definition: "x" }] }] }), null);
console.log("define tests passed");
