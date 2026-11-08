(function () {
  'use strict';

  var MODULE_NAME = 'StreamingUnity';
  var BASE_URL = 'https://streamingunity.vip';
  var VIX_BASE = 'https://vixcloud.co';
  var DEFAULT_CDN = 'https://cdn.streamingunity.vip';
  var USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  var PAGE_ACCEPT =
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  var HLS_ACCEPT =
    'application/vnd.apple.mpegurl,application/x-mpegURL,application/octet-stream,text/plain,*/*;q=0.8';

  var titlePageCache = Object.create(null);

  function log(message) {
    if (typeof console !== 'undefined' && console.log) {
      console.log('[' + MODULE_NAME + '] ' + String(message));
    }
  }

  function decodeEntities(value) {
    if (value === null || value === undefined) return '';
    var text = String(value);
    for (var i = 0; i < 3; i += 1) {
      var decoded = text
        .replace(/&quot;/gi, '"')
        .replace(/&#039;|&#x27;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&nbsp;/gi, ' ');
      if (decoded === text) break;
      text = decoded;
    }
    return text;
  }

  function cleanText(value) {
    return decodeEntities(value).replace(/\s+/g, ' ').trim();
  }

  function decodeUrlPart(value) {
    try {
      return decodeURIComponent(String(value || ''));
    } catch (_) {
      return String(value || '');
    }
  }

  function numberOr(value, fallback) {
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : fallback;
  }

  function positiveInt(value, fallback) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function truthyFlag(value, defaultValue) {
    if (value === null || value === undefined || value === '') {
      return defaultValue === undefined ? false : defaultValue;
    }
    if (value === true || value === 1) return true;
    var text = String(value).toLowerCase().trim();
    if (text === '1' || text === 'true' || text === 'yes' || text === 'on') {
      return true;
    }
    if (text === '0' || text === 'false' || text === 'no' || text === 'off') {
      return false;
    }
    return Boolean(value);
  }

  function isHttp(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
  }

  function absoluteUrl(value, base) {
    var text = cleanText(value).replace(/\\\//g, '/');
    if (!text) return '';
    if (/^\/\//.test(text)) return 'https:' + text;
    if (isHttp(text)) return text;
    if (text.charAt(0) === '/') return String(base || BASE_URL).replace(/\/$/, '') + text;
    return String(base || BASE_URL).replace(/\/$/, '') + '/' + text;
  }

  async function requestText(url, extraHeaders) {
    var headers = {
      'User-Agent': USER_AGENT,
      Accept: PAGE_ACCEPT,
      Referer: BASE_URL + '/'
    };
    var extras = extraHeaders || {};
    Object.keys(extras).forEach(function (key) {
      headers[key] = extras[key];
    });

    var response = null;
    try {
      if (typeof globalThis.fetchv2 === 'function') {
        response = await globalThis.fetchv2(url, headers, 'GET', null);
      } else if (typeof fetch === 'function') {
        response = await fetch(url, { method: 'GET', headers: headers });
      }
    } catch (error) {
      return {
        status: 0,
        ok: false,
        text: '',
        headers: {},
        error: error && error.message ? error.message : 'request failed'
      };
    }

    var status = Number(response && response.status) || 0;
    var body = '';
    if (response && typeof response.body === 'string') {
      body = response.body;
    }
    if (!body && response && typeof response.text === 'function') {
      try {
        var textValue = await response.text();
        if (typeof textValue === 'string') body = textValue;
      } catch (_) {}
    }
    if (!body && response && response.json && typeof response.json === 'object') {
      try {
        body = JSON.stringify(response.json);
      } catch (_) {}
    }
    if (!body && response && typeof response.json === 'function') {
      try {
        var jsonValue = await response.json();
        if (jsonValue !== null && jsonValue !== undefined) {
          body = JSON.stringify(jsonValue);
        }
      } catch (_) {}
    }

    var outputHeaders = {};
    if (response && response.headers) {
      if (typeof response.headers.forEach === 'function') {
        response.headers.forEach(function (value, key) {
          outputHeaders[String(key).toLowerCase()] = String(value);
        });
      } else {
        Object.keys(response.headers).forEach(function (key) {
          outputHeaders[String(key).toLowerCase()] = String(response.headers[key]);
        });
      }
    }

    return {
      status: status,
      ok: status >= 200 && status < 400,
      text: body || '',
      headers: outputHeaders,
      error: ''
    };
  }

  function parsePageData(html) {
    var source = String(html || '');
    var trimmed = source.trim();
    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try {
        return JSON.parse(decodeEntities(trimmed));
      } catch (_) {}
    }
    var match = source.match(/\bdata-page\s*=\s*"([^"]*)"/i) ||
      source.match(/\bdata-page\s*=\s*'([^']*)'/i);
    if (match && match[1]) {
      try {
        return JSON.parse(decodeEntities(match[1]));
      } catch (_) {}
    }

    var next = source.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (next && next[1]) {
      try {
        return JSON.parse(decodeEntities(next[1].trim()));
      } catch (_) {}
    }

    var initial = source.match(/(?:window\.__INITIAL_STATE__|__INITIAL_STATE__)\s*=\s*([\s\S]*?);\s*(?:window\.|<\/script|$)/i);
    if (initial && initial[1]) {
      try {
        return JSON.parse(decodeEntities(initial[1].trim()));
      } catch (_) {}
    }
    return null;
  }

  async function requestPage(url) {
    var result = await requestText(url, { Accept: PAGE_ACCEPT });
    if (!result.ok || !result.text) {
      throw new Error('StreamingUnity page unavailable (' + result.status + ')');
    }
    var page = parsePageData(result.text);
    if (!page || typeof page !== 'object') {
      throw new Error('StreamingUnity page data missing');
    }
    return page;
  }

  function propsOf(page) {
    if (!page || typeof page !== 'object') return {};
    return page.props && typeof page.props === 'object' ? page.props : page;
  }

  function cdnFromProps(props) {
    var candidate = props && props.cdn_url;
    return isHttp(candidate) ? String(candidate).replace(/\/$/, '') : DEFAULT_CDN;
  }

  function imageUrl(value, cdn) {
    if (!value) return '';
    if (typeof value === 'object') {
      var original = value.original_url_field || value.url || value.src;
      if (isHttp(original)) return String(original);
      value = value.filename || value.file || value.path || '';
    }
    var text = cleanText(value);
    if (!text || text === 'null' || text === 'undefined') return '';
    if (isHttp(text)) return text;
    if (text.indexOf('//') === 0) return 'https:' + text;
    if (text.charAt(0) === '/') {
      if (text.indexOf('/images/') === 0) return String(cdn || DEFAULT_CDN) + text;
      return BASE_URL + text;
    }
    return String(cdn || DEFAULT_CDN).replace(/\/$/, '') + '/images/' + text;
  }

  function imageRecords(record) {
    if (!record || !Array.isArray(record.images)) return [];
    return record.images;
  }

  function pickImage(record, wantedTypes, cdn) {
    var records = imageRecords(record);
    var priorities = wantedTypes || [];
    for (var i = 0; i < priorities.length; i += 1) {
      for (var j = 0; j < records.length; j += 1) {
        if (String(records[j] && records[j].type || '').toLowerCase() === String(priorities[i]).toLowerCase()) {
          var preferred = imageUrl(records[j], cdn);
          if (preferred) return preferred;
        }
      }
    }
    for (var k = 0; k < records.length; k += 1) {
      var fallback = imageUrl(records[k], cdn);
      if (fallback) return fallback;
    }
    return imageUrl(record.image || record.poster || record.cover, cdn);
  }

  function slugFor(record, fallback) {
    var source = cleanText(record && (record.slug || record.name || record.title)) || fallback || 'title';
    source = source.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    source = source.replace(/^-+|-+$/g, '');
    return source || 'title';
  }

  function canonicalTitleHref(id, slug) {
    return BASE_URL + '/en/titles/' + String(id) + '-' + slugFor({ slug: slug }, 'title');
  }

  function languageCode(value) {
    var raw = cleanText(value).toLowerCase();
    if (!raw) return 'und';
    if (raw.indexOf('eng') === 0 || raw === 'en') return 'en';
    if (raw.indexOf('ita') === 0 || raw === 'it') return 'it';
    if (raw.indexOf('ger') === 0 || raw.indexOf('deu') === 0 || raw === 'de') return 'de';
    if (raw.indexOf('fre') === 0 || raw.indexOf('fra') === 0 || raw === 'fr') return 'fr';
    if (raw.indexOf('spa') === 0 || raw === 'es') return 'es';
    if (raw.indexOf('por') === 0 || raw === 'pt') return 'pt';
    if (raw.indexOf('jpn') === 0 || raw === 'ja') return 'ja';
    if (raw.indexOf('kor') === 0 || raw === 'ko') return 'ko';
    if (raw.indexOf('ukr') === 0 || raw === 'uk') return 'uk';
    if (raw.indexOf('ara') === 0 || raw === 'ar') return 'ar';
    return raw.split('-')[0] || 'und';
  }

  function genresOf(record) {
    if (!record || !Array.isArray(record.genres)) return [];
    return record.genres.map(function (genre) {
      return cleanText(genre && typeof genre === 'object' ? (genre.name || genre.title) : genre);
    }).filter(Boolean);
  }

  function mapTitleRecord(record, props, flags) {
    var data = record || {};
    var id = cleanText(data.id);
    if (!id) return null;
    var title = cleanText(data.name || data.title || data.original_name) || ('Title ' + id);
    var slug = slugFor(data, title);
    var cdn = cdnFromProps(props || {});
    var poster = pickImage(data, ['poster', 'cover_mobile', 'cover', 'background', 'logo'], cdn);
    var cover = pickImage(data, ['cover', 'cover_mobile', 'background', 'poster'], cdn) || poster;
    var background = pickImage(data, ['background', 'cover', 'cover_mobile', 'poster'], cdn) || cover || poster;
    var type = cleanText(data.type || 'movie').toLowerCase() || 'movie';
    var hasDub = truthyFlag(data.dub_ita, false);
    var hasSub = data.audio_orig === undefined && data.sub_ita === undefined
      ? true
      : truthyFlag(data.audio_orig, false) || truthyFlag(data.sub_ita, false);
    var yearText = cleanText(data.release_date || data.release_date_it || data.year);
    var yearMatch = yearText.match(/(19|20)\d{2}/);
    var item = {
      id: id,
      href: canonicalTitleHref(id, slug),
      url: canonicalTitleHref(id, slug),
      title: title,
      name: title,
      image: poster,
      poster: poster,
      posterUrl: poster,
      cover: cover,
      coverUrl: cover,
      backdrop: background,
      backdropUrl: background,
      background: background,
      description: cleanText(data.plot || data.description || data.overview),
      synopsis: cleanText(data.plot || data.description || data.overview),
      overview: cleanText(data.plot || data.description || data.overview),
      genres: genresOf(data),
      tags: genresOf(data),
      type: type,
      contentType: 'video',
      isMovie: type === 'movie',
      isTrending: Boolean(flags && flags.isTrending),
      isPopular: Boolean(flags && flags.isPopular),
      quality: cleanText(data.quality),
      rating: numberOr(data.score, 0),
      year: yearMatch ? parseInt(yearMatch[0], 10) : 0,
      releaseDate: yearText,
      runtime: numberOr(data.runtime, 0),
      seasonsCount: positiveInt(data.seasons_count, 0),
      subAvailable: hasSub,
      dubAvailable: hasDub
    };
    if (Array.isArray(data.seasons)) {
      item.seasons = data.seasons.map(function (season, index) {
        var seasonNumber = positiveInt(season && (season.number || season.season_number), index + 1);
        return {
          id: cleanText(season && season.id),
          number: seasonNumber,
          name: cleanText(season && season.name) || ('Season ' + seasonNumber),
          href: item.href + '/season-' + seasonNumber
        };
      });
    } else {
      item.seasons = [];
    }
    return item;
  }

  function titleRecords(props) {
    if (!props || typeof props !== 'object') return [];
    if (Array.isArray(props.titles)) return props.titles;
    if (Array.isArray(props.results)) return props.results;
    if (props.title && typeof props.title === 'object') return [props.title];
    return [];
  }

  function mapRecords(records, props, flags) {
    var result = [];
    (records || []).forEach(function (record) {
      var item = mapTitleRecord(record, props, flags);
      if (item) result.push(item);
    });
    return result;
  }

  function parseTitleRef(input) {
    var raw = decodeUrlPart(cleanText(input));
    var withoutQuery = raw.split(/[?#]/)[0];
    var customTitle = withoutQuery.match(/streamingunity-title:(\d+)(?::([^/]+))?/i);
    if (customTitle) {
      return { id: customTitle[1], slug: customTitle[2] || '' };
    }
    var customMovie = withoutQuery.match(/streamingunity-movie:(\d+)(?::(\d+))?/i);
    if (customMovie) {
      return { id: customMovie[1], slug: '' };
    }
    var titleMatch = withoutQuery.match(/\/titles\/(\d+)(?:-([^/]+))?/i);
    if (titleMatch) {
      return { id: titleMatch[1], slug: titleMatch[2] || '' };
    }
    if (/^\d+$/.test(withoutQuery)) return { id: withoutQuery, slug: '' };
    var slug = withoutQuery.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '');
    if (slug.indexOf('/') >= 0) slug = slug.split('/').pop();
    return { id: '', slug: slug };
  }

  async function resolveTitleRef(input) {
    var parsed = parseTitleRef(input);
    if (parsed.id) return parsed;
    if (!parsed.slug) return parsed;
    try {
      var results = await searchResults(parsed.slug, 1);
      var wanted = parsed.slug.toLowerCase();
      for (var i = 0; i < results.length; i += 1) {
        var candidate = results[i];
        var candidateSlug = String(candidate.href || '').split('/').pop().replace(/^\d+-/, '').toLowerCase();
        if (candidateSlug === wanted || String(candidate.title || '').toLowerCase() === wanted) {
          return parseTitleRef(candidate.href);
        }
      }
      if (results.length) return parseTitleRef(results[0].href);
    } catch (_) {}
    return parsed;
  }

  async function loadTitlePage(input) {
    var ref = await resolveTitleRef(input);
    var cacheKey = ref.id + ':' + ref.slug;
    if (cacheKey !== ':' && titlePageCache[cacheKey]) return titlePageCache[cacheKey];

    var candidates = [];
    if (ref.id && ref.slug) candidates.push(canonicalTitleHref(ref.id, ref.slug));
    if (ref.id) candidates.push(BASE_URL + '/en/titles/' + ref.id);
    if (ref.slug) candidates.push(BASE_URL + '/en/titles/' + ref.slug);

    var seen = Object.create(null);
    for (var i = 0; i < candidates.length; i += 1) {
      var url = candidates[i];
      if (seen[url]) continue;
      seen[url] = true;
      try {
        var page = await requestPage(url);
        var props = propsOf(page);
        var title = props.title && typeof props.title === 'object'
          ? props.title
          : (titleRecords(props)[0] || null);
        if (title && title.id) {
          var loaded = { page: page, props: props, title: title, ref: ref, url: url };
          titlePageCache[cacheKey] = loaded;
          return loaded;
        }
      } catch (_) {}
    }
    throw new Error('StreamingUnity title could not be loaded');
  }

  async function discoveryHome() {
    try {
      var page = await requestPage(BASE_URL + '/');
      var props = propsOf(page);
      var sliders = Array.isArray(props.sliders) ? props.sliders : [];
      var sections = [];
      sliders.forEach(function (slider) {
        var name = cleanText(slider && slider.name).toLowerCase();
        var items = mapRecords(
          slider && Array.isArray(slider.titles) ? slider.titles : [],
          props,
          { isTrending: name === 'trending', isPopular: name === 'top10' }
        );
        if (!items.length) return;
        var style = name === 'top10' ? 'top10' : (name === 'trending' ? 'hero' : 'poster');
        sections.push({
          id: 'streamingunity_' + (name || 'titles'),
          title: cleanText(slider && (slider.label || slider.name)) || 'Titles',
          style: style,
          items: items,
          viewAll: { mode: 'feed', feedId: name || 'trending' }
        });
      });
      return { sections: sections };
    } catch (error) {
      log('discoveryHome failed');
      return { sections: [] };
    }
  }

  function feedRoute(feedId) {
    var raw = cleanText(feedId).toLowerCase();
    var aliases = {
      popular: 'trending',
      featured: 'trending',
      recent: 'latest',
      shows: 'tv-shows',
      tv: 'tv-shows'
    };
    var target = aliases[raw] || raw || 'trending';
    if (target === 'movies' || target === 'tv-shows') return BASE_URL + '/en/' + target;
    return BASE_URL + '/en/browse/' + target;
  }

  async function discoveryFeed(feedId, page) {
    var pageNumber = positiveInt(page, 1);
    try {
      var route = feedRoute(feedId);
      var separator = route.indexOf('?') >= 0 ? '&' : '?';
      var pageData = await requestPage(route + separator + 'page=' + pageNumber);
      var props = propsOf(pageData);
      var rawItems = titleRecords(props);
      var target = cleanText(feedId).toLowerCase();
      if (target === 'popular' || target === 'featured') target = 'trending';
      var items = mapRecords(rawItems, props, {
        isTrending: target === 'trending',
        isPopular: target === 'top10'
      });
      var total = numberOr(props.totalCount || props.total_count, 0);
      var hasMore;
      if (target === 'top10') {
        hasMore = false;
      } else if (total > 0) {
        hasMore = pageNumber * items.length < total;
      } else {
        hasMore = items.length >= 60;
      }
      return {
        feedId: feedId || 'trending',
        page: pageNumber,
        items: items,
        hasMore: Boolean(hasMore)
      };
    } catch (error) {
      log('discoveryFeed failed for ' + String(feedId || 'trending'));
      return { feedId: feedId || 'trending', page: pageNumber, items: [], hasMore: false };
    }
  }

  async function searchResults(query, page) {
    var cleanQuery = cleanText(query);
    var pageNumber = positiveInt(page, 1);
    if (!cleanQuery) {
      var homeFeed = await discoveryFeed('trending', pageNumber);
      return homeFeed.items || [];
    }
    try {
      var url = BASE_URL + '/en/search?q=' + encodeURIComponent(cleanQuery);
      if (pageNumber > 1) url += '&page=' + pageNumber;
      var pageData = await requestPage(url);
      var props = propsOf(pageData);
      return mapRecords(titleRecords(props), props, {});
    } catch (error) {
      log('searchResults failed');
      return [];
    }
  }

  function detailsFromLoaded(loaded) {
    var title = loaded.title;
    var props = loaded.props;
    var item = mapTitleRecord(title, props, {});
    if (!item) return null;
    item.href = canonicalTitleHref(title.id, title.slug || loaded.ref.slug || title.name);
    item.url = item.href;
    item.scwsId = cleanText(title.scws_id);
    item.originalLanguage = cleanText(title.original_language);
    item.status = cleanText(title.status);
    item.age = numberOr(title.age, 0);
    item.imdbId = cleanText(title.imdb_id);
    item.tmdbId = cleanText(title.tmdb_id);
    item.preview = title.preview && typeof title.preview === 'object'
      ? cleanText(title.preview.embed_url || title.preview.url)
      : '';
    var loadedSeason = props.loadedSeason;
    item.loadedSeasonNumber = loadedSeason ? positiveInt(loadedSeason.number, 0) : 0;
    item.episodesCount = loadedSeason && Array.isArray(loadedSeason.episodes)
      ? loadedSeason.episodes.length
      : 0;
    return item;
  }

  async function extractDetails(urlOrId) {
    try {
      var loaded = await loadTitlePage(urlOrId);
      return detailsFromLoaded(loaded);
    } catch (error) {
      return {
        id: String(urlOrId || ''),
        href: String(urlOrId || ''),
        title: 'Unavailable',
        name: 'Unavailable',
        description: '',
        synopsis: '',
        image: '',
        poster: '',
        backdrop: '',
        genres: [],
        type: 'movie',
        isMovie: true,
        year: 0,
        rating: 0
      };
    }
  }

  function makeMovieHref(title, props) {
    var titleId = cleanText(title && title.id);
    var providerId = cleanText(title && title.scws_id) || titleId;
    var hasDub = truthyFlag(title && title.dub_ita, false) ? '1' : '0';
    var slug = slugFor(title, titleId);
    return '/streamingunity/movie/' + titleId + '/' + providerId + '/' + hasDub + '/' + slug;
  }

  function makeEpisodeHref(title, seasonNumber, episode, props) {
    var titleId = cleanText(title && title.id);
    var episodeId = cleanText(episode && episode.id);
    var providerId = cleanText(episode && episode.scws_id) || episodeId;
    var hasDub = truthyFlag(episode && episode.dub_ita, false) ? '1' : '0';
    var slug = slugFor(title, titleId);
    return '/streamingunity/episode/' + titleId + '/' + String(seasonNumber) + '/' +
      episodeId + '/' + providerId + '/' + hasDub + '/' + slug;
  }

  function seasonList(title, props) {
    var output = [];
    if (title && Array.isArray(title.seasons)) {
      title.seasons.forEach(function (season, index) {
        var number = positiveInt(season && (season.number || season.season_number), index + 1);
        if (output.every(function (existing) { return existing.number !== number; })) {
          output.push({ number: number, id: cleanText(season && season.id) });
        }
      });
    }
    if (!output.length && props && props.loadedSeason) {
      output.push({ number: positiveInt(props.loadedSeason.number, 1), id: cleanText(props.loadedSeason.id) });
    }
    output.sort(function (a, b) { return a.number - b.number; });
    return output;
  }

  function mapSeasonEpisodes(title, props, seasonNumber, episodeRows, parentPoster) {
    var output = [];
    var rows = Array.isArray(episodeRows) ? episodeRows.slice() : [];
    rows.sort(function (a, b) {
      return positiveInt(a && a.number, 0) - positiveInt(b && b.number, 0);
    });
    rows.forEach(function (episode) {
      var episodeId = cleanText(episode && episode.id);
      var number = positiveInt(episode && episode.number, 0);
      if (!episodeId || !number) return;
      var name = cleanText(episode.name || episode.title) || ('Episode ' + number);
      var image = pickImage(episode, ['cover', 'poster', 'cover_mobile'], cdnFromProps(props || {})) || parentPoster;
      var subAvailable = episode.audio_orig === undefined && episode.sub_ita === undefined
        ? true
        : truthyFlag(episode.audio_orig, false) || truthyFlag(episode.sub_ita, false);
      var dubAvailable = truthyFlag(episode.dub_ita, false);
      var href = makeEpisodeHref(title, seasonNumber, episode, props);
      output.push({
        id: href,
        href: href,
        number: number,
        episodeNumber: number,
        season: seasonNumber,
        seasonNumber: seasonNumber,
        title: 'S' + seasonNumber + 'E' + number + ' - ' + name,
        name: name,
        image: image,
        poster: image,
        thumbnail: image,
        description: cleanText(episode.plot),
        duration: numberOr(episode.duration, 0),
        subAvailable: subAvailable,
        dubAvailable: dubAvailable
      });
    });
    return output;
  }

  async function seasonPage(title, loadedProps, seasonNumber) {
    var loadedSeason = loadedProps && loadedProps.loadedSeason;
    if (loadedSeason && positiveInt(loadedSeason.number, 0) === seasonNumber) {
      return loadedProps;
    }
    var href = canonicalTitleHref(title.id, title.slug || title.name) + '/season-' + seasonNumber;
    try {
      var page = await requestPage(href);
      return propsOf(page);
    } catch (_) {
      return null;
    }
  }

  async function extractEpisodes(seriesId) {
    try {
      var loaded = await loadTitlePage(seriesId);
      var title = loaded.title;
      var props = loaded.props;
      var type = cleanText(title.type || 'movie').toLowerCase();
      var poster = pickImage(title, ['poster', 'cover_mobile', 'cover', 'background'], cdnFromProps(props));
      if (type === 'movie' || (!title.seasons_count && !Array.isArray(title.seasons))) {
        var movieHref = makeMovieHref(title, props);
        return [{
          id: movieHref,
          href: movieHref,
          number: 1,
          episodeNumber: 1,
          season: 1,
          seasonNumber: 1,
          title: cleanText(title.name || title.original_name) || 'Movie',
          name: cleanText(title.name || title.original_name) || 'Movie',
          image: poster,
          poster: poster,
          thumbnail: poster,
          description: cleanText(title.plot),
          duration: numberOr(title.runtime, 0),
          subAvailable: true,
          dubAvailable: truthyFlag(title.dub_ita, false)
        }];
      }

      var seasons = seasonList(title, props);
      var episodes = [];
      for (var i = 0; i < seasons.length; i += 1) {
        var seasonProps = await seasonPage(title, props, seasons[i].number);
        if (!seasonProps || !seasonProps.loadedSeason) continue;
        var season = seasonProps.loadedSeason;
        var rows = Array.isArray(season.episodes) ? season.episodes : [];
        episodes = episodes.concat(mapSeasonEpisodes(title, seasonProps, seasons[i].number, rows, poster));
      }
      return episodes;
    } catch (error) {
      log('extractEpisodes failed');
      return [];
    }
  }

  function parseEpisodeRef(input) {
    var raw = decodeUrlPart(cleanText(input)).split(/[?#]/)[0];
    var episode = raw.match(/\/streamingunity\/episode\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/([^/]+)/i);
    if (episode) {
      return {
        kind: 'episode',
        titleId: episode[1],
        season: positiveInt(episode[2], 1),
        mediaId: episode[3],
        providerId: episode[4] === '0' ? '' : episode[4],
        dubAvailable: episode[5] === '1',
        slug: episode[6]
      };
    }
    var movie = raw.match(/\/streamingunity\/movie\/(\d+)\/(\d+)\/(\d+)\/([^/]+)/i);
    if (movie) {
      return {
        kind: 'movie',
        titleId: movie[1],
        season: 1,
        mediaId: movie[1],
        providerId: movie[2] === '0' ? '' : movie[2],
        dubAvailable: movie[3] === '1',
        slug: movie[4]
      };
    }
    var iframe = raw.match(/\/iframe\/(\d+)/i);
    if (iframe) {
      return {
        kind: 'unknown',
        titleId: iframe[1],
        season: 1,
        mediaId: iframe[1],
        providerId: '',
        dubAvailable: true,
        slug: ''
      };
    }
    return null;
  }

  function providerLanguage(lang) {
    var requested = cleanText(lang || 'sub').toLowerCase();
    if (requested === 'dub' || requested === 'ita' || requested === 'it' || requested === 'vf') return 'ita';
    if (requested === 'de' || requested === 'ger') return 'ger';
    if (requested === 'fr' || requested === 'fra') return 'fre';
    if (requested === 'es' || requested === 'spa') return 'spa';
    if (requested === 'ja' || requested === 'jpn') return 'jpn';
    return 'en';
  }

  function extractVixEmbedUrl(html) {
    var source = String(html || '').replace(/\\\//g, '/');
    var matches = source.match(/<iframe[^>]+src=["']([^"']+)["']/ig) || [];
    for (var i = 0; i < matches.length; i += 1) {
      var match = matches[i].match(/src=["']([^"']+)["']/i);
      var candidate = absoluteUrl(cleanText(match && match[1]).replace(/&amp;/g, '&'), BASE_URL);
      if (candidate.toLowerCase().indexOf('vixcloud.co/') >= 0) return candidate;
    }
    var direct = source.match(/https?:\/\/vixcloud\.co\/(?:embed|e)\/[^"'<>\s]+/i);
    return direct ? cleanText(direct[0]).replace(/&amp;/g, '&') : '';
  }

  function unescapeJs(value) {
    return String(value || '')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
  }

  function vixConfig(html) {
    var source = String(html || '');
    var streams = [];
    var streamMatch = source.match(/window\.streams\s*=\s*(\[[\s\S]*?\])\s*;/i);
    if (streamMatch) {
      try {
        var parsed = JSON.parse(unescapeJs(streamMatch[1]));
        if (Array.isArray(parsed)) streams = parsed;
      } catch (_) {}
    }
    streams.sort(function (a, b) {
      var activeA = truthyFlag(a && a.active, false) ? 1 : 0;
      var activeB = truthyFlag(b && b.active, false) ? 1 : 0;
      return activeB - activeA;
    });
    var tokenMatch = source.match(/["']token["']\s*:\s*["']([^"']+)["']/i);
    var expiresMatch = source.match(/["']expires["']\s*:\s*["']([^"']+)["']/i);
    var asnMatch = source.match(/["']asn["']\s*:\s*["']([^"']*)["']/i);
    var masterMatch = source.match(/window\.masterPlaylist\s*=\s*\{[\s\S]*?\burl\s*:\s*["']([^"']+)["']/i);
    var videoMatch = source.match(/window\.video\s*=\s*\{[\s\S]*?\bid\s*:\s*["']([^"']+)["']/i);
    var bases = [];
    streams.forEach(function (stream) {
      var value = unescapeJs(stream && stream.url);
      if (value && value.indexOf('/playlist/') >= 0) bases.push(value);
    });
    if (masterMatch && masterMatch[1]) bases.push(unescapeJs(masterMatch[1]));
    return {
      streams: bases,
      token: tokenMatch ? tokenMatch[1] : '',
      expires: expiresMatch ? expiresMatch[1] : '',
      asn: asnMatch ? asnMatch[1] : '',
      mediaId: videoMatch ? videoMatch[1] : '',
      canPlayFhd: /window\.canPlayFHD\s*=\s*true/i.test(source)
    };
  }

  function appendQuery(url, key, value) {
    var result = String(url || '');
    if (!value || new RegExp('(?:[?&])' + key + '=', 'i').test(result)) return result;
    return result + (result.indexOf('?') >= 0 ? '&' : '?') + key + '=' + encodeURIComponent(String(value));
  }

  function buildPlaylistUrl(base, config, providerLang) {
    var url = cleanText(base).replace(/&amp;/g, '&');
    url = appendQuery(url, 'token', config.token);
    url = appendQuery(url, 'expires', config.expires);
    url = appendQuery(url, 'asn', config.asn);
    if (config.canPlayFhd) url = appendQuery(url, 'h', '1');
    url = appendQuery(url, 'lang', providerLang);
    return url;
  }

  function parseAttributes(line) {
    var attributes = {};
    var matcher = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
    var match;
    while ((match = matcher.exec(String(line || ''))) !== null) {
      var value = String(match[2] || '').trim();
      if (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
        value = value.substring(1, value.length - 1).replace(/\\"/g, '"');
      }
      attributes[String(match[1]).toUpperCase()] = value;
    }
    return attributes;
  }

  function parseMasterMetadata(master) {
    var subtitles = [];
    var audioTracks = [];
    var lines = String(master || '').split(/\r?\n/);
    var seenSubtitles = Object.create(null);
    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (trimmed.indexOf('#EXT-X-MEDIA:') !== 0) return;
      var attributes = parseAttributes(trimmed.substring('#EXT-X-MEDIA:'.length));
      var uri = absoluteUrl(attributes.URI, VIX_BASE);
      var type = String(attributes.TYPE || '').toUpperCase();
      if (!uri) return;
      if (type === 'AUDIO') {
        audioTracks.push({
          label: cleanText(attributes.NAME || attributes.LANGUAGE || 'Audio'),
          language: languageCode(attributes.LANGUAGE),
          default: String(attributes.DEFAULT || '').toUpperCase() === 'YES',
          uri: uri
        });
      }
      if (type !== 'SUBTITLES' || seenSubtitles[uri]) return;
      seenSubtitles[uri] = true;
      var label = cleanText(attributes.NAME || attributes.LANGUAGE || 'Subtitle');
      var lang = languageCode(attributes.LANGUAGE);
      subtitles.push({
        id: uri,
        label: label,
        language: lang,
        srclang: lang,
        file: uri,
        url: uri,
        kind: 'subtitle',
        default: String(attributes.DEFAULT || '').toUpperCase() === 'YES',
        forced: String(attributes.FORCED || '').toUpperCase() === 'YES',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: VIX_BASE + '/',
          Origin: VIX_BASE
        }
      });
    });
    return { subtitles: subtitles, audioTracks: audioTracks };
  }

  function hlsHeaders(referer) {
    return {
      'User-Agent': USER_AGENT,
      Accept: HLS_ACCEPT,
      Referer: referer || VIX_BASE + '/',
      Origin: VIX_BASE
    };
  }

  function iframeCandidates(ref, mediaId) {
    var candidates = [];
    var titleId = cleanText(ref && ref.titleId);
    var episodeId = cleanText(ref && ref.mediaId);

    // StreamingUnity's current episode router is keyed by title ID and takes
    // the episode ID as a query parameter. The previous implementation used
    // the episode ID as the route ID, which returns 404 for current titles.
    if (ref && ref.kind === 'episode' && titleId && episodeId) {
      candidates.push(BASE_URL + '/en/iframe/' + encodeURIComponent(titleId) +
        '?episode_id=' + encodeURIComponent(episodeId) + '&next_episode=1');
    } else if (ref && ref.kind === 'movie' && titleId) {
      candidates.push(BASE_URL + '/en/iframe/' + encodeURIComponent(titleId));
    } else if (ref && ref.kind === 'unknown' && mediaId) {
      candidates.push(BASE_URL + '/en/iframe/' + encodeURIComponent(String(mediaId)));
    }

    // Keep the older ID forms as bounded compatibility fallbacks for saved
    // episode links produced by earlier module versions.
    if (mediaId) candidates.push(BASE_URL + '/en/iframe/' + encodeURIComponent(String(mediaId)));
    if (ref && ref.providerId) {
      candidates.push(BASE_URL + '/en/iframe/' + encodeURIComponent(String(ref.providerId)));
    }

    var unique = [];
    var seen = Object.create(null);
    candidates.forEach(function (candidate) {
      if (!candidate || seen[candidate]) return;
      seen[candidate] = true;
      unique.push(candidate);
    });
    return unique;
  }

  async function resolveMediaId(mediaId, providerLanguage, ref) {
    var iframeUrls = iframeCandidates(ref, mediaId);
    var lastError = null;
    var watchId = cleanText(ref && ref.titleId) || String(mediaId || '');

    for (var iframeIndex = 0; iframeIndex < iframeUrls.length; iframeIndex += 1) {
      var iframeUrl = iframeUrls[iframeIndex];
      var iframeResult = await requestText(iframeUrl, {
        Accept: PAGE_ACCEPT,
        Referer: BASE_URL + '/en/watch/' + encodeURIComponent(watchId)
      });
      if (!iframeResult.ok || !iframeResult.text) {
        lastError = new Error('iframe unavailable (' + String(iframeResult.status || 0) + ')');
        continue;
      }
      var embedUrl = extractVixEmbedUrl(iframeResult.text);
      if (!embedUrl) {
        lastError = new Error('provider embed missing');
        continue;
      }

      var embedResult = await requestText(embedUrl, {
        Accept: PAGE_ACCEPT,
        Referer: iframeUrl
      });
      if (!embedResult.ok || !embedResult.text) {
        lastError = new Error('provider embed unavailable');
        continue;
      }
      var config = vixConfig(embedResult.text);
      var bases = config.streams.slice();
      if (config.mediaId && bases.length === 0) {
        bases.push(VIX_BASE + '/playlist/' + config.mediaId + '?b=1');
      }
      if (bases.length === 0) {
        bases.push(VIX_BASE + '/playlist/' + String(mediaId) + '?b=1');
      }

      var seen = Object.create(null);
      for (var i = 0; i < bases.length; i += 1) {
        var playlistUrl = buildPlaylistUrl(bases[i], config, providerLanguage);
        if (!playlistUrl || seen[playlistUrl]) continue;
        seen[playlistUrl] = true;
        var playlistResult = await requestText(playlistUrl, hlsHeaders(VIX_BASE + '/'));
        var playlistBody = playlistResult.text || '';
        if (!playlistResult.ok || playlistBody.indexOf('#EXTM3U') < 0) continue;
        var metadata = parseMasterMetadata(playlistBody);
        return {
          url: playlistUrl,
          master: playlistBody,
          subtitles: metadata.subtitles,
          audioTracks: metadata.audioTracks,
          embedUrl: embedUrl
        };
      }
      lastError = new Error('no playable HLS playlist');
    }
    throw lastError || new Error('iframe unavailable');
  }

  async function extractStreamUrl(episodeHref, lang) {
    var requested = cleanText(lang || 'sub').toLowerCase() || 'sub';
    var ref = parseEpisodeRef(episodeHref);
    if (!ref) {
      return {
        streams: [],
        subtitles: [],
        lang: requested,
        error: { message: 'Invalid StreamingUnity episode reference' }
      };
    }
    if ((requested === 'dub' || requested === 'vf') && ref.dubAvailable === false) {
      return {
        streams: [],
        subtitles: [],
        lang: requested,
        error: { message: 'This title has no verified Italian dub track' }
      };
    }

    var providerLang = providerLanguage(requested);
    var ids = [ref.mediaId];
    if (ref.providerId && ids.indexOf(ref.providerId) < 0) ids.push(ref.providerId);
    var lastError = null;
    for (var i = 0; i < ids.length; i += 1) {
      try {
        var resolved = await resolveMediaId(ids[i], providerLang, ref);
        var headers = hlsHeaders(VIX_BASE + '/');
        var primary = {
          label: 'Auto (Adaptive HLS' + (providerLang === 'ita' ? ' · Italian' : ' · English') + ')',
          url: resolved.url,
          quality: 'Auto',
          streamType: 'hls',
          kind: 'hls',
          provider: 'streamingunity-vixcloud',
          headers: headers
        };
        return {
          url: resolved.url,
          stream: resolved.url,
          streams: [primary],
          headers: headers,
          streamType: 'hls',
          quality: 'Auto',
          lang: requested,
          audioLanguage: languageCode(providerLang),
          audioTracks: resolved.audioTracks,
          subtitles: resolved.subtitles
        };
      } catch (error) {
        lastError = error;
        log('provider candidate failed for media ' + ids[i]);
      }
    }
    return {
      streams: [],
      subtitles: [],
      lang: requested,
      error: {
        message: 'StreamingUnity has no playable public stream right now' +
          (lastError && lastError.message ? ': ' + lastError.message : '')
      }
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      searchResults: searchResults,
      extractDetails: extractDetails,
      extractEpisodes: extractEpisodes,
      extractStreamUrl: extractStreamUrl,
      discoveryHome: discoveryHome,
      discoveryFeed: discoveryFeed
    };
  }
})();
