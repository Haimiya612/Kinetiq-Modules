(function () {
  'use strict';

  var MODULE_NAME = 'YASTREAM';
  var BASE_URL = 'https://yastream.tamthai.de';
  var USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
  var PAGE_ACCEPT = 'application/json,text/plain,*/*;q=0.8';
  var HLS_ACCEPT = 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*;q=0.8';
  var feedFirstIds = Object.create(null);

  var FEEDS = {
    'kisskh-korean': { type: 'series', id: 'kisskh.Korean', title: 'KissKH Korean' },
    'onetouchtv-korean': { type: 'series', id: 'onetouchtv.Korean', title: 'OneTouchTV Korean' },
    'kisskh-movies': { type: 'movie', id: 'kisskh.Search', title: 'KissKH Movies' }
  };

  function clean(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&quot;/gi, '"')
      .replace(/&#039;|&#x27;/gi, "'")
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function log(message) {
    if (typeof console !== 'undefined' && console.log) {
      console.log('[' + MODULE_NAME + '] ' + String(message));
    }
  }

  function isHttp(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
  }

  function absoluteUrl(value, base) {
    var text = clean(value).replace(/\\\//g, '/');
    if (!text) return '';
    if (/^\/\//.test(text)) return 'https:' + text;
    if (isHttp(text)) return text;
    if (text.charAt(0) === '/') return String(base || BASE_URL).replace(/\/$/, '') + text;
    return String(base || BASE_URL).replace(/\/$/, '') + '/' + text;
  }

  function resolveRelativeUrl(value, base) {
    var text = clean(value).replace(/\\\//g, '/');
    if (!text) return '';
    if (isHttp(text)) return text;
    var baseText = clean(base).split(/[?#]/)[0];
    var schemeMatch = baseText.match(/^([a-z][a-z0-9+.-]*:)/i);
    var scheme = schemeMatch ? schemeMatch[1] : 'https:';
    if (/^\/\//.test(text)) return scheme + text;
    var originMatch = baseText.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i);
    var origin = originMatch ? originMatch[1] : BASE_URL;
    if (text.charAt(0) === '/') return origin + text;
    var slash = baseText.lastIndexOf('/');
    return (slash >= 0 ? baseText.slice(0, slash + 1) : baseText + '/') + text;
  }

  function asPositiveInt(value, fallback) {
    var number = parseInt(value, 10);
    return isFinite(number) && number > 0 ? number : (fallback || 0);
  }

  function yearOf(value) {
    var text = clean(value);
    var match = text.match(/(?:19|20)\d{2}/);
    return match ? parseInt(match[0], 10) : 0;
  }

  function streamHeaders() {
    return {
      'User-Agent': USER_AGENT,
      Referer: BASE_URL + '/',
      Origin: BASE_URL
    };
  }

  async function readBody(response) {
    if (!response) return '';
    var bodyText = typeof response.body === 'string' ? response.body : null;
    if (bodyText) return bodyText;
    if (response.json && typeof response.json === 'object') {
      try { return JSON.stringify(response.json); } catch (_) {}
    }
    var textValue = null;
    if (typeof response.text === 'function') {
      try {
        var text = await response.text();
        if (typeof text === 'string') {
          textValue = text;
          if (text) return text;
        }
      } catch (_) {}
    }
    if (typeof response.json === 'function') {
      try {
        var json = await response.json();
        return json === null || json === undefined ? '' : JSON.stringify(json);
      } catch (_) {}
    }
    if (bodyText !== null) return bodyText;
    if (textValue !== null) return textValue;
    if (response.body && typeof response.body === 'object') {
      try { return JSON.stringify(response.body); } catch (_) {}
    }
    return '';
  }

  async function requestText(url, extraHeaders) {
    var headers = {
      'User-Agent': USER_AGENT,
      Accept: PAGE_ACCEPT,
      Referer: BASE_URL + '/'
    };
    var extras = extraHeaders || {};
    Object.keys(extras).forEach(function (key) { headers[key] = extras[key]; });
    var response;
    try {
      if (typeof globalThis.fetchv2 === 'function') {
        response = await globalThis.fetchv2(url, headers, 'GET', null);
      } else if (typeof fetch === 'function') {
        response = await fetch(url, { method: 'GET', headers: headers });
      } else {
        throw new Error('fetch bridge unavailable');
      }
    } catch (error) {
      return { ok: false, status: 0, text: '', error: error && error.message ? error.message : 'request failed' };
    }
    var status = Number(response && response.status) || 0;
    return {
      ok: status >= 200 && status < 400,
      status: status,
      text: await readBody(response),
      error: ''
    };
  }

  async function requestJson(url) {
    var response = await requestText(url, { Accept: PAGE_ACCEPT });
    if (!response.ok || !response.text) {
      throw new Error('YASTREAM request failed (' + response.status + ')');
    }
    try {
      return JSON.parse(response.text);
    } catch (_) {
      throw new Error('YASTREAM returned invalid JSON');
    }
  }

  function encodeId(value) {
    return encodeURIComponent(clean(value));
  }

  function makeRoute(kind, type, id) {
    return BASE_URL + '/' + kind + '/' + type + '/' + encodeId(id) + '.json';
  }

  function parseRoute(value) {
    var raw = clean(value);
    var withoutQuery = raw.split('?')[0].split('#')[0];
    var match = withoutQuery.match(/\/(meta|stream|subtitles)\/(movie|series)\/([^/]+?)(?:\.json)?$/i);
    if (match) {
      var decoded = match[3];
      try { decoded = decodeURIComponent(decoded); } catch (_) {}
      return { kind: match[1].toLowerCase(), type: match[2].toLowerCase(), id: decoded };
    }
    if (raw) {
      return { kind: '', type: /^onetouchtv:/i.test(raw) ? 'series' : 'series', id: raw };
    }
    return null;
  }

  function catalogUrl(type, catalogId, query, page) {
    var skip = Math.max(0, (asPositiveInt(page, 1) - 1) * 20);
    var url = BASE_URL + '/catalog/' + type + '/' + encodeURIComponent(catalogId) + '.json?skip=' + skip;
    if (query) url += '&search=' + encodeURIComponent(query);
    return url;
  }

  function rawMetas(payload) {
    return payload && Array.isArray(payload.metas) ? payload.metas : [];
  }

  function mapCard(raw, fallbackType) {
    if (!raw || typeof raw !== 'object') return null;
    var type = clean(raw.type || fallbackType || 'series').toLowerCase();
    if (type !== 'movie' && type !== 'series') type = fallbackType || 'series';
    var id = clean(raw.id);
    var title = clean(raw.name || raw.title);
    if (!id || !title) return null;
    var image = absoluteUrl(raw.poster || raw.image || raw.thumbnail, BASE_URL);
    var backdrop = absoluteUrl(raw.background || raw.backdrop || image, BASE_URL);
    return {
      id: makeRoute('meta', type, id),
      href: makeRoute('meta', type, id),
      url: makeRoute('meta', type, id),
      title: title,
      name: title,
      image: image,
      poster: image,
      thumbnail: image,
      backdrop: backdrop,
      description: clean(raw.description || raw.overview || raw.synopsis),
      year: yearOf(raw.releaseInfo || raw.year || raw.released),
      rating: Number(raw.rating || raw.score || 0) || 0,
      tags: raw.country ? [clean(raw.country)] : [],
      type: type,
      isMovie: type === 'movie',
      subAvailable: true,
      dubAvailable: false
    };
  }

  function dedupeCards(items) {
    var seen = Object.create(null);
    return (items || []).filter(function (item) {
      var key = item && (item.href || item.id);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function queryMatches(item, query) {
    var q = clean(query).toLowerCase();
    if (!q) return true;
    var title = clean(item && (item.title || item.name)).toLowerCase();
    if (title.indexOf(q) >= 0) return true;
    var tokens = q.split(/\s+/).filter(Boolean);
    return tokens.every(function (token) { return title.indexOf(token) >= 0; });
  }

  async function fetchCatalog(type, id, query, page) {
    var payload = await requestJson(catalogUrl(type, id, query, page));
    return rawMetas(payload).map(function (raw) { return mapCard(raw, type); }).filter(Boolean);
  }

  async function searchResults(query, page) {
    var q = clean(query);
    if (!q) {
      var home = await discoveryFeed('kisskh-korean', 1);
      return home.items || [];
    }
    var results = [];
    var routes = [
      { type: 'series', id: 'kisskh.Search' },
      { type: 'series', id: 'onetouchtv.Search' },
      { type: 'movie', id: 'kisskh.Search' }
    ];
    for (var i = 0; i < routes.length; i += 1) {
      try {
        var cards = await fetchCatalog(routes[i].type, routes[i].id, q, page || 1);
        results = results.concat(cards.filter(function (item) { return queryMatches(item, q); }));
      } catch (error) {
        log('search route failed: ' + routes[i].id);
      }
    }
    return dedupeCards(results).slice(0, 40);
  }

  async function discoveryHome() {
    var configs = [
      { feedId: 'kisskh-korean', type: 'series', id: 'kisskh.Korean', title: 'KissKH Korean' },
      { feedId: 'onetouchtv-korean', type: 'series', id: 'onetouchtv.Korean', title: 'OneTouchTV Korean' },
      { feedId: 'kisskh-movies', type: 'movie', id: 'kisskh.Search', title: 'KissKH Movies' }
    ];
    var sections = [];
    for (var i = 0; i < configs.length; i += 1) {
      try {
        var items = (await fetchCatalog(configs[i].type, configs[i].id, '', 1)).slice(0, 12);
        if (items.length) sections.push({ id: configs[i].feedId, title: configs[i].title, items: items });
      } catch (error) {
        log('home route failed: ' + configs[i].id);
      }
    }
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    var config = FEEDS[feedId] || FEEDS['kisskh-korean'];
    var pageNumber = asPositiveInt(page, 1);
    try {
      var items = await fetchCatalog(config.type, config.id, '', pageNumber);
      var first = items.length ? items[0].href : '';
      if (pageNumber > 1 && first && feedFirstIds[feedId] === first) {
        return { feedId: feedId, page: pageNumber, items: [], hasMore: false };
      }
      if (pageNumber === 1) feedFirstIds[feedId] = first;
      return { feedId: feedId, page: pageNumber, items: items, hasMore: items.length >= 20 };
    } catch (error) {
      return { feedId: feedId, page: pageNumber, items: [], hasMore: false, error: String(error && error.message || error) };
    }
  }

  async function fetchMeta(ref) {
    var candidates = [];
    if (ref && ref.kind === 'meta' && ref.type && ref.id) candidates.push(makeRoute('meta', ref.type, ref.id));
    if (ref && ref.id) {
      candidates.push(makeRoute('meta', 'series', ref.id));
      candidates.push(makeRoute('meta', 'movie', ref.id));
    }
    var lastError = null;
    for (var i = 0; i < candidates.length; i += 1) {
      try {
        var payload = await requestJson(candidates[i]);
        if (payload && payload.meta) return { type: candidates[i].indexOf('/movie/') >= 0 ? 'movie' : 'series', meta: payload.meta };
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('metadata unavailable');
  }

  function mapMeta(meta, type, ref) {
    var title = clean(meta && (meta.name || meta.title)) || 'Unavailable';
    var image = absoluteUrl(meta && (meta.poster || meta.image || meta.thumbnail), BASE_URL);
    var backdrop = absoluteUrl(meta && (meta.background || meta.backdrop || image), BASE_URL);
    var id = clean(meta && meta.id) || clean(ref && ref.id);
    var href = makeRoute('meta', type, id);
    var tags = [];
    if (meta && meta.country) tags.push(clean(meta.country));
    if (meta && Array.isArray(meta.genres)) tags = tags.concat(meta.genres.map(clean).filter(Boolean));
    return {
      id: href,
      href: href,
      url: href,
      title: title,
      name: title,
      image: image,
      poster: image,
      thumbnail: image,
      backdrop: backdrop,
      description: clean(meta && (meta.description || meta.overview || meta.synopsis)),
      year: yearOf(meta && (meta.released || meta.releaseInfo || meta.year)),
      rating: Number(meta && (meta.rating || meta.score || 0)) || 0,
      tags: tags,
      type: type,
      isMovie: type === 'movie',
      subAvailable: true,
      dubAvailable: false
    };
  }

  async function extractDetails(urlOrId) {
    var ref = parseRoute(urlOrId);
    try {
      var loaded = await fetchMeta(ref);
      return mapMeta(loaded.meta, loaded.type, ref);
    } catch (error) {
      return {
        id: clean(urlOrId), href: clean(urlOrId), title: 'Unavailable', name: 'Unavailable',
        image: '', poster: '', backdrop: '', description: '', year: 0, tags: [],
        type: 'series', isMovie: false, subAvailable: true, dubAvailable: false,
        error: String(error && error.message || error)
      };
    }
  }

  function mapEpisode(meta, type, video, index) {
    var rawId = clean(video && video.id) || clean(meta && meta.id);
    if (!rawId) return null;
    var season = asPositiveInt(video && (video.season || video.seasonNumber), type === 'movie' ? 1 : 0);
    var number = asPositiveInt(video && (video.episode || video.number || video.episodeNumber), index + 1);
    var streamHref = makeRoute('stream', type, rawId);
    var poster = absoluteUrl(video && (video.thumbnail || video.poster || video.background), BASE_URL) ||
      absoluteUrl(meta && meta.poster, BASE_URL);
    var baseTitle = clean(video && (video.title || video.name)) || (type === 'movie' ? clean(meta.name) : 'Episode ' + number);
    var displayTitle = type === 'movie' ? baseTitle : 'S' + (season || 1) + 'E' + number + ' - ' + baseTitle;
    return {
      id: streamHref,
      href: streamHref,
      number: number,
      episodeNumber: number,
      season: season || 1,
      seasonNumber: season || 1,
      title: displayTitle,
      name: baseTitle,
      image: poster,
      poster: poster,
      thumbnail: poster,
      description: clean(video && (video.description || video.overview)),
      subAvailable: true,
      dubAvailable: false
    };
  }

  async function extractEpisodes(seriesId) {
    var ref = parseRoute(seriesId);
    try {
      var loaded = await fetchMeta(ref);
      var videos = loaded.meta && Array.isArray(loaded.meta.videos) ? loaded.meta.videos : [];
      if (!videos.length) videos = [{ id: loaded.meta && loaded.meta.id, title: loaded.meta && loaded.meta.name, season: 1, episode: 1 }];
      var seen = Object.create(null);
      var output = videos.map(function (video, index) {
        var episode = mapEpisode(loaded.meta, loaded.type, video, index);
        if (!episode || seen[episode.href]) return null;
        seen[episode.href] = true;
        return episode;
      }).filter(Boolean);
      output.sort(function (a, b) {
        return (a.season - b.season) || (a.number - b.number);
      });
      return output;
    } catch (error) {
      log('extractEpisodes failed');
      return [];
    }
  }

  function languageLabel(code) {
    var text = clean(code).toLowerCase();
    var labels = { eng: 'English', en: 'English', ara: 'Arabic', ar: 'Arabic', khm: 'Khmer', km: 'Khmer', ind: 'Indonesian', id: 'Indonesian', fra: 'French', fr: 'French', spa: 'Spanish', es: 'Spanish', ita: 'Italian', it: 'Italian', msa: 'Malay', may: 'Malay', vie: 'Vietnamese', vie: 'Vietnamese', zho: 'Chinese', zh: 'Chinese', tha: 'Thai', th: 'Thai' };
    return labels[text] || (text ? text.toUpperCase() : 'Subtitle');
  }

  function mapSubtitles(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (raw) {
      if (!raw || typeof raw !== 'object') return null;
      var url = absoluteUrl(raw.url || raw.file, BASE_URL);
      if (!url) return null;
      var lang = clean(raw.lang || raw.language || 'und');
      return { url: url, file: url, lang: lang, language: lang, label: clean(raw.label) || languageLabel(lang), headers: streamHeaders() };
    }).filter(Boolean);
  }

  function dedupeSubtitles(items) {
    var seen = Object.create(null);
    return (items || []).filter(function (item) {
      var key = item.url + '|' + item.lang;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function masterVariantUrl(playlist, base) {
    var lines = String(playlist || '').split(/\r?\n/);
    var variants = [];
    for (var i = 0; i < lines.length; i += 1) {
      var line = clean(lines[i]);
      if (line.toUpperCase().indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
      var bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
      var bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
      for (var j = i + 1; j < lines.length; j += 1) {
        var candidate = clean(lines[j]);
        if (!candidate || candidate.charAt(0) === '#') continue;
        var resolved = resolveRelativeUrl(candidate, base);
        if (resolved) variants.push({ url: resolved, bandwidth: bandwidth });
        break;
      }
    }
    variants.sort(function (a, b) { return b.bandwidth - a.bandwidth; });
    return variants.length ? variants[0].url : '';
  }

  async function prepareHlsUrl(url) {
    var response = await requestText(url, { Accept: HLS_ACCEPT });
    if (!response.ok) {
      // Keep an unprobed URL only for transport failures. An explicit HTTP
      // error is a bad candidate and should not win the player race.
      return { url: url, valid: response.status === 0 };
    }
    var body = String(response.text || '').trim();
    if (body.indexOf('#EXTM3U') < 0) return { url: url, valid: true };
    var child = masterVariantUrl(body, url);
    return { url: child || url, valid: true };
  }

  function streamPreference(stream) {
    var url = clean(stream && stream.url).toLowerCase();
    var score = 0;
    // Prefer a directly addressable media playlist. Some older decoders do
    // not follow protocol-relative child playlists in a master manifest.
    if (url.indexOf('/master/') >= 0) score -= 20;
    if (url.indexOf('/child/') >= 0) score += 10;
    if (url.indexOf('.m3u8') >= 0) score += 2;
    return score;
  }

  async function extractStreamUrl(episodeHref, lang) {
    var requested = clean(lang || 'sub').toLowerCase() || 'sub';
    if (requested === 'dub' || requested === 'vf') {
      return { streams: [], subtitles: [], lang: requested, error: { message: 'YASTREAM exposes original-audio streams; no verified dub route is available.' } };
    }
    var ref = parseRoute(episodeHref);
    if (!ref || !ref.id) return { streams: [], subtitles: [], lang: requested, error: { message: 'Invalid YASTREAM episode reference' } };
    var loaded;
    try {
      loaded = await requestJson(ref.kind === 'stream' ? makeRoute('stream', ref.type, ref.id) : makeRoute('stream', ref.type || 'series', ref.id));
    } catch (error) {
      return { streams: [], subtitles: [], lang: requested, error: { message: String(error && error.message || error) } };
    }
    var rawStreams = loaded && Array.isArray(loaded.streams) ? loaded.streams : [];
    var streams = [];
    for (var index = 0; index < rawStreams.length; index += 1) {
      var raw = rawStreams[index];
      var url = absoluteUrl(raw && (raw.url || raw.file || raw.stream), BASE_URL);
      if (!url) continue;
      var type = /\.m3u8(?:$|[?#])/i.test(url) ? 'hls' : (/\.mp4(?:$|[?#])/i.test(url) ? 'mp4' : 'hls');
      var label = clean(raw.name || raw.title || raw.description) || ('Source ' + (index + 1));
      if (type === 'hls') {
        var prepared = await prepareHlsUrl(url);
        if (!prepared.valid) continue;
        url = prepared.url;
      }
      streams.push({ label: label, title: label, url: url, quality: clean(raw.title) || 'Auto', streamType: type, kind: type, headers: streamHeaders() });
    }
    streams.sort(function (a, b) { return streamPreference(b) - streamPreference(a); });
    if (!streams.length) return { streams: [], subtitles: [], lang: requested, error: { message: 'YASTREAM returned no media URL' } };
    var subtitles = [];
    rawStreams.forEach(function (raw) { subtitles = subtitles.concat(mapSubtitles(raw && raw.subtitles)); });
    try {
      var subtitlePayload = await requestJson(makeRoute('subtitles', ref.type || 'series', ref.id));
      subtitles = subtitles.concat(mapSubtitles(subtitlePayload && subtitlePayload.subtitles));
    } catch (_) {}
    var primary = streams[0];
    return {
      url: primary.url,
      stream: primary.url,
      streams: streams,
      headers: primary.headers,
      streamType: primary.streamType,
      quality: primary.quality,
      lang: 'sub',
      audioLanguage: 'original',
      subtitles: dedupeSubtitles(subtitles)
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { searchResults: searchResults, extractDetails: extractDetails, extractEpisodes: extractEpisodes, extractStreamUrl: extractStreamUrl, discoveryHome: discoveryHome, discoveryFeed: discoveryFeed };
  }
})();
