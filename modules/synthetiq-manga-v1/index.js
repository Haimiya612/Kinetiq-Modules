(() => {
  'use strict';

  /**
   * Synthetiq Manga — thin Fast client (VPS/local API).
   * Image module contract: search, details, chapters, images + discovery_v1.
   */

  const MODULE_NAME = 'SynthetiqManga';
  const DEFAULT_API = 'https://one.synthetiq.uk/manga';
  const FALLBACK_API = 'http://127.0.0.1:8788';
  const ALT_API = 'https://manga.synthetiq.uk';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  let _activeBase = DEFAULT_API;

  function log(msg) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(msg || ''));
    } catch (_) {}
  }

  function apiBase() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.SYNTHETIQ_MANGA_API) {
        return String(globalThis.SYNTHETIQ_MANGA_API).replace(/\/+$/, '');
      }
    } catch (_) {}
    return _activeBase || DEFAULT_API;
  }

  function isResponseOk(res, status) {
    if (res && (res.ok === true || res.ok === 1)) return true;
    if (res && (res.ok === false || res.ok === 0)) return false;
    return status >= 200 && status < 300;
  }

  async function readResponseBody(res) {
    if (!res) return '';
    if (typeof res.body === 'string' && res.body.length) return res.body;
    if (typeof res.json === 'function') {
      try {
        const parsed = await res.json();
        if (parsed !== undefined && parsed !== null) return JSON.stringify(parsed);
      } catch (_) {}
    }
    if (typeof res.text === 'function') {
      try {
        const text = await res.text();
        return typeof text === 'string' ? text : '';
      } catch (_) {
        return '';
      }
    }
    return '';
  }

  async function request(url) {
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
    };
    try {
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(url, headers, 'GET', null);
        const status = Number((res && res.status) || 0);
        const textBody = await readResponseBody(res);
        return { ok: isResponseOk(res, status), status, body: textBody };
      }
      if (typeof fetch === 'function') {
        const res = await fetch(url, { method: 'GET', headers });
        const textBody = await res.text();
        return { ok: !!res.ok, status: Number(res.status || 0), body: textBody };
      }
    } catch (error) {
      log('request error: ' + (error && error.message ? error.message : String(error)));
    }
    return { ok: false, status: 0, body: '' };
  }

  async function apiGet(path) {
    const bases = [];
    const primary = apiBase();
    bases.push(primary);
    if (primary !== DEFAULT_API) bases.push(DEFAULT_API);
    if (primary !== ALT_API) bases.push(ALT_API);
    if (primary !== FALLBACK_API) bases.push(FALLBACK_API);

    let lastErr = null;
    for (let i = 0; i < bases.length; i++) {
      const base = bases[i].replace(/\/+$/, '');
      const url = base + path;
      const res = await request(url);
      if (res.ok && res.body) {
        try {
          _activeBase = base;
          return JSON.parse(res.body);
        } catch (e) {
          lastErr = new Error('Synthetiq Manga API invalid JSON for ' + path);
        }
      } else {
        lastErr = new Error('Synthetiq Manga API error ' + res.status + ' ' + path + ' @ ' + base);
      }
    }
    throw lastErr || new Error('Synthetiq Manga API unreachable');
  }

  function mapCard(item) {
    if (!item) return null;
    const href = item.href || item.id || item.seriesId || '';
    if (!href) return null;
    const cached = !!(item.streamCached || item.fast || item.isFast || item.cached);
    return {
      href: href,
      id: href,
      title: item.title || 'Unknown',
      image: item.image || item.posterUrl || '',
      posterUrl: item.image || item.posterUrl || '',
      description: item.description || undefined,
      streamCached: cached,
      fast: cached,
      isFast: cached,
      cached: cached,
      cachedChapterCount: Number(item.cachedChapterCount) || 0,
      chapterCount: Number(item.chapterCount) || 0,
    };
  }

  function mapSection(section) {
    if (!section || !section.id) return null;
    const items = Array.isArray(section.items)
      ? section.items.map(mapCard).filter((x) => x && x.href)
      : [];
    if (!items.length) return null;
    const out = {
      id: String(section.id),
      title: String(section.title || section.id).slice(0, 80),
      style: section.style || 'poster',
      items: items,
    };
    if (section.viewAll && typeof section.viewAll === 'object') out.viewAll = section.viewAll;
    return out;
  }

  async function searchResults(query, page) {
    const q = String(query == null ? '' : query).trim();
    if (/^__popular_page_\d+$/i.test(q)) {
      const pageNum = Number((q.match(/(\d+)$/) || [])[1] || 1);
      const data = await apiGet(
        '/v1/discovery/feed?feedId=more-fast&page=' + encodeURIComponent(pageNum),
      );
      return (Array.isArray(data.items) ? data.items : []).map(mapCard).filter((x) => x && x.href);
    }
    if (!q) {
      const data = await apiGet('/v1/discovery/feed?feedId=more-fast&page=1');
      return (Array.isArray(data.items) ? data.items : []).map(mapCard).filter((x) => x && x.href);
    }
    const data = await apiGet('/v1/search?q=' + encodeURIComponent(q));
    return (Array.isArray(data.items) ? data.items : []).map(mapCard).filter((x) => x && x.href);
  }

  async function extractDetails(seriesId) {
    const id = String(seriesId || '').trim();
    const data = await apiGet('/v1/details?id=' + encodeURIComponent(id));
    return {
      title: data.title || 'Unknown',
      description: data.description || 'No description available.',
      image: data.image || data.posterUrl || undefined,
      status: data.status || undefined,
      type: data.type || undefined,
    };
  }

  async function extractChapters(seriesId) {
    const id = String(seriesId || '').trim();
    const data = await apiGet('/v1/chapters?id=' + encodeURIComponent(id));
    const items = Array.isArray(data.items) ? data.items : [];
    // Always emit a numeric `number`. App falls back to list index if missing,
    // which mis-labels newest chapters as "Ch 1" when the list is newest-first.
    const mapped = items.map((ch, index) => {
      let num = ch.number != null ? Number(ch.number) : NaN;
      if (!isFinite(num)) {
        const m = String(ch.title || '').match(
          /(?:chapter|chap|ch\.?)\s*[:#.-]?\s*(\d+(?:\.\d+)?)/i,
        );
        num = m ? parseFloat(m[1]) : index + 1;
      }
      return {
        href: ch.href || ch.id,
        id: ch.href || ch.id,
        number: num,
        chapterNumber: num,
        title: ch.title || 'Chapter ' + num,
      };
    });
    // Oldest → newest (matches app default chapter sort).
    mapped.sort(function (a, b) {
      if (a.number !== b.number) return a.number - b.number;
      return String(a.href).localeCompare(String(b.href));
    });
    return mapped;
  }

  async function extractImages(chapterId) {
    const id = String(chapterId || '').trim();
    const data = await apiGet('/v1/pages?id=' + encodeURIComponent(id));
    const pages = Array.isArray(data.pages)
      ? data.pages
      : Array.isArray(data.images)
        ? data.images
        : [];
    if (!pages.length) throw new Error('No cached pages for chapter ' + id);
    log('images cached=' + pages.length + ' chapter=' + id);
    return pages;
  }

  async function extractEpisodes(seriesId) {
    return extractChapters(seriesId);
  }

  async function extractStreamUrl(chapterId) {
    const images = await extractImages(chapterId);
    return images[0] || '';
  }

  async function discoveryHome() {
    const data = await apiGet('/v1/discovery/home');
    const sections = Array.isArray(data.sections)
      ? data.sections.map(mapSection).filter(Boolean)
      : [];
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    const id = encodeURIComponent(String(feedId || 'more-fast'));
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const data = await apiGet('/v1/discovery/feed?feedId=' + id + '&page=' + pageNum);
    return {
      items: (Array.isArray(data.items) ? data.items : []).map(mapCard).filter((x) => x && x.href),
      page: pageNum,
      hasMore: !!data.hasMore,
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractChapters = extractChapters;
  globalThis.extractImages = extractImages;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      searchResults,
      extractDetails,
      extractChapters,
      extractImages,
      extractEpisodes,
      extractStreamUrl,
      discoveryHome,
      discoveryFeed,
    };
  }
})();
