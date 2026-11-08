(() => {
  'use strict';

  /**
   * Synthetiq One — thin client module (Pi/VPS API).
   * Discovery V1: Fast badge fields on EVERY card path.
   * Endless: more-fast = cached-only catalog.
   */

  const MODULE_NAME = 'SynthetiqOne';
  const DEFAULT_API = 'https://one.synthetiq.uk';
  const FALLBACK_API = 'https://candypop.uk/synthetiq-one';
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
      if (typeof globalThis !== 'undefined' && globalThis.SYNTHETIQ_ONE_API) {
        return String(globalThis.SYNTHETIQ_ONE_API).replace(/\/+$/, '');
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
    if (res.json !== undefined && res.json !== null && typeof res.json !== 'function') {
      try {
        return JSON.stringify(res.json);
      } catch (_) {}
    }
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

  async function request(url, options) {
    const cfg = options || {};
    const method = cfg.method || 'GET';
    const body = cfg.body == null ? null : cfg.body;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      ...(cfg.headers || {}),
    };

    try {
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(url, headers, method, body);
        const status = Number((res && res.status) || 0);
        const textBody = await readResponseBody(res);
        return { ok: isResponseOk(res, status), status, body: textBody };
      }
      if (typeof fetch === 'function') {
        const res = await fetch(url, { method, headers, body });
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
    if (primary !== FALLBACK_API) bases.push(FALLBACK_API);
    if (primary !== DEFAULT_API) bases.push(DEFAULT_API);

    let lastErr = null;
    for (const base of bases) {
      const url = base.replace(/\/+$/, '') + path;
      const res = await request(url);
      if (res.ok && res.body) {
        try {
          _activeBase = base.replace(/\/+$/, '');
          return JSON.parse(res.body);
        } catch (e) {
          lastErr = new Error('Synthetiq One API invalid JSON for ' + path);
        }
      } else {
        lastErr = new Error(
          'Synthetiq One API error ' + res.status + ' ' + path + ' @ ' + base,
        );
      }
    }
    throw lastErr || new Error('Synthetiq One API unreachable');
  }

  function parseMalId(raw) {
    const s = String(raw || '').trim();
    let m = s.match(/mal:(\d+)/i);
    if (m) return Number(m[1]);
    m = s.match(/^(\d+)$/);
    if (m) return Number(m[1]);
    m = s.match(/\/anime\/(\d+)/i);
    if (m) return Number(m[1]);
    return null;
  }

  function parseEpisodeHref(href) {
    const s = String(href || '').trim();
    let m = s.match(/mal:(\d+):ep:(\d+)/i);
    if (m) return { malId: Number(m[1]), ep: Number(m[2]) };
    m = s.match(/^(\d+)[:\/]ep[:\/]?(\d+)$/i);
    if (m) return { malId: Number(m[1]), ep: Number(m[2]) };
    m = s.match(/^(\d+)[:\/](\d+)$/);
    if (m) return { malId: Number(m[1]), ep: Number(m[2]) };
    return null;
  }

  /** Force Fast fields on every card the app might render. */
  function mapCard(item) {
    if (!item) return null;
    const malId = item.malId || parseMalId(item.href || item.id);
    const cached = !!(
      item.streamCached ||
      item.fast ||
      item.isFast ||
      item.cached
    );
    return {
      href: item.href || (malId ? 'mal:' + malId : ''),
      id: item.href || (malId ? 'mal:' + malId : ''),
      title: item.title || 'Unknown',
      image: item.image || item.posterUrl || '',
      posterUrl: item.image || item.posterUrl || '',
      streamCached: cached,
      fast: cached,
      isFast: cached,
      cached: cached,
      cacheExpiresAt: item.cacheExpiresAt || null,
      cachedEpisodeCount: Number(item.cachedEpisodeCount) || 0,
      description: item.description || undefined,
      year: item.year || undefined,
      rating: item.rating || undefined,
      mediaType: item.mediaType || item.media_type || undefined,
      isMovie: !!(item.isMovie || item.mediaType === 'movie' || item.media_type === 'movie'),
      isPopular: item.isPopular != null ? !!item.isPopular : cached,
      isTrending: item.isTrending != null ? !!item.isTrending : cached,
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
    if (section.viewAll && typeof section.viewAll === 'object') {
      out.viewAll = section.viewAll;
    }
    return out;
  }

  async function searchResults(query) {
    const q = String(query == null ? '' : query).trim();
    // Popular endless feed magic token from app
    if (/^__popular_page_\d+$/i.test(q)) {
      const page = Number((q.match(/(\d+)$/) || [])[1] || 1);
      const data = await apiGet(
        '/v1/discovery/feed?feedId=more-fast&page=' + encodeURIComponent(page),
      );
      const items = Array.isArray(data.items) ? data.items : [];
      return items.map(mapCard).filter((x) => x && x.href && x.title);
    }
    const data = await apiGet('/v1/search?q=' + encodeURIComponent(q));
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
    return items.map(mapCard).filter((x) => x && x.href && x.title);
  }

  /** Fire-and-forget: warm ep1 when user opens series detail (not search). */
  function kickPrefetch(malId, ep) {
    const mid = Number(malId);
    const episode = Math.max(1, Number(ep) || 1);
    if (!mid) return;
    const path =
      '/v1/prefetch?mal_id=' +
      encodeURIComponent(mid) +
      '&ep=' +
      encodeURIComponent(episode) +
      '&lang=dub';
    // Do not await — detail UI must not wait on warm.
    Promise.resolve()
      .then(function () {
        return apiGet(path);
      })
      .then(function (data) {
        log(
          'prefetch mal=' +
            mid +
            ' ep=' +
            episode +
            ' status=' +
            (data && data.status ? data.status : 'ok'),
        );
      })
      .catch(function (e) {
        log(
          'prefetch soft-fail: ' +
            (e && e.message ? e.message : String(e)),
        );
      });
  }

  async function extractDetails(urlOrId) {
    const malId = parseMalId(urlOrId);
    if (!malId) {
      return { title: 'Unknown', description: 'No description available.' };
    }
    const data = await apiGet('/v1/anime/' + malId);
    // User opened show detail → start preparing ep1 in background.
    kickPrefetch(malId, 1);
    const card = mapCard(data);
    return {
      title: card.title,
      description: data.description || 'No description available.',
      image: card.image,
      poster: card.image,
      backdrop: card.image,
      backdropUrl: card.image,
      year: data.year || 0,
      rating: data.rating || 0,
      streamCached: card.streamCached,
      fast: card.fast,
      isFast: card.fast,
      cached: card.fast,
      cachedEpisodeCount: card.cachedEpisodeCount,
      cacheExpiresAt: card.cacheExpiresAt,
      isPopular: card.isPopular,
      isTrending: card.isTrending,
      mediaType: card.mediaType,
      isMovie: card.isMovie,
    };
  }

  async function extractEpisodes(seriesId) {
    const malId = parseMalId(seriesId);
    if (!malId) return [];
    const data = await apiGet('/v1/anime/' + malId + '/episodes');
    // Safety: also kick prefetch if detail skipped / cached path hit episodes first.
    kickPrefetch(malId, 1);
    const items = Array.isArray(data.items) ? data.items : [];
    return items.map((ep) => ({
      href: ep.href || 'mal:' + malId + ':ep:' + ep.number,
      number: Number(ep.number) || 0,
      title: ep.title || '',
      subAvailable: !!ep.subAvailable,
      // One is a DUB-only catalog. The API may omit `dubAvailable` for a
      // cached movie even though `streamCachedDub` is true; exposing false
      // here makes the app's Dub filter hide its only playable episode.
      dubAvailable: !!(ep.dubAvailable || ep.streamCachedDub || ep.streamCached),
      isMovie: !!ep.isMovie,
      mediaType: ep.mediaType || undefined,
      streamCached: !!ep.streamCached,
      streamCachedSub: !!ep.streamCachedSub,
      streamCachedDub: !!ep.streamCachedDub,
    }));
  }

  async function extractStreamUrl(episodeHref, lang) {
    const parsed = parseEpisodeHref(episodeHref);
    if (!parsed || !parsed.malId || !parsed.ep) {
      return { streams: [] };
    }
    // DUB-only product — always request dub
    const L = 'dub';
    void lang;
    const path =
      '/v1/stream?mal_id=' +
      parsed.malId +
      '&ep=' +
      parsed.ep +
      '&lang=' +
      encodeURIComponent(L);
    let data;
    try {
      data = await apiGet(path);
    } catch (e) {
      // Dub missing → empty streams (app can fall back UI)
      log('stream error: ' + (e && e.message ? e.message : String(e)));
      return { streams: [] };
    }
    if (!data || !data.url) return { streams: [] };

    const headers =
      data.headers && typeof data.headers === 'object' ? data.headers : {};

    // Prefer API-expanded quality list (highest first, then Auto).
    // Shape: flat [label, url, ...] or object qualities[].
    let streams = [];
    if (Array.isArray(data.streams) && data.streams.length >= 2) {
      streams = data.streams.slice();
    } else if (Array.isArray(data.qualities) && data.qualities.length) {
      for (let i = 0; i < data.qualities.length; i++) {
        const q = data.qualities[i];
        const lab = String(
          (q && (q.label || q.quality || q.name)) || 'Auto',
        ).trim();
        const u = q && (q.url || q.file || q.src);
        if (u) {
          streams.push(lab, String(u));
        }
      }
      // ensure Auto master present
      if (data.url) streams.push('Auto', data.url);
    } else {
      const lab = data.defaultQuality || data.quality || data.lang || L;
      streams = [lab, data.url];
    }

    // Default play URL = first stream (API already sorts highest first)
    const defaultUrl =
      streams.length >= 2 ? streams[1] : data.url;
    const defaultLabel =
      streams.length >= 2 ? String(streams[0]) : data.defaultQuality || 'Auto';

    return {
      streams: streams,
      headers: headers,
      quality: defaultLabel,
      defaultQuality: data.defaultQuality || defaultLabel,
      qualities: Array.isArray(data.qualities) ? data.qualities : undefined,
      lang: data.lang || L,
      streamType: data.streamType || 'hls',
      cached: !!data.cached,
      url: defaultUrl,
    };
  }

  async function discoveryHome() {
    const data = await apiGet('/v1/discovery/home');
    const sections = Array.isArray(data.sections) ? data.sections : [];
    const mapped = sections.map(mapSection).filter(Boolean);
    // A cold or partially refreshed backend can occasionally return only the
    // hero section. Keep the home useful in that transient state by deriving
    // one regular poster row from the same verified Fast search catalogue.
    // This is deliberately module-local; it does not invent titles or bypass
    // the backend's cached-only rule.
    const hasBrowsableRow = mapped.some((section) => section.style !== 'hero');
    if (!hasBrowsableRow) {
      try {
        const fallbackData = await apiGet('/v1/search?q=');
        const fallbackItems = (
          Array.isArray(fallbackData.items)
            ? fallbackData.items
            : Array.isArray(fallbackData)
              ? fallbackData
              : []
        )
          .map(mapCard)
          .filter((item) => item && item.href)
          .slice(0, 40);
        if (fallbackItems.length) {
          mapped.push({
            id: 'fast-catalog-fallback',
            title: 'Fast Catalog',
            style: 'poster',
            items: fallbackItems,
            viewAll: { mode: 'feed', feedId: 'more-fast' },
          });
          log('discoveryHome supplied Fast Catalog fallback');
        }
      } catch (error) {
        log(
          'discoveryHome fallback unavailable: ' +
            (error && error.message ? error.message : String(error)),
        );
      }
    }
    return { sections: mapped };
  }

  async function discoveryFeed(feedId, page) {
    const id = encodeURIComponent(String(feedId || 'more-fast'));
    const p = Math.max(1, Number(page) || 1);
    const data = await apiGet(
      '/v1/discovery/feed?feedId=' + id + '&page=' + encodeURIComponent(p),
    );
    const items = Array.isArray(data.items)
      ? data.items.map(mapCard).filter((x) => x && x.href)
      : [];
    return {
      items: items,
      page: Number(data.page) || p,
      hasMore: !!data.hasMore,
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  log('loaded api=' + apiBase() + ' discovery_v1=true dub_only=true');
})();
