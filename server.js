'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Timestamped logging ─────────────────────────────────────────────────────
// Prefix every console.log / console.error line with HH:MM:SS so the HA log
// viewer and saved log files have human-readable times on every entry.
{
  const _log = console.log.bind(console);
  const _err = console.error.bind(console);
  const ts = () => {
    const d = new Date();
    return '[' + String(d.getHours()).padStart(2,'0') + ':'
               + String(d.getMinutes()).padStart(2,'0') + ':'
               + String(d.getSeconds()).padStart(2,'0') + ']';
  };
  console.log   = (...a) => _log(ts(), ...a);
  console.error = (...a) => _err(ts(), ...a);
}
// ─────────────────────────────────────────────────────────────────────────────

const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');

const VERSION = '1.8.1';
const PORT = Number(process.env.PORT || 8099);
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '/data';
const OPTIONS_PATH = process.env.OPTIONS_PATH || path.join(DATA_DIR, 'options.json');
const STATE_PATH = path.join(DATA_DIR, 'tf2hub-state.json');
const OFFERS_PATH = path.join(DATA_DIR, 'tf2hub-offers.jsonl');
const POLL_PATH = path.join(DATA_DIR, 'tf2hub-polldata.json');
const COSTS_PATH = path.join(DATA_DIR, 'tf2hub-costs.json');
const PENDING_PATH = path.join(DATA_DIR, 'tf2hub-pending.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readOptions() {
  try { return JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')); }
  catch { return {}; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { listings: [], listings_count: null, last_sync: null }; }
}

function writeState(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[tf2-hub] state write error:', err.message);
  }
}

function appendOffer(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(OFFERS_PATH, JSON.stringify(entry) + '\n');
  } catch {}
}

function readRecentOffers(n = 50) {
  try {
    const lines = fs.readFileSync(OFFERS_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => JSON.parse(l)).reverse();
  } catch { return []; }
}

function readCosts() {
  try { return JSON.parse(fs.readFileSync(COSTS_PATH, 'utf8')); }
  catch { return {}; }
}

function saveCosts(costs) {
  try { fs.writeFileSync(COSTS_PATH, JSON.stringify(costs)); } catch {}
}

function httpsGet(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'TF2-HA-Bot/' + VERSION, ...extraHeaders },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const preview = body.slice(0, 120).replace(/\s+/g, ' ');
          return reject(new Error('HTTP ' + res.statusCode + (preview ? ': ' + preview : '')));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('invalid JSON: ' + body.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpsPost(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'User-Agent': 'TF2-HA-Bot/' + VERSION,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(text)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

function httpsDelete(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'DELETE',
      headers: {
        'User-Agent': 'TF2-HA-Bot/' + VERSION,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
      },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// Fire-and-forget HA notification (uses Supervisor HTTP API inside the add-on)
function haNotify(title, message) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return;
  const body = JSON.stringify({ title, message });
  try {
    const req = http.request({
      hostname: 'supervisor',
      port: 80,
      path: '/core/api/services/notify/notify',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => res.resume());
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch {}
}

// ─── App State ──────────────────────────────────────────────────────────────

const appState = {
  steam_status: 'offline',
  steam_id: null,
  last_error: null,
  accepted_today: 0,
  declined_today: 0,
  listings_count: null,
  last_sync: null,
};

// ─── Concurrency Guard ──────────────────────────────────────────────────────
// Prevents overlapping Backpack.tf API operations from competing for the same
// rate-limit quota.  Sniping operations (snipeClassifieds, snipeBuyOrders) skip
// their cycle if a full sync is in progress.
let isSyncing = false;
let lastSyncCompletedAt = 0;
const MIN_SYNC_COOLDOWN_MS = 3 * 60 * 1000; // minimum 3 minutes between full syncs

async function guardedSync(fn, name) {
  if (isSyncing) {
    console.log(`[tf2-hub] ${name}: skipped — sync in progress`);
    return;
  }
  isSyncing = true;
  try {
    await fn();
  } finally {
    isSyncing = false;
  }
}

// Reset daily counters at midnight
function scheduleDailyReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    appState.accepted_today = 0;
    appState.declined_today = 0;
    scheduleDailyReset();
  }, midnight - now);
}

// ─── TF2 Schema (defindex ↔ item name) ───────────────────────────────────────

const SCHEMA_CACHE_PATH = path.join(DATA_DIR, 'tf2hub-schema.json');
const tf2NameToDefindex = new Map(); // 'Item Name' → defindex
const tf2DefindexToName = new Map(); // defindex → 'Item Name'
let tf2SchemaLoaded = false;
let tf2SchemaFetching = null; // Promise — prevents concurrent fetches

async function loadTf2Schema() {
  if (tf2SchemaLoaded) return;
  if (tf2SchemaFetching) return tf2SchemaFetching; // already in progress — wait for it
  tf2SchemaFetching = _loadTf2Schema().finally(() => { tf2SchemaFetching = null; });
  return tf2SchemaFetching;
}

async function _loadTf2Schema() {
  if (tf2SchemaLoaded) return;

  // Try disk cache first (only changes on TF2 updates)
  try {
    const cached = JSON.parse(fs.readFileSync(SCHEMA_CACHE_PATH, 'utf8'));
    if (Array.isArray(cached) && cached.length > 100) {
      for (const { defindex, item_name } of cached) {
        tf2NameToDefindex.set(item_name, defindex);
        tf2DefindexToName.set(defindex, item_name);
      }
      tf2SchemaLoaded = true;
      console.log('[tf2-hub] tf2 schema loaded from cache:', tf2NameToDefindex.size, 'items');
      return;
    }
  } catch {}

  // Fetch from Steam Web API (uses existing steam_api_key)
  const opts = readOptions();
  if (!opts.steam_api_key) { console.log('[tf2-hub] tf2 schema: no steam_api_key — skipped'); return; }

  console.log('[tf2-hub] tf2 schema: fetching from Steam...');
  const allItems = [];
  let start = 0;
  try {
    while (true) {
      const data = await httpsGet(
        'https://api.steampowered.com/IEconItems_440/GetSchemaItems/v0001/?key='
        + encodeURIComponent(opts.steam_api_key) + '&language=en&start=' + start
      );
      const items = data.result?.items || [];
      for (const item of items) {
        if (item.item_name == null || item.defindex == null) continue;
        tf2NameToDefindex.set(item.item_name, item.defindex);
        tf2DefindexToName.set(item.defindex, item.item_name);
        allItems.push({ defindex: item.defindex, item_name: item.item_name });
      }
      const next = data.result?.next;
      if (!next) break;
      start = next;
      await sleep(400);
    }
    tf2SchemaLoaded = true;
    console.log('[tf2-hub] tf2 schema fetched:', tf2NameToDefindex.size, 'items');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SCHEMA_CACHE_PATH, JSON.stringify(allItems));
  } catch (err) {
    console.error('[tf2-hub] tf2 schema fetch error:', err.message);
  }
}

// ─── PriceDB.IO ───────────────────────────────────────────────────────────────
// Free, no auth required. Covers MvM parts, cases, war paints, and any other
// item not in backpack.tf IGetPrices. Rate limit: 360 req/min.

const priceDbCache = new Map(); // sku → { sell, buy, ts }
const PRICEDB_TTL = 30 * 60 * 1000;

function itemNameToSku(name, quality = 6) {
  const defindex = tf2NameToDefindex.get(name);
  if (defindex == null) return null;
  return defindex + ';' + quality;
}

async function getPriceDb(name, quality = 6) {
  await loadTf2Schema();
  const sku = itemNameToSku(name, quality);
  if (!sku) return null;

  const cached = priceDbCache.get(sku);
  if (cached && Date.now() - cached.ts < PRICEDB_TTL) return cached;

  try {
    const data = await httpsGet('https://pricedb.io/api/item/' + encodeURIComponent(sku));
    const sell = (data.sell?.keys || 0) * keyPriceRef + (data.sell?.metal || 0);
    const buy  = (data.buy?.keys  || 0) * keyPriceRef + (data.buy?.metal  || 0);
    if (!sell && !buy) return null;
    const entry = { sell, buy, ts: Date.now() };
    priceDbCache.set(sku, entry);
    return entry;
  } catch { return null; }
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

let keyPriceRef = 65;
let keyPriceUsd = null;

// backpack.tf IGetPrices bulk list (requires backpack_tf_api_key)
// Each entry: { buy, sell, lastUpdate }
let bpPriceList = null;
let bpPriceListTs = 0;
const BP_PRICE_TTL = 60 * 60 * 1000;

// Auto-selected liquid items (populated when buy_items config is empty)
let autoLiquidItems = [];
let autoLiquidTs = 0;
const AUTO_LIQUID_TTL = 6 * 60 * 60 * 1000; // recompute every 6h

async function loadBpPriceList() {
  const opts = readOptions();
  if (!opts.backpack_tf_api_key) return false;
  if (bpPriceList && Date.now() - bpPriceListTs < BP_PRICE_TTL) return true;

  try {
    const data = await httpsGet(
      'https://api.backpack.tf/api/IGetPrices/v4?key=' + encodeURIComponent(opts.backpack_tf_api_key)
    );
    if (!data.response || data.response.success !== 1) return false;

    bpPriceList = new Map();

    const toRef = (val, cur) =>
      cur === 'keys' ? val * keyPriceRef : cur === 'metal' ? val : null;
    const addEntry = (key, entry) => {
      if (!entry) return;
      const buy  = toRef(entry.value, entry.currency);
      const sell = toRef(entry.value_high ?? entry.value, entry.currency);
      if (buy !== null && sell !== null)
        bpPriceList.set(key, { buy, sell, lastUpdate: entry.last_update || 0 });
    };

    for (const [name, item] of Object.entries(data.response.items || {})) {
      const q6c  = item.prices?.['6']?.Tradable?.Craftable?.['[0]']
                || item.prices?.['6']?.Tradable?.Craftable?.[0];
      const q6nc = item.prices?.['6']?.Tradable?.['Non-Craftable']?.['[0]']
                || item.prices?.['6']?.Tradable?.['Non-Craftable']?.[0];
      const q11c = item.prices?.['11']?.Tradable?.Craftable?.['[0]']
                || item.prices?.['11']?.Tradable?.Craftable?.[0];

      addEntry(name,                q6c);   // Unique craftable  (existing key)
      addEntry(name + ';nc',        q6nc);  // Unique non-craftable
      addEntry(name + ';strange',   q11c);  // Strange craftable
    }

    bpPriceListTs = Date.now();
    console.log('[tf2-hub] bp price list loaded:', bpPriceList.size, 'items');

    const keyEntry = bpPriceList.get('Mann Co. Supply Crate Key');
    if (keyEntry) { keyPriceRef = keyEntry.sell; console.log('[tf2-hub] key price:', keyPriceRef.toFixed(2), 'ref (backpack.tf)'); }

    // Invalidate liquid item cache so it recomputes with fresh prices
    autoLiquidTs = 0;
    return true;
  } catch (err) {
    console.error('[tf2-hub] bp price list error:', err.message);
    return false;
  }
}

// Score and pick the most liquid items to auto-buy.
// Liquidity proxy: many classifieds buyers + good ROI spread.
async function computeLiquidItems() {
  if (!bpPriceList) return [];
  if (Date.now() - autoLiquidTs < AUTO_LIQUID_TTL && autoLiquidItems.length) return autoLiquidItems;

  const opts = readOptions();
  const token = opts.backpack_tf_token; // classifieds search requires user token, not api key
  if (!token) return [];

  const minProfit = Number(opts.min_profit_ref ?? 0.11);
  const ninetyDaysAgo = Date.now() / 1000 - 90 * 86400;
  const skipNames = new Set([...CURRENCY_NAMES, 'Mann Co. Supply Crate Key']);

  // Step 1: pre-filter by spread — O(n) over price list
  const candidates = [];
  for (const [name, p] of bpPriceList.entries()) {
    if (name.includes(';')) continue; // skip ;strange / ;nc variant keys — not real item names
    if (skipNames.has(name)) continue;
    // Skip only if lastUpdate is set AND very old (0 = unknown = allow)
    if (p.lastUpdate > 0 && p.lastUpdate < ninetyDaysAgo) continue;
    const spread = p.sell - p.buy;
    if (spread < minProfit) continue;                  // not enough margin
    if (p.buy < 0.11 || p.buy > keyPriceRef * 5) continue; // too cheap or way too expensive
    const roi = spread / p.buy;
    candidates.push({ name, buy: p.buy, sell: p.sell, spread, roi });
  }
  console.log('[tf2-hub] auto-liquid: ' + candidates.length + ' candidates after spread filter');

  // Step 2: rank by score = spread × (1/buy) × (1/buy) — high ROI on cheap items wins
  // Cheaper items have more buyers and are easier to flip
  candidates.sort((a, b) => {
    const scoreA = a.spread * a.roi * (1 / Math.log(a.buy + 2));
    const scoreB = b.spread * b.roi * (1 / Math.log(b.buy + 2));
    return scoreB - scoreA;
  });

  const maxBuy = 50; // cap auto-liquid list to avoid pre-warm 429s
  autoLiquidItems = candidates.slice(0, maxBuy).map(c => c.name);
  autoLiquidTs = Date.now();

  if (autoLiquidItems.length) {
    console.log('[tf2-hub] auto-liquid items (' + autoLiquidItems.length + '): ' + autoLiquidItems.join(', '));
  } else {
    console.log('[tf2-hub] auto-liquid: no suitable items found');
  }
  return autoLiquidItems;
}

// Classifieds real-market price cache — populated by getCheapestSellRef, checked first by getRefPrice
const classifiedsSellCache = new Map(); // name -> { ref, ts }
const CLASSIFIEDS_PRICE_TTL = 10 * 60 * 1000;

// Steam Community Market fallback (free, no auth)
const priceCache = new Map(); // name -> { usd, ts }
const PRICE_TTL = 10 * 60 * 1000;
let lastPriceFetch = 0;
const PRICE_FETCH_DELAY = 3500;

async function getSteamMarketPrice(name) {
  const cached = priceCache.get(name);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.usd;

  const wait = PRICE_FETCH_DELAY - (Date.now() - lastPriceFetch);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastPriceFetch = Date.now();

  try {
    const data = await httpsGet(
      'https://steamcommunity.com/market/priceoverview/?appid=440&currency=1&market_hash_name='
      + encodeURIComponent(name)
    );
    if (!data.success) return null;
    const priceStr = data.median_price || data.lowest_price;
    if (!priceStr) return null;
    const usd = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
    if (!usd || isNaN(usd)) return null;
    priceCache.set(name, { usd, ts: Date.now() });
    return usd;
  } catch (err) {
    console.error('[tf2-hub] market price error (' + name + '):', err.message);
    return null;
  }
}

// Parse price_overrides — supports two formats:
//   list of strings (HA UI): ["Item Name=1.11", "Other Item=9.5"]
//   legacy plain string:     "Item Name=1.11, Other Item=9.5"
// Each entry format: "Item Name=<ref price>"
function parsePriceOverrides(raw) {
  const out = {};
  if (!raw) return out;
  // Normalise: list of strings → single comma-joined string → split on commas
  const lines = Array.isArray(raw) ? raw : String(raw).split(',');
  for (const part of lines) {
    const s = String(part).trim();
    const eq = s.lastIndexOf('=');
    if (eq < 0) continue;
    const name = s.slice(0, eq).trim();
    const price = parseFloat(s.slice(eq + 1).trim());
    if (name && !isNaN(price) && price >= 0) out[name] = price;
  }
  return out;
}

// Build the Steam Market hash name for an item, appending the wear condition
// (Exterior tag) when present.  e.g. "Simple Spirits Reserve Shooter (Field-Tested)"
// For war paints and normal items there is no Exterior tag, so name is returned as-is.
function itemMarketHashName(item) {
  if (!item || !Array.isArray(item.tags)) return item ? item.name : '';
  const ext = item.tags.find(t => t.category === 'Exterior');
  const wear = ext && (ext.localized_tag_name || ext.name);
  return wear ? `${item.name} (${wear})` : item.name;
}

// name      — canonical item name (used for all internal caches / classifieds)
// marketName — Steam Market hash name (may include wear; defaults to name)
async function getRefPrice(name, marketName = name) {
  switch (name) {
    case 'Mann Co. Supply Crate Key': return keyPriceRef;
    case 'Refined Metal':             return 1;
    case 'Reclaimed Metal':           return 1 / 3;
    case 'Scrap Metal':               return 1 / 9;
  }
  // Manual price overrides take highest priority
  // UI price overrides (set via dashboard) take highest priority
  const uiOverrides = (readState().ui_price_overrides) || {};
  if (uiOverrides[name] !== undefined) return uiOverrides[name];
  // HA config price overrides (fallback)
  const overrides = parsePriceOverrides(readOptions().price_overrides);
  if (overrides[name] !== undefined) return overrides[name];
  // Real classifieds price (most accurate — reflects actual buy/sell spread)
  const cachedClassifieds = classifiedsSellCache.get(name);
  if (cachedClassifieds && Date.now() - cachedClassifieds.ts < CLASSIFIEDS_PRICE_TTL)
    return cachedClassifieds.ref;
  // backpack.tf IGetPrices fallback (community price, can lag actual market)
  if (await loadBpPriceList() && bpPriceList.has(name)) return bpPriceList.get(name).sell;
  // PriceDB.IO fallback — covers items missing from IGetPrices (MvM parts, cases, war paints…)
  const pdb = await getPriceDb(name);
  if (pdb && pdb.sell > 0) { console.log('[tf2-hub] pricedb price for ' + name + ': ' + pdb.sell.toFixed(2) + ' ref'); return pdb.sell; }
  // Steam Market fallback — use marketName (includes wear for decorated weapons)
  const usd = await getSteamMarketPrice(marketName);
  if (usd === null) return null;
  // keyPriceUsd may be null when IGetPrices loaded the key price — fetch it lazily
  if (!keyPriceUsd) {
    keyPriceUsd = await getSteamMarketPrice('Mann Co. Supply Crate Key');
    if (!keyPriceUsd) return null;
  }
  return (usd / keyPriceUsd) * keyPriceRef;
}

// For BUY ceiling decisions — outlier-resistant market price.
//
// Two failure modes we've seen:
//   cheapest sell only → one lowball bot tanks ceiling (Mann of Seven Sees: 3.34k vs market 5k)
//   IGetPrices only    → stale when market drops (Mourning Mercs: said 2.5k, real 1.54k)
//
// Solution: if cheapestSell < highestBuy it's physically impossible (someone selling below
// what buyers will pay) → that listing is an outlier → skip it, use 2nd cheapest.
// Otherwise use cheapestSell (accurate live data, prevents overpaying from stale IGetPrices).
//
// highestBuy must be fetched BEFORE calling this so classifiedsBuyCache is populated.
async function getBuyMarketRef(name) {
  switch (name) {
    case 'Mann Co. Supply Crate Key': return keyPriceRef;
    case 'Refined Metal':             return 1;
    case 'Reclaimed Metal':           return 1 / 3;
    case 'Scrap Metal':               return 1 / 9;
  }
  const overrides = parsePriceOverrides(readOptions().price_overrides);
  if (overrides[name] !== undefined) return overrides[name];

  const now = Date.now();
  const c1 = classifiedsSellCache.get(name);
  const c2 = classifiedsSellCacheSecond.get(name);
  const cb = classifiedsBuyCache.get(name);
  const cheapSell   = c1 && now - c1.ts < CLASSIFIEDS_PRICE_TTL ? c1.ref : null;
  const secondSell  = c2 && now - c2.ts < CLASSIFIEDS_PRICE_TTL ? c2.ref : null;
  const highestBuy  = cb && now - cb.ts < CLASSIFIEDS_PRICE_TTL ? cb.ref : null;

  // Outlier detection: if cheapest sell < highest buy, that listing is anomalous.
  // (Selling below what buyers are willing to pay is impossible in a sane market.)
  if (cheapSell !== null && highestBuy !== null && cheapSell < highestBuy) {
    const ref = secondSell ?? highestBuy * 1.05; // 2nd listing, or estimate sell from buy
    console.log('[tf2-hub] price-outlier ' + name + ': sell=' + cheapSell.toFixed(2) + ' < buy=' + highestBuy.toFixed(2) + ' → using ' + ref.toFixed(2) + ' ref');
    return ref;
  }
  if (cheapSell !== null) return cheapSell; // normal market, trust the live data
  if (secondSell !== null) return secondSell;

  // No cheapSell cached yet. If we have the highest buy price, use it as a proxy.
  // Using IGetPrices here is dangerous — it can be stale and cause us to post a
  // buy listing ABOVE what sellers are currently asking (instant loss).
  // highBuy is always <= what sellers ask, so maxBuyRef = highBuy - spread is safe.
  if (highestBuy !== null) return highestBuy;

  // Absolute last resort: IGetPrices. Only reached if we have zero live data at all.
  if (bpPriceList && bpPriceList.has(name)) return bpPriceList.get(name).sell;
  return getRefPrice(name);
}

// ─── Market Snapshot (v1.7 conservative pricing) ─────────────────────────────
//
// Single source of truth that fuses every available data point into a confidence-rated
// view of an item's market. All trade decisions consult this — the legacy getRefPrice /
// getBuyMarketRef are kept as thin compatibility shims.
//
// Snapshot fields:
//   truth        — best estimate of the current market SELL price (use for valuing items)
//   buyCeiling   — maximum we'd ever pay before applying minProfit (min of multiple anchors)
//   confidence   — 'high' | 'medium' | 'low' | 'untrusted'
//   sells        — array of sell-side prices (ascending)
//   buyers       — count of distinct competing buyers (demand signal)
//   cheapestSell, median, highestBuy, bpSell, outlier — raw inputs for logging
//
// Confidence rules (conservative — when in doubt, downgrade):
//   high       3+ samples, no outlier, median agrees with IGetPrices within 15%
//   medium     2-3 samples, no outlier, modest disagreement (15-30%)
//   low        only 1 sample, or 30-60% disagreement, or IGetPrices-only fallback
//   untrusted  cheapSell<highBuy outlier with no recovery, OR sources disagree >60%
//              → NEVER buy or accept offers for untrusted items
const marketSnapshotCache = new Map(); // name -> { snap, ts }
const MARKET_SNAPSHOT_TTL = 15 * 60 * 1000;

async function fetchSellListings(name, apiKey, count = 5) {
  // No quality or craftable filter — cases are non-craftable, decorated weapons are
  // quality 15, war paints vary.  Removing the filter finds all of them.
  // The median of top-5 results is robust enough to handle mixed-quality listings.
  // NOTE: classifieds/search uses key= (API key), NOT token= (user token).
  //       token= is only for listing management (create/delete).
  try {
    const data = await httpsGet(
      'https://api.backpack.tf/api/classifieds/search/v1?key='
      + encodeURIComponent(apiKey)
      + '&item=' + encodeURIComponent(name)
      + '&intent=sell&tradable=1&page_size=' + count
    );
    const listings = (data.sell?.listings || []).filter(
      l => !appState.steam_id || String(l.steamid) !== String(appState.steam_id)
    );
    const toRef = l => (l.price?.keys || 0) * keyPriceRef + (l.price?.metal || 0);
    return listings.map(toRef).filter(r => r > 0).sort((a, b) => a - b);
  } catch { return []; }
}

async function fetchBuyListings(name, apiKey, count = 5) {
  try {
    const data = await httpsGet(
      'https://api.backpack.tf/api/classifieds/search/v1?key='
      + encodeURIComponent(apiKey)
      + '&item=' + encodeURIComponent(name)
      + '&intent=buy&tradable=1&craftable=1&quality=6&page_size=' + count
    );
    const listings = (data.buy?.listings || []).filter(
      l => !appState.steam_id || String(l.steamid) !== String(appState.steam_id)
    );
    const toRef = l => (l.price?.keys || 0) * keyPriceRef + (l.price?.metal || 0);
    return listings.map(toRef).filter(r => r > 0).sort((a, b) => b - a); // desc
  } catch { return []; }
}

function builtinSnapshot(ref) {
  return { truth: ref, buyCeiling: ref, confidence: 'high', sells: [ref], buyers: 99, bpSell: ref, cheapestSell: ref, median: ref, highestBuy: ref, outlier: false };
}

async function getMarketSnapshot(name, apiKey) {
  // Built-in currencies
  switch (name) {
    case 'Mann Co. Supply Crate Key': return builtinSnapshot(keyPriceRef);
    case 'Refined Metal':             return builtinSnapshot(1);
    case 'Reclaimed Metal':           return builtinSnapshot(1 / 3);
    case 'Scrap Metal':               return builtinSnapshot(1 / 9);
  }

  // Manual override = trusted
  const overrides = parsePriceOverrides(readOptions().price_overrides);
  if (overrides[name] !== undefined) {
    const snap = builtinSnapshot(overrides[name]);
    snap.overridden = true;
    return snap;
  }

  // Cache hit
  const cached = marketSnapshotCache.get(name);
  if (cached && Date.now() - cached.ts < MARKET_SNAPSHOT_TTL) return cached.snap;

  // No API key → IGetPrices only (still 'medium' — it IS our primary source now)
  const bpEntry = bpPriceList && bpPriceList.get(name);
  const bpSell = bpEntry ? bpEntry.sell : null;
  if (!apiKey) {
    if (bpSell === null) return null;
    return { truth: bpSell, buyCeiling: bpSell * 0.85, confidence: 'medium', sells: [bpSell], buyers: 0, bpSell, cheapestSell: null, median: bpSell, highestBuy: null, outlier: false };
  }

  // Fetch live classifieds (both sides), populate legacy caches as a side-effect
  // classifieds/search uses key= (API key), not token= (user token)
  await sleep(300);
  const sells = await fetchSellListings(name, apiKey, 5);
  await sleep(300);
  const buyers = await fetchBuyListings(name, apiKey, 5);

  if (sells.length > 0) {
    classifiedsSellCache.set(name, { ref: sells[0], ts: Date.now() });
    if (sells.length > 1) classifiedsSellCacheSecond.set(name, { ref: sells[1], ts: Date.now() });
  }
  if (buyers.length > 0) classifiedsBuyCache.set(name, { ref: buyers[0], ts: Date.now() });

  const cheapestSell = sells[0] ?? null;
  const highestBuy = buyers[0] ?? null;
  const median = sells.length ? sells[Math.floor(sells.length / 2)] : null;
  const samples = sells.length;

  // Outlier: cheapest sell below highest buy is physically impossible
  const outlier = cheapestSell !== null && highestBuy !== null && cheapestSell < highestBuy;

  // ── Estimate the real market sell price ("truth") ──
  // Priority (matches tf2-express approach):
  //   1. IGetPrices community consensus  ← primary source of truth
  //   2. Classifieds median              ← fallback if not in IGetPrices
  //   3. Highest buy × 1.05             ← last resort estimate
  // Classifieds data is still fetched — it drives undercut pricing in the SELL loop
  // (cheapestSell) and buy-ceiling anchors, but is NOT the price we trust for value.
  let truth;
  if (bpSell !== null) {
    truth = bpSell;                              // community price wins
  } else if (!outlier && median !== null) {
    truth = median;                              // classifieds median fallback
  } else if (sells[1] !== undefined) {
    truth = sells[1];                            // outlier: skip the lowest outlier
  } else if (highestBuy !== null) {
    truth = highestBuy * 1.05;
  } else {
    return null;                                 // no data anywhere
  }

  // ── Score confidence ──
  // When IGetPrices price exists it is the community-consensus → at least 'medium'.
  // Cross-check with classifieds to upgrade or downgrade.
  const pctDiff = (a, b) => Math.max(a, b) / Math.min(a, b);
  let confidence;
  if (bpSell !== null) {
    if (cheapestSell !== null && !outlier) {
      const r = pctDiff(bpSell, cheapestSell);
      if (r < 1.30) confidence = 'high';    // classifieds agrees with community price
      else if (r < 1.60) confidence = 'medium';
      else confidence = 'low';              // big divergence — stale IGetPrices?
    } else {
      confidence = 'medium';               // community price only, no classifieds
    }
  } else if (samples >= 3) {
    confidence = outlier ? 'low' : 'medium';
  } else if (samples === 2) {
    confidence = pctDiff(sells[0], sells[1]) < 1.30 ? 'medium' : 'low';
  } else if (samples === 1) {
    confidence = 'low';
  } else if (highestBuy !== null) {
    confidence = 'low';
  } else {
    confidence = 'low';
  }

  // Physically impossible market: cheapest sell < highest buy with no backup → untrusted
  if (outlier && samples < 3 && bpSell === null) confidence = 'untrusted';

  // ── Conservative buy ceiling (min of every available anchor) ──
  // Each anchor represents an upper bound the bot should never cross.
  const anchors = [];
  if (cheapestSell !== null && !outlier) anchors.push(cheapestSell - 0.11);  // undercut market
  if (median !== null)                  anchors.push(median - 0.11);          // safer vs lowballers
  if (highestBuy !== null)              anchors.push(highestBuy + 0.11);      // outbid current buyers by 1 scrap
  if (bpSell !== null)                  anchors.push(bpSell * 0.95);          // 5% safety buffer below IGetPrices
  // truth anchor: buy ceiling can never exceed the expected sell price itself.
  // This prevents the buy loop listing a price where truth - buyRef < minProfit
  // (e.g. highestBuy anchor alone inflates ceiling above truth).
  if (truth !== null)                   anchors.push(truth);
  const buyCeiling = anchors.length ? Math.min(...anchors) : 0;

  const snap = { truth, buyCeiling, confidence, sells, buyers: buyers.length, bpSell, cheapestSell, median, highestBuy, outlier };
  marketSnapshotCache.set(name, { snap, ts: Date.now() });

  if (confidence === 'untrusted') {
    console.log('[tf2-hub] market-untrusted ' + name + ': cheap=' + (cheapestSell?.toFixed(2) ?? '—') + ' med=' + (median?.toFixed(2) ?? '—') + ' bp=' + (bpSell?.toFixed(2) ?? '—') + ' highBuy=' + (highestBuy?.toFixed(2) ?? '—') + (outlier ? ' OUTLIER' : ''));
  }
  return snap;
}

async function fetchKeyPrice() {
  if (await loadBpPriceList()) return; // key price set inside loadBpPriceList
  const usd = await getSteamMarketPrice('Mann Co. Supply Crate Key');
  if (usd) {
    keyPriceUsd = usd;
    console.log('[tf2-hub] key price: $' + usd.toFixed(2) + ' USD (Steam Market, ~' + keyPriceRef + ' ref)');
  } else {
    console.log('[tf2-hub] key price: using default', keyPriceRef, 'ref');
  }
}

// ─── Scammer Check ───────────────────────────────────────────────────────────

// Cache ban lookups for 1h so we don't hammer the API on busy bots.
const banCache = new Map(); // steamid64 -> { banned, ts }
const BAN_CACHE_TTL = 60 * 60 * 1000;

async function isScammer(steamid64) {
  const cached = banCache.get(steamid64);
  if (cached && Date.now() - cached.ts < BAN_CACHE_TTL) return cached.banned;

  const opts = readOptions();
  const apiKey = opts.backpack_tf_api_key;
  if (!apiKey) return false; // need API key to check — fail open

  try {
    const data = await httpsGet(
      'https://api.backpack.tf/api/users/info/v1?steamids=' + encodeURIComponent(steamid64)
      + '&key=' + encodeURIComponent(apiKey)
    );
    const user = (data.users || {})[steamid64];
    const bans = (user || {}).bans || {};
    const banned = !!(bans.steamrep_scammer || bans.bp_ban || bans.bp_banned);
    banCache.set(steamid64, { banned, ts: Date.now() });
    if (banned) console.log('[tf2-hub] scammer detected:', steamid64, JSON.stringify(bans));
    return banned;
  } catch (err) {
    console.error('[tf2-hub] scammer check error:', err.message);
    return false; // fail open — never block trades because the check API is down
  }
}

// ─── Dynamic Profit ───────────────────────────────────────────────────────────

// Returns the effective minimum profit for a trade of the given market value.
// When dynamic_profit_pct > 0, scales min profit as a % of item value so that
// expensive items earn proportionally more margin than cheap ones.
function effectiveMinProfit(marketRef, baseMinProfit, dynamicPct) {
  if (!dynamicPct || !marketRef) return baseMinProfit;
  return Math.max(baseMinProfit, +(marketRef * dynamicPct / 100).toFixed(4));
}

// ─── TF2 Item Helpers ─────────────────────────────────────────────────────────

// TF2 currency resolution is 1 scrap = 1/9 ref.  Round prices to the nearest
// scrap to avoid IEEE-754 float drift (0.11+0.11+0.11 !== 0.33 in JavaScript).
function snapToScrap(ref) { return Math.round(ref * 9) / 9; }

// TF2 weapons are worth 0.05 ref each (half a scrap, their crafting value).
// Identified by item tags: slot type primary/secondary/melee/pda/building.
const WEAPON_SLOTS = new Set(['primary', 'secondary', 'melee', 'pda', 'pda2', 'building']);
const COSMETIC_SLOTS = new Set(['head', 'misc']); // hat + accessory slot tags
const WEAPON_REF = 1 / 18; // ~0.0556 ref ≈ 0.05 ref
const NC_PENALTY = 1 / 9;  // Non-craftable items trade for ~1 scrap less than craftable

function isWeapon(item) {
  if (!Array.isArray(item.tags)) return false;
  // Decorated Weapon skins (quality 15) share the same Type tags as stock weapons
  // but have real market value — exclude them so they go through normal pricing.
  if (item.quality === 15) return false;
  // Also catch via tags: decorated weapons carry an exterior (wear) tag
  const hasWear = item.tags.some(t => t.category === 'Exterior');
  if (hasWear) return false;
  return item.tags.some(t =>
    t.category === 'Type' &&
    WEAPON_SLOTS.has((t.internal_name || '').toLowerCase())
  );
}

// Non-craftable items have a description "( Not Usable in Crafting )"
function isNonCraftable(item) {
  if (!Array.isArray(item.descriptions)) return false;
  return item.descriptions.some(d => /not.*usable.*in.*crafting/i.test(String(d.value || '')));
}

// Craft hats: Unique (quality 6) craftable cosmetics that all trade at the same
// bulk "craft hat" price.  Excludes Halloween-restricted items, weapons, taunts, tools.
// tf2-express uses the special SKU "-100;6" for the same concept.
function isCraftHat(item) {
  if ((item.quality || 6) !== 6) return false;     // Unique quality only
  if (isNonCraftable(item)) return false;           // Must be craftable
  if (!Array.isArray(item.tags)) return false;
  // Must have a cosmetic slot tag (head = headgear, misc = accessory)
  if (!item.tags.some(t => t.category === 'Type' &&
      COSMETIC_SLOTS.has((t.internal_name || '').toLowerCase()))) return false;
  // Exclude holiday-restricted items (Halloween hats can't trade year-round)
  if (item.tags.some(t => t.category === 'Holiday')) return false;
  return true;
}

// Quality-aware IGetPrices lookup.  Returns the bpPriceList entry for the item
// taking quality (Strange = 11) and craftability into account.
function getBpEntry(item) {
  if (!bpPriceList) return null;
  const q  = item.quality || 6;
  const nc = isNonCraftable(item);
  if (q === 11) return bpPriceList.get(item.name + ';strange') || bpPriceList.get(item.name) || null;
  if (nc)       return bpPriceList.get(item.name + ';nc')      || bpPriceList.get(item.name) || null;
  return bpPriceList.get(item.name) || null;
}

async function priceItems(items, label, costs = {}) {
  const opts = readOptions();
  const craftHatPrice = Number(opts.craft_hat_price ?? 1.33);
  let total = 0;
  const unknown = [];
  for (const item of items) {
    let ref = null;
    switch (item.name) {
      case 'Mann Co. Supply Crate Key': ref = keyPriceRef; break;
      case 'Refined Metal':             ref = 1; break;
      case 'Reclaimed Metal':           ref = 1 / 3; break;
      case 'Scrap Metal':               ref = 1 / 9; break;
      default: {
        // 1. Quality-aware IGetPrices lookup (Strange, NC variants)
        const bpE = getBpEntry(item);
        if (bpE) {
          if (label === 'give') {
            // Bot is SELLING this item: value at acquisition cost (what we paid).
            // Fall back to community buy price if no stored cost.
            const storedCost = costs[item.assetid] || 0;
            ref = storedCost > 0 ? storedCost : bpE.buy;
          } else {
            // Bot is RECEIVING this item (buying it): value at community SELL price
            // (what we can resell it for), not buy price. This makes evaluateOffer
            // consistent with buy-loop logic which targets bpE.sell as profit base.
            ref = bpE.sell;
          }
        } else if (isCraftHat(item) && craftHatPrice > 0) {
          // 2. Generic craft hat price (all craft hats trade at same bulk price)
          ref = craftHatPrice;
        } else {
          // 3. Classifieds / Steam Market fallback
          ref = await getBuyMarketRef(item.name);
          if (ref === null && isWeapon(item)) ref = WEAPON_REF;
        }
        // NC penalty: if no dedicated NC entry existed in IGetPrices (getBpEntry
        // fell back to craftable price), deduct 1 scrap manually.
        const hadDedicatedNcEntry = isNonCraftable(item) &&
          bpPriceList && bpPriceList.has(item.name + ';nc');
        if (ref !== null && ref > NC_PENALTY && isNonCraftable(item) && !hadDedicatedNcEntry) {
          ref = snapToScrap(ref - NC_PENALTY);
        }
        // Weapon floor: some stock weapons (e.g. Baby Face's Blaster, Atomizer) have
        // an IGetPrices craftable price ≈ 0.11 ref. When NC, the penalty drops them to
        // ~0 — but ref stays non-null so they don't go to unknown, they just get priced
        // at 0. Apply WEAPON_REF (≈0.06) as hard floor for any weapon below it.
        if (ref !== null && ref < WEAPON_REF && isWeapon(item)) ref = WEAPON_REF;
        // Same zero-floor for all items: if NC penalty zeroed out the price entirely,
        // treat as unpriced rather than valuing at 0 (which would corrupt totals).
        if (ref !== null && ref <= 0) ref = null;
        break;
      }
    }
    if (ref !== null) {
      total += ref * (item.amount || 1);
      if (label) console.log('[tf2-hub] price-item [' + label + '] ' + item.name + ': ' + ref.toFixed(4) + ' ref');
    } else {
      unknown.push(item.name);
      if (label) console.log('[tf2-hub] price-item [' + label + '] ' + item.name + ': NO PRICE');
    }
  }
  return { total, unknown };
}

// ─── Steam ───────────────────────────────────────────────────────────────────

const client = new SteamUser();
const community = new SteamCommunity();
const manager = new TradeOfferManager({
  steam: client,
  community: community,
  language: 'en',
  pollInterval: 30000,
});

// Restore poll data so we don't re-process old offers after restart
try { manager.pollData = JSON.parse(fs.readFileSync(POLL_PATH, 'utf8')); } catch {}
manager.on('pollData', data => {
  try { fs.writeFileSync(POLL_PATH, JSON.stringify(data)); } catch {}
});

function login() {
  const opts = readOptions();
  if (!opts.steam_username || !opts.steam_password) {
    appState.last_error = 'steam_username / steam_password not configured';
    console.error('[tf2-hub]', appState.last_error);
    return;
  }
  const loginData = { accountName: opts.steam_username, password: opts.steam_password };
  if (opts.steam_shared_secret) {
    loginData.twoFactorCode = SteamTotp.generateAuthCode(opts.steam_shared_secret);
  }
  appState.steam_status = 'connecting';
  appState.last_error = null;
  console.log('[tf2-hub] logging in as', opts.steam_username);
  client.logOn(loginData);
}

client.on('loggedOn', () => {
  appState.steam_status = 'online';
  appState.steam_id = client.steamID.getSteamID64();
  client.setPersona(SteamUser.EPersonaState.Online);
  client.gamesPlayed(440); // appear as In-Game: Team Fortress 2
  console.log('[tf2-hub] Steam login OK — steamid64:', appState.steam_id);
});

let confirmationCheckerStarted = false;
client.on('webSession', (sessionID, cookies) => {
  community.setCookies(cookies);
  manager.setCookies(cookies, err => {
    if (err) { console.error('[tf2-hub] manager cookies error:', err.message); return; }
    const opts = readOptions();
    // webSession can re-fire on Steam reconnect; only start the confirmation
    // checker once to avoid stacking intervals (resource leak).
    if (opts.steam_identity_secret && !confirmationCheckerStarted) {
      community.startConfirmationChecker(10000, opts.steam_identity_secret);
      confirmationCheckerStarted = true;
      console.log('[tf2-hub] auto-confirmation active');
    }
    console.log('[tf2-hub] trade manager ready');
    syncInventoryListings().catch(e => console.error('[tf2-hub] init listings error:', e.message));
  });
});

client.on('error', err => {
  appState.steam_status = 'error';
  appState.last_error = err.message;
  console.error('[tf2-hub] Steam error:', err.message);
  setTimeout(login, 60000);
});

client.on('disconnected', (eresult, msg) => {
  appState.steam_status = 'offline';
  console.log('[tf2-hub] Steam disconnected:', msg || eresult);
});

// Auto-accept friend requests and greet them
client.on('friendRelationship', (steamID, relationship) => {
  if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
    client.addFriend(steamID);
    client.chatMessage(steamID, 'Hey! I\'m a TF2 trading bot. Type !help to see what I can do.');
    console.log('[tf2-hub] friend accepted:', steamID.getSteamID64());
  }
});

// ─── Steam Chat Commands ─────────────────────────────────────────────────────

// Resolve a user-typed item name to the canonical name used in IGetPrices.
// Handles: underscores → spaces, series suffixes (#119), case, partial words.
// Returns the best matching canonical name, or the normalised query if no match.
function resolveItemName(query) {
  if (!query) return '';
  // Normalise: underscores → spaces, collapse whitespace, strip trailing #NNN
  let q = query.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s+#\d+$/, '');

  if (bpPriceList) {
    const qLow = q.toLowerCase();

    // 1. Exact case-insensitive match
    for (const key of bpPriceList.keys()) {
      if (key.includes(';')) continue; // skip ;strange / ;nc variants
      if (key.toLowerCase() === qLow) return key;
    }

    // 2. All-words partial match (every word in the query appears in the item name)
    const words = qLow.split(/\s+/).filter(w => w.length > 1);
    const matches = [];
    for (const key of bpPriceList.keys()) {
      if (key.includes(';')) continue;
      const kLow = key.toLowerCase();
      if (words.length && words.every(w => kLow.includes(w))) matches.push(key);
    }
    if (matches.length === 1) return matches[0];
    // Multiple partial matches → prefer shortest (least ambiguous) name
    if (matches.length > 1) {
      matches.sort((a, b) => a.length - b.length);
      return matches[0];
    }
  }

  return q; // return normalised query even when not found in price list
}

client.on('friendMessage', (steamID, message) => {
  handleChatCommand(steamID, message.trim()).catch(err =>
    console.error('[tf2-hub] chat command error:', err.message));
});

async function handleChatCommand(steamID, message) {
  // Handle backpack.tf-style chat commands: sell_ItemName → !sell Item Name
  if (!message.startsWith('!')) {
    const lm = message.toLowerCase();
    if (lm.startsWith('sell_')) {
      return handleChatCommand(steamID, '!sell ' + message.slice(5).replace(/_/g, ' ').trim());
    }
    if (lm.startsWith('buy_')) {
      return handleChatCommand(steamID, '!buy ' + message.slice(4).replace(/_/g, ' ').trim());
    }
    return; // not a command
  }
  const space = message.indexOf(' ');
  const cmd = (space === -1 ? message : message.slice(0, space)).toLowerCase();
  const args = space === -1 ? '' : message.slice(space + 1).trim();

  function reply(text) { client.chatMessage(steamID, text); }

  switch (cmd) {
    case '!help':
      reply(
        '📦 TF2-HA Bot commands:\n' +
        '!price <item> — show buy/sell price\n' +
        '!buy <item>  — I send you an offer to buy your item\n' +
        '!sell <item> — I send you an offer to sell you my item\n' +
        '!stock       — show what I have in stock\n' +
        '!rate        — show key/metal exchange rate'
      );
      break;

    case '!rate':
      reply('🔑 Key rate: ' + keyPriceRef.toFixed(2) + ' ref per key');
      break;

    case '!price': {
      if (!args) { reply('Usage: !price <item name>'); break; }
      const priceName = resolveItemName(args);
      const ref = await getRefPrice(priceName);
      if (!ref) { reply('❌ No price found for: ' + priceName); break; }
      const opts = readOptions();
      const minP = Number(opts.min_profit_ref ?? 0.11);
      const buyAt  = snapToScrap(Math.max(0.11, ref - 0.11 - minP));
      const sellAt = snapToScrap(Math.max(0.11, ref - 0.11));
      reply('💲 ' + priceName + '\n  I buy for:  ' + buyAt.toFixed(2) + ' ref\n  I sell for: ' + sellAt.toFixed(2) + ' ref');
      break;
    }

    case '!stock': {
      let botInv;
      try {
        botInv = await new Promise((resolve, reject) =>
          manager.getInventoryContents(440, 2, true, (err, items) =>
            err ? reject(err) : resolve(items)));
      } catch { reply('❌ Could not load inventory.'); break; }
      const counts = {};
      botInv.filter(i => i.tradable && !CURRENCY_NAMES.has(i.name))
            .forEach(i => { counts[i.name] = (counts[i.name] || 0) + 1; });
      const entries = Object.entries(counts);
      if (!entries.length) { reply('I have no items in stock right now.'); break; }
      reply('📦 My stock:\n' + entries.slice(0, 20).map(([n, c]) => c + 'x ' + n).join('\n'));
      break;
    }

    case '!buy': {
      if (!args) { reply('Usage: !buy <item name>'); break; }
      // Strip optional leading quantity: "!buy 2 Item Name" → "Item Name"
      const buyArgs = resolveItemName(args.replace(/^\d+\s+/, ''));
      const ref = await getRefPrice(buyArgs);
      if (!ref) { reply('❌ I don\'t have a price for: ' + buyArgs); break; }
      const opts = readOptions();
      const minP = Number(opts.min_profit_ref ?? 0.11);
      const buyRef = Math.max(0.11, +(ref - 0.11 - minP).toFixed(2));

      let partnerInv, botInv;
      try {
        [partnerInv, botInv] = await Promise.all([
          new Promise((resolve, reject) => manager.getUserInventoryContents(steamID, 440, 2, true, (err, items) => err ? reject(err) : resolve(items))),
          new Promise((resolve, reject) => manager.getInventoryContents(440, 2, true, (err, items) => err ? reject(err) : resolve(items))),
        ]);
      } catch (e) { reply('❌ Could not load inventory: ' + e.message); break; }

      // Enforce stock limit — don't buy if we already have max_stock of this item
      const maxStock = Math.max(1, Number(opts.max_stock ?? 3));
      const currentStock = botInv.filter(i => i.name === buyArgs && !CURRENCY_NAMES.has(i.name)).length;
      if (currentStock >= maxStock) {
        reply('❌ I already have ' + currentStock + ' ' + buyArgs + ' in stock (limit ' + maxStock + ').');
        break;
      }

      const item = partnerInv.find(i => i.name === buyArgs && i.tradable);
      if (!item) { reply('❌ Couldn\'t find ' + buyArgs + ' in your inventory (must be public & tradable).'); break; }

      const currencyItems = buildCurrencyItems(buyRef, botInv);
      if (!currencyItems) { reply('❌ I don\'t have enough currency right now (' + buyRef.toFixed(2) + ' ref needed).'); break; }

      reply('📨 Sending offer for your ' + buyArgs + ' — paying ' + buyRef.toFixed(2) + ' ref...');
      const offer = manager.createOffer(steamID.getSteamID64());
      offer.addTheirItems([{ appid: 440, contextid: '2', assetid: item.assetid }]);
      offer.addMyItems(currencyItems);
      offer.setMessage('TF2-HA Bot — buying ' + buyArgs);
      offer.send(err => {
        if (err) reply('❌ Failed to send offer: ' + err.message);
        else {
          reply('✅ Offer sent! Check your trade offers.');
          pendingOffers.set(offer.id, { ts: Date.now(), desc: '!buy from ' + steamID.getSteamID64().slice(-6) + ': ' + buyArgs });
          savePending();
        }
      });
      break;
    }

    case '!sell': {
      if (!args) { reply('Usage: !sell <item name>'); break; }
      // Strip optional leading quantity: "!sell 2 Item Name" → "Item Name"
      const sellArgs = resolveItemName(args.replace(/^\d+\s+/, ''));
      let botInv;
      try {
        botInv = await new Promise((resolve, reject) =>
          manager.getInventoryContents(440, 2, true, (err, items) =>
            err ? reject(err) : resolve(items)));
      } catch { reply('❌ Could not load my inventory.'); break; }

      const item = botInv.find(i => i.name === sellArgs && i.tradable && !CURRENCY_NAMES.has(i.name));
      if (!item) { reply('❌ I don\'t have ' + sellArgs + ' in stock.'); break; }

      const market = await getRefPrice(sellArgs);
      if (!market) { reply('❌ No price for: ' + sellArgs); break; }
      // Sell at market - 1 scrap, but never below cost + min_profit
      const opts2 = readOptions();
      const minP2 = Number(opts2.min_profit_ref ?? 0.11);
      const cost = (readCosts()[item.assetid]) || 0;
      const sellRef = Math.max(+(cost + minP2).toFixed(2), +(market - 0.11).toFixed(2), 0.11);

      let partnerInv;
      try {
        partnerInv = await new Promise((resolve, reject) =>
          manager.getUserInventoryContents(steamID, 440, 2, true, (err, items) =>
            err ? reject(err) : resolve(items)));
      } catch { reply('❌ Could not load your inventory (must be public).'); break; }

      const theirCurrency = buildCurrencyItems(sellRef, partnerInv);
      if (!theirCurrency) { reply('❌ You don\'t have enough currency. Price: ' + sellRef.toFixed(2) + ' ref'); break; }

      reply('📨 Sending offer for ' + sellArgs + ' — price: ' + sellRef.toFixed(2) + ' ref...');
      const offer = manager.createOffer(steamID.getSteamID64());
      offer.addMyItems([{ appid: 440, contextid: '2', assetid: item.assetid }]);
      offer.addTheirItems(theirCurrency);
      offer.setMessage('TF2-HA Bot — selling ' + sellArgs);
      offer.send(err => {
        if (err) reply('❌ Failed to send offer: ' + err.message);
        else {
          reply('✅ Offer sent! Check your trade offers.');
          pendingOffers.set(offer.id, { ts: Date.now(), desc: '!sell to ' + steamID.getSteamID64().slice(-6) + ': ' + sellArgs });
          savePending();
        }
      });
      break;
    }

    default:
      reply('❓ Unknown command. Type !help for the list.');
  }
}

// ─── Trade Offer Handling ────────────────────────────────────────────────────

manager.on('newOffer', offer => {
  console.log('[tf2-hub] new offer', offer.id, 'from', offer.partner.getSteamID64());
  evaluateOffer(offer).catch(err => console.error('[tf2-hub] evaluate error:', err.message));
});

async function evaluateOffer(offer) {
  // Decline immediately if partner has a trade hold (escrow)
  if (offer.escrowEnds) {
    console.log('[tf2-hub] offer', offer.id, '→ decline — trade hold until', offer.escrowEnds);
    appState.declined_today++;
    offer.decline(() => {});
    return;
  }

  // Decline immediately if partner is a known scammer / backpack.tf banned
  const partnerSteamId = offer.partner.getSteamID64();
  if (await isScammer(partnerSteamId)) {
    console.log('[tf2-hub] offer', offer.id, '→ decline — scammer:', partnerSteamId);
    appState.declined_today++;
    offer.decline(() => {});
    appendOffer({ ts: new Date().toISOString(), offer_id: offer.id, partner: partnerSteamId, action: 'decline', reason: 'scammer ban', give_ref: 0, recv_ref: 0, profit: 0 });
    return;
  }

  const opts = readOptions();
  const baseMinProfit = Number(opts.min_profit_ref ?? 0.11);
  const dynamicPct = Number(opts.dynamic_profit_pct ?? 3);
  const acceptDonations = Boolean(opts.accept_donations);

  // ── Build market snapshots for every item in this offer ─────────────────
  // Each snapshot fuses cheapest sell, median of top 5, highest buy, and IGetPrices
  // into a confidence-rated view.  populated here so priceItems and the hard-safety
  // checks below all see fresh, consistent data.
  const apiToken = opts.backpack_tf_api_key; // classifieds search uses key=, not token=
  const offerItems = [...new Set(
    [...offer.itemsToGive, ...offer.itemsToReceive]
      .filter(i => !CURRENCY_NAMES.has(i.name))
      .map(i => i.name)
  )];
  const snapshots = new Map();
  for (const name of offerItems) {
    const snap = await getMarketSnapshot(name, apiToken).catch(() => null);
    if (snap) snapshots.set(name, snap);
  }
  // ─────────────────────────────────────────────────────────────────────────

  const offerCosts = readCosts();
  const [give, recv] = await Promise.all([
    priceItems(offer.itemsToGive, 'give', offerCosts),
    priceItems(offer.itemsToReceive, 'recv', offerCosts),
  ]);
  const profit = recv.total - give.total;
  // Dynamic min profit: scale with the larger side of the trade so expensive
  // items earn proportionally more margin than cheap flips.
  const tradeValue = Math.max(give.total, recv.total);
  const minProfit = effectiveMinProfit(tradeValue, baseMinProfit, dynamicPct);

  let action, reason;

  // Detect gift-wrapped items — they show up as "Wrapped Gift" and can't be priced
  const allUnknown = [...give.unknown, ...recv.unknown];
  const hasWrappedGift = allUnknown.some(n => n === 'Wrapped Gift') ||
    [...offer.itemsToReceive, ...offer.itemsToGive].some(i =>
      (i.name || '') === 'Wrapped Gift' ||
      (Array.isArray(i.tags) && i.tags.some(t => (t.internal_name || '').toLowerCase() === 'gift'))
    );

  if (give.unknown.length || recv.unknown.length) {
    action = 'decline';
    reason = 'unpriced items: ' + allUnknown.slice(0, 3).join(', ');
  } else if (give.total === 0 && recv.total > 0) {
    action = acceptDonations ? 'accept' : 'decline';
    reason = 'donation — ' + recv.total.toFixed(2) + ' ref';
  } else if (profit >= minProfit) {
    action = 'accept';
    reason = '+' + profit.toFixed(2) + ' ref profit (min ' + minProfit.toFixed(2) + ')';
  } else if (offer.itemsToGive.length > 0 && profit > -(minProfit * 2)) {
    // Near miss — try to counter with correct price instead of declining
    const countered = await tryCounterOffer(offer, give, recv, minProfit);
    if (countered) {
      action = 'counter';
      reason = 'countered: asking ' + (give.total + minProfit).toFixed(2) + ' ref';
    } else {
      action = 'decline';
      reason = profit >= 0
        ? 'below min profit (' + profit.toFixed(2) + ' ref, need ' + minProfit.toFixed(2) + ')'
        : profit.toFixed(2) + ' ref loss';
    }
  } else {
    action = 'decline';
    reason = profit < 0
      ? profit.toFixed(2) + ' ref loss'
      : 'below min profit (' + profit.toFixed(2) + ' ref, need ' + minProfit.toFixed(2) + ')';
  }

  // ─── HARD SAFETY NET (v1.7 conservative) ───────────────────────────────
  // Triple-checks on any 'accept' before it actually fires. Catches the cases
  // priceItems can't: stale IGetPrices over-valuing our incoming items, big-ticket
  // surprise trades, and offers for items the market data can't be trusted on.
  if (action === 'accept' && offer.itemsToReceive.length > 0) {
    const recvNonCurrency = offer.itemsToReceive.filter(i => !CURRENCY_NAMES.has(i.name));

    // 1. Untrusted market data → never accept
    for (const item of recvNonCurrency) {
      const snap = snapshots.get(item.name);
      if (snap && snap.confidence === 'untrusted') {
        action = 'decline';
        reason = 'untrusted market: ' + item.name + ' (no resale floor we can verify)';
        break;
      }
    }

    // 2. Per-item floor: never pay >= cheapest competitor sell - minProfit
    // This is the catch-all that prevents the 2.44-ref-for-2.22-ref-item bleed.
    if (action === 'accept' && recvNonCurrency.length && give.total > 0) {
      const perItemPaid = give.total / recvNonCurrency.length;
      for (const item of recvNonCurrency) {
        const snap = snapshots.get(item.name);
        if (!snap) continue;
        const resaleFloor = snap.cheapestSell ?? snap.median ?? snap.truth;
        if (!resaleFloor) continue;
        if (perItemPaid >= resaleFloor - minProfit) {
          action = 'decline';
          reason = 'overpay: ' + perItemPaid.toFixed(2) + ' >= floor ' + resaleFloor.toFixed(2) + ' for ' + item.name;
          break;
        }
      }
    }

    // 3. Max single-trade value cap (configurable safety)
    const maxTradeKeys = Math.max(0, Number(opts.max_trade_value_keys ?? 5));
    if (maxTradeKeys > 0) {
      const maxTradeRef = maxTradeKeys * keyPriceRef;
      if (tradeValue > maxTradeRef) {
        action = 'decline';
        reason = 'trade exceeds cap: ' + tradeValue.toFixed(2) + ' ref > ' + maxTradeRef.toFixed(2) + ' ref (' + maxTradeKeys + ' keys)';
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  const entry = {
    ts: new Date().toISOString(),
    offer_id: offer.id,
    partner: offer.partner.getSteamID64(),
    action,
    reason,
    give_ref: +give.total.toFixed(4),
    recv_ref: +recv.total.toFixed(4),
    profit: +profit.toFixed(4),
  };
  appendOffer(entry);
  const giveNames = offer.itemsToGive.map(i => i.name).join(', ') || '—';
  const recvNames = offer.itemsToReceive.map(i => i.name).join(', ') || '—';
  console.log('[tf2-hub] offer', offer.id, '→', action, '—', reason,
    '| give:', give.total.toFixed(2) + 'ref [' + giveNames + ']',
    '| recv:', recv.total.toFixed(2) + 'ref [' + recvNames + ']',
    '| profit:', profit.toFixed(2) + 'ref');

  if (action === 'accept') {
    appState.accepted_today++;
    const nonCurrencyRecv = offer.itemsToReceive.filter(i => !CURRENCY_NAMES.has(i.name));
    if (nonCurrencyRecv.length && give.total > 0) {
      const costs = readCosts();
      const costEach = give.total / nonCurrencyRecv.length;
      for (const item of nonCurrencyRecv) costs[item.assetid] = +costEach.toFixed(4);
      saveCosts(costs);
    }
    haNotify('TF2 Bot — Trade Accepted',
      'From ' + offer.partner.getSteamID64().slice(-6) + ': +' + profit.toFixed(2) + ' ref profit');
    offer.accept((err) => {
      if (err) console.error('[tf2-hub] accept error:', err.message);
      else {
        console.log('[tf2-hub] offer', offer.id, 'accepted');
        setTimeout(() => syncInventoryListings().catch(() => {}), 15000);
      }
    });
  } else if (action === 'counter') {
    // counter was already sent inside tryCounterOffer
  } else if (action === 'decline') {
    appState.declined_today++;
    if (hasWrappedGift) {
      client.chatMessage(offer.partner,
        '❌ I can\'t price gift-wrapped items — please unwrap the item first and resend the trade!');
    }
    offer.decline(err => {
      if (err) console.error('[tf2-hub] decline error:', err.message);
      else console.log('[tf2-hub] offer', offer.id, 'declined');
    });
  }
}

// Counter an offer by fetching partner's inventory and building correct currency.
// Returns true if counter was sent successfully.
async function tryCounterOffer(offer, give, recv, minProfit) {
  const shortfall = +(give.total + minProfit - recv.total).toFixed(4);
  if (shortfall <= 0 || shortfall > 2) return false;

  // Only counter pure currency-for-items offers (most common case: buying our item)
  if (!offer.itemsToReceive.every(i => CURRENCY_NAMES.has(i.name))) return false;
  if (!offer.itemsToGive.length) return false;

  try {
    const partnerInventory = await new Promise((resolve, reject) =>
      manager.getUserInventoryContents(offer.partner, 440, 2, true, (err, items) =>
        err ? reject(err) : resolve(items)));

    const targetRef = +(give.total + minProfit).toFixed(2);
    const currencyItems = buildCurrencyItems(targetRef, partnerInventory);
    if (!currencyItems || !currencyItems.length) return false;

    const counter = offer.counter();
    offer.itemsToGive.forEach(i =>
      counter.addMyItem({ appid: 440, contextid: '2', assetid: i.assetid }));
    counter.addTheirItems(currencyItems);
    counter.setMessage('Counter at ' + targetRef.toFixed(2) + ' ref. TF2-HA Bot');

    await new Promise((resolve, reject) =>
      counter.send((err, status) => err ? reject(err) : resolve(status)));

    console.log('[tf2-hub] counter sent for offer', offer.id, '— asking', targetRef.toFixed(2), 'ref');
    haNotify('TF2 Bot — Counter Sent',
      'To ' + offer.partner.getSteamID64().slice(-6) + ': asking ' + targetRef.toFixed(2) + ' ref');
    return true;
  } catch (err) {
    console.error('[tf2-hub] counter error:', err.message);
    return false;
  }
}

// ─── Listing Sync ────────────────────────────────────────────────────────────

// Helper: item name → sell_Item_Name format for backpack.tf chat commands
function chatCmd(name) { return name.replace(/ /g, '_'); }

// Fetch competitor sell listing prices (ref) for an item.
// Returns { cheapest, secondCheapest } — cheapest for sell undercut pricing,
// secondCheapest for buy ceiling (avoids one lowball bot tanking the whole market).
// Excludes our own bot's listings.
const classifiedsSellCacheSecond = new Map(); // name -> { ref, ts }  (2nd cheapest)
async function getCheapestSellRef(name, apiKey) {
  // Return from cache if fresh
  const cached = classifiedsSellCache.get(name);
  if (cached && Date.now() - cached.ts < CLASSIFIEDS_PRICE_TTL) return cached.ref;

  try {
    const data = await httpsGet(
      'https://api.backpack.tf/api/classifieds/search/v1?key='
      + encodeURIComponent(apiKey)
      + '&item=' + encodeURIComponent(name)
      + '&intent=sell&tradable=1&page_size=6'
    );
    const listings = (data.sell?.listings || []).filter(
      l => !appState.steam_id || String(l.steamid) !== String(appState.steam_id)
    );
    if (!listings.length) return null;
    const toRef = l => (l.price?.keys || 0) * keyPriceRef + (l.price?.metal || 0);
    const cheapest = toRef(listings[0]);
    // 2nd cheapest: use index 1 if available, else fall back to cheapest
    const second = listings.length > 1 ? toRef(listings[1]) : cheapest;
    classifiedsSellCache.set(name, { ref: cheapest, ts: Date.now() });
    classifiedsSellCacheSecond.set(name, { ref: second, ts: Date.now() });
    return cheapest;
  } catch {
    return null;
  }
}

// Fetch the highest competitor BUY listing price (ref) for an item.
// We want to outbid this by 1 scrap to be the most attractive buyer.
// Excludes our own bot's buy listings.
const classifiedsBuyCache = new Map(); // name -> { ref, ts }
async function getHighestBuyRef(name, apiKey) {
  const cached = classifiedsBuyCache.get(name);
  if (cached && Date.now() - cached.ts < CLASSIFIEDS_PRICE_TTL) return cached.ref;

  try {
    const data = await httpsGet(
      'https://api.backpack.tf/api/classifieds/search/v1?key='
      + encodeURIComponent(apiKey)
      + '&item=' + encodeURIComponent(name)
      + '&intent=buy&tradable=1&craftable=1&quality=6&page_size=5'
    );
    const listings = (data.buy?.listings || []).filter(
      l => !appState.steam_id || String(l.steamid) !== String(appState.steam_id)
    );
    if (!listings.length) return null;
    // Buy listings are sorted highest first — first entry is the best competing offer
    const ref = (listings[0].price?.keys || 0) * keyPriceRef + (listings[0].price?.metal || 0);
    classifiedsBuyCache.set(name, { ref, ts: Date.now() });
    return ref;
  } catch {
    return null;
  }
}

async function syncListings() {
  const opts = readOptions();
  if (!opts.backpack_tf_token) return;
  const doFetch = () => httpsGet(
    'https://api.backpack.tf/api/classifieds/listings/v1?token=' + encodeURIComponent(opts.backpack_tf_token)
  );
  try {
    let data;
    try {
      data = await doFetch();
    } catch (e) {
      if (!e.message.includes('429')) throw e;
      // Rate-limited — back off and try once more
      console.log('[tf2-hub] listings sync 429 — retrying in 20s...');
      await sleep(20000);
      data = await doFetch();
    }
    const listings = Object.values(data.listings || {}).slice(0, 500);
    const state = readState();
    state.listings = listings;
    state.listings_count = listings.length;
    state.last_sync = new Date().toISOString();
    writeState(state);
    appState.listings_count = listings.length;
    appState.last_sync = state.last_sync;
    console.log('[tf2-hub] listings synced:', listings.length);
  } catch (err) {
    console.error('[tf2-hub] listings sync error:', err.message);
  }
}

const CURRENCY_NAMES = new Set(['Refined Metal', 'Reclaimed Metal', 'Scrap Metal', 'Mann Co. Supply Crate Key']);

async function syncInventoryListings(force = false) {
  if (isSyncing) { console.log('[tf2-hub] syncInventoryListings: already running — skipped'); return; }
  const sinceLast = Date.now() - lastSyncCompletedAt;
  if (!force && sinceLast < MIN_SYNC_COOLDOWN_MS) {
    console.log('[tf2-hub] syncInventoryListings: cooldown (' + Math.round((MIN_SYNC_COOLDOWN_MS - sinceLast) / 1000) + 's remaining) — skipped');
    return;
  }
  isSyncing = true;
  try { await _syncInventoryListings(); } finally { isSyncing = false; lastSyncCompletedAt = Date.now(); }
}

async function _syncInventoryListings() {
  const opts = readOptions();
  if (!opts.backpack_tf_token) return;

  const baseMinProfit = Number(opts.min_profit_ref ?? 0.11);
  const dynamicPct = Number(opts.dynamic_profit_pct ?? 3);
  const costs = readCosts();
  // classifieds/search uses the API key (key=), NOT the user token.
  // The user token (token=) is only for listing management (create/delete).
  const apiToken = opts.backpack_tf_api_key;

  try {
    // Fetch bot's TF2 inventory
    const inventory = await new Promise((resolve, reject) =>
      manager.getInventoryContents(440, 2, true, (err, items) =>
        err ? reject(err) : resolve(items)));

    const listings = [];
    const seen = new Set();

    const tradable = inventory.filter(i => i.tradable && !CURRENCY_NAMES.has(i.name));
    console.log('[tf2-hub] inventory: ' + inventory.length + ' items, ' + tradable.length + ' tradable non-currency');

    // Load listing timestamps for stale repricing + abandonment tracking (persisted in state.json)
    const state = readState();
    const listingTs = state.listing_timestamps || {};
    const STALE_MS = 24 * 60 * 60 * 1000;
    const abandonDays = Number(opts.abandon_days ?? 7);
    const abandonMs = abandonDays > 0 ? abandonDays * 24 * 60 * 60 * 1000 : 0;

    // Stock count — declared here so both SELL and BUY loops can reference it
    const maxStock = Math.max(1, Number(opts.max_stock || 3));
    const stockCount = {};
    inventory.forEach(i => { if (i.tradable && !CURRENCY_NAMES.has(i.name)) stockCount[i.name] = (stockCount[i.name] || 0) + 1; });

    // SELL — one listing per unique item name.
    // Price = cheapest competitor listing - 1 scrap (auto-undercut).
    // If item listed >24h without selling, drop by another scrap (stale reprice).
    // Never sell below cost + min profit.
    for (const item of inventory) {
      if (!item.tradable || CURRENCY_NAMES.has(item.name) || seen.has(item.name)) continue;

      // ── Craft hats: all bulk-priced at the configured craft-hat price ────────
      // Quality-6 craftable cosmetics (hats + accessories) all trade at a fixed
      // "craft hat" market price.  Items with their own individual bp.tf price
      // more than 1.5× above craft hat price get individual pricing instead.
      const craftHatPrice = Number(opts.craft_hat_price ?? 1.33);
      if (isCraftHat(item) && craftHatPrice > 0) {
        const bpE = getBpEntry(item);
        const indivPrice = bpE ? bpE.sell : 0;
        if (!bpE || indivPrice <= craftHatPrice * 1.5) {
          // List at bulk craft-hat price
          const sellRef = snapToScrap(craftHatPrice);
          const keys  = Math.floor(sellRef / keyPriceRef);
          const metal = snapToScrap(sellRef - keys * keyPriceRef);
          const priceStr = keys ? keys + ' keys ' + metal.toFixed(2) + ' ref' : metal.toFixed(2) + ' ref';
          listings.push({
            intent: 1,
            id: item.assetid,
            currencies: { keys, metal },
            details: '🎩 CRAFT HAT | ' + priceStr + ' | Stock: ' + (stockCount[item.name] || 1) + ' | Chat: sell_' + chatCmd(item.name),
          });
          seen.add(item.name);
          continue;
        }
        // Individual price is notably higher → fall through to normal pricing
      }

      // ── Weapons: list at the standard 0.05 ref weapon floor ─────────────────
      // Stock weapons have no meaningful market value; their trade-up value is
      // 0.5 scrap ≈ 0.05 ref.  BUT weapon RESKINS (e.g. Bat Outta Hell, Holy
      // Mackerel, Saxxy) share the same slot tags yet have real market prices —
      // detect them via IGetPrices and fall through to normal pricing if priced.
      if (isWeapon(item)) {
        const bpE = getBpEntry(item);
        const bpSellRef = bpE ? bpE.sell : 0;
        if (bpSellRef >= 0.11) {
          // Has a real IGetPrices price → treat as a normal item, not a stock weapon
        } else {
          listings.push({
            intent: 1,
            id: item.assetid,
            currencies: { keys: 0, metal: 0.05 },
            details: '✅ AUTO-ACCEPT | 0.05 ref | Stock: ' + (stockCount[item.name] || 1) + ' | Chat: sell_' + chatCmd(item.name),
          });
          seen.add(item.name);
          continue;
        }
      }

      // For everything else: try IGetPrices first (instant, no rate-limit),
      // then fall back to a live classifieds fetch if the item isn't in the price list.
      // Pass the Steam Market hash name (includes wear for decorated weapons/war paints).
      const mktHash = itemMarketHashName(item);

      // Check for a manual UI price override — if set, use it directly and skip all
      // undercut / stale-reprice logic so the override is actually respected.
      const uiOverrides = (readState().ui_price_overrides) || {};
      const manualOverride = uiOverrides[item.name];
      if (manualOverride !== undefined) {
        const sellRef = +Number(manualOverride).toFixed(2);
        if (sellRef < 0.11) {
          console.log('[tf2-hub] override price too low for ' + item.name + ' (' + sellRef + ') — skip');
          continue;
        }
        console.log('[tf2-hub] price override ' + item.name + ': ' + sellRef.toFixed(2) + ' ref');
        if (!listingTs[item.name]) listingTs[item.name] = {};
        if (!listingTs[item.name].firstListedAt) listingTs[item.name].firstListedAt = Date.now();
        listingTs[item.name] = { postedAt: Date.now(), sellRef, firstListedAt: listingTs[item.name].firstListedAt };
        const keys = Math.floor(sellRef / keyPriceRef);
        const metal = +(sellRef - keys * keyPriceRef).toFixed(2);
        const priceStr = keys ? keys + ' keys ' + metal + ' ref' : metal + ' ref';
        listings.push({
          intent: 1,
          id: item.assetid,
          currencies: { keys, metal },
          details: '✅ AUTO-ACCEPT | ' + priceStr + ' [override] | Stock: ' + (stockCount[item.name] || 1) + ' | Chat: sell_' + chatCmd(item.name),
        });
        seen.add(item.name);
        continue;
      }

      // Quality-aware price: try getBpEntry first (handles Strange q11, NC q6)
      // then fall back to getRefPrice (classifieds cache / IGetPrices / PriceDB / Steam)
      const bpItemEntry = getBpEntry(item);
      let market = bpItemEntry ? bpItemEntry.sell : await getRefPrice(item.name, mktHash);
      if (!market && apiToken) {
        await sleep(300);
        market = await getCheapestSellRef(item.name, apiToken);
      }
      if (!market || market < 0.11) {
        console.log('[tf2-hub] no price for ' + item.name + ' — skip sell listing');
        continue;
      }
      const cost = costs[item.assetid] || 0;
      const minProfit = effectiveMinProfit(market, baseMinProfit, dynamicPct);
      const minSell = +(cost + minProfit).toFixed(2);

      // Set firstListedAt the first time we see this item — never reset unless sold
      if (!listingTs[item.name]) listingTs[item.name] = {};
      if (!listingTs[item.name].firstListedAt) listingTs[item.name].firstListedAt = Date.now();

      // Dead-item abandonment: if an item hasn't sold in N days, stop relisting it.
      // The admin dashboard will show it so the user can force-relist or price-override.
      if (abandonMs > 0 && Date.now() - listingTs[item.name].firstListedAt > abandonMs) {
        const days = Math.floor((Date.now() - listingTs[item.name].firstListedAt) / 86400000);
        console.log('[tf2-hub] abandoned ' + item.name + ' (' + days + 'd unsold — not relisting)');
        seen.add(item.name); // mark seen so timestamp isn't cleared
        continue;
      }
      const ncDiscount = isNonCraftable(item) ? NC_PENALTY : 0;

      // Try to undercut the cheapest competitor by 1 scrap
      const cheapestComp = apiToken ? await getCheapestSellRef(item.name, apiToken) : null;
      let freshRef;
      if (cheapestComp && cheapestComp > minSell) {
        freshRef = Math.max(minSell, +(cheapestComp - 0.11 - ncDiscount).toFixed(2));
        const ncTag = ncDiscount ? ' (NC -' + ncDiscount.toFixed(2) + ')' : '';
        console.log('[tf2-hub] undercut ' + item.name + ': comp=' + cheapestComp.toFixed(2) + ' → list at ' + freshRef.toFixed(2) + ' ref' + ncTag);
      } else {
        freshRef = Math.max(minSell, +(market - 0.11 - ncDiscount).toFixed(2));
      }

      // Stale repricing (v1.7): escalating drops if the item isn't moving.
      // Speeds up inventory turnover — a stuck listing is opportunity cost.
      //   Day 0-1:  hold at fresh undercut
      //   Day 2:    -2% of list price
      //   Day 3:    -5%
      //   Day 4:    -10%
      //   Day 5:    -15%
      //   Day 6+:   -20%   (then day-7 abandon kicks in via abandonMs)
      // Never below minSell (cost + min_profit). Initial under-market price recovers.
      const prev = listingTs[item.name];
      let sellRef = freshRef;
      if (prev && Date.now() - prev.postedAt > STALE_MS) {
        const ageHrs = (Date.now() - (prev.firstListedAt || prev.postedAt)) / 3600000;
        let dropPct = 0;
        if (ageHrs >= 24 && ageHrs < 48)      dropPct = 0.02;
        else if (ageHrs < 72)                  dropPct = 0.05;
        else if (ageHrs < 96)                  dropPct = 0.10;
        else if (ageHrs < 120)                 dropPct = 0.15;
        else                                   dropPct = 0.20;

        if (prev.sellRef >= freshRef - 0.11) {
          // Was priced at/near market — apply escalating stale drop
          const staleRef = +(prev.sellRef * (1 - dropPct)).toFixed(2);
          sellRef = Math.max(minSell, Math.min(prev.sellRef, staleRef));
          if (sellRef < prev.sellRef)
            console.log('[tf2-hub] stale reprice ' + item.name + ' (' + Math.floor(ageHrs / 24) + 'd, -' + (dropPct * 100).toFixed(0) + '%): ' + prev.sellRef.toFixed(2) + ' → ' + sellRef.toFixed(2) + ' ref');
        } else {
          // Was priced below market (initial price was wrong) — recover to fresh undercut
          sellRef = freshRef;
          console.log('[tf2-hub] price recovery ' + item.name + ': ' + prev.sellRef.toFixed(2) + ' → ' + sellRef.toFixed(2) + ' ref');
        }
      }

      // Snap to nearest scrap to avoid float precision drift in listing currencies
      sellRef = snapToScrap(sellRef);

      // Update timestamp — preserve firstListedAt across reposts
      listingTs[item.name] = { postedAt: Date.now(), sellRef, firstListedAt: listingTs[item.name].firstListedAt };

      const keys  = Math.floor(sellRef / keyPriceRef);
      const metal = snapToScrap(sellRef - keys * keyPriceRef);
      const priceStr = keys ? keys + ' keys ' + metal.toFixed(2) + ' ref' : metal.toFixed(2) + ' ref';
      console.log('[tf2-hub] sell-list ' + item.name + ': ' + sellRef.toFixed(2) + ' ref'
        + (cost ? ' (cost ' + cost.toFixed(2) + ' ref, margin ' + (sellRef - cost).toFixed(2) + ' ref)' : ' (cost unknown)')
        + ' bp=' + (getBpEntry(item)?.sell?.toFixed(2) ?? '—')
        + ' comp=' + (cheapestComp?.toFixed(2) ?? '—'));
      listings.push({
        intent: 1,
        id: item.assetid,
        currencies: { keys, metal },
        details: '✅ AUTO-ACCEPT | ' + priceStr + ' | Stock: ' + (stockCount[item.name] || 1) + ' | Chat: sell_' + chatCmd(item.name),
      });
      seen.add(item.name);
    }

    // Persist updated timestamps (trim entries for items no longer in inventory)
    for (const name of Object.keys(listingTs)) {
      if (!seen.has(name)) delete listingTs[name]; // sold — clear timestamp
    }
    state.listing_timestamps = listingTs;

    // Build abandoned item list for admin dashboard
    if (abandonMs > 0) {
      state.abandoned_items = Object.entries(listingTs)
        .filter(([, ts]) => ts.firstListedAt && Date.now() - ts.firstListedAt > abandonMs)
        .map(([name, ts]) => ({ name, days: Math.floor((Date.now() - ts.firstListedAt) / 86400000) }));
    } else {
      state.abandoned_items = [];
    }

    writeState(state);

    // BUY — spread budget across items, keeping reserve_pct% of currency untouched
    const reservePct = Math.min(95, Math.max(0, Number(opts.currency_reserve_pct ?? 50)));
    const totalCurrencyRef = inventory
      .filter(i => i.tradable)
      .reduce((sum, i) => {
        if (i.name === 'Mann Co. Supply Crate Key') return sum + keyPriceRef;
        if (i.name === 'Refined Metal')             return sum + 1;
        if (i.name === 'Reclaimed Metal')           return sum + 1 / 3;
        if (i.name === 'Scrap Metal')               return sum + 1 / 9;
        return sum;
      }, 0);
    let buyBudget = +(totalCurrencyRef * (1 - reservePct / 100)).toFixed(2);
    console.log('[tf2-hub] buy budget: ' + buyBudget.toFixed(2) + ' ref (' + (100 - reservePct) + '% of ' + totalCurrencyRef.toFixed(2) + ' ref)');

    // Parse buy_items — supports "Item Name:N" for per-item stock override, or plain "Item Name" (uses global max_stock)
    const configRaw = (opts.buy_items || '').split(',').map(s => s.trim()).filter(Boolean);
    const configParsed = configRaw.map(entry => {
      const m = entry.match(/^(.+):(\d+)$/);
      return m ? { name: m[1].trim(), stock: Math.max(1, parseInt(m[2])) } : { name: entry, stock: maxStock };
    });

    // MvM robot parts auto-buy (the 8 ingredients for KS kit fabricators):
    // Battle-Worn: Money Furnace, Taunt Processor, KB-808
    // Reinforced:  Humor Suppression Pump, Emotion Detector, Bomb Stabilizer
    // Pristine:    Currency Digester, Brainstorm Bulb
    const MVM_PART_RE = /^(Battle-Worn Robot|Reinforced Robot|Pristine Robot) /i;
    const mvmPartsStock = Math.max(0, Number(opts.mvm_parts_stock || 0));
    const fabItems = [];
    if (mvmPartsStock > 0 && bpPriceList) {
      const parts = [...bpPriceList.entries()]
        .filter(([n]) => MVM_PART_RE.test(n))
        .map(([n]) => ({ name: n, stock: mvmPartsStock }));
      fabItems.push(...parts);
      if (parts.length) console.log('[tf2-hub] mvm-parts buy: ' + parts.length + ' robot parts queued (stock ' + mvmPartsStock + ' each)');
    }

    const buyItemsParsed = configParsed.length
      ? [...configParsed, ...fabItems]
      : [...(await computeLiquidItems()).map(n => ({ name: n, stock: maxStock })), ...fabItems];

    // buyBudget is the max we can spend on ANY SINGLE item — we check each item
    // independently (don't drain budget per listing) so all affordable items get
    // a buy listing. max_auto_buy caps the count.
    //
    // v1.7 conservative gates — every item must clear ALL of these before a buy
    // listing is posted:
    //   1. Market snapshot exists (some real data, not just IGetPrices)
    //   2. Confidence is NOT 'untrusted' (sources don't disagree wildly)
    //   3. At least 2 active competing buyers (item has real demand → liquidity)
    //   4. Per-trade value cap not exceeded
    //   5. Item not over max-single-trade-keys without manual whitelist
    const maxAutoBuy = Math.max(1, Number(opts.max_auto_buy || 50));
    const maxTradeKeys = Math.max(0, Number(opts.max_trade_value_keys ?? 5));
    const maxTradeRef = maxTradeKeys > 0 ? maxTradeKeys * keyPriceRef : Infinity;
    const whitelist = new Set(configParsed.map(e => e.name)); // explicit buy_items bypass the cap
    let buyListingCount = 0;

    // Pre-warm market snapshots for first 20 buy items only — warming all items
    // at once caused 316+ API calls and consistent 429s.  The per-item loop
    // below will fill remaining cache entries lazily on first use.
    const prewarmItems = buyItemsParsed.slice(0, 20);
    console.log(`[tf2-hub] pre-warming market snapshots for ${prewarmItems.length} buy items (of ${buyItemsParsed.length})...`);
    for (const { name } of prewarmItems) {
      await getMarketSnapshot(name, apiToken);
    }
    console.log('[tf2-hub] market snapshot pre-warm complete');

    let skipUntrusted = 0, skipLowConf = 0, skipNoBuyers = 0, skipCap = 0;
    for (const { name, stock: itemMaxStock } of buyItemsParsed) {
      if (buyListingCount >= maxAutoBuy) break;
      if ((stockCount[name] || 0) >= itemMaxStock) continue; // at stock limit

      // Full market snapshot (confidence-rated, populates legacy caches)
      const snap = await getMarketSnapshot(name, apiToken);
      if (!snap) { continue; } // no data → can't safely price

      // Gate 1: untrusted data → NEVER buy
      if (snap.confidence === 'untrusted') {
        skipUntrusted++;
        console.log('[tf2-hub] skip buy ' + name + ': untrusted market (cheap=' + (snap.cheapestSell?.toFixed(2) ?? '—') + ' bp=' + (snap.bpSell?.toFixed(2) ?? '—') + ')');
        continue;
      }
      // Gate 2: low confidence — only skip if not whitelisted AND no IGetPrices data at all
      if (snap.confidence === 'low' && !whitelist.has(name) && snap.bpSell === null) {
        skipLowConf++;
        console.log('[tf2-hub] skip buy ' + name + ': low-conf, no bp.tf price');
        continue;
      }
      // Gate 3: require ≥2 active buyers OR a confirmed IGetPrices community price.
      // When classifieds are down (HTTP 500/timeout), buyers=0 for everything —
      // don't starve the buy loop just because backpack.tf had a bad night.
      // bpSell !== null means the item has a community-consensus price → it trades.
      if (snap.buyers < 2 && snap.bpSell === null && !whitelist.has(name)) {
        skipNoBuyers++;
        console.log('[tf2-hub] skip buy ' + name + ': buyers=' + snap.buyers + ', no bp.tf price');
        continue;
      }
      // Gate 4: per-trade value cap
      if (snap.truth > maxTradeRef && !whitelist.has(name)) {
        console.log('[tf2-hub] skip buy ' + name + ': value ' + snap.truth.toFixed(2) + ' ref > cap ' + maxTradeRef.toFixed(2) + ' ref');
        continue;
      }
      if (snap.truth < 0.22) continue;

      const minP = effectiveMinProfit(snap.truth, baseMinProfit, dynamicPct);
      // Conservative ceiling: snap.buyCeiling is already min(cheapest-0.11, median-0.11,
      // highBuy+0.11, bpSell*0.95). Subtract our profit margin to get the absolute max bid.
      const maxBuyRef = +(snap.buyCeiling - minP).toFixed(2);
      if (maxBuyRef < 0.11) continue;
      if (maxBuyRef > buyBudget) continue; // can't afford

      // Outbid the highest current buyer by 1 scrap, capped at our ceiling
      let buyRef;
      if (snap.highestBuy !== null) {
        const outbid = +(snap.highestBuy + 0.11).toFixed(2);
        buyRef = Math.min(maxBuyRef, Math.max(0.11, outbid));
        if (outbid > maxBuyRef)
          console.log('[tf2-hub] buy ' + name + ': comp=' + snap.highestBuy.toFixed(2) + ' outbid exceeds ceiling, capping at ' + maxBuyRef.toFixed(2) + ' ref (conf=' + snap.confidence + ')');
        else
          console.log('[tf2-hub] buy ' + name + ': outbidding comp=' + snap.highestBuy.toFixed(2) + ' → ' + buyRef.toFixed(2) + ' ref (conf=' + snap.confidence + ', ' + snap.buyers + ' buyers)');
      } else {
        buyRef = Math.max(0.11, maxBuyRef);
      }
      if (buyRef < 0.11) continue;
      const keys = Math.floor(buyRef / keyPriceRef);
      const metal = +(buyRef - keys * keyPriceRef).toFixed(2);
      const priceStr = keys ? keys + ' keys ' + metal + ' ref' : metal + ' ref';
      listings.push({
        intent: 0,
        item: { quality: 6, item_name: name, craftable: 1 },
        currencies: { keys, metal },
        details: '💰 BUYING | ' + priceStr + ' | Stock: ' + (stockCount[name] || 0) + '/' + itemMaxStock + ' | Chat: buy_' + chatCmd(name),
      });
      buyListingCount++;
    }
    console.log('[tf2-hub] buy loop done: ' + buyListingCount + ' listed' +
      (skipUntrusted ? ', ' + skipUntrusted + ' untrusted' : '') +
      (skipLowConf   ? ', ' + skipLowConf   + ' low-conf (no bp.tf data)' : '') +
      (skipNoBuyers  ? ', ' + skipNoBuyers  + ' no-buyers' : '') +
      (skipCap       ? ', ' + skipCap       + ' capped' : ''));

    // AUTOKEYS — keep PURE METAL balance in range by auto-buying/selling keys.
    // Threshold is metal-only (excluding keys); the config name autokeys_*_refined makes this explicit.
    if (opts.autokeys_enable) {
      const maxRef = Math.max(1, Number(opts.autokeys_max_refined || 80));
      const minRef = Math.max(0, Number(opts.autokeys_min_refined || 20));
      const metalOnlyRef = inventory
        .filter(i => i.tradable)
        .reduce((sum, i) => {
          if (i.name === 'Refined Metal')   return sum + 1;
          if (i.name === 'Reclaimed Metal') return sum + 1 / 3;
          if (i.name === 'Scrap Metal')     return sum + 1 / 9;
          return sum;
        }, 0);
      if (metalOnlyRef > maxRef) {
        // Excess metal → buy keys (convert metal to keys at slight discount)
        const keyBuyMetal = +(keyPriceRef - 0.11).toFixed(2);
        listings.push({ intent: 0, item: { quality: 6, item_name: 'Mann Co. Supply Crate Key', craftable: 1 }, currencies: { keys: 0, metal: keyBuyMetal }, details: '🔑 AUTO-BUY BOT | Buying keys instantly!' });
        console.log('[tf2-hub] autokeys: buying keys (metal ' + metalOnlyRef.toFixed(1) + ' ref > max ' + maxRef + ')');
      } else if (metalOnlyRef < minRef) {
        // Low metal → sell a key for refined
        const keyItem = inventory.find(i => i.name === 'Mann Co. Supply Crate Key' && i.tradable);
        if (keyItem) {
          listings.push({ intent: 1, id: keyItem.assetid, currencies: { keys: 0, metal: keyPriceRef }, details: '🔑 AUTO-SELL BOT | Selling key for metal!' });
          console.log('[tf2-hub] autokeys: selling key (metal ' + metalOnlyRef.toFixed(1) + ' ref < min ' + minRef + ')');
        }
      }
    }

    // Clean up costs.json — drop entries whose assetids are no longer in inventory.
    // Keeps the file from growing forever as the bot trades.
    const inventoryAssetIds = new Set(inventory.map(i => i.assetid));
    let costsTrimmed = 0;
    for (const id of Object.keys(costs)) {
      if (!inventoryAssetIds.has(id)) { delete costs[id]; costsTrimmed++; }
    }
    if (costsTrimmed) {
      saveCosts(costs);
      console.log('[tf2-hub] costs: pruned ' + costsTrimmed + ' stale entries');
    }

    if (!listings.length) { console.log('[tf2-hub] inventory: nothing to list'); return; }

    const postListings = async () => httpsPost(
      'https://api.backpack.tf/api/classifieds/list/v1?token=' + encodeURIComponent(opts.backpack_tf_token),
      { listings },
      { 'X-Auth-Token': opts.backpack_tf_token }
    );
    let result;
    try {
      result = await postListings();
    } catch (e) {
      if (e.message.includes('429')) {
        console.log('[tf2-hub] listings 429 — retrying in 10s...');
        await sleep(10000);
        result = await postListings();
      } else { throw e; }
    }

    const created = result.listings ? Object.values(result.listings).filter(l => !l.error).length : listings.length;
    const errors  = result.listings ? Object.values(result.listings).filter(l =>  l.error).length : 0;
    console.log('[tf2-hub] listings posted:', created, 'ok' + (errors ? ', ' + errors + ' errors' : ''));
    // Save posted listings to state immediately so the dashboard can show them right away.
    // Also schedule a bp.tf fetch after 15s to get accurate listing IDs/status.
    const st = readState();
    st.listings = listings.map(l => ({
      intent: l.intent,
      currencies: l.currencies,
      active: true,
      item: { name: inventory.find(i => i.assetid === l.id)?.name || '' }
    }));
    writeState(st);
    setTimeout(() => syncListings().catch(() => {}), 15000);
  } catch (err) {
    console.error('[tf2-hub] inventory list error:', err.message);
  }
}

// ─── Active Sniping ──────────────────────────────────────────────────────────

const sentSnipes = new Set(); // listing IDs already offered on this session
const pendingOffers = new Map(); // offerId -> { ts, desc } — bot-initiated offers awaiting response

// Load persisted pending offers from disk (survives restart so auto-cancel still fires)
try {
  const obj = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  for (const [id, info] of Object.entries(obj)) pendingOffers.set(id, info);
  if (pendingOffers.size) console.log('[tf2-hub] restored ' + pendingOffers.size + ' pending offers');
} catch {}

function savePending() {
  try { fs.writeFileSync(PENDING_PATH, JSON.stringify(Object.fromEntries(pendingOffers))); } catch {}
}

// Clean up pendingOffers when a sent offer changes state.
// When accepted (state 3): re-sync inventory so newly received items get sell listings.
manager.on('sentOfferChanged', (offer) => {
  if (offer.state !== 2 && pendingOffers.has(offer.id)) {
    pendingOffers.delete(offer.id); // 2 = Active
    savePending();
  }
  if (offer.state === 3) { // Accepted — inventory changed, re-post listings
    console.log('[tf2-hub] sent offer', offer.id, 'accepted — scheduling listing refresh');
    setTimeout(() => syncInventoryListings().catch(() => {}), 15000);
  }
});

// Convert a ref amount to the minimum set of currency items from botInventory.
// Works in scrap units (1 scrap = 1/9 ref) to avoid float errors.
function buildCurrencyItems(refNeeded, inventory) {
  const scrapsNeeded = Math.ceil(refNeeded * 9);
  const keys  = inventory.filter(i => i.name === 'Mann Co. Supply Crate Key' && i.tradable);
  const refs  = inventory.filter(i => i.name === 'Refined Metal'             && i.tradable);
  const recs  = inventory.filter(i => i.name === 'Reclaimed Metal'           && i.tradable);
  const scrps = inventory.filter(i => i.name === 'Scrap Metal'               && i.tradable);

  const keyScraps = Math.round(keyPriceRef * 9);
  let remaining = scrapsNeeded;
  const toSend = [];

  for (const k of keys) {
    if (remaining < keyScraps) break;
    toSend.push({ appid: 440, contextid: '2', assetid: k.assetid });
    remaining -= keyScraps;
  }
  for (const r of refs) {
    if (remaining < 9) break;
    toSend.push({ appid: 440, contextid: '2', assetid: r.assetid });
    remaining -= 9;
  }
  for (const r of recs) {
    if (remaining < 3) break;
    toSend.push({ appid: 440, contextid: '2', assetid: r.assetid });
    remaining -= 3;
  }
  for (const s of scrps) {
    if (remaining <= 0) break;
    toSend.push({ appid: 440, contextid: '2', assetid: s.assetid });
    remaining -= 1;
  }

  return remaining > 0 ? null : toSend; // null = can't afford
}

async function snipeClassifieds() {
  const opts = readOptions();
  // classifieds/search uses key= (API key), NOT token= (user token)
  const apiKey = opts.backpack_tf_api_key;
  if (!apiKey) return;

  const configItems = (opts.buy_items || '').split(',').map(s => s.trim()).filter(Boolean);
  const buyItems = configItems.length ? configItems : await computeLiquidItems();
  if (!buyItems.length) return;

  const baseMinProfit = Number(opts.min_profit_ref ?? 0.11);
  const dynamicPct = Number(opts.dynamic_profit_pct ?? 3);

  // Get bot's inventory for currency
  let inventory;
  try {
    inventory = await new Promise((resolve, reject) =>
      manager.getInventoryContents(440, 2, true, (err, items) =>
        err ? reject(err) : resolve(items)));
  } catch (err) {
    console.error('[tf2-hub] snipe: inventory error:', err.message);
    return;
  }

  const botRef = inventory
    .filter(i => i.tradable)
    .reduce((sum, i) => {
      if (i.name === 'Mann Co. Supply Crate Key') return sum + keyPriceRef;
      if (i.name === 'Refined Metal')             return sum + 1;
      if (i.name === 'Reclaimed Metal')           return sum + 1 / 3;
      if (i.name === 'Scrap Metal')               return sum + 1 / 9;
      return sum;
    }, 0);

  for (const name of buyItems) {
    const market = await getBuyMarketRef(name);
    if (!market) continue;

    const minProfit = effectiveMinProfit(market, baseMinProfit, dynamicPct);
    const expectedSellRef = +(market - 0.11).toFixed(2);
    const maxBuyRef = +(expectedSellRef - minProfit).toFixed(2);
    if (maxBuyRef <= 0) continue;

    await sleep(600); // 600 ms between items — stay under bp.tf rate limit
    try {
      const data = await httpsGet(
        'https://api.backpack.tf/api/classifieds/search/v1?key='
        + encodeURIComponent(apiKey)
        + '&item=' + encodeURIComponent(name)
        + '&intent=sell&tradable=1&craftable=1&quality=6&page_size=10'
      );

      const listings = data.sell?.listings || [];
      let committedRef = 0;
      let snipedThisItem = 0;
      for (const listing of listings) {
        if (snipedThisItem >= 3) break; // max 3 copies per item per cycle
        if (sentSnipes.has(listing.id)) continue;

        const listingRef = (listing.price?.keys || 0) * keyPriceRef + (listing.price?.metal || 0);
        const profit = +(expectedSellRef - listingRef).toFixed(4);

        if (profit < minProfit) break; // sorted cheapest first; rest will be worse

        if (listingRef + committedRef > botRef) {
          console.log('[tf2-hub] snipe: can\'t afford more ' + name + ' (committed ' + committedRef.toFixed(2) + '/' + botRef.toFixed(2) + ' ref)');
          break;
        }

        const tradeUrl = listing.trade_url || listing.user?.trade_url;
        const assetid  = String(listing.item?.id || listing.item?.asset_id || '');
        if (!tradeUrl || !assetid) continue;

        const currencyItems = buildCurrencyItems(listingRef, inventory);
        if (!currencyItems) continue;

        console.log('[tf2-hub] snipe: ' + name + ' at ' + listingRef.toFixed(2) + ' ref, profit ' + profit.toFixed(2) + ' ref — sending offer');
        sentSnipes.add(listing.id);
        committedRef += listingRef;
        snipedThisItem++;

        const snipeOffer = manager.createOffer(tradeUrl);
        snipeOffer.addTheirItems([{ appid: 440, contextid: '2', assetid }]);
        snipeOffer.addMyItems(currencyItems);
        snipeOffer.setMessage('TF2-HA Bot');
        snipeOffer.send((err, status) => {
          if (err) {
            console.error('[tf2-hub] snipe send error:', err.message);
            sentSnipes.delete(listing.id);
          } else {
            console.log('[tf2-hub] snipe offer sent', snipeOffer.id, status);
            pendingOffers.set(snipeOffer.id, { ts: Date.now(), desc: 'Snipe: ' + name + ' @ ' + listingRef.toFixed(2) + ' ref' });
            savePending();
            haNotify('TF2 Bot — Snipe Sent',
              name + ' for ' + listingRef.toFixed(2) + ' ref (+' + profit.toFixed(2) + ' ref expected)');
          }
        });
      }
    } catch (err) {
      console.error('[tf2-hub] snipe error (' + name + '):', err.message);
    }
  }
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

async function deleteAllListings() {
  const opts = readOptions();
  if (!opts.backpack_tf_token) return;
  const state = readState();
  const ids = (state.listings || []).map(l => l.id).filter(Boolean);
  if (!ids.length) { console.log('[tf2-hub] no listings to delete'); return; }
  console.log('[tf2-hub] deleting', ids.length, 'listings before shutdown...');
  try {
    await httpsDelete(
      'https://api.backpack.tf/api/v2/classifieds/listings',
      { listing_ids: ids },
      { 'X-Auth-Token': opts.backpack_tf_token }
    );
    console.log('[tf2-hub] all listings deleted');
  } catch (err) {
    console.error('[tf2-hub] delete listings error:', err.message);
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

function jsonReply(res, status, body) {
  const p = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) });
  res.end(p);
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); } });
  });
}

async function handle(req, res) {
  const pathname = (req.url || '/').split('?')[0].replace(/^\/+/, '/') || '/';

  if (req.method === 'GET' && pathname === '/api/status') {
    return jsonReply(res, 200, {
      version: VERSION,
      uptime_seconds: Math.round(process.uptime()),
      key_price_ref: keyPriceRef,
      ...appState,
      recent_offers: readRecentOffers(20),
    });
  }

  if (req.method === 'GET' && pathname === '/api/listings') {
    const listings = readState().listings || [];
    // Normalise listings from bp.tf API format or our own saved format
    const normalised = listings.map(l => ({
      intent:     l.intent,
      currencies: l.currencies || {},
      active:     l.active !== false && l.active !== 0,
      item:       { name: (l.item && l.item.name) ? l.item.name : '' }
    }));
    return jsonReply(res, 200, { listings: normalised });
  }

  if (req.method === 'POST' && pathname === '/api/sync') {
    // If already syncing let it finish; if idle start a fresh sync.
    // Either way the client waits 20s then reloads state.
    if (!isSyncing) syncInventoryListings(true).catch(() => {}); // force=true bypasses cooldown
    return jsonReply(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/bump') {
    syncInventoryListings(true).catch(() => {}); // force=true bypasses cooldown
    return jsonReply(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/pending') {
    const offers = Array.from(pendingOffers.entries()).map(([id, info]) => ({
      id,
      ts: new Date(info.ts).toISOString(),
      desc: info.desc,
      age_min: Math.floor((Date.now() - info.ts) / 60000),
    }));
    return jsonReply(res, 200, { offers });
  }

  if (req.method === 'POST' && pathname === '/api/offers/cancel') {
    const body = await readBody(req);
    const cancelOffer = (id) => {
      manager.getOffer(id, (err, offer) => {
        if (!err && offer && offer.state === 2) offer.cancel(() => {});
        pendingOffers.delete(id);
        savePending();
      });
    };
    if (body.id) {
      cancelOffer(body.id);
    } else {
      for (const id of pendingOffers.keys()) cancelOffer(id);
    }
    return jsonReply(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/relist') {
    const body = await readBody(req);
    const name = body.name;
    if (name) {
      const state = readState();
      const ts = state.listing_timestamps || {};
      if (ts[name]) {
        ts[name].firstListedAt = Date.now(); // reset abandonment timer
        ts[name].postedAt = 0;              // force fresh price on next sync
        state.listing_timestamps = ts;
        if (Array.isArray(state.abandoned_items))
          state.abandoned_items = state.abandoned_items.filter(i => i.name !== name);
        writeState(state);
      }
      syncInventoryListings().catch(() => {});
    }
    return jsonReply(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/abandoned') {
    const state = readState();
    return jsonReply(res, 200, { items: state.abandoned_items || [] });
  }

  if (req.method === 'POST' && pathname === '/api/reset-price-history') {
    const state = readState();
    const count = Object.keys(state.listing_timestamps || {}).length;
    state.listing_timestamps = {};
    state.abandoned_items = [];
    writeState(state);
    console.log('[tf2-hub] price history cleared (' + count + ' items reset)');
    return jsonReply(res, 200, { ok: true, cleared: count });
  }

  if (req.method === 'GET' && pathname === '/api/history') {
    try {
      const lines = fs.readFileSync(OFFERS_PATH, 'utf8').trim().split('\n').filter(Boolean);
      const offers = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      // Only ACCEPTED offers contribute to profit. Declined offers' profit field
      // is "what the offer would have been worth" — not actual P&L.
      const days = {};
      let cum = 0;
      const cumulative = offers.map(o => {
        const isAccepted = o.action === 'accept';
        if (isAccepted) cum += (o.profit || 0);
        const day = (o.ts || '').slice(0, 10);
        if (!days[day]) days[day] = { date: day, profit: 0, accepted: 0, declined: 0 };
        if (isAccepted) {
          days[day].profit += (o.profit || 0);
          days[day].accepted++;
        }
        if (o.action === 'decline') days[day].declined++;
        return { ts: o.ts, profit: isAccepted ? +(o.profit || 0).toFixed(4) : 0, cum: +cum.toFixed(4) };
      });
      return jsonReply(res, 200, {
        cumulative: cumulative.slice(-200),
        daily: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)).slice(-14),
        total_profit: +cum.toFixed(4),
      });
    } catch { return jsonReply(res, 200, { cumulative: [], daily: [], total_profit: 0 }); }
  }

  if (req.method === 'GET') {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) return jsonReply(res, 403, { error: 'Forbidden' });
    try {
      if (rel === 'index.html') {
        const ingressPath = (req.headers['x-ingress-path'] || '').replace(/\/$/, '');
        const base = ingressPath ? ingressPath + '/' : '/';
        const html = fs.readFileSync(filePath, 'utf8')
          .replace('<head>', '<head>\n  <base href="' + base + '">');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'text/plain' });
      return res.end(data);
    } catch { return jsonReply(res, 404, { error: 'Not found' }); }
  }

  // Price overrides — GET returns current map, POST sets/clears an entry
  if (req.method === 'GET' && pathname === '/api/price-overrides') {
    const s = readState();
    return jsonReply(res, 200, { overrides: s.ui_price_overrides || {} });
  }

  if (req.method === 'POST' && pathname === '/api/price-override') {
    const body = await readBody(req);
    const { name, price } = body;
    if (!name) return jsonReply(res, 400, { error: 'name required' });
    const s = readState();
    if (!s.ui_price_overrides) s.ui_price_overrides = {};
    if (price === null || price === '' || price === undefined) {
      delete s.ui_price_overrides[name];
    } else {
      const ref = parseFloat(price);
      if (isNaN(ref) || ref < 0) return jsonReply(res, 400, { error: 'invalid price' });
      s.ui_price_overrides[name] = ref;
    }
    writeState(s);
    console.log('[tf2-hub] price override set: ' + name + ' = ' + (price ?? 'cleared'));
    return jsonReply(res, 200, { ok: true });
  }

  return jsonReply(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[tf2-hub] request error:', err.message);
    try { jsonReply(res, 500, { error: 'Internal server error' }); } catch {}
  });
});

server.on('error', err => {
  console.error('[tf2-hub] server error:', err.code, err.message);
  process.exit(1);
});

// ─── Sell Sniping (proactively send offers to buy-order bots) ────────────────

// Scans backpack.tf buy listings for items the bot has in inventory.
// When a buyer is offering more than cost + min_profit, sends them a trade offer.
// This means the bot doesn't just wait for buyers — it hunts them down.
async function snipeBuyOrders() {
  const opts = readOptions();
  // classifieds/search uses key= (API key), NOT token= (user token)
  const apiKey = opts.backpack_tf_api_key;
  if (!apiKey) return;
  console.log('[tf2-hub] sell-snipe: scanning buy orders...');
  let snipeErrors = 0;

  const baseMinProfit = Number(opts.min_profit_ref ?? 0.11);
  const dynamicPct    = Number(opts.dynamic_profit_pct ?? 3);
  const costs = readCosts();

  let inventory;
  try {
    inventory = await new Promise((resolve, reject) =>
      manager.getInventoryContents(440, 2, true, (err, items) =>
        err ? reject(err) : resolve(items)));
  } catch (err) {
    console.error('[tf2-hub] sell-snipe: inventory error:', err.message);
    return;
  }

  // One sell offer per unique item name per cycle
  const seen = new Set();
  for (const item of inventory) {
    if (!item.tradable || CURRENCY_NAMES.has(item.name) || seen.has(item.name)) continue;
    seen.add(item.name);

    await sleep(600); // respect bp.tf rate limit — ~1 req/s across all concurrent callers

    try {
      const data = await httpsGet(
        'https://api.backpack.tf/api/classifieds/search/v1?key='
        + encodeURIComponent(apiKey)
        + '&item=' + encodeURIComponent(item.name)
        + '&intent=buy&tradable=1&page_size=10'
      );

      const listings = (data.buy?.listings || []).filter(
        l => !appState.steam_id || String(l.steamid) !== String(appState.steam_id)
      );

      if (listings.length > 0)
        console.log('[tf2-hub] sell-snipe: ' + item.name + ' — ' + listings.length + ' buy order(s) found');

      for (const listing of listings) {
        const buyerPaysRef = (listing.price?.keys || 0) * keyPriceRef + (listing.price?.metal || 0);
        const cost    = costs[item.assetid] || 0;
        const minP    = effectiveMinProfit(buyerPaysRef, baseMinProfit, dynamicPct);

        // If cost is unknown (0), require buyer to pay at least market price
        // so we don't give away items that were manually added to the inventory.
        let requiredRef;
        if (cost > 0) {
          requiredRef = cost + minP;
        } else {
          const market = await getBuyMarketRef(item.name);
          requiredRef = market ? market - minP : minP;
        }

        if (buyerPaysRef < requiredRef) {
          console.log('[tf2-hub] sell-snipe: ' + item.name + ' buyer ' + buyerPaysRef.toFixed(2) + ' ref < required ' + requiredRef.toFixed(2) + ' ref — skip');
          break; // buy listings sorted highest-first; no point checking lower ones
        }

        // Avoid re-sending to the same buyer this session
        const listingKey = 'sell-' + String(listing.steamid) + '-' + item.name;
        if (sentSnipes.has(listingKey)) { console.log('[tf2-hub] sell-snipe: already sent to buyer ' + listing.steamid + ' this session'); continue; }

        // Skip scammers
        if (await isScammer(String(listing.steamid))) {
          console.log('[tf2-hub] sell-snipe: skipping scammer buyer', listing.steamid);
          continue;
        }

        const tradeUrl = listing.trade_url || listing.user?.trade_url;
        if (!tradeUrl) {
          console.log('[tf2-hub] sell-snipe: buyer ' + listing.steamid + ' has no trade URL — skip');
          continue;
        }

        // Fetch buyer's inventory to grab their currency
        let buyerInv;
        try {
          buyerInv = await new Promise((resolve, reject) =>
            manager.getUserInventoryContents(String(listing.steamid), 440, 2, true, (err, items) =>
              err ? reject(err) : resolve(items)));
        } catch (e) {
          console.error('[tf2-hub] sell-snipe: can\'t load buyer inventory:', e.message);
          continue;
        }

        const theirCurrency = buildCurrencyItems(buyerPaysRef, buyerInv);
        if (!theirCurrency) {
          console.log('[tf2-hub] sell-snipe: buyer ' + listing.steamid + ' lacks currency for ' + buyerPaysRef.toFixed(2) + ' ref — skip');
          continue;
        }

        const profit = +(buyerPaysRef - (cost || requiredRef)).toFixed(4);
        console.log('[tf2-hub] sell-snipe: ' + item.name + ' → buyer ' + String(listing.steamid).slice(-6) + ' @ ' + buyerPaysRef.toFixed(2) + ' ref (+' + profit.toFixed(2) + ' ref)');

        sentSnipes.add(listingKey);

        const sellOffer = manager.createOffer(tradeUrl);
        sellOffer.addMyItems([{ appid: 440, contextid: '2', assetid: item.assetid }]);
        sellOffer.addTheirItems(theirCurrency);
        sellOffer.setMessage('TF2-HA Bot — selling ' + item.name);
        sellOffer.send((err, status) => {
          if (err) {
            console.error('[tf2-hub] sell-snipe send error:', err.message);
            sentSnipes.delete(listingKey);
          } else {
            console.log('[tf2-hub] sell-snipe offer sent', sellOffer.id, status);
            pendingOffers.set(sellOffer.id, { ts: Date.now(), desc: 'Sell: ' + item.name + ' @ ' + buyerPaysRef.toFixed(2) + ' ref' });
            savePending();
            haNotify('TF2 Bot — Sell Offer Sent',
              item.name + ' to ' + String(listing.steamid).slice(-6) + ' for ' + buyerPaysRef.toFixed(2) + ' ref (+' + profit.toFixed(2) + ' ref)');
          }
        });

        break; // one sell offer per item per cycle — don't double-sell
      }
    } catch (err) {
      snipeErrors++;
      // Only log non-rate-limit errors; tally 403/429 and print a summary at the end
      if (!err.message.includes('403') && !err.message.includes('429'))
        console.error('[tf2-hub] sell-snipe error (' + item.name + '):', err.message);
    }
  }
  if (snipeErrors > 0) console.log('[tf2-hub] sell-snipe: ' + snipeErrors + ' item(s) skipped (rate-limited or no access)');
}

// ─── Startup ─────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log('[tf2-hub] v' + VERSION + ' listening on ' + HOST + ':' + PORT);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  fetchKeyPrice().catch(() => {});
  loadTf2Schema().catch(() => {}); // pre-load schema for prices.tf lookups
  login();
  scheduleDailyReset();

  const opts = readOptions();
  const syncMs = Math.max(5, Number(opts.sync_interval_minutes) || 15) * 60 * 1000;
  setInterval(syncListings, syncMs);
  setInterval(fetchKeyPrice, 6 * 60 * 60 * 1000);
  setInterval(() => syncInventoryListings().catch(() => {}), 15 * 60 * 1000); // every 15min = auto-bump
  // snipeClassifieds disabled — bp.tf /search/v1 requires WebSocket now;
  // REST polling caused account ban. Buy listings handle purchasing instead.
  // setInterval(() => guardedSync(snipeClassifieds, 'snipe-classifieds').catch(() => {}), 90 * 1000);
  setInterval(() => guardedSync(snipeBuyOrders, 'snipe-buy-orders').catch(() => {}), 5 * 60 * 1000); // sell to buy-order bots every 5min
  setTimeout(() => guardedSync(snipeBuyOrders, 'snipe-buy-orders-first').catch(() => {}), 60 * 1000); // first run 60s after startup (let login settle)

  // Auto-cancel pending offers older than 30 minutes
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, info] of pendingOffers.entries()) {
      if (info.ts < cutoff) {
        manager.getOffer(id, (err, offer) => {
          if (err || !offer) { pendingOffers.delete(id); savePending(); return; }
          if (offer.state === 2) {
            offer.cancel(() => {
              pendingOffers.delete(id);
              savePending();
              console.log('[tf2-hub] auto-cancelled stale offer', id, '(' + info.desc + ')');
            });
          } else {
            pendingOffers.delete(id);
            savePending();
          }
        });
      }
    }
  }, 5 * 60 * 1000);
});

process.on('SIGTERM', () => {
  console.log('[tf2-hub] SIGTERM — shutting down');
  deleteAllListings()
    .catch(err => console.error('[tf2-hub] shutdown delete error:', err.message))
    .finally(() => {
      client.logOff();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000);
    });
});

process.on('uncaughtException', err => {
  console.error('[tf2-hub] uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', reason => {
  console.error('[tf2-hub] unhandled rejection:', reason);
});
