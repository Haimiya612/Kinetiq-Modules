(() => {
  'use strict';

  const MODULE_NAME = 'Anikage';
  const BASE_URL = 'https://anikage.cc';
  const PROXY_CDN = 'https://og.bakayaro.live';
  const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  function log(message) {
    try {
      if (typeof debugPrint === 'function') debugPrint('[' + MODULE_NAME + '] ' + String(message || ''));
      else if (typeof console !== 'undefined' && console.log) console.log('[' + MODULE_NAME + '] ' + String(message || ''));
    } catch (_) {}
  }

  function decodeHtml(text) {
    return String(text || '')
      .replace(/&#0?39;|&#x27;|&apos;/g, "'")
      .replace(/&#8217;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  // ---------- HTTP bridge with host-scoped rate-limit cooldown ----------
  const cooldowns = {};

  function rateLimitError(until) {
    const error = new Error(MODULE_NAME + ': source rate limited; retry in ' +
      Math.max(1, Math.ceil((until - Date.now()) / 1000)) + ' seconds');
    error.rateLimited = true;
    return error;
  }

  function retryAfterMs(res) {
    const headers = res && res.headers;
    let raw = '';
    if (headers && typeof headers.get === 'function') raw = headers.get('retry-after');
    else if (headers) {
      const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
      if (key) raw = headers[key];
    }
    raw = String(raw || '').trim();
    if (/^\d+$/.test(raw) && isFinite(Number(raw))) return Math.max(1000, Number(raw) * 1000);
    const date = raw ? Date.parse(raw) : NaN;
    return isFinite(date) && date > Date.now() ? date - Date.now() : 60000;
  }

  async function fetchText(url, extraHeaders) {
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Referer': BASE_URL + '/',
      'Origin': BASE_URL,
    }, extraHeaders || {});
    let res = null;
    try {
      if (typeof fetchv2 === 'function') res = await fetchv2(url, headers, 'GET', null);
      else if (typeof fetch === 'function') res = await fetch(url, { headers });
    } catch (_) { return ''; }
    if (!res) return '';
    if (typeof res.text === 'function') {
      try { const t = await res.text(); if (typeof t === 'string') return t; } catch (_) {}
    }
    if (typeof res.body === 'string') return res.body;
    return '';
  }

  async function qualityFromMaster(url, headers, active) {
    if (active && !active()) return '';
    const text = await settleWithin(fetchText(url, headers), 2500, '');
    if (!text || String(text).indexOf('#EXTM3U') < 0) return '';
    const m = String(text).match(/RESOLUTION=\d+x(\d+)/i);
    if (m) {
      const h = Number(m[1]);
      return h >= 360 ? h + 'p' : '';
    }
    return '';
  }

  async function requestJson(url, extraHeaders) {
    const host = (String(url).match(/^https?:\/\/([^/]+)/i) || [])[1] || '';
    if (cooldowns[host] > Date.now()) throw rateLimitError(cooldowns[host]);
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': BASE_URL + '/',
      'Origin': BASE_URL,
    }, extraHeaders || {});

    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, headers, 'GET', null);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { headers });
    }

    const status = Number((res && res.status) || 0);

    if (status === 429) {
      cooldowns[host] = Date.now() + retryAfterMs(res);
      throw rateLimitError(cooldowns[host]);
    }

    if (status < 200 || status >= 400) {
      throw new Error(MODULE_NAME + ': request failed (HTTP ' + status + ') for ' + url);
    }

    if (res && typeof res.json === 'function') {
      try {
        const j = await res.json();
        if (j !== null && j !== undefined) return j;
      } catch (_) {}
    }
    if (res && res.json && typeof res.json === 'object') return res.json;

    let text = '';
    if (res && typeof res.text === 'function') { try { text = await res.text(); } catch (_) {} }
    else if (res && typeof res.body === 'string') text = res.body;

    if (text) {
      try { return JSON.parse(text); } catch (_) {}
    }
    throw new Error(MODULE_NAME + ': response from ' + url + ' was not valid JSON');
  }

  // ---------- helpers ----------

  async function resolveAnimeSlug(rawSlug) {
    let slug = String(rawSlug || '').trim();
    if (!slug) throw new Error(MODULE_NAME + ': empty anime slug');

    if (slug.startsWith('http://') || slug.startsWith('https://')) {
      const m = slug.match(/\/(?:anime\/)?(?:watch|info)\/([^/?#]+)/i) || slug.match(/\/watch\/([^/?#]+)/i);
      slug = m ? m[1] : '';
    } else {
      slug = slug.replace(/^\/?(anime\/)?(watch|info)\//i, '').replace(/^\/+|\/+$/g, '').split('/')[0];
    }
    if (!slug) throw new Error(MODULE_NAME + ': empty anime slug');

    // If slug is a 10-character Anikage ID or valid slug, check if valid
    try {
      const test = await requestJson(BASE_URL + '/api/media/anime/' + slug);
      if (test && (test.anime || test.slug || test.anilistId)) return slug;
    } catch (error) {
      if (error && error.rateLimited) throw error;
    }

    // Never substitute an unrelated first search result after a failed lookup.
    const searchRes = await searchResults(slug.replace(/[-_]+/g, ' '));
    const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const exact = searchRes.filter((item) => normalize(item.title) === normalize(slug));
    if (exact.length === 1) return exact[0].id;

    return slug;
  }

  function formatTitle(titleObj, fallback) {
    if (!titleObj || typeof titleObj !== 'object') return fallback || 'Anime';
    return titleObj.english || titleObj.userPreferred || titleObj.romaji || titleObj.native || fallback || 'Anime';
  }

  function formatImage(coverObj) {
    if (!coverObj) return '';
    if (typeof coverObj === 'string') return coverObj;
    return coverObj.extraLarge || coverObj.large || coverObj.medium || '';
  }

  // ---------- search ----------

  async function searchResults(query) {
    const q = String(query || '').trim();
    const url = BASE_URL + '/api/media/anime/browse?' + (q ? 'q=' + encodeURIComponent(q) : 'sort=TRENDING_DESC');
    const data = await requestJson(url);
    const results = (data && data.data) || [];

    return results.map((item) => {
      const title = formatTitle(item.title, item.slug);
      const poster = formatImage(item.coverImage);
      return {
        id: item.slug,
        href: BASE_URL + '/anime/info/' + item.slug,
        title: title,
        image: poster,
        poster: poster,
      };
    });
  }

  // ---------- details ----------

  async function extractDetails(urlOrId) {
    const slug = await resolveAnimeSlug(urlOrId);
    const data = await requestJson(BASE_URL + '/api/media/anime/' + slug);
    const anime = (data && data.anime) || data || {};

    const title = formatTitle(anime.title, slug);
    const poster = formatImage(anime.coverImage);
    const banner = anime.bannerImage || anime.fanart || poster;

    return {
      id: slug,
      href: BASE_URL + '/anime/info/' + slug,
      title: title,
      description: anime.description ? decodeHtml(anime.description.replace(/<[^>]*>/g, '')) : 'Watch on Anikage',
      image: poster,
      poster: poster,
      banner: banner,
      genres: Array.isArray(anime.genres) ? anime.genres : [],
      anilistId: anime.anilistId || 0,
      totalEpisodes: anime.episodes_total || anime.totalEpisodes || 0,
    };
  }

  // ---------- episodes ----------

  async function extractEpisodes(seriesId) {
    const slug = await resolveAnimeSlug(seriesId);
    const rawEpisodes = await requestJson(BASE_URL + '/api/media/anime/' + slug + '/episodes');
    const list = Array.isArray(rawEpisodes) ? rawEpisodes : [];

    return list.map((ep, idx) => {
      const epNum = ep.number || ep.episodeInSeason || (idx + 1);
      const epTitle = ep.title ? ('Episode ' + epNum + ': ' + ep.title) : ('Episode ' + epNum);

      return {
        id: slug + ':ep:' + epNum,
        number: epNum,
        title: 'S1E' + epNum + ': ' + epTitle,
        href: 'anikage-stream:' + JSON.stringify({ slug: slug, ep: epNum }),
        hasSub: true,
        hasDub: typeof ep.hasDub === 'boolean' ? ep.hasDub : undefined,
        subAvailable: true,
        dubAvailable: typeof ep.hasDub === 'boolean' ? ep.hasDub : undefined,
        image: ep.img || ep.image || '',
      };
    });
  }

  function unpackPacker(code) {
    try {
      const match = String(code || '').match(/eval\(function\(p,a,c,k,e,[rd]\)\{.*\}\('(.*)',\s*(\d+),\s*(\d+),\s*'([^']*)'\.split\('\|'\)/);
      if (!match) return null;
      let [_, p, a, c, k] = match;
      a = parseInt(a, 10);
      c = parseInt(c, 10);
      k = k.split('|');
      const e = function(c) {
        return (c < a ? '' : e(parseInt(c / a, 10))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
      };
      while (c--) {
        if (k[c]) {
          p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
        }
      }
      return p;
    } catch (_) {
      return null;
    }
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(fallback); }, waitMs);
      Promise.resolve(promise).then(function (value) {
        if (typeof clearTimeout === 'function') clearTimeout(timer);
        resolve(value);
      }, function () {
        if (typeof clearTimeout === 'function') clearTimeout(timer);
        resolve(fallback);
      });
    });
  }

  function mediaUrl(reference, base) {
    const raw = decodeHtml(reference);
    if (/^https?:\/\//i.test(raw)) return raw;
    const origin = String(base || '').match(/^(https?:\/\/[^/]+)/i);
    if (!origin || !raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
    if (raw.indexOf('//') === 0) return origin[1].split(':')[0] + ':' + raw;
    const full = raw[0] === '/' ? raw : String(base).slice(origin[1].length).split(/[?#]/)[0].replace(/[^/]*$/, '') + raw;
    const suffix = full.match(/[?#].*$/);
    const parts = [];
    full.split(/[?#]/)[0].split('/').forEach(function (part) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    });
    return origin[1] + '/' + parts.join('/') + (suffix ? suffix[0] : '');
  }

  function subtitleEntries(data, embedUrl) {
    const params = {};
    String(embedUrl || '').split('?').slice(1).join('?').split('#')[0].split('&').forEach(function (part) {
      const at = part.indexOf('=');
      if (at < 0) return;
      try { params[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(part.slice(at + 1)); } catch (_) {}
    });
    const tracks = [], seen = {};
    function add(file, label, language, preferred) {
      // Provider tokens are not relative paths. Only use supplied HTTP caption URLs.
      if (!/^https?:\/\//i.test(String(file || '')) || seen[file]) return;
      seen[file] = true;
      const name = label || language || 'Subtitles';
      const code = language || (/^english\b/i.test(name) ? 'en' : 'und');
      tracks.push({ url: file, file: file, label: name, language: code, lang: code,
        format: /\.srt(?:[?#]|$)/i.test(file) ? 'srt' : 'vtt', kind: 'captions',
        default: preferred === true, headers: { 'User-Agent': USER_AGENT } });
    }
    Object.keys(params).forEach(function (key) {
      const caption = key.match(/^caption_(\d+)$/i), file = key.match(/^c(\d+)_file$/i);
      if (caption) add(params[key], params['sub_' + caption[1]]);
      else if (file) add(params[key], params['c' + file[1] + '_label']);
      else if (key === 'sub') add(params[key], 'English', 'en');
    });
    (Array.isArray(data && data.subtitles) ? data.subtitles : []).forEach(function (track) {
      if (!track || (track.embedUrl && track.embedUrl !== embedUrl)) return;
      add(track.file || track.url, track.label, track.lang || track.language, track.default);
    });
    return tracks;
  }

  function marker(range) {
    if (!range || typeof range.start !== 'number' || typeof range.end !== 'number' ||
        !isFinite(range.start) || !isFinite(range.end) || range.start < 0 || range.end <= range.start) return null;
    return { start: range.start, end: range.end };
  }

  const validationCache = {};
  const inFlightValidate = {};
  async function validateStreamPlayback(streamUrl, headers, isM3u8, depth, active) {
    const cacheKey = depth === 0 ? String(streamUrl || '') : '';
    if (cacheKey) {
      const hit = validationCache[cacheKey];
      if (hit && hit.until > Date.now()) return hit.valid;
      if (inFlightValidate[cacheKey]) return inFlightValidate[cacheKey];
    }
    const job = (async () => {
      const valid = await validateStreamPlaybackUncached(streamUrl, headers, isM3u8, depth, active);
      if (cacheKey && valid) validationCache[cacheKey] = { until: Date.now() + 10 * 60 * 1000, valid: true };
      return valid;
    })();
    if (cacheKey) inFlightValidate[cacheKey] = job;
    try { return await job; } finally { if (cacheKey) delete inFlightValidate[cacheKey]; }
  }

  async function validateStreamPlaybackUncached(streamUrl, headers, isM3u8, depth, active) {
    depth = depth || 0;
    if (depth > 4 || (active && !active())) return false;
    try {
      if (isM3u8) {
        let playlistText = '';
        if (typeof fetchv2 === 'function') {
          const res = await fetchv2(streamUrl, headers, 'GET', null);
          if (!res || (res.status !== 200 && res.status !== 206)) return false;
          if (typeof res.text === 'function') playlistText = await res.text();
          else if (typeof res.body === 'string') playlistText = res.body;
        } else if (typeof fetch === 'function') {
          const res = await fetch(streamUrl, { headers });
          if (!res || !res.ok) return false;
          playlistText = await res.text();
        }
        if (!playlistText || !playlistText.includes('#EXTM3U')) return false;

        const lines = playlistText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        let segmentOrVariantUrl = '';
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (line.startsWith('#')) continue;
          if (line.startsWith('http://') || line.startsWith('https://')) {
            segmentOrVariantUrl = line;
            break;
          }
          segmentOrVariantUrl = mediaUrl(line, streamUrl);
          break;
        }
        if (!segmentOrVariantUrl) return false;

        if (segmentOrVariantUrl.includes('.m3u8')) {
          return validateStreamPlayback(segmentOrVariantUrl, headers, true, depth + 1, active);
        }

        if (active && !active()) return false;

        const probeHeaders = Object.assign({}, headers, { Range: 'bytes=0-4095' });
        let probeRes = null;
        if (typeof fetchv2 === 'function') {
          probeRes = await fetchv2(segmentOrVariantUrl, probeHeaders, 'GET', null);
        } else if (typeof fetch === 'function') {
          probeRes = await fetch(segmentOrVariantUrl, { headers: probeHeaders });
        }
        if (!probeRes) return false;
        const status = Number(probeRes.status || 0);
        if (status !== 200 && status !== 206) return false;

        let bodyText = '';
        if (typeof probeRes.text === 'function') { try { bodyText = await probeRes.text(); } catch (_) {} }
        else if (typeof probeRes.body === 'string') bodyText = probeRes.body;
        if (bodyText && (bodyText.includes('"error"') || bodyText.includes('domain forbidden') || bodyText.includes('Website Access Blocked'))) {
          return false;
        }

        // Classify by BYTES, never by label: the megaplay CDN serves genuine MPEG-TS
        // under `.jpg`/image-jpeg segments (anti-detection). Byte evidence wins;
        // content-type only rejects when the payload really looks like a web page.
        const cType = String(probeRes.contentType || (probeRes.headers && (probeRes.headers['content-type'] || probeRes.headers['Content-Type'])) || '').toLowerCase();
        const sample = bodyText ? bodyText.slice(0, 32) : '';
        const tsSync = sample.length > 0 && sample.charCodeAt(0) === 0x47;
        const fmp4 = /ftyp|styp|moof/.test(sample);
        const htmlish = /<!doctype|<html|<head|<body/i.test(sample);
        if (htmlish) return false;
        if (tsSync || fmp4) return true;
        if (cType.includes('text/html') || cType.includes('application/json')) return false;
        if (!sample && cType.includes('image/')) return true; // disguised-segment class; the player does the final check
        if (cType.includes('image/')) return false;           // readable bytes that really are an image
        return true;
      } else {
        const probeHeaders = Object.assign({}, headers, { Range: 'bytes=0-4095' });
        let probeRes = null;
        if (typeof fetchv2 === 'function') {
          probeRes = await fetchv2(streamUrl, probeHeaders, 'GET', null);
        } else if (typeof fetch === 'function') {
          probeRes = await fetch(streamUrl, { headers: probeHeaders });
        }
        if (!probeRes) return false;
        const status = Number(probeRes.status || 0);
        if (status !== 200 && status !== 206) return false;
        const cType = String(probeRes.contentType || (probeRes.headers && (probeRes.headers['content-type'] || probeRes.headers['Content-Type'])) || '').toLowerCase();
        if (cType.includes('text/html') || cType.includes('image/') || cType.includes('application/json')) return false;
        return true;
      }
    } catch (e) {
      log('validateStreamPlayback probe error: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  // ---------- embed resolvers ----------

// ---------------------------------------------------------------- player payload decryption
// The vidstream-style player hosts (megaplay.buzz family) moved their stream descriptor into
// an encrypted `enc` field of the getSources/getSourcesNew response (scheme implemented in the
// host's own newclient.min.js: AES-CBC, key "i?LMTAx0Q6,:}50U" zero-padded to 32 bytes, IV
// "W0;27ToaUpl_P%'c", base64url ciphertext, JSON plaintext). Decrypt locally — these are the
// site-published scheme constants, not user data. Pure ES5, no typed arrays, no WebCrypto.
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
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
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
  } catch (_) {
    return null;
  }
}


function safeJsonParse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

  // ---------------------------------------------------------------------------
  // Provider request budget helpers (anikage.cc allows only ~15 requests/min per
  // IP): cache shareable responses so repeat plays and re-navigations cost zero
  // quota, and stop re-fetching the player descriptor for the same episode.
  // ---------------------------------------------------------------------------
  const getSourcesCache = {};
  async function cachedGetSources(realId, srcUrl) {
    const hit = getSourcesCache[realId];
    if (hit && hit.until > Date.now()) return hit.data;
    const data = await requestJson(srcUrl, { 'Referer': 'https://megaplay.buzz/', 'Origin': 'https://megaplay.buzz' });
    getSourcesCache[realId] = { until: Date.now() + 10 * 60 * 1000, data: data };
    return data;
  }

  function playerPayloadStreams(payload) {
    // decryptPlayerPayload returns JSON ({sources:[{file,label}]} or {file}) or {file:url}.
    const raw = (payload && (payload.sources || payload.file)) || payload;
    const out = [];
    function push(entry) {
      if (!entry) return;
      const url = String((entry && (entry.file || entry.url)) || entry || '').trim();
      if (/^https?:\/\//i.test(url)) out.push({ url: url, quality: String((entry && (entry.label || entry.quality)) || '') });
    }
    if (Array.isArray(raw)) raw.forEach(push);
    else push(raw);
    out.sort(function (a, b) { return (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0); });
    return out.map(function (e) { return e.url; });
  }

  const embedResultCache = {};
  const inFlightEmbed = {};
  async function resolveEmbedUrl(embedUrl) {
    const key = String(embedUrl || '').trim();
    const hit = embedResultCache[key];
    if (hit && hit.until > Date.now()) return hit.result;
    if (inFlightEmbed[key]) return inFlightEmbed[key];
    const job = (async () => {
      const result = await resolveEmbedUrlUncached(key);
      if (result && result.url) embedResultCache[key] = { until: Date.now() + 10 * 60 * 1000, result: result };
      return result;
    })();
    inFlightEmbed[key] = job;
    try { return await job; } finally { delete inFlightEmbed[key]; }
  }

  async function resolveEmbedUrlUncached(embedUrl) {
    const raw = String(embedUrl || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) throw new Error('Invalid embed URL: ' + raw);

    const baseHeaders = {
      'User-Agent': USER_AGENT,
      'Referer': BASE_URL + '/',
    };

    // 1. Otaku / Playmogo family (OtakuHG, OtakuVid, Playmogo) -> unpack packer to get direct CDN HLS
    if (/otakuhg|otakuvid|playmogo/i.test(raw)) {
      let pageHtml = '';
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(raw, baseHeaders, 'GET', null);
        if (res && typeof res.text === 'function') pageHtml = await res.text();
        else if (res && typeof res.body === 'string') pageHtml = res.body;
      } else if (typeof fetch === 'function') {
        const res = await fetch(raw, { headers: baseHeaders });
        if (res.ok) pageHtml = await res.text();
      }

      const unpacked = unpackPacker(pageHtml) || pageHtml;
      const m3u8Match = unpacked.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
      if (m3u8Match) {
        const streamUrl = m3u8Match[0].replace(/\\/g, '');
        const streamHeaders = { 'User-Agent': USER_AGENT, 'Referer': raw };
        return {
          url: streamUrl,
          headers: streamHeaders,
          isM3U8: true,
          quality: 'Auto',
          label: 'Direct HD (Otaku)',
        };
      }
    }

    // 2. BibiEmb / ViviBebe family
    if (/bibiemb|vivibebe/i.test(raw)) {
      let pageHtml = '';
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(raw, baseHeaders, 'GET', null);
        if (res && typeof res.text === 'function') pageHtml = await res.text();
        else if (res && typeof res.body === 'string') pageHtml = res.body;
      } else if (typeof fetch === 'function') {
        const res = await fetch(raw, { headers: baseHeaders });
        if (res.ok) pageHtml = await res.text();
      }

      const m3u8Match = pageHtml.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
      if (m3u8Match) {
        const streamUrl = m3u8Match[0].replace(/\\/g, '');
        const streamHeaders = { 'User-Agent': USER_AGENT, 'Referer': raw };
        return {
          url: streamUrl,
          headers: streamHeaders,
          isM3U8: true,
          quality: 'Auto',
          label: 'Direct HD (Bibi)',
        };
      }
    }

    // 3. MegaPlay family
    if (/megaplay/i.test(raw)) {
      let pageHtml = '';
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(raw, baseHeaders, 'GET', null);
        if (res && typeof res.text === 'function') pageHtml = await res.text();
        else if (res && typeof res.body === 'string') pageHtml = res.body;
      } else if (typeof fetch === 'function') {
        const res = await fetch(raw, { headers: baseHeaders });
        if (res.ok) pageHtml = await res.text();
      }

      const realIdM = pageHtml.match(/data-realid=["']([^"']+)["']/i) || pageHtml.match(/data-id=["']([^"']+)["']/i);
      const realId = realIdM ? realIdM[1] : '';
      if (realId) {
        const srcUrl = 'https://megaplay.buzz/stream/getSources?id=' + encodeURIComponent(realId);
        const sJson = await cachedGetSources(realId, srcUrl);
        let file = (sJson && sJson.sources && sJson.sources[0] && sJson.sources[0].file) || (sJson && sJson.file);
        if ((!file || !String(file).startsWith('http')) && sJson && sJson.enc) {
          // The player host moved the stream descriptor into an encrypted `enc`
          // field (AES-CBC with the host's own published constants) - decrypt locally.
          const decrypted = decryptPlayerPayload(sJson.enc);
          if (decrypted) {
            const entries = playerPayloadStreams(decrypted);
            if (entries.length) file = entries[0];
          }
        }
        if (file && String(file).startsWith('http')) {
          const streamHeaders = { 'User-Agent': USER_AGENT, 'Referer': 'https://megaplay.buzz/', 'Origin': 'https://megaplay.buzz' };
          return {
            url: file,
            headers: streamHeaders,
            isM3U8: true,
            quality: 'HD',
            label: 'Direct HD (MegaPlay)',
          };
        }
      }
    }

    // 4. Vidtube / other direct m3u8 embed
    if (/vidtube/i.test(raw)) {
      let pageHtml = '';
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(raw, baseHeaders, 'GET', null);
        if (res && typeof res.text === 'function') pageHtml = await res.text();
        else if (res && typeof res.body === 'string') pageHtml = res.body;
      } else if (typeof fetch === 'function') {
        const res = await fetch(raw, { headers: baseHeaders });
        if (res.ok) pageHtml = await res.text();
      }

      const m3u8Match = pageHtml.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
      if (m3u8Match) {
        const streamUrl = m3u8Match[0].replace(/\\/g, '');
        const streamHeaders = { 'User-Agent': USER_AGENT, 'Referer': raw };
        return {
          url: streamUrl,
          headers: streamHeaders,
          isM3U8: true,
          quality: 'HD',
          label: 'Direct HD (Vidtube)',
        };
      }
    }

    throw new Error('Unsupported embed: ' + raw);
  }

  // ---------- stream resolution ----------

  async function extractStreamUrl(episodeHref, lang) {
    const raw = String(episodeHref || '').trim();
    let slug = '';
    let epNum = NaN;

    if (raw.startsWith('anikage-stream:')) {
      const parsed = JSON.parse(raw.slice('anikage-stream:'.length));
      slug = parsed.slug;
      epNum = parsed.ep;
    } else if (raw.includes(':ep:')) {
      const parts = raw.split(':ep:');
      slug = parts[0];
      epNum = Number(parts[1]);
    } else {
      const m = raw.match(/\/watch\/([^\/]+)\/([0-9]+)/i) || raw.match(/([^\/]+)\/episode\/([0-9]+)/i);
      if (m) {
        slug = m[1];
        epNum = Number(m[2]);
      }
    }

    epNum = Number(epNum);
    if (!/^[a-zA-Z0-9_-]+$/.test(String(slug || '')) || !isFinite(epNum) || epNum < 1 || Math.floor(epNum) !== epNum) {
      throw new Error(MODULE_NAME + ': invalid episode reference');
    }

    const targetLang = String(lang || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub';

    // Try fallbacks only when a provider has no checked routes. Resolve its actual
    // embed alternatives with two workers, retaining each route's own metadata.
    const providers = ['wave', 'koto', 'megg', 'zen', 'neko', 'dib', 'kiwi'];
    const deadline = Date.now() + 22000;
    const remaining = () => Math.max(0, deadline - Date.now());

    for (const provider of providers) {
      if (!remaining()) break;
      try {
        const queryUrl = BASE_URL + '/api/media/anime/' + encodeURIComponent(slug) + '/episodes/' + epNum + '/sources?provider=' + provider + '&lang=' + targetLang;
        const outcome = await settleWithin(requestJson(queryUrl, {
          'Referer': BASE_URL + '/anime/watch/' + slug,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        }).then((data) => ({ data: data }), (error) => ({ error: error })), Math.min(5000, remaining()), null);
        if (outcome && outcome.error) throw outcome.error;
        const data = outcome && outcome.data;
        if (!data || !remaining()) continue;
        if (data.subType && String(data.subType).toLowerCase() !== targetLang) continue;
        if ((data.slug && data.slug !== slug) || (data.number != null && Number(data.number) !== epNum)) continue;

        const intro = marker(data.intro), outro = marker(data.outro);
        const candidates = [], seenEmbeds = {};
        function addEmbed(entry) {
          if (!entry) return;
          const url = entry.embedUrl || entry.url;
          if (!/^https?:\/\//i.test(String(url || '')) || seenEmbeds[url]) return;
          if (entry.type === 'dub' && targetLang !== 'dub') return;
          if (/^(softsub|hardsub|sub)$/.test(entry.type || '') && targetLang === 'dub') return;
          seenEmbeds[url] = true;
          candidates.push({ url: url, name: entry.server || entry.label || 'Server ' + (candidates.length + 1) });
        }
        (Array.isArray(data.embeds) ? data.embeds : []).forEach(addEmbed);
        (Array.isArray(data.sources) ? data.sources : []).filter((entry) => entry && entry.embedUrl).forEach(addEmbed);
        (Array.isArray(data.embedOptions) ? data.embedOptions : []).forEach(addEmbed);
        candidates.sort((a, b) => {
          const score = (u) => /otakuhg|otakuvid|playmogo/i.test(u) ? 4 : (/bibiemb|vivibebe/i.test(u) ? 3 : 1);
          return score(b.url) - score(a.url);
        });
        (Array.isArray(data.sources) ? data.sources : []).forEach(function (entry) {
          if (!entry || !entry.url) return;
          if (entry.type === 'dub' && targetLang !== 'dub') return;
          if (/^(softsub|hardsub|sub)$/.test(entry.type || '') && targetLang === 'dub') return;
          // Newer source payloads carry an opaque token instead of a URL; the site's own player
          // expands it through PUBLIC_PROXY_URL. Only http(s) URLs pass through untouched.
          var sourceUrl = String(entry.url);
          if (!/^https?:\/\//i.test(sourceUrl)) {
            if (!/^[A-Za-z0-9_.\-]+$/.test(sourceUrl)) return;
            sourceUrl = PROXY_CDN.replace(/\/+$/, '') + '/' + sourceUrl;
          }
          candidates.push({ url: sourceUrl, direct: true, isM3U8: entry.isM3U8 !== false,
            headers: Object.assign({ 'User-Agent': USER_AGENT, Referer: BASE_URL + '/', Origin: BASE_URL }, data.headers || {}, entry.headers || {}),
            name: entry.server || entry.quality || 'Direct' });
        });
        let next = 0, closed = false;
        const routes = [];
        const active = () => !closed && remaining() > 0;
        async function worker() {
          while (next < candidates.length && active()) {
            const order = next++, candidate = candidates[order];
            let candidateClosed = false;
            const candidateActive = () => active() && !candidateClosed;
            async function resolveCandidate() {
              const resolved = candidate.direct ? candidate : await resolveEmbedUrl(candidate.url);
              if (!resolved || !candidateActive()) return null;
              const valid = await validateStreamPlayback(resolved.url, resolved.headers, resolved.isM3U8 !== false, 0, candidateActive);
              if (!valid || !candidateActive()) return null;
              return { name: candidate.name + ' (' + provider + ')', url: resolved.url, headers: resolved.headers,
                streamType: resolved.isM3U8 !== false ? 'hls' : 'mp4', quality: (await qualityFromMaster(resolved.url, resolved.headers, candidateActive)) || 'Auto', lang: targetLang,
                subtitles: subtitleEntries(data, candidate.url), intro: intro, outro: outro,
                introStartSeconds: intro ? intro.start : null, introEndSeconds: intro ? intro.end : null,
                outroStartSeconds: outro ? outro.start : null, outroEndSeconds: outro ? outro.end : null };
            }
            const route = await settleWithin(resolveCandidate(), Math.min(4500, remaining()), null);
            candidateClosed = true;
            if (route && active()) routes.push({ order: order, route: route });
          }
        }
        await settleWithin(Promise.all([worker(), worker()]), Math.max(1, remaining()), null);
        closed = true;
        routes.sort((a, b) => a.order - b.order);
        const seen = {}, servers = [];
        routes.forEach(function (entry) {
          if (seen[entry.route.url]) return;
          seen[entry.route.url] = true; servers.push(entry.route);
        });
        if (servers.length) {
          const primary = servers[0];
          return Object.assign({}, primary, { server: primary.name, servers: servers });
        }
      } catch (error) {
        if (error && error.rateLimited) throw error;
        log('Provider ' + provider + ' unavailable; trying next provider');
      }
    }

    throw new Error(MODULE_NAME + ': no checked ' + targetLang + ' stream available for this episode; try again later');
  }

  // ---------- discovery ----------

  async function discoveryHome() {
    const [trending, popular, topRated] = await Promise.all([
      requestJson(BASE_URL + '/api/media/anime/browse?sort=TRENDING_DESC&page=1'),
      requestJson(BASE_URL + '/api/media/anime/browse?sort=POPULARITY_DESC&page=1'),
      requestJson(BASE_URL + '/api/media/anime/browse?sort=SCORE_DESC&page=1'),
    ]);

    const trendingItems = (trending && trending.data) || [];
    const popularItems = (popular && popular.data) || [];
    const topRatedItems = (topRated && topRated.data) || [];

    const mapItem = (item) => ({
      id: item.slug,
      href: BASE_URL + '/anime/info/' + item.slug,
      title: formatTitle(item.title, item.slug),
      image: formatImage(item.coverImage),
    });

    const sections = [];

    // 1. Hero Featured Carousel
    sections.push({
      id: 'featured_trending',
      title: 'Featured Anime',
      style: 'hero',
      viewAll: { mode: 'feed', feedId: 'trending' },
      items: trendingItems.slice(0, 8).map(mapItem),
    });

    // 2. Top 10 Popular
    sections.push({
      id: 'top10_popular',
      title: 'Top 10 Most Popular',
      style: 'top10',
      viewAll: { mode: 'feed', feedId: 'popular' },
      items: popularItems.slice(0, 10).map(mapItem),
    });

    // 3. Trending Now
    sections.push({
      id: 'trending_now',
      title: 'Trending on Anikage',
      style: 'poster',
      viewAll: { mode: 'feed', feedId: 'trending' },
      items: trendingItems.slice(0, 24).map(mapItem),
    });

    // 4. Top Rated
    sections.push({
      id: 'top_rated',
      title: 'Top Rated Anime',
      style: 'poster',
      viewAll: { mode: 'feed', feedId: 'top_rated' },
      items: topRatedItems.slice(0, 24).map(mapItem),
    });

    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    const pageNum = Math.max(1, Number(page) || 1);
    let sort = 'TRENDING_DESC';

    if (feedId === 'popular') sort = 'POPULARITY_DESC';
    else if (feedId === 'top_rated') sort = 'SCORE_DESC';
    else if (feedId === 'favourites') sort = 'FAVOURITES_DESC';

    const data = await requestJson(BASE_URL + '/api/media/anime/browse?sort=' + sort + '&page=' + pageNum);
    const results = (data && data.data) || [];

    return {
      items: results.map((item) => ({
        id: item.slug,
        href: BASE_URL + '/anime/info/' + item.slug,
        title: formatTitle(item.title, item.slug),
        image: formatImage(item.coverImage),
      })),
      page: pageNum,
      hasMore: results.length >= 20,
    };
  }

  // ---------- Exports on globalThis ----------

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
  globalThis.extractHome = discoveryHome;
  globalThis.extractFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      searchResults,
      extractDetails,
      extractEpisodes,
      extractStreamUrl,
      discoveryHome,
      discoveryFeed,
      extractHome: discoveryHome,
      extractFeed: discoveryFeed,
    };
  }
})();
