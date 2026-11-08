/**
 * Alpha Movies — private test candidate (independent movies/TV playback).
 *
 * INDEPENDENCE CONTRACT (enforced in code and asserted by tests):
 *  - Catalogue: Wikipedia + Wikidata (film P4947 / TV P4983) + TVMaze (episodes).
 *    Missing artwork can use the exact TMDB page's public OpenGraph poster. No API key required.
 *    The aggregator site that prompted this module (7reels.cc and every
 *    subdomain/mirror) is on a hard denylist and can never be requested — see DENY_HOSTS.
 *  - Identity: a Wikidata QID / TMDB id taken from the catalogue entry the user tapped. No page
 *    scraping of any aggregator.
 *  - Providers — each addressed DIRECTLY (no aggregator pages; multi-source since 0.2.0):
 *      1) vidrock.net API by TMDB id (below); 2) api.speedracelight.com "videasy" (XOR-keystream
 *         payload, pure JS, English endpoints); 3) streamingunity.vip -> vixcloud.co English HLS
 *         (works from phone IPs only). Every candidate keeps its own headers, and validation is
 *         positive-media only.
 *    Vidrock detail:
 *      GET /api/movie/<tmdbId>          -> {ServerName: {url, type, language?, flag?}}
 *      GET /api/tv/<tmdbId>/<s>/<e>     -> same
 *    The `url` field is AES-256-GCM encrypted (base64url: 12-byte IV || ciphertext || 16-byte tag).
 *    The key is a 32-byte constant published in the provider's own client bundle, and the API itself
 *    is unauthenticated; decryption is implemented here in PURE JS because the app's JS sandbox is
 *    not guaranteed to expose WebCrypto. No authentication, DRM or paywall is involved.
 *  - Streams need the provider's Referer (and Origin for the worker-hosted server); those ride on
 *    every candidate route and are dropped when a route is rejected.
 *
 * RUNTIME RULES OBEYED (hard-won):
 *  - NO timers anywhere: the app's JS sandbox does not pump setTimeout created inside a module call.
 *    Every deadline is a bounded request count plus Date.now() checks BETWEEN steps.
 *  - Positive media validation only: a playlist must parse, a variant must list segments, and a
 *    segment must carry a recognised container signature (TS sync / fMP4 boxes / PNG-wrapped TS).
 *  - Flag semantics: a positive provider verdict is the only thing that clears availability;
 *    "could not ask" never hides a route.
 */
(function () {
  'use strict';

  var MODULE_TAG = '[Alpha Movies]';

  // ---------------------------------------------------------------- hosts
  var WIKI = 'https://en.wikipedia.org';
  var WIKIDATA = 'https://query.wikidata.org';
  var WIKIDATA_API = 'https://www.wikidata.org';
  var TVMAZE = 'https://api.tvmaze.com';
  // Posters load through the One poster proxy (one.synthetiq.uk). Wikimedia throttles burst
  // image loads by User-Agent — generic UAs (the app's image loader included) get 429s and
  // posters silently drop — while the proxy sends a descriptive UA and caches to disk + CDN
  // edge, so a full page of posters resolves on first fill and stays warm afterwards.
  // Only the exact shapes the proxy accepts are rewritten; everything else passes through.
  var IMG_PROXY = 'https://one.synthetiq.uk/v1/img/wiki/';
  var IMG_ORIGIN_RE = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/((?:en|commons)\/(?:thumb\/)?[0-9a-f]{1,2}\/[0-9a-f]{1,2}\/[^?#]+)$/;
  function posterProxy(url) {
    if (!url) return url;
    var m = String(url).split('?')[0].match(IMG_ORIGIN_RE);
    return m ? IMG_PROXY + m[1] : url;
  }
  var PROVIDER = 'https://vidrock.net';
  // Multi-provider expansion — every provider is addressed DIRECTLY (no aggregator pages):
  //  2) videasy        api.speedracelight.com, XOR-keystream payload (pure JS), English endpoints
  //  3) streamunity    streamingunity.vip -> vixcloud.co, works from phone IPs only
  var VIDEASY_API = 'https://api.speedracelight.com';
  var VIDORA = 'https://moviesapi.to/api/vidora';
  var VIDORA_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';
  var VIDEASY_PLAYER = 'https://player.videasy.to';
  var STREAMUNITY = 'https://streamingunity.vip';
  var VIX = 'https://vixcloud.co';
  var USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  // Wikidata/Wikipedia ask for a descriptive agent on the SPARQL endpoint; the browser-ish agent is
  // used for the CDN-bearing provider calls.
  var SPARQL_AGENT = 'SynthetiqAlphaMovies/0.1 (Synthetiq Player module; +https://one.synthetiq.uk)';

  // The aggregator this module exists to NOT depend on. Never fetched, not even for a redirect.
  var DENY_HOSTS = ['7reels.cc', 'www.7reels.cc', 'app.7reels.cc', 'analytics.7reels.cc'];
  var DENY_RE = /(^|\.)7reels\.(cc|to|net|com)$/i;

  var trace = { requests: [], blocked: [], probes: 0, decrypted: 0, decryptFailed: 0 };

  function hostOf(url) {
    var m = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
  function denied(url) {
    var h = hostOf(url);
    if (!h) return false;
    if (DENY_RE.test(h)) return true;
    for (var i = 0; i < DENY_HOSTS.length; i += 1) if (h === DENY_HOSTS[i]) return true;
    return false;
  }
  function log(msg) {
    try {
      if (typeof console !== 'undefined' && console.log) console.log(MODULE_TAG + ' ' + msg);
    } catch (_) {}
  }
  function now() {
    return Date.now();
  }
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---------------------------------------------------------------- pure-JS base64 + AES-GCM
  // The provider encrypts its source urls with AES-256-GCM; the app sandbox cannot be assumed to
  // have atob/WebCrypto, so both primitives live here.
  var B64_LOOKUP = null;
  function b64Chars() {
    if (B64_LOOKUP) return B64_LOOKUP;
    B64_LOOKUP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    return B64_LOOKUP;
  }
  function b64urlToBytes(text) {
    var chars = b64Chars();
    var s = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    var out = [];
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < s.length; i += 1) {
      var c = s.charAt(i);
      if (c === '=') break;
      var idx = chars.indexOf(c);
      if (idx < 0) continue;
      buffer = (buffer << 6) | idx;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buffer >> bits) & 0xff);
      }
    }
    return out;
  }
  function hexToBytes(hex) {
    var out = [];
    for (var i = 0; i < String(hex).length; i += 2) out.push(parseInt(String(hex).substr(i, 2), 16));
    return out;
  }

  // --- AES (encryption direction only: CTR keystream + GCM tag) ---
  var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d];
  // AES S-box, generated and verified against the standard (0x63, 0x7c, 0xed, 0x16 ...).
  // Hardcoded rather than computed: a subtle bug in the generator silently breaks decryption.
var SBOX_TABLE = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
];
  var SBOX = SBOX_TABLE;
  function sbox() {
    return SBOX;
  }
  function xtime(a) {
    a <<= 1;
    if (a & 0x100) a ^= 0x11b;
    return a & 0xff;
  }
  function expandKey(key) {
    var s = sbox();
    var nk = key.length / 4;
    var nr = nk + 6;
    var w = [];
    var i;
    for (i = 0; i < nk; i += 1) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
    for (i = nk; i < 4 * (nr + 1); i += 1) {
      var temp = w[i - 1].slice();
      if (i % nk === 0) {
        temp = [temp[1], temp[2], temp[3], temp[0]];
        temp = [s[temp[0]], s[temp[1]], s[temp[2]], s[temp[3]]];
        temp[0] ^= RCON[i / nk - 1];
      } else if (nk > 6 && i % nk === 4) {
        temp = [s[temp[0]], s[temp[1]], s[temp[2]], s[temp[3]]];
      }
      w.push([w[i - nk][0] ^ temp[0], w[i - nk][1] ^ temp[1], w[i - nk][2] ^ temp[2], w[i - nk][3] ^ temp[3]]);
    }
    return { w: w, nr: nr };
  }
  function encryptBlock(rk, block) {
    var s = sbox();
    // Column-major state, exactly as the standard defines it: column c holds bytes 4c..4c+3.
    // (A transposed mapping here is silent: it still "works" for all-zero blocks and then
    // decrypts nothing else — which is how this module's first build lost an afternoon.)
    var state = [
      [block[0], block[1], block[2], block[3]],
      [block[4], block[5], block[6], block[7]],
      [block[8], block[9], block[10], block[11]],
      [block[12], block[13], block[14], block[15]],
    ];
    var round = 0;
    function addRoundKey(r) {
      for (var c = 0; c < 4; c += 1)
        for (var r2 = 0; r2 < 4; r2 += 1) state[c][r2] ^= rk.w[r * 4 + c][r2];
    }
    function subBytes() {
      for (var c = 0; c < 4; c += 1) for (var r = 0; r < 4; r += 1) state[c][r] = s[state[c][r]];
    }
    function shiftRows() {
      for (var r = 1; r < 4; r += 1) {
        var row = [state[0][r], state[1][r], state[2][r], state[3][r]];
        row = row.slice(r).concat(row.slice(0, r));
        for (var c = 0; c < 4; c += 1) state[c][r] = row[c];
      }
    }
    function mixColumns() {
      for (var c = 0; c < 4; c += 1) {
        var a0 = state[c][0];
        var a1 = state[c][1];
        var a2 = state[c][2];
        var a3 = state[c][3];
        var t = a0 ^ a1 ^ a2 ^ a3;
        state[c][0] ^= t ^ xtime(a0 ^ a1);
        state[c][1] ^= t ^ xtime(a1 ^ a2);
        state[c][2] ^= t ^ xtime(a2 ^ a3);
        state[c][3] ^= t ^ xtime(a3 ^ a0);
      }
    }
    addRoundKey(0);
    for (round = 1; round <= rk.nr; round += 1) {
      subBytes();
      shiftRows();
      if (round !== rk.nr) mixColumns();
      addRoundKey(round);
    }
    var out = [];
    for (var c2 = 0; c2 < 4; c2 += 1) for (var r3 = 0; r3 < 4; r3 += 1) out[4 * c2 + r3] = state[c2][r3];
    return out;
  }
  function ghash(key, aad, ciphertext) {
    // GF(2^128) multiplication as used by GCM.
    var H = encryptBlock(key, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    function mul(X, Y) {
      var Z = new Array(16).fill(0);
      var V = Y.slice();
      for (var i = 0; i < 128; i += 1) {
        var bit = (X[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
        if (bit) for (var j = 0; j < 16; j += 1) Z[j] ^= V[j];
        var lsb = V[15] & 1;
        for (var k = 15; k > 0; k -= 1) V[k] = ((V[k] >> 1) | ((V[k - 1] & 1) << 7)) & 0xff;
        V[0] = (V[0] >> 1) & 0xff;
        if (lsb) V[0] ^= 0xe1;
      }
      return Z;
    }
    var y = new Array(16).fill(0);
    var blocks = [];
    var data = aad.concat(ciphertext);
    for (var i = 0; i < data.length; i += 16) {
      var block = data.slice(i, i + 16);
      while (block.length < 16) block.push(0);
      blocks.push(block);
    }
    blocks.push(
      (function () {
        var lenBlock = new Array(16).fill(0);
        // NOTE: JS `>>>` is shift-mod-32, so `x >>> 32` === x. Bit lengths < 2^32 must be
        // split into high/low halves explicitly or the length block silently grows stray bytes.
        function put64(arr, offset, value) {
          var hi = Math.floor(value / 4294967296);
          var lo = value % 4294967296;
          arr[offset] = (hi >>> 24) & 0xff;
          arr[offset + 1] = (hi >>> 16) & 0xff;
          arr[offset + 2] = (hi >>> 8) & 0xff;
          arr[offset + 3] = hi & 0xff;
          arr[offset + 4] = (lo >>> 24) & 0xff;
          arr[offset + 5] = (lo >>> 16) & 0xff;
          arr[offset + 6] = (lo >>> 8) & 0xff;
          arr[offset + 7] = lo & 0xff;
        }
        put64(lenBlock, 0, aad.length * 8);
        put64(lenBlock, 8, ciphertext.length * 8);
        return lenBlock;
      })(),
    );
    for (var b = 0; b < blocks.length; b += 1) {
      for (var j = 0; j < 16; j += 1) y[j] ^= blocks[b][j];
      y = mul(y, H);
    }
    return y;
  }
  function inc32(counter) {
    var c = counter.slice();
    for (var i = 15; i >= 12; i -= 1) {
      c[i] = (c[i] + 1) & 0xff;
      if (c[i] !== 0) break;
    }
    return c;
  }
  function aesGcmDecrypt(keyBytes, iv, ciphertext, tag) {
    var rk = expandKey(keyBytes);
    var j0 = iv.concat([0, 0, 0, 1]);
    var counter = j0.slice();
    var plain = [];
    for (var i = 0; i < ciphertext.length; i += 16) {
      counter = inc32(counter);
      var ks = encryptBlock(rk, counter);
      for (var j = 0; j < 16 && i + j < ciphertext.length; j += 1) plain.push(ciphertext[i + j] ^ ks[j]);
    }
    var s = ghash(rk, [], ciphertext);
    var ek = encryptBlock(rk, j0);
    var expected = [];
    for (var k = 0; k < 16; k += 1) expected.push(s[k] ^ ek[k]);
    var ok = true;
    for (var m = 0; m < 16; m += 1) if (expected[m] !== tag[m]) ok = false;
    return { plain: plain, tagOk: ok };
  }
  function bytesToAscii(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }

  // Provider key: a public 32-byte constant from the provider's own client bundle (not a user
  // credential; it is sent to every visitor's browser). Kept here as the provider ships it.
  var SOURCE_KEY_HEX = '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f';
  function decryptSource(encoded) {
    try {
      var raw = b64urlToBytes(encoded);
      if (raw.length < 28) return null;
      var iv = raw.slice(0, 12);
      var tag = raw.slice(raw.length - 16);
      var ct = raw.slice(12, raw.length - 16);
      var res = aesGcmDecrypt(hexToBytes(SOURCE_KEY_HEX), iv, ct, tag);
      if (!res.tagOk) {
        trace.decryptFailed += 1;
        log('source decrypt tag mismatch');
        return null;
      }
      trace.decrypted += 1;
      return bytesToAscii(res.plain);
    } catch (e) {
      trace.decryptFailed += 1;
      log('source decrypt failed: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  // ---------------------------------------------------------------- request layer
  var cooldowns = {};
  var MAX_ATTEMPTS = 2;
  var PARK_MIN_MS = 60 * 1000;

  function parked(host) {
    var until = cooldowns[host] || 0;
    if (now() < until) return true;
    if (until) delete cooldowns[host];
    return false;
  }
  function parkHost(host, ms, why) {
    var until = now() + Math.max(Number(ms) || 0, PARK_MIN_MS);
    cooldowns[host] = until;
    trace.parked = (trace.parked || 0) + 1;
    log('parked ' + host + ' for ' + Math.round((until - now()) / 1000) + 's (' + why + ')');
  }
  function retryAfterMs(response) {
    try {
      var h = response && response.headers;
      if (!h) return 0;
      var v = typeof h.get === 'function' ? h.get('retry-after') : h['retry-after'] || h['Retry-After'];
      if (!v) return 0;
      var secs = Number(v);
      if (!isNaN(secs)) return secs * 1000;
      var when = Date.parse(v);
      if (!isNaN(when)) return Math.max(0, when - now());
    } catch (_) {}
    return 0;
  }
  function tryParse(text) {
    var trimmed = String(text || '').trim();
    if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return null;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return null;
    }
  }
  // fetchv2 shims differ: some expose `body`, some `text()` (possibly a promise), some `json`.
  // Raw text is kept because playlists and segment probes need the bytes, JSON for the APIs.
  async function readRaw(response) {
    if (!response) return { text: null, json: null };
    if (response.bodyDropped) return { text: null, json: null, dropped: true };
    if (response.json) {
      try {
        var parsed = typeof response.json === 'function' ? await response.json() : response.json;
        if (parsed != null && typeof parsed === 'object') return { text: JSON.stringify(parsed), json: parsed };
      } catch (_) {}
    }
    var text = null;
    if (typeof response.body === 'string' && response.body) text = response.body;
    else if (typeof response.text === 'function') {
      try {
        var t = await response.text();
        if (typeof t === 'string' && t) text = t;
      } catch (_) {}
    }
    if (text == null && response.json) {
      try {
        var v = typeof response.json === 'function' ? await response.json() : response.json;
        if (v != null) return { text: typeof v === 'string' ? v : JSON.stringify(v), json: typeof v === 'string' ? tryParse(v) : v };
      } catch (_) {}
    }
    if (text == null) return { text: null, json: null };
    return { text: text, json: tryParse(text) };
  }

  function within(promise, ms, fallback) {
    var timer;
    return Promise.race([promise, new Promise(function (resolve) {
      timer = setTimeout(function () { resolve(fallback); }, Math.max(1, ms));
    })]).finally(function () { if (typeof clearTimeout === 'function') clearTimeout(timer); });
  }

  function publicHttpUrl(url) {
    var match = String(url || '').match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/i);
    if (!match || /[@\s\\\[\]:]/.test(match[1])) return false;
    var host = match[1].toLowerCase().replace(/\.$/, '');
    return host.indexOf('.') > 0 && !/^(localhost|0|127|10|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))(?:\.|$)/.test(host) &&
      !/^\d+(?:\.\d+)*$/.test(host) && !/\.(local|localhost|internal)$/.test(host);
  }

  function traceRequest(entry) {
    trace.requests.push(entry);
    if (trace.requests.length > 256) trace.requests.shift();
  }

  async function request(url, headers, method, body, options) {
    var opts = options || {};
    if (!publicHttpUrl(url) || denied(url)) {
      trace.blocked.push({ host: hostOf(url), at: now() });
      if (trace.blocked.length > 64) trace.blocked.shift();
      log('DENIED host refused: ' + hostOf(url));
      return { ok: false, status: 0, denied: true, json: null, text: null };
    }
    var host = hostOf(url);
    if (parked(host)) return { ok: false, status: 0, parked: true, json: null, text: null };

    var last = { ok: false, status: 0, json: null, text: null };
    for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      var started = now();
      try {
        var response = await within((async function () {
          var res = await fetchv2(url, headers, method || 'GET', body || null,
            Object.assign({timeoutMs: 6000}, opts));
          return {res: res, raw: await readRaw(res)};
        })(), 6000, null);
        if (!response) return {ok: false, status: 0, text: null, json: null, timedOut: true};
        var res = response.res;
        var status = res && typeof res.status === 'number' ? res.status : 0;
        var raw = response.raw;
        var finalUrl = res && res.finalUrl || url;
        if (!publicHttpUrl(finalUrl) || denied(finalUrl)) return {ok: false, status: 0, json: null, text: null, denied: true};
        last = { ok: status >= 200 && status < 300 && !raw.dropped, status: status, json: raw.json, text: raw.text, headers: res && res.headers, finalUrl: finalUrl };
        traceRequest({ host: host, status: status, ms: now() - started, at: started });
        if (status === 429 || status === 403) {
          parkHost(host, retryAfterMs(res), 'http ' + status);
          last.parked = true;
          return last;
        }
        if (status >= 500 && attempt < MAX_ATTEMPTS) continue; // one immediate retry, no timer
        return last;
      } catch (e) {
        last = { ok: false, status: 0, json: null, text: null, error: String((e && e.message) || e) };
        traceRequest({ host: host, status: 0, ms: now() - started, at: started });
        if (attempt >= MAX_ATTEMPTS) return last;
      }
    }
    return last;
  }

  // ---------------------------------------------------------------- catalogue: wikipedia / wikidata
  var catalogueCache = {};
  var CATALOGUE_TTL_MS = 10 * 60 * 1000;

  function cacheGet(key) {
    var hit = catalogueCache[key];
    if (hit && now() - hit.at < CATALOGUE_TTL_MS) return hit.value;
    if (hit) delete catalogueCache[key];
    return null;
  }
  function cacheSet(key, value) {
    var keys = Object.keys(catalogueCache);
    if (!catalogueCache[key] && keys.length >= 256) delete catalogueCache[keys[0]];
    catalogueCache[key] = { at: now(), value: value };
    return value;
  }

  function wikiHeaders() {
    return { 'User-Agent': SPARQL_AGENT, Accept: 'application/json' };
  }

  // Wikidata entity search: returns QIDs (with descriptions) in one request, which is both cheaper
  // and more precise than Wikipedia opensearch - it does not return "season 5" / "characters" pages.
  async function entitySearch(query) {
    var q = clean(query);
    if (!q) return [];
    var key = 'es:' + q.toLowerCase();
    var cached = cacheGet(key);
    if (cached) return cached;
    var res = await request(
      WIKIDATA_API + '/w/api.php?action=wbsearchentities&search=' + encodeURIComponent(q) +
        '&language=en&uselang=en&type=item&limit=25&format=json',
      wikiHeaders(),
      'GET',
    );
    if (!res.ok || !res.json || !Array.isArray(res.json.search)) throw new Error('Catalogue search temporarily unavailable; retry shortly.');
    var hits = res.json.search;
    var out = [];
    for (var i = 0; i < hits.length; i += 1) {
      if (!hits[i] || !hits[i].id) continue;
      out.push({
        qid: String(hits[i].id),
        label: clean(hits[i].label) || null,
        description: clean(hits[i].description) || null,
      });
    }
    return cacheSet(key, out);
  }

  async function wikiSummary(title) {
    var t = clean(title);
    if (!t) return null;
    var key = 'summary:' + t;
    var cached = cacheGet(key);
    if (cached !== null) return cached;
    var res = await request(WIKI + '/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_')), wikiHeaders(), 'GET');
    var body = res && res.json;
    if (!body || !body.wikibase_item) return cacheSet(key, null);
    var value = {
      qid: body.wikibase_item,
      title: clean(body.title) || t,
      description: clean(body.description),
      extract: clean(body.extract),
      image: posterProxy(body.thumbnail && body.thumbnail.source ? String(body.thumbnail.source) : body.originalimage && body.originalimage.source ? String(body.originalimage.source) : null),
      pageType: body.type || null,
    };
    return cacheSet(key, value);
  }

  // One SPARQL call for up to 40 items: film TMDB id (P4947), TV TMDB id (P4983), IMDb id, year,
  // instance-of classes, English label and the enwiki article title (for batched posters).
  // P4947 is films only; TV series carry their provider id in P4983 - querying just P4947 silently
  // made every series look unsourced.
  async function wikidataInfo(qids) {
    var all = (qids || []).filter(Boolean);
    if (!all.length) return {};
    if (all.length > 25) {
      var merged = {};
      for (var c = 0; c < all.length; c += 25) {
        var part = await wikidataInfo(all.slice(c, c + 25));
        for (var qk in part) if (part.hasOwnProperty(qk)) merged[qk] = part[qk];
      }
      return merged;
    }
    var list = all;
    var key = 'wd:' + list.slice().sort().join(',');
    var cached = cacheGet(key);
    if (cached) return cached;
    var values = list.map(function (q) {
      return 'wd:' + q;
    }).join(' ');
    var sparql =
      'SELECT ?item ?tmdbMovie ?tmdbTv ?imdb ?year ?kindLabel ?itemLabel ?article WHERE { VALUES ?item { ' + values + ' } ' +
      'OPTIONAL { ?item wdt:P4947 ?tmdbMovie } OPTIONAL { ?item wdt:P4983 ?tmdbTv } OPTIONAL { ?item wdt:P345 ?imdb } ' +
      'OPTIONAL { ?item wdt:P577 ?date } OPTIONAL { ?item wdt:P31 ?kind } ' +
      'OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> } ' +
      'BIND(YEAR(?date) AS ?year) ' +
      'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }';
    var res = await request(
      WIKIDATA + '/sparql?format=json&query=' + encodeURIComponent(sparql),
      { 'User-Agent': SPARQL_AGENT, Accept: 'application/sparql-results+json' },
      'GET',
    );
    if (!res.ok || !res.json || !res.json.results || !Array.isArray(res.json.results.bindings)) {
      return directEntityInfo(list, key);
    }
    var out = {};
    var bindings = res.json.results.bindings;
    for (var i = 0; i < bindings.length; i += 1) {
      var b = bindings[i];
      var qid = b.item ? String(b.item.value).split('/').pop() : null;
      if (!qid) continue;
      var entry = out[qid] || { qid: qid, tmdbMovie: null, tmdbTv: null, imdb: null, year: null, kinds: [], label: null, article: null };
      if (b.tmdbMovie) {
        var movieId = Number(b.tmdbMovie.value);
        if (entry.tmdbMovie && entry.tmdbMovie !== movieId) entry.ambiguous = true;
        entry.tmdbMovie = movieId || null;
      }
      if (b.tmdbTv) {
        var tvId = Number(b.tmdbTv.value);
        if (entry.tmdbTv && entry.tmdbTv !== tvId) entry.ambiguous = true;
        entry.tmdbTv = tvId || null;
      }
      if (b.imdb && !entry.imdb) entry.imdb = String(b.imdb.value);
      if (b.year && !entry.year) entry.year = Number(String(b.year.value).slice(0, 4)) || null;
      if (b.kindLabel && entry.kinds.indexOf(String(b.kindLabel.value)) < 0) entry.kinds.push(String(b.kindLabel.value));
      if (b.itemLabel && !entry.label) {
        var lab = String(b.itemLabel.value);
        if (!/^Q\d+$/.test(lab)) entry.label = lab;
      }
      if (b.article && !entry.article) entry.article = String(b.article.value).split('/').pop().replace(/_/g, ' ');
      out[qid] = entry;
    }
    return cacheSet(key, out);
  }

  async function directEntityInfo(qids, key) {
    var res = await request(WIKIDATA_API + '/w/api.php?action=wbgetentities&ids=' + qids.join('|') +
      '&props=labels|claims|sitelinks&languages=en&sitefilter=enwiki&format=json', wikiHeaders(), 'GET');
    if (!res.ok || !res.json || !res.json.entities) throw new Error('Catalogue identity lookup temporarily unavailable; retry shortly.');
    var out = {};
    qids.forEach(function (qid) {
      var e = res.json.entities[qid];
      if (!e || e.missing != null) return;
      function claim(property) {
        var rows = (e.claims && e.claims[property] || []).filter(function (row) {
          return row.rank !== 'deprecated' && row.mainsnak && row.mainsnak.snaktype === 'value' && row.mainsnak.datavalue;
        });
        var preferred = rows.filter(function (row) { return row.rank === 'preferred'; });
        if (preferred.length) rows = preferred;
        var values = [];
        rows.forEach(function (row) {
          var v = row.mainsnak.datavalue.value;
          if (typeof v === 'string' && values.indexOf(v) < 0) values.push(v);
        });
        return values.length === 1 ? values[0] : null;
      }
      var movie = claim('P4947'), tv = claim('P4983');
      if (Boolean(movie) === Boolean(tv)) return;
      var id = Number(movie || tv);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      var dates = ((e.claims && e.claims.P577) || []).concat((e.claims && e.claims.P580) || []);
      var years = dates.filter(function (row) { return row.rank !== 'deprecated'; }).map(function (row) {
        var v = row.mainsnak && row.mainsnak.datavalue && row.mainsnak.datavalue.value;
        var m = v && String(v.time || '').match(/^\+(\d{4})-/);
        return m ? Number(m[1]) : null;
      }).filter(Boolean);
      out[qid] = {qid:qid, tmdbMovie:movie ? id : null, tmdbTv:tv ? id : null, imdb:claim('P345'),
        year:years.length ? Math.min.apply(null, years) : null, kinds:[],
        label:e.labels && e.labels.en && e.labels.en.value || null,
        article:e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title || null};
    });
    return cacheSet(key, out);
  }

  // Which provider id does this item carry? P4983 = TV series, P4947 = film.
  function tmdbOf(entry) {
    if (!entry || entry.ambiguous || (entry.tmdbMovie && entry.tmdbTv)) return null;
    var candidate = entry.tmdbMovie || entry.tmdbTv;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) return null;
    if (entry.tmdbMovie) return { id: entry.tmdbMovie, kind: 'movie' };
    if (entry.tmdbTv) return { id: entry.tmdbTv, kind: 'tv' };
    return null;
  }
  function kindOf(entry) {
    var id = tmdbOf(entry);
    if (id) return id.kind;
    var kinds = (entry && entry.kinds) || [];
    var joined = kinds.join(' ').toLowerCase();
    if (/television series|tv series|miniseries|anime television/.test(joined)) return 'tv';
    return 'movie';
  }

  function posterFor(image, width) {
    // Wikipedia thumbnails come as .../thumb/<path>/<file>/<size>px-<file>; re-scale when asked.
    var src = String(image || '');
    if (!src) return null;
    return src.replace(/\/(\d+)px-/, '/' + (width || 400) + 'px-');
  }

  // One batched pageimages call dresses a whole row (or a set of search cards) with posters.
  async function postersFor(titles) {
    var map = {};
    var list = (titles || []).filter(Boolean).slice(0, 50);
    if (!list.length) return map;
    var key = 'pi:' + list.slice().sort().join('|');
    var cached = cacheGet(key);
    if (cached) return cached;
    var res = await request(
      WIKI + '/w/api.php?action=query&prop=pageimages&pilicense=any&piprop=thumbnail&pithumbsize=400&format=json&redirects=1&titles=' + encodeURIComponent(list.join('|')),
      wikiHeaders(),
      'GET',
    );
    var pages = res && res.json && res.json.query && res.json.query.pages ? res.json.query.pages : {};
    if (!res.ok || !res.json || !res.json.query) return map;
    for (var pid in pages) {
      if (!pages.hasOwnProperty(pid)) continue;
      var p = pages[pid];
      if (!p || !p.title) continue;
      map[String(p.title)] = posterProxy(p.thumbnail && p.thumbnail.source ? String(p.thumbnail.source) : null);
      map[String(p.title).replace(/ /g, '_')] = map[String(p.title)];
    }
    return cacheSet(key, map);
  }

  // Build cards for entity-search hits. Two batched requests total (SPARQL + pageimages), and only
  // items that actually carry a provider id are surfaced - a card you cannot play is a broken promise.
  // A batch answer for Q1..Qn also answers the single-item question "what is Q1?" — store each item
  // under its own key so details/episodes never need a second (throttle-prone) round trip.
  function seedItemCache(qid, meta) {
    if (!qid || !meta) return;
    cacheSet('wd:' + qid, (function () {
      var one = {};
      one[qid] = meta;
      return one;
    })());
  }

  async function cardsFromItems(items, limit) {
    var slice = (items || []).slice(0, 25);
    if (!slice.length) return [];
    var info = await wikidataInfo(slice.map(function (it) { return it.qid; }));
    var keep = [];
    for (var i = 0; i < slice.length && keep.length < (limit || 12); i += 1) {
      var meta = info[slice[i].qid];
      if (!meta || !tmdbOf(meta)) continue;
      keep.push({ item: slice[i], meta: meta });
    }
    if (!keep.length) return [];
    var posters = await postersFor(keep.map(function (k) { return k.meta.article || k.meta.label || k.item.label; }));
    var images = await posterFallbacks(keep.map(function (k) {
      var id = tmdbOf(k.meta);
      return { article: k.meta.article || k.meta.label || k.item.label, kind: id.kind, tmdb: id.id, imdb: k.meta.imdb || null, year: k.meta.year || null };
    }), posters);
    var out = [];
    for (var j = 0; j < keep.length; j += 1) {
      var k = keep[j];
      var label = k.meta.label || k.item.label || k.meta.article || k.item.qid;
      seedItemCache(k.item.qid, k.meta);
      out.push({
        href: 'alpha:' + k.item.qid,
        title: k.meta.year ? label + ' (' + k.meta.year + ')' : label,
        image: images[j] || null,
        description: k.item.description || (k.meta.kinds.length ? k.meta.kinds.join(', ') : ''),
        type: kindOf(k.meta),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- search / details / episodes
  // Wikipedia title search, used only as a fallback: entity search answers with the *most famous*
  // entity, which for a name like "Barbie" is the doll, not the film.
  async function wikiTitleSearch(query) {
    var q = clean(query);
    if (!q) return [];
    var key = 'wts:' + q.toLowerCase();
    var cached = cacheGet(key);
    if (cached) return cached;
    var res = await request(
      WIKI + '/w/api.php?action=opensearch&limit=12&namespace=0&format=json&search=' + encodeURIComponent(q),
      wikiHeaders(),
      'GET',
    );
    var rows = res && Array.isArray(res.json) && Array.isArray(res.json[1]) ? res.json[1] : [];
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var t = clean(rows[i]);
      if (!t) continue;
      if (/^List of /i.test(t)) continue;
      if (/\((season \d+|soundtrack|album|song|disambiguation|franchise)\)$/i.test(t)) continue;
      out.push(t);
    }
    return cacheSet(key, out);
  }

  async function searchResults(query) {
    var q = clean(query);
    if (!q) return homeCards();
    var hits = await entitySearch(q);
    var out = hits.length ? await cardsFromItems(hits, 12) : [];
    if (!out.length) {
      var titles = await wikiTitleSearch(q);
      var items = [];
      for (var i = 0; i < titles.length && i < 6; i += 1) {
        var summary = await wikiSummary(titles[i]);
        if (summary && summary.qid) items.push({ qid: summary.qid, label: summary.title, description: summary.description });
      }
      if (items.length) out = await cardsFromItems(items, 12);
      if (out.length) log('search "' + q + '": entity search had no playable hit, title search recovered ' + out.length);
    }
    log('search "' + q + '" -> ' + out.length + ' cards (' + hits.length + ' entity hits)');
    return out;
  }

  function parseRef(raw) {
    var text = clean(raw);
    if (/^https?:/i.test(text)) {
      var absolute = text.match(/^https:\/\/vidrock\.net\/([^?#]+)#?$/i);
      if (!absolute) return null;
      text = absolute[1];
    } else if (text.charAt(0) === '/') text = text.slice(1);
    try { text = decodeURIComponent(text); } catch (_) { return null; }
    function valid(n) { return /^[1-9]\d*$/.test(n) && Number(n) <= 9007199254740991; }
    var m = text.match(/^alpha:([Qq]\d+)$/);
    if (m && valid(m[1].slice(1))) return { kind: 'item', qid: m[1].toUpperCase() };
    m = text.match(/^alpha:movie:(\d+)(?::(\d+))?$/i);
    if (m && valid(m[1]) && (!m[2] || m[2] === '1')) return { kind: 'movie', tmdb: Number(m[1]), episode: 1 };
    m = text.match(/^alpha:tv:(\d+):(\d+):(\d+)$/i);
    if (m && valid(m[1]) && valid(m[2]) && valid(m[3])) return { kind: 'tv', tmdb: Number(m[1]), season: Number(m[2]), episode: Number(m[3]) };
    return null;
  }

  async function resolveItem(ref) {
    if (ref.kind === 'movie' || ref.kind === 'tv') return ref;
    var info = (await wikidataInfo([ref.qid]))[ref.qid] || {};
    var id = tmdbOf(info);
    if (!id) return null;
    return { kind: id.kind, qid: ref.qid, tmdb: id.id, imdb: info.imdb, year: info.year, info: info };
  }

  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref) {
      ref = parseRef('alpha:' + clean(urlOrId));
      if (!ref) throw new Error('Unrecognised title reference. Search for the title again.');
    }
    var info = ref.info || {};
    if (ref.kind === 'item') {
      info = (await wikidataInfo([ref.qid]))[ref.qid] || {};
      var page = info.article || info.label || (await wikidataLabel(ref.qid)) || '';
      var summary = page ? await wikiSummary(page) : null;
      var label = (summary && summary.title) || info.label || String(urlOrId);
      var y = info.year || null;
      var image = summary ? posterFor(summary.image, 500) : null;
      var tmdb = tmdbOf(info);
      if (!image && tmdb) image = await artworkFallback({ kind: tmdb.kind, tmdb: tmdb.id, imdb: info.imdb || null, year: y, article: page });
      return {
        title: y ? label + ' (' + y + ')' : label,
        description: (summary && summary.extract) || '',
        image: image,
        href: String(urlOrId),
        year: y,
        genres: info.kinds || [],
        tmdbId: (tmdbOf(info) || {}).id || null,
        type: kindOf(info),
      };
    }
    var label2 = (ref.info && ref.info.label) || String(urlOrId);
    return {
      title: ref.year ? label2 + ' (' + ref.year + ')' : label2,
      description: '',
      image: null,
      href: String(urlOrId),
      year: ref.year || null,
      genres: (ref.info && ref.info.kinds) || [],
      tmdbId: ref.tmdb || null,
      type: ref.kind,
    };
  }

  async function wikidataLabel(qid) {
    if (!qid) return null;
    var key = 'label:' + qid;
    var cached = cacheGet(key);
    if (cached) return cached;
    var res = await request(
      'https://www.wikidata.org/w/api.php?action=wbgetentities&props=labels|sitelinks&languages=en&sitefilter=enwiki&format=json&ids=' + qid,
      wikiHeaders(),
      'GET',
    );
    var ent = res && res.json && res.json.entities && res.json.entities[qid];
    var label = null;
    if (ent) {
      if (ent.labels && ent.labels.en) label = clean(ent.labels.en.value);
      else if (ent.sitelinks && ent.sitelinks.enwiki) label = clean(ent.sitelinks.enwiki.title);
    }
    return cacheSet(key, label);
  }

  async function tvmazeEpisodes(title, identity) {
    var key = 'tvmaze:' + identity.tmdb + ':' + (identity.imdb || '') + ':' + (identity.year || '');
    var cached = cacheGet(key);
    if (cached) return cached;
    var headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    var showId = null;
    var imdb = /^tt\d+$/.test(identity.imdb || '') ? identity.imdb : null;
    if (imdb) {
      var lookup = await request(TVMAZE + '/lookup/shows?imdb=' + imdb, headers, 'GET');
      if (lookup.ok && lookup.json && lookup.json.externals && lookup.json.externals.imdb === imdb) showId = lookup.json.id;
      else if (lookup.status !== 404) throw new Error('Episode identity lookup temporarily unavailable.');
    }
    if (!showId) {
      var sres = await request(TVMAZE + '/search/shows?q=' + encodeURIComponent(title), headers, 'GET');
      if (!sres.ok || !Array.isArray(sres.json)) throw new Error('Episode search temporarily unavailable.');
      function normalized(name) { return clean(name).toLowerCase().replace(/[\u2018\u2019]/g, "'"); }
      var matches = sres.json.map(function (r) { return r && r.show; }).filter(function (show) {
        if (!show || !show.id) return false;
        if (imdb) return show.externals && show.externals.imdb === imdb;
        return identity.year && normalized(show.name) === normalized(title) && String(show.premiered || '').slice(0, 4) === String(identity.year);
      });
      if (matches.length !== 1) throw new Error('Unable to identify the exact series episode list; no episodes substituted.');
      showId = matches[0].id;
    }
    var eres = await request(TVMAZE + '/shows/' + showId + '/episodes?specials=1', { 'User-Agent': USER_AGENT, Accept: 'application/json' }, 'GET');
    if (!eres.ok || !Array.isArray(eres.json)) throw new Error('Episode list temporarily unavailable.');
    var eps = eres.json;
    var out = [];
    var seen = {};
    for (var i = 0; i < eps.length; i += 1) {
      var e = eps[i];
      if (!e || !(e.season > 0) || !(e.number > 0) || Number(e.season) % 1 || Number(e.number) % 1) continue;
      if (e.airstamp && Date.parse(e.airstamp) > now()) continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(e.airdate || '') && e.airdate > new Date(now()).toISOString().slice(0, 10)) continue;
      var epKey = e.season + ':' + e.number;
      if (seen[epKey]) continue;
      seen[epKey] = true;
      out.push({ season: Number(e.season), number: Number(e.number), name: clean(e.name) || 'Episode ' + e.number, airdate: e.airdate || null });
    }
    out.sort(function (a, b) {
      return a.season - b.season || a.number - b.number;
    });
    return cacheSet(key, out);
  }

  function episodesForMovie(ref) {
    return [
      {
        number: 1,
        href: 'alpha:movie:' + ref.tmdb + ':1',
        episodeNumber: 1,
        title: 'Movie',
        subAvailable: true,
        dubAvailable: false,
      },
    ];
  }

  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref) return [];
    var resolved = await resolveItem(ref);
    if (!resolved || !resolved.tmdb) {
      log('no TMDB id resolvable for ' + seriesId);
      return [];
    }
    if (resolved.kind === 'movie') return episodesForMovie(resolved);
    var label = (resolved.info && (resolved.info.label || resolved.info.article)) || (await wikidataLabel(resolved.qid)) || '';
    if (!label || /^Q\d+$/.test(label)) label = (resolved.info && resolved.info.article) || '';
    var eps = label ? await tvmazeEpisodes(label, resolved) : [];
    if (!eps.length) {
      // Without an episode list we must not invent one: a series with no episodes is reported empty.
      log('no episode list for ' + label);
      return [];
    }
    var out = [];
    for (var i = 0; i < eps.length; i += 1) {
      var e = eps[i];
      out.push({
        number: i + 1,
        episodeNumber: e.number,
        season: e.season,
        title: 'S' + pad2(e.season) + 'E' + pad2(e.number) + (e.name ? ': ' + e.name : ''),
        href: 'alpha:tv:' + resolved.tmdb + ':' + e.season + ':' + e.number,
        subAvailable: true,
        dubAvailable: false,
      });
    }
    return out;
  }
  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // ---------------------------------------------------------------- provider playback
  function providerHeaders(extra) {
    var base = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,application/vnd.apple.mpegurl,*/*',
      Referer: PROVIDER + '/',
      Origin: PROVIDER,
    };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) base[k] = extra[k];
    return base;
  }
  function cdnHeaders() {
    // The CDNs are hotlink-protected: the provider's own referer unlocks them, and the worker-hosted
    // server additionally checks Origin.
    return { 'User-Agent': USER_AGENT, Referer: PROVIDER + '/', Origin: PROVIDER };
  }

  async function providerSources(ref) {
    var path = ref.kind === 'tv' ? '/api/tv/' + ref.tmdb + '/' + ref.season + '/' + ref.episode : '/api/movie/' + ref.tmdb;
    var res = await request(PROVIDER + path, providerHeaders(), 'GET');
    if (!res.ok || !res.json || typeof res.json !== 'object') {
      return { ok: false, status: res.status, parked: res.parked, reason: res.denied ? 'denied' : 'no-api-answer' };
    }
    var out = [];
    for (var name in res.json) {
      if (!res.json.hasOwnProperty(name)) continue;
      var entry = res.json[name];
      if (!entry || typeof entry !== 'object' || !entry.url) continue;
      var url = decryptSource(String(entry.url));
      if (!url || !publicHttpUrl(url) || denied(url)) continue;
      out.push({
        name: name,
        url: url,
        type: entry.type || null,
        language: entry.language ? clean(entry.language) : null,
        flag: entry.flag ? clean(entry.flag) : null,
      });
    }
    return { ok: true, sources: out };
  }


  // ---------------------------------------------------------------- provider 2: videasy
  // Direct third-party API by TMDB id. /seed keys an XOR keystream that hides the JSON
  // (magic 'mvm1'). English endpoints only; empty language is trusted only for the /cdn route.
  function vImul(a, b) { return Math.imul(a, b) >>> 0; }
  function vU32(x) { return x >>> 0; }
  function vMix(e) { e = vU32(e); e ^= e >>> 16; e = vImul(e, 2246822507); e ^= e >>> 13; e = vImul(e, 3266489909); e ^= e >>> 16; return vU32(e); }
  function vRotl(e, t) { e = vU32(e); t = t & 31; if (!t) return e; return vU32((e << t) | (e >>> (32 - t))); }
  function vKeystate(seed, mediaId) {
    var tNum = Number(mediaId) || 0;
    var S = {};
    var fnv = 2166136261;
    var seedStr = String(seed || '');
    for (var i = 0; i < seedStr.length; i += 1) fnv = vImul(fnv ^ seedStr.charCodeAt(i), 16777619);
    var a = vMix(vMix(fnv) ^ vMix(vU32(tNum) ^ 2654435769));
    for (var e = 0; e < 8; e += 1) {
      var tSlot = a % 61;
      a = vRotl(vU32(a + 2654435769), 7 + (7 & e));
      S[tSlot] = vU32(a ^ vMix(a));
      a = vMix(vU32(a + tSlot));
    }
    return { S: S, acc: vMix(vU32(2779096485 ^ a)) };
  }
  function vNextWord(state, tCounter) {
    var r = state.S;
    var o = state.acc;
    var n = o % 61;
    var present = Object.prototype.hasOwnProperty.call(r, n);
    var iMask = present ? 0xffffffff : 0;
    var l = present ? vU32(r[n]) : 0;
    var aVal = vU32(l ^ vImul(2654435769, tCounter + 1));
    var s = o;
    var d = vU32(vU32(s ^ aVal) | vU32(s & aVal & iMask));
    d = vU32(vRotl(vU32(d + o), 31 & n) ^ vRotl(o, 31 & vImul(n, 7)));
    o = vMix(vU32(d + 2654435769));
    r[n] = o;
    state.acc = o;
    return o;
  }
  function vKeystream(seed, mediaId, length) {
    var state = vKeystate(seed, mediaId);
    var out = [];
    var o = 0;
    while (out.length < length) {
      var t = vNextWord(state, o);
      o += 1;
      out.push(t & 255, (t >>> 8) & 255, (t >>> 16) & 255, (t >>> 24) & 255);
    }
    out.length = length;
    return out;
  }
  var VIDEASY_MAGIC = [109, 118, 109, 49];
  function utf8FromBytes(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
      else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
      else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) { out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
      else if (b >= 0xf0 && i + 3 < bytes.length) {
        var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        i += 4;
      } else { i += 1; }
    }
    return out;
  }
  function videasyDecrypt(payload, seed, mediaId) {
    var raw = b64urlToBytes(String(payload || '').trim().replace(/^"|"$/g, ''));
    if (!raw.length) throw new Error('videasy-empty');
    var ks = vKeystream(seed, mediaId, raw.length);
    var plain = [];
    for (var i = 0; i < raw.length; i += 1) plain.push(raw[i] ^ ks[i]);
    for (var m = 0; m < VIDEASY_MAGIC.length; m += 1) if (plain[m] !== VIDEASY_MAGIC[m]) throw new Error('videasy-magic');
    return utf8FromBytes(plain.slice(4));
  }
  function videasyHeaders(extra) {
    var base = { 'User-Agent': USER_AGENT, Accept: 'application/json,text/plain,*/*', Origin: VIDEASY_PLAYER, Referer: VIDEASY_PLAYER + '/' };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) base[k] = extra[k];
    return base;
  }
  function videasyStreamHeaders() {
    return { 'User-Agent': USER_AGENT, Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*', Origin: VIDEASY_PLAYER, Referer: VIDEASY_PLAYER + '/' };
  }
  var videasySeedCache = {};
  async function videasySeed(mediaId) {
    var key = String(mediaId);
    var hit = videasySeedCache[key];
    if (hit && hit.expires > now()) return hit.seed;
    var res = await request(VIDEASY_API + '/seed?mediaId=' + encodeURIComponent(key), videasyHeaders(), 'GET');
    var seed = res.ok && res.json && res.json.seed ? String(res.json.seed) : '';
    if (seed) {
      var keys = Object.keys(videasySeedCache);
      if (keys.length >= 24) delete videasySeedCache[keys[0]];
      videasySeedCache[key] = { seed: seed, expires: now() + 60 * 60 * 1000 };
    }
    return seed;
  }
  var VIDEASY_ENDPOINTS = ['/cdn/sources-with-title', '/m4uhd/sources-with-title', '/vsrc/sources-with-title'];
  function videasyLangOf(blob) {
    var text = String(blob || '');
    if (/\bhindi\b/i.test(text)) return 'hi';
    if (/\b(spanish|espanol|español|latino|castellano)\b/i.test(text)) return 'es';
    if (/\b(german|deutsch)\b/i.test(text)) return 'de';
    if (/\b(portuguese|portugues|português)\b/i.test(text)) return 'pt';
    if (/\b(french|francais|français)\b/i.test(text)) return 'fr';
    if (/\barabic\b/i.test(text)) return 'ar';
    if (/\bitalian\b/i.test(text)) return 'it';
    if (/\bjapanese\b/i.test(text)) return 'ja';
    if (/\bkorean\b/i.test(text)) return 'ko';
    if (/\b(english|eng)\b/i.test(text)) return 'en';
    return '';
  }
  async function videasyCandidates(ref) {
    var out = [];
    try {
      var identity = await identityFor(ref);
      var seed = await videasySeed(ref.tmdb);
      if (!seed) return out;
      var startedAt = now();
      var params = {
        title: identity.title,
        mediaType: ref.kind,
        year: identity.year,
        tmdbId: ref.tmdb,
        enc: '2',
        seed: seed,
      };
      if (ref.kind === 'tv') { params.seasonId = ref.season; params.episodeId = ref.episode; }
      var q = [];
      for (var pk in params) if (params.hasOwnProperty(pk) && params[pk] !== '' && params[pk] != null) q.push(encodeURIComponent(pk) + '=' + encodeURIComponent(String(params[pk])));
      var query = q.join('&');
      var seen = {};
      for (var i = 0; i < VIDEASY_ENDPOINTS.length; i += 1) {
        if (out.length && now() - startedAt > 4000) break;
        if (now() - startedAt > 8000) break;
        var ep = VIDEASY_ENDPOINTS[i];
        var res = await request(VIDEASY_API + ep + '?' + query, videasyHeaders(), 'GET');
        if (!res.ok || !res.text) continue;
        var data = null;
        try { data = JSON.parse(videasyDecrypt(res.text, seed, ref.tmdb)); } catch (_) { continue; }
        var sources = data && Array.isArray(data.sources) ? data.sources : [];
        for (var j = 0; j < sources.length; j += 1) {
          var src = sources[j] || {};
          var url = String(src.url || '');
          if (!/^https:\/\//i.test(url) || !publicHttpUrl(url) || denied(url)) continue;
          if (/\.mpd(\?|$)/i.test(url) || /type=dash/i.test(url)) continue;
          var language = videasyLangOf([src.quality, src.language, src.lang, src.audio, src.title].join(' '));
          // Alternate-language routes stay in the list (labelled, sorted after English): the
          // app's audio/stream picker lets the viewer choose, and 'dub' mode still filters to en.
          var audioLang = language || 'en';
          if (seen[url]) continue;
          seen[url] = true;
          out.push({
            provider: 'videasy',
            server: 'Videasy ' + (ep.indexOf('/cdn') === 0 ? 'CDN' : ep.indexOf('/m4uhd') === 0 ? 'M4U' : 'VSRC') + (src.quality ? ' ' + clean(String(src.quality)) : '') + (audioLang !== 'en' ? ' · ' + audioLang.toUpperCase() : ''),
            url: url,
            headers: videasyStreamHeaders(),
            language: audioLang,
            audio: audioLang === 'en' ? 'en' : 'other',
            quality: clean(String(src.quality || '')),
          });
        }
      }
    } catch (_) {}
    return out;
  }

  // ---------------------------------------------------------------- provider 3: Stream Unity -> vixcloud
  // Works from phone IPs only (every VPS gets 403). English audio route ('sub').
  function suDecodeEntities(value) {
    var text = String(value == null ? '' : value);
    for (var i = 0; i < 3; i += 1) {
      var decoded = text
        .replace(/&quot;/gi, '"').replace(/&#039;|&#x27;/gi, "'")
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ');
      if (decoded === text) break;
      text = decoded;
    }
    return text;
  }
  function suParsePage(html) {
    var source = String(html || '');
    var match = source.match(/\bdata-page\s*=\s*"([^"]*)"/i) || source.match(/\bdata-page\s*=\s*'([^']*)'/i);
    if (!match || !match[1]) return null;
    try { return JSON.parse(suDecodeEntities(match[1])); } catch (_) { return null; }
  }
  function suProps(page) {
    if (!page || typeof page !== 'object') return {};
    return page.props && typeof page.props === 'object' ? page.props : page;
  }
  function suRecords(page) {
    var props = suProps(page);
    if (Array.isArray(props.titles)) return props.titles;
    if (Array.isArray(props.results)) return props.results;
    if (props.title && typeof props.title === 'object') return [props.title];
    return [];
  }
  function suSlug(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'title';
  }
  function suExtractVixEmbed(html) {
    var source = String(html || '').replace(/\\\//g, '/');
    var matches = source.match(/<iframe[^>]+src=["']([^"']+)["']/ig) || [];
    for (var i = 0; i < matches.length; i += 1) {
      var m = matches[i].match(/src=["']([^"']+)["']/i);
      var candidate = suDecodeEntities(clean(m && m[1]));
      if (/vixcloud\.co\//i.test(candidate)) {
        if (/^https?:\/\//i.test(candidate)) return candidate;
        if (candidate.indexOf('//') === 0) return 'https:' + candidate;
      }
    }
    var direct = source.match(/https?:\/\/vixcloud\.co\/(?:embed|e)\/[^"'<>\s]+/i);
    return direct ? suDecodeEntities(clean(direct[0])) : '';
  }
  function suUnescapeJs(value) {
    return String(value || '')
      .replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  function suVixConfig(html) {
    var source = String(html || '');
    var streams = [];
    var streamMatch = source.match(/window\.streams\s*=\s*(\[[\s\S]*?\])\s*;/i);
    if (streamMatch) {
      try {
        var parsed = JSON.parse(suUnescapeJs(streamMatch[1]));
        if (Array.isArray(parsed)) streams = parsed;
      } catch (_) {}
    }
    streams.sort(function (a, b) {
      var activeA = a && (a.active === true || a.active === 1) ? 1 : 0;
      var activeB = b && (b.active === true || b.active === 1) ? 1 : 0;
      return activeB - activeA;
    });
    var tokenMatch = source.match(/["']token["']\s*:\s*["']([^"']+)["']/i);
    var expiresMatch = source.match(/["']expires["']\s*:\s*["']([^"']+)["']/i);
    var asnMatch = source.match(/["']asn["']\s*:\s*["']([^"']*)["']/i);
    var masterMatch = source.match(/window\.masterPlaylist\s*=\s*\{[\s\S]*?\burl\s*:\s*["']([^"']+)["']/i);
    var videoMatch = source.match(/window\.video\s*=\s*\{[\s\S]*?\bid\s*:\s*["']([^"']+)["']/i);
    var bases = [];
    streams.forEach(function (stream) {
      var value = suUnescapeJs(stream && stream.url);
      if (value && value.indexOf('/playlist/') >= 0) bases.push(value);
    });
    if (masterMatch && masterMatch[1]) bases.push(suUnescapeJs(masterMatch[1]));
    return {
      streams: bases,
      token: tokenMatch ? tokenMatch[1] : '',
      expires: expiresMatch ? expiresMatch[1] : '',
      asn: asnMatch ? asnMatch[1] : '',
      mediaId: videoMatch ? videoMatch[1] : '',
      canPlayFhd: /window\.canPlayFHD\s*=\s*true/i.test(source),
    };
  }
  function suAppendQuery(url, key, value) {
    var result = String(url || '');
    if (!value || new RegExp('(?:[?&])' + key + '=', 'i').test(result)) return result;
    return result + (result.indexOf('?') >= 0 ? '&' : '?') + key + '=' + encodeURIComponent(String(value));
  }
  function suVixPlaylistUrl(base, cfg) {
    var url = clean(base).replace(/&amp;/g, '&');
    url = suAppendQuery(url, 'token', cfg.token);
    url = suAppendQuery(url, 'expires', cfg.expires);
    url = suAppendQuery(url, 'asn', cfg.asn);
    if (cfg.canPlayFhd) url = suAppendQuery(url, 'h', '1');
    url = suAppendQuery(url, 'lang', 'en');
    return url;
  }
  function suPageHeaders(extra) {
    var base = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: STREAMUNITY + '/' };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) base[k] = extra[k];
    return base;
  }
  function vixHeaders() {
    return { 'User-Agent': USER_AGENT, Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,application/octet-stream,text/plain,*/*;q=0.8', Referer: VIX + '/', Origin: VIX };
  }
  async function suCandidates(ref) {
    var out = [];
    try {
      var identity = await identityFor(ref);
      if (!identity.title) return out;
      var wantType = ref.kind === 'tv' ? 'tv' : 'movie';
      var search = await request(STREAMUNITY + '/en/search?q=' + encodeURIComponent(identity.title), suPageHeaders(), 'GET');
      if (!search.ok || !search.text) return out;
      var records = suRecords(suParsePage(search.text));
      var wanted = clean(identity.title).toLowerCase();
      var ranked = records.filter(function (row) {
        return row && row.id && clean(row.name || row.title).toLowerCase() === wanted;
      });
      if (!ranked.length) return out;
      ranked.sort(function (a, b) {
        var at = String(a.type || '').toLowerCase() === wantType ? 0 : 1;
        var bt = String(b.type || '').toLowerCase() === wantType ? 0 : 1;
        return at - bt;
      });
      var title = null;
      var titleId = '';
      for (var i = 0; i < ranked.length && i < 3 && !title; i += 1) {
        var row = ranked[i];
        var load = await request(STREAMUNITY + '/en/titles/' + row.id + '-' + suSlug(row.slug || row.name || row.title), suPageHeaders(), 'GET');
        var page = load.ok && load.text ? suParsePage(load.text) : null;
        var props = suProps(page);
        var candidate = props.title && typeof props.title === 'object' ? props.title : (Array.isArray(props.titles) ? props.titles[0] : null);
        if (candidate && candidate.id && clean(candidate.name || candidate.title).toLowerCase() === wanted) {
          title = candidate;
          titleId = String(candidate.id);
        }
      }
      if (!title || !titleId) return out;
      var mediaId = titleId;
      if (wantType === 'tv') {
        var seasonPage = await request(STREAMUNITY + '/en/titles/' + titleId + '-' + suSlug(title.slug || title.name) + '/season-' + Number(ref.season || 1), suPageHeaders(), 'GET');
        var seasonProps = seasonPage.ok && seasonPage.text ? suProps(suParsePage(seasonPage.text)) : {};
        var loadedSeason = seasonProps && seasonProps.loadedSeason;
        var rows = loadedSeason && Array.isArray(loadedSeason.episodes) ? loadedSeason.episodes : [];
        var hit = null;
        for (var e = 0; e < rows.length; e += 1) if (Number(rows[e] && rows[e].number) === Number(ref.episode)) { hit = rows[e]; break; }
        if (!hit || !hit.id) return out;
        mediaId = String(hit.id);
      }
      var iframeUrl = wantType === 'tv'
        ? STREAMUNITY + '/en/iframe/' + encodeURIComponent(titleId) + '?episode_id=' + encodeURIComponent(mediaId) + '&next_episode=1'
        : STREAMUNITY + '/en/iframe/' + encodeURIComponent(titleId);
      var iframe = await request(iframeUrl, suPageHeaders({ Referer: STREAMUNITY + '/en/watch/' + encodeURIComponent(titleId) }), 'GET');
      if (!iframe.ok || !iframe.text) return out;
      var embedUrl = suExtractVixEmbed(iframe.text);
      if (!embedUrl) return out;
      var embed = await request(embedUrl, suPageHeaders({ Referer: iframeUrl }), 'GET');
      if (!embed.ok || !embed.text) return out;
      var cfg = suVixConfig(embed.text);
      var bases = cfg.streams.slice();
      if (!bases.length && cfg.mediaId) bases.push(VIX + '/playlist/' + cfg.mediaId + '?b=1');
      for (var b = 0; b < bases.length && b < 2; b += 1) {
        var url = suVixPlaylistUrl(bases[b], cfg);
        if (!url || !publicHttpUrl(url) || denied(url)) continue;
        out.push({ provider: 'streamunity', server: 'Stream Unity', url: url, headers: vixHeaders(), language: 'en', quality: 'Auto' });
      }
    } catch (_) {}
    return out;
  }

  // ---------------------------------------------------------------- candidate collection (multi-provider)
  var identityCache = {};
  async function identityFor(ref) {
    var key = ref.kind + ':' + ref.tmdb;
    var hit = identityCache[key];
    if (hit && hit.expires > now()) return hit;
    var info = { title: '', year: '', expires: now() + 6 * 60 * 60 * 1000 };
    // Wikidata FIRST: the exact TMDB id is a claim (P4983/P4947), so the label is authoritative
    // and keyless. The themoviedb.org page scrape below is only a fallback - that host bot-walls
    // script clients (403) and a title this provider chain depends on must not ride on it.
    try {
      var prop = ref.kind === 'tv' ? 'P4983' : 'P4947';
      var sparql = 'SELECT ?item ?itemLabel ?imdb ?date WHERE { ?item wdt:' + prop + ' "' + ref.tmdb + '" . ' +
        'OPTIONAL { ?item wdt:P345 ?imdb } OPTIONAL { ?item wdt:P577 ?date } ' +
        'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 3';
      var wd = await request(WIKIDATA + '/sparql?format=json&query=' + encodeURIComponent(sparql),
        { 'User-Agent': SPARQL_AGENT, Accept: 'application/sparql-results+json' }, 'GET');
      if (wd.ok && wd.json && wd.json.results && Array.isArray(wd.json.results.bindings) && wd.json.results.bindings.length) {
        var b = wd.json.results.bindings[0];
        var lbl = b.itemLabel ? clean(String(b.itemLabel.value)) : '';
        if (lbl && !/^Q\d+$/.test(lbl)) info.title = lbl;
        if (b.date) {
          var ymw = String(b.date.value).match(/^\+?(\d{4})/);
          if (ymw) info.year = ymw[1];
        }
        if (b.imdb) info.imdb = String(b.imdb.value);
      }
    } catch (_) {}
    if (!info.title) {
      try {
        var page = await request('https://www.themoviedb.org/' + (ref.kind === 'tv' ? 'tv' : 'movie') + '/' + ref.tmdb, { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' }, 'GET');
        if (page.ok && page.text) {
          var og = String(page.text).match(/property="og:title"\s+content="([^"]+)"/i) || String(page.text).match(/content="([^"]+)"\s+property="og:title"/i);
          var title = og ? clean(suDecodeEntities(og[1])) : '';
          var ym = title.match(/^(.*?)\s*\((\d{4})\)\s*$/);
          if (ym) { info.title = clean(ym[1]); info.year = ym[2]; } else { info.title = title; }
        }
      } catch (_) {}
    }
    var keys = Object.keys(identityCache);
    if (keys.length >= 64) delete identityCache[keys[0]];
    identityCache[key] = info;
    return info;
  }
  async function collectCandidates(ref) {
    var jobs = [
      within(providerSources(ref).catch(function () { return null; }), 8500, null),
      within(videasyCandidates(ref).catch(function () { return []; }), 9000, []),
      within(suCandidates(ref).catch(function () { return []; }), 11000, []),
    ];
    var results = await Promise.all(jobs);
    var sources = [];
    var vidrockWhy = '';
    var vr = results[0];
    if (vr && vr.ok) {
      for (var i = 0; i < vr.sources.length; i += 1) {
        var src = vr.sources[i];
        var lang = String(src.language || '');
        sources.push({
          provider: 'vidrock', server: src.name, url: src.url, headers: cdnHeaders(),
          language: src.language, type: src.type,
          audio: /^(en|eng|english)([-_].*)?$/i.test(lang) ? 'en' : (lang ? 'other' : 'unknown'),
        });
      }
    } else if (vr && !vr.ok) {
      vidrockWhy = vr.parked
        ? 'The primary provider is rate-limiting right now; try again in a minute.'
        : (vr.reason === 'denied' ? 'Blocked by the independence guard.' : 'The provider did not answer for this title.');
    } else {
      vidrockWhy = 'The provider did not answer for this title.';
    }
    var extra = [results[1], results[2]];
    for (var x = 0; x < extra.length; x += 1) {
      var list = Array.isArray(extra[x]) ? extra[x] : [];
      for (var y = 0; y < list.length; y += 1) {
        var row = list[y];
        if (!row || !row.url) continue;
        if (!row.audio) row.audio = 'en';
        sources.push(row);
      }
    }
    var seenUrls = {};
    var unique = [];
    for (var u = 0; u < sources.length; u += 1) {
      if (seenUrls[sources[u].url]) continue;
      seenUrls[sources[u].url] = true;
      unique.push(sources[u]);
    }
    log('candidates: ' + unique.length + ' total (' + (vr && vr.ok ? vr.sources.length : 0) + ' vidrock, ' + (results[1] || []).length + ' videasy, ' + (results[2] || []).length + ' unity)');
    return { sources: unique, vidrockWhy: vidrockWhy };
  }

  // --- positive media validation (playlist -> variant -> segment container) ---
  async function fetchText(url, headers) {
    var res = await request(url, headers, 'GET');
    return res && res.ok ? res : null;
  }
  function classifySegment(bytes) {
    if (!bytes || bytes.length < 16) return { kind: 'empty' };
    var b = bytes;
    function at(i) {
      return b[i];
    }
    var prefix = '';
    for (var p = 0; p < Math.min(b.length, 12); p += 1) prefix += String.fromCharCode(b[p]);
    // GIF starts with G/I, which otherwise collides with the weak TS sync check.
    if (/^GIF8[79]a/.test(prefix) || /^BM/.test(prefix) ||
        (/^RIFF/.test(prefix) && prefix.slice(8, 12) === 'WEBP') ||
        (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff)) return { kind: 'image' };
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
      // Image prefixes are not portable media. Do not certify a PNG by finding two TS-like bytes.
      return { kind: 'image' };
    }
    if (at(0) === 0x47 && (at(1) & 0xc0) === 0x40) return { kind: 'ts' };
    var magic = String.fromCharCode(at(4), at(5), at(6), at(7));
    if (magic === 'ftyp' || magic === 'styp' || magic === 'moof' || magic === 'sidx') return { kind: 'fmp4' };
    var head = '';
    for (var j = 0; j < Math.min(b.length, 32); j += 1) head += String.fromCharCode(b[j]);
    if (/^\s*<|^\{|^\[/.test(head)) return { kind: 'markup' };
    return { kind: 'unknown' };
  }
  function bytesFromResponse(res) {
    if (!res) return null;
    // This is a lightweight signature probe, not byte-perfect media validation:
    // native fetchv2 may UTF-8-decode binary with replacement characters.
    var text = res.text;
    if (typeof text !== 'string' || !text.length) return null;
    var out = [];
    for (var i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff);
    return out;
  }

  async function validateHls(url, headers, session) {
    if (now() >= session.deadline) return { ok: false, reason: 'deadline' };
    var master = await fetchText(url, headers);
    if (session.closed || now() >= session.deadline) return {ok: false, reason: 'deadline'};
    if (!master || !master.text) return { ok: false, reason: 'playlist-fetch' };
    var text = String(master.text).replace(/^\uFEFF/, '').trim();
    if (text.indexOf('#EXTM3U') !== 0) return { ok: false, reason: 'not-hls', sample: text.slice(0, 40) };
    var lines = text.split('\n').map(function (l) {
      return l.trim();
    }).filter(Boolean);
    var variants = [];
    for (var i = 0; i < lines.length; i += 1) if (lines[i].charAt(0) !== '#') variants.push(lines[i]);
    var isMaster = /#EXT-X-STREAM-INF:/.test(text);
    var masterUrl = master.finalUrl || url;
    var variantUrl = isMaster && variants.length ? resolveUrl(variants[0], masterUrl) : masterUrl;
    var variant = isMaster ? await fetchText(variantUrl, headers) : master;
    if (session.closed || now() >= session.deadline) return {ok: false, reason: 'deadline'};
    if (!variant || !variant.text) return { ok: false, reason: 'variant-fetch' };
    variantUrl = variant.finalUrl || variantUrl;
    var vtext = String(variant.text).replace(/^\uFEFF/, '').trim();
    if (vtext.indexOf('#EXTM3U') !== 0) return { ok: false, reason: 'variant-not-hls' };
    if (vtext.indexOf('#EXTINF') < 0) return { ok: false, reason: 'variant-no-segments' };
    var segs = vtext.split('\n').map(function (l) {
      return l.trim();
    }).filter(function (l) {
      return l && l.charAt(0) !== '#';
    });
    if (!segs.length) return { ok: false, reason: 'variant-no-segments' };
    var segUrl = resolveUrl(segs[Math.floor(segs.length / 2)], variantUrl);
    if (session.closed || now() >= session.deadline) return { ok: false, reason: 'deadline' };
    var segRes = await request(segUrl, Object.assign({}, headers, { Range: 'bytes=0-65535' }), 'GET', null, { maxBytesHint: 2500000 });
    trace.probes += 1;
    if (session.closed || now() >= session.deadline) return { ok: false, reason: 'deadline' };
    if (!segRes || !segRes.ok) {
      var code = segRes ? segRes.status : 0;
      return { ok: false, reason: 'segment-http-' + code, master: text, variantUrl: variantUrl };
    }
    var bytes = bytesFromResponse(segRes);
    var kind = classifySegment(bytes);
    if (kind.kind === 'ts' || kind.kind === 'fmp4') {
      return { ok: true, master: text, masterUrl: masterUrl, variantUrl: variantUrl, segmentKind: kind.kind, bytes: bytes ? bytes.length : 0 };
    }
    // AES-128 encrypted HLS cannot carry a plaintext container signature. Positive alternative:
    // the variant declares a single identity-key AES-128 KEY, the key resource is fetchable,
    // and the segment itself carries real bytes (non-empty, non-markup).
    if (bytes && bytes.length > 0) {
      var keyLine = vtext.match(/#EXT-X-KEY:([^\n]+)/);
      if (keyLine) {
        var attrs = {};
        var re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
        var am;
        while ((am = re.exec(keyLine[1])) !== null) {
          var av = String(am[2] || '').trim();
          if (av.charAt(0) === '"' && av.charAt(av.length - 1) === '"') av = av.substring(1, av.length - 1);
          attrs[String(am[1]).toUpperCase()] = av;
        }
        if (attrs.METHOD === 'AES-128' && (!attrs.KEYFORMAT || attrs.KEYFORMAT === 'identity')) {
          var keyUrl = resolveUrl(attrs.URI, variantUrl);
          if (keyUrl) {
            var keyRes = await request(keyUrl, Object.assign({}, headers, { Range: 'bytes=0-15' }), 'GET', null, { maxBytesHint: 65536 });
            trace.probes += 1;
            if (session.closed || now() >= session.deadline) return { ok: false, reason: 'deadline' };
            if (keyRes && keyRes.ok && !/text\/html|application\/json/i.test((keyRes.headers || {})['content-type'] || '')) {
              return { ok: true, master: text, masterUrl: masterUrl, variantUrl: variantUrl, segmentKind: 'ts-encrypted', bytes: bytes.length };
            }
          }
        }
      }
    }
    return { ok: false, reason: 'segment-' + kind.kind, master: text, variantUrl: variantUrl };
  }
  function resolveUrl(relative, base) {
    var rel = clean(relative);
    if (/^https?:\/\//i.test(rel)) return rel;
    var m = String(base).match(/^(https?:)\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
    if (!m || /^[a-z][a-z0-9+.-]*:/i.test(rel)) return '';
    if (rel.indexOf('//') === 0) return m[1] + rel;
    var origin = m[1] + '//' + m[2];
    var basePath = m[3] || '/';
    if (!rel) return String(base).replace(/#.*$/, '');
    if (rel.charAt(0) === '#') return origin + basePath + (m[4] || '') + rel;
    if (rel.charAt(0) === '?') return origin + basePath + rel;
    var suffix = (rel.match(/[?#].*$/) || [''])[0];
    var pathname = rel.replace(/[?#].*$/, '');
    if (pathname.charAt(0) !== '/') pathname = basePath.replace(/[^/]*$/, '') + pathname;
    var parts = pathname.split('/');
    var normalized = [];
    for (var p = 0; p < parts.length; p++) {
      if (parts[p] === '..') { if (normalized.length > 1) normalized.pop(); }
      else if (parts[p] !== '.') normalized.push(parts[p]);
    }
    if (/\/(?:\.|\.\.)$/.test(pathname)) normalized.push('');
    return origin + (normalized.join('/') || '/') + suffix;
  }

  function parseQualities(master, baseUrl) {
    var out = [];
    if (!master) return out;
    // A video-only child loses the external audio group. Keep Auto on the master.
    if (String(master).split('\n').some(function (line) { return /#EXT-X-MEDIA:.*TYPE=AUDIO/.test(line) && /URI=/.test(line); })) return out;
    var lines = String(master).split('\n').map(function (l) {
      return l.trim();
    });
    for (var i = 0; i < lines.length; i += 1) {
      if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0) continue;
      var height = null;
      var rm = lines[i].match(/RESOLUTION=\d+x(\d+)/i);
      if (rm) height = Number(rm[1]);
      var next = '';
      for (var j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && lines[j].charAt(0) !== '#') {
          next = lines[j];
          break;
        }
      }
      if (!next) continue;
      out.push({ height: height, url: resolveUrl(next, baseUrl) });
    }
    var seen = {};
    var unique = [];
    for (var k = 0; k < out.length; k += 1) {
      var label = out[k].height ? out[k].height + 'p' : 'auto';
      if (seen[label]) continue;
      seen[label] = true;
      unique.push({ label: label, url: out[k].url, height: out[k].height });
    }
    return unique;
  }

  function audioLabel(source, ref) {
    var lang = source && source.language ? source.language : null;
    if (lang) return lang + ' (provider label)';
    return 'Source audio (unverified language)';
  }

  function explicitEnglishAudio(master) {
    var tracks = String(master || '').split('\n').filter(function (line) {
      return /^#EXT-X-MEDIA:/.test(line.trim()) && /(?:[:,])TYPE=AUDIO(?:,|$)/i.test(line);
    });
    var defaults = tracks.filter(function (line) { return /(?:[:,])DEFAULT=YES(?:,|$)/i.test(line); });
    var selected = defaults.length ? defaults : tracks;
    return selected.length > 0 && selected.every(function (line) {
      var language = line.match(/(?:[:,])LANGUAGE="([^"]+)"/i);
      return language && /^(en|eng)(?:[-_].*)?$/i.test(language[1]);
    });
  }

  // One candidate probe, made promise-friendly for concurrent validation.
  async function validateCandidate(source, session) {
    var check = await validateHls(source.url, source.headers || {}, session);
    return { source: source, check: check };
  }

  var captionCache = {};
  var captionPending = {};
  var captionNames = { en: 'English', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', nl: 'Dutch', tr: 'Turkish', id: 'Indonesian', ms: 'Malay', hi: 'Hindi', ru: 'Russian', pl: 'Polish', el: 'Greek', ro: 'Romanian', uk: 'Ukrainian', he: 'Hebrew', da: 'Danish', fi: 'Finnish', sv: 'Swedish', no: 'Norwegian', cs: 'Czech', hu: 'Hungarian' };
  // HLS renditions label languages in ISO 639-2/B-style codes (eng/ger/gre/fre/ita/rum...).
  var ISO3_1 = { eng: 'en', ger: 'de', deu: 'de', gre: 'el', ell: 'el', fre: 'fr', fra: 'fr', ita: 'it', rum: 'ro', ron: 'ro', dut: 'nl', nld: 'nl', por: 'pt', rus: 'ru', ukr: 'uk', spa: 'es', ara: 'ar', pol: 'pl', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', hin: 'hi', tur: 'tr', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', cze: 'cs', ces: 'cs', hun: 'hu', heb: 'he', ell2: 'el' };

  function captionTrack(row) {
    var url = clean(row && (row.url || row.file || row.src));
    if (!/^https:\/\/[^\/@\s?#]+\//i.test(url) || denied(url)) return null;
    var host = hostOf(url);
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[|0\.)/i.test(host) || /:\d+$/.test(host)) return null;
    var language = clean(row.language || row.lang || row.srclang || 'und').toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language)) language = 'und';
    var base = language.split('-')[0];
    var label = captionNames[base] || clean(row.display || row.label) || language;
    if (language !== base) label += ' (' + language + ')';
    return { id: url, url: url, file: url, language: language, lang: language, label: label, kind: 'captions', headers: { 'User-Agent': USER_AGENT, Accept: 'text/vtt,application/x-subrip,text/plain,*/*' } };
  }

  // Conservative timing sanity for a caption file: at least three cues, no more than a fifth of
  // cues with a non-positive duration, no backwards jump larger than a second, nothing absurdly far
  // into the future. Catches truncated, duplicated or garbled files without rejecting ordinary
  // subtitles. This is NOT synchronization verification against the video (that needs the device).
  function captionTimingOk(text) {
    var re = /(\d{1,2}):(\d{2})(?::(\d{2}))?[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2})(?::(\d{2}))?[.,](\d{3})/g;
    function ms(a, b, c, milli) {
      // WebVTT allows MM:SS.mmm (2-part) and HH:MM:SS.mmm (3-part). The 2-part form used to be
      // read as HH:MM, inflating every timestamp x60 and rejecting any episode whose cues ran
      // past ~4:00 (measured: a 47-min episode's track failed the 'far future' bound because
      // 57:51 read as 57 hours). Hours are zero unless the seconds group is present.
      var h = c !== undefined ? Number(a) : 0;
      var m2 = c !== undefined ? Number(b) : Number(a);
      var s2 = c !== undefined ? Number(c) : Number(b);
      return ((h * 60 + m2) * 60 + s2) * 1000 + Number(milli);
    }
    var cues = [];
    var match;
    while ((match = re.exec(text)) && cues.length < 6000) {
      cues.push([ms(match[1], match[2], match[3], match[4]), ms(match[5], match[6], match[7], match[8])]);
    }
    if (!cues.length) return false; // a single-cue file is legitimate; ordering checks catch corruption
    var broken = 0;
    var lastEnd = 0;
    for (var i = 0; i < cues.length; i += 1) {
      if (cues[i][1] <= cues[i][0]) broken += 1;
      if (cues[i][0] + 1000 < lastEnd) return false;
      if (cues[i][0] > 4 * 3600 * 1000) return false;
      if (cues[i][1] > lastEnd) lastEnd = cues[i][1];
    }
    return broken / cues.length <= 0.2;
  }

  async function checkedCaption(track, language) {
    var res = await request(track.url, track.headers, 'GET', null, { maxBytesHint: 2000000 });
    if (!res.ok || !res.text || res.text.length > 2000000 || !/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\d{1,2}:\d{2}/.test(res.text)) return null;
    if (!captionTimingOk(res.text)) return null;
    var dialogue = res.text.replace(/<[^>]*>/g, '').replace(/[^A-Za-z\u0600-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g, '');
    var nonLatin = dialogue.replace(/[A-Za-z]/g, '').length;
    if (language === 'en' && dialogue.length > 20 && nonLatin / dialogue.length > 0.2) return null;
    return Object.assign({}, track, { content: res.text, format: /^\uFEFF?WEBVTT/.test(res.text) ? 'vtt' : 'srt' });
  }

  // ---- embedded (in-manifest) subtitle renditions -------------------------------------------
  // HLS masters declare subtitle rendition playlists (EXT-X-MEDIA TYPE=SUBTITLES). They are
  // fetched and merged into explicit tracks so captions survive the external chain's outages,
  // English first. Measured on vixcloud: one VTT segment per rendition (~30-50 KB), so the whole
  // set costs a handful of bounded requests.
  function embeddedSubRenditions(masterText, masterUrl) {
    var out = [];
    var lines = String(masterText || '').split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!/^#EXT-X-MEDIA:/.test(line) || !/(?:[:,])TYPE=SUBTITLES(?:,|$)/i.test(line)) continue;
      var attrs = {};
      line.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi, function (_, k, v) {
        v = String(v).trim();
        if (v.charAt(0) === '"') v = v.slice(1, -1);
        attrs[k.toUpperCase()] = v;
        return '';
      });
      if (!attrs.URI) continue;
      var raw = String(attrs.LANGUAGE || '').toLowerCase();
      var base = ISO3_1[raw] || raw.split('-')[0];
      if (!/^[a-z]{2,3}$/.test(base)) base = 'und';
      out.push({
        lang: raw || 'und',
        base: base,
        name: String(attrs.NAME || '').trim(),
        forced: attrs.FORCED === 'YES' || /forc/i.test(String(attrs.NAME || '')),
        url: resolveUrl(attrs.URI, masterUrl),
      });
    }
    return out;
  }

  async function fetchEmbeddedCaption(rend, headers, deadline) {
    if (now() > deadline) return null;
    var pid = (String(rend.url).match(/\/playlist\/(\d+)/) || [])[1] || String(rend.url).slice(-40);
    var key = 'vsub:' + pid + ':' + rend.base;
    var hit = cacheGet(key);
    if (hit !== null) return hit || null;
    var content = null;
    try {
      var pl = await fetchText(rend.url, headers);
      if (!pl || !pl.text || String(pl.text).indexOf('#EXTM3U') < 0) return null;
      var segs = String(pl.text).split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && l.charAt(0) !== '#'; });
      if (!segs.length || segs.length > 24) return null;
      var parts = [];
      var total = 0;
      for (var i = 0; i < segs.length; i += 1) {
        if (now() > deadline) return null;
        var sg = await fetchText(resolveUrl(segs[i], pl.finalUrl || rend.url), headers);
        var t = sg && sg.text ? String(sg.text) : '';
        if (!t) return null;
        total += t.length;
        if (total > 400000) return null;
        parts.push(t.replace(/^\uFEFF/, ''));
      }
      var merged;
      if (parts.length === 1) {
        merged = parts[0];
      } else if (parts.some(function (t) { return /^X-TIMESTAMP-MAP/im.test(t); })) {
        return null; // segmented captions with relative timing are not safely mergeable - skip
      } else {
        merged = 'WEBVTT\n\n' + parts.map(function (t) {
          return t.replace(/^WEBVTT[^\n]*\n/, '').replace(/^\s+|\s+$/g, '');
        }).join('\n\n');
      }
      if (!/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->/.test(merged)) return null;
      if (merged.length > 400000 || !captionTimingOk(merged)) return null;
      content = merged;
    } catch (_) { content = null; }
    cacheSet(key, content || '');
    return content;
  }

  // Embedded tracks first (they are exact-to-the-stream), then external tracks for any language
  // the renditions do not cover; English first within the merged list.
  function mergeCaptions(embedded, external) {
    var out = [];
    var seen = {};
    (embedded || []).forEach(function (t) {
      var b = String(t.lang || '').split('-')[0];
      if (b && b !== 'und' && !seen[b] && out.length < 64) { seen[b] = true; out.push(t); }
    });
    (external || []).forEach(function (t) {
      var b = String(t.lang || t.language || '').split('-')[0];
      if (b && b !== 'und' && !seen[b] && out.length < 64) { seen[b] = true; out.push(t); }
    });
    var en = [], rest = [];
    out.forEach(function (t) { (/^en/.test(String(t.lang || '')) ? en : rest).push(t); });
    return en.concat(rest);
  }

  async function captionTracks(ref, language) {
    var lang = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language || '') ? language : 'en';
    var key = [ref.kind, ref.tmdb, ref.season || 0, ref.episode || 1, lang].join(':');
    var hit = captionCache[key];
    if (hit && hit.expires > now()) return hit.rows;
    if (captionPending[key]) return captionPending[key];
    var job = (async function () {
      var rows = [];
      var selected = null;
      try {
        var url = 'https://subtitles.shegu.st/subtitles?type=' + ref.kind + '&tmdb=' + ref.tmdb;
        if (ref.kind === 'tv') url += '&season=' + ref.season + '&episode=' + ref.episode;
        var primary = await request(url, { Accept: 'application/json' }, 'GET');
        if (primary.ok && primary.json && Array.isArray(primary.json.subtitles)) {
          rows = primary.json.subtitles.filter(function (row) { return row && /^https:\/\/subtitles\.shegu\.st\/sub\/[A-Za-z0-9_-]+$/.test(row.url || ''); }).map(captionTrack).filter(Boolean);
          var candidates = rows.filter(function (row) { return row.language === lang; }).slice(0, 2);
          for (var i = 0; i < candidates.length && !selected; i += 1) selected = await checkedCaption(candidates[i], lang);
        }
        // The existing server keeps fallback credentials private. Do not call it
        // when Cinejoy already supplied a usable file in the requested language.
        if (!selected) {
          var fallbackUrl = 'https://one.synthetiq.uk/v1/subs?id=' + ref.tmdb + '&language=' + encodeURIComponent(lang) + '&format=srt';
          if (ref.kind === 'tv') fallbackUrl += '&season=' + ref.season + '&episode=' + ref.episode;
          var fallback = await request(fallbackUrl, { Accept: 'application/json' }, 'GET');
          var extras = fallback.ok && fallback.json && Array.isArray(fallback.json.subtitles) ? fallback.json.subtitles.map(captionTrack).filter(Boolean) : [];
          for (var j = 0; j < extras.length && j < 2 && !selected; j += 1) {
            if (extras[j].language === lang) selected = await checkedCaption(extras[j], lang);
          }
        }
      } catch (_) { /* Caption availability must not turn working video into an error. */ }
      var seen = {};
      var result = selected ? [selected] : [];
      seen[lang] = true;
      rows.forEach(function (row) {
        if (!seen[row.language] && row.language !== 'und' && result.length < 64) { seen[row.language] = true; result.push(row); }
      });
      var keys = Object.keys(captionCache);
      if (keys.length >= 12) delete captionCache[keys[0]];
      captionCache[key] = { rows: result, expires: now() + (result.length ? 600000 : 60000) };
      return result;
    })();
    captionPending[key] = job;
    try { return await job; } finally { delete captionPending[key]; }
  }

  async function extractSubtitles(episodeHref, language) {
    var ref = parseRef(episodeHref);
    if (!ref || ref.kind === 'item') return { subtitles: [] };
    return { subtitles: await captionTracks(ref, language) };
  }

  // Stable partition: English-audio candidates first, everything else after — the app plays
  // the first server by default, so an alternate-language route must never outrank English.
  function englishFirst(list, audioOf) {
    var en = [];
    var rest = [];
    for (var i = 0; i < list.length; i += 1) {
      var audio = audioOf(list[i]);
      if (audio === 'en') en.push(list[i]);
      else rest.push(list[i]);
    }
    return en.concat(rest);
  }

  // Language names for the alternate-audio labels (codes come from videasyLangOf).
  var LANG_NAMES = { hi: 'Hindi', es: 'Spanish', de: 'German', pt: 'Portuguese', fr: 'French', ar: 'Arabic', it: 'Italian', ja: 'Japanese', ko: 'Korean' };

  // Audio renditions declared in an HLS master — exactly what the app's Audio selector can
  // offer for this stream. Returns unique language codes, e.g. ['IT', 'EN'].
  function audioGroupsOf(master) {
    var lines = String(master || '').split('\n');
    var out = [];
    var seen = {};
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!/^#EXT-X-MEDIA:/.test(line) || !/(?:[:,])TYPE=AUDIO(?:,|$)/i.test(line)) continue;
      var m = line.match(/LANGUAGE="([^"]+)"/i) || line.match(/NAME="([^"]+)"/i);
      if (!m) continue;
      var code = String(m[1]).toLowerCase().slice(0, 3);
      if (seen[code]) continue;
      seen[code] = true;
      out.push(code.toUpperCase());
    }
    return out;
  }


  /* ------------------------------------------------------------------ */
  /* MoviesAPI / VidSpark stream provider (verified 2026-10)             */
  /* ------------------------------------------------------------------ */
  async function vidoraDrawResult(ref, lang) {
    var isTv = ref.kind === 'tv';
    var path = isTv
      ? '/v1/tv/' + encodeURIComponent(ref.tmdb) + '/' + (ref.season || 1) + '/' + (ref.episode || 1)
      : '/v1/movie/' + encodeURIComponent(ref.tmdb);
    var referer = 'https://moviesapi.to/' + (isTv
      ? 'tv/' + ref.tmdb + '/' + (ref.season || 1) + '/' + (ref.episode || 1)
      : 'movie/' + ref.tmdb);
    var res;
    try {
      res = await request(VIDORA + path, {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'x-player-key': VIDORA_KEY,
        Origin: 'https://moviesapi.to',
        Referer: referer,
      }, 'GET');
    } catch (e) { return null; }
    var d = res && res.json;
    if (!res || !res.ok || !d || d.result !== true) return null;
    var src = (d.sources || [])[0];
    if (!src || !src.url) return null;
    var master = String(src.url);
    var hdrs = { 'User-Agent': USER_AGENT, Accept: '*/*', Origin: 'https://moviesapi.to', Referer: 'https://moviesapi.to/' };
    var mres;
    try { mres = await request(master, hdrs, 'GET'); } catch (e) { return null; }
    if (!mres || !mres.ok || !mres.text || mres.text.indexOf('#EXTM3U') < 0) return null;
    var qs = parseQualities(mres.text, master) || [];
    var usable = qs.filter(function (q) { return q && q.url; });
    if (!usable.length) return null;
    var vres;
    try { vres = await request(usable[0].url, hdrs, 'GET'); } catch (e) { log('vidora variant error ' + (e && e.message)); return null; }
    if (!vres || !vres.ok || !vres.text || vres.text.indexOf('#EXTM3U') < 0 || vres.text.indexOf('#EXTINF') < 0) return null;
    var subs = (src.tracks || []).map(function (t) {
      var file = t.file || t.src || t.url;
      if (!file) return null;
      return { label: t.label || 'English', language: 'en', srclang: 'en', kind: 'captions', file: file, url: file, headers: hdrs };
    }).filter(Boolean);
    var streams = ['sub Auto', master];
    var qualityObjects = [];
    for (var i = 0; i < usable.length && i < 6; i += 1) {
      qualityObjects.push({ label: usable[i].label, url: usable[i].url, headers: hdrs });
      if (usable[i].url !== master) streams.push(usable[i].label, usable[i].url);
    }
    return {
      url: master,
      streams: streams,
      headers: hdrs,
      streamType: 'hls',
      lang: 'sub',
      quality: 'Auto',
      defaultQuality: 'Auto',
      qualities: [{ label: 'Auto', url: master, headers: hdrs }].concat(qualityObjects),
      servers: [{
        name: 'MoviesAPI',
        label: 'English audio · MoviesAPI',
        url: master,
        headers: hdrs,
        streamType: 'hls',
        lang: 'sub',
        audioLanguage: 'en',
        qualities: usable,
        subtitles: subs,
      }],
      subtitles: subs,
      movie: ref.kind === 'movie',
    };
  }

  async function vidoraResult(ref, lang) {
    if (String(lang || '').toLowerCase() === 'dub') return null; // no dub audio metadata upstream
    // No timers in this sandbox: two sequential draws (the provider rotates CDN hosts and some
    // answer 429) — first verified draw wins.
    var first = await vidoraDrawResult(ref, lang);
    if (first) return first;
    return await vidoraDrawResult(ref, lang);
  }

  async function extractStreamUrl(episodeHref, lang) {
    var ref = parseRef(episodeHref);
    // Failure snapshots must expose NO bare scalar strings: naive stream pickers (the release
    // gate's catch-all Object.values branch, and possibly some app versions) treat any top-level
    // string as a candidate URL — the old `lang: 'sub'` was fetched as a relative URL and
    // surfaced as 'Only absolute URLs are supported' instead of the honest error.
    if (!ref) return { streams: [], subtitles: [], error: { message: 'Unrecognised reference: ' + String(episodeHref) } };
    if (ref.kind === 'item') {
      var resolved = await resolveItem(ref);
      if (!resolved) return { streams: [], subtitles: [], error: { message: 'This title is not resolvable to a playable id (no TMDB id on Wikidata).' } };
      if (resolved.kind === 'movie') ref = { kind: 'movie', tmdb: resolved.tmdb, episode: 1 };
      else return { streams: [], subtitles: [], error: { message: 'Series need an episode reference — open the episode list first.' } };
    }

    try {
      var fast = await vidoraResult(ref, lang);
      if (fast) {
        log('stream via MoviesAPI: ' + (ref.kind === 'tv' ? 'tv ' + ref.tmdb : 'movie ' + ref.tmdb) + ' subs=' + fast.subtitles.length);
        return fast;
      }
    } catch (_) {}

    var session = { closed: false, deadline: now() + 20000 };
    var collected = await collectCandidates(ref);
    var found = { sources: collected.sources };
    if (!found.sources.length) {
      var why = collected.vidrockWhy || 'Every source for this title answered empty right now.';
      return { streams: [], subtitles: [], error: { message: why } };
    }

    if (lang === 'dub') {
      found.sources = found.sources.filter(function (source) { return source.audio === 'en'; });
      if (!found.sources.length) return { streams: [], subtitles: [], error: { message: 'No source offers a verified English audio route.' } };
    }

    var accepted = [];
    var rejected = [];
    // Prefer plain HLS in launch order, but let a verified opaque route rescue a stalled sibling.
    var plainSources = [];
    var opaqueSources = [];
    for (var si = 0; si < found.sources.length; si += 1) {
      if (/\.m3u8(\?|$)/i.test(found.sources[si].url)) plainSources.push(found.sources[si]);
      else opaqueSources.push(found.sources[si]);
    }
    log('candidates: ' + plainSources.length + ' plain, ' + opaqueSources.length + ' token-path');
    // The app consumes this returned snapshot; it does not call extractSubtitles later.
    var captionsSeen;
    var captionJob = captionTracks(ref, 'en').then(
      function (rows) {
        captionsSeen = rows || [];
        return captionsSeen;
      },
      function () {
        captionsSeen = [];
        return captionsSeen;
      },
    );

    var primary = null;
    plainSources = englishFirst(plainSources, function (s) { return s.audio; });
    opaqueSources = englishFirst(opaqueSources, function (s) { return s.audio; });
    var queue = plainSources.concat(opaqueSources).slice(0, 10);
    var nextCandidate = 0;
    var primaryReady;
    var first = new Promise(function (resolve) { primaryReady = resolve; });
    async function worker() {
      while (!session.closed && now() < session.deadline && nextCandidate < queue.length) {
        var src = queue[nextCandidate++];
        var outcome = await within(validateCandidate(src, session).catch(function () {
          return null;
        }), Math.min(6500, session.deadline - now()), null);
        if (session.closed) return;
        if (lang === 'dub' && outcome && outcome.check && src.provider === 'vidrock' && !explicitEnglishAudio(outcome.check.master)) {
          rejected.push((src.server || src.name || src.provider || 'source') + ':english-audio-not-confirmed');
          continue;
        }
        if (outcome && outcome.check && outcome.check.ok) {
          accepted.push(outcome);
          if (!primary) { primary = outcome; primaryReady(outcome); }
        } else {
          rejected.push((src.server || src.name || src.provider || 'source') + ':' + (outcome && outcome.check ? outcome.check.reason : 'probe-timeout'));
        }
      }
    }
    // Three video probes leave room for the caption request in the bridge's four-request budget.
    var workers = Promise.all([worker(), worker(), worker()]);
    await within(Promise.race([first, workers]), session.deadline - now(), null);
    if (primary) {
      // Collect fast alternatives and captions, never wait indefinitely for slow siblings.
      await within(Promise.all([workers, captionJob]), Math.min(1500, session.deadline - now()), null);
    }
    session.closed = true;
    if (rejected.length) log('rejected routes: ' + rejected.join(', '));
    if (!primary) {
      return { streams: [], subtitles: [], error: { message: 'Every server for this title failed media validation.' } };
    }
    accepted = englishFirst(accepted, function (o) { return o.source && o.source.audio; });
    primary = accepted[0];

    // Embedded (in-manifest) captions: source them from the best ACCEPTED route that declares
    // subtitle renditions - the fastest route is not always the one carrying them. Measured on
    // vixcloud: one VTT segment per rendition (~30-50 KB), so the whole set is bounded requests.
    var embeddedTracks = null;
    var capSrc = null;
    var capRends = null;
    for (var csi = 0; csi < accepted.length; csi += 1) {
      var rList = embeddedSubRenditions(accepted[csi].check.master, accepted[csi].check.masterUrl || accepted[csi].source.url).filter(function (r) {
        return !r.forced;
      });
      if (rList.length) { capSrc = accepted[csi]; capRends = rList; break; }
    }
    if (capSrc) {
      var rendUniq = [];
      var rendSeen = {};
      for (var ri2 = 0; ri2 < capRends.length; ri2 += 1) {
        if (rendSeen[capRends[ri2].base]) continue;
        rendSeen[capRends[ri2].base] = true;
        rendUniq.push({ rend: capRends[ri2], order: rendUniq.length });
      }
      if (rendUniq.length) {
        embeddedTracks = [];
        var embeddedJob = (async function () {
          var dl = Math.min(now() + 6000, session.deadline - 300);
          var total = 0;
          var nextR = 0;
          async function ew() {
            while (nextR < rendUniq.length && now() < dl && total < 700000) {
              var entryR = rendUniq[nextR++];
              try {
                var content = await within(fetchEmbeddedCaption(entryR.rend, capSrc.source.headers || {}, dl), Math.min(3000, dl - now()), null);
                if (content) {
                  total += content.length;
                  embeddedTracks.push({
                    order: entryR.order,
                    track: {
                      id: 'embedded:' + entryR.rend.base,
                      language: entryR.rend.base,
                      lang: entryR.rend.base,
                      label: captionNames[entryR.rend.base] || entryR.rend.name || entryR.rend.base,
                      kind: 'captions',
                      content: content,
                      format: 'vtt',
                    },
                  });
                }
              } catch (_) { /* captions must never break playback */ }
            }
          }
          await Promise.all([ew(), ew(), ew(), ew()]);
          return embeddedTracks;
        })();
        await within(embeddedJob, Math.min(4500, session.deadline - now()), null);
        if (!embeddedTracks.length) log('embedded captions still resolving; video returned without waiting');
      }
    }
    var embeddedResolved = (embeddedTracks || []).slice()
      .sort(function (a, b) { return a.order - b.order; })
      .map(function (x) { return x.track; });
    var captions = mergeCaptions(embeddedResolved, captionsSeen !== undefined ? captionsSeen : []);
    if (captionsSeen === undefined) log('captions still resolving; verified video returned without waiting');
    void captionJob;

    var qualities = parseQualities(primary.check.master, primary.check.masterUrl || primary.source.url);
    // Contract shape (mirrors the certified anime module): `streams` is a FLAT label/url pair array,
    // `url` is the primary stream, and `qualities` are objects with the Auto entry first.
    var streams = [(lang === 'dub' ? 'dub' : 'sub') + ' Auto', primary.source.url];
    var qualityObjects = [];
    for (var q = 0; q < qualities.length && q < 6; q += 1) {
      if (!qualities[q] || !qualities[q].url) continue;
      qualityObjects.push({ label: qualities[q].label, url: qualities[q].url, headers: primary.source.headers || {} });
      if (qualities[q].url !== primary.source.url) streams.push(qualities[q].label, qualities[q].url);
    }

    var servers = [];
    var seen = {};
    for (var a = 0; a < accepted.length; a += 1) {
      var acc = accepted[a];
      if (seen[acc.source.url]) continue;
      seen[acc.source.url] = true;
      var audioText;
      if (acc.source.provider === 'vidrock') audioText = audioLabel(acc.source, ref);
      else if (acc.source.audio && acc.source.audio !== 'en') audioText = (LANG_NAMES[String(acc.source.language || '').toLowerCase()] || 'Alternate') + ' audio';
      else audioText = 'English audio';
      var groups = audioGroupsOf(acc.check.master);
      servers.push({
        name: acc.source.server || acc.source.name,
        label: audioText + ' · ' + (acc.source.server || acc.source.name) + (groups.length > 1 ? ' · ' + groups.join('+') + ' audio' : ''),
        url: acc.source.url,
        headers: acc.source.headers || {},
        streamType: 'hls',
        lang: lang === 'dub' ? 'dub' : 'sub',
        audioLanguage: acc.source.audio === 'en' ? 'en' : String(acc.source.language || 'other'),
        qualities: parseQualities(acc.check.master, acc.check.masterUrl || acc.source.url),
        // Full list on the primary only. The bridge hard-cuts any result at 2 MiB and inline
        // caption bodies are heavy; other entries carry the light (url-based) rows so the total
        // payload stays far under the cap. The app resolves the loaded source to the PRIMARY
        // entry (or falls back to the top-level list when this is empty), so nothing is lost.
        subtitles: servers.length === 0 ? captions : captions.filter(function (t) { return !t.content; }),
      });
    }

    log(
      'stream ' + (ref.kind === 'tv' ? 'tv ' + ref.tmdb + ' S' + ref.season + 'E' + ref.episode : 'movie ' + ref.tmdb) +
        ': servers=' + servers.length + ' accepted=' + accepted.length + ' rejected=' + rejected.length + ' qualities=' + qualities.length,
    );
    var result = {
      url: primary.source.url,
      streams: streams,
      headers: primary.source.headers || {},
      streamType: 'hls',
      lang: lang === 'dub' ? 'dub' : 'sub',
      quality: 'Auto',
      defaultQuality: 'Auto',
      qualities: [{ label: 'Auto', url: primary.source.url, headers: primary.source.headers || {} }].concat(qualityObjects),
      servers: servers,
      subtitles: captions,
      movie: ref.kind === 'movie',
    };
    // The app bridge SILENTLY truncates any module result at 2 MiB (JSON.parse then fails with
    // 'Unterminated string'). Bound the snapshot with a graded tail-drop: the heavy inline bodies
    // are duplicated once (top-level list + primary server entry, which the app prefers), so the
    // emergency ceiling sits at 1.85 MB. English is kept unconditionally; the LAST languages give
    // way first. Tracks are shared objects, so one deletion updates both lists.
    try {
      var sizeGuard = function () { try { return JSON.stringify(result).length; } catch (_) { return 0; } };
      var sz = sizeGuard();
      if (sz > 1850000) {
        for (var tj = captions.length - 1; tj >= 1 && sz > 1850000; tj -= 1) {
          if (captions[tj] && captions[tj].content) {
            delete captions[tj].content;
            sz = sizeGuard();
          }
        }
        log('caption payload trimmed to fit the app bridge budget');
      }
    } catch (_) {}
    return result;
  }

  // ---------------------------------------------------------------- discovery
  // Home and feeds use category continuation plus direct entity batches, not SPARQL full scans.
  // The older pool helpers below are retained but are not used by discoveryHome/discoveryFeed.
  async function topPageviews(period) {
    var key = 'pv:' + period;
    var cached = cacheGet(key);
    if (cached) return cached;
    var res = await request(
      'https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/' + period + '/all-days',
      wikiHeaders(),
      'GET',
    );
    var rows = res && res.json && res.json.items && res.json.items[0] && Array.isArray(res.json.items[0].articles) ? res.json.items[0].articles : [];
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var t = clean(String(rows[i].article || '').replace(/_/g, ' '));
      if (!t) continue;
      if (/^(Main Page|Special:|Wikipedia:|Portal:|Help:|File:|Template:|Category:|Draft:)/i.test(t)) continue;
      out.push({ title: t, views: Number(rows[i].views) || 0 });
    }
    return cacheSet(key, out);
  }

  function periodNow() {
    var d = new Date();
    var m = d.getUTCMonth() + 1;
    var y = d.getUTCFullYear();
    if (m === 1) {
      m = 12;
      y -= 1;
    } else m -= 1;
    return y + '/' + pad2(m);
  }

  async function categoryTitles(category, limit) {
    return (await categoryPage(category, limit || 40, null)).titles;
  }

  async function qidsForTitles(titles) {
    var list = (titles || []).filter(Boolean).slice(0, 50);
    if (!list.length) return {};
    var key = 'q4t:' + list.slice().sort().join('|');
    var cached = cacheGet(key);
    if (cached) return cached;
    var res = await request(
      WIKIDATA_API + '/w/api.php?action=wbgetentities&sites=enwiki&props=sitelinks&format=json&titles=' + encodeURIComponent(list.join('|')),
      wikiHeaders(),
      'GET',
    );
    var map = {};
    var ents = res && res.json && res.json.entities ? res.json.entities : {};
    for (var id in ents) {
      if (!ents.hasOwnProperty(id)) continue;
      if (!/^Q\d+$/.test(id)) continue;
      var ent = ents[id];
      var title = ent && ent.sitelinks && ent.sitelinks.enwiki ? String(ent.sitelinks.enwiki.title) : null;
      if (!title) continue;
      map[title] = id;
      map[title.replace(/_/g, ' ')] = id;
    }
    for (var i = 0; i < list.length; i += 1) if (!map[list[i]] && map[list[i].replace(/ /g, '_')]) map[list[i]] = map[list[i].replace(/ /g, '_')];
    return cacheSet(key, map);
  }

  async function itemsForTitles(titles) {
    var list = (titles || []).filter(Boolean);
    if (!list.length) return [];
    var map = {};
    for (var c = 0; c < list.length && c < 150; c += 50) {
      var chunk = await qidsForTitles(list.slice(c, c + 50));
      for (var t in chunk) if (chunk.hasOwnProperty(t)) map[t] = chunk[t];
    }
    var qids = [];
    for (var i = 0; i < list.length; i += 1) {
      var q = map[list[i]] || map[list[i].replace(/ /g, '_')];
      if (q && qids.indexOf(q) < 0) qids.push(q);
    }
    if (!qids.length) return [];
    var info = await wikidataInfo(qids);
    var out = [];
    for (var k = 0; k < qids.length; k += 1) {
      var meta = info[qids[k]];
      if (!meta) continue;
      var id = tmdbOf(meta);
      if (!id) continue; // only surface what can actually be played
      seedItemCache(qids[k], meta);
      out.push({ qid: qids[k], label: meta.label || null, year: meta.year || null, article: meta.article || meta.label || null, kind: id.kind, tmdb: id.id, imdb: meta.imdb || null });
    }
    return out;
  }

  async function cardsForItems(items, limit) {
    var slice = (items || []).filter(Boolean).slice(0, limit || 20);
    if (!slice.length) return [];
    var posters = await postersFor(slice.map(function (it) {
      return it.article || it.label;
    }));
    var images = await posterFallbacks(slice, posters);
    var out = [];
    for (var i = 0; i < slice.length; i += 1) {
      var it = slice[i];
      if (!it.qid) continue;
      out.push({
        href: 'alpha:' + it.qid,
        title: it.year && it.label ? it.label + ' (' + it.year + ')' : it.label || it.qid,
        image: images[i] || null,
        type: it.kind,
      });
    }
    return out;
  }

  var FEEDS = {
    'popular-movies': { title: 'Popular Movies', kind: 'movie' },
    'recent-movies': { title: 'New Releases', kind: 'movie' },
    'popular-series': { title: 'TV Series', kind: 'tv' },
  };

  async function tmdbPoster(item) {
    if (!item || !/^(movie|tv)$/.test(item.kind) || !Number.isSafeInteger(item.tmdb) || item.tmdb <= 0) return null;
    var key = 'tmdb-poster:' + item.kind + ':' + item.tmdb;
    var cached = cacheGet(key);
    if (cached) return cached;
    var page = 'https://www.themoviedb.org/' + item.kind + '/' + item.tmdb;
    var res = await request(page, { 'User-Agent': USER_AGENT, Accept: 'text/html' }, 'GET');
    if (!res.ok || !res.text) return null;
    var tags = res.text.match(/<meta\b[^>]*>/gi) || [];
    var canonical = null;
    var image = null;
    tags.forEach(function (tag) {
      var attrs = {};
      tag.replace(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g, function (_, name, quote, value) { attrs[name.toLowerCase()] = value.replace(/&amp;/g, '&'); });
      if (attrs.property === 'og:url') canonical = attrs.content;
      if (attrs.property === 'og:image' && !image && /^https:\/\/(?:media\.themoviedb\.org|image\.tmdb\.org)\/t\/p\/(?:w\d+|original)\/[a-zA-Z0-9]+\.(?:jpg|png|webp)$/.test(attrs.content || '')) image = attrs.content;
    });
    if (!canonical || !(canonical === page || canonical.indexOf(page + '-') === 0 || canonical === page + '/')) return null;
    if (image) cacheSet(key, image);
    return image;
  }

  // TVMaze artwork fallback for a card whose primary (Wikipedia pageimage) came back empty.
  // Exact when the entity carries an IMDb id (P345 -> /lookup/shows?imdb=), else a show search
  // that only accepts an exact name with a compatible premiere year - a wrong poster is worse
  // than none. One request per item; results (including misses) are cached.
  async function tvmazePoster(item) {
    if (!item) return null;
    var imdb = /^tt\d+$/.test(String(item.imdb || '')) ? String(item.imdb) : null;
    var bare = String(item.article || item.label || '').replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!imdb && !(bare && item.kind === 'tv')) return null;
    var key = 'tvmz-art:' + (imdb || bare.toLowerCase()) + ':' + (item.year || '');
    var hit = cacheGet(key);
    if (hit !== null) return hit || null;
    var img = null;
    try {
      if (imdb) {
        var lookup = await request(TVMAZE + '/lookup/shows?imdb=' + imdb,
          { 'User-Agent': USER_AGENT, Accept: 'application/json' }, 'GET');
        if (lookup.ok && lookup.json && lookup.json.externals && lookup.json.externals.imdb === imdb) {
          var li = lookup.json.image || null;
          img = li ? String(li.original || li.medium || '') || null : null;
        }
      }
      if (!img && bare && item.kind === 'tv') {
        var sres = await request(TVMAZE + '/search/shows?q=' + encodeURIComponent(bare),
          { 'User-Agent': USER_AGENT, Accept: 'application/json' }, 'GET');
        if (sres.ok && Array.isArray(sres.json)) {
          var cands = [];
          for (var i = 0; i < sres.json.length && i < 5; i += 1) {
            var s = sres.json[i] && sres.json[i].show;
            if (!s || !s.image) continue;
            if (String(s.name || '').trim().toLowerCase() !== bare.toLowerCase()) continue;
            cands.push(s);
          }
          var chosen = null;
          if (item.year) {
            for (var j = 0; j < cands.length && !chosen; j += 1) {
              var py = Number(String(cands[j].premiered || '').slice(0, 4));
              if (py && Math.abs(py - item.year) <= 1) chosen = cands[j];
            }
          } else if (cands.length === 1) {
            chosen = cands[0];
          }
          if (chosen) img = String(chosen.image.original || chosen.image.medium || '') || null;
        }
      }
    } catch (_) { /* a missing poster must never break a row */ }
    cacheSet(key, img || '');
    return img;
  }

  async function artworkFallback(item) {
    var img = await tvmazePoster(item);
    if (img) return img;
    try { return await tmdbPoster(item); } catch (_) { return null; }
  }

  async function posterFallbacks(items, originals) {
    // Every missing poster is still looked up (the module's contract: never leave artwork blank when
    // the exact TMDB identity has it). Speed comes from concurrency, not from skipping cards: six
    // workers overlap the page fetches instead of serialising them three at a time.
    var out = items.map(function (item) { return originals[item.article || item.label] || null; });
    var next = 0;
    async function worker() {
      while (next < items.length) {
        var index = next++;
        if (out[index]) continue;
        try { out[index] = await artworkFallback(items[index]); } catch (_) {}
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    return out;
  }

  async function categoryPage(category, limit, cursor) {
    var key = 'category-page:' + category + ':' + limit + ':' + (cursor || '');
    var cached = cacheGet(key);
    if (cached) return cached;
    var res = await request(WIKI + '/w/api.php?action=query&list=categorymembers&cmtitle=' +
      encodeURIComponent('Category:' + category) + '&cmlimit=' + limit + '&cmnamespace=0&format=json' +
      (cursor ? '&cmcontinue=' + encodeURIComponent(cursor) : ''), wikiHeaders(), 'GET');
    if (!res.ok || !res.json || !res.json.query || !Array.isArray(res.json.query.categorymembers)) throw new Error('Catalogue page temporarily unavailable. Please retry.');
    var next = res.json.continue && res.json.continue.cmcontinue;
    if (next && next === cursor) throw new Error('Catalogue repeated its continuation cursor. Please retry.');
    return cacheSet(key, { titles: res.json.query.categorymembers.map(function (row) { return clean(row.title); }).filter(Boolean), cursor: typeof next === 'string' ? next : null });
  }

  // Thin ranked windows are held for the next page attempt instead of being shipped as a tiny page.
  async function pendingCarry(state) {
    return state.rankedCarry || [];
  }

  var feedSessions = {};
  // Two tiers, in order: titles that LOOK like the kind we want first (media-dense windows - this is
  // what the home rows slice from), then everything else that is not the unmistakable opposite kind
  // (so feeds walking deeper still find films whose article carries no "(film)" suffix, e.g.
  // "Spider-Man: Brand New Day" or "Awarapan 2"). Kind is finally decided by the entity's own
  // P4947/P4983 claim in homeItems.
  function looksLike(kind, title) {
    if (kind === 'movie') return /\((?:\d{4} )?film\)$/i.test(title);
    return /\([^)]*(?:TV|television|Miniseries)[^)]*\)$/i.test(title);
  }
  async function rankedTitles(kind, rows) {
    rows = rows || await topPageviews(periodNow());
    var titles = rows.map(function (row) { return row.title; }).filter(function (title) {
      if (/^List of /i.test(title)) return false;
      if (/\((?:soundtrack|album|song|disambiguation|franchise|film series)\)$/i.test(title)) return false;
      if (kind === 'movie' && /\([^)]*(?:TV|television|Miniseries)[^)]*\)$/i.test(title)) return false;
      if (kind === 'tv' && /\((?:\d{4} )?film\)$/i.test(title)) return false;
      return true;
    });
    var first = [];
    var rest = [];
    titles.forEach(function (title) {
      (looksLike(kind, title) ? first : rest).push(title);
    });
    return first.concat(rest);
  }

  function feedCategories(feedId) {
    var out = [];
    if (feedId === 'popular-series') {
      for (var decade = Math.floor(new Date().getUTCFullYear() / 10) * 10; decade >= 1950; decade -= 10) out.push(decade + 's American television series');
    } else {
      for (var year = new Date().getUTCFullYear(); year >= 1900; year--) out.push(year + ' films');
    }
    return out;
  }

  async function nextFeedPage(state, feedId, page) {
    if ((feedId === 'popular-movies' || feedId === 'popular-series') && !state.rankedDone) {
      var rankedKind = FEEDS[feedId].kind;
      var ranked = await rankedTitles(rankedKind);
      var offset = state.rankedOffset || 0;
      var rankedItems = await homeItems(ranked.slice(offset, offset + 20));
      rankedItems = rankedItems.filter(function (item) { return item.kind === rankedKind && !state.seen[item.qid]; });
      var rankedCards = await cardsForItems(rankedItems, 20);
      state.rankedOffset = offset + 20;
      state.rankedDone = state.rankedOffset >= ranked.length;
      var rankedMin = FEEDS[feedId].kind === 'tv' ? 6 : 8;
      rankedItems.forEach(function (item) { state.seen[item.qid] = true; });
      // A window that yields a card or two is not a page. TV windows in the pageviews list are thin
      // and shipping them produced the measured 3- and 5-card TV pages while movie pages returned
      // 11-18. Thin windows are carried into the category fill below instead.
      if (rankedCards.length >= rankedMin) return { items: rankedCards, page: page, hasMore: true };
      if (rankedCards.length) state.rankedCarry = (state.rankedCarry || []).concat(rankedCards);
    }
    var categories = feedCategories(feedId);
    var category = state.category;
    var cursor = state.cursor;
    var carry = state.rankedCarry || [];
    state.rankedCarry = null;
    var items = [];
    var known = Object.assign({}, state.seen);
    var limit = feedId === 'popular-series' ? 16 : 20;
    // Pull batches until the page is actually full (bounded at four): several TV categories yield
    // one or two identity-backed series per batch, so stopping at the first non-empty batch is what
    // produced three-card pages. The cursor is only committed for batches that succeeded.
    var target = Math.ceil(limit * 0.75);
    // Fetch the next batch while the current one is being resolved: category continuation is
    // sequential by nature, but the identity lookup for batch N does not depend on batch N+1 being
    // requested, and the two are separate HTTP round trips. Measured TV page 3 at 10.2s fully
    // serialised; overlapping roughly halves the wall clock without extra requests.
    var pendingBatch = null;
    function nextBatch(cat, cur) {
      return categoryPage(categories[cat], limit, cur);
    }
    for (var attempt = 0; attempt < 4 && category < categories.length && items.length < target; attempt++) {
      var batch = await (pendingBatch || nextBatch(category, cursor));
      pendingBatch = null;
      var found = await homeItems(batch.titles);
      found.forEach(function (item) {
        if (item.kind === FEEDS[feedId].kind && !known[item.qid]) { known[item.qid] = true; items.push(item); }
      });
      cursor = batch.cursor;
      if (!cursor) category += 1;
      if (attempt + 1 < 4 && category < categories.length && items.length < target) {
        pendingBatch = nextBatch(category, cursor).catch(function () { return null; });
        pendingBatch = pendingBatch.then(function (value) { return value || null; });
      }
    }
    var more = category < categories.length;
    if (!items.length && !carry.length && more) {
      state.category = category;
      state.cursor = cursor;
      throw new Error('This catalogue page has no matched titles yet. Please retry.');
    }
    var cards = await cardsForItems(items, limit);
    if (carry.length) {
      var seenHref = {};
      cards = carry.concat(cards).filter(function (card) {
        if (!card || !card.href || seenHref[card.href]) return false;
        seenHref[card.href] = true;
        return true;
      });
    }
    state.category = category;
    state.cursor = cursor;
    state.seen = known;
    return { items: cards, page: page, hasMore: more };
  }

  async function poolFor(feedId) {
    var key = 'pool:' + feedId;
    var cached = cacheGet(key);
    if (cached) return cached;
    var feed = FEEDS[feedId];
    var out = [];
    try {
      if (feedId === 'recent-movies') {
        var y = new Date().getUTCFullYear();
        var titles = await categoryTitles(y + ' films', 80);
        titles = titles.concat(await categoryTitles(y - 1 + ' films', 80));
        out = await itemsForTitles(titles);
      } else {
        var top = await topPageviews(periodNow());
        out = await itemsForTitles(top.slice(0, 50).map(function (t) {
          return t.title;
        }));
        out = out.filter(function (it) {
          return it.kind === feed.kind;
        });
      }
      if (out.length < 40 && feed.kind === 'movie') {
        var y2 = new Date().getUTCFullYear();
        var extra = await categoryTitles(y2 + ' films', 80);
        extra = extra.concat(await categoryTitles(y2 - 1 + ' films', 80));
        out = out.concat(await itemsForTitles(extra));
      }
      if (out.length < 40 && feed.kind === 'tv') {
        var seriesTitles = await categoryTitles('2020s American television series', 80);
        if (seriesTitles.length < 20) seriesTitles = seriesTitles.concat(await categoryTitles('American television series', 80));
        out = out.concat(await itemsForTitles(seriesTitles));
      }
    } catch (e) {
      log('pool ' + feedId + ' failed: ' + (e && e.message ? e.message : e));
    }
    var seen = {};
    var uniq = [];
    for (var i = 0; i < out.length; i += 1) {
      if (!out[i].qid || seen[out[i].qid]) continue;
      seen[out[i].qid] = true;
      uniq.push(out[i]);
    }
    if (feed.kind) uniq = uniq.filter(function (it) { return it.kind === feed.kind; });
    return cacheSet(key, uniq);
  }

  async function homeItems(titles) {
    if (!titles.length) return [];
    var cacheKey = 'home-items:' + titles.join('|');
    var cached = cacheGet(cacheKey);
    if (cached) return cached;
    // Direct entity batches avoid the query service and its long-running SPARQL joins.
    var res = await request(WIKIDATA_API + '/w/api.php?action=wbgetentities&sites=enwiki' +
      '&props=claims%7Clabels%7Csitelinks&languages=en&sitefilter=enwiki&format=json&titles=' +
      encodeURIComponent(titles.slice(0, 20).join('|')), wikiHeaders(), 'GET');
    if (!res.ok || !res.json || !res.json.entities) throw new Error('Home identity lookup temporarily unavailable. Please retry.');
    var entities = res.json.entities;
    var byTitle = {};
    function claim(entity, property) {
      var rows = (entity.claims && entity.claims[property]) || [];
      var values = rows.filter(function (row) { return row.rank !== 'deprecated' && row.mainsnak && row.mainsnak.snaktype === 'value' && row.mainsnak.datavalue; });
      var preferred = values.filter(function (row) { return row.rank === 'preferred'; });
      if (preferred.length) values = preferred;
      var out = [];
      values.forEach(function (row) {
        var value = row.mainsnak.datavalue.value;
        if (typeof value === 'string' && out.indexOf(value) < 0) out.push(value);
      });
      return out.length === 1 ? out[0] : null;
    }
    for (var qid in entities) {
      if (!/^Q\d+$/.test(qid)) continue;
      var entity = entities[qid];
      var article = entity.sitelinks && entity.sitelinks.enwiki && entity.sitelinks.enwiki.title;
      if (!article || titles.indexOf(article) < 0) continue;
      var movie = claim(entity, 'P4947');
      var tv = claim(entity, 'P4983');
      if (Boolean(movie) === Boolean(tv)) continue;
      var id = movie || tv;
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) continue;
      var label = entity.labels && entity.labels.en && entity.labels.en.value || article;
      var dates = (entity.claims && (entity.claims.P577 || entity.claims.P580)) || [];
      var releaseDates = dates.filter(function (row) { return row.rank !== 'deprecated'; }).map(function (row) {
        var value = row.mainsnak && row.mainsnak.datavalue && row.mainsnak.datavalue.value;
        var match = value && String(value.time || '').match(/^\+(\d{4})-(\d{2})-(\d{2})T/);
        return match ? Date.UTC(Number(match[1]), Math.max(1, Number(match[2])) - 1, Math.max(1, Number(match[3]))) : null;
      }).filter(function (date) { return date !== null && Number.isFinite(date); });
      if (releaseDates.length && releaseDates.every(function (date) { return date > now(); })) continue;
      var years = dates.filter(function (row) { return row.rank !== 'deprecated'; }).map(function (row) {
        var value = row.mainsnak && row.mainsnak.datavalue && row.mainsnak.datavalue.value;
        var match = value && String(value.time || '').match(/^\+(\d{4})-/);
        return match ? Number(match[1]) : null;
      }).filter(Boolean);
      var year = years.length ? Math.min.apply(null, years) : null;
      var meta = { qid: qid, tmdbMovie: movie ? Number(id) : null, tmdbTv: tv ? Number(id) : null,
        imdb: claim(entity, 'P345'), year: year, kinds: [], label: label, article: article };
      seedItemCache(qid, meta);
      byTitle[article] = { qid: qid, label: label, article: article, year: year, kind: movie ? 'movie' : 'tv', tmdb: Number(id), imdb: meta.imdb || null };
    }
    return cacheSet(cacheKey, titles.map(function (title) { return byTitle[title]; }).filter(Boolean));
  }

  var homePending = null;
  var homeSnapshot = null;
  async function discoveryHome() {
    if (homeSnapshot && now() - homeSnapshot.at < 60000) return homeSnapshot.value;
    if (homePending) return homePending;
    homePending = (async function () {
      var y = new Date().getUTCFullYear();
      var popularity = await topPageviews(periodNow()).catch(function () { return []; });
      var ranked = await Promise.all([rankedTitles('movie', popularity), rankedTitles('tv', popularity)]);
      var categories = await Promise.all([
        ranked[0].length ? Promise.resolve(ranked[0].slice(0, 20)) : categoryTitles(y + ' films', 20).catch(function () { return []; }),
        ranked[1].length ? Promise.resolve(ranked[1].slice(0, 12)) : categoryTitles('2020s American television series', 12).catch(function () { return []; }),
      ]);
      if (!categories[0].length) categories[0] = await categoryTitles(y - 1 + ' films', 20).catch(function () { return []; });
      var groups = await Promise.all(categories.map(function (titles) {
        return homeItems(titles).catch(function () { return []; });
      }));
      var movies = groups[0].filter(function (it) { return it.kind === 'movie'; });
      var series = groups[1].filter(function (it) { return it.kind === 'tv'; });
      var all = movies.concat(series);
      if (!all.length) throw new Error('Home catalogue temporarily unavailable. Please retry or use Search.');
      var cards = await cardsForItems(all, 32);
      var movieCards = cards.filter(function (card) { return card.type === 'movie'; });
      var tvCards = cards.filter(function (card) { return card.type === 'tv'; });
      var sections = [];
      function add(id, title, style, items, feed) {
        if (items.length) sections.push({ id: id, title: title, style: style, items: items, viewAll: { mode: 'feed', feedId: feed } });
      }
      var featured = movieCards.length ? movieCards : tvCards;
      add('alpha-featured', 'Featured', 'hero', featured.slice(0, 8), movieCards.length ? 'popular-movies' : 'popular-series');
      add('alpha-recent', 'Movies', 'poster', movieCards.slice(8), 'popular-movies');
      add('alpha-series', 'TV Series', 'poster', movieCards.length ? tvCards : tvCards.slice(8), 'popular-series');
      var value = { sections: sections };
      homeSnapshot = { at: now(), value: value };
      return value;
    })();
    try { return await homePending; } finally { homePending = null; }
  }

  async function homeCards() {
    var home = await discoveryHome();
    var cards = [];
    home.sections.forEach(function (section) { cards = cards.concat(section.items); });
    return cards.slice(0, 32);
  }

  async function discoveryFeed(feedId, page) {
    if (!FEEDS[feedId]) return { items: [], page: Number(page) || 1, hasMore: false };
    var p = Math.max(1, Number(page) || 1);
    if (!Number.isSafeInteger(p) || p > 500) throw new Error('Invalid catalogue page.');
    var state = feedSessions[feedId];
    if (!state) state = feedSessions[feedId] = { category: 0, cursor: null, seen: {}, pages: {}, last: 0, pending: null };
    while (state.pending) await state.pending;
    if (state.pages[p]) return state.pages[p];
    if (p < state.last || p > state.last + 3) throw new Error('Reopen the catalogue before jumping to this page.');
    state.pending = (async function () {
      while (state.last < p) {
        var n = state.last + 1;
        state.pages[n] = await nextFeedPage(state, feedId, n);
        state.last = n;
        if (!state.pages[n].hasMore && n < p) return { items: [], page: p, hasMore: false };
      }
      return state.pages[p];
    })();
    try { return await state.pending; } finally { state.pending = null; }
  }

  // ---------------------------------------------------------------- exports
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractSubtitles = extractSubtitles;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
  globalThis.__alphaTrace = function () {
    return {
      requests: trace.requests.slice(-40),
      blocked: trace.blocked.length,
      probes: trace.probes,
      decrypted: trace.decrypted,
      decryptFailed: trace.decryptFailed,
      parked: trace.parked || 0,
    };
  };
  // Test surface only: raw primitive access so the harness can check AES/GCM against published
  // vectors and against WebCrypto. Nothing in the app calls these.
  globalThis.__alphaAesBlock = function (keyHex, blockHex) {
    var key = hexToBytes(keyHex);
    var block = hexToBytes(blockHex);
    var out = encryptBlock(expandKey(key), block);
    var hex = '';
    for (var i = 0; i < 16; i += 1) hex += ('0' + out[i].toString(16)).slice(-2);
    return hex;
  };
  globalThis.__alphaDecryptRaw = function (keyHex, payloadB64) {
    try {
      var raw = b64urlToBytes(payloadB64);
      if (raw.length < 28) return null;
      var iv = raw.slice(0, 12);
      var tag = raw.slice(raw.length - 16);
      var ct = raw.slice(12, raw.length - 16);
      var res = aesGcmDecrypt(hexToBytes(keyHex), iv, ct, tag);
      if (!res.tagOk) return { tagOk: false, plain: bytesToAscii(res.plain) };
      return { tagOk: true, plain: bytesToAscii(res.plain) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  };
  // Test surface only: lets the harness compare the pure-JS decryptor against a reference
  // implementation. Harmless in the app (nothing calls it) and it keeps the crypto verifiable.
  globalThis.__alphaDecrypt = function (encoded) {
    return decryptSource(String(encoded));
  };
})();
