(() => {
  'use strict';

  const MODULE_NAME = 'An1me';
  const BASE_URL = 'https://an1me.to';
  const API_BASE = BASE_URL + '/wp-json/kiranime/v1';
  const KR_VIDEO = BASE_URL + '/kr-video/';
  const MAX_EPISODES = 1300;

  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
  const STREAM_HEADERS = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="138"',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    Origin: BASE_URL,
    Referer: BASE_URL + '/',
  };

  function log(msg) {
    try { console.log('[' + MODULE_NAME + '] ' + String(msg || '')); } catch (_) {}
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, Math.max(1, Number(ms) || 0))); }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([promise, sleep(waitMs).then(() => fallback)]);
  }

  function decodeHtml(str) {
    return String(str || '')
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#39;/g, "'")
      .replace(/&#038;/g, '&').replace(/&#38;/g, '&')
      .replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .trim();
  }

  function safeJsonParse(text) {
    if (text !== null && typeof text === 'object') return text;
    try { return JSON.parse(String(text == null ? '' : text).trim()); } catch (_) { return null; }
  }

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function stripTags(value) {
    return cleanText(decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ')));
  }

  function attrValue(tag, name) {
    const re = new RegExp("\\b" + name + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1", "i");
    const match = String(tag || '').match(re);
    return match ? decodeHtml(match[2]) : '';
  }

  function normalizeAnimeHref(value) {
    let href = decodeHtml(String(value || '').trim()).replace(/\\\//g, '/');
    if (!href) return '';
    if (href.startsWith('//')) href = 'https:' + href;
    if (href.startsWith('/')) href = BASE_URL + href;
    if (!/^https?:\/\/an1me\.to\/anime\//i.test(href)) return '';
    return href.replace(/\/$/, '');
  }

  async function readResponseBody(res) {
    if (!res) return '';
    if (res.json !== undefined && res.json !== null && typeof res.json !== 'function') {
      try { return JSON.stringify(res.json); } catch (_) {}
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
        const value = await res.json();
        return JSON.stringify(value);
      } catch (_) {}
    }
    return '';
  }

  async function request(url, options) {
    const cfg = options || {};
    const method = cfg.method || 'GET';
    const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json,*/*', 'Accept-Language': 'en-US,en;q=0.9' };
    if (cfg.headers) Object.assign(headers, cfg.headers);
    const body = cfg.body == null ? null : cfg.body;

    try {
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(url, headers, method, body);
        const status = Number((res && res.status) || 0);
        const textBody = await readResponseBody(res);
        let contentType = String((res && res.contentType) || '');
        if (!contentType && res && res.headers && typeof res.headers === 'object') {
          contentType = String(res.headers['content-type'] || res.headers['Content-Type'] || '');
        }
        return { ok: !!(res && (res.ok === true || (status >= 200 && status < 300))), status, body: textBody, json: safeJsonParse(textBody), contentType };
      }
      if (typeof fetch === 'function') {
        const res = await fetch(url, { method, headers, body });
        const textBody = await res.text();
        return { ok: !!res.ok, status: Number(res.status || 0), body: textBody, json: safeJsonParse(textBody), contentType: String((res && res.headers && res.headers.get) ? res.headers.get('content-type') || '' : '') };
      }
    } catch (e) {
      log('request error: ' + (e && e.message ? e.message : String(e)));
    }
    return { ok: false, status: 0, body: '', json: null };
  }

  async function apiGet(path) {
    const res = await request(BASE_URL + path, { headers: { Accept: 'application/json' } });
    if (!res.ok || !res.body) return null;
    try { return JSON.parse(res.body); } catch (_) { return null; }
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  function parseSearchHtml(html) {
    const source = decodeHtml(html);
    const items = [];
    const seen = new Set();
    const cards = [...source.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map(match => match[0]);
    // The WordPress JSON fallback returns a list of <a> rows rather than
    // <article> cards. Parsing the whole source as one card used to keep only
    // its first title, which is often a movie or recap entry.
    const chunks = cards;
    for (const card of chunks) {
      const hrefMatch = card.match(/(?:href|window\.location\.href)\s*=\s*["']((?:https?:\/\/an1me\.to)?\/anime\/[^"']+)["']/i);
      const href = normalizeAnimeHref(hrefMatch && hrefMatch[1]);
      if (!href || seen.has(href)) continue;

      const titleMatch = card.match(/group-data-\[language=en\]\/body:hidden[^>]*>([\s\S]*?)<\/span>/i);
      const jsonName = (card.match(/"name"\s*:\s*"((?:\\.|[^"\\])*)"/i) || [])[1] || '';
      const imageTag = (card.match(/<img\b[^>]*>/i) || [])[0] || '';
      const image = attrValue(imageTag, 'src') || attrValue(imageTag, 'data-src');
      const slugTitle = href.replace(/^https?:\/\/an1me\.to\/anime\//i, '').replace(/-/g, ' ');
      const title = stripTags(titleMatch && titleMatch[1]) || decodeHtml(jsonName) || attrValue(imageTag, 'alt') || cleanText(slugTitle);
      seen.add(href);
      items.push({ title, href: href.replace(/^https?:\/\/an1me\.to\/anime\//i, ''), image });
    }

    if (!cards.length) {
      const links = [...source.matchAll(/(?:href|window\.location\.href)\s*=\s*["']((?:https?:\/\/an1me\.to)?\/anime\/[^"']+)["']/gi)];
      for (const match of links) {
        const href = normalizeAnimeHref(match[1]);
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const end = source.indexOf('</a>', match.index);
        const fragment = end >= 0 ? source.slice(Math.max(0, source.lastIndexOf('<a', match.index)), end + 4) : source.slice(match.index, match.index + 1200);
        const imageTag = (fragment.match(/<img\b[^>]*>/i) || [])[0] || '';
        const titleMatch = fragment.match(/group-data-\[language=en\]\/body:hidden[^>]*>([\s\S]*?)<\/span>/i);
        items.push({
          title: stripTags(titleMatch && titleMatch[1]) || attrValue(imageTag, 'alt') || cleanText(href.replace(/^https?:\/\/an1me\.to\/anime\//i, '').replace(/-/g, ' ')),
          href: href.replace(/^https?:\/\/an1me\.to\/anime\//i, ''),
          image: attrValue(imageTag, 'src') || attrValue(imageTag, 'data-src') || '',
        });
      }
    }
    return items;
  }

  // Search titles on An1me are a mixture of English names, romanized names,
  // seasons, movies, and recap entries. Keep the aliases small and explicit so
  // a normal title wins over a related franchise entry without hiding results.
  const TITLE_ALIASES = {
    attackontitan: ['shingekinokyojin'],
    shingekinokyojin: ['attackontitan'],
    demonslayer: ['kimetsunoyaiba'],
    kimetsunoyaiba: ['demonslayer'],
    myheroacademia: ['bokunoheroacademia'],
    bokunoheroacademia: ['myheroacademia'],
  };

  function titleKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function titleVariants(query) {
    const key = titleKey(query);
    return [key].concat(TITLE_ALIASES[key] || []).filter(Boolean);
  }

  function searchTitleScore(title, query) {
    const value = titleKey(title);
    if (!value) return 0;
    const variants = titleVariants(query);
    let score = 0;
    for (const variant of variants) {
      if (value === variant) score = Math.max(score, variant === variants[0] ? 1200 : 1050);
      else if (value.indexOf(variant) === 0) score = Math.max(score, variant === variants[0] ? 700 : 620);
      else if (value.indexOf(variant) >= 0) score = Math.max(score, variant === variants[0] ? 350 : 300);
    }
    const queryKey = titleKey(query);
    const hasFranchiseQualifier = /(?:movie|film|season|part|ova|ona|special|recap|kanketsu|final)/i.test(String(title || ''));
    if (hasFranchiseQualifier && !/(?:movie|film|season|part|ova|ona|special|recap|final)/i.test(String(query || ''))) {
      score -= 120;
    }
    // An exact alias remains stronger than a season or movie entry.
    if (variants.length > 1 && value === variants[1]) score += 80;
    return score + (queryKey && value === queryKey ? 100 : 0);
  }

  function sortSearchResults(items, query) {
    return items.sort((a, b) => {
      const scoreA = searchTitleScore(a.title, query);
      const scoreB = searchTitleScore(b.title, query);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  function parseSearchPayload(res) {
    const payload = res && (res.json || safeJsonParse(res.body));
    const html = payload && payload.data && payload.data.html
      ? payload.data.html
      : payload && payload.html
        ? payload.html
        : typeof payload === 'string'
          ? payload
          : '';
    return parseSearchHtml(html);
  }

  async function searchSite(query, pageNumber) {
    const body = [
      's_keyword=' + encodeURIComponent(query),
      'orderby=popular',
      'order=DESC',
      'action=advanced_search',
      'page=' + encodeURIComponent(pageNumber),
    ].join('&');
    const headers = {
      Accept: 'application/json,text/html,*/*',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE_URL,
      Referer: BASE_URL + '/search/',
    };

    // The public AJAX handler currently serves GET reliably while POST is
    // rate-limited (429) for some clients. Use the same parameters and fall
    // back to POST for older site versions.
    const getRes = await request(BASE_URL + '/wp-admin/admin-ajax.php?' + body, {
      method: 'GET',
      headers: {
        ...headers,
      },
    });
    let items = getRes.ok ? parseSearchPayload(getRes) : [];
    if (items.length) return items;

    const postRes = await request(BASE_URL + '/wp-admin/admin-ajax.php', {
      method: 'POST',
      body,
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    });
    items = postRes.ok ? parseSearchPayload(postRes) : [];
    return items;
  }

  async function searchResults(query, page) {
    const q = String(query == null ? '' : query).trim();
    const pageNumber = Math.max(1, Number(page) + 1 || 1);
    if (!q) return [];
    try {
      let raw = await searchSite(q, pageNumber);
      if (!raw.length && /jojo/i.test(q)) raw = await searchSite('jojo', pageNumber);
      if (!raw.length && /bizarre\\s+adventure/i.test(q)) raw = await searchSite(q.replace(/bizarre\\s+adventure/ig, '').trim(), pageNumber);
      if (!raw.length) {
        const res = await request(API_BASE + '/anime/search?query=' + encodeURIComponent(q));
        if (res.ok && res.json) raw = parseSearchHtml(decodeHtml(res.json.result || res.body || ''));
      }
      if (!raw.length) return [];
      sortSearchResults(raw, q);
      // The AJAX endpoint already applies pageNumber. Slicing again here used
      // to discard page 2+ results and made search appear incomplete.
      return raw.slice(0, 30);
    } catch (e) {
      log('search error: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  // ── Details ────────────────────────────────────────────────────────────────

  async function extractDetails(urlOrId) {
    const slug = String(urlOrId || '')
      .replace(/^https?:\/\/an1me\.to\/(?:anime\/)?/i, '')
      .replace(/^\/?(?:anime\/)?/i, '')
      .replace(/\/$/, '');
    if (!slug) return { title: 'Unknown', description: '' };
    const res = await settleWithin(request(BASE_URL + '/anime/' + slug + '/'), 7000, null);
    const body = (res && res.ok && res.body) || '';
    const meta = name => {
      for (const match of body.matchAll(/<meta\b[^>]*>/gi)) {
        const tag = match[0];
        const key = attrValue(tag, 'property') || attrValue(tag, 'name');
        if (key.toLowerCase() === String(name).toLowerCase()) return attrValue(tag, 'content');
      }
      return '';
    };
    const ogTitle = meta('og:title');
    const ogDesc = meta('og:description');
    const ogImage = meta('og:image');
    const malImg = (body.match(/https:\/\/(?:cdn\.)?myanimelist\.net\/images\/anime\/[^"'\s]+/g) || [])[0] || '';
    const h1 = stripTags((body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
    const notFound = !body || res.status === 404 || res.status === 410 || /<title>\s*Page not found/i.test(body);
    const title = notFound
      ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : (cleanText(ogTitle || h1 || slug.replace(/-/g, ' ')).replace(/.*Watch\s+/, '').replace(/.*Παρακολουθήστε\s+/, '').replace(/\s*-?\s*(?:online Free on An1me\.to).*/i, '').trim() || slug.replace(/-/g, ' '));
    return {
      title: title || 'An1me',
      description: notFound ? '' : stripTags(ogDesc || ''),
      image: ogImage || malImg || '',
      href: slug,
    };
  }

  // ── Episodes ───────────────────────────────────────────────────────────────

  const AJAX_BASE = BASE_URL + '/wp-admin/admin-ajax.php';

  function seriesAudioAvailability(html) {
    let sub = false;
    let dub = false;
    // WordPress marks only this title's taxonomy ancestors, unlike the generic
    // Sub/Dub description and the always-present navigation links.
    for (const match of String(html || '').matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)) {
      const tag = match[0].match(/^<li\b[^>]*>/i)[0];
      const classes = attrValue(tag, 'class').split(/\s+/);
      if (!classes.includes('current-anime-ancestor') && !classes.includes('current-anime-parent')) continue;
      for (const link of match[0].matchAll(/<a\b[^>]*>/gi)) {
        const href = attrValue(link[0], 'href');
        const language = href.match(/^(?:https:\/\/an1me\.to)?\/anime_attribute\/(sub|dub)\/?$/i);
        if (language && language[1].toLowerCase() === 'sub') sub = true;
        if (language && language[1].toLowerCase() === 'dub') dub = true;
      }
    }
    // Unknown metadata must not advertise a Dub that the site never supplied.
    return { subAvailable: sub || !dub, dubAvailable: dub };
  }

  async function fetchAjaxEpisodes(animeId, maxPages, availability) {
    const eps = [];
    const seen = new Set();
    const pages = Math.min(Math.max(1, Number(maxPages) || 1), 40);
    for (let page = 1; page <= pages; page++) {
      const url = AJAX_BASE + '?action=get_episodes&anime_id=' + animeId + '&page=' + page + '&order=asc';
      const res = await settleWithin(request(url, { headers: { Accept: 'application/json' } }), 6000, null);
      if (!res || !res.ok || !res.body) break;
      let data = null;
      try { data = JSON.parse(res.body); } catch (_) { break; }
      if (!data || data.success !== true || !data.data) break;
      const items = Array.isArray(data.data.episodes) ? data.data.episodes : [];
      if (!items.length) break;
      const maxPage = Number(data.data.max_episodes_page) || 1;
      for (const item of items) {
        const epUrl = String((item && item.url) || '');
        if (!epUrl || seen.has(epUrl)) continue;
        seen.add(epUrl);
        const numStr = String((item && item.number) || '');
        const numMatch = numStr.match(/(\d+)/);
        const num = numMatch ? Number(numMatch[1]) : (item && item.meta_number ? Number(item.meta_number) : eps.length + 1);
        eps.push({
          number: num,
          href: epUrl,
          title: 'Episode ' + num,
          ...availability,
        });
        if (eps.length >= MAX_EPISODES) return eps;
      }
      if (page >= maxPage) break;
    }
    return eps;
  }

  async function probeAjaxHasEpisodes(animeId) {
    const url = AJAX_BASE + '?action=get_episodes&anime_id=' + animeId + '&page=1&order=asc';
    const res = await settleWithin(request(url, { headers: { Accept: 'application/json' } }), 6000, null);
    if (!res || !res.ok || !res.body) return false;
    try {
      const data = JSON.parse(res.body);
      return !!(data && data.success === true && data.data && Array.isArray(data.data.episodes) && data.data.episodes.length);
    } catch (_) {
      return false;
    }
  }

  async function extractEpisodes(seriesId) {
    const slug = String(seriesId || '')
      .replace(/^https?:\/\/an1me\.to\/(?:anime\/)?/i, '')
      .replace(/^\/?(?:anime\/)?/i, '')
      .replace(/\/$/, '');
    if (!slug) return [];

    // The series API remains available when WordPress watch pages fail.
    const seriesPage = await settleWithin(request(BASE_URL + '/anime/' + slug + '/'), 6000, null);
    const seriesBody = seriesPage && seriesPage.ok ? seriesPage.body : '';
    const availability = seriesAudioAvailability(seriesBody);
    const identity = seriesBody.match(/postid-(\d+)/);
    log('Series identity=' + (identity && identity[1]) + ', status=' + (seriesPage && seriesPage.status));
    if (identity) {
      const first = await apiGet('/wp-admin/admin-ajax.php?action=get_episodes&anime_id=' + identity[1] + '&page=1&order=asc');
      log('Episode first page success=' + (first && first.success) + ', pages=' + (first && first.data && first.data.max_episodes_page));
      if (first && first.success && first.data && Array.isArray(first.data.episodes) && first.data.episodes.length) {
        const pages = Number(first.data.max_episodes_page) || 1;
        if (!Number.isInteger(pages) || pages < 1 || pages > 60) throw new Error('Unsupported episode page count');
        let items = first.data.episodes.slice();
        for (let page = 2; page <= pages; page += 3) {
          const jobs = [];
          for (let p = page; p < page + 3 && p <= pages; p++) {
            jobs.push((async function (n) {
              const path = '/wp-admin/admin-ajax.php?action=get_episodes&anime_id=' + identity[1] + '&page=' + n + '&order=asc';
              let data = await settleWithin(apiGet(path), 5000, null);
              const valid = function (value) { return value && value.success && value.data && Array.isArray(value.data.episodes) && value.data.episodes.length > 0; };
              if (!valid(data)) data = await settleWithin(apiGet(path), 5000, null);
              if (!valid(data)) {
                log('Episode page unavailable: page=' + n + ', success=' + (data && data.success));
                throw new Error('Episode page unavailable; retry');
              }
              return data.data.episodes;
            })(p));
          }
          const batch = await Promise.all(jobs);
          batch.forEach(function (rows) { items = items.concat(rows); });
        }
        const seen = new Set();
        log('Episode API rows=' + items.length + ', parent=' + (items[0] && items[0].parent_slug) + ', slug=' + slug);
        return items.filter(function (item) {
          if (item.parent_slug && item.parent_slug !== slug) return false;
          if (!/^https:\/\/an1me\.to\/watch\//.test(item.url || '') || seen.has(item.url)) return false;
          seen.add(item.url);
          return Number(item.meta_number) > 0 || /\d/.test(item.number || '');
        }).map(function (item) {
          const number = Number(item.meta_number) || Number(String(item.number).match(/\d+/)[0]);
          return {number: number, href: item.url, title: stripTags(item.title || 'Episode ' + number), image: item.thumbnail || '', ...availability};
        }).sort(function (a, b) { return a.number - b.number; }).slice(0, MAX_EPISODES);
      }
    }

    // 1) Traditional watch page scrape (works for most series)
    const watchUrl = BASE_URL + '/watch/' + slug + '-episode-1/';
    const res = await settleWithin(request(watchUrl), 10000, null);
    const body = (res && res.ok && res.body) || '';
    const pageNotFound = !body || res.status === 404 || res.status === 410 || /<title>\s*Page not found/i.test(body);
    if (!pageNotFound) {
      const eps = [];
      const seen = new Set();
      const re = /href=["']((?:https:\/\/an1me\.to)?\/watch\/[^"']+)["'][^>]*data-episode-search-query=["'](\d+)["']/gi;
      let m;
      while ((m = re.exec(body))) {
        const num = Number(m[2]);
        if (!num || seen.has(num)) continue;
        seen.add(num);
        eps.push({ number: num, href: m[1], title: 'Episode ' + num, ...availability });
        if (eps.length >= MAX_EPISODES) break;
      }
      if (eps.length) {
        eps.sort((a, b) => a.number - b.number);
        return eps;
      }
      // Fallback: build from data attributes
      const maxEp = Math.max(1, ...([...body.matchAll(/data-episode-search-query=["'](\d+)["']/gi)].map(x => Number(x[1]))));
      if (maxEp > 1) {
        const eps2 = [];
        for (let n = 1; n <= Math.min(maxEp, MAX_EPISODES); n++) {
          eps2.push({ number: n, href: BASE_URL + '/watch/' + slug + '-episode-' + n + '/', title: 'Episode ' + n, ...availability });
        }
        return eps2;
      }
    }

    // 2) Movie fallback: bare slug URL (movies have no episode grid)
    const movieUrl = BASE_URL + '/watch/' + slug + '/';
    const movieRes = await settleWithin(request(movieUrl), 8000, null);
    if (movieRes && movieRes.ok && movieRes.body && !/<title>\s*Page not found/i.test(movieRes.body)) {
      return [{ number: 1, href: movieUrl, title: 'Movie', ...availability }];
    }

    // 3) AJAX API fallback (multi-season shows, Pokemon, etc.)
    const detailRes = await settleWithin(request(BASE_URL + '/anime/' + slug + '/'), 10000, null);
    const detailBody = (detailRes && detailRes.ok && detailRes.body) || '';
    if (detailBody) {
      const postIdMatch = detailBody.match(/postid-(\d+)/);
      const seasonIds = [...new Set([...detailBody.matchAll(/data-season="(\d+)"/g)].map(x => x[1]))];
      const tryIds = [];
      if (postIdMatch) tryIds.push(postIdMatch[1]);
      for (const sid of seasonIds) {
        if (!tryIds.includes(sid)) tryIds.push(sid);
      }
      for (const animeId of tryIds.slice(0, 3)) {
        if (!(await probeAjaxHasEpisodes(animeId))) continue;
        const ajaxEps = await fetchAjaxEpisodes(animeId, 40, seriesAudioAvailability(detailBody));
        if (ajaxEps.length) {
          // Filter to episodes matching this show's slug
          const matching = ajaxEps.filter(e => e.href.includes(slug));
          if (matching.length) {
            matching.sort((a, b) => a.number - b.number);
            return matching.slice(0, MAX_EPISODES);
          }
          // If no slug match but this is the post ID, return all (franchise page)
          if (animeId === (postIdMatch && postIdMatch[1])) {
            ajaxEps.sort((a, b) => a.number - b.number);
            return ajaxEps.slice(0, MAX_EPISODES);
          }
        }
      }
    }

    return [];
  }

  // ── Stream ─────────────────────────────────────────────────────────────────

  function streamHeadersForUrl(url) {
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="138"',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    };
    // Google-hosted media rejects the An1me Origin/Referer pair even though
    // the signed route itself is valid. Keep those headers for An1me/CDN
    // routes, but let the media host validate the signed URL directly.
    if (!/googleusercontent\.com|googlevideo\.com/i.test(String(url || ''))) {
      headers.Origin = BASE_URL;
      headers.Referer = /cdn\.an1me\.io/.test(url) ? BASE_URL + '/kr-video/' : BASE_URL + '/';
    }
    return headers;
  }

  async function resolveStreamUrl(krVideoPageUrl) {
    const res = await settleWithin(
      request(krVideoPageUrl, {
        headers: { Referer: BASE_URL + '/', Accept: 'text/html,application/xhtml+xml,*/*' },
      }),
      10000,
      null,
    );
    if (!res || !res.ok || !res.body) return [];
    const match = res.body.match(/const\s+params\s*=\s*(\{[^;]+)/);
    if (!match) return [];
    try {
      const params = JSON.parse(match[1].replace(/\\\//g, '/').replace(/\\\\/g, '\\'));
      const sources = Array.isArray(params.sources) ? params.sources : [];
      const out = [];
      const seenUrls = Object.create(null);
      for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        const url = String((s && s.url) || '');
        if (!url.startsWith('http')) continue;
        if (seenUrls[url]) continue;
        seenUrls[url] = true;
        // File-transfer hosts (WeTransfer) hand out signed URLs with ~2h JWT
        // tokens. Prefer An1/CDN/Google routes, but keep a probed WeTransfer
        // file as last resort when a new episode has no other host yet.
        const ephemeral = /wetransfer\.com/i.test(url);
        const stype = (s && s.type) && String(s.type).includes('mpegURL') ? 'hls' : 'mp4';
        const qualityInfo = sourceQuality(s, url);
        out.push({
          label: qualityInfo.label + (sources.length > 1 ? ' ' + (i + 1) : ''),
          url: url,
          streamType: stype,
          height: qualityInfo.height,
          headers: streamHeadersForUrl(url),
          ephemeral: ephemeral,
        });
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  // An1me's Google-hosted MP4 entries do not end in .mp4. They commonly carry
  // YouTube-compatible format ids instead, so preserve the quality exposed by
  // the site instead of making the app display an unknown/auto quality.
  function sourceQuality(source, url) {
    const rawValues = [
      source && source.html,
      source && source.quality,
      source && source.label,
      source && source.name,
      source && source.resolution,
      source && source.height,
    ];
    const text = rawValues
      .map(value => String(value == null ? '' : value).trim())
      .find(value => value && !/^null|undefined$/i.test(value)) || '';
    const heightValue = source && (source.height || source.resolutionHeight || source.heightPx);
    const explicitHeight = Number(heightValue);
    const labelledHeight = text.match(/(\d{3,4})\s*p/i);
    const urlHeight = String(url || '').match(/(?:^|[^\d])(\d{3,4})p(?:[^\d]|$)/i);
    const formatId = String(url || '').match(/[?&=]m(18|22)(?:$|[&#])/i);
    const formatHeights = { '18': 360, '22': 720 };
    const height = Number.isFinite(explicitHeight) && explicitHeight > 0
      ? explicitHeight
      : labelledHeight
        ? Number(labelledHeight[1])
        : urlHeight
          ? Number(urlHeight[1])
          : formatId
            ? formatHeights[formatId[1]]
            : null;
    if (height) return { label: height + 'p', height };
    const cleaned = text.replace(/HLS\s+Stream/i, 'Auto').trim();
    return { label: cleaned || 'Auto', height: null };
  }

  function absoluteUrl(value, base) {
    const ref = String(value || '').trim();
    const baseText = String(base || '').trim();
    if (!ref || !baseText) return '';
    if (/^https?:\/\//i.test(ref)) return encodeURI(ref);
    const origin = (baseText.match(/^(https?:\/\/[^/]+)/i) || [])[1] || '';
    if (!origin) return '';
    if (ref.startsWith('/')) return encodeURI(origin + ref);
    const directory = baseText.replace(/[^/]*$/, '');
    return encodeURI(directory + ref.replace(/^\.\//, ''));
  }

  function playlistVariantUrl(body, baseUrl) {
    const lines = String(body || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith('#')) continue;
        return absoluteUrl(lines[j], baseUrl);
      }
    }
    return '';
  }

  function firstMediaReference(body, baseUrl) {
    const lines = String(body || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      if (/\.m3u8(?:[?#]|$)/i.test(line)) continue;
      return absoluteUrl(line, baseUrl);
    }
    return '';
  }

  // Some server entries advertise an HLS URL but actually contain a slideshow
  // of JPG segments. Downloads can save that response, while a video player
  // never receives decodable video. Drop only that false-HLS shape and keep
  // genuine HLS or MP4 fallbacks available.
  //
  // Some hosts (An1me) disguise REAL MPEG-TS video segments behind .jpg/.png
  // filenames. A genuine stream still advertises real video codecs
  // (avc1/hev1/av01) or a real RESOLUTION in the master #EXT-X-STREAM-INF
  // lines, so a master carrying either is treated as a real stream regardless
  // of the segment extension. A slideshow master never lists video codecs or
  // resolutions.
  async function isImageSequenceHls(url) {
    const headers = streamHeadersForUrl(url);
    const master = await settleWithin(request(url, { headers }), 5000, null);
    if (!master || !master.ok || !master.body || !/#EXTM3U/i.test(master.body)) return false;
    const masterIsVideo = /CODECS="[^"]*(?:avc1|av01|hev1|vp09|vp9)[^"]*"/i.test(master.body) ||
      /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=/i.test(master.body);
    if (masterIsVideo) return false;
    let playlistBody = master.body;
    let playlistUrl = url;
    const variantUrl = playlistVariantUrl(master.body, url);
    if (variantUrl) {
      const variant = await settleWithin(request(variantUrl, { headers: streamHeadersForUrl(variantUrl) }), 5000, null);
      if (!variant || !variant.ok || !variant.body || !/#EXTM3U/i.test(variant.body)) return false;
      playlistBody = variant.body;
      playlistUrl = variantUrl;
    }
    const mediaUrl = firstMediaReference(playlistBody, playlistUrl);
    return /\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(mediaUrl);
  }

  function decodeB64(str) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let s = String(str || '').replace(/[^A-Za-z0-9+/=]/g, '');
    while (s.length % 4) s += '=';
    const result = [];
    for (let i = 0; i < s.length; i += 4) {
      const a = chars.indexOf(s[i] || 'A');
      const b = chars.indexOf(s[i + 1] || 'A');
      const c = chars.indexOf(s[i + 2] || 'A');
      const d = chars.indexOf(s[i + 3] || 'A');
      result.push((a << 2) | (b >> 4));
      if (s[i + 2] !== '=') result.push(((b & 15) << 4) | (c >> 2));
      if (s[i + 3] !== '=') result.push(((c & 3) << 6) | d);
    }
    const out = [];
    for (const byte of result) {
      if (byte < 128) out.push(byte);
      else if (byte < 2048) { out.push(192 | (byte >> 6)); out.push(128 | (byte & 63)); }
      else { out.push(224 | (byte >> 12)); out.push(128 | ((byte >> 6) & 63)); out.push(128 | (byte & 63)); }
    }
    let text = '';
    for (let i = 0; i < out.length; i++) text += String.fromCharCode(out[i] & 0xFF);
    return text;
  }

  // Range-probe a candidate route and decide whether it can actually deliver
  // media. Dead Google Photos entries return 403/302 or JPEG bytes; wetransfer
  // tokens expire to 403; real HLS returns 200/206 with a playlist or binary.
  async function probeStreamCandidate(url, declaredType) {
    const headers = streamHeadersForUrl(url);
    headers['Range'] = 'bytes=0-1000';
    const res = await settleWithin(request(url, { headers }), 7000, null);
    // Googleusercontent signed media can return the redirecter's 403/HTML
    // response to a server-side probe while still being playable by the
    // device player. The An1 player declares these routes as video/mp4; keep
    // the route only when that declaration is present and the host is the
    // expected signed-media host.
    if (!res || !res.ok) {
      return false;
    }
    const ct = String(res.contentType || '').toLowerCase();
    if (!ct || ct.includes('text/html') || ct.includes('text/plain')) {
      return false;
    }
    if (ct.includes('image/')) {
      // Some hosts (An1me) serve REAL MPEG-TS segments as image/jpeg. Only
      // accept an image content-type when the URL is a segment within an
      // already-verified HLS chain; bare image responses are rejected here.
      return false;
    }
    const head = String(res.body || '').substring(0, 8).toLowerCase();
    if (head.startsWith('<')) return false;
    return true;
  }

  function normalizeWatchHref(value) {
    let href = decodeHtml(String(value || '').trim());
    if (!href) return '';
    if (href.startsWith('//')) href = 'https:' + href;
    if (href.startsWith('/')) href = BASE_URL + href;
    return href;
  }

  async function extractStreamUrl(episodeHref, lang) {
    const watchHref = normalizeWatchHref(episodeHref);
    const res = await settleWithin(
      request(watchHref, { headers: { Accept: 'text/html,application/xhtml+xml,*/*' } }),
      12000,
      null,
    );
    if (!res || !res.body) return { streams: [] };
    if (!res.ok) {
      const canonical = (res.body.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1];
      const sameEpisode = canonical && canonical.replace(/\/$/, '') === watchHref.replace(/\/$/, '');
      if (res.status !== 500 || !sameEpisode || !/postid-\d+/.test(res.body) || !/data-embed-id=/.test(res.body)) return {streams: []};
    }
    const body = res.body;
    const wantDub = String(lang || 'sub').toLowerCase() === 'dub';
    const embedIds = [...body.matchAll(/data-embed-id="([^"]+)"/g)].map(x => x[1]);
    if (!embedIds.length) return { streams: [] };

    // Classify servers: sub vs dub
    const subServers = [];
    const dubServers = [];
    for (const eid of embedIds) {
      const colonIdx = eid.indexOf(':');
      if (colonIdx < 0) continue;
      const nameB64 = eid.slice(0, colonIdx);
      let name = '';
      try { name = decodeB64(nameB64).toLowerCase(); } catch (_) {}
      const iframeB64 = eid.slice(colonIdx + 1);
      const iframe = decodeB64(iframeB64);
      if (/invalid video url/i.test(iframe)) continue;
      const srcMatch = iframe.match(/src=["']([^"']+)["']/i);
      if (!srcMatch) continue;
      const krUrl = decodeHtml(srcMatch[1]);
      if (!/^https?:\/\//i.test(krUrl)) continue;
      // Check for dub/sub in server name
      const isDub = /dub|μεταγλ/i.test(name);
      if (isDub) {
        dubServers.push({ name, krUrl });
      } else {
        subServers.push({ name, krUrl });
      }
    }

    const preferred = wantDub ? dubServers : subServers;
    const routeResults = await Promise.all(preferred.slice(0, 6).map(async server => {
      try {
        const resolved = await resolveStreamUrl(server.krUrl);
        return resolved.map(s => ({ ...s, serverName: server.name }));
      } catch (_) {
        return [];
      }
    }));
    const results = routeResults.flat().map(s => ({
      ...s,
      label: (wantDub ? 'DUB' : 'SUB') + ' • ' + s.label,
    }));
    const hlsChecks = await Promise.all(results.map(async stream => ({
      stream,
      imageSequence: stream.streamType === 'hls' ? await isImageSequenceHls(stream.url) : false,
    })));
    let playableResults = hlsChecks
      .filter(entry => !entry.imageSequence)
      .map(entry => entry.stream);
    // Range-probe every surviving candidate and drop dead routes (Google
    // Photos 403/JPEG, expired wetransfer tokens). Real HLS hosts accept a
    // small range; dead links refuse.
    const probed = await Promise.all(playableResults.map(async stream => {
      const ok = await probeStreamCandidate(stream.url, stream.streamType);
      return ok ? stream : null;
    }));
    playableResults = probed.filter(s => s !== null);
    const durable = playableResults.filter(s => !s.ephemeral);
    if (durable.length) playableResults = durable;

    // Ordering: the site's own An1 server HLS is the most reliable (real
    // MPEG-TS video), then verified MP4 files, then anything else.
    // WeTransfer stays last because its signed URL expires in about two hours.
    const score = (s) => {
      const host = String(s.url || '');
      const an1 = String(s.serverName || '').includes('an1');
      let base = 30;
      if (s.ephemeral) base = 80;
      else if (/googleusercontent|googlevideo/i.test(host) && s.streamType === 'mp4') base = 0;
      else if (s.streamType === 'mp4') base = 8;
      else if (an1 && s.streamType === 'hls' && s.height) base = 12;
      else if (an1 && s.streamType === 'hls') base = 18;
      else if (s.streamType === 'hls') base = 22;
      return base;
    };
    playableResults.sort((a, b) => score(a) - score(b));

    if (!playableResults.length) return { streams: [] };
    const packed = playableResults.map(s => ({
      url: s.url,
      headers: s.headers,
      streamType: /\.m3u8(?:[?#]|$)/i.test(s.url) ? 'hls' : s.streamType,
      label: s.label,
      language: 'el',
      lang: wantDub ? 'dub' : 'sub',
      height: s.height || undefined,
    }));
    return {
      url: packed[0].url,
      streams: [packed[0].label, packed[0].url],
      servers: playableResults.map(function (s) {
        return {name: s.serverName || s.label, url: s.url, headers: s.headers,
          streamType: /\.m3u8(?:[?#]|$)/i.test(s.url) ? 'hls' : s.streamType, lang: wantDub ? 'dub' : 'sub', subtitles: []};
      }),
      subtitles: [],
      headers: packed[0].headers,
      streamType: packed[0].streamType,
      quality: packed[0].label || 'auto',
      lang: wantDub ? 'dub' : 'sub',
      language: 'el',
    };
  }

  // ── Discovery / Home ──────────────────────────────────────────────────────

  async function scrapeHomepageCards() {
    const res = await settleWithin(request(BASE_URL + '/'), 12000, null);
    if (!res || !res.ok || !res.body) return [];
    const body = res.body;
    const items = [];
    const seen = new Set();

    // Normalise a title so that "Naruto: Shippuuden", "naruto-shippuuden" and
    // "Naruto Shippuuden" all compare equal, while "Bleach" and
    // "Bleach: Sennen Kessen-hen - Kashin-tan" remain distinct.
    const norm = t => String(t == null ? '' : t)
      .replace(/&amp;/g, '&')
      .toLowerCase()
      .replace(/[:;.!?,–—'"«»]/g, '')
      .replace(/[()]/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 1) List cards: the <a> wraps its own local poster image and carries the
    //    exact display title in the title="" attribute. Pair them directly.
    const listCardRe =
      /<a\b[^>]*href="(https:\/\/an1me\.to\/anime\/[^"]+)"[^>]*title="([^"]*)"[^>]*>\s*<img\b[^>]*src='([^']+)'/g;
    const localImageByTitle = {};
    let lc;
    while ((lc = listCardRe.exec(body))) {
      const href = lc[1];
      if (href.includes('#') || href.includes('?')) continue;
      const title = cleanText(lc[2]);
      const img = lc[3].replace(/-\d+x\d+(?=\.\w+$)/, '');
      if (!title || !img.startsWith('http')) continue;
      const key = norm(title);
      if (!key) continue;
      if (!localImageByTitle[key]) {
        localImageByTitle[key] = { href, title, image: img };
      }
    }

    // 2) Spotlight/hero cards: the MAL poster <img> (with alt=title) appears
    //    right before the <a> that carries the display title.
    const malByTitle = {};
    const malRe =
      /<img\b[^>]*src='(https:\/\/(?:cdn\.)?myanimelist\.net\/images\/anime\/[^']+)'[^>]*?\salt='([^']*)'/g;
    let im;
    while ((im = malRe.exec(body))) {
      const key = norm(im[2]);
      if (!key) continue;
      if (!malByTitle[key]) malByTitle[key] = im[1];
    }

    // 3) Every /anime/ link with its display title attribute.
    const linkRe =
      /<a\b[^>]*href="(https:\/\/an1me\.to\/anime\/[^"]+)"[^>]*title="([^"]*)"[^>]*>/g;
    const links = [];
    const seenHrefs = new Set();
    let lm;
    while ((lm = linkRe.exec(body))) {
      const href = lm[1];
      if (href.includes('#') || href.includes('?')) continue;
      if (seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      links.push({ href, title: cleanText(lm[2]) });
    }
    // 3b) Spotlight/hero anchors carry no title="" attribute; the English
    //     display name lives in the second <span> (language=en).
    const heroRe =
      /<a\b[^>]*href="(https:\/\/an1me\.to\/anime\/[^"]+)"[^>]*>\s*<h2[\s\S]*?group-data-\[language=en\]\/body:hidden[^>]*>([^<]*)<\/span>/g;
    let hm;
    while ((hm = heroRe.exec(body))) {
      const href = hm[1];
      if (href.includes('#') || href.includes('?')) continue;
      if (seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      links.push({ href, title: cleanText(hm[2]) });
    }

    for (let i = 0; i < links.length && items.length < 40; i++) {
      const { href, title } = links[i];
      const slug = href.replace(/^https:\/\/an1me\.to\/anime\//, '').replace(/\/$/, '');
      if (seen.has(slug)) continue;
      seen.add(slug);
      const key = norm(title);
      const slugKey = norm(slug.replace(/-/g, ' '));
      const paired = localImageByTitle[key];
      const image =
        (paired && paired.image) ||
        malByTitle[key] ||
        malByTitle[slugKey] ||
        '';
      items.push({
        title: title || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        href: slug,
        image,
      });
    }
    if (!items.length) {
      for (const { href } of links) {
        const slug = href.replace(/^https:\/\/an1me\.to\/anime\//, '').replace(/\/$/, '');
        items.push({ title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), href: slug, image: '' });
        if (items.length >= 40) break;
      }
    }
    return items;
  }

  async function discoveryHome() {
    try {
      const cards = await scrapeHomepageCards();
      const sections = [];
      if (cards.length) {
        const hero = cards.slice(0, 6).map((c, i) => ({ ...c, rank: i + 1 }));
        sections.push({ id: 'featured', title: 'Featured', style: 'hero', items: hero });
        sections.push({
          id: 'browse',
          title: 'Browse',
          style: 'poster',
          items: cards.slice(0, 30),
          viewAll: { mode: 'feed', feedId: 'browse' },
        });
      }
      return { sections };
    } catch (e) {
      log('discovery error: ' + (e && e.message ? e.message : String(e)));
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedId, page) {
    const key = String(feedId || 'browse').toLowerCase();
    const pageNumber = Math.max(1, Number(page) || 1);
    if (key !== 'browse' || !Number.isInteger(pageNumber) || pageNumber > 500) return {items: [], page: pageNumber, hasMore: false};
    const path = pageNumber === 1 ? '/anime/' : '/anime/page/' + pageNumber + '/';
    const res = await settleWithin(request(BASE_URL + path), 7000, null);
    if (!res || !res.ok) throw new Error('Catalogue page unavailable; retry');
    const items = parseSearchHtml(res.body);
    const next = '/anime/page/' + (pageNumber + 1) + '/';
    return {items: items, page: pageNumber, hasMore: items.length > 0 && res.body.includes(next)};
  }

  // Support empty search = browse popular
  const _origSearchResults = searchResults;
  searchResults = async function (query, pg) {
    const q = String(query == null ? '' : query).trim();
    if (!q) {
      const cards = await scrapeHomepageCards();
      const pageNumber = Math.max(1, Number(pg) + 1 || 1);
      const start = (pageNumber - 1) * 30;
      return start <= 0 ? cards : cards.slice(start, start + 30);
    }
    return _origSearchResults(q, pg);
  };

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { searchResults, extractDetails, extractEpisodes, extractStreamUrl, discoveryHome, discoveryFeed };
  }
})();
