const MODULE_NAME = 'AnimeHeavenV301';
const BASE_URL = 'https://animeheaven.me';
const SEARCH_ENDPOINT = BASE_URL + '/fastsearch.php?xhr=1&s=';
const GATE_ENDPOINT = BASE_URL + '/gate.php';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function log(message) {
  try {
    console.log('[' + MODULE_NAME + '] ' + String(message || ''));
  } catch (_) {}
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '-')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(text) {
  return decodeHtml(String(text || '').replace(/<[^>]+>/g, ' '));
}

function normalizeTitle(value) {
  return decodeHtml(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rankSearchResult(item, query) {
  const title = normalizeTitle(item && item.title);
  const term = normalizeTitle(query);
  if (!term) return 50;
  if (title === term) return 0;
  if (title.startsWith(term + ' ')) return 10;
  if (title.includes(term)) return 20;
  return 50;
}

function toAbsoluteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('//')) return 'https:' + raw;
  if (raw.startsWith('/')) return BASE_URL + raw;
  return BASE_URL + '/' + raw;
}

function safeJsonParse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function request(url, options) {
  const cfg = options || {};
  const method = cfg.method || 'GET';
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Referer': BASE_URL + '/',
    ...(cfg.headers || {}),
  };
  const body = cfg.body == null ? null : cfg.body;

  try {
    if (typeof fetchv2 === 'function') {
      const res = await fetchv2(url, headers, method, body, { timeoutMs: 10000 });
      const status = Number((res && res.status) || 0);

      let textBody = '';
      if (res && typeof res.text === 'function') {
        try {
          textBody = await res.text();
        } catch (_) {
          textBody = '';
        }
      } else if (res && typeof res.body === 'string') {
        textBody = res.body;
      }

      let jsonBody = null;
      if (!textBody && res && typeof res.json === 'function') {
        try {
          jsonBody = await res.json();
          textBody = JSON.stringify(jsonBody);
        } catch (_) {
          jsonBody = null;
        }
      }

      return {
        ok: !!(res && (res.ok === true || (status >= 200 && status < 300))),
        status,
        body: textBody,
        json: jsonBody || safeJsonParse(textBody),
        headers: (res && res.headers) || {},
        contentType: (res && res.contentType) || ((res && res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || ''),
        bodyDropped: !!(res && res.bodyDropped === true),
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
        headers: Object.fromEntries(res.headers.entries()),
        contentType: res.headers.get('content-type') || '',
        bodyDropped: false,
      };
    }

    return { ok: false, status: 0, body: '', json: null };
  } catch (error) {
    log('request error: ' + (error && error.message ? error.message : String(error)));
    return { ok: false, status: 0, body: '', json: null };
  }
}

function parseSearchItems(html) {
  const out = [];
  const seen = new Set();
  const cardPattern = /<a class='ac' href='([^']+)'>[\s\S]*?<img class='coverimg' src='([^']+)'[^>]*>[\s\S]*?<div class='fastname'>([\s\S]*?)<\/div>[\s\S]*?<\/a>/gi;

  let match;
  while ((match = cardPattern.exec(html)) !== null) {
    const href = toAbsoluteUrl(match[1]);
    if (!href || seen.has(href)) continue;

    const image = toAbsoluteUrl(match[2]);
    const title = stripTags(match[3]);
    if (!title) continue;

    out.push({ href, image, title });
    seen.add(href);

    if (out.length >= 30) break;
  }

  // The site now uses the same `similarimg` cards for its full search page as
  // it does for related titles. Keep the older fast-search parser above, then
  // accept this current shape as a fallback.
  const similarPattern = /<a\s+href=['\"]([^'\"]*anime\.php\?[^'\"]+)['\"][^>]*>\s*<img[^>]*class=['\"][^'\"]*coverimg[^'\"]*['\"][^>]*src=['\"]([^'\"]+)['\"][^>]*alt=['\"]([^'\"]+)['\"][^>]*>/gi;
  while ((match = similarPattern.exec(html)) !== null) {
    const href = toAbsoluteUrl(match[1]);
    const title = stripTags(match[3]);
    if (!href || !title || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, image: toAbsoluteUrl(match[2]), title });
    if (out.length >= 30) break;
  }
  return out;
}


function parseHomeItems(html) {
  const out = [];
  const seen = new Set();
  // The three carousel banners are decorative. The actual browse catalogue is
  // rendered as hundreds of `coverimg` chart cards, with attribute order that
  // can change between deploys. Parse the link and image separately rather
  // than depending on one exact HTML shape.
  const pattern = /<a\b[^>]*href=['"]([^'"]*anime\.php\?[^'"]+)['"][^>]*>\s*<img\b([^>]*)>/gi;
  let match;
  while ((match = pattern.exec(String(html || ''))) !== null) {
    const href = toAbsoluteUrl(match[1]);
    const attributes = String(match[2] || '');
    if (!/\b(?:coverimg|bannerimg)\b/i.test(attributes) || !href || seen.has(href)) continue;
    const srcMatch = attributes.match(/\b(?:src|data-src|data-original)=['"]([^'"]+)['"]/i);
    const altMatch = attributes.match(/\balt=['"]([^'"]+)['"]/i);
    const title = stripTags(altMatch ? altMatch[1] : '');
    if (!srcMatch || !title) continue;
    seen.add(href);
    out.push({
      href,
      image: toAbsoluteUrl(srcMatch[1]),
      title,
    });
    if (out.length >= 360) break;
  }
  return out;
}

function extractToken(episodeHref) {
  const raw = String(episodeHref || '').trim();
  if (!raw) return '';

  const queryMatch = raw.match(/[?&](?:id|key)=([a-f0-9]{16,64})/i);
  if (queryMatch) return queryMatch[1];

  const cookieMatch = raw.match(/\b([a-f0-9]{16,64})\b/i);
  if (cookieMatch) return cookieMatch[1];

  return '';
}

function looksLikeBlockPage(body) {
  const s = String(body || '');
  if (!s) return false;
  if (/just a moment|attention required|cf-browser-verification|checking your browser/i.test(s)) return true;
  if (/<title>[^<]*(access denied|blocked|login|sign in)[^<]*<\/title>/i.test(s)) return true;
  if (/cloudflare|cdn-cgi\/challenge/i.test(s) && s.length < 4000) return true;
  return false;
}

function isValidEpisodeToken(token) {
  return /^[a-f0-9]{16,64}$/i.test(String(token || '').trim());
}

function parseEpisodeRows(html, image) {
  const rows = [];
  const seenByNumber = new Set();
  const seenByKey = new Set();
  let skippedNonNumeric = 0;

  // Current site markup (as of 2026-08):
  //   <a class='c' onmouseover='gateh("TOKEN")' onclick='gatea("TOKEN")'
  //      id ="TOKEN" href= 'gate.php' ...>
  //     <div class='trackep0 watch bc2'><div class='trackep watchb bc'>
  //       <div class='watch1 bc c'>Episode</div>
  //       <div  class=' watch2 bc '>12</div>
  //       <div class='watch1 bc c'>611 d ago</div>
  //     </div></div></a>
  // Attribute whitespace varies between deploys (`id ="..."`, `href= '...'`),
  // so parse each anchor's attributes and body separately instead of matching
  // one exact HTML shape. Only anchors carrying a valid hex episode token and
  // a numeric `watch2 bc` label are accepted; navigation links, related-show
  // cards, and malformed IDs are rejected.
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const idPattern = /\bid\s*=\s*["']([a-f0-9]{16,64})["']/i;
  const numberPattern = /\bclass\s*=\s*["'][^"']*\bwatch2\b[^"']*["'][^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*</i;

  let match;
  while ((match = anchorPattern.exec(String(html || ''))) !== null) {
    const attributes = String(match[1] || '');
    const inner = String(match[2] || '');

    const idMatch = attributes.match(idPattern);
    if (!idMatch) continue;
    const token = String(idMatch[1] || '').trim();
    if (!isValidEpisodeToken(token)) continue;

    const numberMatch = inner.match(numberPattern);
    if (!numberMatch) continue;
    const label = numberMatch[1];
    const number = Number(label);
    if (!Number.isFinite(number) || number <= 0) {
      skippedNonNumeric++;
      continue;
    }

    // Reject duplicate episodes: the site lists newest first, so the first
    // occurrence of a number carries the current token for that episode.
    if (seenByNumber.has(number)) continue;
    const key = token + '::' + number;
    if (seenByKey.has(key)) continue;
    seenByNumber.add(number);
    seenByKey.add(key);

    rows.push({
      href: token,
      number,
      subAvailable: true,
      dubAvailable: false,
      image: image || undefined,
    });
  }

  if (skippedNonNumeric > 0) {
    log('parseEpisodeRows: skipped ' + skippedNonNumeric + ' non-numeric episode labels');
  }

  rows.sort((a, b) => a.number - b.number);
  return rows;
}

function extractDeclaredEpisodeCount(html) {
  const match = String(html || '').match(/Episodes:\s*<div class='inline c2'>([^<]+)<\/div>/i);
  if (!match) return null;
  const numMatch = String(match[1] || '').match(/(\d+)/);
  if (!numMatch) return null;
  const count = Number(numMatch[1]);
  return Number.isFinite(count) && count > 0 ? count : null;
}

function analyzeEpisodeRows(rows) {
  const numbers = Array.isArray(rows)
    ? rows.map(row => Number(row && row.number)).filter(Number.isFinite).filter(n => n > 0)
    : [];
  if (numbers.length === 0) {
    return {
      count: 0,
      first: null,
      last: null,
      largestJump: 0,
      firstLargeJump: null,
      coverage: 1,
    };
  }

  const uniqueSorted = Array.from(new Set(numbers)).sort((a, b) => a - b);
  let largestJump = 0;
  let firstLargeJump = null;

  for (let i = 1; i < uniqueSorted.length; i++) {
    const gap = uniqueSorted[i] - uniqueSorted[i - 1];
    if (gap > 1) {
      const missing = gap - 1;
      if (missing > largestJump) largestJump = missing;
      if (!firstLargeJump) {
        firstLargeJump = {
          from: uniqueSorted[i - 1],
          to: uniqueSorted[i],
          missing,
        };
      }
    }
  }

  const first = uniqueSorted[0];
  const last = uniqueSorted[uniqueSorted.length - 1];
  const span = (last - first) + 1;
  return {
    count: uniqueSorted.length,
    first,
    last,
    largestJump,
    firstLargeJump,
    coverage: span > 0 ? uniqueSorted.length / span : 1,
  };
}

function collectStreamCandidates(html) {
  const out = [];
  const seen = new Set();
  function add(value) {
    const url = decodeHtml(value || '').replace(/&amp;/g, '&').trim();
    if (!url || seen.has(url)) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (!/(\.mp4|\.m3u8)(\?|$)/i.test(url)) return;
    if (/animeheaven\.me\/(?:gate|anime|err)\.php/i.test(url)) return;
    seen.add(url);
    out.push(url);
  }

  const sourcePattern = /<source\s+[^>]*src=['"]([^'"]+)['"][^>]*>/gi;
  let match;
  while ((match = sourcePattern.exec(String(html || ''))) !== null) {
    add(match[1]);
  }

  // Explicit player sources take precedence over duplicate download links.
  if (out.length) return out;

  const urlPattern = /https?:\/\/[^"'\s<>]+(?:\.mp4|\.m3u8)[^"'\s<>]*/gi;
  while ((match = urlPattern.exec(String(html || ''))) !== null) {
    add(match[0]);
  }

  return out;
}

async function probeStreamUrl(url) {
  const res = await request(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'video/mp4,application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      'Referer': BASE_URL + '/',
      'Origin': BASE_URL,
      'Range': 'bytes=0-1',
    },
  });
  if (!res || (res.status !== 200 && res.status !== 206)) return false;
  const contentType = String(res.contentType || '').toLowerCase();
  if (contentType.includes('text/html')) return false;
  if (contentType.includes('image/')) return false;
  if (contentType.includes('video/') || contentType.includes('mpegurl') || contentType.includes('octet-stream')) return true;
  const body = String(res.body || '').trim().slice(0, 128).toLowerCase();
  if (!body) return false;
  return body.startsWith('#extm3u');
}

async function pickBestStreamUrl(html) {
  const candidates = await verifiedStreamCandidates(html);
  return candidates[0] || '';
}

async function verifiedStreamCandidates(html) {
  const candidates = collectStreamCandidates(html);
  const result = [];
  const deadline = Date.now() + 20000;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    if (await probeStreamUrl(candidate)) result.push(candidate);
  }
  return result;
}

async function searchResults(query) {
  const term = String(query || '').trim();
  if (!term) {
    const home = await request(BASE_URL + '/');
    if (!home.ok || !home.body) return [];
    return parseHomeItems(home.body);
  }

  const res = await request(SEARCH_ENDPOINT + encodeURIComponent(term));
  let items = res.ok && res.body ? parseSearchItems(res.body) : [];
  // Fast search is intentionally preferred, but it is not the site's stable
  // public card format. Fall back to the full results page when it changes.
  if (!items.length) {
    const full = await request(BASE_URL + '/search.php?s=' + encodeURIComponent(term));
    if (full.ok && full.body) items = parseSearchItems(full.body);
  }

  return items
    .sort((a, b) => {
      const rankDelta = rankSearchResult(a, term) - rankSearchResult(b, term);
      if (rankDelta !== 0) return rankDelta;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
}

async function extractDetails(urlOrId) {
  const target = toAbsoluteUrl(urlOrId);
  if (!target) {
    return {
      title: 'Unknown',
      description: 'No description available.',
    };
  }

  const res = await request(target);
  if (!res.ok || !res.body) {
    throw new Error('AnimeHeaven: details request failed for ' + target
      + ' (HTTP ' + (res.status || 'no response') + ')');
  }
  if (looksLikeBlockPage(res.body)) {
    throw new Error('AnimeHeaven: details page returned a block or challenge page for ' + target);
  }
  const html = res.body;

  const titleBlock = html.match(/<div class='infotitle c'>([\s\S]*?)<\/div>/i);
  const titleTag = html.match(/<title>([^<]+)<\/title>/i);
  const descriptionBlock = html.match(/<div class='infodes c'>([\s\S]*?)<\/div>/i);
  const yearBlock = html.match(/Year:\s*<div class='inline c2'>([^<]+)<\/div>/i);
  const posterBlock = html.match(/<img class='coverimg' src='([^']+)'/i);

  const title = stripTags((titleBlock && titleBlock[1]) || (titleTag && titleTag[1]) || 'Unknown');
  const description = stripTags((descriptionBlock && descriptionBlock[1]) || 'No description available.');
  const airdate = stripTags((yearBlock && yearBlock[1]) || 'Unknown');
  const image = toAbsoluteUrl((posterBlock && posterBlock[1]) || '');

  return {
    title,
    description,
    aliases: title,
    airdate,
    image,
  };
}

async function extractEpisodes(seriesId) {
  const target = toAbsoluteUrl(seriesId);
  if (!target) {
    throw new Error('AnimeHeaven: no series URL provided to extractEpisodes');
  }

  const res = await request(target);
  if (!res.ok || !res.body) {
    throw new Error('AnimeHeaven: series page request failed for ' + target
      + ' (HTTP ' + (res.status || 'no response') + ')');
  }
  if (looksLikeBlockPage(res.body)) {
    throw new Error('AnimeHeaven: series page returned a block or challenge page for ' + target);
  }

  const posterMatch = res.body.match(/<link[^>]+rel=['\"]preload['\"][^>]+href=['\"]([^'\"]+)['\"][^>]+as=['\"]image['\"]/i)
    || res.body.match(/<img[^>]+class=['\"][^'\"]*coverimg[^'\"]*['\"][^>]+src=['\"]([^'\"]+)['\"]/i);
  const rows = parseEpisodeRows(res.body, toAbsoluteUrl((posterMatch && posterMatch[1]) || ''));
  const declaredEpisodeCount = extractDeclaredEpisodeCount(res.body);
  const analysis = analyzeEpisodeRows(rows);

  // AnimeHeaven sometimes exposes only a partial chunk of very long-running
  // shows (for example 1-130 and 1033-1156 for One Piece). Return the rows
  // that exist instead of hiding the title, but say so in the log.
  const isClearlyPartialLongSeries = declaredEpisodeCount && declaredEpisodeCount >= 50
    && rows.length < declaredEpisodeCount * 0.85;

  if (isClearlyPartialLongSeries) {
    console.log('[AnimeHeaven] extractEpisodes: partial catalog exposed by source for ' + target
      + ' declared=' + declaredEpisodeCount
      + ' parsed=' + rows.length
      + ' coverage=' + analysis.coverage.toFixed(3)
      + ' largestJump=' + analysis.largestJump
      + (analysis.firstLargeJump ? ' jump=' + analysis.firstLargeJump.from + '->' + analysis.firstLargeJump.to : '')
      + ' — returning available rows instead of hiding the title.');
  }

  if (!rows.length) {
    const hasEpisodeMarkers = /gateh\(|gatea\(|watch2|linetitle2/i.test(res.body);
    if (hasEpisodeMarkers || declaredEpisodeCount) {
      throw new Error('AnimeHeaven: episode markup changed or could not be parsed for ' + target
        + ' (declared=' + (declaredEpisodeCount || 'unknown') + ', episode markers present)');
    }
    throw new Error('AnimeHeaven: no episodes listed upstream for ' + target);
  }

  return rows;
}

async function extractStreamUrl(episodeHref, lang) {
  // Episode metadata declares SUB only; a label cannot create an English dub.
  if (String(lang || '').toLowerCase() === 'dub') {
    throw new Error('AnimeHeaven: Dub is not available through this module');
  }
  const token = extractToken(episodeHref);
  if (!token || !isValidEpisodeToken(token)) {
    throw new Error('AnimeHeaven: episode link does not contain a valid episode token ('
      + String(episodeHref || '').slice(0, 60) + ')');
  }

  const gateHeaders = {
    'Cookie': 'key=' + token,
    'Referer': toAbsoluteUrl('/anime.php'),
    'Origin': BASE_URL,
  };

  const res = await request(GATE_ENDPOINT, { headers: gateHeaders });
  if (!res.ok || !res.body) {
    throw new Error('AnimeHeaven: gate request failed for episode '
      + token.slice(0, 8) + '… (HTTP ' + (res.status || 'no response') + ')');
  }
  if (looksLikeBlockPage(res.body)) {
    throw new Error('AnimeHeaven: gate returned a block or challenge page for episode '
      + token.slice(0, 8) + '…');
  }

  const candidates = await verifiedStreamCandidates(res.body);
  const streamUrl = candidates[0];
  if (!streamUrl) {
    throw new Error('AnimeHeaven: gate returned no playable video sources for episode '
      + token.slice(0, 8) + '…');
  }

  const headers = {'Referer':BASE_URL+'/', 'Origin':BASE_URL, 'User-Agent':USER_AGENT};
  return {
    streams: ['Auto', streamUrl],
    url: streamUrl,
    streamType: /\.m3u8(?:[?#]|$)/i.test(streamUrl) ? 'hls' : 'mp4',
    headers,
    servers: candidates.map((url,index) => ({name:'Source '+(index+1),url,headers,
      streamType:/\.m3u8(?:[?#]|$)/i.test(url)?'hls':'mp4'})),
  };
}

function toDiscoveryCards(items, limit) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const href = String(item && (item.href || item.url || item.id) || '').trim();
    const title = String(item && (item.title || item.name) || '').trim();
    if (!href || !title || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, id: href, title, image: String(item.image || item.poster || '').trim() });
    if (out.length >= limit) break;
  }
  return out;
}

async function discoverFor(query, limit) {
  try {
    return toDiscoveryCards(await searchResults(query), limit);
  } catch (_) {
    return [];
  }
}

async function discoverCatalogPage(path) {
  try {
    const response = await request(BASE_URL + path);
    if (!response.ok || !response.body) return [];
    return toDiscoveryCards(parseHomeItems(response.body), 360);
  } catch (_) {
    return [];
  }
}

async function discoverHomeCatalog() {
  return discoverCatalogPage('/');
}

async function discoveryHome() {
  const groups = await Promise.all([
    discoverHomeCatalog(),
    discoverCatalogPage('/new.php'),
    discoverCatalogPage('/popular.php'),
  ]);
  const sections = [];
  if (groups[0].length) sections.push({ id: 'featured', title: 'Featured', style: 'hero', items: groups[0].slice(0, 8), viewAll: { mode: 'feed', feedId: 'all' } });
  if (groups[1].length) sections.push({ id: 'latest', title: 'Latest Updates', style: 'poster', items: groups[1].slice(0, 20), viewAll: { mode: 'feed', feedId: 'all' } });
  if (groups[2].length) sections.push({ id: 'popular', title: 'Popular', style: 'poster', items: groups[2].slice(0, 20), viewAll: { mode: 'feed', feedId: 'all' } });
  if (!sections.length) throw new Error('AnimeHeaven discovery returned no usable cards');
  return { sections };
}

async function discoveryFeed(feedId, page) {
  const pageNumber = Math.max(1, Number(page) || 1);
  if (String(feedId || '').toLowerCase() !== 'all') {
    return { items: [], page: pageNumber, hasMore: false };
  }
  const pages = await Promise.all([
    discoverHomeCatalog(),
    discoverCatalogPage('/new.php'),
    discoverCatalogPage('/popular.php'),
  ]);
  const catalog = toDiscoveryCards([].concat(pages[0], pages[1], pages[2]), 900);
  const pageSize = 30;
  const offset = (pageNumber - 1) * pageSize;
  const items = catalog.slice(offset, offset + pageSize);
  return { items, page: pageNumber, hasMore: offset + items.length < catalog.length };
}

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
