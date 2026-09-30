// Word definitions from Wiktionary's public REST API (CORS-enabled, no key).
// Results are cached in localStorage so repeat lookups are instant and offline-safe.

const API = "https://en.wiktionary.org/api/rest_v1/page/definition/";
const CACHE_KEY = "wg.defs";
const CACHE_MAX = 400;

// Parts of speech that are never what a word-game player means.
const SKIP_POS = new Set(["Symbol", "Proper noun", "Abbreviation", "Letter", "Initialism", "Acronym", "Prefix", "Suffix"]);

// "plural of bet", "simple past of erode" … → the base word to look up next.
const FORM_OF = /^(?:.*?\b)?(plural|third-person singular|simple past|past participle|present participle|comparative|superlative|alternative (?:form|spelling)|obsolete (?:form|spelling)|archaic (?:form|spelling))(?: and past participle)?(?: simple present)?(?: indicative)? (?:form )?of ([a-z]+)/i;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
export function cleanHtml(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

// Pick the first real definition from a Wiktionary response.
// Returns { pos, text, baseOf? } or null.
export function parseEntry(json) {
  for (const entry of json?.en ?? []) {
    if (SKIP_POS.has(entry.partOfSpeech)) continue;
    for (const d of entry.definitions ?? []) {
      const text = cleanHtml(d.definition ?? "");
      if (!text || /^Used (?:as|a|in)\b/i.test(text) && text.length < 40) continue;
      const form = text.match(FORM_OF);
      return { pos: entry.partOfSpeech.toLowerCase(), text, baseOf: form ? form[2].toLowerCase() : null };
    }
  }
  return null;
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
}
function writeCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

async function lookup(word) {
  const res = await fetch(API + encodeURIComponent(word));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseEntry(await res.json());
}

// Returns { word, pos, text, base?: { word, pos, text } } or null if there's no entry.
// Throws if the lookup failed (offline, rate-limited), so the caller can say so.
export async function define(word) {
  const cache = readCache();
  if (word in cache) return cache[word];
  let result = null;
  const main = await lookup(word);
  if (main) {
    result = { word, pos: main.pos, text: main.text };
    // "plural of bet" is accurate but unhelpful on its own; add what BET means.
    if (main.baseOf && main.baseOf !== word) {
      const base = await lookup(main.baseOf).catch(() => null);
      if (base) result.base = { word: main.baseOf, pos: base.pos, text: base.text };
    }
  }
  cache[word] = result;
  writeCache(cache);
  return result;
}
