(() => {
  'use strict';

  const MODULE_NAME = 'Shahiid';
  const SITE = 'https://shahiid-anime.net';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const MAX_EPISODES = 1240;
  const MAX_SEASONS = 15;
  // The season paginator is a rolling window (page 1 links only to 2-4) but the same season URL also
  // accepts ?epp=N directly — verified to N=61 on One Piece, which carries ~1180 episodes. Walking in
  // small parallel batches reaches the end of long series that a 25-page sequential cap used to hide
  // (it returned 500 of ~1180).
  const MAX_PAGES = 62;
  const PAGE_BATCH = 6;
  // A call must stay inside the runtime's per-call ceiling, so the walk is bounded by time as well as
  // by page count: on a fast connection a long series returns most of its list, on a slow one the list
  // is as complete as the budget allows instead of the whole call failing. The ceiling is real — an
  // unbounded aggregate walk was measured timing out at 20s (the aggregate /series/ walk enumerates
  // several seasons and pushed past it), so the budget stays comfortably below. Measured here: the
  // One Piece main season walk (62 pages, ~1180 episodes upstream) returns in ~13s.
  const PAGE_TIME_BUDGET_MS = 12000;

  function log(message) {
    try { console.log('[' + MODULE_NAME + '] ' + String(message || '')); } catch (_) {}
  }

  function decodeHtml(text) {
    return String(text || '')
      .replace(/&#0?39;|&#x27;|&apos;/g, "'")
      .replace(/&#8217;/g, "'")
      .replace(/&#8211;|&ndash;/g, '-')
      .replace(/&quot;|&#8221;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  function stripTags(text) {
    return decodeHtml(String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }

  function toAbsoluteUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return 'https:' + raw;
    if (raw.startsWith('/')) return SITE + raw;
    return SITE + '/' + raw;
  }

  function normalizeHref(value) {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
      const m = raw.match(/^https?:\/\/[^/]+([^?]*)(\?.*)?$/i);
      if (!m) return '';
      raw = (m[1] || '/') + (m[2] || '');
    } else {
      if (raw.startsWith('//')) raw = raw.slice(1);
      if (!raw.startsWith('/')) raw = '/' + raw;
    }
    raw = raw.replace(/\/{2,}/g, '/');
    if (raw.length > 1 && !raw.includes('?') && !/\/$/.test(raw)) raw += '/';
    return raw;
  }

  function looksLikeBlockPage(html) {
    const s = String(html || '');
    if (!s) return false;
    if (/just a moment|attention required|cf-browser-verification|checking your browser/i.test(s)) return true;
    if (/<title>[^<]*(access denied|blocked|403)[^<]*<\/title>/i.test(s)) return true;
    return false;
  }

  async function requestText(url, extraHeaders) {
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/json,*/*',
      Referer: SITE + '/',
    }, extraHeaders || {});
    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, headers, 'GET', null);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { headers });
    }
    const status = Number((res && res.status) || 0);
    let text = '';
    let json = null;
    if (res && typeof res.json === 'function') {
      try { json = await res.json(); } catch (_) {}
    } else if (res && res.json !== undefined && res.json !== null) {
      json = res.json;
    }
    if (res && typeof res.text === 'function') {
      try { text = await res.text(); } catch (_) {}
    } else if (res && typeof res.body === 'string') {
      text = res.body;
    }
    if (!text && json) {
      try { text = JSON.stringify(json); } catch (_) {}
    }
    return {
      status: status,
      ok: status >= 200 && status < 400,
      text: text || '',
      json: json,
      finalUrl: (res && res.url) || url,
    };
  }

  async function requestPostForm(url, fields, extraHeaders) {
    const bodyParts = [];
    for (const key of Object.keys(fields)) {
      bodyParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(fields[key] == null ? '' : fields[key])));
    }
    const body = bodyParts.join('&');
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: '*/*',
      Referer: SITE + '/',
    }, extraHeaders || {});
    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, headers, 'POST', body);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { method: 'POST', headers, body });
    }
    const status = Number((res && res.status) || 0);
    let text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    else if (res && typeof res.body === 'string') text = res.body;
    return { status: status, ok: status >= 200 && status < 400, text: text || '' };
  }

  // ---------- card parsing (search + home + catalog pages) ----------

  function parsePosterCards(html, catalogueOnly) {
    const out = [];
    const seen = new Set();
    const text = String(html || '');
    // Poster anchors carry the link + image; the visible <h2><a>Title</a></h2>
    // follows just after the closing </a>. Match them in sequence so both
    // search cards and home/carousel rows parse reliably.
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const href = normalizeHref(m[1]);
      if (!href || seen.has(href)) continue;
      if (!/^\/(?:anime|series(?:Dubbed)?|seasons(?:Dubbed)?|episodes(?:Dubbed)?)\/[^/?]+/i.test(href)) continue;
      if (catalogueOnly && /^\/episodes(?:Dubbed)?\//i.test(href)) continue;
      if (/(\/feed\/|wp-login|#respond|\/search\/)/i.test(href)) continue;
      const img = m[2].match(/<img\b([^>]*)>/i);
      if (!img) continue;
      const attrs = img[1];
      const srcM = attrs.match(/\bdata-src=["']([^"']+)["']/i)
        || attrs.match(/\bdata-original=["']([^"']+)["']/i)
        || attrs.match(/\bsrc=["']([^"']+)["']/i);
      if (!srcM) continue;

      const tailStart = m.index + m[0].length;
      const tail = text.slice(tailStart, tailStart + 900);
      const titleM = m[2].match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
        || tail.match(/^\s*(?:<\/div>\s*)?<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)
        || attrs.match(/alt=["']([^"']{2,})["']/i)
        || tail.match(/alt=["']([^"']{2,})["']/i);
      const title = stripTags(titleM ? titleM[1] : '');
      if (!title || title.length < 2) continue;
      seen.add(href);
      out.push({ href, image: toAbsoluteUrl(decodeHtml(srcM[1])), title });
      if (out.length >= 60) break;
    }
    return out;
  }

  // ---------- search ----------

  // Deadline for the current extractEpisodes call: the per-season page walk and the multi-season loop
  // both honour it, so a whole call stays inside the app's ceiling however many seasons a series has.
  // (A per-season budget was worse: every season restarted the clock.)
  let walkDeadline = 0;

  // Cache only successful catalogue results, never playback links or errors.
  const searchCache = new Map();
  const pendingSearches = new Map();

  async function searchResults(query) {
    const term = String(query || '').trim();
    if (!term) {
      return (await discoveryFeed('subbed', 1)).items;
    }
    const key = term.toLowerCase();
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached.items.map(item => Object.assign({}, item));
    if (pendingSearches.has(key)) return (await pendingSearches.get(key)).map(item => Object.assign({}, item));
    const pending = searchUncached(term);
    pendingSearches.set(key, pending);
    try {
      const items = await pending;
      if (items.length) {
        searchCache.delete(key);
        searchCache.set(key, { at: Date.now(), items });
        if (searchCache.size > 10) searchCache.delete(searchCache.keys().next().value);
      }
      return items.map(item => Object.assign({}, item));
    } finally { pendingSearches.delete(key); }
  }

  async function searchUncached(term) {
    const res = await requestText(SITE + '/?s=' + encodeURIComponent(term));
    if (!res.ok) throw new Error('Shahiid: search request failed (HTTP ' + res.status + ')');
    if (looksLikeBlockPage(res.text)) throw new Error('Shahiid: search returned a block page');
    const items = parsePosterCards(res.text);
    if (!items.length) log('search: no result cards for "' + term + '"');

    // Prioritize seasons pages first, then series containers, then movies, then episodes
    items.sort((a, b) => {
      const rank = (href) => {
        if (/^\/?seasons(?:Dubbed)?\//i.test(href)) return 0;
        if (/^\/?series(?:Dubbed)?\//i.test(href)) return 1;
        if (/^\/?anime\//i.test(href)) return 2;
        return 3;
      };
      // Single-item pages (specials, films) sit under the same /seasons/ path as real series and can
      // outrank them in the site's own ordering, so a search for a long show returned a one-episode
      // special. Push those below their multi-episode siblings.
      const isSingleItem = (item) => {
        const title = decodeHtml(stripTags(String((item && item.title) || '')));
        return /(?:حلقة\s*خاصة|فيلم|movie|special)/i.test(title);
      };
      const rankOf = (item) => rank(item.href) + (isSingleItem(item) ? 0.5 : 0);
      return rankOf(a) - rankOf(b);
    });

    return items;
  }

  // ---------- details ----------

  async function extractDetails(urlOrId) {
    const path = normalizeHref(urlOrId);
    if (!path) throw new Error('Shahiid: extractDetails received an empty or foreign URL');
    const res = await requestText(SITE + path);
    if (!res.ok) throw new Error('Shahiid: details request failed (HTTP ' + res.status + ') for ' + path);
    if (looksLikeBlockPage(res.text)) throw new Error('Shahiid: details page returned a block page');
    const html = res.text;

    const og = (prop) => {
      const needle = 'og:' + prop;
      const tagRe = /<meta\b[^>]*>/gi;
      let tag;
      while ((tag = tagRe.exec(html)) !== null) {
        const t = tag[0];
        if (t.indexOf(needle) < 0) continue;
        const c = t.match(/content\s*=\s*"([^"]*)"/i) || t.match(/content\s*=\s*'([^']*)'/i);
        if (c) return decodeHtml(c[1]);
      }
      return '';
    };

    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    let title = stripTags(og('title') || (h1 ? h1[1] : '') || '');

    // Category archive pages on shahiid have generic "مواسم الأنمي Archive" in og:title
    if (/Archive/i.test(title) || /مواسم الأنمي/i.test(title)) {
      if (h1) {
        title = stripTags(h1[1]);
      } else {
        const headingMatch = html.match(/<h[12][^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h[12]>/i);
        if (headingMatch) title = stripTags(headingMatch[1]);
      }
      title = title.replace(/\s*Archive.*$/i, '').trim();
    }

    const description = stripTags(og('description'));
    let image = toAbsoluteUrl(og('image'));
    if (!image && title) {
      const expected = title.replace(/\s+-\s+Shahiid.*$/i, '').trim().toLowerCase();
      for (const tag of (html.match(/<img\b[^>]*>/gi) || [])) {
        const alt = tag.match(/\balt=["']([^"']*)["']/i);
        if (!alt || !expected || !decodeHtml(alt[1]).toLowerCase().includes(expected)) continue;
        const src = tag.match(/\bdata-src=["']([^"']+)["']/i) || tag.match(/\bsrc=["']([^"']+)["']/i);
        if (src) { image = toAbsoluteUrl(decodeHtml(src[1])); break; }
      }
    }

    return {
      href: SITE + path,
      title: title || 'Unknown',
      description: description || 'No description available.',
      image: image,
    };
  }

  // ---------- episodes ----------

  function episodeNumberFromPath(path) {
    let decoded = path;
    try { decoded = decodeURIComponent(path); } catch (_) {}
    let m = decoded.match(/(?:\u0627\u0644\u062d\u0644\u0642\u0629|\u062d\u0644\u0642\u0629|episode|ep)[-_ ](?:\u0627\u0644\u062e\u0627\u0635\u0629[-_ ])?([0-9]+(?:\.[0-9]+)?)/i);
    if (m) return Number(m[1]);
    m = decoded.match(/-([0-9]+(?:\.[0-9]+)?)-?\/*$/);
    if (m) return Number(m[1]);
    m = decoded.match(/([0-9]+(?:\.[0-9]+)?)(?:\/|$)/);
    if (m) return Number(m[1]);
    return null;
  }

  function episodeVariantFromPath(path) {
    const p = decodeURIComponent(String(path || ''));
    return /(Dubbed|%d9%85%d8%af%d8%a8%d9%84%d8%ac|مدبلج|دبلجة)/i.test(p) ? 'dub' : 'sub';
  }

  function makeEpisode(path, fallbackNumber) {
    const num = episodeNumberFromPath(path) || fallbackNumber || 1;
    const variant = episodeVariantFromPath(path);
    return {
      number: num,
      href: path,
      title: '\u0627\u0644\u062d\u0644\u0642\u0629 ' + num,
      subAvailable: variant !== 'dub',
      dubAvailable: variant === 'dub',
    };
  }

  function collectEpisodeLinks(html) {
    const out = [];
    const seen = new Set();
    const re = /href=["']([^"']*\/episodes(?:Dubbed)?\/[^"'?]+)["']/gi;
    let m;
    while ((m = re.exec(String(html || ''))) !== null) {
      const href = normalizeHref(m[1]);
      if (!href || seen.has(href) || /\/page\//i.test(href)) continue;
      seen.add(href);
      out.push(href);
    }
    return out;
  }

  async function fetchEpisodesFromSeasonPage(seasonPath, collected, seenHrefs) {
    let first = collected.length;
    const res = await requestText(SITE + seasonPath);
    if (!res.ok) return;
    const links = collectEpisodeLinks(res.text);
    for (const link of links) {
      if (seenHrefs.has(link)) continue;
      seenHrefs.add(link);
      collected.push(makeEpisode(link, collected.length + 1 - first));
      if (collected.length >= MAX_EPISODES) return;
    }
    // Follow the current page, not just links visible on page one.
    let pageHtml = res.text;
    // Walk the season's episode pages. Prefer the direct ?epp=N form and fall back to the legacy
    // /page/N/ form when a page yields nothing, so a paginator redesign degrades instead of silently
    // truncating. Pages are fetched PAGE_BATCH at a time; the walk stops as soon as a whole batch adds
    // no new episodes.
    const seasonBase = seasonPath.split('?')[0].replace(/\/$/, '') + '/';
    const fetchSeasonPage = async (n) => {
      const direct = await requestText(SITE + seasonBase + '?epp=' + n).catch(() => null);
      if (direct && direct.ok && collectEpisodeLinks(direct.text).length) return direct.text;
      const legacy = await requestText(SITE + seasonBase + 'page/' + n + '/').catch(() => null);
      if (legacy && legacy.ok && collectEpisodeLinks(legacy.text).length) return legacy.text;
      return '';
    };
    for (let first = 2; first <= MAX_PAGES && collected.length < MAX_EPISODES; first += PAGE_BATCH) {
      if (walkDeadline && Date.now() > walkDeadline) {
        log('episode walk stopped at the time budget with ' + collected.length + ' episodes collected');
        break;
      }
      const batch = [];
      for (let n = first; n < first + PAGE_BATCH && n <= MAX_PAGES; n++) {
        if (collected.length + batch.length * 20 >= MAX_EPISODES) break;
        batch.push(n);
      }
      if (!batch.length) break;
      const pages = await Promise.all(batch.map(fetchSeasonPage));
      let added = 0;
      for (const pageText of pages) {
        if (!pageText) continue;
        for (const link of collectEpisodeLinks(pageText)) {
          if (seenHrefs.has(link)) continue;
          seenHrefs.add(link);
          collected.push(makeEpisode(link, collected.length + 1));
          added += 1;
          if (collected.length >= MAX_EPISODES) break;
        }
        if (collected.length >= MAX_EPISODES) break;
      }
      if (!added) break;
    }
  }

  async function extractEpisodes(seriesId) {
    const path = normalizeHref(seriesId);
    if (!path) throw new Error('Shahiid: extractEpisodes received an empty or foreign URL');

    // Single episode href -> one-entry list
    if (/^\/?episodes(?:Dubbed)?\//i.test(path)) return [makeEpisode(path, 1)];

    // Movie page -> the movie itself is the playable entry
    if (/^\/?anime\//i.test(path)) {
      const variant = episodeVariantFromPath(path);
      return [{
        number: 1,
        href: path,
        title: '\u0641\u064a\u0644\u0645',
        subAvailable: variant !== 'dub',
        dubAvailable: variant === 'dub',
      }];
    }

    const collected = [];
    const seenHrefs = new Set();
    walkDeadline = Date.now() + PAGE_TIME_BUDGET_MS;

    if (/^\/?(?:seasons)(?:Dubbed)?\//i.test(path) || /^\/?seasonsDubbed\/\?/i.test(path)) {
      await fetchEpisodesFromSeasonPage(path, collected, seenHrefs);
    } else if (/^\/?(?:series)(?:Dubbed)?\//i.test(path)) {
      // series page redirects to a seasons listing — gather every season
      const res = await requestText(SITE + path);
      if (!res.ok) throw new Error('Shahiid: series request failed (HTTP ' + res.status + ')');
      if (looksLikeBlockPage(res.text)) throw new Error('Shahiid: series page returned a block page');
      const seasonRe = /href=["']([^"']*\/seasons(?:Dubbed)?\/[^"'?][^"']*)["']/gi;
      const seasons = [];
      let m;
      while ((m = seasonRe.exec(res.text)) !== null) {
        const sp = normalizeHref(m[1]);
        if (/^\/seasons(?:Dubbed)?\/[^/?]+\/?$/i.test(sp)
          && !/\/feed\/|\/page\//i.test(sp) && seasons.indexOf(sp) < 0) seasons.push(sp);
      }
      log('series has ' + seasons.length + ' season page(s)');
      for (let i = 0; i < Math.min(seasons.length, MAX_SEASONS) && collected.length < MAX_EPISODES; i++) {
        if (collected.length && Date.now() > walkDeadline) {
          log('stopping after ' + collected.length + ' episodes: series has more seasons but the time budget is spent');
          break;
        }
        await fetchEpisodesFromSeasonPage(seasons[i], collected, seenHrefs);
      }
    } else {
      throw new Error('Shahiid: unrecognised series URL shape: ' + path.slice(0, 80));
    }

    if (!collected.length) {
      // Some entries live under /seasons/ but are single movies or bare landing pages with no player
      // at all (verified: a Naruto movie page carries an <h1> and a rating widget, nothing else).
      // The app requires a list from extractEpisodes, so report the empty case in the log instead of
      // throwing an exception that surfaces as a broken screen.
      log('no episodes found for ' + path.slice(0, 80)
        + ' — single-movie/landing page upstream or the site markup changed');
      return [];
    }

    // Episode hrefs are authoritative; specials/seasons may reuse numbers.
    collected.sort((a, b) => (a.number - b.number) || (a.href < b.href ? -1 : 1));
    const finalSeen = new Set();
    const out = [];
    for (const ep of collected) {
      if (finalSeen.has(ep.href)) continue;
      finalSeen.add(ep.href);
      out.push(ep);
    }
    return out;
  }

  // ---------- streams ----------

  function unpackPackedJs(source) {
    const text = String(source || '');
    const m = text.match(/\}\s*\(\s*['"]([\s\S]+?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]+?)['"]\.split\(\s*['"]\|['"]\s*\)/);
    if (!m) return null;
    let p = m[1];
    const a = parseInt(m[2], 10) || 36;
    let c = parseInt(m[3], 10) || 0;
    const k = m[4].split('|');
    function e(c) {
      return (c < a ? '' : e(parseInt(c / a, 10))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
    }
    while (c--) {
      if (k[c]) {
        p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
      }
    }
    return p;
  }

  function resolveMediaReference(base, value) {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('//')) return 'https:' + value;
    const origin = base.match(/^https?:\/\/[^/]+/i);
    if (!origin) return '';
    const pathname = value.startsWith('/') ? value
      : base.slice(origin[0].length).split('?')[0].replace(/[^/]*$/, '') + value;
    const parts = [];
    for (const part of pathname.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return origin[0] + '/' + parts.join('/');
  }

  async function probeMedia(url, referer, depth) {
    if ((depth || 0) > 3) return { ok: false, reason: 'playlist nesting limit' };
    const ref = referer || (SITE + '/');
    const origin = ref.replace(/^(https?:\/\/[^\/]+).*$/, '$1');
    const headers = {
      'User-Agent': USER_AGENT,
      Referer: ref,
      Origin: origin,
      Accept: '*/*',
    };
    const isHlsCandidate = /\.m3u8(?:\?|$)/i.test(url);
    const reqHeaders = isHlsCandidate
      ? headers
      : Object.assign({ Range: 'bytes=0-1023' }, headers);

    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, reqHeaders, 'GET', null, isHlsCandidate ? { maxBytesHint: 65536 } : { maxBytesHint: 2048 });
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { headers: reqHeaders });
    }
    const status = Number((res && res.status) || 0);
    if (!(status === 200 || status === 206)) return { ok: false, reason: 'HTTP ' + status };
    const contentType = String(
      (res && ((res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || res.contentType)) || '',
    ).toLowerCase();
    let body = '';
    if (res && typeof res.text === 'function') { try { body = await res.text(); } catch (_) {} }
    else if (res && typeof res.body === 'string') body = res.body;

    const isHlsUrl = isHlsCandidate || contentType.indexOf('mpegurl') >= 0;
    if (isHlsUrl) {
      const t = String(body || '').trim();
      if (t.indexOf('#EXTM3U') !== 0) return { ok: false, reason: 'not an HLS playlist' };
      const resources = t.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
      if (!resources.length) return { ok: false, reason: 'empty playlist' };
      if (resources.some((line) => /\.(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(line))) return { ok: false, reason: 'image playlist' };
      if (/<!doctype|<html|just a moment/i.test(t)) return { ok: false, reason: 'html playlist' };
      const next = resolveMediaReference(url, resources[0]);
      if (!next) return { ok: false, reason: 'invalid media reference' };
      const child = await probeMedia(next, ref, (depth || 0) + 1);
      if (!child.ok) return child;
      return { ok: true, kind: 'hls' };
    }
    if (contentType.indexOf('text/') >= 0) return { ok: false, reason: 'text response (' + contentType + ')' };
    if (contentType.indexOf('image/') >= 0) return { ok: false, reason: 'image response' };
    if (contentType.indexOf('html') >= 0) return { ok: false, reason: 'html response' };
    // Progressive media must show real binary/video evidence.
    const binaryOk = contentType.indexOf('video/') >= 0
      || contentType.indexOf('octet-stream') >= 0
      || /^ftyp|\u0000\u0000\u0000 ftyp|moov|mdat/i.test(String(body || '').slice(0, 64));
    if (!binaryOk) return { ok: false, reason: 'no media signature' };
    return { ok: true, kind: 'mp4' };
  }

  async function resolveLulustream(mirrorUrl) {
    let url = mirrorUrl;
    if (url.startsWith('//')) url = 'https:' + url;
    const origin = url.replace(/^(https?:\/\/[^\/]+).*$/, '$1');
    const res = await requestText(url, { Referer: 'https://share4max.com/' });
    if (!res.ok) return null;
    const unpacked = unpackPackedJs(res.text) || '';
    const blob = unpacked + '\n' + res.text.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const m = blob.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/i);
    if (!m) return null;
    const m3u8Url = m[0];
    const probe = await probeMedia(m3u8Url, origin + '/');
    if (!probe.ok) return null;
    return {
      label: 'HLS',
      url: m3u8Url,
      streamType: 'hls',
      headers: { 'User-Agent': USER_AGENT, Referer: origin + '/', Origin: origin },
    };
  }

  async function resolveStreamtape(mirrorUrl) {
    let url = mirrorUrl;
    if (url.startsWith('//')) url = 'https:' + url;
    const origin = url.replace(/^(https?:\/\/[^\/]+).*$/, '$1');
    const res = await requestText(url, { Referer: 'https://share4max.com/' });
    if (!res.ok) return null;
    const m = res.text.match(/getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(?['"]([^'"]+)['"]\)?\.substring\((\d+)\)(?:\.substring\((\d+)\))?/);
    if (!m) return null;
    let part1 = m[1];
    let part2 = m[2];
    if (m[3]) part2 = part2.substring(Number(m[3]));
    if (m[4]) part2 = part2.substring(Number(m[4]));
    let videoUrl = part1 + part2;
    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
    return {
      label: 'MP4',
      url: videoUrl,
      streamType: 'mp4',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: origin + '/',
        Origin: origin,
        Accept: '*/*',
      },
    };
  }

  async function resolveGenericMirror(mirrorUrl) {
    let url = mirrorUrl;
    if (url.startsWith('//')) url = 'https:' + url;
    const origin = url.replace(/^(https?:\/\/[^\/]+).*$/, '$1');
    const res = await requestText(url, { Referer: 'https://share4max.com/' });
    if (/^https:\/\/(?:docs|drive)\.google\.com\//i.test(url)
      && /violation of our Terms of Service/i.test(res.text)) {
      throw new Error('Shahiid: the video host has removed this file. Choose another episode or source.');
    }
    if (!res.ok) return null;
    const unpacked = unpackPackedJs(res.text) || '';
    const blob = unpacked + '\n' + res.text;
    const assetRe = /\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|html?)(?:\?|$)/i;
    let candidate = '';
    const m3u8 = blob.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    if (m3u8 && !assetRe.test(m3u8[0])) {
      candidate = m3u8[0];
    } else {
      const mp4 = blob.match(/["'[](https?:\/\/[^"'\\\s]+\.m[pk]4[a-z]?[^"'\s]*)/i)
        || blob.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv)[^\s"'<>]*/i);
      if (mp4 && !assetRe.test(mp4[1] || mp4[0])) candidate = mp4[1] || mp4[0];
    }
    if (!candidate) return null;
    const probe = await probeMedia(candidate, origin + '/');
    if (!probe.ok) return null;
    return {
      label: (probe.kind === 'hls' || candidate.includes('.m3u8')) ? 'HLS' : 'MP4',
      url: candidate,
      streamType: (probe.kind === 'hls' || candidate.includes('.m3u8')) ? 'hls' : (probe.kind || 'mp4'),
      headers: { 'User-Agent': USER_AGENT, Referer: origin + '/', Origin: origin, Accept: '*/*' },
    };
  }

  async function resolveShare4max(hashId) {
    const iframeUrl = 'https://share4max.com/iframe/' + encodeURIComponent(hashId);
    const page = await requestText(iframeUrl, { Referer: SITE + '/' });
    log('resolveShare4max page status=' + page.status + ' ok=' + page.ok);
    if (!page.ok) throw new Error('Shahiid: share4max embed request failed (HTTP ' + page.status + ')');
    const versionM = page.text.match(/"version":"([^"]+)"/);
    const componentM = page.text.match(/"component":"([^"]+)"/);
    if (!versionM || !componentM) {
      log('resolveShare4max markup changed: page text sample=' + page.text.slice(0, 200));
      throw new Error('Shahiid: share4max embed markup changed (no Inertia version/component)');
    }
    const component = componentM[1].replace(/\\\//g, '/');
    log('resolveShare4max version=' + versionM[1] + ' component=' + component);
    const partial = await requestText(iframeUrl + '?prop=streams', {
      Referer: iframeUrl,
      Accept: 'text/html, application/xhtml+xml',
      'X-Inertia': 'true',
      'X-Inertia-Version': versionM[1],
      'X-Inertia-Partial-Component': component,
      'X-Inertia-Partial-Data': 'streams,subtitles',
      'X-Requested-With': 'XMLHttpRequest',
    });
    log('resolveShare4max partial status=' + partial.status + ' hasJson=' + !!partial.json + ' textLen=' + (partial.text || '').length);
    if (!partial.ok) throw new Error('Shahiid: share4max sources request failed (HTTP ' + partial.status + ')');

    let mirrors = [];
    try {
      const envelope = partial.json || (partial.text ? JSON.parse(partial.text) : null);
      const data = (((envelope && envelope.props || {}).streams || {}).data) || [];
      for (const group of data) {
        for (const mir of (group.mirrors || [])) {
          mirrors.push({
            driver: String(mir.driver || ''),
            link: String(mir.link || ''),
            resolution: String(group.resolution || group.label || ''),
          });
        }
      }
    } catch (e) {
      log('resolveShare4max json parse err: ' + (e.message || e));
      throw new Error('Shahiid: share4max sources response was not valid JSON (markup changed)');
    }
    log('resolveShare4max found mirrors=' + mirrors.length);
    if (!mirrors.length) throw new Error('Shahiid: share4max returned no mirrors for this episode');

    const priority = (d) => {
      const l = d.toLowerCase();
      if (l.indexOf('streamtape') >= 0) return 0;
      if (l.indexOf('lulustream') >= 0) return 1;
      if (l.indexOf('byse') >= 0) return 2;
      if (l.indexOf('voe') >= 0) return 3;
      if (l.indexOf('fileserve') >= 0 || l.indexOf('firestream') >= 0) return 4;
      return 5;
    };
    const resHeight = (r) => {
      const m = String(r || '').match(/(\d{3,4})p?/i);
      return m ? Number(m[1]) : 0;
    };
    mirrors.sort((a, b) => {
      const diffH = resHeight(b.resolution) - resHeight(a.resolution);
      if (diffH !== 0) return diffH;
      return priority(a.driver) - priority(b.driver);
    });

    const streams = [];
    for (let i = 0; i < mirrors.length && streams.length < 4; i++) {
      const mir = mirrors[i];
      let link = mir.link;
      if (!link) continue;
      if (link.startsWith('//')) link = 'https:' + link;
      if (!/^https?:\/\//i.test(link)) continue;
      if (/doodstream|mixdrop|savefiles/i.test(mir.driver + link)) continue; // CF-walled in practice
      try {
        let item = null;
        if (/streamtape/i.test(mir.driver + link)) item = await resolveStreamtape(link);
        if (!item && /lulustream|tnmr/i.test(mir.driver + link)) item = await resolveLulustream(link);
        if (!item) item = await resolveGenericMirror(link);
        if (item) {
          const resLabel = mir.resolution && /^\d+p$/i.test(mir.resolution) ? mir.resolution : '';
          item.label = (item.label || 'HLS') + (resLabel ? ' ' + resLabel : '');
          item.height = resHeight(mir.resolution) || undefined;
          item.serverId = link;
          item.serverName = mir.driver || link.replace(/^https?:\/\//, '').split('/')[0];
          streams.push(item);
          log('resolveShare4max resolved stream: ' + item.label + ' url=' + item.url.slice(0, 60));
        }
      } catch (e) {
        log('mirror ' + mir.driver + ' failed: ' + String(e.message || e).slice(0, 80));
      }
    }
    return streams;
  }

  // Server-button pages (older dubbed titles): each button carries
  // data-post / data-frameserver / data-serv and the real embed arrives via a
  // WordPress admin-ajax call.
  function parseServerButtons(html) {
    const buttons = [];
    const re = /<a\b[^>]*class=["'][^"']*buttosn[^"']*["'][^>]*>/gi;
    let m;
    while ((m = re.exec(String(html || ''))) !== null) {
      const tag = m[0];
      const attr = (name) => {
        const am = tag.match(new RegExp('data-' + name + '=["\\\']([^"\\\']*)["\\\']', 'i'));
        return am ? decodeHtml(am[1]).trim() : '';
      };
      const post = attr('post');
      const frameserver = attr('frameserver');
      const serv = attr('serv');
      if (!frameserver || !post) continue;
      buttons.push({ post: post, frameserver: frameserver, serv: serv });
      if (buttons.length >= 4) break;
    }
    return buttons;
  }

  async function fetchServerEmbedUrl(button, episodePageUrl) {
    try {
      const res = await requestPostForm(SITE + '/wp-admin/admin-ajax.php', {
        action: 'codecanal_ajax_request',
        post: button.post,
        _server_code_: '',
        frameserver: button.frameserver,
        is_film: '',
        serv: button.serv || '_server_movie_' + button.post,
      }, { Referer: episodePageUrl });
      if (!res.ok) return '';
      const m = res.text.match(/(?:src|SRC)=["']([^"']+)["']/);
      if (!m) return '';
      let url = decodeHtml(m[1]).trim();
      if (url.startsWith('//')) url = 'https:' + url;
      return /^https?:\/\//i.test(url) ? url : '';
    } catch (_) {
      return '';
    }
  }

  async function extractStreamUrl(episodeHref, lang) {
    try {
      const path = normalizeHref(episodeHref);
      if (!path) throw new Error('Shahiid: extractStreamUrl received an empty or foreign URL');

      log('extractStreamUrl path=' + path + ' lang=' + lang);
      const variant = episodeVariantFromPath(path);
      const requestedDub = String(lang || '').toLowerCase() === 'dub';
      const requestedSub = String(lang || '').toLowerCase() === 'sub';

      if (requestedDub && variant !== 'dub') {
        throw new Error('Shahiid: requested DUB but this episode is subtitle-only (مترجم)');
      }
      if (requestedSub && variant === 'dub') {
        throw new Error('Shahiid: requested SUB but this episode is dubbed-only (مدبلج)');
      }

      const res = await requestText(SITE + path);
      if (!res.ok) throw new Error('Shahiid: episode request failed (HTTP ' + res.status + ')');
      if (looksLikeBlockPage(res.text)) throw new Error('Shahiid: episode page returned a block page');

      const iframes = [];
      const re = /<iframe[^>]*src=["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(res.text)) !== null) iframes.push(decodeHtml(m[1]));

      log('extractStreamUrl iframes: ' + iframes.join(', '));
      const shareM = iframes.map((u) => u.match(/(?:share4max\.com|megamax\.me)\/iframe\/([a-zA-Z0-9_-]+)/)).find(Boolean);

      let streams = [];
      let embedUrls = [];
      let unavailableReason = '';

      if (shareM) {
        log('extractStreamUrl resolving share4max ' + shareM[1]);
        streams = await resolveShare4max(shareM[1]);
      } else {
        embedUrls = iframes.filter((u) => !/shahiid-anime\.net|youtube|facebook/i.test(u));
        const buttons = parseServerButtons(res.text);
        for (const button of buttons) {
          if (embedUrls.length >= 4) break;
          const embed = await fetchServerEmbedUrl(button, SITE + path);
          if (embed && embedUrls.indexOf(embed) < 0) {
            log('server button -> ' + embed.replace(/^https?:\/\//, '').slice(0, 60));
            embedUrls.push(embed);
          }
        }
        for (const embed of embedUrls.slice(0, 3)) {
          try {
            let items = [];
            const shareMatch = embed.match(/(?:share4max\.com|megamax\.me)\/iframe\/([a-zA-Z0-9_-]+)/);
            if (shareMatch) {
              items = await resolveShare4max(shareMatch[1]);
            } else if (/ok\.ru\/videoembed\//i.test(embed)) {
              const idM = embed.match(/videoembed\/(\d+)/i);
              const item = await resolveGenericMirror(
                'https://ok.ru/videoembed/' + (idM ? idM[1] : ''),
              );
              if (item) items.push(item);
            } else {
              const item = await resolveGenericMirror(embed);
              if (item) items.push(item);
            }
            for (const item of items) {
              item.serverId = item.serverId || embed;
              item.serverName = item.serverName || embed.replace(/^https?:\/\//, '').split('/')[0];
              streams.push(item);
              if (streams.length >= 3) break;
            }
            if (streams.length >= 2) break;
          } catch (e) {
            if (/video host has removed this file/.test(String(e.message || e))) unavailableReason = e.message;
            log('embed failed: ' + String(e.message || e).slice(0, 80));
          }
        }
      }

      if (!streams.length) {
        if (unavailableReason) throw new Error(unavailableReason);
        throw new Error('Shahiid: no playable stream could be extracted for ' + path.slice(0, 80)
          + ' — every server on this episode failed validation'
          + (embedUrls.length ? ' (' + embedUrls.length + ' upstream servers tried)' : ''));
      }

      const flatStreams = [];
      for (const s of streams) flatStreams.push(s.label, s.url);
      const primary = streams[0];
      return {
        url: primary.url,
        streams: flatStreams,
        qualities: streams.map((s) => ({
          label: s.label,
          url: s.url,
          headers: s.headers,
          height: s.height || undefined,
        })),
        servers: streams.map((s) => ({
          id: s.serverId || s.url,
          name: (s.serverName || 'Source') + (s.height ? ' ' + s.height + 'p' : ''),
          url: s.url,
          headers: s.headers,
          streamType: s.streamType || 'hls',
          lang: variant === 'dub' ? 'dub' : 'sub',
        })),
        headers: primary.headers || { 'User-Agent': USER_AGENT, Referer: SITE + '/' },
        lang: variant === 'dub' ? 'dub' : 'sub',
        streamType: primary.streamType || 'hls',
        defaultQuality: primary.label,
        subtitles: [],
      };
    } catch (err) {
      log('extractStreamUrl ERROR: ' + (err && err.stack ? err.stack : (err && err.message ? err.message : String(err))));
      throw err;
    }
  }

  // ---------- discovery ----------

  async function discoveryHome() {
    // The site's latest-episode cards are not series. Use its title archives
    // without resolving one parent page per card or opening any player.
    const subbed = await discoveryFeed('subbed', 1);
    const dubbed = await discoveryFeed('dubbed', 1);
    const movies = await discoveryFeed('movies', 1);
    const sections = [];
    const allCards = subbed.items;
    if (allCards.length >= 3) {
      sections.push({
        id: 'featured',
        title: 'مميز (Featured)',
        style: 'hero',
        items: allCards.slice(0, 6),
        viewAll: { mode: 'feed', feedId: 'subbed' },
      });
    }

    const dubbedCards = dubbed.items;
    if (dubbedCards.length) {
      sections.push({
        id: 'dubbed',
        title: 'أنمي مدبلج',
        style: 'poster',
        items: dubbedCards.slice(0, 24),
        viewAll: { mode: 'feed', feedId: 'dubbed' },
      });
    }

    const movieCards = movies.items;
    if (movieCards.length) {
      sections.push({
        id: 'movies',
        title: 'أفلام الأنمي',
        style: 'poster',
        items: movieCards.slice(0, 24),
        viewAll: { mode: 'feed', feedId: 'movies' },
      });
    }

    const subbedCards = subbed.items;
    if (subbedCards.length) {
      sections.push({
        id: 'subbed',
        title: 'مواسم الأنمي المترجم',
        style: 'poster',
        items: subbedCards.slice(0, 24),
        viewAll: { mode: 'feed', feedId: 'subbed' },
      });
    }

    return { sections: sections.slice(0, 6) };
  }

  async function discoveryFeed(feedId, page) {
    const pageNumber = Math.max(1, Number(page) || 1);
    const paths = {
      dubbed: '/seriesDubbed/',
      subbed: '/series/',
      movies: '/anime/',
      featured: '/series/',
      latest: '/series/',
    };
    const base = paths[String(feedId || '').toLowerCase()] || '/seriesDubbed/';
    const url = pageNumber > 1
      ? SITE + base.replace(/\/$/, '') + '/page/' + pageNumber + '/'
      : SITE + base;
    const res = await requestText(url);
    if (!res.ok) throw new Error('Shahiid: discovery feed request failed (HTTP ' + res.status + ')');
    if (looksLikeBlockPage(res.text)) throw new Error('Shahiid: discovery returned a block page');
    const items = parsePosterCards(res.text, true).slice(0, 30);
    const hasMore = new RegExp('/page/' + (pageNumber + 1) + '/', 'i').test(res.text);
    return { items: items, page: pageNumber, hasMore: hasMore };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
