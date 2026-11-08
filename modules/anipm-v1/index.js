'use strict';
/*
 * AniPM (ani.pm) — Synthetiq Player module
 *
 * 100% ani.pm-native pipeline (no third-party scraping):
 *
 *  Catalogue / metadata (ani.pm API — reachable from every client):
 *    GET /api/anime/home-bootstrap                          -> { hero[], trending[], top[], latest[] }
 *    GET /api/anime/search?q=<query>                        -> { items[] }
 *    GET /api/anime/series/<id>?phase=core                  -> series meta + episodes[] { number, sub, dub, subExact, dubExact, routeId, runtimeSeconds }
 *    GET /api/anime/catalog?page=<n>&limit=30[&sort=...|&genre=...]
 *                                                            -> { items[], page, lastPage, total, hasNextPage } (8,900+ titles)
 *
 *  Playback — two independent engines, composed per request:
 *
 *  1) "AniPM" route — settlar embed service (via ani.pm):
 *     GET /api/anime/playback-bootstrap/<source>/<id>?ep=<n>&lang=<sub|dub>&backup=1
 *                                                            -> { availability{sub,dub}, settlarSelection, skip{op,ed}, backupEmbed, ... }
 *     GET /api/anime/settlar/session?selection=<sel>&provider=anipm&ep=<n>&channel=<sub|dub>&telemetry=0
 *                                                            -> { embedUrl: https://embed.settlar.io/embed/v1?t=<token> }
 *     GET https://embed.settlar.io/api/embed/session?t=<token> -> { source: <master m3u8 on media.settlar.io>, kind:"hls", subtitles[] }
 *     NOTE: embed.settlar.io / media.settlar.io sit behind Cloudflare protection that
 *     only admits browser-class TLS stacks (NSURLSession, browsers). The app's iOS
 *     CupertinoClient passes; dart:io (macOS/Windows/Android/Linux) and the Node test
 *     harness receive a 403 challenge page. The module detects that challenge, marks the
 *     settlar engine unavailable for this app run (settlarBlockedUntil) and relies on the
 *     MegaPlay engine below. Never retry-loop into the challenge.
 *
 *  2) "MegaPlay" route — backup embed named by ani.pm's bootstrap (backupEmbed):
 *     GET <backupEmbed.url>            (https://megaplay.buzz/stream/s-2/<id>/<sub|dub>)
 *                                      -> HTML with data-id
 *     GET https://megaplay.buzz/stream/getSourcesNew?id=<dataId>&id=<dataId>&type=<lang>
 *         (fallback: /stream/getSources?id=...) 
 *                                      -> { tracks[], intro{start,end}, outro{start,end}, enc }
 *     `enc` is AES-CBC (key "i?LMTAx0Q6,:}50U" zero-padded to 32B, IV "W0;27ToaUpl_P%'c",
 *     base64url ciphertext, JSON plaintext { file: <master m3u8> }) — pure-Array AES, no
 *     typed arrays, ported from the qualified AniKoto module (same site-published scheme).
 *     Media host: fetch.nexabloom.top (AniKage family) — REQUIRES Referer https://megaplay.buzz/
 *     on playlists, segments and caption files (403 without it). Segments use the AniKage
 *     8-class name rotation (.jpg/.html/.js/.css/.txt/.png/.webp/.ico), genuine MPEG-TS.
 *     On Apple/Windows the app's session HLS proxy maps every class except `.html` into the
 *     working /segment.ts sniff path; `.html` refs (1-in-8) hit the released app's /segment.mp4
 *     dispatch defect (app-side fix exists; not module-fixable). Android (ExoPlayer direct)
 *     and the app runtime are unaffected.
 *
 *  Skip markers: prefer the bootstrap `skip` (settlar), else the MegaPlay intro/outro.
 *  Language: sub/dub decided from bootstrap availability; a mismatch serves the
 *  available channel labelled as what it is (never silently substituted).
 *
 *  Home: discovery_v1 — Featured hero + poster rows + an endless "All Anime" grid
 *  driven by catalogue pagination. Legacy search('') home preserved as the
 *  fallback path for hosts without discovery support.
 *  Captions: the MegaPlay caption set (reachable host + per-track gate headers) is
 *  preferred and mirrored onto the settlar route — media.settlar.io caption URLs
 *  answer non-NSURLSession clients with a 403 and the app's cue loader is dart:io
 *  on every platform, so settlar-only caption sets never render in the player.
 */

var BASE = 'https://ani.pm';
var EMBED = 'https://embed.settlar.io';
var MEDIA_HOST = 'media.settlar.io';
var MEGAPLAY_HOST = 'megaplay.buzz';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

var SERIES_TTL = 10 * 60 * 1000;
var STREAM_TTL = 3 * 60 * 1000;
var NEG_TTL = 25 * 1000;
var SETTLAR_BLOCK_TTL = 20 * 60 * 1000;

var seriesCache = {};
var streamCache = {};
var settlarBlockedUntil = 0;

/* ------------------------------------------------------------------ */
/* Fetch handling                                                       */
/* ------------------------------------------------------------------ */

function jsonHeaders() {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Origin': BASE,
    'Referer': BASE + '/'
  };
}

function embedHeaders(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Origin': EMBED,
    'Referer': referer && referer.indexOf(EMBED) === 0 ? referer : EMBED + '/'
  };
}

/* The bridge delivers JSON bodies either as text or as a parsed json()
 * payload with an EMPTY body string — read defensively, in that order. */
async function readPayload(res) {
  if (!res) return '';
  var text = '';
  try {
    if (typeof res.text === 'function') text = await res.text();
  } catch (e) { text = ''; }
  if (!text && typeof res.body === 'string' && res.body) text = res.body;
  if (!text && typeof res.json === 'function') {
    try {
      var parsed = await res.json();
      if (parsed !== undefined && parsed !== null) text = JSON.stringify(parsed);
    } catch (e2) { /* no json payload */ }
  }
  return text;
}

async function fetchRaw(url, headers) {
  var attempts = 2;
  var last = { status: 0, text: '' };
  for (var i = 0; i < attempts; i += 1) {
    try {
      if (typeof fetchv2 !== 'function') throw new Error('fetchv2 unavailable');
      var res = await fetchv2(url, headers, 'GET', null);
      var status = res && typeof res.status === 'number' ? res.status : 0;
      var text = await readPayload(res);
      last = { status: status, text: text };
      if (status >= 200 && status < 300 && text) return last;
    } catch (e) {
      last = { status: last.status, text: '' };
    }
  }
  return last;
}

async function getJson(url, headers) {
  var res = await fetchRaw(url, headers);
  if (res.status < 200 || res.status >= 300 || !res.text) throw new Error('http ' + (res.status || 'error'));
  return JSON.parse(res.text);
}

function isCloudflareChallenge(res) {
  if (!res || (res.status !== 403 && res.status !== 503)) return false;
  var text = String(res.text || '');
  if (text.indexOf('<') !== 0) return false;
  return /cloudflare|attention required|just a moment|cf-error/i.test(text.slice(0, 4000));
}

/* ------------------------------------------------------------------ */
/* Small string helpers (no URL/URLSearchParams in the app runtime)     */
/* ------------------------------------------------------------------ */

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function absolute(url) {
  var u = clean(url);
  if (!u) return '';
  if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) return u;
  return BASE + (u.charAt(0) === '/' ? u : '/' + u);
}

function hostOf(url) {
  var s = String(url || '');
  var i = s.indexOf('://');
  if (i < 0) return '';
  var rest = s.slice(i + 3);
  var slash = rest.indexOf('/');
  var host = slash < 0 ? rest : rest.slice(0, slash);
  var at = host.indexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  var colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  return host.toLowerCase();
}

function queryParam(url, name) {
  var s = String(url || '');
  var qi = s.indexOf('?');
  if (qi < 0) return '';
  var parts = s.slice(qi + 1).split('&');
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    if (parts[i].slice(0, eq) === name) {
      var raw = parts[i].slice(eq + 1);
      try { return decodeURIComponent(raw.replace(/\+/g, '%20')); } catch (e) { return raw; }
    }
  }
  return '';
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/* href scheme: series `anipm:<id>`, episode `anipm:<id>:e<number>`.
 * The app may hand these back URL-wrapped (e.g. https://ani.pm/anipm:1642:e1) —
 * parse from the LAST scheme occurrence and accept both forms. */
function parseRef(href) {
  var s = String(href == null ? '' : href);
  var m = /anipm:(?:[a-z0-9_-]{1,24}:)?(\d{1,9})(?::e(\d{1,6}))?/i.exec(s);
  if (!m) {
    m = /(\d{1,9})(?::e(\d{1,6}))?/.exec(s);
    if (!m) return null;
  }
  return { id: Number(m[1]), ep: m[2] ? Number(m[2]) : null };
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                            */
/* ------------------------------------------------------------------ */

function cardFor(item) {
  if (!item || item.id == null) return null;
  var title = clean(item.title || item.native || '');
  if (!title) return null;
  return {
    href: 'anipm:' + item.id,
    title: title,
    image: absolute(item.poster || item.banner || ''),
    id: String(item.id)
  };
}

function cardsFor(items, cap) {
  var seen = {};
  var out = [];
  if (!items || !items.length) return out;
  for (var i = 0; i < items.length && out.length < cap; i++) {
    var card = cardFor(items[i]);
    if (!card || seen[card.href]) continue;
    seen[card.href] = 1;
    out.push(card);
  }
  return out;
}

async function searchResults(query) {
  var q = typeof query === 'string' ? query.trim() : '';
  try {
    if (!q) {
      var home = await getJson(BASE + '/api/anime/home-bootstrap', jsonHeaders());
      var merged = [].concat(home.hero || [], home.trending || []);
      return cardsFor(merged, 30);
    }
    var res = await getJson(BASE + '/api/anime/search?q=' + encodeURIComponent(q), jsonHeaders());
    return cardsFor((res && res.items) || [], 40);
  } catch (e) {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Discovery v1 (config.capabilities.discovery_v1)                      */
/* ------------------------------------------------------------------ */

function feedPath(feed, page) {
  var p = Math.max(1, Math.min(5000, parseInt(page, 10) || 1));
  var base = '/api/anime/catalog?page=' + p + '&limit=30';
  var f = String(feed == null ? '' : feed).toLowerCase();
  if (f === 'romance') return base + '&genre=Romance&sort=trending';
  if (f === 'popular') return base + '&sort=popular';
  if (f === 'trending' || f === 'weekly') return base + '&sort=trending';
  return base;
}

async function discoveryFeed(feedId, page) {
  var p = Math.max(1, parseInt(page, 10) || 1);
  try {
    var data = await getJson(BASE + feedPath(feedId, p), jsonHeaders());
    var items = cardsFor(data && data.items, 30);
    var reported = data && Number(data.page) > 0 ? Number(data.page) : p;
    return {
      items: items,
      page: reported,
      hasMore: !!(data && data.hasNextPage === true) && items.length > 0
    };
  } catch (e) {
    return { items: [], page: p, hasMore: false };
  }
}

async function discoveryHome() {
  var sections = [];

  /* Row sources are independent — one failing call must never empty the home. */
  try {
    var boot = await getJson(BASE + '/api/anime/home-bootstrap', jsonHeaders());
    var hero = cardsFor(boot && boot.hero, 8);
    if (hero.length) {
      sections.push({ id: 'featured', title: 'Featured', style: 'hero', items: hero });
    }
    var weekly = cardsFor(boot && boot.trending, 30);
    if (weekly.length) {
      sections.push({
        id: 'weekly', title: 'Top Weekly', style: 'poster', items: weekly,
        viewAll: { mode: 'feed', feedId: 'trending' }
      });
    }
    var latest = cardsFor(boot && boot.latest, 30);
    if (latest.length) {
      sections.push({ id: 'latest', title: 'Latest Episodes', style: 'poster', items: latest });
    }
  } catch (eBoot) { /* bootstrap rows are optional */ }

  var rows = [
    { id: 'romance', title: 'Top Romance', feed: 'romance' },
    { id: 'popular', title: 'Most Popular', feed: 'popular' }
  ];
  for (var i = 0; i < rows.length; i++) {
    try {
      var d = await getJson(BASE + feedPath(rows[i].feed, 1), jsonHeaders());
      var items = cardsFor(d && d.items, 30);
      if (items.length) {
        sections.push({
          id: rows[i].id, title: rows[i].title, style: 'poster', items: items,
          viewAll: { mode: 'feed', feedId: rows[i].feed }
        });
      }
    } catch (eRow) { /* skip this row only */ }
  }

  /* The LAST poster section with a feed becomes the app's vertical grid — the
   * one that keeps loading as the user scrolls. All Anime is the endless one:
   * ani.pm's catalogue carries 8,900+ titles over ~299 source pages. */
  try {
    var cat = await getJson(BASE + feedPath('all', 1), jsonHeaders());
    var all = cardsFor(cat && cat.items, 30);
    if (all.length) {
      sections.push({
        id: 'all-anime', title: 'All Anime', style: 'poster', items: all,
        viewAll: { mode: 'feed', feedId: 'all' }
      });
    }
  } catch (eAll) { /* grid is optional too */ }

  return { sections: sections };
}

async function loadSeries(id) {
  var key = String(id);
  var hit = seriesCache[key];
  if (hit && (Date.now() - hit.at) < SERIES_TTL) return hit.value;
  var data = await getJson(BASE + '/api/anime/series/' + encodeURIComponent(key) + '?phase=core', jsonHeaders());
  if (!data || typeof data !== 'object' || data.id == null) throw new Error('AniPM series unavailable');
  seriesCache[key] = { at: Date.now(), value: data };
  if (Object.keys(seriesCache).length > 60) seriesCache = {};
  return data;
}

async function extractDetails(href) {
  var ref = parseRef(href);
  if (!ref || !ref.id) return { title: '', description: '' };
  var s = await loadSeries(ref.id);
  return {
    title: clean(s.title || ''),
    description: typeof s.synopsis === 'string' ? s.synopsis : '',
    image: absolute(s.poster || ''),
    author: Array.isArray(s.studios) ? s.studios.join(', ') : '',
    status: clean(s.status || ''),
    genres: Array.isArray(s.genres) ? s.genres : [],
    year: s.year
  };
}

async function extractEpisodes(href) {
  var ref = parseRef(href);
  if (!ref || !ref.id) return [];
  var s = await loadSeries(ref.id);
  var eps = Array.isArray(s.episodes) ? s.episodes : [];
  var out = [];
  for (var i = 0; i < eps.length; i++) {
    var e = eps[i];
    if (!e || !(Number(e.number) > 0)) continue;
    out.push({
      number: e.number,
      href: 'anipm:' + ref.id + ':e' + e.number,
      title: clean(e.title) || ('Episode ' + e.number),
      subAvailable: e.sub === true,
      dubAvailable: e.dub === true
    });
  }
  out.sort(function (a, b) { return a.number - b.number; });
  return out;
}

/* ------------------------------------------------------------------ */
/* AES-CBC payload decryption (megaplay `enc` field)                    */
/* Scheme published by the host's own newclient.min.js; pure ES5,       */
/* no typed arrays — ported from the qualified AniKoto module.          */
/* ------------------------------------------------------------------ */

const PLAYER_PAYLOAD_KEY = 'i?LMTAx0Q6,:}50U';
const PLAYER_PAYLOAD_IV = "W0;27ToaUpl_P%'c";
const AES_SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
];
var AES_INV_SBOX = null;
function aesInvSbox() {
  if (AES_INV_SBOX) return AES_INV_SBOX;
  var inv = new Array(256);
  for (var i = 0; i < 256; i += 1) inv[AES_SBOX[i]] = i;
  AES_INV_SBOX = inv;
  return inv;
}
const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d];
function aesExpandKey256(keyBytes) {
  const Nk = 8;
  const total = 60;
  const w = new Array(total);
  for (let i = 0; i < Nk; i += 1) {
    w[i] = (((keyBytes[4 * i] & 255) << 24) | ((keyBytes[4 * i + 1] & 255) << 16) | ((keyBytes[4 * i + 2] & 255) << 8) | (keyBytes[4 * i + 3] & 255)) >>> 0;
  }
  for (let i = Nk; i < total; i += 1) {
    let t = w[i - 1];
    if (i % Nk === 0) {
      t = ((t << 8) | (t >>> 24)) >>> 0;
      t = ((AES_SBOX[(t >>> 24) & 255] << 24) | (AES_SBOX[(t >>> 16) & 255] << 16) | (AES_SBOX[(t >>> 8) & 255] << 8) | AES_SBOX[t & 255]) >>> 0;
      t = (t ^ ((AES_RCON[(i / Nk) - 1] & 255) << 24)) >>> 0;
    } else if (i % Nk === 4) {
      t = ((AES_SBOX[(t >>> 24) & 255] << 24) | (AES_SBOX[(t >>> 16) & 255] << 16) | (AES_SBOX[(t >>> 8) & 255] << 8) | AES_SBOX[t & 255]) >>> 0;
    }
    w[i] = (w[i - Nk] ^ t) >>> 0;
  }
  return w;
}
function gfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i += 1) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 255;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 255;
}
function aesDecryptBlock(block16, w) {
  const inv = aesInvSbox();
  const s = block16.slice(0);
  let i;
  const addRoundKey = function (round) {
    const base = 4 * round;
    for (let j = 0; j < 16; j += 1) s[j] ^= (w[base + (j >> 2)] >>> (24 - 8 * (j & 3))) & 255;
  };
  addRoundKey(14);
  for (let round = 13; round >= 0; round -= 1) {
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    for (i = 0; i < 16; i += 1) s[i] = inv[s[i]];
    addRoundKey(round);
    if (round > 0) {
      for (let c = 0; c < 4; c += 1) {
        const a0 = s[4 * c]; const a1 = s[4 * c + 1]; const a2 = s[4 * c + 2]; const a3 = s[4 * c + 3];
        s[4 * c] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
        s[4 * c + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
        s[4 * c + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
        s[4 * c + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
      }
    }
  }
  return s;
}
const B64URL_LOOKUP = (function () {
  const table = {};
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charAt(i)] = i;
  return table;
})();
function base64UrlBytes(value) {
  const s = String(value || '').replace(/\+/g, '-').replace(/\//g, '_');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charAt(i);
    if (c === '=') break;
    const v = B64URL_LOOKUP[c];
    if (v === undefined) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return out;
}
function bytesToText(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
    else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3;
    } else if (b >= 0xf0 && i + 3 < bytes.length) {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const adj = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff)); i += 4;
    } else { out += String.fromCharCode(b); i += 1; }
  }
  return out;
}
function playerPayloadKeyBytes() {
  const bytes = [];
  for (let i = 0; i < 32; i += 1) bytes.push(i < PLAYER_PAYLOAD_KEY.length ? PLAYER_PAYLOAD_KEY.charCodeAt(i) & 255 : 0);
  return bytes;
}
function decryptPlayerPayload(enc) {
  try {
    if (!enc || typeof enc !== 'string') return null;
    const bytes = base64UrlBytes(enc);
    if (!bytes.length || bytes.length % 16 !== 0) return null;
    const iv = [];
    for (let i = 0; i < 16; i += 1) iv.push(PLAYER_PAYLOAD_IV.charCodeAt(i) & 255);
    const w = aesExpandKey256(playerPayloadKeyBytes());
    const plainBytes = [];
    let prev = iv;
    for (let off = 0; off + 16 <= bytes.length; off += 16) {
      const block = bytes.slice(off, off + 16);
      const dec = aesDecryptBlock(block, w);
      for (let i = 0; i < 16; i += 1) plainBytes.push(dec[i] ^ prev[i]);
      prev = block;
    }
    // PKCS#7 unpad (only when the padding is well formed).
    let outBytes = plainBytes;
    const pad = outBytes.length ? outBytes[outBytes.length - 1] : 0;
    if (pad > 0 && pad <= 16 && pad <= outBytes.length) {
      let ok = true;
      for (let k = 0; k < pad; k += 1) if (outBytes[outBytes.length - 1 - k] !== pad) { ok = false; break; }
      if (ok) outBytes = outBytes.slice(0, outBytes.length - pad);
    }
    const text = bytesToText(outBytes).trim();
    const json = safeJsonParse(text);
    if (json && typeof json === 'object') return json;
    if (/^https?:\/\//i.test(text)) return { file: text };
    return null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Playback helpers                                                     */
/* ------------------------------------------------------------------ */

function pairRange(range) {
  if (!range || typeof range !== 'object') return null;
  var a = Number(range.start);
  var b = Number(range.end);
  if (!isFinite(a) || !isFinite(b) || a < 0 || b <= a) return null;
  return [a, b];
}

function skipFromRanges(op, ed) {
  var out = {};
  var o = pairRange(op), e = pairRange(ed);
  if (o) { out.introStart = o[0]; out.introEnd = o[1]; }
  if (e) { out.outroStart = e[0]; out.outroEnd = e[1]; }
  if (o || e) {
    out.skip = {};
    if (o) out.skip.op = { start: o[0], end: o[1] };
    if (e) out.skip.ed = { start: e[0], end: e[1] };
  }
  return out;
}

function skipFromBootstrap(skip) {
  if (!skip || typeof skip !== 'object') return {};
  return skipFromRanges(skip.op, skip.ed);
}

function mapSubtitles(list) {
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length && out.length < 20; i++) {
    var t = list[i];
    if (!t || typeof t.url !== 'string' || t.url.indexOf('https://') !== 0) continue;
    var code = clean(t.srclang || t.lang || t.language || '').toLowerCase();
    var item = {
      url: t.url,
      label: clean(t.label || t.name || code || 'Subtitle') || 'Subtitle',
      language: code
    };
    if (t.default === true) item.default = true;
    out.push(item);
  }
  return out;
}

function mapMegaTracks(tracks) {
  var out = [];
  if (!Array.isArray(tracks)) return out;
  /* The caption host (hiddenvertex.top) enforces the same megaplay referer gate
   * as the media host — carry it on every track so any client that fetches a
   * track directly (without merging the route headers) still gets 200. */
  var trackHeaders = {
    'Referer': 'https://' + MEGAPLAY_HOST + '/',
    'Origin': 'https://' + MEGAPLAY_HOST
  };
  for (var i = 0; i < tracks.length && out.length < 20; i++) {
    var t = tracks[i];
    if (!t || typeof t.file !== 'string' || t.file.indexOf('https://') !== 0) continue;
    var label = clean(t.label || t.name || 'Subtitle') || 'Subtitle';
    var code = /^english/i.test(label) ? 'en' : clean(t.srclang || t.language || '').toLowerCase();
    var item = { url: t.file, label: label, language: code, headers: trackHeaders };
    if (t.default === true) item.default = true;
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* settlar engine ("AniPM" route)                                       */
/* ------------------------------------------------------------------ */

async function trySettlarRoute(boot, num, channel, cacheKey) {
  var selection = boot && typeof boot.settlarSelection === 'string' ? boot.settlarSelection : '';
  if (!selection || selection.length < 16) return null;
  var session;
  try {
    session = await getJson(
      BASE + '/api/anime/settlar/session?selection=' + encodeURIComponent(selection) +
        '&provider=anipm&ep=' + encodeURIComponent(String(num)) +
        '&channel=' + encodeURIComponent(channel) + '&telemetry=0',
      jsonHeaders()
    );
  } catch (e) { return null; }
  var embedUrl = session && typeof session.embedUrl === 'string' ? session.embedUrl : '';
  if (embedUrl.indexOf(EMBED + '/') !== 0) return null;
  var token = queryParam(embedUrl, 't');
  if (!token) return null;
  var res = await fetchRaw(EMBED + '/api/embed/session?t=' + encodeURIComponent(token), embedHeaders(embedUrl));
  if (isCloudflareChallenge(res)) {
    settlarBlockedUntil = Date.now() + SETTLAR_BLOCK_TTL;
    return null;
  }
  if (res.status < 200 || res.status >= 300 || !res.text) return null;
  var embedSession = safeJsonParse(res.text);
  if (!embedSession || typeof embedSession !== 'object') return null;
  var mediaUrl = typeof embedSession.source === 'string' ? embedSession.source : '';
  if (!mediaUrl || mediaUrl.indexOf('https://') !== 0 || hostOf(mediaUrl) !== MEDIA_HOST) return null;
  if (embedSession.kind && embedSession.kind !== 'hls') return null;
  return {
    label: 'AniPM · ' + (channel === 'dub' ? 'Dub' : 'Sub'),
    server: 'AniPM',
    url: mediaUrl,
    lang: channel,
    subtitles: mapSubtitles(embedSession.subtitles)
  };
}

/* ------------------------------------------------------------------ */
/* MegaPlay engine ("MegaPlay" route)                                   */
/* ------------------------------------------------------------------ */

function megaPlayPageMeta(html) {
  var source = String(html || '');
  var playerId = (source.match(/data-id=["'](\d{1,12})["']/i) || [])[1] || '';
  var typeMatch = source.match(/type:\s*['"](sub|dub|hsub)['"]/i);
  return {
    playerId: clean(playerId),
    type: typeMatch ? typeMatch[1].toLowerCase() : ''
  };
}

function megaSourceUrl(decrypted) {
  if (!decrypted) return '';
  var candidate = '';
  if (typeof decrypted.file === 'string') candidate = decrypted.file;
  else if (typeof decrypted.url === 'string') candidate = decrypted.url;
  else if (Array.isArray(decrypted.sources) && decrypted.sources.length) {
    var first = decrypted.sources[0] || {};
    candidate = first.file || first.url || '';
  } else if (decrypted.sources && typeof decrypted.sources === 'object') {
    candidate = decrypted.sources.file || decrypted.sources.url || '';
  }
  candidate = clean(candidate);
  if (!candidate || candidate.indexOf('https://') !== 0) return '';
  return candidate;
}

async function tryMegaPlayRoute(backupEmbed, channel, cacheKey) {
  var pageUrl = backupEmbed && typeof backupEmbed.url === 'string' ? backupEmbed.url : '';
  if (!pageUrl || pageUrl.indexOf('https://') !== 0) return null;
  if (hostOf(pageUrl) !== MEGAPLAY_HOST) return null;

  var page = await fetchRaw(pageUrl, {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': BASE + '/'
  });
  if (page.status < 200 || page.status >= 300 || !page.text) return null;
  var meta = megaPlayPageMeta(page.text);
  if (!meta.playerId) return null;

  var type = meta.type && meta.type !== 'hsub' ? meta.type : channel;
  var headers = {
    'User-Agent': UA,
    'Referer': 'https://' + MEGAPLAY_HOST + '/',
    'Origin': 'https://' + MEGAPLAY_HOST,
    'Accept': 'application/json, text/javascript, */*; q=0.01'
  };
  var idParam = 'id=' + encodeURIComponent(meta.playerId);
  var sourceData = null;
  try {
    sourceData = await getJson('https://' + MEGAPLAY_HOST + '/stream/getSourcesNew?' + idParam + '&' + idParam + '&type=' + encodeURIComponent(type), headers);
  } catch (e) {
    try {
      sourceData = await getJson('https://' + MEGAPLAY_HOST + '/stream/getSources?' + idParam + '&' + idParam + '&type=' + encodeURIComponent(type), headers);
    } catch (e2) { sourceData = null; }
  }
  if (!sourceData || typeof sourceData !== 'object') return null;

  var mediaUrl = megaSourceUrl(sourceData);
  if (!mediaUrl && sourceData.enc) {
    mediaUrl = megaSourceUrl(decryptPlayerPayload(sourceData.enc));
  }
  if (!mediaUrl) return null;

  var route = {
    label: 'MegaPlay · ' + (channel === 'dub' ? 'Dub' : 'Sub'),
    server: 'MegaPlay',
    url: mediaUrl,
    lang: channel,
    headers: {
      'Referer': 'https://' + MEGAPLAY_HOST + '/',
      'Origin': 'https://' + MEGAPLAY_HOST
    },
    subtitles: mapMegaTracks(sourceData.tracks)
  };
  return { route: route, intro: sourceData.intro, outro: sourceData.outro };
}

/* ------------------------------------------------------------------ */
/* extractStreamUrl                                                     */
/* ------------------------------------------------------------------ */

function markFail(cacheKey) {
  if (!cacheKey) return;
  streamCache[cacheKey] = { at: Date.now(), ok: false };
}

async function extractStreamUrl(episodeHref, lang) {
  var ref = parseRef(episodeHref);
  if (!ref || !ref.id || !ref.ep) return null;
  var id = ref.id;
  var num = ref.ep;
  var wanted = String(lang == null ? 'sub' : lang).toLowerCase().indexOf('dub') === 0 ? 'dub' : 'sub';
  var cacheKey = '';

  try {
    var source = 'settlar';
    try {
      var series = await loadSeries(id);
      if (series && typeof series.source === 'string' && /^[a-z0-9_-]{1,24}$/.test(series.source)) {
        source = series.source;
      }
    } catch (eSeries) { /* series is a hint here; bootstrap is the authority */ }

    cacheKey = source + ':' + id + ':' + num + ':' + wanted;
    var cached = streamCache[cacheKey];
    if (cached) {
      var age = Date.now() - cached.at;
      if (cached.ok && age < STREAM_TTL) return cached.value;
      if (!cached.ok && age < NEG_TTL) return { streams: [] };
    }

    function bootUrl(forLang) {
      return BASE + '/api/anime/playback-bootstrap/' + encodeURIComponent(source) + '/' +
        encodeURIComponent(String(id)) + '?ep=' + encodeURIComponent(String(num)) +
        '&lang=' + encodeURIComponent(forLang) + '&backup=1';
    }

    var boot = await getJson(bootUrl(wanted), jsonHeaders());

    var availability = (boot && boot.availability) || {};
    var channel = wanted;
    if (availability[wanted] !== true) {
      /* Honest fallback: serve the language that exists, labelled as what it is.
       * Never substituted silently — the route carries the real channel. */
      var other = wanted === 'dub' ? 'sub' : 'dub';
      if (availability[other] === true) {
        channel = other;
        /* The backup embed is language-specific — refetch for the channel we use. */
        try { boot = await getJson(bootUrl(channel), jsonHeaders()); } catch (e2) { /* keep first boot */ }
      } else {
        markFail(cacheKey);
        return { streams: [] };
      }
    }

    var settlarRoute = null;
    if (Date.now() >= settlarBlockedUntil) {
      try { settlarRoute = await trySettlarRoute(boot, num, channel, cacheKey); } catch (eS) { settlarRoute = null; }
    }

    var mega = null;
    if (boot && boot.backupEmbed && boot.backupEmbed.available === true) {
      try { mega = await tryMegaPlayRoute(boot.backupEmbed, channel, cacheKey); } catch (eM) { mega = null; }
    }

    var routes = [];
    /* Default-route policy (0.1.0-beta.4): MegaPlay first. The app's default
     * stream is ALSO the stream its downloader fetches, and that downloader
     * (dart:io) only understands STREAM-INF variants - never EXT-X-MEDIA audio
     * renditions - and the settlar media host answers non-NSURLSession clients
     * with a Cloudflare 403 (see the caption note below). Making the muxed,
     * dart-reachable engine the default keeps downloads audible and removes
     * A/V drift; the AniPM (settlar) engine stays as the alternate server. */
    if (mega && mega.route) routes.push(mega.route);
    if (settlarRoute) routes.push(settlarRoute);
    if (!routes.length) {
      markFail(cacheKey);
      return { streams: [] };
    }

    var result = { streams: routes, streamType: 'hls' };

    /* Caption reachability: media.settlar.io answers every non-NSURLSession client
     * with a Cloudflare 403, and the APP's cue loader is dart:io on ALL platforms
     * including iOS — so settlar-hosted caption URLs can never load in the player.
     * Prefer the MegaPlay caption set (dart-reachable host, per-track gate headers)
     * and mirror it onto the settlar route as well, so the caption menu works
     * whichever engine the player ends up using. */
    var megaTracks = (mega && mega.route && mega.route.subtitles) || [];
    var settlarTracks = (settlarRoute && settlarRoute.subtitles) || [];
    var subtitles = megaTracks.length ? megaTracks : settlarTracks;
    if (settlarRoute && megaTracks.length) settlarRoute.subtitles = megaTracks;
    if (subtitles.length) result.subtitles = subtitles;

    var markers = skipFromBootstrap(boot.skip);
    if (!markers.introStart && !markers.outroStart && mega) {
      markers = skipFromRanges(mega.intro, mega.outro);
    }
    for (var key in markers) {
      if (Object.prototype.hasOwnProperty.call(markers, key)) result[key] = markers[key];
    }

    streamCache[cacheKey] = { at: Date.now(), ok: true, value: result };
    if (Object.keys(streamCache).length > 80) streamCache = {};
    return result;
  } catch (e) {
    markFail(cacheKey);
    return { streams: [] };
  }
}

/* ------------------------------------------------------------------ */

globalThis.searchResults = searchResults;
globalThis.extractDetails = extractDetails;
globalThis.extractEpisodes = extractEpisodes;
globalThis.extractStreamUrl = extractStreamUrl;
globalThis.discoveryHome = discoveryHome;
globalThis.discoveryFeed = discoveryFeed;
