import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, "user", "sticker-cache.json");
const MAX_ENTRIES = 1000;

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return { entries: {}, byKeyword: {} };
  }
}

function saveCache(cache) {
  const tmp = CACHE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, CACHE_FILE);
}

function evictIfNeeded(cache) {
  const urls = Object.keys(cache.entries);
  if (urls.length <= MAX_ENTRIES) return;

  // Evict lowest hitCount, then oldest cachedAt
  const sorted = urls
    .map((url) => ({ url, ...cache.entries[url] }))
    .sort((a, b) => a.hitCount - b.hitCount || a.cachedAt - b.cachedAt);

  const toRemove = sorted.slice(0, urls.length - MAX_ENTRIES);
  for (const entry of toRemove) {
    delete cache.entries[entry.url];
    if (entry.keyword && cache.byKeyword[entry.keyword] === entry.url) {
      delete cache.byKeyword[entry.keyword];
    }
  }
}

export function lookup(url, keyword) {
  const cache = loadCache();

  // Primary: look up by URL
  if (url && cache.entries[url]) {
    const entry = cache.entries[url];
    entry.hitCount = (entry.hitCount || 0) + 1;
    saveCache(cache);
    return entry.interpretation;
  }

  // Secondary: look up by keyword
  if (keyword && cache.byKeyword[keyword]) {
    const mappedUrl = cache.byKeyword[keyword];
    if (cache.entries[mappedUrl]) {
      const entry = cache.entries[mappedUrl];
      entry.hitCount = (entry.hitCount || 0) + 1;
      saveCache(cache);
      return entry.interpretation;
    }
  }

  return null;
}

export function store(url, interpretation, keyword) {
  const cache = loadCache();

  cache.entries[url] = {
    interpretation,
    keyword: keyword || "",
    cachedAt: Date.now(),
    hitCount: 0,
  };

  if (keyword) {
    cache.byKeyword[keyword] = url;
  }

  evictIfNeeded(cache);
  saveCache(cache);
}

export function list() {
  const cache = loadCache();
  return Object.entries(cache.entries).map(([url, entry]) => ({
    url,
    ...entry,
  }));
}

export function stats() {
  const cache = loadCache();
  const entries = Object.values(cache.entries);
  const totalHits = entries.reduce((sum, e) => sum + (e.hitCount || 0), 0);
  return {
    totalEntries: entries.length,
    totalKeywords: Object.keys(cache.byKeyword).length,
    totalHits,
    cacheFile: CACHE_FILE,
  };
}

export function clear() {
  saveCache({ entries: {}, byKeyword: {} });
}
