/**
 * Anikoto Video Module
 *
 * Playback flow (reverse-engineered from /watch/ pages):
 * 1. ajax/episode/list/{showId} -> episode anchors with data-ids tokens
 * 2. ajax/server/list?servers={data-ids} -> server list (SUB/DUB/HSUB)
 * 3. ajax/server?get={data-link-id} -> embed player URL (VidTube / MegaPlay / VidWish)
 * 4. Fetch embed page, read data-id, call {playerHost}/stream/getSources?id={data-id}
 * 5. Return direct HLS + VTT subtitles with player Referer/Origin headers
 */

const MODULE_NAME = 'AnikotoV300';
const DOMAINS = ['https://anikototv.to', 'https://anikoto.cz'];
const SEARCH_MAX_RESULTS = 60;
const FILTER_PAGE_SIZE = 30;
const FALLBACK_MAX_ROUTES = 3;
const FALLBACK_MAX_EMBEDS_PER_PROVIDER = 4;
// Fallback quota hygiene: anikage.cc allows ~15 requests/min per IP and the whole
// provider sweep shares that one budget. Remember what already resolved (the app
// calls extractStreamUrl again on a retry) and stop fast when rate limited.
var FALLBACK_RATE_LIMITED = false;
var FALLBACK_ROUTE_CACHE = {};
var FALLBACK_ROUTE_TTL = 10 * 60 * 1000;
var FALLBACK_SLUG_CACHE = {};
var FALLBACK_SLUG_TTL = 6 * 60 * 60 * 1000;
function fallbackCacheGet(store, key) {
  var hit = store[key];
  if (!hit) return null;
  if (hit.expires <= Date.now()) { delete store[key]; return null; }
  return hit.value;
}
function fallbackCacheSet(store, key, value, ttl) {
  var keys = Object.keys(store);
  if (keys.length > 40) delete store[keys[0]];
  store[key] = { value: value, expires: Date.now() + ttl };
}
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Vidstream/MegaPlay often resolves to cdn.mewstream.buzz which 403s in native players.
// Prefer VidPlay first: current native probes show its nekostream route serves
// normal media segments, while the VidCloud route can expose image-only paths.
const SERVER_PRIORITY = {
  sub: ['vidplay', 'vidtube', 'vidcloud', 'vidwish', 'hd', 'vidstream', 'megaplay', 'vibe', 'kiwi'],
  // MegaPlay/Vidstream remain later fallbacks because their tickets often fail
  // in native playback even when the master playlist is reachable.
  dub: ['vidplay', 'vidtube', 'vidcloud', 'vidwish', 'hd', 'vidstream', 'megaplay', 'vibe', 'kiwi'],
  hsub: ['vidplay', 'vidtube', 'vidcloud', 'vidwish', 'hd', 'vidstream', 'megaplay', 'vibe', 'kiwi'],
};
const BLOCKED_STREAM_HOSTS = ['cdn.mewstream.buzz', 'mewstream.buzz', 'vibeplayer.site'];
const PLAYER_HOSTS = [
  { pattern: /megaplay\.|vidstream/i, getSourcesPath: '/stream/getSourcesNew' },
  { pattern: /vidtube\.site/i, getSourcesPath: '/stream/getSources' },
  { pattern: /vidwish\.live/i, getSourcesPath: '/stream/getSources' },
];

function log(message) {
  try {
    console.log('[' + MODULE_NAME + '] ' + String(message || '').replace(/https?:\/\/[^\s]+/g, '[URL]'));
  } catch (_) {}
}

function safeJsonParse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#0*38;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function decodeBase64Url(value) {
  const input = String(value || '').replace(/[\r\n\s]/g, '');
  if (!input) return '';
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < padded.length; i += 1) {
    const ch = padded.charAt(i);
    if (ch === '=') break;
    const idx = chars.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

function absoluteUrl(url, base) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return 'https:' + raw;
  const root = String(base || DOMAINS[0]).replace(/\/+$/, '');
  if (raw.startsWith('/')) return root + raw;
  return root + '/' + raw.replace(/^\//, '');
}

// Mirrors the released 8.6 session-HLS-proxy rewrite classes: manifest refs are served
// through /segment.<suffix>, but .m4s/.mp4/.html and /init. refs land in the /segment.mp4
// route the shipped dispatcher mis-handles. Routes without such refs are preferred when a
// choice exists; the count is advisory metadata and never changes validation acceptance.
function countProxyBrokenRefs(body, baseUrl) {
  const baseSafe = String(baseUrl || '').replace(/\/[^/]*$/, '/');
  const lines = String(body || '').split(/\r?\n/);
  let broken = 0;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf('#EXT-X-KEY') === 0) continue; // keys are served through /asset.m3u8
    if (line.indexOf('#EXT-X-MAP') === 0) {
      const uri = line.match(/URI="([^"]+)"/);
      if (!uri) continue;
      line = uri[1];
    } else if (line.charAt(0) === '#') {
      continue;
    }
    // Resolve relative refs against the playlist DIRECTORY, like the app's URI resolution,
    // so the playlist's own .m3u8 suffix cannot leak into every ref and skip them all.
    const abs = /^https?:\/\//i.test(line) ? absoluteUrl(line, baseUrl) : absoluteUrl(line, baseSafe);
    if (!abs) continue;
    const lower = abs.toLowerCase();
    if (lower.indexOf('.m3u8') !== -1) continue;
    if (/\.(m4s|mp4|html)$/.test(lower) || lower.indexOf('/init.') !== -1) broken += 1;
  }
  return broken;
}

function originFromUrl(url) {
  const match = String(url || '').match(/^(https?:\/\/[^/]+)/i);
  return match ? match[1] : '';
}

function normalizeLang(lang) {
  const value = String(lang || 'sub').toLowerCase().trim();
  if (value === 'dub' || value.includes('dub')) return 'dub';
  if (value === 'hsub' || value.includes('hsub') || value.includes('hard')) return 'hsub';
  return 'sub';
}

function langToServerType(lang) {
  const normalized = normalizeLang(lang);
  if (normalized === 'dub') return 'dub';
  if (normalized === 'hsub') return 'hsub';
  return 'sub';
}

function makeEpisodeHref(showId, slug, epNum) {
  return String(showId || '').trim() + '|' + String(slug || '').trim() + '|' + String(epNum || '').trim();
}

function normalizeSlug(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\/[^/]+\/?/i, '')
    .replace(/^\/+/, '')
    .replace(/^watch\//i, '')
    .replace(/\/ep-[^/?#]+$/i, '')
    .replace(/\/$/, '')
    .trim();
}

function parseEpisodeHref(raw) {
  const value = String(raw || '').trim();
  if (!value) return { showId: '', slug: '', epNum: '', base: '' };

  const json = safeJsonParse(value);
  if (json && typeof json === 'object') {
    return {
      showId: String(json.showId || json.id || '').trim(),
      slug: String(json.slug || json.watchSlug || '').trim(),
      epNum: String(json.epNum || json.number || json.episode || '').trim(),
      base: String(json.base || '').trim(),
    };
  }

  if (value.indexOf('|') !== -1) {
    const parts = value.split('|');
    return {
      showId: String(parts[0] || '').trim(),
      slug: String(parts[1] || '').trim(),
      epNum: String(parts[2] || '').trim(),
      base: String(parts[3] || '').trim(),
    };
  }

  const watchMatch = value.match(/\/watch\/([^/]+)(?:\/ep-([^/?#]+))?/i);
  if (watchMatch) {
    return {
      showId: '',
      slug: decodeURIComponent(watchMatch[1] || '').trim(),
      epNum: decodeURIComponent(watchMatch[2] || '').trim(),
      base: '',
    };
  }

  if (value.indexOf('::') !== -1) {
    const parts = value.split('::');
    return {
      showId: String(parts[0] || '').trim(),
      slug: String(parts[1] || '').trim(),
      epNum: String(parts[2] || '').trim(),
      base: '',
    };
  }

  return { showId: '', slug: value, epNum: '', base: '' };
}

async function readResponsePayload(res) {
  let textBody = '';
  let jsonBody = null;

  if (res && res.json !== undefined && res.json !== null && typeof res.json !== 'function') {
    jsonBody = res.json;
    textBody = JSON.stringify(jsonBody);
  } else if (res && typeof res.json === 'function') {
    try {
      jsonBody = await res.json();
      if (jsonBody != null) {
        textBody = JSON.stringify(jsonBody);
      }
    } catch (_) {
      jsonBody = null;
    }
  }

  if (!textBody && res && typeof res.text === 'function') {
    try {
      textBody = await res.text();
    } catch (_) {
      textBody = '';
    }
  }
  if (!textBody && res && typeof res.body === 'string') {
    textBody = res.body;
  }
  if (jsonBody == null) {
    jsonBody = safeJsonParse(textBody);
  }
  return { text: textBody, json: jsonBody };
}

async function request(url, options) {
  const cfg = options || {};
  if (cfg.alive && !cfg.alive()) throw new Error('Playback lookup expired');
  const method = cfg.method || 'GET';
  const headers = Object.assign(
    {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    cfg.headers || {},
  );
  const body = cfg.body == null ? null : cfg.body;

  if (typeof fetchv2 === 'function') {
    const res = await fetchv2(url, headers, method, body, cfg.maxBytesHint ? { maxBytesHint: cfg.maxBytesHint } : undefined);
    if (cfg.alive && !cfg.alive()) throw new Error('Playback lookup expired');
    const payload = await readResponsePayload(res);
    const status = Number((res && res.status) || 0);
    const responseHeaders = (res && res.headers) || {};
    return {
      ok: !!(res && (res.ok === true || (status >= 200 && status < 300))),
      status: status,
      text: payload.text,
      json: payload.json,
      contentType: String(
        (res && res.contentType) ||
          responseHeaders['content-type'] ||
          responseHeaders['Content-Type'] ||
          '',
      ),
      bodyBytes: Number((res && res.bodyBytes) || 0),
      bodyDropped: !!(res && res.bodyDropped),
      hlsPrefixBytes: Number((res && res.hlsPrefixBytes) || 0),
    };
  }

  if (typeof fetch === 'function') {
    const res = await fetch(url, { method, headers, body });
    const textBody = await res.text();
    return {
      ok: !!res.ok,
      status: Number(res.status || 0),
      text: textBody,
      json: safeJsonParse(textBody),
      contentType: String((res.headers && res.headers.get('content-type')) || ''),
      bodyBytes: textBody.length,
    };
  }

  throw new Error('No HTTP runtime available');
}

async function requestJson(url, headers, alive) {
  const res = await request(url, {
    alive: alive,
    headers: Object.assign(
      {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      headers || {},
    ),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const json = res.json || safeJsonParse(res.text);
  if (!json) throw new Error('Invalid JSON from ' + url);
  return json;
}

async function requestHtml(url, headers, alive) {
  const res = await request(url, {
    alive: alive,
    headers: Object.assign(
      {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      headers || {},
    ),
  });
  if (!res.ok || !res.text) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.text;
}

async function withDomainFallback(task) {
  let lastError = null;
  for (let i = 0; i < DOMAINS.length; i += 1) {
    const base = DOMAINS[i];
    try {
      return await task(base);
    } catch (error) {
      lastError = error;
      log('domain failed ' + base + ': ' + (error && error.message ? error.message : String(error)));
    }
  }
  throw lastError || new Error('All Anikoto domains failed');
}

function slugFromWatchHref(href) {
  const normalized = normalizeSlug(href);
  if (!normalized) return '';
  const watchMatch = normalized.match(/(?:^|\/)watch\/([^/?#]+)/i);
  if (watchMatch && watchMatch[1]) return String(watchMatch[1]).trim();
  return normalized.split('/')[0].trim();
}

function appendSearchCard(out, seen, card, limit) {
  const slug = slugFromWatchHref(card.href);
  const title = decodeHtml(card.title);
  if (!title || !slug || seen[slug]) return false;
  seen[slug] = true;
  out.push({
    title,
    href: slug,
    image: absoluteUrl(card.image || '', card.base || DOMAINS[0]),
  });
  return out.length >= (limit || SEARCH_MAX_RESULTS);
}

function parseAjaxSearchCards(html, base, limit, seen) {
  const out = [];
  const dedupe = seen || {};
  const source = String(html || '');
  const cap = limit || SEARCH_MAX_RESULTS;
  const ajaxRegex =
    /<a class="item" href="([^"]+)"[\s\S]*?<img\s+src="([^"]+)"[\s\S]*?<div class="name[^"]*"[^>]*>([^<]+)/gi;
  let match;
  while ((match = ajaxRegex.exec(source)) !== null) {
    if (
      appendSearchCard(
        out,
        dedupe,
        {
          href: match[1],
          image: match[2],
          title: match[3],
          base: base,
        },
        cap,
      )
    ) {
      return out;
    }
  }
  return out;
}

function parseFilterSearchCards(html, base, limit, seen) {
  const out = [];
  const dedupe = seen || {};
  const source = String(html || '');
  const cap = limit || SEARCH_MAX_RESULTS;
  const titleLinkRegex = /<a class="name d-title" href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = titleLinkRegex.exec(source)) !== null) {
    const start = Math.max(0, match.index - 900);
    const chunk = source.slice(start, match.index + match[0].length);
    const imgMatch = chunk.match(/<img[^>]+src="([^"]+)"/i);
    if (
      appendSearchCard(
        out,
        dedupe,
        {
          href: match[1],
          image: imgMatch ? imgMatch[1] : '',
          title: match[2],
          base: base,
        },
        cap,
      )
    ) {
      return out;
    }
  }
  return out;
}

function parseWatchCards(html, base, limit, seen) {
  const out = [];
  const dedupe = seen || {};
  const cap = limit || SEARCH_MAX_RESULTS;
  const batches = [
    parseFilterSearchCards(html, base, cap, dedupe),
    parseAjaxSearchCards(html, base, cap, dedupe),
  ];
  for (let i = 0; i < batches.length; i += 1) {
    for (let j = 0; j < batches[i].length; j += 1) {
      out.push(batches[i][j]);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function parseFilterMaxPage(html) {
  const pages = [];
  const regex = /page=(\d+)/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const page = parseInt(match[1], 10);
    if (!isNaN(page) && page > 0) pages.push(page);
  }
  return pages.length ? Math.max.apply(null, pages) : 1;
}

function normalizeSearchTerm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\bre[:\s\-_]*zero\b/g, 're zero')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rankSearchResult(item, query) {
  const qNorm = normalizeSearchTerm(query);
  if (!qNorm) return 50;
  const tNorm = normalizeSearchTerm(item && item.title);
  if (!tNorm) return 100;

  let score = 50;

  if (tNorm === qNorm) {
    score = 0;
  } else if (tNorm === qNorm + ' tv') {
    score = 1;
  } else if (tNorm.indexOf(qNorm + ' ') === 0) {
    score = 5;
  } else if (tNorm.indexOf(qNorm) !== -1) {
    score = 15;
  } else {
    const tokens = qNorm.split(' ').filter(Boolean);
    if (tokens.length && tokens.every(function (tok) { return tNorm.indexOf(tok) !== -1; })) {
      score = 25;
    } else {
      score = 60;
    }
  }

  // Length/conciseness tiebreaker: penalize extra words so base series ranks above lengthy spinoffs
  const qTokens = qNorm.split(' ').filter(Boolean);
  const tTokens = tNorm.split(' ').filter(Boolean);
  const extraWords = Math.max(0, tTokens.length - qTokens.length);
  score += Math.min(10, extraWords);

  // Check if query specifically requested season / part / movie / special
  const qHasSeason = /\b(season\s*\d+|s\d+|\d+(st|nd|rd|th)\s*season)\b/i.test(query);
  const qHasPart = /\bpart\s*\d+\b/i.test(query);
  const qHasMovie = /\b(movie|film)\b/i.test(query);

  const rawTitle = String((item && item.title) || '');
  const tHasSeason = /\b(season\s*[2-9]|\d{2,}|[2-9](st|nd|rd|th)\s*season)\b/i.test(rawTitle);
  const tHasPart = /\bpart\s*[2-9]\b/i.test(rawTitle);
  const tHasMovie = /\b(movie|film)\b/i.test(rawTitle);
  const tHasSpecial = /\b(special|specials|ova|ona)\b/i.test(rawTitle);

  if (!qHasSeason && tHasSeason) score += 30;
  if (!qHasPart && tHasPart) score += 20;
  if (!qHasMovie && tHasMovie) score += 25;
  if (tHasSpecial) score += 35;

  return score;
}

function parseShowIdFromHtml(html) {
  const source = String(html || '');
  const patterns = [
    /name="show_id"\s+value="(\d+)"/i,
    /data-sync-id="(\d+)"/i,
    /data-anime-id="(\d+)"/i,
    /data-manga-id="(\d+)"/i,
    /data-tip="(\d+)"/i,
    /data-id="(\d+)"/i,
    /mangaId\s*=\s*(\d+)/i,
    /\/ajax\/episode\/list\/(\d+)/i,
  ];
  for (let i = 0; i < patterns.length; i += 1) {
    const match = source.match(patterns[i]);
    if (match && match[1]) return String(match[1]).trim();
  }
  return '';
}

function parseDetailsFromHtml(html, base, slug) {
  const source = String(html || '');
  const ogTitle = (source.match(/property="og:title"\s+content="([^"]*)"/i) || [])[1];
  const ogImage = (source.match(/property="og:image"\s+content="([^"]*)"/i) || [])[1];
  const ogDescription = (source.match(/property="og:description"\s+content="([^"]*)"/i) || [])[1];
  const h1 = (source.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i) || [])[1];
  const title = decodeHtml((h1 || ogTitle || '').replace(/Watch\s+/i, '').replace(/\s+Anime.*$/i, '').trim());
  if (!title) throw new Error('Could not parse series title');

  return {
    title,
    description: decodeHtml(ogDescription || ''),
    image: absoluteUrl(ogImage || '', base),
    href: slug,
    showId: parseShowIdFromHtml(source),
    aliases: (source.match(/data-jp="([^"]*)"/i) || [])[1] || '',
  };
}

function playerCatalogueId(html) {
  // Scope to the current player, never IDs in recommendations or other artwork.
  const player = String(html || '').match(/<div\b[^>]*\bid=["']player["'][^>]*>/i);
  const banner = player && player[0].match(/https:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/anime\/banner\/(\d+)[-\.]/i);
  return banner ? String(banner[1]) : '';
}

function showMalId(html) {
  // Episode-list anchors carry a uniform MAL id per show (data-mal) that is
  // available even when the watch page banner has no AniList id; used only to
  // key the Vidhawk fallback, never exposed as metadata.
  const match = String(html || '').match(/<a\b[^>]*data-mal="(\d+)"/i);
  return match ? String(match[1]) : '';
}

function parseEpisodesFromHtml(html, showId, slug, base) {
  const source = String(html || '');
  const episodes = [];
  const seen = {};
  const regex = /<a href="#"[^>]*data-id="(\d+)"[^>]*data-num="([^"]*)"[^>]*data-slug="([^"]*)"[^>]*data-sub="([^"]*)"[^>]*data-dub="([^"]*)"[^>]*data-ids="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const epId = String(match[1] || '').trim();
    const epNum = String(match[2] || match[3] || '').trim();
    const epSlug = String(match[3] || epNum).trim();
    const subAvailable = String(match[4] || '') === '1';
    const dubAvailable = String(match[5] || '') === '1';
    const dataIds = String(match[6] || '').trim();
    const key = epId || epNum;
    if (!key || seen[key]) continue;
    seen[key] = true;
    episodes.push({
      number: Number(epNum) || episodes.length + 1,
      href: makeEpisodeHref(showId, slug, epNum || epSlug),
      title: 'Episode ' + (epNum || episodes.length + 1),
      season: 1,
      subAvailable,
      dubAvailable,
      epId,
      epSlug,
      dataIds,
    });
  }
  return episodes;
}

function parseServersFromHtml(html, lang) {
  const source = String(html || '');
  const targetType = langToServerType(lang);
  const typeRegex = new RegExp(
    '<div class="type"[^>]*data-type="' + targetType + '"[\\s\\S]*?<ul>([\\s\\S]*?)</ul>',
    'i',
  );
  const blockMatch = source.match(typeRegex);
  // Missing language group must not expose another group's servers.
  const block = blockMatch ? blockMatch[1] : '';
  const servers = [];
  const regex = /<li[^>]*data-link-id="([^"]+)"[^>]*>([^<]+)</gi;
  let match;
  while ((match = regex.exec(block)) !== null) {
    servers.push({
      linkId: String(match[1] || '').trim(),
      name: decodeHtml(match[2] || '').trim(),
    });
  }
  return servers;
}

function serverPriorityList(lang) {
  const key = langToServerType(lang);
  return SERVER_PRIORITY[key] || SERVER_PRIORITY.sub;
}

function serverRank(name, lang) {
  const lower = String(name || '').toLowerCase();
  const priorities = serverPriorityList(lang);
  for (let i = 0; i < priorities.length; i += 1) {
    if (lower.indexOf(priorities[i]) !== -1) return i;
  }
  return priorities.length;
}

function playerLangFromUrl(playerUrl) {
  const match = String(playerUrl || '').match(/\/(sub|dub|hsub)(?:[/?#]|$)/i);
  return match ? normalizeLang(match[1]) : '';
}

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

function parsePlayerPageMeta(html) {
  const source = String(html || '');
  const playerId =
    (source.match(/data-id=["'](\d+)["']/i) || [])[1] ||
    (source.match(/id:\s*["']?(\d+)["']?/i) || [])[1] ||
    '';
  const typeMatch = source.match(/type:\s*['"](sub|dub|hsub)['"]/i);
  return {
    playerId: String(playerId || '').trim(),
    type: typeMatch ? normalizeLang(typeMatch[1]) : '',
  };
}

function dedupeServers(servers) {
  const out = [];
  const seen = {};
  for (let i = 0; i < servers.length; i += 1) {
    const server = servers[i];
    const key = String(server.linkId || server.name || '').trim();
    if (!key || seen[key]) continue;
    seen[key] = true;
    out.push(server);
  }
  return out;
}

function sortServers(servers, lang) {
  const normalized = normalizeLang(lang);
  return servers.slice().sort(function (a, b) {
    return serverRank(a.name, normalized) - serverRank(b.name, normalized);
  });
}

function buildStreamHeaders(playerOrigin) {
  const origin = String(playerOrigin || '').replace(/\/+$/, '');
  return {
    Referer: origin + '/',
    Origin: origin,
    'User-Agent': USER_AGENT,
    Accept: '*/*',
  };
}

function isBlockedStreamUrl(url) {
  // JavaScriptCore does not guarantee the browser URL global. Parse the host
  // directly so blocklist enforcement is identical in Flutter and browsers.
  const match = String(url || '')
    .trim()
    .match(/^[a-z][a-z0-9+.-]*:\/\/([^\/?#:]+)/i);
  const host = match && match[1] ? String(match[1]).toLowerCase() : '';
  if (!host) return false;
  for (let i = 0; i < BLOCKED_STREAM_HOSTS.length; i += 1) {
    if (host === BLOCKED_STREAM_HOSTS[i] || host.endsWith('.' + BLOCKED_STREAM_HOSTS[i])) {
      return true;
    }
  }
  return false;
}

function looksLikeFakeHls(body) {
  const text = String(body || '');
  if (!text.includes('#EXTM3U')) return true;
  if (/ibyteimg\.com|\/obj\/ad-site|tiktokcdn\.com.*\.image|tplv-.*\.image/im.test(text)) return true;
  return false;
}

async function validateHlsManifest(url, headers, alive) {
  if (!url || isBlockedStreamUrl(url)) {
    return { ok: false, reason: 'blocked or missing stream host' };
  }

  const res = await request(url, {
    method: 'GET',
    headers: headers,
    alive: alive,
  });
  const body = String((res && res.text) || '');
  if (!res.ok) {
    return { ok: false, reason: 'manifest HTTP ' + res.status };
  }
  if (looksLikeFakeHls(body)) {
    return { ok: false, reason: 'manifest is not playable HLS' };
  }
  return { ok: true, body: body };
}

function settleWithin(promise, timeoutMs, fallback) {
  const waitMs = Math.max(1, Number(timeoutMs) || 0);
  let timer;
  const timeout = new Promise(function (resolve) {
    timer = setTimeout(function () { resolve(fallback); }, waitMs);
  });
  return Promise.race([promise, timeout]).then(function (result) {
    if (typeof clearTimeout === 'function') clearTimeout(timer);
    return result;
  }, function (error) {
    if (typeof clearTimeout === 'function') clearTimeout(timer);
    throw error;
  });
}

// A master can be valid while its media segments are ad images or placeholders.
// Probe a small range from one real segment before handing a server to AVPlayer.
async function validateHlsPlayback(url, headers, options) {
  if (options && options.alive && !options.alive()) return { ok: false, reason: 'playback lookup expired' };
  // This memo belongs to one extraction only; signed media URLs are never persisted.
  if (options && options.memo) {
    const headerKey = Object.keys(headers || {}).sort().map(function (key) { return [key, headers[key]]; });
    const key = JSON.stringify([url, headerKey, options.maxBytesHint || 0]);
    if (!options.memo[key]) options.memo[key] = probeHlsPlayback(url, headers, options);
    return options.memo[key];
  }
  return probeHlsPlayback(url, headers, options);
}

async function probeHlsPlayback(url, headers, options) {
  let closed = false;
  // Total probe budget raised 3000 -> 5000 ms (trio repair 2026-09-27): the AniKage CDNs
  // ignore Range and the first segment is ~2.1 MB, which needs more than 3 s on a 4 MiB cap.
  const deadline = Date.now() + 5000;
  function alive() { return !closed && Date.now() < deadline && (!options || !options.alive || options.alive()); }
  return settleWithin(
    (async function () {
      const master = await validateHlsManifest(url, headers, alive);
      if (!master.ok) return master;

      let playlistUrl = url;
      let playlistBody = master.body;
      const variants = parseHlsQualityVariants(url, master.body);
      if (variants.length) {
        const preferred = variants.slice().sort(function (a, b) {
          const aHeight = Number((String(a.quality || '').match(/(\d{3,4})p/i) || [])[1]) || 0;
          const bHeight = Number((String(b.quality || '').match(/(\d{3,4})p/i) || [])[1]) || 0;
          return bHeight - aHeight;
        })[0];
        playlistUrl = preferred.url;
        const playlist = await request(playlistUrl, { headers: headers, alive: alive });
        if (!playlist.ok || !String(playlist.text || '').includes('#EXTM3U')) {
          return { ok: false, reason: 'variant playlist unavailable' };
        }
        playlistBody = playlist.text;
      }

      const segmentUrl = firstHlsMediaUrl(playlistUrl, playlistBody);
      if (!segmentUrl) return { ok: false, reason: 'playlist has no media segments' };
      const proxyBrokenRefs = countProxyBrokenRefs(playlistBody, playlistUrl);
      const probe = await request(segmentUrl, {
        headers: Object.assign({}, headers, { Range: 'bytes=0-4095' }),
        maxBytesHint: options && options.maxBytesHint || 4194304,
        alive: alive,
      });
      if (!probe.ok) return { ok: false, reason: 'segment HTTP ' + probe.status };
      if (probe.bodyDropped || !probe.text) {
        // Range ignored + body cut at the 4 MiB probe cap: reachability evidence only
        // (no byte signature). Accept unless the response marks an error page.
        const droppedCt = String(probe.contentType || '').toLowerCase();
        const droppedBytes = Number(probe.bodyBytes || 0);
        if (probe.status >= 200 && probe.status < 300 && droppedBytes >= 3145728 && droppedCt.indexOf('html') < 0 && droppedCt.indexOf('json') < 0) {
          return { ok: true, body: master.body, url: playlistUrl, kind: 'size_capped', brokenRefs: proxyBrokenRefs, reachabilityOnly: true };
        }
        return { ok: false, reason: 'segment bytes unavailable for validation' };
      }
      // Released 8.6 validates this wrapper in native code before exposing its
      // prefix length. Filename and MIME alone cannot distinguish it from an ad.
      const normalizedTs = probe.hlsPrefixBytes > 0;
      if (!normalizedTs && looksLikeImagePayload(probe.contentType, probe.text)) {
        return { ok: false, reason: 'segment is image placeholder' };
      }
      if (/^\s*<(?:!doctype|html)/i.test(String(probe.text || ''))) {
        return { ok: false, reason: 'segment is HTML instead of media' };
      }
      const sample = String(probe.text || '');
      const ts = sample.charCodeAt(0) === 0x47;
      const mp4 = /^(?:ftyp|styp|moof|mdat)$/.test(sample.slice(4, 8));
      if (!normalizedTs && !ts && !mp4) {
        return { ok: false, reason: 'segment has no recognized media container' };
      }
      return { ok: true, body: master.body, url: playlistUrl, brokenRefs: proxyBrokenRefs };
    })(),
    5000,
    { ok: false, reason: 'probe timed out after 5000ms' },
  ).then(function (result) { closed = true; return result; }, function (error) { closed = true; throw error; });
}

function directMediaFromPlayerUrl(playerUrl) {
  const url = String(playerUrl || '').trim();
  if (!url) return '';
  if (/\.m3u8(\?|$)|\.mp4(\?|$)/i.test(url)) return url;
  if (url.indexOf('#') !== -1) {
    const fragment = url.split('#')[1].replace(/#+$/, '').trim();
    if (!fragment) return '';
    if (/^https?:\/\//i.test(fragment)) return fragment;
    const decoded = decodeBase64Url(fragment);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }
  return '';
}

function playerConfigForUrl(playerUrl) {
  const origin = originFromUrl(playerUrl);
  for (let i = 0; i < PLAYER_HOSTS.length; i += 1) {
    if (PLAYER_HOSTS[i].pattern.test(playerUrl)) {
      return {
        origin: origin,
        getSourcesUrl: origin + PLAYER_HOSTS[i].getSourcesPath,
      };
    }
  }
  if (/vidtube|megaplay|vidwish/i.test(origin)) {
    return { origin: origin, getSourcesUrl: origin + '/stream/getSources' };
  }
  return null;
}

function normalizeSourceEntries(sourceData) {
  const streams = [];
  if (!sourceData) return streams;
  let raw = sourceData.sources || sourceData.file;
  if (raw && typeof raw === 'object' && raw.file) {
    raw = raw.file;
  }
  if (!raw) return streams;

  if (typeof raw === 'string' && raw.trim()) {
    streams.push({ quality: 'Auto', url: raw.trim() });
    return streams;
  }

  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 1) {
      const item = raw[i] || {};
      const url = String(item.file || item.url || '').trim();
      if (!url) continue;
      streams.push({
        quality: String(item.label || item.quality || item.type || 'Auto').trim() || 'Auto',
        url,
      });
    }
    return streams;
  }

  if (typeof raw === 'object') {
    const url = String(raw.file || raw.url || '').trim();
    if (url) {
      streams.push({
        quality: String(raw.label || raw.quality || 'Auto').trim() || 'Auto',
        url,
      });
    }
  }
  return streams;
}

function resolveMediaUrl(reference, baseUrl) {
  const raw = String(reference || '').trim();
  const base = String(baseUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return 'https:' + raw;
  const origin = originFromUrl(base);
  if (!origin) return '';
  if (raw.startsWith('/')) return origin + raw;
  const cleanBase = base.split('#')[0].split('?')[0];
  const slash = cleanBase.lastIndexOf('/');
  const directory = slash >= 0 ? cleanBase.slice(0, slash + 1) : origin + '/';
  return directory + raw.replace(/^\.\//, '');
}

// A player often returns one HLS master URL even though that master contains
// its own 360p/720p/1080p variants. Expose those variants to the app so its
// generic quality picker can work without any Anikoto-specific UI.
function parseHlsQualityVariants(masterUrl, manifest) {
  const source = String(manifest || '');
  if (!source.includes('#EXTM3U')) return [];
  const variants = [];
  const seen = {};
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const tag = String(lines[i] || '').trim();
    if (!tag.startsWith('#EXT-X-STREAM-INF:')) continue;
    let target = '';
    for (let next = i + 1; next < lines.length; next += 1) {
      const candidate = String(lines[next] || '').trim();
      if (!candidate) continue;
      if (!candidate.startsWith('#')) {
        target = resolveMediaUrl(candidate, masterUrl);
        break;
      }
    }
    if (!target || seen[target]) continue;
    const resolution = tag.match(/RESOLUTION=\d+x(\d+)/i);
    const height = resolution && resolution[1] ? String(resolution[1]) : '';
    seen[target] = true;
    variants.push({ quality: height ? height + 'p' : 'Auto', url: target });
  }
  return variants;
}

function firstHlsMediaUrl(playlistUrl, manifest) {
  const lines = String(manifest || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '').trim();
    if (!line || line.startsWith('#')) continue;
    return resolveMediaUrl(line, playlistUrl);
  }
  return '';
}

function looksLikeImagePayload(contentType, body) {
  const type = String(contentType || '').toLowerCase();
  const sample = String(body || '').slice(0, 96);
  const upper = sample.toUpperCase();
  // fetchv2 exposes binary samples as UTF-8 text. A PNG header therefore
  // normally starts with replacement-char + PNG even when a CDN lies about
  // the MIME type. That is sufficient to reject the 1x1 ad placeholders seen
  // from some otherwise-valid HLS playlists without treating normal TS data
  // as an image.
  const hasPngSignature = sample.slice(0, 16).toUpperCase().includes('PNG');
  const hasJpegMarker =
    upper.indexOf('JFIF') >= 0 && upper.indexOf('JFIF') <= 16 ||
    upper.indexOf('EXIF') >= 0 && upper.indexOf('EXIF') <= 16;
  if (hasPngSignature || hasJpegMarker) return true;
  // Several valid HLS CDNs deliberately use `.jpg` paths and even label their
  // MPEG-TS segments as image/jpeg. MIME alone is not evidence of a bad
  // stream; only reject a real image signature or HTML above.
  return false;
}

// Subtitle `lang` is a language tag, not a display label: the app matches
// codes ('en', 'en-...') for auto-selection and certifiers normalize them.
// Provider labels look like "Portuguese (- Portuguese(Brazil))"; strip the
// "(- qualifier)" tail and map known names to ISO tags.
const SUBTITLE_LANGUAGE_CODES = { english: 'en', eng: 'en', japanese: 'ja', spanish: 'es',
  arabic: 'ar', french: 'fr', italian: 'it', german: 'de', portuguese: 'pt', russian: 'ru',
  chinese: 'zh', korean: 'ko', turkish: 'tr', polish: 'pl', indonesian: 'id', thai: 'th',
  vietnamese: 'vi', dutch: 'nl', greek: 'el', hindi: 'hi' };

function subtitleLanguageTag(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'und';
  const clean = raw.replace(/\s*\(-\s.*\)\s*$/, '').replace(/\s*\([^()]*\)\s*$/, '').trim() || raw;
  const candidates = [clean.toLowerCase(), clean.toLowerCase().split(/[ (]/)[0],
    raw.toLowerCase().split(/[ (]/)[0]];
  for (let i = 0; i < candidates.length; i += 1) {
    if (SUBTITLE_LANGUAGE_CODES[candidates[i]]) return SUBTITLE_LANGUAGE_CODES[candidates[i]];
  }
  return clean;
}

function normalizeSubtitleEntries(sourceData, playerOrigin) {
  const tracks = Array.isArray(sourceData && sourceData.tracks) ? sourceData.tracks : [];
  const streamHeaders = buildStreamHeaders(playerOrigin);
  const subtitles = [];
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i] || {};
    const rawFile = String(track.file || track.url || '').trim();
    if (!rawFile || /^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(rawFile)) continue;
    const file = absoluteUrl(rawFile, playerOrigin);
    const kind = String(track.kind || '').toLowerCase();
    if (kind && kind.indexOf('caption') === -1 && kind.indexOf('subtitle') === -1 && kind.indexOf('sub') === -1) {
      continue;
    }
    subtitles.push({
      file: file,
      url: file,
      label: String(track.label || track.lang || 'Subtitles').trim() || 'Subtitles',
      lang: subtitleLanguageTag(track.srclang || track.lang || track.label || 'und'),
      kind: track.kind || 'captions',
      default: track.default === true || track.default === 'true',
      headers: streamHeaders,
    });
  }
  return subtitles;
}

function normalizeMarkerRange(marker) {
  if (!marker) return null;

  let start;
  let end;
  if (Array.isArray(marker)) {
    start = Number(marker[0]);
    end = Number(marker[1]);
  } else if (typeof marker === 'object') {
    start = Number(
      marker.start ??
        marker.from ??
        marker.startSeconds ??
        marker.start_seconds,
    );
    end = Number(
      marker.end ??
        marker.to ??
        marker.endSeconds ??
        marker.end_seconds,
    );
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return null;
  }
  return { start, end };
}

function pickMarkerRange(primary, fallback) {
  return normalizeMarkerRange(primary) || normalizeMarkerRange(fallback);
}

async function fetchPlayerSources(playerUrl, expectedLang, alive) {
  const targetLang = normalizeLang(expectedLang);
  const direct = directMediaFromPlayerUrl(playerUrl);
  if (direct) {
    return {
      playerUrl,
      playerOrigin: originFromUrl(direct) || originFromUrl(playerUrl),
      streams: [{ quality: 'Auto', url: direct }],
      subtitles: [],
      intro: null,
      outro: null,
      playerType: playerLangFromUrl(playerUrl) || targetLang,
    };
  }

  const playerHtml = await requestHtml(playerUrl, {
    Referer: DOMAINS[0] + '/',
  }, alive);

  const playerMeta = parsePlayerPageMeta(playerHtml);
  const playerId = playerMeta.playerId;
  if (!playerId) throw new Error('Could not find player data-id on embed page');

  const config = playerConfigForUrl(playerUrl);
  if (!config) throw new Error('Unsupported player host: ' + playerUrl);

  const playerType = playerMeta.type || playerLangFromUrl(playerUrl) || targetLang;
  let sourceUrl =
    config.getSourcesUrl +
    '?id=' +
    encodeURIComponent(playerId) +
    '&id=' +
    encodeURIComponent(playerId);
  if (playerType) {
    sourceUrl += '&type=' + encodeURIComponent(playerType);
  }

  const reqHeaders = {
    Referer: /megaplay/i.test(playerUrl) ? 'https://megaplay.buzz/' : playerUrl,
    Origin: config.origin,
    Accept: 'application/json, text/javascript, */*; q=0.01',
  };

  let sourceData = null;
  try {
    sourceData = await requestJson(sourceUrl, reqHeaders, alive);
  } catch (_) {
    if (sourceUrl.includes('getSourcesNew')) {
      const fallbackUrl = sourceUrl.replace('getSourcesNew', 'getSources');
      try {
        sourceData = await requestJson(fallbackUrl, reqHeaders, alive);
      } catch (e) {
        throw new Error('Player getSources failed: ' + (e && e.message ? e.message : e));
      }
    } else {
      throw _;
    }
  }

  let streams = normalizeSourceEntries(sourceData);
  if (!streams.length && sourceData && sourceData.enc) {
    // The player hosts now ship the stream descriptor encrypted in `enc`.
    const decrypted = decryptPlayerPayload(sourceData.enc);
    if (decrypted) streams = normalizeSourceEntries(decrypted);
  }
  if (!streams.length) throw new Error('Player returned no stream sources');

  // Dub audio can still have full-dialogue or signs/songs caption tracks.
  const subtitles = normalizeSubtitleEntries(sourceData, config.origin);

  return {
    playerUrl,
    playerOrigin: config.origin,
    streams,
    subtitles,
    intro: normalizeMarkerRange(sourceData.intro),
    outro: normalizeMarkerRange(sourceData.outro),
    playerType,
  };
}

async function resolveEpisodeContext(episodeHref, alive) {
  const parsed = parseEpisodeHref(episodeHref);
  return withDomainFallback(async function (base) {
    let showId = parsed.showId;
    let slug = parsed.slug;
    let epNum = parsed.epNum;

    if (!slug && episodeHref) slug = String(episodeHref).trim();
    if (!slug) throw new Error('Missing series slug');

    const watchUrl = absoluteUrl('/watch/' + slug + (epNum ? '/ep-' + epNum : ''), base);
    const watchHtml = await requestHtml(watchUrl, { Referer: base + '/' }, alive);
    if (!showId) showId = parseShowIdFromHtml(watchHtml);
    if (!showId) throw new Error('Could not resolve show id for ' + slug);

    const episodeList = await requestJson(absoluteUrl('/ajax/episode/list/' + showId, base), {
      Referer: watchUrl,
    }, alive);
    if (Number(episodeList.status) !== 200 || !episodeList.result) {
      throw new Error(episodeList.message || 'Episode list unavailable');
    }

    const episodes = parseEpisodesFromHtml(episodeList.result, showId, slug, base);
    if (!episodes.length) throw new Error('No episodes found for ' + slug);

    let episode = null;
    if (epNum) {
      episode = episodes.find(function (item) {
        return String(item.number) === String(epNum) || String(item.epSlug) === String(epNum);
      });
    }
    if (!episode && epNum) throw new Error('Requested episode is unavailable');
    if (!episode) episode = episodes[0];

    return {
      base,
      showId,
      slug,
      episode,
      watchUrl,
      title: parseDetailsFromHtml(watchHtml, base, slug).title,
      catalogueId: playerCatalogueId(watchHtml),
      malId: showMalId(episodeList.result),
      alias: decodeHtml(parseDetailsFromHtml(watchHtml, base, slug).aliases || ''),
    };
  });
}

async function extractStreamFromServer(base, watchUrl, server, lang, options) {
  const opts = options || {};
  const targetLang = normalizeLang(lang);
  const payload = await requestJson(
    absoluteUrl('/ajax/server?get=' + encodeURIComponent(server.linkId), base),
    { Referer: watchUrl },
    opts.alive,
  );
  if (Number(payload.status) !== 200 || !payload.result || !payload.result.url) {
    throw new Error((payload && payload.message) || 'Server link unavailable');
  }

  const playerUrl = String(payload.result.url || '').trim();
  const playerLang = playerLangFromUrl(playerUrl);
  if (playerLang && playerLang !== targetLang) {
    throw new Error('Player URL language mismatch (' + playerLang + ' != ' + targetLang + ')');
  }
  // Per-play deduplication only: never persist expiring player links.
  if (opts.seenPlayers) {
    if (opts.seenPlayers[playerUrl]) throw new Error('Duplicate player route');
    opts.seenPlayers[playerUrl] = true;
  }

  log('server ' + server.name + ' [' + targetLang + '] -> ' + playerUrl);
  const resolved = await fetchPlayerSources(playerUrl, targetLang, opts.alive);
  if (resolved.playerType && resolved.playerType !== targetLang) {
    throw new Error('Player page language mismatch (' + resolved.playerType + ' != ' + targetLang + ')');
  }

  const streamHeaders = buildStreamHeaders(resolved.playerOrigin);

  const streamEntries = [];
  const seenUrls = {};
  for (let i = 0; i < resolved.streams.length; i += 1) {
    const stream = resolved.streams[i];
    const probe = await validateHlsPlayback(stream.url, streamHeaders, { alive: opts.alive, memo: opts.probeMemo });
    if (!probe.ok) {
      log('reject stream ' + stream.url + ': ' + probe.reason);
      continue;
    }
    if (
      targetLang === 'dub' &&
      opts.subFingerprint &&
      (stream.url === opts.subFingerprint || probe.url === opts.subFingerprint)
    ) {
      log('reject dub stream identical to sub fingerprint on ' + server.name);
      continue;
    }
    const variants = parseHlsQualityVariants(stream.url, probe.body);
    // Keep the checked default and validate the remaining ladder with two workers.
    const checkedUrl = probe.url || stream.url;
    const checked = variants.find(function (item) { return item.url === checkedUrl; });
    const playable = [checked || { url: checkedUrl, quality: stream.quality || 'Auto' }];
    const pending = opts.fingerprintOnly ? [] : variants.filter(function (item) { return item.url !== checkedUrl; });
    let nextVariant = 0;
    let qualityChecksClosed = false;
    async function checkQualityWorker() {
      while (!qualityChecksClosed && nextVariant < pending.length) {
        const variant = pending[nextVariant++];
        try {
          const result = await validateHlsPlayback(variant.url, streamHeaders, { alive: opts.alive, memo: opts.probeMemo });
          if (!qualityChecksClosed && result.ok) playable.push(variant);
        } catch (_) {}
      }
    }
    await settleWithin(Promise.all([checkQualityWorker(), checkQualityWorker()]), 3000, null);
    qualityChecksClosed = true;
    for (let index = 0; index < playable.length; index += 1) {
      const item = playable[index];
      const url = String(item.url || '').trim();
      if (!url || seenUrls[url]) continue;
      seenUrls[url] = true;
      streamEntries.push({
        label: targetLang + ' ' + String(item.quality || stream.quality || 'Auto'),
        url: url,
        height: Number((String(item.quality || '').match(/(\d{3,4})p/i) || [])[1]) || undefined,
      });
    }
    // Quality checks reuse this server's ladder; no additional server resolution.
    break;
  }

  if (!streamEntries.length) {
    throw new Error('No playable HLS manifest from ' + server.name);
  }

  streamEntries.sort(function (a, b) {
    return Number(b.height || 0) - Number(a.height || 0);
  });

  const skipData = (payload.result && payload.result.skip_data) || {};

  return {
    // Object entries preserve their individual player headers. This matters
    // when a later server is used as a fallback: the Flutter runtime can race
    // it without incorrectly reusing another host's Referer/Origin.
    url: streamEntries[0].url,
    streams: streamEntries.map(function (item) {
      return {
        label: item.label,
        url: item.url,
        height: item.height,
        headers: streamHeaders,
      };
    }),
    qualities: streamEntries,
    quality: streamEntries[0].label,
    defaultQuality: streamEntries[0].label,
    headers: streamHeaders,
    subtitles: resolved.subtitles,
    streamType: 'hls',
    lang: targetLang,
    intro: pickMarkerRange(resolved.intro, skipData.intro),
    outro: pickMarkerRange(resolved.outro, skipData.outro),
    server: server.name,
    playerUrl: resolved.playerUrl,
  };
}

async function resolveSubStreamFingerprint(base, watchUrl, dataIds, alive) {
  const serverList = await requestJson(
    absoluteUrl('/ajax/server/list?servers=' + encodeURIComponent(dataIds), base),
    { Referer: watchUrl }, alive,
  );
  if (Number(serverList.status) !== 200 || !serverList.result) return '';

  let servers = parseServersFromHtml(serverList.result, 'sub');
  servers = sortServers(dedupeServers(servers), 'sub');
  for (let i = 0; i < servers.length && i < 2; i += 1) {
    try {
      const result = await extractStreamFromServer(base, watchUrl, servers[i], 'sub', { alive: alive, fingerprintOnly: true });
      const url = result.qualities && result.qualities.length
        ? String(result.qualities[0].url || '')
        : '';
      if (url) {
        log('sub fingerprint via ' + servers[i].name + ' -> ' + url);
        return url;
      }
    } catch (error) {
      log(
        'sub fingerprint probe failed ' +
          servers[i].name +
          ': ' +
          (error && error.message ? error.message : String(error)),
      );
    }
  }
  return '';
}

async function searchViaAjax(base, keyword, maxResults) {
  const res = await request(absoluteUrl('/ajax/anime/search?keyword=' + encodeURIComponent(keyword), base), {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: base + '/',
    },
  });
  const data = res.json;
  if (!res.ok || !data || Number(data.status) !== 200 || !data.result || !data.result.html) {
    throw new Error('AJAX search unavailable');
  }
  return parseAjaxSearchCards(data.result.html, base, maxResults || SEARCH_MAX_RESULTS);
}

async function searchViaFilter(base, keyword, maxResults, pageIndex) {
  const limit = maxResults || SEARCH_MAX_RESULTS;
  const pageOffset = Math.max(0, parseInt(pageIndex, 10) || 0);
  const filterPagesPerBatch = Math.max(1, Math.ceil(limit / FILTER_PAGE_SIZE));
  const seen = {};
  const out = [];
  const filterUrl = absoluteUrl('/filter?keyword=' + encodeURIComponent(keyword), base);
  const firstHtml = await requestHtml(filterUrl, { Referer: base + '/' });
  const maxPage = parseFilterMaxPage(firstHtml);
  const startPage = pageOffset * filterPagesPerBatch + 1;
  const endPage = Math.min(maxPage, startPage + filterPagesPerBatch - 1);

  for (let page = startPage; page <= endPage; page += 1) {
    const html =
      page === 1
        ? firstHtml
        : await requestHtml(filterUrl + '&page=' + page, {
            Referer: filterUrl,
          });
    const batch = parseFilterSearchCards(html, base, limit - out.length, seen);
    for (let i = 0; i < batch.length; i += 1) {
      out.push(batch[i]);
      if (out.length >= limit) break;
    }
    if (out.length >= limit || batch.length === 0) break;
  }

  return out;
}

async function searchResults(query, page) {
  const keyword = String(query == null ? '' : query).trim();
  const pageIndex = Math.max(0, parseInt(page, 10) || 0);

  return withDomainFallback(async function (base) {
    if (!keyword) {
      if (pageIndex > 0) return [];
      const homeHtml = await requestHtml(base + '/home', { Referer: base + '/' });
      const homeResults = parseWatchCards(homeHtml, base, SEARCH_MAX_RESULTS);
      log('home browse -> ' + homeResults.length + ' results');
      return homeResults;
    }

    let results = [];
    try {
      results = await searchViaFilter(base, keyword, SEARCH_MAX_RESULTS, pageIndex);
      log('search filter "' + keyword + '" page ' + pageIndex + ' -> ' + results.length + ' results');
    } catch (filterError) {
      log(
        'filter search failed, using ajax fallback: ' +
          (filterError && filterError.message ? filterError.message : String(filterError)),
      );
      results = await searchViaAjax(base, keyword, SEARCH_MAX_RESULTS);
      log('search ajax "' + keyword + '" -> ' + results.length + ' results');
    }

    if (results.length < 10) {
      try {
        const ajaxResults = await searchViaAjax(base, keyword, SEARCH_MAX_RESULTS);
        const seen = {};
        const merged = [];
        for (let i = 0; i < results.length; i += 1) {
          seen[results[i].href] = true;
          merged.push(results[i]);
        }
        for (let j = 0; j < ajaxResults.length; j += 1) {
          if (seen[ajaxResults[j].href]) continue;
          seen[ajaxResults[j].href] = true;
          merged.push(ajaxResults[j]);
          if (merged.length >= SEARCH_MAX_RESULTS) break;
        }
        results = merged;
        log('search merged "' + keyword + '" -> ' + results.length + ' results');
      } catch (_) {}
    }

    results.sort(function (a, b) {
      return rankSearchResult(a, keyword) - rankSearchResult(b, keyword);
    });
    return results.slice(0, SEARCH_MAX_RESULTS);
  });
}

async function extractDetails(urlOrId) {
  const raw = String(urlOrId || '').trim();
  if (!raw) throw new Error('Missing series id');

  const slug = normalizeSlug(raw);
  if (!slug) throw new Error('Missing series slug');

  return withDomainFallback(async function (base) {
    const watchUrl = absoluteUrl('/watch/' + slug, base);
    const html = await requestHtml(watchUrl, { Referer: base + '/' });
    const details = parseDetailsFromHtml(html, base, slug);
    log('details ' + details.title + ' (' + details.showId + ')');
    return details;
  });
}

// Private metadata trial. Verified Anikoto original-anime identity on 2026-09-07.
// Source: https://www.animefillerlist.com/shows/one-piece (through episode 1168).
// No runtime lookup, episode title changes, or playback-route changes.
function annotateAnikotoFillers(episodes, showId, slug) {
  if (String(showId) !== '1642' || slug !== 'one-piece-odmau') return episodes;
  const seen = {};
  for (let i = 0; i < episodes.length; i += 1) {
    const n = episodes[i].number;
    if (!Number.isInteger(n) || n < 1 || seen[n]) return episodes;
    seen[n] = true;
  }
  const statuses = {};
  const ranges = {
    filler: '54-60,98-99,102,131-143,196-206,220-225,279-283,291-292,303,317-319,326-336,382-384,406-407,426-429,457-458,492,542,575-578,590,626-627,747-750,780-782,895-896,907,1029-1030',
    mixed: '45-47,61,68-69,101,226,354,421,489,520,574,625,628,633,653,657,679,690,731,738,751,777-778,789,803,807,878-879,881-885,887-890,924,988-989,991',
  };
  Object.keys(ranges).forEach(function (status) {
    ranges[status].split(',').forEach(function (range) {
      const bounds = range.split('-').map(Number);
      for (let n = bounds[0]; n <= bounds[bounds.length - 1]; n += 1) {
        statuses[n] = status;
      }
    });
  });
  return episodes.map(function (episode) {
    const status = statuses[episode.number];
    if (!status || episode.fillerStatus != null) return episode;
    return Object.assign({}, episode, { fillerStatus: status });
  });
}

async function extractEpisodes(seriesId) {
  const parsed = parseEpisodeHref(seriesId);
  const slug = normalizeSlug(parsed.slug || seriesId);
  if (!slug) throw new Error('Missing series slug');

  return withDomainFallback(async function (base) {
    const watchUrl = absoluteUrl('/watch/' + slug, base);
    const watchHtml = await requestHtml(watchUrl, { Referer: base + '/' });
    const showId = parsed.showId || parseShowIdFromHtml(watchHtml);
    if (!showId) throw new Error('Could not resolve show id');

    const data = await requestJson(absoluteUrl('/ajax/episode/list/' + showId, base), {
      Referer: watchUrl,
    });
    if (Number(data.status) !== 200 || !data.result) {
      throw new Error(data.message || 'Episode list unavailable');
    }

    const episodes = parseEpisodesFromHtml(data.result, showId, slug, base);
    log('episodes ' + slug + ' -> ' + episodes.length);
    const result = episodes.map(function (episode) {
      return {
        number: episode.number,
        href: episode.href,
        title: episode.title,
        season: episode.season,
        subAvailable: episode.subAvailable,
        dubAvailable: episode.dubAvailable,
      };
    });
    return annotateAnikotoFillers(result, showId, slug);
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
    const e = function (c) {
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

function fallbackSubtitleEntries(data, embedUrl) {
  const params = {};
  const query = String(embedUrl || '').split('?').slice(1).join('?').split('#')[0];
  query.split('&').forEach(function (part) {
    const at = part.indexOf('=');
    if (at < 0) return;
    try {
      params[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(part.slice(at + 1));
    } catch (_) {}
  });
  const tracks = [];
  const seen = {};
  function add(file, label, language) {
    // Opaque provider tokens are not relative subtitle paths.
    if (!/^https?:\/\//i.test(String(file || '')) || seen[file]) return;
    seen[file] = true;
    tracks.push({ file: file, url: file, label: label || 'Subtitles',
      lang: subtitleLanguageTag(language || label || 'und'), kind: 'captions', headers: { 'User-Agent': USER_AGENT } });
  }
  Object.keys(params).forEach(function (key) {
    const match = key.match(/^caption_(\d+)$/);
    if (match) {
      const label = params['sub_' + match[1]] || 'Subtitles';
      add(params[key], label, subtitleLanguageTag(label));
      return;
    }
    const fileMatch = key.match(/^c(\d+)_file$/i);
    if (fileMatch) {
      const label = params['c' + fileMatch[1] + '_label'] || 'Subtitles';
      add(params[key], label, subtitleLanguageTag(label));
      return;
    }
    if (key === 'sub') {
      add(params[key], 'English', 'en');
    }
  });
  (Array.isArray(data && data.subtitles) ? data.subtitles : []).forEach(function (track) {
    if (!track) return;
    add(track.file || track.url, track.label || track.language, track.lang || track.language);
  });
  return tracks;
}

function exactFallbackMatch(results, title, catalogueId) {
  if (!Array.isArray(results)) return null;
  if (catalogueId) {
    const byId = results.filter(function (item) {
      return item && String(item.anilistId || '') === String(catalogueId);
    });
    return byId.length === 1 ? byId[0] : null;
  }
  const wanted = normalizeSearchTerm(title);
  if (!wanted || !Array.isArray(results)) return null;
  const matches = results.filter(function (item) {
    if (!item || !item.title) return false;
    const titles = typeof item.title === 'string' ? [item.title] :
      [item.title.english, item.title.romaji, item.title.userPreferred];
    return titles.some(function (value) { return value && normalizeSearchTerm(value) === wanted; });
  });
  // An ambiguous match is not permission to choose the first search result.
  return matches.length === 1 ? matches[0] : null;
}

function fallbackEmbeds(data, preferCaptions) {
  const seen = {};
  function entryUrl(entry) {
    if (typeof entry === 'string') return entry;
    if (!entry) return '';
    const sourceUrl = String(entry.url || '').trim();
    return /^https?:\/\//i.test(sourceUrl) ? sourceUrl : entry.embedUrl;
  }
  function rank(url) {
    let value = /^https?:\/\/(?:www\.)?(?:otakuhg\.site|otakuvid\.online|playmogo\.com)\//i.test(url) ? 0 : 1;
    if (preferCaptions && /(?:[?&](?:sub|caption_\d+|c\d+_file)=|\/softsub\b)/i.test(url)) value -= 2;
    return value;
  }
  const sourceEntries = Array.isArray(data && data.sources) ? data.sources : [];
  return [].concat(data && data.embeds || [], data && data.embedOptions || [], sourceEntries)
    .map(entryUrl)
    .filter(function (url) {
      if (!/^https?:\/\//i.test(String(url || '')) || seen[url]) return false;
      seen[url] = true;
      return true;
    })
    .sort(function (a, b) { return rank(a) - rank(b); });
}

function fallbackResponseMatches(data, slug, episode, lang) {
  if (!data || String(data.slug || '') !== String(slug)) return false;
  if (Number(data.number) !== Number(episode)) return false;
  return String(data.subType || '').toLowerCase() === lang;
}

async function resolveFallbackPlayer(embedUrl, data, alive) {
  if (!alive()) return null;
  const origin = originFromUrl(embedUrl);
  const echo = String(embedUrl).match(/^https:\/\/play\.echovideo\.ru\/(embed-[a-z0-9-]+)\/([^/?#]+)(?:[?#]|$)/i);
  let entries = [];
  let subtitles = fallbackSubtitleEntries(data, embedUrl);
  let playerData = null;
  let name = 'Direct';
  const headers = { 'User-Agent': USER_AGENT, Referer: embedUrl, Origin: origin };
  if (echo) {
    name = 'EchoVideo';
    playerData = await requestJson(origin + '/' + echo[1] + '/getSources?id=' + encodeURIComponent(echo[2]), headers, alive);
    if (!alive()) return null;
    const raw = playerData.sources;
    entries = normalizeSourceEntries(playerData);
    if (raw && !Array.isArray(raw) && typeof raw === 'object' && !entries.length) {
      ['HQ', 'HD', 'SD'].forEach(function (quality) {
        [].concat(raw[quality] || []).forEach(function (url) {
          if (typeof url === 'string') entries.push({ url: url, quality: quality });
        });
      });
    }
    subtitles = normalizeSubtitleEntries(playerData, origin).concat(subtitles);
  } else if (/\.m3u8(?:[?#]|$)/i.test(embedUrl)) {
    headers.Referer = 'https://anikage.cc/';
    headers.Origin = 'https://anikage.cc';
    entries = [{ url: embedUrl, quality: 'Auto' }];
  } else if (/^https?:\/\/(?:www\.)?(?:otakuhg\.site|otakuvid\.online|playmogo\.com|[^/]+\.(?:vivi|bibi)\.[a-z]+)\//i.test(embedUrl)) {
    name = 'Otaku';
    const html = await requestHtml(embedUrl, { 'User-Agent': USER_AGENT, Referer: 'https://anikage.cc/' }, alive);
    if (!alive()) return null;
    const unpacked = unpackPacker(html) || html;
    const match = unpacked.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
    if (match) entries = [{ url: match[0], quality: 'Auto' }];
  } else {
    return null;
  }
  for (let i = 0; i < entries.length && i < 3 && alive(); i += 1) {
    const url = String(entries[i].url || '');
    if (!/^https?:\/\//i.test(url)) continue;
    const probe = await validateHlsPlayback(url, headers, { alive: alive, maxBytesHint: echo ? 4194304 : undefined });
    if (!probe.ok || !alive()) continue;
    const variants = parseHlsQualityVariants(url, probe.body);
    const selected = variants.find(function (variant) { return variant.url === probe.url; });
    const qualities = [{ label: selected ? selected.quality : (entries[i].quality || 'Auto'), url: probe.url || url, headers: headers }];
    // Validate every additional quality before exposing it; no guessed ladder.
    for (let v = 0; v < variants.length && v < 4 && alive(); v += 1) {
      if (qualities.some(function (quality) { return quality.url === variants[v].url; })) continue;
      const checked = await validateHlsPlayback(variants[v].url, headers, { alive: alive, maxBytesHint: echo ? 4194304 : undefined });
      if (checked.ok && alive()) qualities.push({ label: variants[v].quality, url: checked.url || variants[v].url, headers: headers });
    }
    const seen = {};
    return { name: name, url: probe.url || url, headers: headers, qualities: qualities, brokenRefs: probe.brokenRefs || 0,
      subtitles: subtitles.filter(function (track) {
        const key = track.url || track.file;
        if (!key || seen[key]) return false;
        seen[key] = true;
        return true;
      }),
      intro: pickMarkerRange(playerData && playerData.intro, data.intro),
      outro: pickMarkerRange(playerData && playerData.outro, data.outro) };
  }
  return null;
}

function fallbackPlaybackResult(routes, targetLang) {
  if (!routes.length) return null;
  const primary = routes[0];
  const qualities = primary.qualities || [{ label: 'Auto', url: primary.url, headers: primary.headers }];
  const streams = qualities.map(function (quality) {
    return Object.assign({}, quality, { quality: quality.label, lang: targetLang,
      headers: quality.headers || primary.headers });
  });
  routes.slice(1).forEach(function (route) {
    streams.push({ quality: 'Auto Backup (' + route.name + ')', label: 'Auto Backup (' + route.name + ')',
      url: route.url, headers: route.headers, lang: targetLang, subtitles: route.subtitles,
      intro: route.intro, outro: route.outro });
  });
  return { url: primary.url, headers: primary.headers, streamType: 'hls', lang: targetLang,
    quality: qualities[0].label, server: primary.name, qualities: qualities, streams: streams,
    servers: routes, subtitles: primary.subtitles || [], intro: primary.intro, outro: primary.outro,
    introStartSeconds: primary.intro ? primary.intro.start : 0,
    introEndSeconds: primary.intro ? primary.intro.end : 0,
    outroStartSeconds: primary.outro ? primary.outro.start : 0,
    outroEndSeconds: primary.outro ? primary.outro.end : 0 };
}

function catalogueCaptions(meta, lang) {
  const raw = meta && meta.captions;
  const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw[lang]) ? raw[lang] : []);
  const languageNames = SUBTITLE_LANGUAGE_CODES;
  const tracks = rows.filter(function (row) { return row && typeof row === 'object'; }).map(function (row) {
    const label = String(row.label || row.language || row.lang || 'Subtitles');
    const named = languageNames[label.toLowerCase().split(/[ (]/)[0]];
    return { file: row.src || row.url || row.file, label: label, kind: 'captions',
      lang: named || row.lang || row.language || 'und', default: row.default === true };
  });
  return normalizeSubtitleEntries({ tracks: tracks }, 'https://vidhawk.buzz');
}

async function resolveCatalogueFallback(catalogueId, malId, episode, lang, parentAlive) {
  const anilist = /^\d+$/.test(String(catalogueId || '')) ? String(catalogueId) : '';
  const mal = /^\d+$/.test(String(malId || '')) ? String(malId) : '';
  if ((!anilist && !mal) || !Number.isInteger(Number(episode)) || Number(episode) < 1) return null;
  if (lang !== 'sub' && lang !== 'dub') return null;
  const origin = 'https://vidhawk.buzz';
  const idQuery = anilist ? 'anilistId=' + anilist : 'malId=' + mal;
  const embed = origin + '/embed/ani/' + (anilist || mal) + '/' + episode + '/' + lang;
  const headers = { 'User-Agent': USER_AGENT, Referer: embed, Origin: origin };
  const deadline = Date.now() + 8000;
  let closed = false;
  const routes = [];
  function alive() { return !closed && Date.now() < deadline && (!parentAlive || parentAlive()); }
  async function resolveServer(server) {
    try {
      if (!alive()) return;
      const resolved = await requestJson(origin + '/api/stream/resolve?' + idQuery +
        '&episode=' + episode + '&audio=' + lang + '&parentHost=anicrowd.xyz&fast=1&server=' + server, headers, alive);
      if (!resolved.ticket || !alive()) return;
      const meta = await requestJson(origin + '/api/play?t=' + encodeURIComponent(resolved.ticket), headers, alive);
      if (!alive()) return;
      const track = (Array.isArray(meta.tracks) ? meta.tracks : []).find(function (row) {
        return row && row.id === lang && /^https?:\/\//i.test(String(row.src || ''));
      });
      if (!track) return;
      const probe = await validateHlsPlayback(track.src, headers, { alive: alive });
      if (!probe.ok || !alive()) return;
      const variants = parseHlsQualityVariants(track.src, probe.body);
      const selected = variants.find(function (row) { return row.url === probe.url; });
      const qualities = [{ label: selected ? selected.quality : 'Auto', url: probe.url || track.src, headers: headers }];
      // Keep the usable route even if a secondary quality is slow.
      const route = { name: 'Vidhawk ' + server, url: probe.url || track.src, headers: headers, lang: lang,
        qualities: qualities, subtitles: catalogueCaptions(meta, lang),
        intro: normalizeMarkerRange(meta.intro), outro: normalizeMarkerRange(meta.outro) };
      if (!routes.some(function (row) { return row.url === route.url; })) routes.push(route);
      for (let i = 0; i < variants.length && i < 4 && alive(); i += 1) {
        if (qualities.some(function (row) { return row.url === variants[i].url; })) continue;
        const checked = await validateHlsPlayback(variants[i].url, headers, { alive: alive });
        if (checked.ok && alive()) qualities.push({ label: variants[i].quality, url: checked.url || variants[i].url, headers: headers });
      }
    } catch (_) {}
  }
  await settleWithin(Promise.all(['flow', 'zuri'].map(resolveServer)), 8000, null);
  closed = true;
  routes.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  return fallbackPlaybackResult(routes, lang);
}

async function verifiedFallbackAlias(results, title, alias, catalogueId, alive) {
  // A known conflicting ID must never be overridden by an alias.
  if (catalogueId || !Array.isArray(results) || results.length > 20) return null;
  const wanted = [title, alias].filter(Boolean).map(normalizeSearchTerm);
  const matches = [];
  const seen = {};
  for (let i = 0; i < results.length; i += 1) {
    const item = results[i];
    if (!item || !item.slug || seen[item.slug]) continue;
    seen[item.slug] = true;
    let detail;
    try { detail = await requestJson('https://anikage.cc/api/media/anime/' + encodeURIComponent(item.slug), {}, alive); }
    catch (_) { return null; }
    const anime = detail && detail.anime;
    if (!anime || String(anime.anilistId || '') !== String(item.anilistId || '')) return null;
    const names = [].concat(anime.synonyms || [], (anime.malTitles || []).map(function (entry) { return entry.title; }));
    if (names.some(function (name) { return wanted.indexOf(normalizeSearchTerm(name)) !== -1; })) matches.push(item);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function resolveAnimeFallbackStream(query, epNum, lang, catalogueId, alias, parentAlive) {
  try {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return null;
    const queries = [cleanQuery];
    if (alias && normalizeSearchTerm(alias) !== normalizeSearchTerm(cleanQuery)) queries.push(alias);
    const slugKey = normalizeSearchTerm(cleanQuery) + '|' + normalizeSearchTerm(alias || '') + '|' + String(catalogueId || '');
    let slug = fallbackCacheGet(FALLBACK_SLUG_CACHE, slugKey);
    if (!slug) {
      let matched = null;
      let lastResults = [];
      for (let q = 0; q < queries.length && !matched; q += 1) {
        const searchData = await requestJson('https://anikage.cc/api/media/anime/browse?q=' + encodeURIComponent(queries[q]), {}, parentAlive);
        lastResults = (searchData && searchData.data) || [];
        matched = exactFallbackMatch(lastResults, queries[q], catalogueId);
      }
      if (!matched) matched = await verifiedFallbackAlias(lastResults, cleanQuery, alias, catalogueId, parentAlive);
      if (!matched) return null;
      slug = matched.slug || matched.id;
      if (!slug) return null;
      fallbackCacheSet(FALLBACK_SLUG_CACHE, slugKey, slug, FALLBACK_SLUG_TTL);
    }

    const targetLang = String(lang || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub';
    const routeKey = slug + '|' + String(epNum) + '|' + targetLang;
    const cachedRoutes = fallbackCacheGet(FALLBACK_ROUTE_CACHE, routeKey);
    if (cachedRoutes && cachedRoutes.length) return fallbackPlaybackResult(cachedRoutes, targetLang);
    const providers = ['neko', 'wave', 'koto', 'zen', 'dib', 'kiwi', 'megg'];

    const routes = [];
    const seenRouteUrls = {};
    const routeOrder = {};
    const deadline = Date.now() + 20000;
    let firstRouteAt = 0;
    let closed = false;
    let backupProvidersRemaining = 2;
    function remaining() {
      if (parentAlive && !parentAlive()) return 0;
      return Math.max(0, Math.min(deadline, firstRouteAt ? firstRouteAt + 4000 : deadline) - Date.now());
    }
    for (let pIdx = 0; pIdx < providers.length && routes.length < FALLBACK_MAX_ROUTES; pIdx += 1) {
      if (!remaining()) break;
      // Once playback is available, do not spend the provider's request quota
      // walking every empty backup. Full fallback remains available on failure.
      if (routes.length && backupProvidersRemaining-- <= 0) break;
      const provider = providers[pIdx];
      try {
        const queryUrl = 'https://anikage.cc/api/media/anime/' + encodeURIComponent(slug) + '/episodes/' + epNum + '/sources?provider=' + provider + '&lang=' + targetLang;
        const data = await settleWithin(requestJson(queryUrl, { Referer: 'https://anikage.cc/anime/watch/' + slug }, parentAlive), Math.min(4000, remaining()), null);
        if (!fallbackResponseMatches(data, slug, epNum, targetLang)) continue;

        const embeds = fallbackEmbeds(data, targetLang === 'sub');

        async function resolveFallbackEmbed(emb) {
          if (closed || !remaining()) return null;
          try {
            const route = await resolveFallbackPlayer(emb, data, function () { return !closed && remaining() > 0; });
            if (!route || closed || !remaining()) return null;
            route.name += ' (' + provider + ')';
            route.lang = targetLang;
            return route;
          } catch (_) {
            return null;
          }
        }

        // Resolve a small batch concurrently to keep fallback startup within
        // the module budget without launching an unbounded provider scan.
        for (let eIdx = 0; eIdx < embeds.length && eIdx < FALLBACK_MAX_EMBEDS_PER_PROVIDER && routes.length < FALLBACK_MAX_ROUTES && remaining(); eIdx += 2) {
          const batch = embeds.slice(eIdx, Math.min(eIdx + 2, FALLBACK_MAX_EMBEDS_PER_PROVIDER));
          // Collect completed routes independently: a stalled sibling must not
          // discard a checked route or mutate results after this call returns.
          await settleWithin(Promise.all(batch.map(async function (emb, batchIndex) {
            const candidate = await resolveFallbackEmbed(emb);
            if (!candidate || closed || !remaining() || routes.length >= FALLBACK_MAX_ROUTES || seenRouteUrls[candidate.url]) return;
            seenRouteUrls[candidate.url] = true;
            routeOrder[candidate.url] = pIdx * FALLBACK_MAX_EMBEDS_PER_PROVIDER + eIdx + batchIndex;
            const duplicateName = routes.filter(function (route) { return route.name.indexOf(candidate.name) === 0; }).length;
            if (duplicateName > 0) candidate.name += ' #' + (duplicateName + 1);
            routes.push(candidate);
            if (!firstRouteAt) firstRouteAt = Date.now();
          })), Math.min(7000, remaining()), null);
        }
      } catch (e) {
        if (/HTTP 429|too many requests|rate.?limit/i.test(String(e && e.message || ''))) {
          FALLBACK_RATE_LIMITED = true;
          log('anikage fallback rate limited (HTTP 429); stopping provider sweep');
          break;
        }
      }
    }
    closed = true;
    routes.sort(function (a, b) {
      // Prefer routes the released session proxy can serve end-to-end (no .html/.mp4/.m4s/init refs).
      return (a.brokenRefs === 0 ? 0 : 1) - (b.brokenRefs === 0 ? 0 : 1) || (routeOrder[a.url] - routeOrder[b.url]);
    });
    if (routes.length) fallbackCacheSet(FALLBACK_ROUTE_CACHE, routeKey, routes, FALLBACK_ROUTE_TTL);

    return fallbackPlaybackResult(routes, targetLang);
  } catch (e) {
    log('fallback resolver error: ' + (e && e.message ? e.message : e));
  }
  return null;
}

async function resolveStreamUrl(episodeHref, lang, alive) {
  let targetLang = normalizeLang(lang);
  const context = await resolveEpisodeContext(episodeHref, alive);
  const dataIds = context.episode.dataIds;

  if (!lang || lang === 'auto') {
    targetLang = context.episode.subAvailable ? 'sub' : (context.episode.dubAvailable ? 'dub' : 'sub');
  }

  if (targetLang === 'dub' && !context.episode.dubAvailable) {
    throw new Error('Dub is not available for this episode');
  }
  if (targetLang === 'sub' && !context.episode.subAvailable) {
    throw new Error('Sub is not available for this episode');
  }

  let servers = [];
  let lastError = null;
  // Server discovery can fail independently of the episode catalogue. Preserve
  // its error, but still reach the exact-identity fallback below.
  try {
    if (!dataIds) throw new Error('Episode is missing server token');
    const serverList = await requestJson(
      absoluteUrl('/ajax/server/list?servers=' + encodeURIComponent(dataIds), context.base),
      { Referer: context.watchUrl }, alive,
    );
    if (Number(serverList.status) !== 200 || !serverList.result) {
      throw new Error(serverList.message || 'Server list unavailable');
    }
    servers = sortServers(dedupeServers(parseServersFromHtml(serverList.result, targetLang)), targetLang);
    if (!servers.length) throw new Error('No servers available for ' + targetLang);
  } catch (error) {
    lastError = error;
    log('server list unavailable; checking exact-episode fallback');
  }

  let subFingerprint = '';
  if (targetLang === 'dub' && servers.length) {
    let fingerprintClosed = false;
    const fingerprintDeadline = Date.now() + 3000;
    function fingerprintAlive() { return !fingerprintClosed && Date.now() < fingerprintDeadline && (!alive || alive()); }
    try {
      subFingerprint = await settleWithin(resolveSubStreamFingerprint(context.base, context.watchUrl, dataIds, fingerprintAlive), 3000, '');
    } catch (_) {} finally { fingerprintClosed = true; }
  }

  let primary = null;
  const combinedStreams = [];
  const serverChoices = [];
  const seenStreamUrls = {};
  const seenPlayers = {};
  const probeMemo = {};
  const primaryDeadline = Date.now() + 10000;
  function primaryAlive() { return (!alive || alive()) && Date.now() < primaryDeadline; }
  for (let i = 0; i < servers.length && primaryAlive(); i += 1) {
    try {
      const result = await settleWithin(extractStreamFromServer(
        context.base,
        context.watchUrl,
        servers[i],
        targetLang,
        { subFingerprint: subFingerprint, seenPlayers: seenPlayers, alive: primaryAlive, probeMemo: probeMemo },
      ), Math.max(1, primaryDeadline - Date.now()), null);
      if (!result) break;
      const entries = Array.isArray(result.streams) ? result.streams : [];
      serverChoices.push({
        name: result.server,
        url: result.url,
        lang: targetLang,
        headers: result.headers || {},
        subtitles: result.subtitles || [],
        intro: result.intro,
        outro: result.outro,
      });
      if (!primary) {
        primary = result;
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          const url = String(entry && entry.url ? entry.url : '').trim();
          if (!url || seenStreamUrls[url]) continue;
          seenStreamUrls[url] = true;
          combinedStreams.push(entry);
        }
        continue;
      }

      // Preserve each independently checked server as a transport fallback.
      const fallback = entries[0];
      const fallbackUrl = String(fallback && fallback.url ? fallback.url : '').trim();
      if (fallbackUrl && !seenStreamUrls[fallbackUrl]) {
        seenStreamUrls[fallbackUrl] = true;
        combinedStreams.push({
          label: targetLang + ' Backup (' + result.server + ')',
          url: fallbackUrl,
          headers: fallback.headers || result.headers || {},
          lang: targetLang,
          subtitles: result.subtitles || [],
          intro: result.intro,
          outro: result.outro,
        });
      }
      log(
        'playback fallback [' +
          targetLang +
          '] via ' +
          result.server +
          ' (' +
          fallbackUrl +
          ')',
      );
    } catch (error) {
      lastError = error;
      log(
        'server failed ' +
          servers[i].name +
          ': ' +
          (error && error.message ? error.message : String(error)),
      );
    }
  }

  if (!primary) {
    log('primary servers failed for ' + (context.slug || episodeHref) + ', trying multi-provider fallback...');
    const animeTitle = context.title;
    const epNumber = context.episode && context.episode.number ? context.episode.number : 1;
    const directFallback = await resolveCatalogueFallback(context.catalogueId, context.malId, epNumber, targetLang, alive);
    if (directFallback) return directFallback;
    const fallbackRes = await resolveAnimeFallbackStream(animeTitle, epNumber, targetLang, context.catalogueId, context.alias, alive);
    if (fallbackRes && fallbackRes.url) {
      log('playback ready [' + targetLang + '] via fallback resolver: ' + fallbackRes.url);
      return fallbackRes;
    }
    throw lastError || new Error('All stream servers failed');
  }

  primary.streams = combinedStreams;
  primary.servers = serverChoices;
  log(
    'playback ready [' +
      targetLang +
      '] via ' +
      primary.server +
      ' with ' +
      Math.max(0, combinedStreams.length - primary.qualities.length) +
      ' fallback route(s)',
  );
  return primary;
}

async function extractStreamUrl(episodeHref, lang) {
  FALLBACK_RATE_LIMITED = false;
  const deadline = Date.now() + 26000;
  let closed = false;
  function alive() { return !closed && Date.now() < deadline; }
  try {
    const result = await settleWithin(resolveStreamUrl(episodeHref, lang, alive), 26000, null);
    if (result) return result;
    throw new Error('Playback lookup timed out. Please retry shortly.');
  } catch (error) {
    // Return the existing structured-error contract, avoiding the old app's
    // broken thrown-error wrapper without changing any app code.
    const raw = String(error && error.message || 'No playable route available');
    const unavailable = /(?:Sub|Dub) is not available/.test(raw);
    const rateLimited = FALLBACK_RATE_LIMITED;
    const message = unavailable
      ? raw
      : rateLimited
        ? 'The backup source is rate-limiting this network right now. Wait about a minute, then retry.'
        : 'AniKoto could not find a working video for this episode. Please retry shortly or choose another source.';
    log(raw + (rateLimited ? ' [fallback rate limited]' : ''));
    return { streams: [], subtitles: [], error: { code: unavailable ? 'language_unavailable' : rateLimited ? 'source_rate_limited' : 'anikoto_no_playable_route', message: message } };
  } finally { closed = true; }
}

async function discoveryHome() {
  return withDomainFallback(async function (base) {
    const homeHtml = await requestHtml(base + '/home', { Referer: base + '/' });
    const allCards = parseWatchCards(homeHtml, base, 100);

    if (!allCards.length) {
      throw new Error('Home page returned no cards');
    }

    const sections = [];
    const seen = {};
    let cardIndex = 0;

    // Spotlight section (hero style, ~6 items)
    const spotlightCards = [];
    while (spotlightCards.length < 6 && cardIndex < allCards.length) {
      const card = allCards[cardIndex];
      const href = card.href;
      if (!seen[href]) {
        seen[href] = true;
        spotlightCards.push(card);
      }
      cardIndex += 1;
    }

    if (spotlightCards.length > 0) {
      sections.push({
        id: 'spotlight',
        title: 'Spotlight',
        style: 'hero',
        items: spotlightCards.slice(0, 8),
      });
    }

    // Trending section (top10 style, exactly 10 items)
    const trendingCards = [];
    while (trendingCards.length < 10 && cardIndex < allCards.length) {
      const card = allCards[cardIndex];
      const href = card.href;
      if (!seen[href]) {
        seen[href] = true;
        trendingCards.push(card);
      }
      cardIndex += 1;
    }

    if (trendingCards.length > 0) {
      sections.push({
        id: 'trending',
        title: 'Trending Now',
        style: 'top10',
        items: trendingCards.slice(0, 10),
        viewAll: {
          mode: 'feed',
          feedId: 'trending',
        },
      });
    }

    // Latest section (poster style, remaining cards with feed viewAll)
    const latestCards = [];
    while (latestCards.length < 10 && cardIndex < allCards.length) {
      const card = allCards[cardIndex];
      const href = card.href;
      if (!seen[href]) {
        seen[href] = true;
        latestCards.push(card);
      }
      cardIndex += 1;
    }

    if (latestCards.length > 0) {
      sections.push({
        id: 'latest',
        title: 'Latest Anime',
        style: 'poster',
        items: latestCards.slice(0, 30),
        viewAll: {
          mode: 'feed',
          feedId: 'latest',
        },
      });
    }

    // Synthetic feed-backed "All Anime" row from /filter
    try {
      const filterHtml = await requestHtml(base + '/filter?keyword=', { Referer: base + '/' });
      const filterCards = parseFilterSearchCards(filterHtml, base, 30, seen);

      if (filterCards.length > 0) {
        sections.push({
          id: 'all_anime',
          title: 'All Anime',
          style: 'poster',
          items: filterCards.slice(0, 30),
          viewAll: {
            mode: 'feed',
            feedId: 'all',
          },
        });
      }
    } catch (_) {
      // Filter fetch is optional, continue with existing sections
    }

    if (sections.length === 0) {
      throw new Error('No valid discovery sections generated');
    }

    log('discovery home -> ' + sections.length + ' sections');
    return { sections: sections };
  });
}

async function discoveryFeed(feedId, page) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);

  let sort = 'default';
  let keyword = '';
  const fid = String(feedId || '').toLowerCase().trim();
  switch (fid) {
    case 'trending':
    case 'popular':
      sort = 'most-viewed';
      break;
    case 'latest':
      sort = 'latest-updated';
      break;
    case 'spotlight':
      sort = 'score';
      break;
    case 'all':
    case 'all_anime':
    case '':
      sort = 'default';
      break;
    default:
      sort = 'default';
      break;
  }

  return withDomainFallback(async function (base) {
    const filterUrl = absoluteUrl('/filter?keyword=' + encodeURIComponent(keyword) + '&sort=' + sort, base);
    const pageUrl = pageNum === 1 ? filterUrl : filterUrl + '&page=' + pageNum;

    const html = await requestHtml(pageUrl, { Referer: base + '/' });
    const items = parseFilterSearchCards(html, base, 50);

    // Determine hasMore: try to parse max page from pagination
    const maxPage = parseFilterMaxPage(html);
    const hasMore = pageNum < maxPage;

    // Fallback: if no pagination found but items returned, assume more pages exist
    const hasMoreFallback = items.length > 0;

    log('discovery feed "' + feedId + '" page ' + pageNum + ' -> ' + items.length + ' items, hasMore=' + (hasMore || hasMoreFallback));

    return {
      items: items,
      page: pageNum,
      hasMore: hasMore || hasMoreFallback,
    };
  });
}

globalThis.searchResults = searchResults;
globalThis.extractDetails = extractDetails;
globalThis.extractEpisodes = extractEpisodes;
globalThis.extractStreamUrl = extractStreamUrl;
globalThis.discoveryHome = discoveryHome;
globalThis.discoveryFeed = discoveryFeed;
globalThis.annotateAnikotoFillers = annotateAnikotoFillers;
