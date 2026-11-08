(() => {
  'use strict';

  const MODULE_NAME = 'Kartoons';
  const SITE = 'https://kartoons.me';
  const API = 'https://api.kartoons.me/api';
  const CS = API + '/cloudstream';
  const VIDEASY_ORIGIN = 'https://player.videasy.to';
  const LOOKMOVIE = 'https://www.lookmovie2.to';
  const USER_AGENT =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  // LookMovie hit cache: title -> { id_show/id_movie, slug, year, kind }
  const lmHitCache = Object.create(null);
  // Show episode maps and play paths change far less often than signed access
  // URLs. Caching them removes two catalogue requests from every later play.
  const lmShowMetaCache = Object.create(null);
  // Public TMDB key used by free frontends (catalogue/id resolve only).
  const TMDB_KEY = '9801b6b0548ad57581d111ea690c85c8';
  // Embedded SPA link encryption key (AES-256-CBC). Used if native links return ciphertext.
  const LINK_KEY = 'bca9e0df1a5abb32906ca3f63ac04cef';
  const STREAM_CACHE_TTL_MS = 5 * 60 * 1000;
  const streamCache = Object.create(null);
  const episodeOrdinalCache = Object.create(null);

  // Defined early — parseHref + stream resolve use these (no network).
  const PLAYABLE_BY_SHOW = {
    '68121c7f271f42dd3dd09f50': { tmdbId: '65733', title: 'Doraemon', year: '2005' },
    '6a70a174e53c58753772b2c5': { tmdbId: '31911', title: 'Fullmetal Alchemist: Brotherhood', year: '2009' },
    '681865ce24c9061ac54aa3a2': { tmdbId: '46260', title: 'Naruto', year: '2002' },
    '681ef19518f5a104ba5f735e': { tmdbId: '31910', title: 'Naruto Shippuden', year: '2007' },
    '6823ed1c3d34005060027150': { tmdbId: '4686', title: 'Ben 10', year: '2005' },
    '683554362454037aca2590f1': { tmdbId: '2085', title: 'Courage the Cowardly Dog', year: '1999' },
    '6821aed0d1f9d64912f80cd0': { tmdbId: '12971', title: 'Dragon Ball Z', year: '1989' },
    '6817010e50d10e09357765fa': { tmdbId: '30623', title: 'Shin Chan', year: '1992' },
    '68a455e840dc1eb0212dd19f': { tmdbId: '2437', title: 'Oggy and the Cockroaches', year: '1998' },
    '68491fdf5948f47f3a15202b': { tmdbId: '60572', title: 'Pokemon', year: '1997' },
    '686a360563fd935d5802eb36': { tmdbId: '158198', title: 'Ninja Hattori', year: '2012' },
    '6982e04f04de05b1207d9647': { tmdbId: '37233', title: 'Perman', year: '1983' },
    '6827432f89211dfc2443dc04': { tmdbId: '56426', title: 'KochiKame', year: '1996' },
    '68b5b2c2d862b6766f3958c0': { tmdbId: '80609', title: 'Kiteretsu Daihyakka', year: '1988' },
    '695cc1b2d91468fbde44fe51': { tmdbId: '32035', title: 'Chhota Bheem', year: '2008' },
    '68878b1aed6dcb4325423863': { tmdbId: '70058', title: 'Motu Patlu', year: '2012' },
  };
  const DEAD_TMDB = {
    '57911': '65733',
    '57912': '65733',
  };
  const tmdbCache = Object.create(null);

  function log(msg) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(msg || ''));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(1, Number(ms) || 0)));
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([promise, sleep(waitMs).then(() => fallback)]);
  }

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function encodeQuery(params) {
    const parts = [];
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.join('&');
  }

  async function readResponseBody(res) {
    if (!res) return '';
    if (res.json !== undefined && res.json !== null && typeof res.json !== 'function') {
      try {
        return JSON.stringify(res.json);
      } catch (_) {}
    }
    if (typeof res.body === 'string' && res.body.length) return res.body;
    if (typeof res.text === 'function') {
      try {
        const text = await res.text();
        if (typeof text === 'string' && text.length) return text;
      } catch (_) {}
    }
    if (typeof res.json === 'function') {
      try {
        return JSON.stringify(await res.json());
      } catch (_) {}
    }
    return '';
  }

  function safeJsonParse(text) {
    if (text !== null && typeof text === 'object') return text;
    try {
      return JSON.parse(String(text == null ? '' : text).trim());
    } catch (_) {
      return null;
    }
  }

  async function request(url, options) {
    const cfg = options || {};
    const method = cfg.method || 'GET';
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,*/*',
        Origin: SITE,
        Referer: SITE + '/',
      },
      cfg.headers || {},
    );
    const body = cfg.body == null ? null : cfg.body;
    try {
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(url, headers, method, body);
        const status = Number((res && res.status) || 0);
        const textBody = await readResponseBody(res);
        return {
          ok: !!(res && (res.ok === true || (status >= 200 && status < 300))),
          status,
          body: textBody,
          json: safeJsonParse(textBody),
          headers: (res && res.headers) || {},
        };
      }
      if (typeof fetch === 'function') {
        const res = await fetch(url, { method, headers, body });
        const textBody = await res.text();
        return {
          ok: !!res.ok,
          status: Number(res.status || 0),
          body: textBody,
          json: safeJsonParse(textBody),
          headers: {},
        };
      }
    } catch (e) {
      log('request error: ' + (e && e.message ? e.message : String(e)));
    }
    return { ok: false, status: 0, body: '', json: null, headers: {} };
  }

  async function apiGet(path, extraHeaders) {
    return settleWithin(
      request(API + path, {
        headers: Object.assign({ Accept: 'application/json' }, extraHeaders || {}),
      }),
      20000,
      null,
    );
  }

  async function csGet(path) {
    return settleWithin(
      request(CS + path, { headers: { Accept: 'application/json' } }),
      20000,
      null,
    );
  }

  function itemId(item) {
    if (!item) return '';
    return cleanText(item._id || item.id || '');
  }

  function itemType(item) {
    const t = String((item && (item.type || item.contentType)) || '').toLowerCase();
    if (t === 'movie' || t === 'film') return 'movie';
    if (t === 'show' || t === 'tv' || t === 'series') return 'show';
    // fallbacks
    if (item && (item.releaseYear != null || item.duration != null) && item.startYear == null) {
      return 'movie';
    }
    return 'show';
  }

  function cardFromKartoons(item, typeHint) {
    if (!item) return null;
    const id = itemId(item);
    if (!id) return null;
    const type = typeHint || itemType(item);
    const href = type === 'movie' ? 'movie:' + id : 'show:' + id;
    const image = cleanText(item.image || item.coverImage || item.poster || item.hoverImage || '');
    const year = item.releaseYear || item.startYear || item.year || '';
    const title = cleanText(item.title || item.name || id);
    return {
      href: href,
      id: href,
      title: title,
      image: image,
      poster: image,
      year: year ? String(year) : '',
    };
  }

  function parseHref(raw) {
    const s = String(raw || '')
      .trim()
      .replace(/^https?:\/\/(?:www\.)?kartoons\.me\/+/i, '');
    if (!s) return null;

    // Compact: k|showId|s|e|tmdb|epId
    if (s.charAt(0) === 'k' && s.charAt(1) === '|') {
      const p = s.split('|');
      // k, showId, s, e, tmdb, epId
      return {
        kind: 'episode',
        showId: p[1] || '',
        season: numOr(p[2], 1),
        episode: numOr(p[3], 1),
        tmdbId: p[4] || '',
        episodeId: p[5] || '',
        title: '',
        seriesTitle: (PLAYABLE_BY_SHOW[p[1]] && PLAYABLE_BY_SHOW[p[1]].title) || '',
        year: '',
      };
    }

    // Legacy long form: ep:…|show:…|s:… etc
    if (s.indexOf('ep:') === 0 || s.indexOf('movie:') === 0 || s.indexOf('show:') === 0) {
      const parts = {};
      const segs = s.split('|');
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const c = seg.indexOf(':');
        if (c < 0) continue;
        parts[seg.slice(0, c)] = seg.slice(c + 1);
      }
      if (parts.ep) {
        return {
          kind: 'episode',
          episodeId: parts.ep,
          showId: parts.show || '',
          season: numOr(parts.s, 1),
          episode: numOr(parts.e, 1),
          tmdbId: parts.tmdb || '',
          title: parts.title ? decodeURIComponent(parts.title) : '',
          seriesTitle: parts.series ? decodeURIComponent(parts.series) : '',
          year: parts.year || '',
        };
      }
      if (parts.movie || (segs[0] && segs[0].indexOf('movie:') === 0)) {
        const mid = parts.movie || (segs[0] || '').slice(6);
        return {
          kind: 'movie',
          movieId: mid,
          tmdbId: parts.tmdb || '',
          title: parts.title ? decodeURIComponent(parts.title) : '',
          year: parts.year || '',
        };
      }
      if (parts.show || (segs[0] && segs[0].indexOf('show:') === 0)) {
        const sid = parts.show || (segs[0] || '').slice(5);
        return {
          kind: 'show',
          showId: sid,
          tmdbId: parts.tmdb || '',
          title: parts.title ? decodeURIComponent(parts.title) : '',
          year: parts.year || '',
        };
      }
    }

    let m = s.match(/^(show|movie):([A-Za-z0-9]+)$/i);
    if (m) {
      return m[1].toLowerCase() === 'movie'
        ? { kind: 'movie', movieId: m[2], tmdbId: '', title: '', year: '' }
        : { kind: 'show', showId: m[2], tmdbId: '', title: '', year: '' };
    }
    m = s.match(/^ep:([A-Za-z0-9]+)$/i);
    if (m) {
      return {
        kind: 'episode',
        episodeId: m[1],
        showId: '',
        season: 1,
        episode: 1,
        tmdbId: '',
        title: '',
      };
    }
    m = s.match(/^(movie|tv):(\d+)(?::(\d+):(\d+))?$/i);
    if (m) {
      if (m[1].toLowerCase() === 'movie') {
        return { kind: 'movie', movieId: '', tmdbId: m[2], title: '', year: '' };
      }
      return {
        kind: 'episode',
        episodeId: '',
        showId: '',
        season: m[3] ? Number(m[3]) : 1,
        episode: m[4] ? Number(m[4]) : 1,
        tmdbId: m[2],
        title: '',
      };
    }
    return null;
  }

  function buildShowHref(id, meta) {
    let h = 'show:' + id;
    if (meta && meta.tmdbId) h += '|tmdb:' + meta.tmdbId;
    if (meta && meta.title) h += '|title:' + encodeURIComponent(meta.title);
    if (meta && meta.year) h += '|year:' + meta.year;
    return h;
  }

  function buildMovieHref(id, meta) {
    let h = 'movie:' + id;
    if (meta && meta.tmdbId) h += '|tmdb:' + meta.tmdbId;
    if (meta && meta.title) h += '|title:' + encodeURIComponent(meta.title);
    if (meta && meta.year) h += '|year:' + meta.year;
    return h;
  }

  function numOr(value, fallback) {
    // Preserve 0 (specials). Only fall back when null/undefined/NaN/empty.
    if (value === 0 || value === '0') return 0;
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function buildEpHref(ep, showMeta) {
    const id = itemId(ep);
    const sn = numOr(
      ep && ep.seasonNumber != null ? ep.seasonNumber : null,
      numOr(showMeta && showMeta.seasonNumber, 1),
    );
    const en = numOr(
      ep && (ep.episodeNumber != null ? ep.episodeNumber : ep.number),
      1,
    );
    // Compact href — long series return 100KB+ of href strings over the JS bridge.
    // k|showId|s|e|tmdb|epId
    const showId = (showMeta && showMeta.showId) || '';
    const tmdb = (showMeta && showMeta.tmdbId) || '';
    return 'k|' + showId + '|' + sn + '|' + en + '|' + tmdb + '|' + id;
  }

  // ---------- PoW (native links) ----------
  function leadingZeroBits(digest) {
    let bits = 0;
    for (let i = 0; i < digest.length; i++) {
      const byte = digest[i];
      if (byte === 0) {
        bits += 8;
        continue;
      }
      let mask = 0x80;
      while (mask && !(byte & mask)) {
        bits++;
        mask >>= 1;
      }
      break;
    }
    return bits;
  }

  async function sha256Bytes(str) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return new Uint8Array(buf);
    }
    // Minimal pure-JS SHA-256 for flutter_js fallback
    return sha256Pure(str);
  }

  function sha256Pure(ascii) {
    function rotr(n, x) {
      return (x >>> n) | (x << (32 - n));
    }
    function ch(x, y, z) {
      return (x & y) ^ (~x & z);
    }
    function maj(x, y, z) {
      return (x & y) ^ (x & z) ^ (y & z);
    }
    function sigma0(x) {
      return rotr(2, x) ^ rotr(13, x) ^ rotr(22, x);
    }
    function sigma1(x) {
      return rotr(6, x) ^ rotr(11, x) ^ rotr(25, x);
    }
    function gamma0(x) {
      return rotr(7, x) ^ rotr(18, x) ^ (x >>> 3);
    }
    function gamma1(x) {
      return rotr(17, x) ^ rotr(19, x) ^ (x >>> 10);
    }
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
      0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
      0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
      0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
      0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
      0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
      0xc67178f2,
    ];
    const utf8 = unescape(encodeURIComponent(ascii));
    const bytes = [];
    for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 0xff);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);

    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const W = new Array(64);
    for (let i = 0; i < bytes.length; i += 64) {
      for (let t = 0; t < 16; t++) {
        W[t] =
          (bytes[i + t * 4] << 24) |
          (bytes[i + t * 4 + 1] << 16) |
          (bytes[i + t * 4 + 2] << 8) |
          bytes[i + t * 4 + 3];
      }
      for (let t = 16; t < 64; t++) {
        W[t] = (gamma1(W[t - 2]) + W[t - 7] + gamma0(W[t - 15]) + W[t - 16]) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const T1 = (h + sigma1(e) + ch(e, f, g) + K[t] + W[t]) >>> 0;
        const T2 = (sigma0(a) + maj(a, b, c)) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + T1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (T1 + T2) >>> 0;
      }
      H = [
        (H[0] + a) >>> 0,
        (H[1] + b) >>> 0,
        (H[2] + c) >>> 0,
        (H[3] + d) >>> 0,
        (H[4] + e) >>> 0,
        (H[5] + f) >>> 0,
        (H[6] + g) >>> 0,
        (H[7] + h) >>> 0,
      ];
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (H[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (H[i] >>> 8) & 0xff;
      out[i * 4 + 3] = H[i] & 0xff;
    }
    return out;
  }

  async function solvePow(nonce, bits, deadlineMs) {
    const deadline = Date.now() + (deadlineMs || 25000);
    let n = 0;
    while (Date.now() < deadline) {
      const sol = String(n);
      const dig = await sha256Bytes(nonce + ':' + sol);
      if (leadingZeroBits(dig) >= bits) return sol;
      n++;
      if (n % 2000 === 0) await sleep(0);
    }
    return null;
  }

  async function powHeaders(contentKey) {
    try {
      const res = await apiGet('/challenge/pow?' + encodeQuery({ content: contentKey }));
      if (!res || !res.ok) return {};
      const data = (res.json && res.json.data) || {};
      if (data.enabled === false) return {};
      if (!data.nonce || typeof data.bits !== 'number') return {};
      const sol = await solvePow(data.nonce, data.bits, 20000);
      if (!sol) return {};
      return { 'X-Pow-Nonce': data.nonce, 'X-Pow-Solution': sol };
    } catch (e) {
      log('pow fail: ' + (e && e.message ? e.message : e));
      return {};
    }
  }

  // ---------- AES-CBC decrypt (native link ciphertext) ----------
  function b64ToBytes(b64) {
    let s = String(b64 || '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad) s += '===='.slice(0, 4 - pad);
    if (typeof atob === 'function') {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // node Buffer fallback
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(s, 'base64'));
    }
    return null;
  }

  async function decryptLinkUrl(cipher) {
    if (!cipher || /^https?:\/\//i.test(cipher)) return cipher;
    try {
      const raw = b64ToBytes(cipher);
      if (!raw || raw.length < 17) return cipher;
      const iv = raw.slice(0, 16);
      const data = raw.slice(16);
      const keyStr = LINK_KEY.padEnd(32, ' ').substring(0, 32);

      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(keyStr),
          { name: 'AES-CBC' },
          false,
          ['decrypt'],
        );
        const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, data);
        return new TextDecoder().decode(plain);
      }
      // No subtle: leave ciphertext (Videasy fallback will handle playback)
      return cipher;
    } catch (_) {
      return cipher;
    }
  }

  // ---------- Catalogue ----------
  async function listFeaturedShows() {
    const res = await apiGet('/shows/featured');
    if (!res || !res.ok) return [];
    const data = (res.json && res.json.data) || [];
    return (Array.isArray(data) ? data : []).map((i) => cardFromKartoons(i, 'show')).filter(Boolean);
  }

  async function listFeaturedMovies() {
    const res = await apiGet('/movies/featured');
    if (!res || !res.ok) return [];
    const data = (res.json && res.json.data) || [];
    return (Array.isArray(data) ? data : []).map((i) => cardFromKartoons(i, 'movie')).filter(Boolean);
  }

  async function listRecentShows(page) {
    const res = await apiGet('/shows?' + encodeQuery({ page: String(page || 1), limit: '24' }));
    if (!res || !res.ok) return [];
    const data = (res.json && res.json.data) || [];
    return (Array.isArray(data) ? data : []).map((i) => cardFromKartoons(i, 'show')).filter(Boolean);
  }

  async function listRecentMovies(page) {
    const res = await apiGet('/movies?' + encodeQuery({ page: String(page || 1), limit: '24' }));
    if (!res || !res.ok) return [];
    const data = (res.json && res.json.data) || [];
    return (Array.isArray(data) ? data : []).map((i) => cardFromKartoons(i, 'movie')).filter(Boolean);
  }

  async function listCsCatalog(kind, catalog) {
    const path =
      kind === 'movie'
        ? '/catalog/movie?catalog=' + encodeURIComponent(catalog || 'popular')
        : '/catalog/show?catalog=' + encodeURIComponent(catalog || 'popular');
    const res = await csGet(path);
    if (!res || !res.ok) return [];
    const data = (res.json && res.json.data) || [];
    return (Array.isArray(data) ? data : [])
      .map((i) => cardFromKartoons(i, kind === 'movie' ? 'movie' : 'show'))
      .filter(Boolean);
  }

  async function listCsPopular(kind) {
    return listCsCatalog(kind, 'popular');
  }

  async function searchResults(query, page) {
    const q = cleanText(query || '');
    const pageNumber = Math.max(1, Number(page) + 1 || 1);
    try {
      if (!q) {
        const featured = await listFeaturedShows();
        if (featured.length) return featured.slice(0, 30);
        return (await listCsPopular('show')).slice(0, 30);
      }

      // Cloudstream search bypasses human challenge on /api/search
      async function csSearch(term) {
        const res = await csGet('/search?' + encodeQuery({ q: term }));
        if (!res || !res.ok) return [];
        const data = (res.json && res.json.data) || [];
        return (Array.isArray(data) ? data : [])
          .map((i) => cardFromKartoons(i, itemType(i)))
          .filter(Boolean);
      }

      const CARTOON_SEARCH_ALIASES = {
        shinchan: 'Shin Chan',
        shinchanmovie: 'Shin Chan',
        crayons: 'Crayon Shin-chan',
        ben10: 'Ben 10',
        ben10alienforce: 'Ben 10 Alien Force',
        ben10ultimatealien: 'Ben 10 Ultimate Alien',
        ben10omniverse: 'Ben 10 Omniverse',
        oggy: 'Oggy and the Cockroaches',
        hamarawalaoggy: 'Oggy',
        dbz: 'Dragon Ball Z',
        dragonball: 'Dragon Ball',
        dragonballz: 'Dragon Ball Z',
        pokemon: 'Pokemon',
        pokemonthemovie: 'Pokemon',
        tomandjerry: 'Tom and Jerry',
        'tom&jerry': 'Tom and Jerry',
        ninjahattori: 'Ninja Hattori',
        chhotabheem: 'Chhota Bheem',
        motupatlu: 'Motu Patlu',
        rollno21: 'Roll No 21',
        couragethecowardlydog: 'Courage the Cowardly Dog',
        courage: 'Courage the Cowardly Dog',
        deathnote: 'Death Note',
        narutoshippuden: 'Naruto Shippuden',
      };

      const lower = q.toLowerCase();
      const normalizedKey = lower.replace(/[^a-z0-9]/g, '');
      const aliasQuery = CARTOON_SEARCH_ALIASES[normalizedKey] || '';

      const searchTerms = [q];
      if (aliasQuery && aliasQuery.toLowerCase() !== lower) searchTerms.push(aliasQuery);

      if (lower.indexOf('doraemon') >= 0) {
        searchTerms.push(
          'nobita',
          'doraemon:',
          'stand by me',
          'dinosaur',
          'treasure island',
          'antarctic',
          'steel troops',
          'windmasters',
          'dorabian',
          'spaceblazer',
          'birth of doraemon',
          'gian',
        );
      } else if (lower.indexOf('shin') >= 0 || lower.indexOf('chan') >= 0) {
        searchTerms.push('shin chan', 'shinchan', 'crayon');
      } else if (lower.indexOf('ben') >= 0) {
        searchTerms.push('ben 10', 'ben10', 'alien force', 'omniverse');
      } else if (lower.indexOf('dragon') >= 0 || lower.indexOf('dbz') >= 0) {
        searchTerms.push('dragon ball', 'dragonball', 'dbz');
      } else if (lower.indexOf('pokemon') >= 0) {
        searchTerms.push('pokemon', 'pokémon');
      } else if (lower.indexOf('oggy') >= 0) {
        searchTerms.push('oggy', 'cockroaches', 'hamara wala oggy');
      }

      if (/[a-z][0-9]|[0-9][a-z]/i.test(q)) {
        const spaced = q.replace(/([a-zA-Z])([0-9])/g, '$1 $2').replace(/([0-9])([a-zA-Z])/g, '$1 $2');
        if (!searchTerms.includes(spaced)) searchTerms.push(spaced);
      }

      // Concurrently search all relevant terms
      const termResults = await Promise.all(searchTerms.map((term) => csSearch(term)));
      const seen = new Set();
      const cards = [];
      for (let ti = 0; ti < termResults.length; ti++) {
        const list = termResults[ti] || [];
        for (let ci = 0; ci < list.length; ci++) {
          const card = list[ci];
          if (card && card.href && !seen.has(card.href)) {
            seen.add(card.href);
            cards.push(card);
          }
        }
      }

      // API is picky with long phrases — retry with shorter tokens
      if (cards.length < 2) {
        const tokens = q
          .split(/[\s:.\-_/]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 4)
          .slice(0, 3);
        for (let ti = 0; ti < tokens.length; ti++) {
          const more = await csSearch(tokens[ti]);
          for (const c of more) {
            if (!seen.has(c.href)) {
              cards.push(c);
              seen.add(c.href);
            }
          }
          if (cards.length >= 8) break;
        }
      }

      let finalCards = cards;
      if (lower.indexOf('doraemon') >= 0) {
        finalCards = cards.filter((c) => {
          const t = (c.title || '').toLowerCase();
          return t.indexOf('doraemon') >= 0 || t.indexOf('nobita') >= 0 || t.indexOf('gian') >= 0 || t.indexOf('shizuka') >= 0;
        });
      } else if (lower.indexOf('shin') >= 0 || lower.indexOf('chan') >= 0) {
        finalCards = cards.filter((c) => {
          const t = (c.title || '').toLowerCase();
          return t.indexOf('shin') >= 0 || t.indexOf('chan') >= 0 || t.indexOf('crayon') >= 0;
        });
      }

      const aliasLower = (aliasQuery || '').toLowerCase().trim();
      const qTokens = lower.split(/[\s:.\-_/]+/).filter((t) => t.length >= 3);

      function rankCard(c) {
        const t = (c.title || '').toLowerCase().trim();
        const isShow = String(c.href || '').startsWith('show:');
        if (t === lower || (aliasLower && t === aliasLower)) return -100;
        if (isShow && (t.indexOf(lower) >= 0 || (aliasLower && t.indexOf(aliasLower) >= 0))) return -50;
        if (t.indexOf(lower) === 0 || (aliasLower && t.indexOf(aliasLower) === 0)) return -20;
        if (t.indexOf(lower) >= 0 || (aliasLower && t.indexOf(aliasLower) >= 0)) return 0;
        const hits = qTokens.filter((tok) => t.indexOf(tok) >= 0).length;
        return 20 - hits;
      }
      finalCards.sort((a, b) => rankCard(a) - rankCard(b));
      return finalCards.slice(0, 50);
    } catch (e) {
      log('search error: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  function playableTmdb(rawId, showId, title, kind) {
    if (kind !== 'movie' && showId && PLAYABLE_BY_SHOW[showId]) {
      return PLAYABLE_BY_SHOW[showId].tmdbId;
    }
    const id = cleanText(rawId || '');
    if (id && DEAD_TMDB[id]) return DEAD_TMDB[id];
    if (kind === 'movie') {
      return id;
    }
    const t = cleanText(title || '').toLowerCase();
    if (t.indexOf('doraemon') >= 0) return '65733';
    if (t.indexOf('shin chan') >= 0 || t.indexOf('shinchan') >= 0 || t.indexOf('crayon shin') >= 0) return '30623';
    if (t === 'ben 10' || t.indexOf('ben 10') === 0) return '4686';
    if (t.indexOf('oggy') >= 0) return '2437';
    if (t.indexOf('pokemon') >= 0) return '60572';
    if (t.indexOf('dragon ball z') >= 0) return '12971';
    if (t.indexOf('courage the cowardly dog') >= 0 || t === 'courage') return '2085';
    if (t.indexOf('ninja hattori') >= 0) return '158198';
    if (t.indexOf('perman') >= 0) return '37233';
    if (t.indexOf('kochikame') >= 0) return '56426';
    if (t.indexOf('kiteretsu') >= 0) return '80609';
    if (t.indexOf('chhota bheem') >= 0) return '32035';
    if (t.indexOf('motu patlu') >= 0) return '70058';
    if (t.indexOf('fullmetal') >= 0 && t.indexOf('brotherhood') >= 0) return '31911';
    if (t === 'naruto') return '46260';
    if (t === 'naruto shippuden' || t === 'naruto shippūden' || t.indexOf('shippuden') === 0) {
      return '31910';
    }
    if (id) return id;
    return '';
  }

  const showCache = Object.create(null);
  const movieCache = Object.create(null);

  async function fetchShow(id) {
    if (!id) return null;
    if (showCache[id]) return showCache[id];
    // Prefer cloudstream (richer seasons list with episode ids)
    let res = await csGet('/show/' + encodeURIComponent(id));
    if (res && res.ok && res.json && res.json.data) {
      showCache[id] = res.json.data;
      return res.json.data;
    }
    res = await apiGet('/shows/' + encodeURIComponent(id));
    if (res && res.ok && res.json && res.json.data) {
      showCache[id] = res.json.data;
      return res.json.data;
    }
    return null;
  }

  async function fetchMovie(id) {
    if (!id) return null;
    if (movieCache[id]) return movieCache[id];
    let res = await csGet('/movie/' + encodeURIComponent(id));
    if (res && res.ok && res.json && res.json.data) {
      movieCache[id] = res.json.data;
      return res.json.data;
    }
    res = await apiGet('/movies/' + encodeURIComponent(id));
    if (res && res.ok && res.json && res.json.data) {
      movieCache[id] = res.json.data;
      return res.json.data;
    }
    return null;
  }

  async function resolveTmdbCandidates(title, year, prefer) {
    const q = cleanText(title || '');
    if (!q) return [];
    const cacheKey = (prefer || 'tv') + ':' + q.toLowerCase();
    if (tmdbCache[cacheKey]) return [tmdbCache[cacheKey]];
    // Instant overrides — no network
    const forced = playableTmdb('', '', q, prefer === 'movie' ? 'movie' : 'show');
    if (forced && (q.toLowerCase().indexOf('doraemon') >= 0 || q.toLowerCase().indexOf('naruto') >= 0 || q.toLowerCase().indexOf('fullmetal') >= 0)) {
      const hit = { tmdbId: forced, type: prefer === 'movie' ? 'movie' : 'tv', title: q, year: '', popularity: 999, vote: 999 };
      tmdbCache[cacheKey] = hit;
      return [hit];
    }
    try {
      const type = prefer === 'movie' ? 'movie' : prefer === 'tv' ? 'tv' : 'multi';
      const url =
        'https://api.themoviedb.org/3/search/' +
        type +
        '?api_key=' +
        TMDB_KEY +
        '&query=' +
        encodeURIComponent(q) +
        '&include_adult=false&language=en-US&page=1';
      const res = await settleWithin(request(url), 5000, null);
      if (!res || !res.ok) return [];
      const data = res.json || safeJsonParse(res.body) || {};
      const results = Array.isArray(data.results) ? data.results : [];
      const out = [];
      const seen = new Set();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r || r.id == null) continue;
        if (type === 'multi' && r.media_type !== 'movie' && r.media_type !== 'tv') continue;
        const mediaType =
          r.media_type === 'movie' || prefer === 'movie'
            ? 'movie'
            : r.media_type === 'tv' || prefer === 'tv'
              ? 'tv'
              : r.title
                ? 'movie'
                : 'tv';
        let id = String(r.id);
        if (DEAD_TMDB[id]) id = DEAD_TMDB[id];
        if (seen.has(id)) continue;
        seen.add(id);
        const y = cleanText((r.release_date || r.first_air_date || '').slice(0, 4));
        out.push({
          tmdbId: id,
          type: mediaType,
          title: cleanText(r.title || r.name || q),
          year: y,
          popularity: Number(r.popularity) || 0,
          vote: Number(r.vote_count) || 0,
        });
      }
      // Prefer popularity over year (year often pins dead remakes)
      out.sort((a, b) => b.popularity * 10 + b.vote - (a.popularity * 10 + a.vote));
      if (out[0]) tmdbCache[cacheKey] = out[0];
      return out.slice(0, 3);
    } catch (e) {
      log('tmdb candidates fail: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  async function resolveTmdb(title, year, prefer) {
    const list = await resolveTmdbCandidates(title, year, prefer);
    return list.length ? list[0] : null;
  }

  async function extractDetails(urlOrId) {
    const ref = parseHref(urlOrId);
    if (!ref) return { title: 'Unknown', description: '' };
    try {
      if (ref.kind === 'movie') {
        const d = ref.movieId ? await fetchMovie(ref.movieId) : null;
        const title = cleanText((d && d.title) || ref.title || 'Movie');
        const year = (d && (d.releaseYear || d.year)) || ref.year || '';
        let tmdbId = playableTmdb((d && d.tmdbId) || ref.tmdbId || '', ref.movieId, title, 'movie');
        if (!tmdbId && title) {
          const t = await resolveTmdb(title, year, 'movie');
          if (t) tmdbId = t.tmdbId;
        }
        return {
          title: title,
          description: cleanText((d && d.description) || ''),
          image: cleanText((d && (d.image || d.coverImage)) || ''),
          href: buildMovieHref(ref.movieId || tmdbId, { tmdbId: tmdbId, title: title, year: year }),
          year: year ? String(year) : '',
        };
      }

      // show or episode → show details
      const showId = ref.showId || (ref.kind === 'show' ? ref.showId : '');
      const d = showId ? await fetchShow(showId) : null;
      const title = cleanText((d && d.title) || ref.title || 'Show');
      const year = (d && (d.startYear || d.year)) || ref.year || '';
      let tmdbId = playableTmdb((d && d.tmdbId) || ref.tmdbId || '', showId, title, 'show');
      if (!tmdbId && title) {
        const t = await resolveTmdb(title, year, 'tv');
        if (t) tmdbId = t.tmdbId;
      }
      return {
        title: title,
        description: cleanText((d && d.description) || ''),
        image: cleanText((d && (d.image || d.coverImage)) || ''),
        href: buildShowHref(showId || '', { tmdbId: tmdbId, title: title, year: year }),
        year: year ? String(year) : '',
      };
    } catch (e) {
      log('details error: ' + (e && e.message ? e.message : String(e)));
      return { title: 'Unknown', description: '' };
    }
  }

  async function loadSeasonEpisodes(showId, seasonId) {
    const res = await apiGet(
      '/shows/' + encodeURIComponent(showId) + '/season/' + encodeURIComponent(seasonId) + '/all-episodes',
    );
    if (!res || !res.ok) return [];
    const data = res.json && res.json.data;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.episodes)) return data.episodes;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  }

  async function extractEpisodes(seriesId) {
    const ref = parseHref(seriesId);
    if (!ref) return [];

    if (ref.kind === 'movie') {
      let tmdbId = ref.tmdbId || '';
      let title = ref.title || '';
      let year = ref.year || '';
      if (ref.movieId) {
        const d = await fetchMovie(ref.movieId);
        if (d) {
          title = cleanText(d.title || title);
          year = d.releaseYear || d.year || year;
          tmdbId = d.tmdbId || tmdbId;
        }
      }
      if (!tmdbId && title) {
        const t = await resolveTmdb(title, year, 'movie');
        if (t) tmdbId = t.tmdbId;
      }
      return [
        {
          number: 1,
          href: buildMovieHref(ref.movieId || tmdbId || 'x', {
            tmdbId: tmdbId,
            title: title,
            year: year,
          }),
          title: 'Movie',
          subAvailable: true,
          dubAvailable: true,
        },
      ];
    }

    const showId = ref.showId;
    if (!showId) return [];
    try {
      const d = await fetchShow(showId);
      if (!d) return [];
      const title = cleanText(d.title || ref.title || '');
      const year = d.startYear || d.year || ref.year || '';
      // Prefer free-player-working TMDB (never pin dead 1979 Doraemon etc.)
      let tmdbId = playableTmdb(d.tmdbId || ref.tmdbId || '', showId, title, 'show');
      if (!tmdbId && title) {
        const t = await resolveTmdb(title, year, 'tv');
        if (t) tmdbId = playableTmdb(t.tmdbId, showId, title, 'show');
      }
      const showMeta = { showId: showId, tmdbId: tmdbId, title: title, year: year };
      const seasons = Array.isArray(d.seasons) ? d.seasons : [];
      const out = [];

      // CRITICAL SPEED: cloudstream already embeds episode id arrays.
      // NEVER call all-episodes per season (Doraemon = 20+ sequential API calls = 15–40s).
      for (let si = 0; si < seasons.length; si++) {
        const season = seasons[si];
        if (!season) continue;
        const sn = numOr(season.seasonNumber != null ? season.seasonNumber : null, si + 1);
        const seasonId = itemId(season);
        let eps = [];
        if (Array.isArray(season.episodes) && season.episodes.length) {
          if (typeof season.episodes[0] === 'object') {
            eps = season.episodes;
          } else {
            // id strings — build list locally (instant)
            eps = season.episodes.map((eid, idx) => ({
              _id: eid,
              episodeNumber: idx + 1,
              seasonNumber: sn,
              title: 'Episode ' + (idx + 1),
            }));
          }
        } else if (seasonId) {
          // Only hit all-episodes when season has no embedded list
          eps = await loadSeasonEpisodes(showId, seasonId);
        }

        for (let ei = 0; ei < eps.length; ei++) {
          const ep = eps[ei] || {};
          const en = numOr(
            ep.episodeNumber != null ? ep.episodeNumber : ep.number,
            ei + 1,
          );
          const epObj = Object.assign({}, ep, { seasonNumber: sn, episodeNumber: en });
          // Minimal fields — large series (Doraemon) used to ship 120KB+ JSON
          // across flutter_js and stall the series/watch screens for 10–20s.
          out.push({
            number: out.length + 1,
            seasonNumber: sn,
            episodeNumber: en,
            href: buildEpHref(epObj, showMeta),
            title: sn > 0 ? 'S' + sn + 'E' + en : 'SP' + en,
            subAvailable: true,
            dubAvailable: true,
          });
          const episodeId = itemId(epObj);
          if (episodeId) episodeOrdinalCache[showId + '|' + episodeId] = out.length;
          if (out.length >= 200) break;
        }
        if (out.length >= 200) break;
      }

      if (!out.length) {
        out.push({
          number: 1,
          seasonNumber: 1,
          episodeNumber: 1,
          href: buildEpHref(
            { _id: showId, episodeNumber: 1, seasonNumber: 1, title: 'Episode 1' },
            showMeta,
          ),
          title: 'S1E1',
          subAvailable: true,
          dubAvailable: true,
        });
      }
      return out;
    } catch (e) {
      log('episodes error: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  // ---------- Streams ----------
  function qualityHeight(q) {
    const s = String(q || '');
    const m = s.match(/(\d{3,4})/);
    return m ? Number(m[1]) : 0;
  }

  function streamSeekScore(s) {
    const h = qualityHeight(s && s.quality);
    let score = 0;
    if (h === 1080) score += 10000;
    else if (h === 720) score += 8000;
    else if (h > 0 && h < 720) score += 4000 + h;
    else if (h >= 2160) score += 2500;
    else if (h > 1080) score += 3000;
    else score += 1000;
    if (s && (s.kind === 'hls' || s.streamType === 'hls' || /\.m3u8/i.test(s.url || ''))) score += 200;
    if (s && /videasy-cdn/i.test(s.provider || '')) score += 150;
    if (s && /kartoons/i.test(s.provider || '')) score += 500; // prefer native when present
    return score;
  }

  function normalizeLinkList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.links)) return payload.links;
    if (payload.data) return normalizeLinkList(payload.data);
    if (typeof payload === 'object' && payload.url) return [payload];
    // object map of quality -> url
    if (typeof payload === 'object') {
      const out = [];
      Object.keys(payload).forEach((k) => {
        const v = payload[k];
        if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
          out.push({ url: v, quality: k, name: k });
        } else if (v && typeof v === 'object' && v.url) {
          out.push(Object.assign({ quality: k }, v));
        }
      });
      return out;
    }
    return [];
  }

  function streamPlayHeaders() {
    // ironwall / rivermagnet playlists 403 without Videasy Referer+Origin.
    return {
      'User-Agent': USER_AGENT,
      Referer: VIDEASY_ORIGIN + '/',
      Origin: VIDEASY_ORIGIN,
    };
  }

  function lookmovieHeaders() {
    return {
      'User-Agent': USER_AGENT,
      Referer: LOOKMOVIE + '/',
      Origin: LOOKMOVIE,
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
    };
  }

  function absoluteMediaUrl(baseUrl, rawUrl) {
    const value = cleanText(rawUrl || '');
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    const base = String(baseUrl || '');
    const originMatch = base.match(/^(https?:\/\/[^/]+)/i);
    if (value.charAt(0) === '/' && originMatch) return originMatch[1] + value;
    const root = base.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    const parts = (root + value.replace(/^\.\//, '')).split('/');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '..') out.pop();
      else if (parts[i] !== '.') out.push(parts[i]);
    }
    return out.join('/');
  }

  function playlistMediaLines(body) {
    return String(body || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.charAt(0) !== '#');
  }

  async function probeMediaObject(url, headers) {
    const head = await settleWithin(
      request(url, {
        method: 'HEAD',
        headers: Object.assign({}, headers || {}, { Accept: 'video/*,*/*' }),
      }),
      5000,
      null,
    );
    if (head && (head.status === 200 || head.status === 206)) return true;
    const range = await settleWithin(
      request(url, {
        headers: Object.assign({}, headers || {}, {
          Accept: 'video/*,*/*',
          Range: 'bytes=0-1',
        }),
      }),
      5000,
      null,
    );
    return !!(range && (range.status === 200 || range.status === 206));
  }

  async function validateSeekableHls(stream) {
    if (!stream || !stream.url || !/\.m3u8(?:$|[?#])/i.test(stream.url)) return null;
    const headers = stream.headers || lookmovieHeaders();
    const playlist = await settleWithin(
      request(stream.url, {
        headers: Object.assign({}, headers, {
          Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
        }),
      }),
      6000,
      null,
    );
    if (!playlist || !playlist.ok || !/^\s*#EXTM3U/m.test(playlist.body || '')) return null;

    let mediaUrl = stream.url;
    let mediaBody = String(playlist.body || '');
    let lines = playlistMediaLines(mediaBody);

    // A master playlist contains child playlists rather than media objects.
    if (/#EXT-X-STREAM-INF/i.test(mediaBody)) {
      const child = lines.find((line) => /\.m3u8(?:$|[?#])/i.test(line));
      if (!child) return null;
      mediaUrl = absoluteMediaUrl(stream.url, child);
      const media = await settleWithin(
        request(mediaUrl, {
          headers: Object.assign({}, headers, {
            Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
          }),
        }),
        6000,
        null,
      );
      if (!media || !media.ok || !/^\s*#EXTM3U/m.test(media.body || '')) return null;
      mediaBody = String(media.body || '');
      lines = playlistMediaLines(mediaBody);
    }

    const segments = lines.filter((line) => !/\.m3u8(?:$|[?#])/i.test(line));
    if (segments.length < 4 || !/#EXTINF:/i.test(mediaBody)) return null;
    if (segments.some((line) => /\.(?:jpe?g|png|webp|gif|css)(?:$|[?#])/i.test(line))) return null;

    const firstUrl = absoluteMediaUrl(mediaUrl, segments[0]);
    const middleUrl = absoluteMediaUrl(mediaUrl, segments[Math.floor(segments.length / 2)]);
    const checks = await Promise.all([
      probeMediaObject(firstUrl, headers),
      probeMediaObject(middleUrl, headers),
    ]);
    if (!checks[0] || !checks[1]) return null;
    return Object.assign({}, stream, {
      provider: 'kartoons-lookmovie-validated',
      seekValidated: true,
    });
  }

  async function validateLookmovieStreams(streams) {
    const candidates = Array.isArray(streams) ? streams.slice(0, 4) : [];
    const out = [];
    for (let i = 0; i < candidates.length; i++) {
      const validated = await validateSeekableHls(candidates[i]);
      if (validated) out.push(validated);
    }
    return out;
  }

  async function lmRequest(url, opts) {
    const o = opts || {};
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: o.accept || 'application/json,text/html,*/*',
        Referer: LOOKMOVIE + '/',
        Origin: LOOKMOVIE,
      },
      o.headers || {},
    );
    if (o.xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
    return settleWithin(
      request(url, { headers: headers, method: o.method || 'GET', body: o.body || null }),
      o.timeout || 10000,
      null,
    );
  }

  /**
   * LookMovie HLS uses real .ts segments (seekable).
   * Videasy cartoon streams use .jpg/.css/.png disguise segments — seeks freeze on iOS.
   */
  async function resolveLookmovie(title, year, mediaType, season, episode, absoluteEpisode) {
    const q = cleanText(title || '');
    if (!q) return [];
    const kind = mediaType === 'movie' ? 'movie' : 'show';
    const cacheKey = kind + ':' + q.toLowerCase() + ':' + (year || '');
    let hit = lmHitCache[cacheKey] || null;

    try {
      if (!hit) {
        const path =
          kind === 'movie'
            ? '/api/v1/movies/do-search/?q='
            : '/api/v1/shows/do-search/?q=';
        let res = await lmRequest(LOOKMOVIE + path + encodeURIComponent(q), {
          xhr: true,
          timeout: 8000,
        });
        let rows = [];
        try {
          rows = (JSON.parse((res && res.body) || '{}') || {}).result || [];
        } catch (_) {
          rows = [];
        }

        if (!rows.length) {
          const cleanedTitle = String(q)
            .replace(/\s*\([^)]*\)/g, '')
            .replace(/^hamara wala\s+/i, '')
            .replace(/\s*-\s*dabang.*$/i, '')
            .replace(/:\s*ek bhayankar yudh/i, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (cleanedTitle && cleanedTitle !== q) {
            res = await lmRequest(LOOKMOVIE + path + encodeURIComponent(cleanedTitle), {
              xhr: true,
              timeout: 8000,
            });
            try {
              rows = (JSON.parse((res && res.body) || '{}') || {}).result || [];
            } catch (_) {
              rows = [];
            }
          }
        }
        if (!rows.length) return [];
        let best = null;
        let bestScore = -1;
        const ql = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const qNorm = ql.replace(/[^a-z0-9]/g, '');
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (!r) continue;
          const t = cleanText(r.title).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          const tNorm = t.replace(/[^a-z0-9]/g, '');
          let sc = 0;
          if (t === ql || (qNorm && tNorm === qNorm)) sc += 1000;
          else if (t.indexOf(ql) === 0 || (qNorm && tNorm.indexOf(qNorm) === 0)) sc += 500;
          else if (t.indexOf(ql) >= 0 || (qNorm && tNorm.indexOf(qNorm) >= 0)) sc += 200;
          if (year && Number(r.year) === Number(year)) sc += 350;
          // Prefer 2005 Doraemon over older entries when present
          if (ql.indexOf('doraemon') >= 0 && Number(r.year) === 2005) sc += 400;
          if (sc > bestScore) {
            bestScore = sc;
            best = r;
          }
        }
        if (!best || bestScore < 150) return [];
        hit = best;
        lmHitCache[cacheKey] = hit;
      }

      if (kind === 'movie') {
        const view = await lmRequest(LOOKMOVIE + '/movies/view/' + encodeURIComponent(hit.slug), {
          accept: 'text/html,*/*',
          timeout: 9000,
        });
        if (!view || !view.body) return [];
        const playM = String(view.body).match(/href="(\/movies\/play\/[^"]+)"/i);
        if (!playM) return [];
        const play = await lmRequest(LOOKMOVIE + playM[1], {
          accept: 'text/html,*/*',
          timeout: 9000,
        });
        if (!play || !play.body) return [];
        const idMovie = (String(play.body).match(/id_movie:\s*(\d+)/) || [])[1];
        const hash = (String(play.body).match(/hash:\s*['"]([^'"]+)['"]/) || [])[1];
        const expires = (String(play.body).match(/expires:\s*(\d+)/) || [])[1];
        if (!idMovie || !hash || !expires) return [];
        const acc = await lmRequest(
          LOOKMOVIE +
            '/api/v1/security/movie-access?id_movie=' +
            idMovie +
            '&hash=' +
            encodeURIComponent(hash) +
            '&expires=' +
            encodeURIComponent(expires),
          { xhr: true, timeout: 9000 },
        );
        if (!acc || !acc.ok || !acc.body) return [];
        return lookmovieStreamsFromAccess(JSON.parse(acc.body));
      }

      // TV / show
      const sn = Math.max(1, numOr(season, 1) || 1);
      const en = Math.max(1, numOr(episode, 1) || 1);
      const idShow = hit.id_show || hit.id;
      if (!idShow) return [];
      const metaKey = String(idShow);
      let showMeta = lmShowMetaCache[metaKey];
      if (!showMeta || Date.now() - showMeta.savedAt > 30 * 60 * 1000) {
        const pair = await Promise.all([
          lmRequest(
            LOOKMOVIE + '/api/v2/download/episode/list?id=' + encodeURIComponent(String(idShow)),
            { xhr: true, timeout: 9000 },
          ),
          lmRequest(LOOKMOVIE + '/shows/view/' + encodeURIComponent(hit.slug), {
            accept: 'text/html,*/*',
            timeout: 9000,
          }),
        ]);
        const listRes = pair[0];
        const view = pair[1];
        if (!listRes || !listRes.ok || !listRes.body || !view || !view.body) return [];
        let list = {};
        try {
          list = (JSON.parse(listRes.body) || {}).list || {};
        } catch (_) {
          list = {};
        }
        const playM = String(view.body).match(/href="(\/shows\/play\/[^"]+)"/i);
        if (!playM) return [];
        showMeta = { list: list, playPath: playM[1], savedAt: Date.now() };
        lmShowMetaCache[metaKey] = showMeta;
      }
      const list = showMeta.list || {};
      const seasonMap = list[String(sn)] || list[sn];
      let cell = seasonMap && typeof seasonMap === 'object'
        ? seasonMap[String(en)] || seasonMap[en]
        : null;
      // Kartoons splits Doraemon into specials/seasons while the stable media
      // catalogue stores those same episodes as one flat ordered season.
      if (!cell && q.toLowerCase() === 'doraemon' && absoluteEpisode > 0) {
        const flat = list['1'] || list[1];
        if (flat && typeof flat === 'object') {
          cell = flat[String(absoluteEpisode)] || flat[absoluteEpisode];
        }
      }
      const eid = cell && cell.id_episode;
      if (!eid) {
        log('lookmovie missing s' + sn + 'e' + en);
        return [];
      }

      // Hash is episode-specific when id_episode is on the play URL
      const play = await lmRequest(
        LOOKMOVIE + showMeta.playPath + '?id_episode=' + encodeURIComponent(String(eid)),
        { accept: 'text/html,*/*', timeout: 9000 },
      );
      if (!play || !play.body) return [];
      const hash = (String(play.body).match(/hash:\s*['"]([^'"]+)['"]/) || [])[1];
      const expires = (String(play.body).match(/expires:\s*(\d+)/) || [])[1];
      if (!hash || !expires) return [];

      const acc = await lmRequest(
        LOOKMOVIE +
          '/api/v1/security/episode-access?id_episode=' +
          encodeURIComponent(String(eid)) +
          '&hash=' +
          encodeURIComponent(hash) +
          '&expires=' +
          encodeURIComponent(expires),
        { xhr: true, timeout: 9000 },
      );
      if (!acc || !acc.ok || !acc.body) return [];
      let json = null;
      try {
        json = JSON.parse(acc.body);
      } catch (_) {
        return [];
      }
      if (!json || !json.success) return [];
      return lookmovieStreamsFromAccess(json);
    } catch (e) {
      log('lookmovie err: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  function lookmovieStreamsFromAccess(json) {
    const streamsMap = (json && json.streams) || {};
    const out = [];
    const keys = Object.keys(streamsMap).sort(function (a, b) {
      return (qualityHeight(b) || 0) - (qualityHeight(a) || 0);
    });
    const hdr = lookmovieHeaders();
    for (let i = 0; i < keys.length; i++) {
      const raw = streamsMap[keys[i]];
      // Free accounts lock higher qualities as null
      if (!raw || typeof raw !== 'string' || raw.indexOf('http') !== 0) continue;
      const h = qualityHeight(keys[i]) || qualityHeight(raw) || 480;
      // Prefer 720 when free; otherwise best unlocked (often 480)
      out.push({
        label: 'Kartoons · LM ' + (h || keys[i]) + 'p',
        url: raw,
        quality: h,
        streamType: 'hls',
        kind: 'hls',
        provider: 'kartoons-lookmovie',
        headers: hdr,
      });
    }
    // Seek-friendly ranking: 720 > 480 > 1080 free-null already skipped
    out.sort(function (a, b) {
      const ha = qualityHeight(a.quality);
      const hb = qualityHeight(b.quality);
      // Prefer 720 for scrubbing, then 480, then higher
      function rank(h) {
        if (h === 720) return 10000;
        if (h === 480 || h === 540) return 8000;
        if (h === 1080) return 6000;
        return h || 0;
      }
      return rank(hb) - rank(ha);
    });
    return out.slice(0, 2);
  }

  async function resolveVideasyOnce(tmdbId, mediaType, seasonId, episodeId, titleHint, serverName) {
    const headers = streamPlayHeaders();
    const seedRes = await settleWithin(
      request('https://api.speedracelight.com/seed?mediaId=' + encodeURIComponent(tmdbId), {
        headers: headers,
      }),
      8000,
      null,
    );
    if (!seedRes || !seedRes.ok || /error code:\s*1015/i.test(seedRes.body || '')) {
      log('videasy seed fail tmdb=' + tmdbId + ' st=' + (seedRes && seedRes.status));
      return [];
    }
    const seed = (seedRes.json || safeJsonParse(seedRes.body) || {}).seed;
    if (!seed) return [];

    const mt = mediaType === 'movie' ? 'movie' : 'tv';
    const sn = Math.max(1, numOr(seasonId, 1) || 1);
    const en = Math.max(1, numOr(episodeId, 1) || 1);
    const server = serverName || 'cdn';
    const fullUrl =
      'https://api.speedracelight.com/' +
      server +
      '/sources-with-title?title=' +
      encodeURIComponent(cleanText(titleHint || '')) +
      '&mediaType=' +
      mt +
      '&year=&episodeId=' +
      en +
      '&seasonId=' +
      sn +
      '&tmdbId=' +
      tmdbId +
      '&imdbId=&enc=2&seed=' +
      encodeURIComponent(seed);
    const encRes = await settleWithin(request(fullUrl, { headers: headers }), 10000, null);
    if (!encRes || !encRes.ok || !encRes.body) {
      log('videasy enc fail ' + server + ' s' + sn + 'e' + en + ' st=' + (encRes && encRes.status));
      return [];
    }
    if (/Attention Required|Just a moment|error code:\s*1015|No streams available/i.test(encRes.body)) {
      return [];
    }

    const decRes = await settleWithin(
      request('https://enc-dec.app/api/dec-videasy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          text: String(encRes.body).trim(),
          id: String(tmdbId),
          seed: seed,
        }),
      }),
      10000,
      null,
    );
    if (!decRes || !decRes.ok) {
      log('videasy dec fail st=' + (decRes && decRes.status));
      return [];
    }
    const dec = decRes.json || safeJsonParse(decRes.body) || {};
    if (dec.status !== 200 || !dec.result) return [];
    const sources = Array.isArray(dec.result.sources) ? dec.result.sources : [];
    const streams = [];
    const seen = new Set();
    const playHeaders = streamPlayHeaders();
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      if (!src || !src.url || seen.has(src.url)) continue;
      if (String(src.quality || '').includes('HDR')) continue;
      seen.add(src.url);
      const h = qualityHeight(src.quality);
      const isHls = /\.m3u8/i.test(src.url) || /mpegurl/i.test(String(src.type || ''));
      streams.push({
        label: 'Kartoons · ' + (src.quality || 'auto'),
        url: src.url,
        quality: h || src.quality || 'auto',
        streamType: isHls ? 'hls' : 'mp4',
        kind: isHls ? 'hls' : 'mp4',
        provider: 'kartoons-videasy-' + server,
        headers: playHeaders,
      });
    }
    streams.sort((a, b) => streamSeekScore(b) - streamSeekScore(a));
    return streams.slice(0, 2);
  }

  async function resolveVideasy(tmdbId, mediaType, seasonId, episodeId, titleHint) {
    if (!tmdbId) return [];
    tmdbId = playableTmdb(tmdbId, '', titleHint, mediaType === 'movie' ? 'movie' : 'show') || tmdbId;
    if (String(tmdbId) === '57911') tmdbId = '65733';

    // Free players have no true S0 specials — map to S1 same ep number.
    const sn = Math.max(1, numOr(seasonId, 1) || 1);
    const en = Math.max(1, numOr(episodeId, 1) || 1);

    // Prefer CDN; fall back to m4uhd if needed.
    let streams = await resolveVideasyOnce(tmdbId, mediaType, sn, en, titleHint, 'cdn');
    if (!streams.length) {
      streams = await resolveVideasyOnce(tmdbId, mediaType, sn, en, titleHint, 'm4uhd');
    }
    // Episode miss: try S1E1 as last-chance (better than hard fail for specials).
    if (!streams.length && !(sn === 1 && en === 1)) {
      log('videasy fallback s1e1 after miss s' + sn + 'e' + en);
      streams = await resolveVideasyOnce(tmdbId, mediaType, 1, 1, titleHint, 'cdn');
    }
    return streams;
  }

  async function extractStreamUrl(episodeHref, lang) {
    const t0 = Date.now();
    const ref = parseHref(episodeHref);
    if (!ref) {
      log('extractStreamUrl: bad href');
      return { streams: [] };
    }

    const requestedLang = String(lang || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub';
    const cacheKey = String(episodeHref || '') + '|' + requestedLang;
    const cached = streamCache[cacheKey];
    if (cached && Date.now() - cached.savedAt < STREAM_CACHE_TTL_MS) {
      log('extractStreamUrl: cache hit');
      return cached.result;
    }

    const mediaType = ref.kind === 'movie' ? 'movie' : 'tv';
    let season = Math.max(1, numOr(ref.season, 1) || 1);
    let episode = Math.max(1, numOr(ref.episode, 1) || 1);
    if (mediaType === 'movie') {
      season = 1;
      episode = 1;
    }

    let title = cleanText(ref.seriesTitle || (ref.kind === 'movie' ? ref.title : '') || '');
    const kindHint = mediaType === 'movie' ? 'movie' : 'show';
    let tmdbId = playableTmdb(ref.tmdbId || '', ref.showId || '', title, kindHint);
    let yearHint = ref.year || '';

    // Always recover a series/movie title for LookMovie (compact episode hrefs omit it).
    if (ref.kind === 'movie' && ref.movieId && (!title || !tmdbId)) {
      const d = await fetchMovie(ref.movieId);
      if (d) {
        title = cleanText(d.title || title);
        tmdbId = playableTmdb(d.tmdbId || ref.tmdbId, '', title, 'movie') || tmdbId;
        if (!yearHint && (d.releaseYear || d.year)) yearHint = String(d.releaseYear || d.year);
      }
    } else if (kindHint !== 'movie' && ref.showId && !title) {
      if (PLAYABLE_BY_SHOW[ref.showId]) {
        title = PLAYABLE_BY_SHOW[ref.showId].title;
        if (!tmdbId) tmdbId = PLAYABLE_BY_SHOW[ref.showId].tmdbId;
      } else {
        const d = await fetchShow(ref.showId);
        if (d) {
          title = cleanText(d.title || '');
          tmdbId = playableTmdb(d.tmdbId || ref.tmdbId, ref.showId, title, 'show') || tmdbId;
          if (!yearHint && (d.startYear || d.year)) yearHint = String(d.startYear || d.year);
        }
      }
    }

    if (!tmdbId || DEAD_TMDB[String(ref.tmdbId || '')]) {
      if (!tmdbId && title) {
        const t = await resolveTmdb(title, yearHint, mediaType === 'movie' ? 'movie' : 'tv');
        if (t) tmdbId = playableTmdb(t.tmdbId, ref.showId, title, kindHint);
      }
    }
    if (kindHint !== 'movie' && !tmdbId && ref.showId && PLAYABLE_BY_SHOW[ref.showId]) {
      tmdbId = PLAYABLE_BY_SHOW[ref.showId].tmdbId;
    }
    // Use recovered year for LookMovie matching below
    ref.year = yearHint || ref.year;

    // Year hint for LookMovie matching (Doraemon → 2005)
    let year = ref.year || '';
    if (!year && title && title.toLowerCase().indexOf('doraemon') >= 0) year = '2005';
    if (!year && ref.showId && PLAYABLE_BY_SHOW[ref.showId] && title === PLAYABLE_BY_SHOW[ref.showId].title) {
      if (title.toLowerCase().indexOf('doraemon') >= 0) year = '2005';
    }

    log(
      'extractStreamUrl tmdb=' +
        tmdbId +
        ' s' +
        season +
        'e' +
        episode +
        ' title=' +
        title +
        ' hrefTmdb=' +
        (ref.tmdbId || ''),
    );

    const absoluteEpisode = ref.showId && ref.episodeId
      ? Number(episodeOrdinalCache[ref.showId + '|' + ref.episodeId]) || 0
      : 0;

    let streams = [];
    if (title) {
      const rawLookmovie = await settleWithin(
        resolveLookmovie(title, year, mediaType, season, episode, absoluteEpisode),
        10000,
        [],
      );
      if (rawLookmovie && rawLookmovie.length) {
        streams = await validateLookmovieStreams(rawLookmovie);
        if (streams.length) log('extractStreamUrl: using seek-validated LookMovie');
      }
    }

    if (!streams.length && tmdbId) {
      log('extractStreamUrl: trying Videasy fallback for ' + title);
      const vdStreams = await settleWithin(
        resolveVideasy(tmdbId, mediaType, season, episode, title),
        10000,
        [],
      );
      if (vdStreams && vdStreams.length) {
        streams = vdStreams;
        log('extractStreamUrl: using Videasy fallback');
      }
    }

    const ms = Date.now() - t0;
    if (!streams.length) {
      log('extractStreamUrl: no streams in ' + ms + 'ms');
      return { streams: [] };
    }
    const top = streams[0];
    log('extractStreamUrl: ok in ' + ms + 'ms ' + top.label + ' via ' + (top.provider || '?'));

    const qualityCandidates = streams.map((s) => {
      const h = qualityHeight(s.quality) || qualityHeight(s.label) || 480;
      return {
        label: h >= 720 ? h + 'p · Kartoons HD' : h + 'p · Kartoons SD',
        url: s.url,
        headers: s.headers || lookmovieHeaders(),
        height: h,
      };
    });

    const result = {
      streams: streams,
      qualities: qualityCandidates,
      url: top.url,
      stream: top.url,
      subtitles: [],
      headers: top.headers || lookmovieHeaders(),
      streamType: top.streamType || 'hls',
      quality: top.quality || 1080,
      lang: requestedLang,
    };
    streamCache[cacheKey] = { savedAt: Date.now(), result: result };
    return result;
  }

  // ---------- Discovery ----------
  function sectionFrom(id, title, items, feedId, style, limit) {
    if (!items || !items.length) return null;
    const max = Math.max(1, Number(limit) || 24);
    return {
      id: id,
      title: title,
      style: style || 'poster',
      items: items.slice(0, max).map((c, i) => ({
        href: c.href,
        title: c.title,
        image: c.image || c.poster || '',
        poster: c.poster || c.image || '',
        rank: i + 1,
      })),
      viewAll: feedId ? { mode: 'feed', feedId: feedId } : undefined,
    };
  }

  async function discoveryHome() {
    try {
      const [popShows, popMovies, latShows, latMovies, trendShows, trendMovies] =
        await Promise.all([
          listCsCatalog('show', 'popular'),
          listCsCatalog('movie', 'popular'),
          listCsCatalog('show', 'latest'),
          listCsCatalog('movie', 'latest'),
          listCsCatalog('show', 'trending'),
          listCsCatalog('movie', 'trending'),
        ]);

      const sections = [];
      const heroItems = popShows.slice(0, 4).concat(popMovies.slice(0, 4));
      const hero = sectionFrom('hero', 'Featured Cartoons & Movies', heroItems, 'popular-shows', 'hero', 8);
      if (hero) sections.push(hero);

      const ps = sectionFrom('popular-shows', 'Popular Cartoons & Anime', popShows, 'popular-shows', 'top10', 10);
      if (ps) sections.push(ps);

      const pm = sectionFrom(
        'popular-movies',
        'Childhood Movies & Specials',
        popMovies,
        'popular-movies',
        'poster',
        20,
      );
      if (pm) sections.push(pm);

      const ls = sectionFrom('latest-shows', 'Latest Released Shows', latShows, 'latest-shows', 'poster', 20);
      if (ls) sections.push(ls);

      const lm = sectionFrom(
        'latest-movies',
        'Latest Released Movies',
        latMovies,
        'latest-movies',
        'poster',
        20,
      );
      if (lm) sections.push(lm);

      const ts = sectionFrom('trending-shows', 'Trending Cartoons', trendShows, 'trending-shows', 'poster', 20);
      if (ts) sections.push(ts);

      const tm = sectionFrom(
        'trending-movies',
        'Trending Movies',
        trendMovies,
        'trending-movies',
        'poster',
        20,
      );
      if (tm) sections.push(tm);

      return { sections: sections.slice(0, 12) };
    } catch (e) {
      log('discoveryHome error: ' + (e && e.message ? e.message : e));
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedId, page) {
    const id = cleanText(feedId || '');
    const p = Math.max(1, Number(page) || 1);
    let items = [];
    try {
      if (id === 'hero' || id === 'featured' || id === 'popular-shows') {
        items = await listCsCatalog('show', 'popular');
      } else if (id === 'popular-movies') {
        items = await listCsCatalog('movie', 'popular');
      } else if (id === 'latest-shows') {
        items = await listCsCatalog('show', 'latest');
      } else if (id === 'latest-movies') {
        items = await listCsCatalog('movie', 'latest');
      } else if (id === 'trending-shows') {
        items = await listCsCatalog('show', 'trending');
      } else if (id === 'trending-movies') {
        items = await listCsCatalog('movie', 'trending');
      } else {
        items = await listCsCatalog('show', 'popular');
      }
    } catch (e) {
      log('discoveryFeed error: ' + (e && e.message ? e.message : e));
    }
    return {
      items: (items || []).slice(0, 50).map((c) => ({
        href: c.href,
        title: c.title,
        image: c.image || c.poster || '',
        poster: c.poster || c.image || '',
      })),
      page: p,
      hasMore: false,
    };
  }

  // exports
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      searchResults,
      extractDetails,
      extractEpisodes,
      extractStreamUrl,
      discoveryHome,
      discoveryFeed,
    };
  }
})();
