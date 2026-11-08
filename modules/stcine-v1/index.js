(() => {
  'use strict';

  const MODULE_NAME = 'STCine';
  const SITE = 'https://stcine.com';
  const API = SITE + '/api';
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
  const VIDEASY_ORIGIN = 'https://player.videasy.to';
  const LOOKMOVIE = 'https://www.lookmovie2.to';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
  const STREAM_RESOLVE_BUDGET_MS = 26000;
  const STREAM_PROBE_CONCURRENCY = 3;
  const STREAM_PROBE_LIMIT = 8;

  // Public TMDB key used by many free frontends (including STCine SPA). Catalogue fallback only.
  const TMDB_KEY = '9801b6b0548ad57581d111ea690c85c8';
  const lookmovieHitCache = Object.create(null);

  function log(msg) {
    try { console.log('[' + MODULE_NAME + '] ' + String(msg || '')); } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(1, Number(ms) || 0)));
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    let timer;
    return Promise.race([promise, new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), waitMs);
    })]).then((value) => {
      if (typeof clearTimeout === 'function') clearTimeout(timer);
      return value;
    }, (error) => {
      if (typeof clearTimeout === 'function') clearTimeout(timer);
      throw error;
    });
  }

  async function mapBounded(items, limit, run) {
    let next = 0;
    const results = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index], index);
      }
    }));
    return results;
  }

  function subtitleTracks(rows, baseUrl) {
    const out = [];
    const seen = new Set();
    const counts = Object.create(null);
    const names = {english:'en',arabic:'ar',french:'fr',spanish:'es',german:'de',italian:'it',japanese:'ja',korean:'ko',portuguese:'pt', 'protuguese (br)':'pt-BR', 'portuguese (br)':'pt-BR',polish:'pl',dutch:'nl',greek:'el',turkish:'tr',hebrew:'he',persian:'fa',russian:'ru',indonesian:'id',vietnamese:'vi',thai:'th',swedish:'sv',danish:'da',finnish:'fi',romanian:'ro',hungarian:'hu',czech:'cs',serbian:'sr',croatian:'hr',albanian:'sq',bulgarian:'bg',bosnian:'bs',slovenian:'sl',bengali:'bn',tamil:'ta',malay:'ms',sinhala:'si',estonian:'et',icelandic:'is',macedonian:'mk',kazakh:'kk',belarusian:'be'};
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row || typeof row !== 'object') return;
      if (row.kind && !/^(captions|subtitles)$/i.test(row.kind)) return;
      const url = absoluteFromPlaylist(baseUrl || '', row.url || row.file || row.src || '');
      if (!/^https?:\/\//i.test(url)) return;
      const rawLanguage = cleanText(row.language || row.lang || row.srclang || '');
      const language = names[rawLanguage.toLowerCase()] || rawLanguage;
      const label = cleanText(row.label || row.name || rawLanguage || 'Subtitle');
      const key = url + '|' + language;
      if (seen.has(key)) return;
      seen.add(key);
      // Source libraries can return hundreds of release duplicates. Keep every
      // language, with two alternatives each, instead of hundreds of "English" rows.
      const group = language.toLowerCase() || label.toLowerCase();
      counts[group] = (counts[group] || 0) + 1;
      if (counts[group] > 2) return;
      const display = label + (counts[group] > 1 && !/\(2\)$/.test(label) ? ' (2)' : '');
      out.push({ url, language, label: display, kind: 'subtitles', headers: row.headers || {} });
    });
    return out.sort((a, b) => Number(/^en(?:-|$)/i.test(b.language)) - Number(/^en(?:-|$)/i.test(a.language)));
  }

  function captionRows(data) {
    return data && (data.subtitles || data.tracks || data.captions || data.subs) || [];
  }

  function remainingMs(deadlineMs, reserveMs) {
    return Math.max(0, Number(deadlineMs || 0) - Date.now() - Math.max(0, Number(reserveMs) || 0));
  }

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function normalizeTitleKey(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
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
        return JSON.stringify(await res.json());
      } catch (_) {}
    }
    return '';
  }

  function safeJsonParse(text) {
    if (text !== null && typeof text === 'object') return text;
    try { return JSON.parse(String(text == null ? '' : text).trim()); } catch (_) { return null; }
  }

  async function request(url, options) {
    const cfg = options || {};
    const method = cfg.method || 'GET';
    const headers = Object.assign(
      { 'User-Agent': USER_AGENT, Accept: 'application/json,*/*' },
      cfg.headers || {},
    );
    const body = cfg.body == null ? null : cfg.body;
    try {
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(url, headers, method, body);
        const status = Number((res && res.status) || 0);
        const textBody = await readResponseBody(res);
        let resHeaders = {};
        try {
          if (res && res.headers) {
            if (typeof res.headers.get === 'function') {
              resHeaders = {
                'content-type': res.headers.get('content-type') || '',
                'Content-Type': res.headers.get('content-type') || '',
              };
            } else if (typeof res.headers === 'object') {
              resHeaders = res.headers;
            }
          }
        } catch (_) {}
        return {
          ok: !!(res && (res.ok === true || (status >= 200 && status < 300))),
          status,
          body: textBody,
          json: safeJsonParse(textBody),
          headers: resHeaders,
        };
      }
      if (typeof fetch === 'function') {
        const res = await fetch(url, { method, headers, body });
        const textBody = await res.text();
        let resHeaders = {};
        try {
          resHeaders = {
            'content-type': (res.headers && res.headers.get && res.headers.get('content-type')) || '',
            'Content-Type': (res.headers && res.headers.get && res.headers.get('content-type')) || '',
          };
        } catch (_) {}
        return {
          ok: !!res.ok,
          status: Number(res.status || 0),
          body: textBody,
          json: safeJsonParse(textBody),
          headers: resHeaders,
        };
      }
    } catch (e) {
      log('request error: ' + (e && e.message ? e.message : String(e)));
    }
    return { ok: false, status: 0, body: '', json: null };
  }

  function posterUrl(path) {
    const p = cleanText(path || '');
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    return TMDB_IMG + (p.startsWith('/') ? p : '/' + p);
  }

  function cardFromStcine(item) {
    if (!item) return null;
    const tmdbId = item.tmdbId || item.id;
    if (!tmdbId) return null;
    const type = String(item.type || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
    const href = type === 'tv' ? ('tv:' + tmdbId) : ('movie:' + tmdbId);
    return {
      href: href,
      id: href,
      title: cleanText(item.title || item.name || ('TMDB ' + tmdbId)),
      image: posterUrl(item.poster_path || item.backdrop_path),
      poster: posterUrl(item.poster_path || item.backdrop_path),
      releaseDate: cleanText(item.releaseDate || item.release_date || item.first_air_date || ''),
      type: type,
      mediaType: type,
      isMovie: type === 'movie',
    };
  }

  function cardFromTmdb(item, typeHint) {
    if (!item) return null;
    const isTv = typeHint === 'tv' || item.media_type === 'tv' || (!!item.name && !item.title);
    const tmdbId = item.id;
    if (!tmdbId) return null;
    const type = isTv ? 'tv' : 'movie';
    const href = isTv ? ('tv:' + tmdbId) : ('movie:' + tmdbId);
    return {
      href: href,
      id: href,
      title: cleanText(item.title || item.name || ('TMDB ' + tmdbId)),
      image: posterUrl(item.poster_path),
      poster: posterUrl(item.poster_path),
      releaseDate: cleanText(item.release_date || item.first_air_date || ''),
      type: type,
      mediaType: type,
      isMovie: type === 'movie',
    };
  }

  function parseHref(raw) {
    const s = String(raw || '').trim();
    // movie:123 | tv:456 | tv:456:1:3 | legacy stcine player urls
    let m = s.match(/(?:^|\/)(movie|tv):(\d+)(?::(\d+):(\d+))?(?:[?#].*)?$/i);
    if (m) {
      return {
        type: m[1].toLowerCase(),
        tmdbId: m[2],
        season: m[3] ? Number(m[3]) : 1,
        episode: m[4] ? Number(m[4]) : 1,
      };
    }
    m = s.match(/[?&]id=(\d+)/i);
    if (m) {
      const type = /type=tv/i.test(s) ? 'tv' : 'movie';
      return { type: type, tmdbId: m[1], season: 1, episode: 1 };
    }
    m = s.match(/\/(movie|tv)\/(\d+)/i);
    if (m) return { type: m[1].toLowerCase(), tmdbId: m[2], season: 1, episode: 1 };
    if (/^\d+$/.test(s)) return { type: 'movie', tmdbId: s, season: 1, episode: 1 };
    return null;
  }

  async function stcineList(type, page, search) {
    const pageNumber = Math.max(1, Number(page) || 1);
    const qs = encodeQuery({
      status: 'published',
      type: type === 'tv' ? 'tv' : 'movie',
      limit: '24',
      page: String(pageNumber),
      search: search || undefined,
    });
    const res = await settleWithin(
      request(API + '/movies?' + qs, {
        headers: { Accept: 'application/json', Referer: SITE + '/' },
      }),
      15000,
      null,
    );
    if (!res || !res.ok) return [];
    const data = res.json || safeJsonParse(res.body) || {};
    const results = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
    return results.map(cardFromStcine).filter(Boolean);
  }

  async function tmdbSearch(query, page) {
    const q = encodeURIComponent(query);
    const pageNumber = Math.max(1, Number(page) || 1);
    const url =
      'https://api.themoviedb.org/3/search/multi?api_key=' +
      TMDB_KEY +
      '&query=' +
      q +
      '&include_adult=false&language=en-US&page=' +
      pageNumber;
    const res = await settleWithin(request(url), 12000, null);
    if (!res || !res.ok) return [];
    const data = res.json || safeJsonParse(res.body) || {};
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .filter((r) => r && (r.media_type === 'movie' || r.media_type === 'tv'))
      .map((r) => cardFromTmdb(r))
      .filter(Boolean)
      .slice(0, 30);
  }

  async function tmdbPopular(kind, page) {
    const type = kind === 'tv' ? 'tv' : 'movie';
    const url =
      'https://api.themoviedb.org/3/' +
      type +
      '/popular?api_key=' +
      TMDB_KEY +
      '&language=en-US&page=' + Math.max(1, Number(page) || 1);
    const res = await settleWithin(request(url), 12000, null);
    if (!res || !res.ok) return [];
    const data = res.json || safeJsonParse(res.body) || {};
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((r) => cardFromTmdb(r, type)).filter(Boolean).slice(0, 20);
  }

  async function searchResults(query, page) {
    const q = cleanText(query || '');
    const pageNumber = Math.max(1, Number(page) + 1 || 1);
    try {
      if (!q) {
        const movies = filterReleasedCards(await stcineList('movie', pageNumber, ''));
        if (movies.length) return movies;
        return filterReleasedCards(await tmdbPopular('movie', pageNumber));
      }
      // STCine search first, then TMDB if thin
      const packs = await Promise.all([
        stcineList('movie', pageNumber, q), stcineList('tv', pageNumber, q),
      ]);
      let cards = mergeUniqueCards(packs[0], packs[1]);
      const normalizedQuery = normalizeTitleKey(q);
      const hasExact = cards.some((card) => normalizeTitleKey(card.title) === normalizedQuery);
      // STCine can return many related titles without the exact canonical
      // record (for example, Matrix sequels). Add the matching TMDB result in
      // that case even when the upstream result count is not small.
      if (cards.length < 5 || !hasExact) {
        // Keep fallback pages aligned with the requested module page. The
        // STCine search endpoint can return an empty later page; restarting
        // TMDB at page 1 here would repeat the first page in the app.
        const tmdb = await tmdbSearch(q, pageNumber);
        const seen = new Set(cards.map((c) => c.href));
        for (const c of tmdb) {
          if (!seen.has(c.href)) {
            cards.push(c);
            seen.add(c.href);
          }
        }
      }
      // Prefer exact-ish matches after both sources have been combined.
      const lower = q.toLowerCase();
      cards.sort((a, b) => {
        const as = a.title.toLowerCase() === lower ? 0 : a.title.toLowerCase().includes(lower) ? 1 : 2;
        const bs = b.title.toLowerCase() === lower ? 0 : b.title.toLowerCase().includes(lower) ? 1 : 2;
        return as - bs;
      });
      return cards.slice(0, 30);
    } catch (e) {
      log('search error: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  async function extractDetails(urlOrId) {
    const ref = parseHref(urlOrId);
    if (!ref) return { title: 'Unknown', description: '' };
    try {
      // Prefer TMDB for reliable metadata
      const path = ref.type === 'tv' ? 'tv' : 'movie';
      const url =
        'https://api.themoviedb.org/3/' +
        path +
        '/' +
        ref.tmdbId +
        '?api_key=' +
        TMDB_KEY +
        '&language=en-US';
      const res = await settleWithin(request(url), 12000, null);
      const d = (res && (res.json || safeJsonParse(res.body))) || {};
      const title = cleanText(d.title || d.name || ('TMDB ' + ref.tmdbId));
      const originalTitle = cleanText(d.original_title || d.original_name || '');
      const isMovie = ref.type === 'movie';
      const seasons = [];
      if (!isMovie && Array.isArray(d.seasons)) {
        d.seasons.forEach(function (s) {
          const n = Number(s && s.season_number);
          if (n > 0) seasons.push(n);
        });
      }
      return {
        title: title,
        originalTitle: originalTitle,
        description: cleanText(d.overview || ''),
        image: posterUrl(d.poster_path || d.backdrop_path),
        poster: posterUrl(d.poster_path || d.backdrop_path),
        banner: posterUrl(d.backdrop_path || d.poster_path),
        href: isMovie ? ('movie:' + ref.tmdbId) : ('tv:' + ref.tmdbId),
        id: isMovie ? ('movie:' + ref.tmdbId) : ('tv:' + ref.tmdbId),
        year: cleanText((d.release_date || d.first_air_date || '').slice(0, 4)),
        type: isMovie ? 'movie' : 'tv',
        mediaType: isMovie ? 'movie' : 'tv',
        isMovie: isMovie,
        seasons: isMovie ? 0 : seasons.length || Number(d.number_of_seasons || 0) || 0,
        seasonNumbers: isMovie ? [] : seasons,
      };
    } catch (e) {
      log('details error: ' + (e && e.message ? e.message : String(e)));
      return {
        title: ref.type + ' ' + ref.tmdbId,
        description: '',
        href: ref.type + ':' + ref.tmdbId,
        type: ref.type,
        mediaType: ref.type,
        isMovie: ref.type === 'movie',
      };
    }
  }

  async function extractEpisodes(seriesId) {
    const ref = parseHref(seriesId);
    if (!ref) return [];
    if (ref.type === 'movie') {
      // Movies are a single playable title — not "Episode 1".
      const details = await extractDetails('movie:' + ref.tmdbId);
      return [{
        number: 1,
        href: 'movie:' + ref.tmdbId,
        title: details.title || 'Full Movie',
        image: details.image || details.poster || '',
        isMovie: true,
        mediaType: 'movie',
        type: 'movie',
        subAvailable: true,
        dubAvailable: false,
      }];
    }
    // TV: expand seasons from TMDB
    try {
      const infoUrl =
        'https://api.themoviedb.org/3/tv/' +
        ref.tmdbId +
        '?api_key=' +
        TMDB_KEY +
        '&language=en-US';
      const infoRes = await settleWithin(request(infoUrl), 12000, null);
      const info = (infoRes && (infoRes.json || safeJsonParse(infoRes.body))) || {};
      const seasons = Array.isArray(info.seasons) ? info.seasons : [];
      const eps = [];
      const usable = seasons
        .filter((s) => s && Number(s.season_number) > 0)
        .sort((a, b) => Number(a.season_number) - Number(b.season_number));
      const deadline = Date.now() + 22000;
      const seasonResults = await mapBounded(usable, 3, async (season) => {
        if (remainingMs(deadline, 500) < 1000) throw new Error('Episode catalogue timed out; retry.');
        const sn = Number(season.season_number) || 1;
        const sUrl =
          'https://api.themoviedb.org/3/tv/' +
          ref.tmdbId +
          '/season/' +
          sn +
          '?api_key=' +
          TMDB_KEY +
          '&language=en-US';
        const sRes = await settleWithin(request(sUrl), Math.min(10000, remainingMs(deadline, 500)), null);
        if (!sRes || !sRes.ok) throw new Error('A season could not be loaded; retry.');
        const sData = (sRes && (sRes.json || safeJsonParse(sRes.body))) || {};
        const list = Array.isArray(sData.episodes) ? sData.episodes : [];
        return { sn, list };
      });
      const seen = new Set();
      for (const pack of seasonResults) {
        const sn = pack.sn;
        for (const ep of pack.list) {
          const en = Number(ep.episode_number);
          if (!Number.isInteger(en) || en < 1 || seen.has(sn + ':' + en)) continue;
          if (ep.air_date && Date.parse(ep.air_date) > Date.now()) continue;
          seen.add(sn + ':' + en);
          eps.push({
            number: eps.length + 1,
            seasonNumber: sn,
            episodeNumber: en,
            image: posterUrl(ep.still_path || ''),
            href: 'tv:' + ref.tmdbId + ':' + sn + ':' + en,
            title: 'S' + sn + 'E' + en + (ep.name ? ' · ' + cleanText(ep.name) : ''),
            subAvailable: true,
            dubAvailable: false,
          });
        }
      }
      return eps;
    } catch (e) {
      log('episodes error: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  function qualityHeight(q) {
    const s = String(q || '');
    const m = s.match(/(\d{3,4})/);
    return m ? Number(m[1]) : 0;
  }

  async function resolveVideasy(ref, deadline) {
    deadline = deadline || Date.now() + 17000;
    const headers = {
      'User-Agent': USER_AGENT,
      Referer: VIDEASY_ORIGIN + '/',
      Origin: VIDEASY_ORIGIN,
    };
    const tmdbId = ref.tmdbId;
    const mediaType = ref.type === 'tv' ? 'tv' : 'movie';
    const seasonId = ref.season || 1;
    const episodeId = ref.episode || 1;

    const seedRes = await settleWithin(
      request('https://api.speedracelight.com/seed?mediaId=' + encodeURIComponent(tmdbId), {
        headers: headers,
      }),
      Math.min(5000, remainingMs(deadline, 500)),
      null,
    );
    if (!seedRes || !seedRes.ok) return [];
    const seedJson = seedRes.json || safeJsonParse(seedRes.body) || {};
    const seed = seedJson.seed;
    if (!seed) return [];

    const servers = [
      { name: 'cdn', endpoint: 'cdn' },
      { name: 'm4uhd', endpoint: 'm4uhd' },
      { name: 'lamovie', endpoint: 'lamovie' },
    ];
    const streams = [];
    const seen = new Set();

    const results = [];
    const work = mapBounded(servers, 2, async (server) => {
      const found = [];
      if (remainingMs(deadline, 500) < 800) return found;
      try {
        const fullUrl =
          'https://api.speedracelight.com/' +
          server.endpoint +
          '/sources-with-title?title=&mediaType=' +
          mediaType +
          '&year=&episodeId=' +
          episodeId +
          '&seasonId=' +
          seasonId +
          '&tmdbId=' +
          tmdbId +
          '&imdbId=&enc=2&seed=' +
          encodeURIComponent(seed);
        const encRes = await settleWithin(
          request(fullUrl, { headers: headers }),
          Math.min(6000, remainingMs(deadline, 500)),
          null,
        );
        if (!encRes || !encRes.ok || !encRes.body) return found;
        if (/Attention Required|Just a moment/i.test(encRes.body)) return found;
        if (remainingMs(deadline, 500) < 800) return found;

        const postData = JSON.stringify({
          text: String(encRes.body).trim(),
          id: String(tmdbId),
          seed: seed,
        });
        const decRes = await settleWithin(
          request('https://enc-dec.app/api/dec-videasy', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': USER_AGENT,
            },
            body: postData,
          }),
          Math.min(6000, remainingMs(deadline, 500)),
          null,
        );
        if (!decRes || !decRes.ok) return found;
        const dec = decRes.json || safeJsonParse(decRes.body) || {};
        if (dec.status !== 200 || !dec.result) return found;
        const sources = Array.isArray(dec.result.sources) ? dec.result.sources : [];
        for (let i = 0; i < sources.length; i++) {
          const src = sources[i];
          if (!src || !src.url) continue;
          if (String(src.quality || '').includes('HDR')) continue;
          const h = qualityHeight(src.quality);
          found.push({
            label: 'STCine · Videasy ' + server.name + ' · ' + (src.quality || 'auto'),
            url: src.url,
            quality: h || src.quality || 'auto',
            streamType: /\.m3u8/i.test(src.url) ? 'hls' : 'mp4',
            kind: /\.m3u8/i.test(src.url) ? 'hls' : 'mp4',
            provider: 'stcine-videasy-' + server.name,
            subtitles: subtitleTracks(captionRows(src).length ? captionRows(src) : captionRows(dec.result), VIDEASY_ORIGIN + '/'),
            headers: {
              'User-Agent': USER_AGENT,
              Referer: VIDEASY_ORIGIN + '/',
              Origin: VIDEASY_ORIGIN,
            },
          });
        }
      } catch (e) {
        log('videasy server fail ' + server.name + ': ' + (e && e.message ? e.message : e));
      }
      results.push(found);
      return found;
    });
    await settleWithin(work, remainingMs(deadline, 100), []);
    results.forEach((rows) => rows.forEach((stream) => {
      const key = stream.url + JSON.stringify(stream.headers) + JSON.stringify(stream.subtitles);
      if (!seen.has(key)) { seen.add(key); streams.push(stream); }
    }));

    // Prefer seek-friendly ladders: 1080 first, then 720, then lower, then 4K last.
    // Free 4K HLS often seeks poorly (long GOPs / weak CDN range).
    streams.sort((a, b) => streamSeekScore(b) - streamSeekScore(a));
    return streams;
  }

  function streamSeekScore(s) {
    if (!s || !s.url) return -1;
    const h = Number(s.height) || qualityHeight(s.quality) || qualityHeight(s.label) || 0;
    let score = 0;
    if (s.segmentDead || s.playlistDead) return -100000;
    if (s.audioLanguageMismatch) return -100000;
    if (s.audioLanguageEnglish) score += 18000;
    if (s.segmentMimeRisky) score -= 40000;
    if (s.segmentProbeOk && !s.segmentMimeRisky) score += 15000;
    if (h === 1080) score += 10000;
    else if (h === 720) score += 8000;
    else if (h > 0 && h < 720) score += 4000 + h;
    else if (h >= 2160) score += 2500;
    else if (h > 1080) score += 3000;
    else score += 1000;
    if (s.kind === 'hls' || s.streamType === 'hls' || /\.m3u8/i.test(s.url || '')) score += 200;
    // Prefer real LookMovie TS when Videasy is jpeg-disguised junk.
    if (s.provider === 'lookmovie' && s.segmentProbeOk) score += 12000;
    else if (s.provider === 'lookmovie') score += 14000;
    if (/videasy-cdn/i.test(s.provider || '') && s.segmentProbeOk && !s.segmentMimeRisky) score += 1500;
    if (/videasy-(m4uhd|lamovie)/i.test(s.provider || '')) score -= 12000;
    return score;
  }

  function playlistAudioLanguages(body) {
    const found = [];
    const text = String(body || '');
    const re = /#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO[^\r\n]*/gi;
    let match;
    while ((match = re.exec(text))) {
      const line = match[0];
      const lang = (line.match(/LANGUAGE\s*=\s*["']?([^,"'\s]+)/i) || [])[1] || '';
      const name = (line.match(/NAME\s*=\s*["']([^"']+)/i) || [])[1] || '';
      const value = cleanText(lang || name).toLowerCase();
      if (value && found.indexOf(value) < 0) found.push(value);
    }
    return found;
  }

  function markAudioLanguageEvidence(stream, body) {
    const languages = playlistAudioLanguages(body);
    stream.audioLanguages = languages;
    if (!languages.length) return;
    const hasEnglish = languages.some(function (value) {
      return /^(en|eng|english)(-|$)/i.test(value);
    });
    stream.audioLanguageEnglish = hasEnglish;
    stream.audioLanguageMismatch = !hasEnglish;
  }

  function absoluteFromPlaylist(baseUrl, line) {
    const t = String(line || '').trim();
    if (!t) return '';
    if (/^https?:\/\//i.test(t)) return t;
    const base = String(baseUrl).match(/^(https?):\/\/([^/]+)([^?#]*)/i);
    if (!base || /^[a-z][a-z0-9+.-]*:/i.test(t)) return '';
    if (t.indexOf('//') === 0) return base[1] + ':' + t;
    const suffix = (t.match(/[?#].*$/) || [''])[0];
    const path = t.replace(/[?#].*$/, '');
    const parts = (path.charAt(0) === '/' ? path : base[3].replace(/[^/]*$/, '') + path).split('/');
    const normalized = [];
    parts.forEach((part) => {
      if (part === '..') normalized.pop();
      else if (part && part !== '.') normalized.push(part);
    });
    return base[1] + '://' + base[2] + '/' + normalized.join('/') + suffix;
  }

  function firstMediaUri(body) {
    const lines = String(body || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] || '').trim();
      if (!line || line.charAt(0) === '#') continue;
      return line;
    }
    return '';
  }

  async function softProbeStream(stream) {
    if (!stream || !stream.url) return stream;
    if (stream.kind !== 'hls' && stream.streamType !== 'hls' && !/\.m3u8/i.test(stream.url)) {
      const res = await settleWithin(request(stream.url, { headers: Object.assign({}, stream.headers, { Range: 'bytes=0-1023' }) }), 5000, null);
      const body = String(res && res.body || '');
      stream.segmentProbeOk = !!(res && res.ok && body.slice(4, 8) === 'ftyp');
      stream.segmentDead = !stream.segmentProbeOk;
      return stream;
    }
    try {
      const headers = Object.assign(
        { 'User-Agent': USER_AGENT, Accept: 'application/vnd.apple.mpegurl,*/*' },
        stream.headers || {},
      );
      const pl = await settleWithin(
        request(stream.url, { headers: headers }),
        8000,
        null,
      );
      if (!pl || !pl.ok || !pl.body || !/^\s*#EXTM3U/.test(pl.body)) {
        stream.playlistDead = true;
        stream.segmentDead = true;
        return stream;
      }
      const body = String(pl.body);
      const hlsCaptions = body.split(/\r?\n/).filter((line) => /^#EXT-X-MEDIA:/.test(line) && /TYPE=SUBTITLES/.test(line)).map((line) => ({
        url: (line.match(/\bURI="([^"]+)"/) || [])[1],
        language: (line.match(/\bLANGUAGE="([^"]+)"/) || [])[1],
        label: (line.match(/\bNAME="([^"]+)"/) || [])[1],
      }));
      // Segmented subtitle playlists need player support; only expose direct caption files.
      stream.subtitles = subtitleTracks((stream.subtitles || []).concat(hlsCaptions.filter((row) => /\.(vtt|srt)(?:[?#]|$)/i.test(row.url || ''))), stream.url);
      markAudioLanguageEvidence(stream, body);
      if (stream.audioLanguageMismatch) {
        log('softProbe rejected non-English audio for ' + (stream.label || ''));
        return stream;
      }
      // Fake Videasy playlists point at .jpg/.png/.css/.html "segments".
      if (/\.(jpg|jpeg|png|css|txt|html)(\?|$)/i.test(body) && !/\.ts(\?|$)/i.test(body)) {
        stream.segmentMimeRisky = true;
        stream.segmentDead = true;
        log('softProbe fake segment extensions for ' + (stream.label || ''));
        return stream;
      }
      let segUrl = absoluteFromPlaylist(stream.url, firstMediaUri(body));
      const visited = new Set([stream.url]);
      for (let depth = 0; segUrl && /\.m3u8(\?|$)/i.test(segUrl) && depth < 3; depth++) {
        if (visited.has(segUrl)) { stream.segmentDead = true; return stream; }
        visited.add(segUrl);
        const nested = await settleWithin(request(segUrl, { headers: headers }), 7000, null);
        if (nested && nested.ok && nested.body && /^\s*#EXTM3U/.test(nested.body)) {
          const nestedBody = String(nested.body);
          markAudioLanguageEvidence(stream, nestedBody);
          if (stream.audioLanguageMismatch) return stream;
          if (/\.(jpg|jpeg|png|css|txt|html)(\?|$)/i.test(nestedBody) && !/\.ts(\?|$)/i.test(nestedBody)) {
            stream.segmentMimeRisky = true;
            stream.segmentDead = true;
            return stream;
          }
          const nestedUri = firstMediaUri(nestedBody);
          if (nestedUri) segUrl = absoluteFromPlaylist(segUrl, nestedUri);
        } else {
          stream.segmentDead = true;
          return stream;
        }
      }
      if (!segUrl || /\.m3u8(?:[?#]|$)/i.test(segUrl)) {
        stream.segmentProbeFailed = true;
        return stream;
      }
      if (/\.(jpg|jpeg|png|css|html|txt)(\?|$)/i.test(segUrl)) {
        stream.segmentMimeRisky = true;
        stream.segmentDead = true;
        return stream;
      }
      const seg = await settleWithin(
        request(segUrl, {
          headers: Object.assign({}, headers, {
            Range: 'bytes=0-512',
            Accept: 'video/mp2t,video/*,*/*',
          }),
        }),
        8000,
        null,
      );
      if (!seg) {
        stream.segmentProbeFailed = true;
        stream.segmentDead = true;
        return stream;
      }
      const status = Number(seg.status || 0);
      const ctype = String(
        (seg.headers && (seg.headers['content-type'] || seg.headers['Content-Type'])) || '',
      ).toLowerCase();
      const raw = String(seg.body || '');
      const b0 = raw.length ? raw.charCodeAt(0) : 0;
      if (status === 401 || status === 403 || status === 404 || status >= 500) {
        stream.segmentDead = true;
        return stream;
      }
      if (ctype.indexOf('text/html') === 0 || /<!DOCTYPE|<html|Just a moment/i.test(raw)) {
        stream.segmentDead = true;
        stream.segmentMimeRisky = true;
        return stream;
      }
      if (ctype.indexOf('image/') === 0) {
        // jpeg-TS: often 0x47 but freezes / fails in player — treat as dead for STCine.
        stream.segmentMimeRisky = true;
        stream.segmentDead = true;
        log('softProbe image/* segment dead for ' + (stream.label || ''));
        return stream;
      }
      if (status >= 200 && status < 300 && raw.length && (b0 === 0x47 || ['ftyp', 'styp', 'moof'].includes(raw.slice(4, 8)))) {
        stream.segmentProbeOk = true;
        stream.segmentDead = false;
        stream.segmentMimeRisky = false;
      } else {
        stream.segmentProbeFailed = true;
      }
    } catch (e) {
      stream.segmentProbeFailed = true;
      stream.segmentDead = true;
    }
    return stream;
  }

  async function softProbeStreams(streams, deadlineMs) {
    const list = Array.isArray(streams) ? streams.slice(0, STREAM_PROBE_LIMIT) : [];
    const out = [];
    for (let i = 0; i < list.length; i += STREAM_PROBE_CONCURRENCY) {
      const remaining = remainingMs(deadlineMs, 600);
      if (remaining < 800) {
        break;
      }
      const batch = list.slice(i, i + STREAM_PROBE_CONCURRENCY);
      const timeout = Math.min(7500, remaining);
      const probed = await Promise.all(batch.map(function (stream) {
        return settleWithin(softProbeStream(Object.assign({}, stream)), timeout, null);
      }));
      for (let j = 0; j < probed.length; j++) out.push(probed[j]);
    }
    return out;
  }

  function lookmovieHeaders() {
    return {
      'User-Agent': USER_AGENT,
      Referer: LOOKMOVIE + '/',
      Origin: LOOKMOVIE,
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
    };
  }

  async function lookmovieRequest(url, options) {
    const opts = options || {};
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: opts.accept || 'application/json,text/html,*/*',
        Referer: LOOKMOVIE + '/',
        Origin: LOOKMOVIE,
      },
      opts.headers || {},
    );
    if (opts.xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
    return settleWithin(request(url, { headers: headers }), opts.timeout || 12000, null);
  }

  function expandHlsUrls(url) {
    const u = String(url || '');
    if (!u || u.indexOf('http') !== 0) return [];
    const out = [u];
    if (/\/index\.m3u8(\?|$)/i.test(u)) {
      const master = u.replace(/\/index\.m3u8/i, '/master.m3u8');
      if (master !== u) out.push(master);
    } else if (/\/master\.m3u8(\?|$)/i.test(u)) {
      const index = u.replace(/\/master\.m3u8/i, '/index.m3u8');
      if (index !== u) out.unshift(index);
    }
    return out;
  }

  function streamsFromLookmovieAccess(json) {
    const streams = (json && json.streams) || {};
    const out = [];
    const keys = Object.keys(streams).sort(function (a, b) {
      return (qualityHeight(b) || 0) - (qualityHeight(a) || 0);
    });
    for (let i = 0; i < keys.length; i++) {
      const rawUrl = streams[keys[i]];
      if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.indexOf('http') !== 0) continue;
      const height = qualityHeight(keys[i]) || qualityHeight(rawUrl) || 480;
      const urls = expandHlsUrls(rawUrl);
      for (let u = 0; u < urls.length; u++) {
        out.push({
          label: 'STCine · LookMovie ' + (height >= 360 ? height + 'p' : keys[i]),
          url: urls[u],
          quality: height,
          height: height,
          streamType: 'hls',
          kind: 'hls',
          provider: 'lookmovie',
          subtitles: subtitleTracks(captionRows(json), LOOKMOVIE + '/'),
          headers: lookmovieHeaders(),
        });
      }
    }
    return out;
  }

  async function findLookmovieMovie(title, year) {
    const queries = [];
    const push = function (v) {
      const s = cleanText(v);
      if (s && queries.indexOf(s) < 0) queries.push(s);
    };
    push(title);
    push(String(title || '').replace(/[:\-–—].*$/, ''));
    push(String(title || '').replace(/\s*\(\d{4}\)\s*$/, ''));
    if (year) push(cleanText(title) + ' ' + year);
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < queries.length; i++) {
      const res = await lookmovieRequest(
        LOOKMOVIE + '/api/v1/movies/do-search/?q=' + encodeURIComponent(queries[i]),
        { xhr: true, timeout: 10000 },
      );
      if (!res || !res.body) continue;
      let rows = [];
      try {
        rows = ((JSON.parse(res.body) || {}).result) || [];
      } catch (_) {
        rows = [];
      }
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        const t = normalizeTitleKey(row && row.title);
        const q = normalizeTitleKey(title);
        const rowYear = Number(row && row.year) || 0;
        const wantedYear = Number(year) || 0;
        const titleExact = t === q;
        const yearExact = !wantedYear || !rowYear || rowYear === wantedYear;
        let score = 0;
        if (titleExact) score += yearExact ? 1350 : 700;
        else if (!wantedYear && t.indexOf(q) === 0) score += 500;
        else if (!wantedYear && q.indexOf(t) === 0 && t.length >= 4) score += 400;
        else if (!wantedYear && (t.indexOf(q) >= 0 || q.indexOf(t) >= 0)) score += 200;
        if (wantedYear && rowYear === wantedYear) score += 350;
        if (score > bestScore) {
          bestScore = score;
          best = row;
        }
      }
      if (bestScore >= 1300) break;
    }
    if (!best || normalizeTitleKey(best.title) !== normalizeTitleKey(title)) return null;
    if (year && best.year && Number(best.year) !== Number(year)) return null;
    return best;
  }

  async function findLookmovieShow(title, year) {
    const queries = [];
    const push = function (v) {
      const s = cleanText(v);
      if (s && queries.indexOf(s) < 0) queries.push(s);
    };
    push(title);
    push(String(title || '').replace(/[:\-–—].*$/, ''));
    if (year) push(cleanText(title) + ' ' + year);
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < queries.length; i++) {
      const res = await lookmovieRequest(
        LOOKMOVIE + '/api/v1/shows/do-search/?q=' + encodeURIComponent(queries[i]),
        { xhr: true, timeout: 10000 },
      );
      if (!res || !res.body) continue;
      let rows = [];
      try {
        rows = ((JSON.parse(res.body) || {}).result) || [];
      } catch (_) {
        rows = [];
      }
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        const t = normalizeTitleKey(row && row.title);
        const q = normalizeTitleKey(title);
        const rowYear = Number(row && row.year) || 0;
        const wantedYear = Number(year) || 0;
        const titleExact = t === q;
        const yearExact = !wantedYear || !rowYear || rowYear === wantedYear;
        let score = 0;
        if (titleExact) score += yearExact ? 1350 : 700;
        else if (!wantedYear && t.indexOf(q) === 0) score += 500;
        else if (!wantedYear && q.indexOf(t) === 0 && t.length >= 4) score += 400;
        else if (!wantedYear && (t.indexOf(q) >= 0 || q.indexOf(t) >= 0)) score += 200;
        if (wantedYear && rowYear === wantedYear) score += 350;
        if (score > bestScore) {
          bestScore = score;
          best = row;
        }
      }
      if (bestScore >= 1300) break;
    }
    if (!best || normalizeTitleKey(best.title) !== normalizeTitleKey(title)) return null;
    if (year && best.year && Number(best.year) !== Number(year)) return null;
    return best;
  }

  function pickLookmovieEpisodeId(listPayload, season, episode) {
    const lst = listPayload;
    const s = String(season);
    const e = String(episode);
    if (lst && typeof lst === 'object' && !Array.isArray(lst)) {
      const seasonMap = lst[s] || lst[season];
      if (seasonMap && typeof seasonMap === 'object') {
        const cell = seasonMap[e] || seasonMap[episode];
        if (cell && cell.id_episode) return cell.id_episode;
      }
    }
    if (Array.isArray(lst)) {
      // An unlabeled season array is ambiguous; never search another season for the same episode number.
      const row = lst.find((item) => item && Number(item.season_number || item.season) === Number(season));
      if (!row) return null;
      const episodes = row.episodes || row;
      const cell = Array.isArray(episodes)
        ? episodes.find((item) => Number(item.episode_number || item.episode) === Number(episode))
        : episodes[e];
      return cell && cell.id_episode || null;
    }
    return null;
  }

  async function resolveLookmovie(ref) {
    try {
      const details = await extractDetails(
        ref.type === 'tv' ? 'tv:' + ref.tmdbId : 'movie:' + ref.tmdbId,
      );
      const title = details.title || '';
      const originalTitle = details.originalTitle || '';
      const year = details.year || '';

      if (ref.type === 'movie') {
        const cacheKey = 'movie:' + ref.tmdbId;
        let hit = lookmovieHitCache[cacheKey] || null;
        if (!hit) {
          hit = await findLookmovieMovie(title, year);
          if (!hit && originalTitle && originalTitle !== title) {
            hit = await findLookmovieMovie(originalTitle, year);
          }
          if (hit) lookmovieHitCache[cacheKey] = hit;
        }
        if (!hit) {
          log('lookmovie no match for ' + title);
          return [];
        }
        const view = await lookmovieRequest(
          LOOKMOVIE + '/movies/view/' + encodeURIComponent(hit.slug),
          { accept: 'text/html,*/*', timeout: 12000 },
        );
        if (!view || !view.body) return [];
        const playPath = (String(view.body).match(/href="(\/movies\/play\/[^"]+)"/i) || [])[1];
        if (!playPath) return [];
        const play = await lookmovieRequest(LOOKMOVIE + playPath, {
          accept: 'text/html,*/*',
          timeout: 12000,
        });
        if (!play || !play.body) return [];
        const text = String(play.body);
        const idMovie = (text.match(/id_movie:\s*(\d+)/) || [])[1];
        const hash = (text.match(/hash:\s*['"]([^'"]+)['"]/) || [])[1];
        const expires = (text.match(/expires:\s*(\d+)/) || [])[1];
        if (!idMovie || !hash || !expires) return [];
        const acc = await lookmovieRequest(
          LOOKMOVIE +
            '/api/v1/security/movie-access?id_movie=' +
            idMovie +
            '&hash=' +
            encodeURIComponent(hash) +
            '&expires=' +
            encodeURIComponent(expires),
          { xhr: true, timeout: 12000 },
        );
        if (!acc || !acc.body) return [];
        const json = safeJsonParse(acc.body);
        if (!json || !json.success) return [];
        return streamsFromLookmovieAccess(json);
      }

      // TV episode via LookMovie
      const season = ref.season || 1;
      const episode = ref.episode || 1;
      const cacheKey = 'tv:' + ref.tmdbId;
      let hit = lookmovieHitCache[cacheKey] || null;
      if (!hit) {
        hit = await findLookmovieShow(title, year);
        if (!hit && originalTitle && originalTitle !== title) {
          hit = await findLookmovieShow(originalTitle, year);
        }
        if (hit) lookmovieHitCache[cacheKey] = hit;
      }
      if (!hit || !hit.id_show) {
        log('lookmovie no TV match for ' + title);
        return [];
      }
      const listRes = await lookmovieRequest(
        LOOKMOVIE + '/api/v2/download/episode/list?id=' + encodeURIComponent(String(hit.id_show)),
        { xhr: true, timeout: 12000 },
      );
      if (!listRes || !listRes.body) return [];
      let list = {};
      try {
        list = (JSON.parse(listRes.body) || {}).list || {};
      } catch (_) {
        list = {};
      }
      const eid = pickLookmovieEpisodeId(list, season, episode);
      if (!eid) {
        log('lookmovie missing episode ' + season + 'x' + episode);
        return [];
      }
      const view = await lookmovieRequest(
        LOOKMOVIE + '/shows/view/' + encodeURIComponent(hit.slug),
        { accept: 'text/html,*/*', timeout: 12000 },
      );
      if (!view || !view.body) return [];
      const playPath = (String(view.body).match(/href="(\/shows\/play\/[^"]+)"/i) || [])[1];
      if (!playPath) return [];
      const play = await lookmovieRequest(LOOKMOVIE + playPath, {
        accept: 'text/html,*/*',
        timeout: 12000,
      });
      if (!play || !play.body) return [];
      const text = String(play.body);
      const hash = (text.match(/hash:\s*['"]([^'"]+)['"]/) || [])[1];
      const expires = (text.match(/expires:\s*(\d+)/) || [])[1];
      if (!hash || !expires) return [];
      const acc = await lookmovieRequest(
        LOOKMOVIE +
          '/api/v1/security/episode-access?id_episode=' +
          encodeURIComponent(String(eid)) +
          '&hash=' +
          encodeURIComponent(hash) +
          '&expires=' +
          encodeURIComponent(expires),
        { xhr: true, timeout: 12000 },
      );
      if (!acc || !acc.body) return [];
      const json = safeJsonParse(acc.body);
      if (!json || !json.success) return [];
      const raw = json.streams || {};
      const norm = {};
      Object.keys(raw).forEach(function (k) {
        norm[/p$/i.test(k) ? k : k + 'p'] = raw[k];
      });
      json.streams = norm;
      return streamsFromLookmovieAccess(json);
    } catch (e) {
      log('lookmovie fail: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  async function extractStreamUrl(episodeHref, lang) {
    const ref = parseHref(episodeHref);
    if (!ref) return { streams: [] };
    // This source exposes its original-language route, not a separately verified dub.
    if (String(lang || 'sub').toLowerCase() === 'dub') return { streams: [], subtitles: [] };
    log('extractStreamUrl ' + ref.type + ' ' + ref.tmdbId + ' s' + (ref.season || 1) + 'e' + (ref.episode || 1));
    const deadlineMs = Date.now() + STREAM_RESOLVE_BUDGET_MS;

    let streams = [];
    const providerBudget = Math.min(17500, remainingMs(deadlineMs, 8000));
    const providerResults = await Promise.all([
      settleWithin(resolveVideasy(ref, Date.now() + providerBudget - 100), providerBudget, []),
      settleWithin(resolveLookmovie(ref), providerBudget, []),
    ]);
    const videasy = providerResults[0] || [];
    for (let i = 0; i < videasy.length; i++) {
      if (videasy[i] && videasy[i].url) {
        videasy[i].height = qualityHeight(videasy[i].quality) || videasy[i].height || 0;
        streams.push(videasy[i]);
      }
    }
    // LookMovie for movies + TV — real .ts when Videasy is jpeg-junk.
    const lm = providerResults[1] || [];
    for (let i = 0; i < lm.length; i++) {
      if (lm[i] && lm[i].url) streams.push(lm[i]);
    }

    if (!streams.length) return { streams: [] };

    const seenUrls = Object.create(null);
    streams = streams.filter(function (stream) {
      const url = stream && String(stream.url || '');
      const key = url + JSON.stringify(stream.headers || {}) + JSON.stringify(stream.subtitles || []);
      if (!url || seenUrls[key]) return false;
      seenUrls[key] = true;
      return true;
    });
    streams.sort(function (a, b) {
      return streamSeekScore(b) - streamSeekScore(a);
    });

    const probed = await softProbeStreams(streams, deadlineMs);
    const good = probed.filter(function (s) {
      return s && s.url && s.segmentProbeOk && !s.segmentDead && !s.playlistDead && !s.segmentMimeRisky && !s.audioLanguageMismatch;
    });
    good.sort(function (a, b) {
      return streamSeekScore(b) - streamSeekScore(a);
    });
    // Reliability and language confidence outrank resolution. The old HD-first
    // partition could promote a less trustworthy host after scoring completed.
    let ordered = good.slice(0, 8);
    if (!ordered.length) {
      log('extractStreamUrl no playable streams after probe');
      return { streams: [] };
    }

    const entries = ordered.map(function (s, idx) {
        const h = Number(s.height) || qualityHeight(s.quality) || qualityHeight(s.label) || 0;
        return {
          label: s.label,
          url: s.url,
          height: h || undefined,
          quality: h >= 360 ? h + 'p' : s.quality,
          streamType: s.streamType || 'hls',
          kind: s.kind || 'hls',
          provider: s.provider,
          name: String(s.provider || 'Source').replace(/^stcine-/, ''),
          serverKey: s.provider,
          headers: s.headers,
          subtitles: s.subtitles || [],
          lang: 'sub',
          preferred: idx === 0,
          segmentProbeOk: !!s.segmentProbeOk,
          audioLanguages: s.audioLanguages || [],
        };
      });
    const seenServers = new Set();
    const servers = entries.slice().sort((a, b) => (b.height || 0) - (a.height || 0)).filter((entry) => {
      const key = entry.serverKey + JSON.stringify(entry.headers || {});
      if (seenServers.has(key)) return false;
      seenServers.add(key);
      return true;
    });
    const top = entries[0];
    // The current runtime can select a different candidate by resolution or
    // response time. Global captions are safe only if every candidate shares them.
    const sharedCaptions = entries.every((entry) => JSON.stringify(entry.subtitles) === JSON.stringify(top.subtitles))
      ? top.subtitles : [];
    return {
      streams: entries,
      qualities: entries,
      servers,
      subtitles: sharedCaptions,
      headers: { 'User-Agent': USER_AGENT },
      streamType: top.streamType || 'hls',
      quality: (Number(top.height) || qualityHeight(top.quality) || 0) >= 360
        ? (Number(top.height) || qualityHeight(top.quality)) + 'p'
        : top.quality,
      lang: String(lang || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub',
    };
  }

  function sectionFrom(id, title, items, feedId, style, limit) {
    if (!items || !items.length) return null;
    const max = Math.max(1, Number(limit) || 24);
    const section = {
      id: id,
      title: title,
      style: style || 'poster',
      items: items.slice(0, max).map((c, i) => ({
        href: c.href,
        title: c.title,
        image: c.image || c.poster || c.backdrop || '',
        poster: c.poster || c.image || '',
        rank: i + 1,
        type: c.type || c.mediaType || (c.isMovie ? 'movie' : undefined),
        mediaType: c.mediaType || c.type || (c.isMovie ? 'movie' : undefined),
        isMovie: !!c.isMovie || c.type === 'movie' || c.mediaType === 'movie',
      })),
    };
    if (feedId) section.viewAll = { mode: 'feed', feedId: feedId };
    return section;
  }

  function filterReleasedCards(items) {
    return (Array.isArray(items) ? items : []).filter(function (card) {
      if (!card) return false;
      const raw = cleanText(card.releaseDate || card.release_date || '');
      if (!raw) return true;
      const timestamp = Date.parse(raw);
      // Unknown/malformed dates are retained; only an explicit future date is
      // enough to hide a home card. STCine currently labels future records as
      // published even though their provider list is empty.
      return !Number.isFinite(timestamp) || timestamp <= Date.now();
    });
  }

  function mergeUniqueCards(primary, secondary) {
    const out = [];
    const seen = Object.create(null);
    const add = function (card) {
      if (!card || !card.href || seen[card.href]) return;
      seen[card.href] = true;
      out.push(card);
    };
    (Array.isArray(primary) ? primary : []).forEach(add);
    (Array.isArray(secondary) ? secondary : []).forEach(add);
    return out;
  }

  async function tmdbTrending() {
    const url =
      'https://api.themoviedb.org/3/trending/all/week?api_key=' +
      TMDB_KEY +
      '&language=en-US';
    const res = await settleWithin(request(url), 12000, null);
    if (!res || !res.ok) return [];
    const data = res.json || safeJsonParse(res.body) || {};
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .filter((r) => r && (r.media_type === 'movie' || r.media_type === 'tv'))
      .map((r) => {
        const card = cardFromTmdb(r);
        if (!card) return null;
        // Hero prefers wide art when available
        const backdrop = posterUrl(r.backdrop_path);
        if (backdrop) {
          card.image = backdrop.replace('/w500/', '/w780/');
          card.backdrop = card.image;
        }
        return card;
      })
      .filter(Boolean)
      .slice(0, 12);
  }

  async function discoveryHome() {
    try {
      const packs = await mapBounded([
        () => stcineList('movie', 1, ''), () => stcineList('tv', 1, ''),
        () => tmdbPopular('movie', 1), () => tmdbPopular('tv', 1), () => tmdbTrending(),
      ], 3, (run) => run());
      let movies = filterReleasedCards(packs[0]);
      let tv = filterReleasedCards(packs[1]);
      const popMovies = filterReleasedCards(packs[2]);
      const popTv = filterReleasedCards(packs[3]);
      const trending = filterReleasedCards(packs[4]);
      movies = mergeUniqueCards(popMovies, movies).slice(0, 24);
      tv = mergeUniqueCards(popTv, tv).slice(0, 24);

      const sections = [];
      // Featured big cards (hero) — same pattern as X-Stream / Elisworld
      const featured = trending.length ? trending : movies.slice(0, 8);
      const sHero = sectionFrom('featured', 'Featured', featured, 'movies', 'hero', 8);
      const sTop = sectionFrom('top10', 'Top 10', (trending.length ? trending : movies).slice(0, 10), 'movies', 'top10', 10);
      const s1 = sectionFrom('popular-movies', 'Popular movies', movies, 'movies', 'poster', 24);
      const s2 = sectionFrom('popular-tv', 'Popular TV', tv, 'tv', 'poster', 24);
      if (sHero) sections.push(sHero);
      if (sTop) sections.push(sTop);
      if (s1) sections.push(s1);
      if (s2) sections.push(s2);
      return { sections };
    } catch (e) {
      log('home error: ' + (e && e.message ? e.message : String(e)));
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedId, page) {
    const pageNumber = Math.max(1, Number(page) || 1);
    const key = String(feedId || 'movies').toLowerCase();
    try {
      const type = key.includes('tv') ? 'tv' : 'movie';
      // Home already leads with canonical TMDB cards. Keep the same catalogue
      // for every feed page, rather than mixing page-one fallback with site pages.
      const rawItems = await tmdbPopular(type, pageNumber);
      const items = filterReleasedCards(rawItems);
      const visibleItems = items.filter((c) => c && (c.image || c.poster));
      return {
        items: visibleItems.map((c) => ({
          href: c.href,
          title: c.title,
          image: c.image,
          poster: c.image,
          type: c.type,
          mediaType: c.mediaType,
          isMovie: c.isMovie,
        })),
        page: pageNumber,
        hasMore: rawItems.length >= 20,
      };
    } catch (e) {
      log('feed error: ' + (e && e.message ? e.message : String(e)));
      return { items: [], page: pageNumber, hasMore: false };
    }
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
})();
