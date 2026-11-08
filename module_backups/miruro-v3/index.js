(() => {
  'use strict';

  const MODULE_NAME = 'Miruro';
  const BASE_URL = 'https://www.miruro.to';
  const ANILIST_URL = 'https://graphql.anilist.co';
  const KITSU_API = 'https://kitsu.io/api/edge';
  const HIANIME_BASE = 'https://hianimes.ru';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

  const TIMEOUT_MS = 10000;
  const SEARCH_TIMEOUT_MS = 12000;
  const STREAM_TIMEOUT_MS = 9000;

  // Curated fallback featured anime for instant zero-latency discovery
  const FALLBACK_FEATURED = [
    { id: '16498', title: 'Attack on Titan', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg' },
    { id: '1535', title: 'Death Note', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg' },
    { id: '101922', title: 'Demon Slayer: Kimetsu no Yaiba', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg' },
    { id: '113415', title: 'JUJUTSU KAISEN', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg' },
    { id: '21', title: 'ONE PIECE', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg' },
    { id: '269', title: 'Bleach', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png' },
    { id: '20', title: 'Naruto', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg' },
    { id: '11061', title: 'Hunter x Hunter (2011)', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png' },
    { id: '5114', title: 'Fullmetal Alchemist: Brotherhood', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-1Q1tBbz5n0n0.jpg' },
    { id: '127230', title: 'Chainsaw Man', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx127230-0eQeZ3QZ5Q3c.jpg' },
    { id: '147105', title: 'Solo Leveling', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx147105-0E7Z3zYq0e0e.jpg' },
    { id: '137822', title: 'Frieren: Beyond Journey\'s End', image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx137822-4a4b4c4d4e4f.jpg' }
  ];

  // In-flight request deduplication and local memory caches
  const detailsCache = Object.create(null);
  const episodesCache = Object.create(null);
  const streamCache = Object.create(null);

  function log(msg) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(msg || ''));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.max(1, Number(ms) || 0));
    });
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([promise, sleep(waitMs).then(() => fallback)]);
  }

  function safeJsonParse(text) {
    if (text !== null && typeof text === 'object') return text;
    try {
      return JSON.parse(String(text == null ? '' : text).trim());
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
      .replace(/<[^>]*>/g, '')
      .trim();
  }

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function cleanForCompare(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\bre[:\s\-_]*zero\b/g, 're zero')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractSeasonNumber(str) {
    const s = String(str || '').toLowerCase();
    const ordMatch = s.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i);
    if (ordMatch) return parseInt(ordMatch[1], 10);
    const sMatch = s.match(/\b(?:season\s*(\d+)|s(\d+))\b/i);
    if (sMatch) return parseInt(sMatch[1] || sMatch[2], 10);
    const romanMatch = s.match(/\b(?:season|part)\s*(iv|iii|ii|i)\b/i) || s.match(/\b(iv|iii|ii)\b/i);
    if (romanMatch) {
      const r = (romanMatch[1] || '').toLowerCase();
      if (r === 'iv') return 4;
      if (r === 'iii') return 3;
      if (r === 'ii') return 2;
      if (r === 'i') return 1;
    }
    if (/\bfinal\s*season\b/i.test(s)) return 4;
    return 1;
  }

  function generateSearchQueries(title, altTitle, synonyms) {
    const list = [];
    const seen = new Set();
    function add(q) {
      if (!q) return;
      const clean = String(q).trim().replace(/\s+/g, ' ');
      if (clean.length < 2) return;
      const key = clean.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        list.push(clean);
      }
    }

    add(title);
    add(altTitle);

    for (const t of [title, altTitle]) {
      if (!t) continue;
      add(t.replace(/\s*-\s*/g, ' ').replace(/^-+|-+$/g, ''));
      const parts = t.split(/\s*[:\-–—|/]\s*/);
      if (parts[0] && parts[0].trim().length >= 3) add(parts[0].trim());

      if (/\bre[:\s\-_]*zero\b/i.test(t)) {
        add('Re:Zero');
        add('rezero');
      }

      const words = t.replace(/[^a-zA-Z0-9\s:]+/g, ' ').trim().split(/\s+/);
      if (words.length >= 3) {
        add(words.slice(0, 2).join(' '));
        add(words.slice(0, 3).join(' '));
      }
    }

    if (Array.isArray(synonyms)) {
      for (const s of synonyms) {
        if (/^[a-zA-Z0-9\s:’'\-]+$/.test(s)) add(s);
      }
    }

    return list;
  }

  function pairScore(target, card) {
    const cT = cleanForCompare(target);
    const cC = cleanForCompare(card);
    if (!cT || !cC) return 0;

    if (cT === cC) return 1000;

    if (cC.startsWith(cT + ' ') || cT.startsWith(cC + ' ')) {
      const lenRatio = Math.min(cT.length, cC.length) / Math.max(cT.length, cC.length);
      return Math.round(700 * lenRatio);
    }

    const s1 = new Set(cT.split(' ').filter(Boolean));
    const s2 = new Set(cC.split(' ').filter(Boolean));
    let inter = 0;
    for (const w of s1) {
      if (s2.has(w)) inter++;
    }
    const dice = (2 * inter) / (s1.size + s2.size);
    if (dice < 0.4) return 0;
    return Math.round(dice * 500);
  }

  function scoreCard(targetTitle, targetAlt, cardTitle, cardJname) {
    const targetSeason = extractSeasonNumber(targetTitle) !== 1
      ? extractSeasonNumber(targetTitle)
      : extractSeasonNumber(targetAlt);
    const cardSeason = extractSeasonNumber(cardTitle) !== 1
      ? extractSeasonNumber(cardTitle)
      : extractSeasonNumber(cardJname);

    let maxBase = 0;
    const targets = [targetTitle, targetAlt].filter(Boolean);
    const cards = [cardTitle, cardJname].filter(Boolean);

    for (const t of targets) {
      for (const c of cards) {
        const s = pairScore(t, c);
        if (s > maxBase) maxBase = s;
      }
    }

    if (maxBase === 0) return 0;

    let finalScore = maxBase;
    if (targetSeason === cardSeason) finalScore += 200;
    else finalScore -= 400;

    return Math.max(finalScore, 0);
  }

  /* ────────────────────────── HTTP Request Layer ────────────────────────── */

  async function readResponseBody(res) {
    if (!res) return '';
    if (res.json !== undefined && res.json !== null && typeof res.json !== 'function') {
      try {
        return JSON.stringify(res.json);
      } catch (_) {}
    }
    if (typeof res.body === 'string' && res.body.length) return res.body;
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

  async function readResponseJson(res, textBody) {
    if (res && res.json !== undefined && res.json !== null && typeof res.json !== 'function') {
      return res.json;
    }
    let json = safeJsonParse(textBody);
    if (json != null) return json;
    if (res && typeof res.json === 'function') {
      try {
        json = await res.json();
        if (json != null) return json;
      } catch (_) {}
    }
    return null;
  }

  async function request(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const defaultHeaders = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    const headers = Object.assign(defaultHeaders, options.headers || {});
    const body = options.body == null ? null : options.body;

    try {
      let res;
      if (typeof fetchv2 === 'function') {
        res = await fetchv2(url, headers, method, body, { timeoutMs: TIMEOUT_MS });
      } else if (typeof fetch === 'function') {
        res = await fetch(url, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          redirect: 'follow',
        });
      } else {
        return { ok: false, status: 0, body: '', json: null, headers: {} };
      }

      const status = Number((res && res.status) || 0);
      const textBody = await readResponseBody(res);
      const resHeaders = (res && res.headers) || {};

      return {
        ok: !!(res && (res.ok === true || (status >= 200 && status < 300))),
        status,
        body: textBody,
        json: await readResponseJson(res, textBody),
        headers: resHeaders,
        text: async () => textBody,
      };
    } catch (e) {
      log('Provider request failed');
      return { ok: false, status: 0, body: '', json: null, headers: {}, text: async () => '' };
    }
  }

  /* ────────────────────────── AniList & Kitsu Layer ────────────────────────── */

  async function anilistQuery(query, variables = {}, retries = 0) {
    const res = await request(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Referer: 'https://anilist.co/',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && retries < 2) {
        await sleep(500 * (retries + 1));
        return anilistQuery(query, variables, retries + 1);
      }
      throw new Error('AniList request failed: HTTP ' + res.status);
    }
    const data = res.json || safeJsonParse(res.body);
    if (data && data.errors && data.errors.length) {
      throw new Error('AniList error: ' + data.errors[0].message);
    }
    return data && data.data;
  }

  async function fallbackKitsuSearch(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const url = `${KITSU_API}/anime?filter[text]=${encodeURIComponent(term)}&page[limit]=20`;
    const res = await settleWithin(request(url), SEARCH_TIMEOUT_MS, null);
    if (!res || !res.ok || !res.json) return [];
    const data = res.json.data || [];
    const cards = data.map((item) => {
      const attr = item.attributes || {};
      const titles = attr.titles || {};
      const enTitle = titles.en || titles.en_us;
      const title = enTitle || attr.canonicalTitle || titles.en_jp || 'Anime';
      const image = attr.posterImage ? attr.posterImage.large || attr.posterImage.original : '';
      const href = `${BASE_URL}/info/kitsu-${item.id}/${slugify(title)}?cb=11`;
      const allTitles = [title, attr.canonicalTitle, titles.en, titles.en_us, titles.en_jp].filter(Boolean);
      const score = Math.max(0, ...allTitles.map(t => pairScore(term, t)));
      return {
        id: href,
        href,
        title,
        image,
        poster: image,
        type: 'video',
        episodes: attr.episodeCount || null,
        rating: attr.averageRating ? String(Math.round(Number(attr.averageRating))) : null,
        year: attr.startDate ? attr.startDate.slice(0, 4) : null,
        _score: score,
      };
    });

    cards.sort((a, b) => b._score - a._score);
    return cards.map(({ _score, ...rest }) => rest);
  }

  function mediaToCard(media) {
    if (!media || !media.id) return null;
    const id = String(media.id);
    const titleObj = media.title || {};
    const title = titleObj.english || titleObj.romaji || titleObj.native || `Anime ${id}`;
    const coverObj = media.coverImage || {};
    const image = coverObj.extraLarge || coverObj.large || media.bannerImage || '';
    const href = `${BASE_URL}/info/${id}/${slugify(title)}?cb=11`;
    return {
      id: href,
      href,
      title,
      image,
      poster: image,
      type: 'video',
      episodes: media.episodes || null,
      rating: media.averageScore ? String(media.averageScore) : null,
      year: media.seasonYear ? String(media.seasonYear) : null,
    };
  }

  function parseIdFromHref(href) {
    const raw = String(href || '').trim();
    const kitsuMatch = raw.match(/(?:info|watch|series|anime)\/kitsu-(\d+)/i) || raw.match(/^miruro\|kitsu-(\d+)/i);
    if (kitsuMatch) return { isKitsu: true, id: Number(kitsuMatch[1]), rawId: `kitsu-${kitsuMatch[1]}` };
    const anilistMatch = raw.match(/(?:info|watch|series|anime)\/(\d+)/i) || raw.match(/^miruro\|(\d+)/i) || (raw.match(/^\d+$/) ? [null, raw] : null);
    if (anilistMatch) return { isKitsu: false, id: Number(anilistMatch[1]), rawId: String(anilistMatch[1]) };
    return { isKitsu: false, id: 0, rawId: '' };
  }

  /* ────────────────────────── Search & Details ────────────────────────── */

  async function searchResults(query, page = 0) {
    const q = String(query || '').trim();
    const pageNum = Math.max(1, Number(page) + 1 || 1);

    const isBrowse = !q;
    const gqlQuery = isBrowse
      ? `query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,sort:POPULARITY_DESC,isAdult:false){id format episodes duration title{english romaji native}coverImage{extraLarge large}bannerImage averageScore seasonYear}}}`
      : `query($q:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,search:$q,sort:SEARCH_MATCH,isAdult:false){id format episodes duration title{english romaji native}coverImage{extraLarge large}bannerImage averageScore seasonYear}}}`;

    const variables = isBrowse ? { page: pageNum, perPage: 24 } : { q, page: pageNum, perPage: 24 };

    try {
      const data = await anilistQuery(gqlQuery, variables);
      const mediaList = data && data.Page && data.Page.media;
      if (Array.isArray(mediaList) && mediaList.length > 0) {
        const results = [];
        const seen = new Set();
        for (const m of mediaList) {
          const card = mediaToCard(m);
          if (card && !seen.has(card.href)) {
            seen.add(card.href);
            if (!isBrowse) {
              const allTitles = [m.title && m.title.english, m.title && m.title.romaji, card.title].filter(Boolean);
              card._score = Math.max(0, ...allTitles.map((t) => pairScore(q, t)));
            }
            results.push(card);
          }
        }
        if (!isBrowse) {
          results.sort((a, b) => (b._score || 0) - (a._score || 0));
          return results.map(({ _score, ...rest }) => rest);
        }
        return results;
      }
    } catch (e) {
      log('AniList search failed, trying Kitsu fallback: ' + (e && e.message ? e.message : String(e)));
    }

    // Fallback if AniList is rate limited or unavailable
    if (q) {
      const fallback = await fallbackKitsuSearch(q);
      if (fallback.length) return fallback;
      return [];
    }

    // Default browse fallback (only reached when !q and AniList fails)
    return FALLBACK_FEATURED.map((f) => ({
      id: `${BASE_URL}/info/${f.id}/${slugify(f.title)}?cb=11`,
      href: `${BASE_URL}/info/${f.id}/${slugify(f.title)}?cb=11`,
      title: f.title,
      image: f.image,
      poster: f.image,
      type: 'video',
      episodes: 24,
      rating: '85',
      year: '2022',
    }));
  }

  async function extractDetails(urlOrId) {
    const parsed = parseIdFromHref(urlOrId);
    if (!parsed.id) throw new Error('Miruro details missing valid id');
    const cacheKey = parsed.rawId;
    if (detailsCache[cacheKey]) return detailsCache[cacheKey];

    if (!parsed.isKitsu) {
      try {
        const gqlQuery = `query($id:Int){Media(id:$id,type:ANIME){id title{english romaji native}synonyms description coverImage{extraLarge large}bannerImage status episodes duration genres averageScore seasonYear}}`;
        const data = await anilistQuery(gqlQuery, { id: parsed.id });
        const media = data && data.Media;
        if (media) {
          const titleObj = media.title || {};
          const title = titleObj.english || titleObj.romaji || titleObj.native || `AniList ${parsed.id}`;
          const coverObj = media.coverImage || {};
          const image = coverObj.extraLarge || coverObj.large || media.bannerImage || '';

          const details = {
            title,
            description: decodeHtml(media.description || ''),
            image,
            bannerImage: media.bannerImage || image,
            status: media.status || '',
            episodes: media.episodes || null,
            duration: media.duration || null,
            genres: Array.isArray(media.genres) ? media.genres : [],
            rating: media.averageScore || null,
            url: `${BASE_URL}/info/${parsed.id}/${slugify(title)}?cb=11`,
            aliases: titleObj.romaji && titleObj.romaji !== title ? titleObj.romaji : '',
            synonyms: Array.isArray(media.synonyms) ? media.synonyms : [],
          };

          detailsCache[cacheKey] = details;
          return details;
        }
      } catch (e) {
        log('AniList details error for ' + parsed.id + ': ' + (e && e.message ? e.message : String(e)));
      }
    }

    // Fallback details using Kitsu API or slug title
    const rawUrl = String(urlOrId || '');
    const slugMatch = rawUrl.match(/\/info\/(?:kitsu-)?\d+\/([^?#]+)/i) || rawUrl.match(/info\/([^?#]+)/i);
    const slugTitle = slugMatch ? decodeURIComponent(slugMatch[1]).replace(/[-_+]+/g, ' ').trim() : '';

    try {
      const kitsuId = parsed.id;
      const kitsuUrl = `${KITSU_API}/anime/${kitsuId}`;
      const kRes = await settleWithin(request(kitsuUrl), SEARCH_TIMEOUT_MS, null);
      if (kRes && kRes.ok && kRes.json && kRes.json.data) {
        const attr = kRes.json.data.attributes || {};
        const titles = attr.titles || {};
        const title = titles.en || titles.en_us || attr.canonicalTitle || titles.en_jp || slugTitle;
        const aliases = titles.en_jp && titles.en_jp !== title ? titles.en_jp : (titles.ja_jp || '');
        const image = attr.posterImage ? (attr.posterImage.extraLarge || attr.posterImage.large || attr.posterImage.original) : '';
        const details = {
          title,
          description: decodeHtml(attr.synopsis || attr.description || ''),
          image,
          bannerImage: (attr.coverImage && attr.coverImage.large) || image,
          status: attr.status || '',
          episodes: attr.episodeCount || null,
          duration: attr.episodeLength || null,
          genres: [],
          rating: attr.averageRating ? Math.round(Number(attr.averageRating)) : null,
          url: `${BASE_URL}/info/${parsed.rawId}/${slugify(title)}?cb=11`,
          aliases,
          synonyms: Array.isArray(attr.abbreviatedTitles) ? attr.abbreviatedTitles : [],
        };
        detailsCache[cacheKey] = details;
        return details;
      }
    } catch (_) {}

    const fallbackItem = FALLBACK_FEATURED.find((f) => f.id === String(parsed.id)) || {
      id: String(parsed.id),
      title: slugTitle || `Anime ${parsed.id}`,
      image: '',
    };

    const resolvedTitle = slugTitle || fallbackItem.title;

    const details = {
      title: resolvedTitle,
      description: `Watch ${resolvedTitle} online in high quality.`,
      image: fallbackItem.image,
      bannerImage: fallbackItem.image,
      status: 'FINISHED',
      episodes: null,
      duration: 24,
      genres: ['Action', 'Adventure', 'Fantasy'],
      rating: 85,
      url: `${BASE_URL}/info/${parsed.rawId}/${slugify(resolvedTitle)}?cb=11`,
      aliases: '',
      synonyms: [],
    };

    detailsCache[cacheKey] = details;
    return details;
  }

  /* ────────────────────────── Provider Mapping & Scrapers ────────────────────────── */

  async function searchHiAnimeShow(title, altTitle = '', synonyms = []) {
    const queries = generateSearchQueries(title, altTitle, synonyms);
    const cardRe =
      /<div class="flw-item[^>]*>[\s\S]*?href="(\/info\/[^"\s]+)["\s][\s\S]*?<div class="film-detail">[\s\S]*?<a[^>]*data-jname="([^"]*)"[^>]*>([^<]*)<\/a>/g;

    let best = null;
    let bestScore = 0;
    const seenCards = new Set();

    for (const q of queries) {
      if (bestScore >= 1100) break;

      const url = HIANIME_BASE + '/filter?keyword=' + encodeURIComponent(q);
      const res = await settleWithin(request(url), SEARCH_TIMEOUT_MS, null);
      if (!res || !res.ok || !res.body) continue;

      const html = res.body;
      let match;
      while ((match = cardRe.exec(html)) !== null) {
        const href = match[1];
        const jname = decodeHtml(match[2]);
        const visible = decodeHtml(match[3]);
        const slug = href.replace(/^\/info\//, '');
        const idMatch = slug.match(/(\d+)$/);
        const id = idMatch ? idMatch[1] : '';
        if (!id || seenCards.has(id)) continue;
        seenCards.add(id);

        const score = scoreCard(title, altTitle, visible, jname);
        if (score > bestScore && score >= 100) {
          bestScore = score;
          best = { id, slug, href: HIANIME_BASE + href, title: visible, jname, score };
        }
      }
    }

    return best;
  }

  async function fetchHiAnimeEpisodes(showId, showSlug) {
    const url = HIANIME_BASE + '/ajax/v2/episode/list/' + showId;
    const res = await settleWithin(
      request(url, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Referer: HIANIME_BASE + '/info/' + (showSlug || showId),
        },
      }),
      TIMEOUT_MS,
      null
    );

    const data = res && res.json;
    if (!data || !Array.isArray(data.episodeData)) return [];

    const dubSet = new Set(Array.isArray(data.dubEpisodes) ? data.dubEpisodes.map(Number) : []);
    const episodes = [];

    for (const ep of data.episodeData) {
      const num = Number(ep.episode_number || 0);
      if (num < 1) continue;
      const malId = Number(ep.mal_id || num);
      episodes.push({
        number: num,
        id: String(malId),
        title: ep.title ? String(ep.title).trim() : `Episode ${num}`,
        subAvailable: true,
        dubAvailable: dubSet.has(num),
        provider: 'hianime',
        showId,
      });
    }

    return episodes;
  }

  function streamTypeForUrl(url, declaredType) {
    const type = String(declaredType || '').toLowerCase();
    const value = String(url || '').toLowerCase();
    if (type.indexOf('hls') >= 0 || type.indexOf('mpegurl') >= 0 || /\.m3u8(?:[?#]|$)/i.test(value)) {
      return 'hls';
    }
    return 'mp4';
  }

  async function resolveHiAnimeStream(showId, episodeId, lang = 'sub') {
    const deadline = Date.now() + 24000;
    const collected = [];
    const seenStreams = new Set();
    const serversUrl =
      HIANIME_BASE +
      '/ajax/v2/episode/servers?episodeId=' +
      encodeURIComponent(episodeId) +
      '&mov_id=' +
      encodeURIComponent(showId);

    const serversRes = await settleWithin(
      request(serversUrl, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Referer: HIANIME_BASE + '/watch/' + showId,
        },
      }),
      STREAM_TIMEOUT_MS,
      null
    );

    const sData = serversRes && serversRes.json;
    if (!sData) return null;

    const html = Array.isArray(sData.html) ? sData.html.join('') : String(sData.html || '');
    const serverEntries = [];
    const re = /<[^>]+data-id\s*=\s*["'][^"']+["'][^>]*>/gi;
    let sm;
    while ((sm = re.exec(html)) !== null) {
      const attr = key => (sm[0].match(new RegExp(key + '\\s*=\\s*["\u0027]([^"\u0027]*)["\u0027]', 'i')) || [])[1];
      const id = attr('data-id'), type = String(attr('data-type') || '').toLowerCase();
      if (id && /^(sub|dub)$/.test(type) && !serverEntries.some(s => s.id === id)) {
        serverEntries.push({ id, serverId: attr('data-server-id') || id, type });
      }
    }

    const preferred = serverEntries.filter((s) => s.type === lang);
    const candidateList = preferred;

    for (const s of candidateList) {
      if (Date.now() >= deadline) break;
      const sourceUrl = HIANIME_BASE + '/ajax/v2/episode/sources?id=' + encodeURIComponent(s.id);
      const sourceRes = await settleWithin(
        request(sourceUrl, {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Referer: HIANIME_BASE + '/watch/' + showId,
          },
        }),
        STREAM_TIMEOUT_MS,
        null
      );

      const srcData = sourceRes && sourceRes.json;
      if (!srcData || !srcData.link) continue;

      const link = String(srcData.link);
      const ev = link.match(/^https?:\/\/(play\.echovideo\.ru|.*echovideo.*)\/(embed-[^/]+)\/([^?#]+)/i);
      const host = ev ? 'https://play.echovideo.ru' : (link.match(/^(https?:\/\/[^/]+)/) || [])[1] || '';
      const path = ev ? '/' + ev[2] : (link.match(/^(https?:\/\/[^/]+)(\/[^?#]*)/) || [])[2] || '';
      const token = ev ? ev[3] : (link.match(/\/([^/?#]+)$/) || [])[1] || '';

      if (!host || !token) continue;

      const getUrl = host + (path ? path + '/' : '/') + 'getSources?id=' + encodeURIComponent(token);
      const getRes = await settleWithin(
        request(getUrl, {
          headers: {
            Referer: link,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
          },
        }),
        STREAM_TIMEOUT_MS,
        null
      );

      const gd = getRes && getRes.json;
      if (!gd || !gd.sources) continue;

      const streamList = [];
      const rawSources = gd.sources;
      const headers = {
        Referer: host + '/',
        Origin: host,
        'User-Agent': USER_AGENT,
      };

      if (typeof rawSources === 'string' && rawSources.startsWith('http')) {
        const kind = streamTypeForUrl(rawSources, '');
        streamList.push({
          label: kind === 'hls' ? 'Auto (HLS)' : 'Auto (MP4)',
          url: rawSources,
          quality: 'auto',
          height: null,
          streamType: kind,
          kind,
          headers,
        });
      } else if (typeof rawSources === 'object') {
        const order = [
          { key: 'HQ', label: '1080p', height: 1080 },
          { key: 'HD', label: '720p', height: 720 },
          { key: 'SD', label: '480p', height: 480 },
        ];
        for (const q of order) {
          const list = rawSources[q.key];
          if (!list) continue;
          const arr = Array.isArray(list) ? list : [list];
          for (const u of arr) {
            if (typeof u === 'string' && u.startsWith('http')) {
              const kind = streamTypeForUrl(u, '');
              streamList.push({
                label: q.label,
                url: u,
                quality: q.key.toLowerCase(),
                height: q.height,
                streamType: kind,
                kind,
                headers,
              });
            }
          }
        }
      }

      const subtitles = readCaptions(gd, link);

      if (streamList.length) {
        for (const stream of streamList) {
          if (seenStreams.has(stream.url)) continue;
          seenStreams.add(stream.url);
          collected.push(Object.assign({}, stream, {server: 'Server ' + s.serverId,
            subtitles, intro: readMarker(gd.intro), outro: readMarker(gd.outro)}));
        }
      }
    }

    return collected.length ? { streams: collected, headers: collected[0].headers,
      subtitles: collected[0].subtitles } : null;
  }

  function readMarker(range) {
    return range && typeof range.start === 'number' && typeof range.end === 'number' &&
      isFinite(range.start) && isFinite(range.end) && range.start >= 0 && range.end > range.start
      ? {start: range.start, end: range.end} : null;
  }

  function readCaptions(data, embedUrl) {
    const tracks = [], seen = new Set();
    const languages = {english:'en',arabic:'ar',spanish:'es',french:'fr',german:'de',italian:'it',portuguese:'pt',japanese:'ja'};
    function add(file, label, language, headers) {
      if (!/^https?:\/\//i.test(String(file || '')) || seen.has(file)) return;
      seen.add(file);
      const name = String(label || language || 'Subtitles');
      const code = language || languages[name.toLowerCase()] || 'und';
      tracks.push({url:file,file,label:name,language:code,lang:code,kind:'captions',
        format:/\.srt(?:[?#]|$)/i.test(file)?'srt':'vtt',headers:Object.assign({'User-Agent':USER_AGENT},headers || {})});
    }
    const params = {};
    String(embedUrl || '').split('?').slice(1).join('?').split('#')[0].split('&').forEach(part => {
      const at = part.indexOf('='); if (at < 0) return;
      try { params[decodeURIComponent(part.slice(0,at))] = decodeURIComponent(part.slice(at+1)); } catch (_) {}
    });
    Object.keys(params).forEach(key => {
      const caption = key.match(/^caption_(\d+)$/), file = key.match(/^c(\d+)_file$/);
      if (caption) add(params[key],params['sub_'+caption[1]]);
      else if (file) add(params[key],params['c'+file[1]+'_label']);
      else if (key === 'sub') add(params[key],'English','en');
    });
    [].concat(Array.isArray(data.tracks)?data.tracks:[],Array.isArray(data.subtitles)?data.subtitles:[]).forEach(t => {
      if (!t || (t.kind && !/^(captions|subtitles)$/i.test(t.kind))) return;
      add(t.file || t.url,t.label,t.lang || t.language,t.headers);
    });
    return tracks;
  }

  /* ────────────────────────── Extract Episodes ────────────────────────── */

  async function extractEpisodes(urlOrId) {
    const parsed = parseIdFromHref(urlOrId);
    if (!parsed.id) throw new Error('Miruro episodes missing id');
    const cacheKey = parsed.rawId;
    if (episodesCache[cacheKey]) return episodesCache[cacheKey];

    const details = await extractDetails(urlOrId);
    const showTitle = details.title || `Anime ${parsed.rawId}`;
    const altTitle = details.aliases || '';

    const activeHi = await searchHiAnimeShow(showTitle, altTitle, details.synonyms || []);
    let providerEpisodes = [];

    if (activeHi && activeHi.id) {
      providerEpisodes = await fetchHiAnimeEpisodes(activeHi.id, activeHi.slug);
    }

    const episodeMap = Object.create(null);
    for (const pEp of providerEpisodes) {
      episodeMap[pEp.number] = pEp;
    }

    let episodeNums = Object.keys(episodeMap).map(Number).sort((a, b) => a - b);
    if (!episodeNums.length) {
      const fallbackCount = Math.max(Number(details.episodes) || 1, 1);
      episodeNums = Array.from({ length: fallbackCount }, (_, i) => i + 1);
    }

    const results = [];
    for (const num of episodeNums) {
      const pEp = episodeMap[num];
      const epData = {
        anilistId: parsed.rawId,
        number: num,
        hiShowId: activeHi ? activeHi.id : '',
        hiEpId: pEp ? pEp.id : String(num),
        title: pEp ? pEp.title : `Episode ${num}`,
        subAvailable: true,
        dubAvailable: pEp ? pEp.dubAvailable : true,
      };

      const href = `miruro|${parsed.rawId}|${num}|${encodeURIComponent(JSON.stringify(epData))}`;
      results.push({
        number: num,
        title: epData.title,
        image: details.image,
        description: `Episode ${num} of ${showTitle}`,
        subAvailable: epData.subAvailable,
        dubAvailable: epData.dubAvailable,
        href,
      });
    }

    episodesCache[cacheKey] = results;
    return results;
  }

  /* ────────────────────────── Stream URL Extraction ────────────────────────── */

  async function extractStreamUrl(episodeHref, lang = 'sub') {
    const parts = String(episodeHref || '').split('|');
    if (parts.length < 3 || parts[0] !== 'miruro') {
      throw new Error('Miruro episode href is invalid');
    }

    const rawId = parts[1] || '0';
    const episodeNumber = Number(parts[2] || 1);
    const requestedLang = String(lang || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub';

    const cacheKey = `${rawId}:${episodeNumber}:${requestedLang}`;
    if (streamCache[cacheKey]) return streamCache[cacheKey];

    let epData = null;
    if (parts[3]) {
      try {
        epData = JSON.parse(decodeURIComponent(parts[3]));
      } catch (_) {}
    }

    let showId = epData && epData.hiShowId;
    let epId = epData && epData.hiEpId;

    if (!showId || !epId) {
      const details = await extractDetails(rawId);
      const hi = showId ? { id: showId, slug: '' } : await searchHiAnimeShow(details.title, details.aliases, details.synonyms || []);
      if (hi) {
        showId = hi.id;
        const eps = await fetchHiAnimeEpisodes(hi.id, hi.slug || '');
        const target = eps.find((e) => e.number === episodeNumber);
        epId = target ? target.id : null;
      }
    }

    if (!showId || !epId) {
      throw new Error(`Miruro could not locate anime streams for ID ${rawId}`);
    }

    // Try primary HiAnime stream resolution
    let resolved = await resolveHiAnimeStream(showId, epId || String(episodeNumber), requestedLang);

    if (!resolved || !resolved.streams || !resolved.streams.length) {
      throw new Error(`Miruro stream unavailable for episode ${episodeNumber}`);
    }

    const streams = resolved.streams
      .filter((s) => s && s.url && s.server === resolved.streams[0].server)
      .map((s) => {
        const kind = streamTypeForUrl(s.url, s.streamType || s.kind);
        return {
          label: s.label || (kind === 'hls' ? 'Auto (HLS)' : 'Auto (MP4)'),
          url: s.url,
          file: s.url,
          quality: s.quality,
          height: s.height,
          streamType: kind,
          kind,
          headers: s.headers || resolved.headers,
        };
      });
    if (!streams.length) throw new Error(`Miruro stream candidates were empty for episode ${episodeNumber}`);

    const result = {
      streams,
      servers: resolved.streams.map(s => ({name:s.server + ' - ' + s.label,url:s.url,headers:s.headers,
        streamType:s.streamType,subtitles:s.subtitles,intro:s.intro,outro:s.outro})),
      url: streams[0].url,
      headers: streams[0].headers || resolved.headers || {
        Referer: HIANIME_BASE + '/',
        Origin: HIANIME_BASE,
        'User-Agent': USER_AGENT,
      },
      subtitles: Array.isArray(resolved.subtitles) ? resolved.subtitles : [],
      streamType: streams[0].streamType || 'hls',
      quality: streams[0].quality || streams[0].height || 'auto',
      intro: resolved.streams[0].intro,
      outro: resolved.streams[0].outro,
    };

    streamCache[cacheKey] = result;
    return result;
  }

  /* ────────────────────────── Discovery Feeds ────────────────────────── */

  async function discoveryHome() {
    const [trending, popular, topRated] = await Promise.all([
      searchResults('', 0),
      searchResults('', 1),
      searchResults('', 2),
    ]);

    const sections = [];
    if (trending.length) {
      sections.push({
        id: 'trending',
        title: 'Trending Anime',
        style: 'hero',
        items: trending.slice(0, 8),
        viewAll: { mode: 'feed', feedId: 'trending' },
      });
    }
    if (popular.length) {
      sections.push({
        id: 'popular',
        title: 'Popular Anime',
        style: 'poster',
        items: popular.slice(0, 24),
        viewAll: { mode: 'feed', feedId: 'popular' },
      });
    }
    if (topRated.length) {
      sections.push({
        id: 'top_rated',
        title: 'Top Rated Anime',
        style: 'poster',
        items: topRated.slice(0, 24),
        viewAll: { mode: 'feed', feedId: 'top_rated' },
      });
    }

    return { sections };
  }

  async function discoveryFeed(feedId, page) {
    const pageNum = Math.max(1, Number(page) || 1);
    const items = await searchResults('', pageNum - 1);
    return {
      items,
      page: pageNum,
      hasMore: items.length > 0 && pageNum < 10,
    };
  }

  /* ────────────────────────── Global Module Exports ────────────────────────── */

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
