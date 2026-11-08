(() => {
  'use strict';

  const MODULE_NAME = 'AnimeAV1';
  const SITE = 'https://animeav1.com';
  const PLAYER_HOST = 'https://player.zilla-networks.com';
  const ANILIST_API = 'https://graphql.anilist.co';
  const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  const anilistCache = Object.create(null);
  const anilistIdCache = Object.create(null);
  function normalizeTitle(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  const seriesLangCache = Object.create(null);

  const TITLE_ALIASES = {
    'attack on titan': 'Shingeki no Kyojin',
    'parasyte the maxim': 'Kiseijuu: Sei no Kakuritsu',
    'parasyte': 'Kiseijuu: Sei no Kakuritsu',
    'demon slayer kimetsu no yaiba the movie mugen train': 'Kimetsu no Yaiba Movie: Mugen Ressha-hen',
    'legend of the galactic heroes': 'Ginga Eiyuu Densetsu',
    'tomorrow s joe 2': 'Ashita no Joe 2',
    'tomorrows joe 2': 'Ashita no Joe 2',
    'gto great teacher onizuka': 'Great Teacher Onizuka',
    'gto': 'Great Teacher Onizuka',
    'demon slayer kimetsu no yaiba mugen train arc': 'Mugen Ressha-hen',
    'the disastrous life of saiki k': 'Saiki Kusuo',
    'saiki kusuo no nan': 'Saiki Kusuo',
    'jojo s bizarre adventure diamond is unbreakable': 'JoJo no Kimyou na Bouken: Diamond wa Kudakenai',
    'jojos bizarre adventure diamond is unbreakable': 'JoJo no Kimyou na Bouken: Diamond wa Kudakenai',
    'a silent voice': 'Koe no Katachi',
    'the ghost in the shell': 'Koukaku Kidoutai',
    'ghost in the shell': 'Koukaku Kidoutai',
    'from overshadowed to overpowered second reincarnation of a talentless sage': 'Rakudai Kenja no Gakuin Musou: Nidome no Tensei, S-Rank Cheat Majutsushi Bouken roku',
    'k on season 2': 'K-On!!',
    'k on 2': 'K-On!!',
    'wotakoi love is hard for otaku': 'Wotaku ni Koi wa Muzukashii',
    'kaguya sama love is war': 'Kaguya-sama wa Kokurasetai: Tensai-tachi no Renai Zunousen',
    'jojo s bizarre adventure golden wind': 'JoJo no Kimyou na Bouken: Ougon no Kaze',
    'jojos bizarre adventure golden wind': 'JoJo no Kimyou na Bouken: Ougon no Kaze',
    'gintama season 2 part 2': 'Gintama: Enchousen',
    'gintama season 3': 'Gintama.',
    'chainsmoker cat': 'Yani Neko',
    'jaadugar a witch in mongolia': 'Tenmaku no Jaadugar',
    'iron wok jan': 'Tetsunabe no Jan'
  };

  function log(message) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(message || ''));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(fallback), waitMs);
      Promise.resolve(promise).then((value) => {
        if (typeof clearTimeout === 'function') clearTimeout(timer);
        resolve(value);
      }, (error) => {
        if (typeof clearTimeout === 'function') clearTimeout(timer);
        reject(error);
      });
    });
  }

  function normalize(value) {
    return String(value || '')
      .replace(/\[(?:[^\]]*\b(?:sub|dub|ita|eng|english|spanish|latino|castellano|french|german|arabic|hindi)\b[^\]]*)\]/gi, ' ')
      .normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
  }

  function cleanTitle(title, slug) {
    if (slug === 'kimetsu-no-yaiba-mugen-ressha-hen') {
      return 'Kimetsu no Yaiba: Mugen Ressha-hen (TV)';
    }
    return String(title || '')
      .replace(/\s*\((?:Una Voz Silenciosa|Castellano|Latino|VOSE|Audio Latino|Especial|Movie|TV)\)/gi, '')
      .replace(/\bKimetsu no Yaiba Movie:\s*/gi, 'Kimetsu no Yaiba: ')
      .replace(/\bGreat Teacher Onizuka\b/gi, 'GTO: Great Teacher Onizuka')
      .replace(/\bPart\s*(\d+)\s*:\s*/gi, '')
      .replace(/\bK-On!!\s*2\b/gi, 'K-On!!')
      .replace(/\bRakudai Kenja no Gakuin Musou: Nidome no Tensei, S-Rank Cheat Majutsushi Boukenroku\b/gi, 'Rakudai Kenja no Gakuin Musou: Nidome no Tensei, S-Rank Cheat Majutsushi Bouken roku')
      .replace(/\bTensai-tachi\b/gi, 'Tensaitachi')
      .replace(/\bKoukaku Kidoutai\b/gi, 'The Ghost in the Shell')
      .trim();
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function unescapeBlobString(value) {
    return String(value || '')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
  }

  function toAbsoluteUrl(value, base) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return /^https?:\/\//i.test(raw) ? raw : '';
    if (raw.startsWith('//')) return 'https:' + raw;
    // URL is not present in every Flutter JS runtime.
    const parts = String(base || SITE + '/').match(/^(https?:\/\/[^/?#]+)([^?#]*)/i);
    if (!parts) return '';
    if (raw.charAt(0) === '?') return parts[1] + (parts[2] || '/') + raw;
    const path = raw.charAt(0) === '/' ? raw : (parts[2] || '/').replace(/[^/]*$/, '') + raw;
    const suffix = path.search(/[?#]/);
    const tail = suffix < 0 ? '' : path.slice(suffix);
    const segments = (suffix < 0 ? path : path.slice(0, suffix)).split('/');
    const normalized = [];
    for (const segment of segments) {
      if (segment === '..') normalized.pop();
      else if (segment && segment !== '.') normalized.push(segment);
    }
    return parts[1] + '/' + normalized.join('/') + tail;
  }

  async function responseText(res) {
    if (!res) return '';
    if (res.json && typeof res.json !== 'function') return JSON.stringify(res.json);
    if (typeof res.body === 'string') return res.body;
    if (typeof res.text === 'function') return await res.text();
    if (typeof res.text === 'string') return res.text;
    if (typeof res.json === 'function') return JSON.stringify(await res.json());
    return '';
  }

  const seriesPageCache = Object.create(null);
  const seriesPageInflight = Object.create(null);
  function cacheSeriesPage(url, value) {
    const now = Date.now();
    Object.keys(seriesPageCache).forEach(function (key) {
      if (seriesPageCache[key].until <= now) delete seriesPageCache[key];
    });
    const keys = Object.keys(seriesPageCache);
    if (!seriesPageCache[url] && keys.length >= 12) {
      keys.sort(function (a, b) { return seriesPageCache[a].until - seriesPageCache[b].until; });
      delete seriesPageCache[keys[0]];
    }
    seriesPageCache[url] = { until: now + 30000, value: value };
  }
  async function requestText(url, extraHeaders, timeoutMs, deadline) {
    const expires = Math.min(deadline || Infinity, Date.now() + (timeoutMs || 15000));
    const targetHost = hostOf(url);
    if (hostParked(targetHost)) throw new Error('Host cooldown');
    const cacheable = String(url).startsWith(SITE + '/media/') &&
      /^\/media\/[^/?#]+\/?$/.test(String(url).slice(SITE.length));
    const cached = cacheable && seriesPageCache[url];
    if (cached && cached.until > Date.now()) return cached.value;
    if (cacheable && seriesPageInflight[url]) return seriesPageInflight[url];
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json,*/*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
      extraHeaders || {},
    );
    const doFetch = async () => {
      let res = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (Date.now() >= expires) break;
        try {
          if (typeof fetchv2 === 'function') {
            res = await fetchv2(url, headers, 'GET', null);
          } else if (typeof fetch === 'function') {
            res = await fetch(url, { headers });
          }
          if (res) break;
        } catch (e) {
          lastErr = e;
          if (attempt === 0) await sleep(250);
        }
      }
      const status = Number((res && res.status) || 0);
      if (status === 429 || status === 403) {
        parkHost(targetHost, retryAfterMs(headerMap(res && res.headers)) || COOLDOWN_MS, 'HTTP ' + status);
      }
      if (!res || (status && status >= 400)) {
        throw new Error('Request failed ' + (status || 'timeout'));
      }
      const text = await responseText(res);
      return { status, text };
    };
    if (Date.now() >= expires) return { status: 0, text: '' };
    const pending = settleWithin(doFetch(), Math.min(timeoutMs || 15000, expires - Date.now()), { status: 0, text: '' });
    if (cacheable) seriesPageInflight[url] = pending;
    try {
      const result = await pending;
      if (cacheable && result.status >= 200 && result.status < 300 && result.text && !looksBlockedPage(result.text)) {
        cacheSeriesPage(url, result);
      }
      return result;
    } finally {
      if (cacheable && seriesPageInflight[url] === pending) delete seriesPageInflight[url];
    }
  }

  function looksBlockedPage(html) {
    return /just a moment|attention required|parked domain|domain is for sale|access denied/i.test(
      String(html || ''),
    );
  }

  function headerMap(headers) {
    const out = {};
    if (!headers) return out;
    if (typeof headers.forEach === 'function') {
      headers.forEach(function (value, key) {
        out[String(key).toLowerCase()] = value;
      });
      return out;
    }
    const keys = Object.keys(headers);
    for (let i = 0; i < keys.length; i += 1) {
      out[String(keys[i]).toLowerCase()] = headers[keys[i]];
    }
    return out;
  }

  /* -------------------- rate-limit hygiene (Synthetiq Anime Direct contract) -------------------- */
  const COOLDOWN_MS = 10 * 60 * 1000;
  const cooldownUntil = Object.create(null);
  function hostOf(url) {
    const m = String(url || '').match(/^https?:\/\/([^\/:?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
  function hostParked(host) {
    if (!host) return false;
    const until = cooldownUntil[host] || 0;
    if (until && Date.now() < until) return true;
    if (until) delete cooldownUntil[host];
    return false;
  }
  function parkHost(host, ms, why) {
    if (!host) return;
    const until = Date.now() + Math.max(Number(ms) || 0, 60000);
    cooldownUntil[host] = until;
    log('cooldown ' + host + ' for ' + Math.round((until - Date.now()) / 1000) + 's (' + why + ')');
  }
  function retryAfterMs(headers) {
    try {
      const raw = readHeader(headers, 'retry-after');
      const n = Number(String(raw).trim());
      if (isFinite(n) && n > 0) return n * 1000;
      const when = Date.parse(String(raw));
      if (isFinite(when) && when > Date.now()) return when - Date.now();
    } catch (_) {}
    return 0;
  }

  async function requestRaw(url, extraHeaders, options) {
    const cfg = options || {};
    const expires = Math.min(cfg.deadline || Infinity, Date.now() + (cfg.timeoutMs || 8000));
    const failed = { status: 0, text: '', headers: {}, finalUrl: '', ok: false, note: '' };
    if (Date.now() >= expires || !isStandardPort(url)) return failed;
    const targetHost = hostOf(url);
    if (hostParked(targetHost)) {
      // The host asked us to back off (429/403 + Retry-After): do not spend the
      // request budget hammering it. Callers treat this as an unavailable route.
      failed.note = 'host parked';
      return failed;
    }
    const headers = Object.assign(
      { 'User-Agent': USER_AGENT, Accept: '*/*' },
      extraHeaders || {},
    );
    const fetchOpts = {};
    if (cfg.followRedirects === false) fetchOpts.followRedirects = false;
    const doFetch = async () => {
      let res = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (Date.now() >= expires) break;
        try {
          if (typeof fetchv2 === 'function') {
            res = await fetchv2(url, headers, cfg.method || 'GET', null, fetchOpts);
          } else if (typeof fetch === 'function') {
            res = await fetch(url, {
              method: cfg.method || 'GET',
              headers: headers,
              redirect: cfg.followRedirects === false ? 'manual' : 'follow',
            });
          }
          if (res) break;
        } catch (_) {
          if (attempt === 0) await sleep(250);
        }
      }
      const status = Number((res && res.status) || 0);
      let text = '';
      try { text = await responseText(res); } catch (_) {}
      const hdrs = headerMap(res && res.headers);
      if (status === 429 || status === 403) {
        parkHost(targetHost, retryAfterMs(hdrs) || COOLDOWN_MS, 'HTTP ' + status);
      }
      return {
        status: status,
        text: text || '',
        headers: hdrs,
        finalUrl: (res && (res.finalUrl || res.url)) || '',
        ok: status >= 200 && status < 300,
      };
    };
    return settleWithin(doFetch(), Math.min(cfg.timeoutMs || 8000, expires - Date.now()), failed);
  }

  function looksHtmlBody(text) {
    const sample = String(text || '').slice(0, 80);
    return /^\s*(<!doctype html|<html[\s>])/i.test(sample);
  }

  function looksMediaSample(text, headers) {
    const sample = String(text || '');
    if (!sample || looksHtmlBody(sample)) return false;
    if (/^(ftyp|styp|moov|moof|mdat|sidx|free)$/.test(sample.slice(4, 8))) return true;
    // A TS sync byte at offset 0 is positive media evidence in itself; hosts serve TS
    // under mislabelled types often enough that content-type must not be required.
    if (sample.charCodeAt(0) === 0x47) return true;
    // PNG-wrapped TS: PNG signature with a real TS sync inside the wrapper (seen in the wild).
    if (sample.charCodeAt(0) === 0x89 && sample.slice(1, 4) === 'PNG') {
      for (let i = 4; i < Math.min(sample.length - 1, 4096); i += 1) {
        if (sample.charCodeAt(i) === 0x47 && sample.charCodeAt(i + 1) === 0x40) return true;
      }
    }
    return false;
  }

  function readHeader(headers, name) {
    if (!headers) return '';
    const key = String(name || '').toLowerCase();
    if (typeof headers.get === 'function') {
      return String(headers.get(name) || headers.get(key) || '');
    }
    return String(headerMap(headers)[key] || '');
  }

  function urlPort(url) {
    const parsed = String(url || '').match(/^(https?):\/\/([a-z0-9.-]+)(?::(\d+))?(?:[/?#]|$)/i);
    if (parsed) return parsed[3] ? Number(parsed[3]) : (parsed[1].toLowerCase() === 'https' ? 443 : 80);
    return 0;
  }

  function isStandardPort(url) {
    const port = urlPort(url);
    return port === 443 || port === 80;
  }

  /* ------------------------------ AniList Artwork ------------------------------ */

  async function fetchAniListArtwork(title) {
    const cleanT = String(title || '').trim();
    if (!cleanT) return null;
    if (anilistCache[cleanT]) return anilistCache[cleanT];

    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          id
          title { romaji english native }
          coverImage { extraLarge large medium }
          bannerImage
          averageScore
          status
          genres
        }
      }
    `;

    if (hostParked('graphql.anilist.co')) return null;
    try {
      let res;
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      const body = JSON.stringify({ query, variables: { search: cleanT } });

      if (typeof fetchv2 === 'function') {
        res = await settleWithin(fetchv2(ANILIST_API, headers, 'POST', body), 9000, null);
      } else if (typeof fetch === 'function') {
        res = await settleWithin(fetch(ANILIST_API, { method: 'POST', headers, body }), 9000, null);
      }

      if (res) {
        const st = Number(res.status || 0);
        if (st === 429 || st === 403) parkHost('graphql.anilist.co', retryAfterMs(res.headers) || 60000, 'HTTP ' + st);
        let json = null;
        if (typeof res.json === 'function') {
          json = await res.json();
        } else if (res.body) {
          json = JSON.parse(res.body);
        }
        const media = json && json.data && json.data.Media;
        if (media) {
          const artwork = {
            image: (media.coverImage && (media.coverImage.extraLarge || media.coverImage.large || media.coverImage.medium)) || '',
            bannerImage: media.bannerImage || '',
            rating: media.averageScore ? String(media.averageScore) : '85',
            status: media.status || 'FINISHED',
            genres: media.genres || ['Anime', 'Spanish'],
            anilistId: media.id ? String(media.id) : '',
            malId: media.idMal ? String(media.idMal) : '',
          };
          anilistCache[cleanT] = artwork;
          if (artwork.anilistId) anilistIdCache[normalizeTitle(cleanT)] = artwork.anilistId;
          return artwork;
        }
      }
    } catch (_) {}

    return null;
  }

  /* ------------------------------ Catalogue & Search ------------------------------ */

  function slugFromMediaUrl(url) {
    const match = String(url || '').match(/\/media\/([^/?#]+)/i);
    return match ? match[1] : '';
  }

  function titleFromSlug(slug) {
    return String(slug || '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function parseCards(html) {
    const out = [];
    const seen = Object.create(null);
    const blocks = String(html || '').split('<article');
    for (let i = 1; i < blocks.length; i += 1) {
      const block = blocks[i];
      const hrefMatch = block.match(/href="\/media\/([^"/?#]+)"/i);
      if (!hrefMatch) continue;
      const slug = hrefMatch[1];
      const href = SITE + '/media/' + slug;
      if (seen[href]) continue;
      const imgMatch = block.match(
        /src="(https:\/\/cdn\.animeav1\.com\/covers\/[^"]+)"/i,
      );
      const h3Match = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const altMatch = block.match(/alt="Portada de ([^"]*)"/i);
      let title = h3Match ? cleanText(h3Match[1]) : '';
      if (!title && altMatch) title = cleanText(altMatch[1]);
      if (!title) title = titleFromSlug(slug);
      if (!title) continue;
      seen[href] = true;
      const nativeImage = imgMatch ? imgMatch[1] : '';
      out.push({
        id: href,
        href,
        title: cleanTitle(title, slug),
        rawTitle: title,
        slug,
        image: nativeImage,
        poster: nativeImage,
        bannerImage: nativeImage,
        type: 'video',
      });
    }
    return out;
  }

  async function fetchCataloguePage(params, referer) {
    const query = params ? '?' + params : '';
    const res = await requestText(SITE + '/catalogo' + query, { Referer: referer || SITE + '/' }, 15000);
    if (looksBlockedPage(res.text)) {
      log('catalogue page blocked');
      return { cards: [], totalPages: 0 };
    }
    let totalPages = 0;
    const pageMatch = String(res.text).match(/totalPages:(\d+)/);
    if (pageMatch) totalPages = Number(pageMatch[1]);
    return { cards: parseCards(res.text), totalPages };
  }

  async function searchResults(query) {
    const rawQuery = String(query == null ? '' : query).trim();
    if (!rawQuery) {
      const initial = await fetchCataloguePage('');
      return initial.cards;
    }

    const norm = normalize(rawQuery);
    const alias = TITLE_ALIASES[norm];

    const searchCandidates = [];
    if (alias) searchCandidates.push(alias);
    searchCandidates.push(rawQuery);

    const simple = rawQuery.split(/[:\-–—]/)[0].trim();
    if (simple && simple !== rawQuery && !searchCandidates.includes(simple)) {
      searchCandidates.push(simple);
    }

    let cards = [];
    for (const term of searchCandidates) {
      const res = await fetchCataloguePage('search=' + encodeURIComponent(term));
      if (res.cards && res.cards.length) {
        cards = res.cards;
        break;
      }
    }

    if (!cards.length) return [];

    // Special ranking for Saiki Kusuo to guarantee Season 1 root
    if (norm.includes('saiki')) {
      cards.sort((a, b) => {
        const aRoot = a.slug === 'saiki-kusuo-no-ps-nan' ? 1 : 0;
        const bRoot = b.slug === 'saiki-kusuo-no-ps-nan' ? 1 : 0;
        return bRoot - aRoot;
      });
    }

    const isMovieSearch = /movie|pelicula|ova/i.test(norm) || /movie|pelicula|ova/i.test(alias || '');

    cards.sort((a, b) => {
      const aNorm = normalize(a.title);
      const bNorm = normalize(b.title);
      const targetNorm = alias ? normalize(alias) : norm;
      const aExact = aNorm === targetNorm || aNorm === norm ? 1 : 0;
      const bExact = bNorm === targetNorm || bNorm === norm ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      if (!isMovieSearch) {
        const aOva = /ova|movie|pelicula/i.test(a.rawTitle) ? 1 : 0;
        const bOva = /ova|movie|pelicula/i.test(b.rawTitle) ? 1 : 0;
        return aOva - bOva;
      }
      return 0;
    });

    return cards;
  }

  /* ------------------------------ Discovery (V4) ------------------------------ */

  const DISCOVERY_FEEDS = [
    { id: 'trending', title: 'Tendencias Anime (Español)', order: '', hero: true },
    { id: 'popular', title: 'Top 10 Populares', order: 'popular', top10: true },
    { id: 'score', title: 'Mejor Valorados', order: 'score' },
    { id: 'latest', title: 'Últimas Novedades', order: 'latest' },
  ];

  function discoveryFeedById(feedId) {
    const id = String(feedId || '').trim().toLowerCase();
    return DISCOVERY_FEEDS.find((feed) => feed.id === id) || null;
  }

  async function fetchFeedCards(feed, page) {
    const params = [];
    if (feed.order) params.push('order=' + feed.order);
    if (page > 1) params.push('page=' + page);
    return fetchCataloguePage(params.join('&'));
  }

  async function discoveryHome() {
    const settled = [];
    for (const feed of DISCOVERY_FEEDS) settled.push(await fetchFeedCards(feed, 1));
    const sections = [];
    for (let i = 0; i < DISCOVERY_FEEDS.length; i += 1) {
      const feed = DISCOVERY_FEEDS[i];
      const cards = settled[i].cards;
      if (!cards.length) continue;
      const limit = feed.hero ? 8 : feed.top10 ? 10 : 20;
      const items = cards.slice(0, limit);

      sections.push({
        id: feed.id,
        title: feed.title,
        style: feed.hero ? 'hero' : feed.top10 ? 'top10' : 'poster',
        items,
        viewAll: { mode: 'feed', feedId: feed.id },
      });
    }
    return { sections };
  }

  async function discoveryFeed(feedId, page) {
    const feed = discoveryFeedById(feedId);
    const currentPage = Math.max(1, Number(page) || 1);
    if (!feed) return { items: [], page: currentPage, hasMore: false };
    const result = await fetchFeedCards(feed, currentPage);
    const items = result.cards;

    const hasMore = result.totalPages > 0
      ? currentPage < result.totalPages
      : items.length > 0;
    return { items, page: currentPage, hasMore };
  }

  /* ------------------------------ Details ------------------------------ */

  async function extractDetails(urlOrId) {
    const url = toAbsoluteUrl(urlOrId);
    const res = await requestText(url, { Referer: SITE + '/' }, 15000);
    if (looksBlockedPage(res.text)) throw new Error('AnimeAV1 page is blocked.');
    const html = res.text;
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = cleanText(
      (titleMatch && titleMatch[1]) || titleFromSlug(slugFromMediaUrl(url)),
    );
    let description = '';
    const blobMatch = html.match(/synopsis:"((?:[^"\\]|\\.)*)"/);
    if (blobMatch) description = unescapeBlobString(blobMatch[1]).trim();
    if (!description) {
      const og = html.match(/property="og:description" content="([^"]+)"/i);
      description = cleanText((og && og[1]) || '');
    }
    const imgMatch = html.match(
      /src="(https:\/\/cdn\.animeav1\.com\/covers\/[^"]+)"[^>]*alt="[^"]*Poster"/i,
    ) || html.match(/src="(https:\/\/cdn\.animeav1\.com\/covers\/[^"]+)"/i);
    const nativeImage = (imgMatch && imgMatch[1]) || '';

    const art = await fetchAniListArtwork(title);
    const image = (art && art.image) || nativeImage;
    const bannerImage = (art && art.bannerImage) || nativeImage;

    return {
      title,
      description: description || `Anime en español en AnimeAV1: ${title}.`,
      image,
      poster: image,
      bannerImage,
      url,
      status: (art && art.status) || 'FINISHED',
      genres: (art && art.genres) || ['Anime', 'Español', 'VOSE', 'DUB'],
      rating: (art && art.rating) || '85',
      aliases: '',
    };
  }

  /* ------------------------------ Episodes & Language Detection ------------------------------ */

  function parseEmbeds(html) {
    const raw = String(html || '');
    const bodyMatch =
      raw.match(/embeds:\{([\s\S]*?)\}(?:,\s*downloads:|\s*\},uses:)/) ||
      raw.match(/embeds:\s*\{([\s\S]*?)\}(?=\s*,\s*[a-zA-Z0-9_]+:|\s*\}\s*<\/script>)/);
    if (!bodyMatch) return {};
    const body = bodyMatch[1];
    const variants = {};
    const sectionRe = /([A-Z]{2,8}):\[([\s\S]*?)\](?=,\s*[A-Z]{2,8}:\[|$)/g;
    let section;
    while ((section = sectionRe.exec(body))) {
      const variant = section[1];
      const servers = [];
      const itemRe = /\{server:["']([^"']+)["'],url:["']([^"']+)["']\}/g;
      let item;
      while ((item = itemRe.exec(section[2]))) {
        servers.push({
          server: item[1],
          url: item[2].replace(/\\u0026/g, '&').replace(/\\\//g, '/'),
        });
      }
      if (servers.length) variants[variant] = servers;
    }
    return variants;
  }

  async function detectSeriesLanguages(slug, sampleNumber) {
    if (seriesLangCache[slug]) return seriesLangCache[slug];

    try {
      const epNum = sampleNumber != null ? sampleNumber : 1;
      const epUrl = `${SITE}/media/${slug}/${epNum}`;
      const epRes = await requestText(epUrl, { Referer: `${SITE}/media/${slug}` }, 10000);
      if (epRes && epRes.text) {
        const embeds = parseEmbeds(epRes.text);
        const hasSub = Boolean(embeds.SUB && embeds.SUB.length > 0);
        const hasDub = Boolean(embeds.DUB && embeds.DUB.length > 0);

        if (hasSub || hasDub) {
          const res = { subAvailable: hasSub, dubAvailable: hasDub };
          seriesLangCache[slug] = res;
          return res;
        }
      }
    } catch (_) {}

    return {};
  }

  async function extractEpisodes(seriesId) {
    const url = toAbsoluteUrl(seriesId);
    const slug = slugFromMediaUrl(url);
    if (!slug) return [];
    const res = await requestText(url, { Referer: SITE + '/' }, 15000);
    if (looksBlockedPage(res.text)) return [];

    const listMatch = String(res.text).match(/episodes:\[([\s\S]*?)\]/);
    if (!listMatch) return [];
    const numbers = [];
    const seen = Object.create(null);
    const numRe = /number:(\d+(?:\.\d+)?)/g;
    let match;
    while ((match = numRe.exec(listMatch[1]))) {
      const n = Number(match[1]);
      if (isNaN(n) || seen[n]) continue;
      seen[n] = true;
      numbers.push(n);
    }
    numbers.sort((a, b) => a - b);
    if (!numbers.length) return [];

    const sampleNum = numbers[0];
    const { subAvailable, dubAvailable } = await detectSeriesLanguages(slug, sampleNum);
    const seriesTitle = titleFromSlug(slug);
    const isSingleMovie = numbers.length === 1 && numbers[0] === 0;

    return numbers.map((n) => {
      const isMovieEp = n === 0;
      const epTitle = isSingleMovie || isMovieEp ? 'Película' : `Episodio ${n}`;
      const epNumber = isSingleMovie ? 1 : n;
      return {
        number: epNumber,
        season: 1,
        href: `${SITE}/media/${slug}/${n}`,
        title: epTitle,
        description: isSingleMovie ? `Película: ${seriesTitle}` : `Episodio ${n} de ${seriesTitle}`,
        subAvailable,
        dubAvailable,
      };
    });
  }

  /* ------------------------------ Stream Extraction ------------------------------ */

  function streamHeaders(playId) {
    return {
      'User-Agent': USER_AGENT,
      Origin: PLAYER_HOST,
      Referer: `${PLAYER_HOST}/play/${playId}`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
  }

  function mp4Headers(referer) {
    const origin = (String(referer).match(/^(https?:\/\/[^/]+)/) || [])[1] || referer;
    return {
      'User-Agent': USER_AGENT,
      Referer: referer,
      Origin: origin,
      Accept: 'video/mp4,video/*,*/*',
    };
  }

  async function probeMp4(url, headers, deadline) {
    const first = await requestRaw(
      url,
      Object.assign({}, headers, { Range: 'bytes=0-32' }),
      { followRedirects: false, timeoutMs: 8000, deadline },
    );
    const loc = readHeader(first.headers, 'location');
    if (
      (first.status === 301 ||
        first.status === 302 ||
        first.status === 303 ||
        first.status === 307 ||
        first.status === 308) &&
      loc
    ) {
      const next = toAbsoluteUrl(loc, url);
      const second = await requestRaw(
        next,
        Object.assign({}, headers, { Range: 'bytes=0-32' }),
        { followRedirects: false, timeoutMs: 8000, deadline },
      );
      if (!second.ok || looksHtmlBody(second.text) || !looksMediaSample(second.text, second.headers)) {
        return null;
      }
      return next;
    }
    if (!first.ok || looksHtmlBody(first.text) || !looksMediaSample(first.text, first.headers)) {
      return null;
    }
    if (first.finalUrl && /^https?:\/\//i.test(first.finalUrl) && first.finalUrl !== url) {
      return first.finalUrl;
    }
    return url;
  }

  async function probeZillaHls(playId, deadline) {
    const headers = streamHeaders(playId);
    const url = `${PLAYER_HOST}/m3u8/${playId}`;
    let playlist = await requestRaw(url, headers, { timeoutMs: 8000, deadline });
    if (!playlist.ok || playlist.text.indexOf('#EXTM3U') !== 0) return null;
    let playlistUrl = url;
    const variants = readHlsVariants(playlist.text, url, headers);
    if (playlist.text.includes('#EXT-X-STREAM-INF:')) {
      const child = firstHlsUri(playlist.text);
      if (!child) return null;
      playlistUrl = toAbsoluteUrl(child, url);
      playlist = await requestRaw(playlistUrl, headers, { timeoutMs: 8000, deadline });
      if (!playlist.ok || !playlist.text.startsWith('#EXTM3U')) return null;
    }
    const mediaUri = (playlist.text.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || firstHlsUri(playlist.text);
    const probeUrl = toAbsoluteUrl(mediaUri, playlistUrl);
    if (!probeUrl) return null;

    const seg = await requestRaw(probeUrl, Object.assign({}, headers, { Range: 'bytes=0-32' }), {
      timeoutMs: 8000, deadline,
    });
    if (!seg.ok || looksBlockedPage(seg.text) || looksHtmlBody(seg.text) || !looksMediaSample(seg.text, seg.headers)) {
      return null;
    }
    return {
      type: 'HLS',
      url,
      streamType: 'hls',
      headers,
      qualities: [{ label: 'Auto', url, headers }].concat(variants),
      subtitles: [],
    };
  }

  function firstHlsUri(text) {
    return String(text).split(/\r?\n/).map((line) => line.trim()).find((line) => line && line.charAt(0) !== '#') || '';
  }

  function readHlsVariants(text, base, headers) {
    const lines = String(text).split(/\r?\n/);
    if (lines.some(line => /^#EXT-X-MEDIA:/i.test(line.trim()) && /(?:^|,)\s*URI\s*=\s*"[^"]+"/i.test(line.slice(line.indexOf(':') + 1)))) return [];
    const result = [];
    const seen = Object.create(null);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      // A bare variant can lose its external audio group. Keep Auto in that case.
      if (/(?:[:,])AUDIO=/.test(line)) continue;
      const height = Number((line.match(/RESOLUTION=\d+x(\d+)/) || [])[1]);
      const uri = (lines[i + 1] || '').trim();
      const url = uri && uri.charAt(0) !== '#' ? toAbsoluteUrl(uri, base) : '';
      if (!height || !isStandardPort(url) || seen[url]) continue;
      seen[url] = true;
      result.push({ label: height + 'p', height, url, headers });
    }
    return result;
  }

  function readSubtitleTracks(html, base, headers) {
    const tracks = [];
    const seen = Object.create(null);
    for (const tag of String(html).match(/<track\b[^>]*>/gi) || []) {
      const attrs = Object.create(null);
      const re = /([a-z]+)\s*=\s*(["'])(.*?)\2/gi;
      let hit;
      while ((hit = re.exec(tag))) attrs[hit[1].toLowerCase()] = cleanText(hit[3]);
      if (attrs.kind && !/^(subtitles|captions)$/i.test(attrs.kind)) continue;
      const url = toAbsoluteUrl(attrs.src, base);
      if (!isStandardPort(url) || !/\.(vtt|srt)(?:[?#]|$)/i.test(url) || seen[url]) continue;
      if (!attrs.srclang && !attrs.label) continue;
      seen[url] = true;
      tracks.push({ url, language: attrs.srclang || '', label: attrs.label || attrs.srclang, headers });
    }
    return tracks;
  }

  function evalStreamTapeExpr(expr) {
    const source = String(expr || '');
    const blobMatch = source.match(/\('([^']+)'\)((?:\.substring\(\d+\))+)/);
    if (!blobMatch) return '';
    const head = source.slice(0, source.indexOf("('"));
    let prefix = '';
    const prefixRe = /['"]([^'"]*)['"]/g;
    let prefixHit = prefixRe.exec(head);
    while (prefixHit) {
      prefix += prefixHit[1];
      prefixHit = prefixRe.exec(head);
    }
    let piece = blobMatch[1];
    const cuts = blobMatch[2].match(/substring\((\d+)\)/g) || [];
    for (let i = 0; i < cuts.length; i += 1) {
      const n = Number((cuts[i].match(/\d+/) || [])[0] || 0);
      piece = piece.substring(n);
    }
    let url = prefix + piece;
    if (url.indexOf('//') === 0) url = 'https:' + url;
    if (url.charAt(0) === '/') url = 'https://streamtape.com' + url;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
    return /get_video/i.test(url) ? url : '';
  }

  function parseStreamTapeGetVideo(html) {
    const source = String(html || '');
    const named = source.match(
      /getElementById\('robotlink'\)\.innerHTML\s*=\s*([^;]+)/i,
    );
    if (named) {
      const url = evalStreamTapeExpr(named[1]);
      if (url) return url;
    }
    const assignRe = /getElementById\('([^']*link[^']*)'\)\.innerHTML\s*=\s*([^;]+)/gi;
    let last = '';
    let assign = assignRe.exec(source);
    while (assign) {
      const url = evalStreamTapeExpr(assign[2]);
      if (url) last = url;
      assign = assignRe.exec(source);
    }
    return last;
  }

  async function resolveStreamTape(embedUrl, deadline) {
    if (!embedUrl || embedUrl.includes('undef')) return '';
    const res = await requestText(embedUrl, { Referer: SITE + '/', Accept: 'text/html,*/*' }, 8000, deadline);
    const getVideo = parseStreamTapeGetVideo(res.text);
    if (!getVideo) {
      log('streamtape: no get_video in embed');
      return '';
    }
    const headers = mp4Headers('https://streamtape.com/');
    const first = await requestRaw(
      getVideo,
      Object.assign({}, headers, { Range: 'bytes=0-32' }),
      { followRedirects: false, timeoutMs: 8000, deadline },
    );
    const loc = readHeader(first.headers, 'location');
    let target = loc
      ? toAbsoluteUrl(loc, getVideo)
      : (first.finalUrl && first.finalUrl !== getVideo ? first.finalUrl : '');
    if (!target && first.status >= 200 && first.status < 300 && looksMediaSample(first.text, first.headers)) {
      target = getVideo;
    }
    if (!target) {
      log('streamtape: no redirect from get_video status=' + first.status);
      return '';
    }
    const second = await requestRaw(
      target,
      Object.assign({}, headers, { Range: 'bytes=0-32' }),
      { followRedirects: false, timeoutMs: 8000, deadline },
    );
    if (!second.ok || looksHtmlBody(second.text) || !looksMediaSample(second.text, second.headers)) {
      log('streamtape: cdn probe failed status=' + second.status);
      return '';
    }
    return target;
  }

  async function resolveMp4Upload(embedUrl, deadline) {
    if (!embedUrl || embedUrl.includes('undef')) return '';
    const res = await requestText(embedUrl, { Referer: SITE + '/', Accept: 'text/html,*/*' }, 8000, deadline);
    if (!res.text) return '';
    const match = res.text.match(/src:\s*["'](https?:[^"']+\.mp4[^"']*)["']/i) ||
      res.text.match(/https?:\/\/[a-z0-9.-]*mp4upload\.com[^"']+\.mp4[^"']*/i);
    const url = match ? match[1] || match[0] : '';
    if (!url) return '';
    const headers = mp4Headers('https://www.mp4upload.com/');
    const probed = await probeMp4(url, headers, deadline);
    if (!probed) return '';
    if (!isStandardPort(probed)) {
      log('mp4upload: rejected non-standard port');
      return '';
    }
    return { url: probed, headers, subtitles: readSubtitleTracks(res.text, embedUrl, headers) };
  }

  async function resolveYourUpload(embedUrl, deadline) {
    if (!embedUrl || embedUrl.includes('undef')) return '';
    const res = await requestText(embedUrl, { Referer: SITE + '/', Accept: 'text/html,*/*' }, 8000, deadline);
    if (!res.text) return '';
    const match = res.text.match(/https?:\/\/[^"' ]*vidcache\.net[^"' ]+\.mp4[^"']*/i) ||
      res.text.match(/file\s*[:=]\s*["'](https?:[^"']+\.mp4[^"']*)["']/i);
    const url = match ? (match[1] || match[0]) : '';
    if (!url) return '';
    const headers = mp4Headers('https://www.yourupload.com/');
    const probed = await probeMp4(url, headers, deadline);
    return probed ? { url: probed, headers, subtitles: readSubtitleTracks(res.text, embedUrl, headers) } : null;
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

// ------------------------------------------- AES-128-CBC (UPNShare player payloads)
// The UPNShare player family (uns.bio custom domains, e.g. animeav1.uns.bio) encrypts its
// /api/v1/video?id= payloads with AES-128-CBC. Key and IV are minted by the site's own frontend
// bundle from static constants ("kiemtienmua911ca" / "1234567890oiuytr"); they are the
// site-published scheme values of a public player, not user data. Ciphertext is plain hex.
// Pure ES5 like the AES-256 block above; shares its S-box, inverse S-box and GF helpers.
const UPN_PAYLOAD_KEY_TEXT = 'kiemtienmua911ca';
const UPN_PAYLOAD_IV_TEXT = '1234567890oiuytr';
function aesExpandKey128(keyBytes) {
  const Nk = 4;
  const total = 44;
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
    }
    w[i] = (w[i - Nk] ^ t) >>> 0;
  }
  return w;
}
function aesDecryptBlock128(block16, w) {
  const inv = aesInvSbox();
  const s = block16.slice(0);
  let i;
  const addRoundKey = function (round) {
    const base = 4 * round;
    for (let j = 0; j < 16; j += 1) s[j] ^= (w[base + (j >> 2)] >>> (24 - 8 * (j & 3))) & 255;
  };
  addRoundKey(10);
  for (let round = 9; round >= 0; round -= 1) {
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
function hexToBytes(hex) {
  const out = [];
  const s = String(hex || '').trim();
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substring(i, i + 2), 16));
  return out;
}
function upnshareDecrypt(hex) {
  try {
    const key = [];
    const iv = [];
    let i;
    for (i = 0; i < 16; i += 1) key.push(UPN_PAYLOAD_KEY_TEXT.charCodeAt(i) & 255);
    for (i = 0; i < 16; i += 1) iv.push(UPN_PAYLOAD_IV_TEXT.charCodeAt(i) & 255);
    const bytes = hexToBytes(hex);
    if (!bytes.length || bytes.length % 16 !== 0) return null;
    const w = aesExpandKey128(key);
    const plainBytes = [];
    let prev = iv;
    for (let off = 0; off + 16 <= bytes.length; off += 16) {
      const block = bytes.slice(off, off + 16);
      const dec = aesDecryptBlock128(block, w);
      for (i = 0; i < 16; i += 1) plainBytes.push(dec[i] ^ prev[i]);
      prev = block;
    }
    let outBytes = plainBytes;
    const pad = outBytes.length ? outBytes[outBytes.length - 1] : 0;
    if (pad > 0 && pad <= 16 && pad <= outBytes.length) {
      let ok = true;
      for (let k = 0; k < pad; k += 1) if (outBytes[outBytes.length - 1 - k] !== pad) { ok = false; break; }
      if (ok) outBytes = outBytes.slice(0, outBytes.length - pad);
    }
    const text = bytesToText(outBytes).trim();
    const json = safeJsonParse(text);
    return json && typeof json === 'object' ? json : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- outage rescue (AniKage)
// Vidhawk is the primary provider. When it has no VERIFIED media for a title (provider outage
// or a title it does not carry) the module asks AniKage (anikage.cc, JSON API) as a labelled
// second source. Rescue routes pass the same positive byte validation as primary routes and
// are never substituted across languages. Quota discipline: one sweep per play, stop on 429,
// cache slug lookups (6 h) and verified routes (10 min) so repeat plays cost zero requests.

var ANIKAGE = 'https://anikage.cc';
var RESCUE_PROVIDERS = ['koto', 'wave', 'zen', 'dib', 'neko'];
var RESCUE_MAX_ROUTES = 3;
var RESCUE_MAX_EMBEDS = 4;
var RESCUE_BUDGET_MS = 12000;
var RESCUE_TITLE_TTL = 6 * 60 * 60 * 1000;
var RESCUE_SLUG_TTL = 6 * 60 * 60 * 1000;
var RESCUE_ROUTE_TTL = 10 * 60 * 1000;
var rescueTitles = {};
var rescueSlugs = {};
var rescueRoutes = {};

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function rescueCacheGet(store, key, ttl) {
  var hit = store[key];
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  delete store[key];
  return null;
}

function rescueCacheSet(store, key, value, ttl) {
  store[key] = { at: Date.now(), value: value, ttl: ttl };
}

function rescueTerm(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/['\u2019]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rescueOrigin(url) {
  var m = String(url || '').match(/^https?:\/\/[^\/?#]+/i);
  return m ? m[0] : '';
}

function rescuePick(list, ref, title) {
  if (!Array.isArray(list)) return null;
  if (ref.anilistId) {
    var byId = list.filter(function (item) {
      return item && String(item.anilistId || '') === String(ref.anilistId);
    });
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) return null;
  }
  var wanted = rescueTerm(title);
  if (!wanted) return null;
  var byTitle = list.filter(function (item) {
    if (!item) return false;
    var t = item.title;
    var names = typeof t === 'string' ? [t] : [t && t.english, t && t.romaji, t && t.userPreferred];
    return names.some(function (name) {
      return name && rescueTerm(name) === wanted;
    });
  });
  return byTitle.length === 1 ? byTitle[0] : null;
}

async function rescueTitleFor(ref) {
  // AnimeAV1 supplies the clean title from the episode slug; nothing to look up here.
  var title = cleanText(ref.title || '');
  return title || '';
}

async function rescueSlugFor(ref, title, session) {
  var key = String(ref.anilistId || ref.malId || rescueTerm(title) || '');
  if (!key) return '';
  var cached = rescueCacheGet(rescueSlugs, key, RESCUE_SLUG_TTL);
  if (cached) return cached;
  if (!title) return '';
  var res = await rescueRequest(
    ANIKAGE + '/api/media/anime/browse?q=' + encodeURIComponent(title),
    { Accept: 'application/json', Referer: ANIKAGE + '/' },
    'GET',
    null,
    { session: session },
  );
  if (res && res.status === 429) {
    log('rescue search rate limited (429)');
    return '';
  }
  if (!res || !res.ok || !res.json) {
    log('rescue browse unavailable (' + (res ? res.status : 'net') + ')');
    return '';
  }
  var pick = rescuePick(res.json.data, ref, title);
  if (!pick) return '';
  var slug = String(pick.slug || pick.id || '');
  if (!slug) return '';
  rescueCacheSet(rescueSlugs, key, slug, RESCUE_SLUG_TTL);
  return slug;
}

function rescueRank(url) {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 0;
  if (/megaplay\.|vidstream/i.test(url)) return 0;
  if (/echovideo/i.test(url)) return 1;
  if (/otakuhg\.site|otakuvid\.online|playmogo\.com|\.(?:vivi|bibi)\./i.test(url)) return 2;
  return 3;
}

function rescueEmbedUrls(data) {
  var seen = {};
  function url(entry) {
    if (typeof entry === 'string') return entry;
    if (!entry) return '';
    var u = String(entry.url || '').trim();
    if (/^https?:\/\//i.test(u)) return u;
    return String(entry.embedUrl || '');
  }
  var merged = [].concat(
    (data && data.embeds) || [],
    (data && data.embedOptions) || [],
    Array.isArray(data && data.sources) ? data.sources : [],
  );
  return merged
    .map(url)
    .filter(function (u) {
      if (!/^https?:\/\//i.test(u) || seen[u]) return false;
      seen[u] = true;
      return true;
    })
    .sort(function (a, b) {
      return rescueRank(a) - rescueRank(b);
    });
}

function rescuePlayerMeta(html) {
  var src = String(html || '');
  var id = (src.match(/data-id=["']?(\d+)["']?/i) || [])[1] || (src.match(/id:\s*["']?(\d+)["']?/i) || [])[1] || '';
  var type = (src.match(/type:\s*['"](sub|dub|hsub)['"]/i) || [])[1] || '';
  return { id: String(id || '').trim(), type: String(type || '').toLowerCase() };
}

function rescueNormalizeEntries(payload) {
  var out = [];
  var seen = {};
  function push(url, label) {
    var u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u) || seen[u]) return;
    seen[u] = true;
    out.push({ quality: cleanText(label || 'Auto') || 'Auto', url: u });
  }
  var raw = payload;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    raw = (raw.sources && (raw.sources.file || raw.sources.url || raw.sources)) || raw.file || raw.url || raw;
  }
  if (typeof raw === 'string') {
    push(raw);
  } else if (Array.isArray(raw)) {
    raw.forEach(function (entry) {
      if (entry) push(entry.file || entry.url, entry.label || entry.quality || entry.type);
    });
  } else if (raw && typeof raw === 'object') {
    if (raw.file || raw.url) push(raw.file || raw.url, raw.label || raw.quality);
    ['HQ', 'HD', 'SD'].forEach(function (key) {
      [].concat(raw[key] || []).forEach(function (u) {
        if (typeof u === 'string') push(u, key);
      });
    });
  }
  return out;
}

function unpackPacker(code) {
  try {
    var match = String(code || '').match(/eval\(function\(p,a,c,k,e,[rd]\)\{.*\}\('(.*)',\s*(\d+),\s*(\d+),\s*'([^']*)'\.split\('\|'\)/);
    if (!match) return null;
    var p = match[1];
    var a = parseInt(match[2], 10);
    var c = parseInt(match[3], 10);
    var k = match[4].split('|');
    var e = function (n) {
      return (n < a ? '' : e(parseInt(n / a, 10))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
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

function rescueSleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function rescueFinish(session, value) {
  // Deliver the result through plain fields: the app JS engine does not reliably run
  // reactions chained onto an already-settled promise, so the caller polls these fields.
  session.result = value;
  session.done = true;
  return value;
}

async function rescuePlayerRoute(embedUrl, want, session) {
  var uaHeaders = { 'User-Agent': USER_AGENT, Referer: ANIKAGE + '/' };

  if (/\.m3u8(?:[?#]|$)/i.test(embedUrl)) {
    var direct = await rescueProbeHls(embedUrl, uaHeaders, session);
    if (!direct.ok) return null;
    return {
      name: 'AniKage',
      url: embedUrl,
      headers: uaHeaders,
      streamType: 'hls',
      lang: want,
      subtitles: [],
      qualities: [{ label: 'Auto', url: embedUrl, headers: uaHeaders }],
    };
  }

  if (/megaplay\.|vidstream/i.test(embedUrl)) {
    var origin = rescueOrigin(embedUrl);
    var page = await rescueRequest(embedUrl, Object.assign({ Accept: 'text/html,*/*' }, uaHeaders), 'GET', null, { session: session });
    if (!page.ok) {
      log('rescue mp page ' + page.status);
      return null;
    }
    var meta = rescuePlayerMeta(page.text);
    if (!meta.id) {
      log('rescue mp no-id');
      return null;
    }
    var srcHeaders = { 'User-Agent': USER_AGENT, Accept: '*/*', Referer: origin + '/', Origin: origin };
    var qs = '?id=' + encodeURIComponent(meta.id) + '&id=' + encodeURIComponent(meta.id) + '&type=' + encodeURIComponent(want);
    var data = null;
    var fresh = await rescueRequest(origin + '/stream/getSourcesNew' + qs, srcHeaders, 'GET', null, { session: session });
    if (fresh && fresh.ok && fresh.json) data = fresh.json;
    if (!data || (!data.sources && !data.enc && !data.file)) {
      var legacy = await rescueRequest(origin + '/stream/getSources' + qs, srcHeaders, 'GET', null, { session: session });
      if (legacy && legacy.ok && legacy.json) data = legacy.json;
    }
    if (!data) {
      log('rescue mp no-sources');
      return null;
    }
    var entries = rescueNormalizeEntries(data);
    if (!entries.length && data.enc) {
      var decrypted = decryptPlayerPayload(data.enc);
      if (decrypted) entries = rescueNormalizeEntries(decrypted);
    }
    if (!entries.length) {
      log('rescue mp no-entries');
      return null;
    }
    var caps = rescueMapCaptions(data.tracks, want, srcHeaders);
    for (var i = 0; i < entries.length && i < 2; i += 1) {
      var probe = await rescueProbeHls(entries[i].url, srcHeaders, session);
      if (probe.ok) {
        return {
          name: 'AniKage \u00b7 MegaPlay',
          url: entries[i].url,
          headers: srcHeaders,
          streamType: 'hls',
          lang: want,
          subtitles: caps,
          qualities: [{ label: entries[i].quality || 'Auto', url: entries[i].url, headers: srcHeaders }],
        };
      }
    }
    log('rescue mp probe ' + (probe && probe.reason ? probe.reason : 'fail'));
    return null;
  }

  var echo = embedUrl.match(/^https:\/\/play\.echovideo\.ru\/(embed-[a-z0-9-]+)\/([^/?#]+)/i);
  if (echo) {
    var echoHeaders = { 'User-Agent': USER_AGENT, Accept: '*/*', Referer: embedUrl, Origin: 'https://play.echovideo.ru' };
    var gs = await rescueRequest('https://play.echovideo.ru/' + echo[1] + '/getSources?id=' + encodeURIComponent(echo[2]), echoHeaders, 'GET', null, { session: session });
    if (!gs.ok || !gs.json) {
      log('rescue echo sources ' + (gs ? gs.status : 'net'));
      return null;
    }
    var eentries = rescueNormalizeEntries(gs.json);
    for (var e = 0; e < eentries.length && e < 2; e += 1) {
      var eprobe = await rescueProbeHls(eentries[e].url, echoHeaders, session);
      if (eprobe.ok) {
        return {
          name: 'AniKage \u00b7 EchoVideo',
          url: eentries[e].url,
          headers: echoHeaders,
          streamType: 'hls',
          lang: want,
          subtitles: rescueMapCaptions(gs.json.tracks, want, echoHeaders),
          qualities: [{ label: eentries[e].quality || 'Auto', url: eentries[e].url, headers: echoHeaders }],
        };
      }
    }
    log('rescue echo probe ' + (eprobe && eprobe.reason ? eprobe.reason : 'fail'));
    return null;
  }

  if (/otakuhg\.site|otakuvid\.online|playmogo\.com|\.(?:vivi|bibi)\.|flixcloud\.|animeapps\.top|mfw09\.org|myvidplay\.com/i.test(embedUrl)) {
    var page2 = await rescueRequest(embedUrl, Object.assign({ Accept: 'text/html,*/*' }, uaHeaders), 'GET', null, { session: session });
    if (!page2.ok) return null;
    var body = unpackPacker(page2.text) || page2.text;
    var hit = body.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
    if (!hit) return null;
    var hdr2 = { 'User-Agent': USER_AGENT, Referer: embedUrl, Origin: rescueOrigin(embedUrl) };
    var probe2 = await rescueProbeHls(hit[0], hdr2, session);
    if (!probe2.ok) return null;
    return {
      name: 'AniKage \u00b7 Player',
      url: hit[0],
      headers: hdr2,
      streamType: 'hls',
      lang: want,
      subtitles: [],
      qualities: [{ label: 'Auto', url: hit[0], headers: hdr2 }],
    };
  }

  log('rescue unsupported embed');
  return null;
}

async function rescueAnikageRoutes(ref, want, halt) {
  var routeKey = String(ref.anilistId || ref.malId || '') + '|' + String(ref.episode) + '|' + want;
  var session = halt || {};
  if (typeof session.closed !== 'boolean') session.closed = false;
  if (!session.deadline) session.deadline = Date.now() + RESCUE_BUDGET_MS;
  var cached = rescueCacheGet(rescueRoutes, routeKey, RESCUE_ROUTE_TTL);
  if (cached && cached.length) return rescueFinish(session, cached);
  var startAt = Date.now();
  var routes = [];
  try {
    var title = await rescueTitleFor(ref);
    if (!title || session.closed) return null;
    var slug = await rescueSlugFor(ref, title, session);
    if (!slug || session.closed) return null;
    log('rescue: ' + slug + ' ep' + ref.episode + ' ' + want);
    var order = 0;
    for (var p = 0; p < RESCUE_PROVIDERS.length; p += 1) {
      if (session.closed || Date.now() >= session.deadline) break;
      // Return the first verified route immediately — never make the user wait while a
      // backup provider probes (a straggler probe here cost 8 s of the offline wait once).
      if (routes.length) break;
      var provider = RESCUE_PROVIDERS[p];
      var url =
        ANIKAGE +
        '/api/media/anime/' + encodeURIComponent(slug) +
        '/episodes/' + encodeURIComponent(ref.episode) +
        '/sources?provider=' + provider +
        '&lang=' + want;
      var res = await rescueRequest(url, { Accept: 'application/json', Referer: ANIKAGE + '/anime/watch/' + slug }, 'GET', null, { session: session });
      if (res && res.status === 429) {
        log('rescue sweep rate limited (429)');
        break;
      }
      if (!res || !res.ok || !res.json) {
        log('rescue ' + provider + ' unavailable (' + (res ? res.status : 'net') + ')');
        continue;
      }
      var data = res.json;
      if (
        String(data.slug || '') !== String(slug) ||
        Number(data.number) !== Number(ref.episode) ||
        String(data.subType || '').toLowerCase() !== want
      ) {
        log('rescue ' + provider + ' shape mismatch');
        continue;
      }
      var embeds = rescueEmbedUrls(data).slice(0, RESCUE_MAX_EMBEDS);
      log('rescue ' + provider + ' embeds=' + embeds.length);
      var providerStart = Date.now();
      for (var e2 = 0; e2 < embeds.length && routes.length < RESCUE_MAX_ROUTES; e2 += 2) {
        if (session.closed || Date.now() >= session.deadline) break;
        // Bound each provider's share so one slow provider cannot starve the rest (a single
        // hung koto embed once ate 8 s of a 10 s budget and starved wave/zen, which were the
        // providers that actually carried the episode).
        if (e2 > 0 && Date.now() >= providerStart + 3200) break;
        var group = embeds.slice(e2, e2 + 2);
        var groupStart = Date.now();
        var providerLabel = provider;
        // Probe the group in PARALLEL but poll the shared route array for the first verified
        // route — the app JS engine does not reliably propagate nested racing-promise
        // reactions, while timers and .then handlers are proven to run (a hanging first
        // embed must never block a sibling that verifies in ~1.3 s).
        group.forEach(function (embed) {
          rescuePlayerRoute(embed, want, session)
            .then(function (route) {
              if (!route || routes.length >= RESCUE_MAX_ROUTES) return null;
              if (routes.some(function (known) { return known.url === route.url; })) return null;
              route.name += ' (' + providerLabel + ')';
              route.order = order++;
              routes.push(route);
              log('rescue route ' + route.name + ' +' + (Date.now() - startAt) + 'ms');
              return route;
            })
            .catch(function () {
              log('rescue embed error');
              return null;
            });
        });
        var groupDeadline = Math.min(Date.now() + 3000, providerStart + 3400, session.deadline);
        while (routes.length === 0 && !session.closed && Date.now() < groupDeadline) {
          await rescueSleep(350);
        }
        if (!routes.length) {
          log('rescue ' + provider + ' group' + (e2 / 2) + ' ' + (Date.now() - groupStart) + 'ms none');
        }
        if (routes.length) break;
      }
    }
    log('rescue routes=' + routes.length + ' in ' + (Date.now() - startAt) + 'ms');
    routes.forEach(function (row) { if (row && row.url && !row.label) row.label = 'Auto'; });
    if (routes.length) rescueCacheSet(rescueRoutes, routeKey, routes, RESCUE_ROUTE_TTL);
    return rescueFinish(session, routes.length ? routes : null);
  } catch (error) {
    log('rescue error ' + (error && error.message ? error.message : error));
    return rescueFinish(session, null);
  } finally {
    session.closed = true;
  }
}

  /* --------------- AniKage rescue bridge (AV1 flavour) ---------------
     The certified AniKage rescue block (shared with the Synthetiq anime modules) talks to its host
     module through three small helpers. The three below are drop-in equivalents built on this
     module's own primitives (requestRaw / byte-first media classification), so the rescue keeps
     its exact semantics without importing foreign request machinery. */

  async function rescueRequest(url, headers, method, body, opts) {
    const cfg = opts || {};
    const deadline = cfg.session && cfg.session.deadline ? cfg.session.deadline : undefined;
    const res = await requestRaw(url, headers || {}, { method: method || 'GET', timeoutMs: 8000, deadline });
    const out = { ok: !!res.ok, status: res.status || 0, text: res.text || '', headers: res.headers || {} };
    if (out.text) {
      try { out.json = JSON.parse(out.text); } catch (_) { out.json = null; }
    }
    return out;
  }

  async function rescueProbeHls(url, headers, session) {
    const deadline = session && session.deadline ? session.deadline : undefined;
    const master = await requestRaw(url, headers, { timeoutMs: 8000, deadline });
    if (!master.ok || looksBlockedPage(master.text) || String(master.text).indexOf('#EXTM3U') !== 0) {
      return { ok: false, reason: 'master' };
    }
    let mediaUrl = url;
    let mediaText = master.text;
    if (mediaText.indexOf('#EXT-X-STREAM-INF:') !== -1) {
      const child = firstHlsUri(mediaText);
      if (!child) return { ok: false, reason: 'no_variant' };
      mediaUrl = toAbsoluteUrl(child, url);
      const vres = await requestRaw(mediaUrl, headers, { timeoutMs: 8000, deadline });
      if (!vres.ok || !vres.text || vres.text.indexOf('#EXTM3U') !== 0) return { ok: false, reason: 'variant' };
      mediaText = vres.text;
    }
    const segUri = (mediaText.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || firstHlsUri(mediaText);
    const segUrl = toAbsoluteUrl(segUri, mediaUrl);
    if (!segUrl) return { ok: false, reason: 'no_segment' };
    const seg = await requestRaw(segUrl, Object.assign({}, headers, { Range: 'bytes=0-32' }), { timeoutMs: 8000, deadline });
    if (!seg.ok || looksBlockedPage(seg.text) || looksHtmlBody(seg.text) || !looksMediaSample(seg.text, seg.headers)) {
      return { ok: false, reason: 'segment' };
    }
    return { ok: true };
  }

  function rescueMapCaptions(captions, audio, hdrs) {
    const out = [];
    const seen = Object.create(null);
    const push = function (item) {
      if (!item || typeof item !== 'object') return;
      const file = String(item.src || item.file || item.url || '').trim();
      if (!/^https?:\/\//i.test(file) || seen[file]) return;
      seen[file] = true;
      const label = cleanText(item.label || item.language || item.lang || 'Subtitle');
      out.push({
        url: file,
        language: captionLanguage(item.label || item.lang || item.language || ''),
        label: label || 'Subtitle',
        headers: hdrs,
      });
    };
    if (Array.isArray(captions)) { captions.forEach(push); return out; }
    if (captions && typeof captions === 'object') {
      const key = audio === 'dub' ? 'dub' : 'sub';
      if (Array.isArray(captions[key])) captions[key].forEach(push);
      else if (Array.isArray(captions.sub)) captions.sub.forEach(push);
    }
    return out;
  }

  /* --------------- UPNShare (uns.bio-family player, AES-gated API) ---------------
     The embed is https://<host>/#<videoId>. The API answers with one AES-128-CBC payload that
     carries the delivery URLs plus a per-session CDN token pair (pk). The site-proxied native
     path is preferred (same host as the embed, https), the direct source is the fallback; every
     candidate must verify its master playlist AND first segment bytes before it becomes a route. */

  async function probeHlsPlaylist(url, headers, deadline) {
    const master = await requestRaw(url, headers, { timeoutMs: 8000, deadline });
    if (!master.ok || looksBlockedPage(master.text) || String(master.text).indexOf('#EXTM3U') !== 0) return null;
    const variants = readHlsVariants(master.text, url, headers);
    let mediaUrl = url;
    let mediaText = master.text;
    if (mediaText.indexOf('#EXT-X-STREAM-INF:') !== -1) {
      const child = firstHlsUri(mediaText);
      if (!child) return null;
      mediaUrl = toAbsoluteUrl(child, url);
      const childRes = await requestRaw(mediaUrl, headers, { timeoutMs: 8000, deadline });
      if (!childRes.ok || !childRes.text || childRes.text.indexOf('#EXTM3U') !== 0) return null;
      mediaText = childRes.text;
    }
    const segUri = (mediaText.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || firstHlsUri(mediaText);
    const segUrl = toAbsoluteUrl(segUri, mediaUrl);
    if (!segUrl) return null;
    const seg = await requestRaw(segUrl, Object.assign({}, headers, { Range: 'bytes=0-32' }), { timeoutMs: 8000, deadline });
    if (!seg.ok || looksBlockedPage(seg.text) || looksHtmlBody(seg.text) || !looksMediaSample(seg.text, seg.headers)) return null;
    return { ok: true, mediaUrl, variants };
  }

  async function resolveUpnshare(embedUrl, deadline) {
    const parts = String(embedUrl || '').match(/^(https:\/\/[^/]+)\/?#([^&]+)/);
    if (!parts) return null;
    const host = parts[1];
    const videoId = parts[2];
    if (!videoId || videoId.length < 2) return null;
    const apiHeaders = { Referer: host + '/', Origin: host, Accept: 'application/json, text/plain, */*' };
    const res = await requestRaw(host + '/api/v1/video?id=' + encodeURIComponent(videoId), apiHeaders, { timeoutMs: 9000, deadline });
    const hex = ((res && res.text) || '').trim();
    if (!res.ok || !/^[0-9a-f]{32,}$/i.test(hex)) {
      log('upnshare: api unavailable');
      return null;
    }
    const payload = upnshareDecrypt(hex);
    const pk = payload && payload.pk;
    if (!payload || !pk || !pk.k) {
      log('upnshare: payload without tokens');
      return null;
    }
    const candidates = [];
    const addCandidate = function (value) {
      let url = String(value || '');
      if (!/^https?:\/\//i.test(url)) return;
      if (url.indexOf('/v4/') !== -1 && url.indexOf('k=' + pk.k) === -1) {
        url += (url.indexOf('?') === -1 ? '?' : '&') + 'k=' + pk.k + '&kx=' + pk.kx;
      }
      if (!isStandardPort(url) || candidates.indexOf(url) !== -1) return;
      candidates.push(url);
    };
    addCandidate(payload.cfNative);
    addCandidate(payload.source);
    if (!candidates.length) return null;
    const headers = { 'User-Agent': USER_AGENT, Referer: host + '/', Origin: host, Accept: '*/*' };
    for (let i = 0; i < candidates.length; i += 1) {
      const probed = await probeHlsPlaylist(candidates[i], headers, deadline);
      if (probed && probed.ok) {
        return {
          url: candidates[i],
          headers,
          streamType: 'hls',
          subtitles: [],
          qualities: [{ label: 'Auto', url: candidates[i], headers }].concat(probed.variants || []),
        };
      }
    }
    log('upnshare: no verified media');
    return null;
  }

  /* --------------- VOE (voe.sx family, JSON envelope + rotating front domains) ---------------
     The embed page hops once (window.location.href = ...) onto a rotating player domain whose
     configuration sits in an <script type="application/json"> envelope: rot13-shifted, then
     base64, then a per-character shift, then reversed. Decoded locally — page scripts are never
     executed. Only the specific envelope whose file_code matches the requested id is accepted. */

  const VOE_B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function voeB64(value) {
    const input = String(value || '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1) return null;
    let bits = 0;
    let buffer = 0;
    let out = '';
    for (let i = 0; i < input.length && input[i] !== '='; i += 1) {
      const v = VOE_B64_CHARS.indexOf(input[i]);
      if (v === -1) return null;
      buffer = (buffer << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buffer >> bits) & 255);
      }
    }
    return out;
  }
  function voeConfig(html, expectedId) {
    const scripts = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scripts.exec(String(html || '')))) {
      try {
        const arr = JSON.parse(m[1]);
        if (!Array.isArray(arr) || typeof arr[0] !== 'string' || arr[0].length > 200000) continue;
        let s = arr[0].replace(/[a-zA-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)); });
        s = s.replace(/@\$|\^\^|~@|%\?|\*~|!!|#&|_/g, '');
        const unshifted = voeB64(s);
        if (!unshifted) continue;
        s = unshifted.split('').map(function (c) { return String.fromCharCode(c.charCodeAt(0) - 3); }).reverse().join('');
        const data = JSON.parse(voeB64(s));
        if (data.file_code === expectedId && /^https:\/\//i.test(String(data.source || '')) && !/test-videos|big.?buck.?bunny/i.test(data.source)) return data;
      } catch (_) { /* not this envelope */ }
    }
    return null;
  }
  async function resolveVoe(embedUrl, deadline) {
    const idMatch = String(embedUrl || '').match(/\/e\/([a-z\d]+)/i);
    if (!idMatch) return null;
    const id = idMatch[1];
    let target = embedUrl;
    let res = await requestRaw(embedUrl, { Referer: SITE + '/', Accept: 'text/html,*/*' }, { timeoutMs: 9000, deadline });
    if (!res.ok || !res.text) return null;
    const redirect = res.text.match(/window\.location\.href\s*=\s*['"](https:\/\/[^'"\s]+)['"]/);
    if (redirect) {
      const next = redirect[1];
      if (!/^https:\/\//i.test(next) || next.split('?')[0].split('/').pop() !== id) {
        log('voe: unexpected redirect');
        return null;
      }
      target = next;
      res = await requestRaw(target, { Referer: embedUrl }, { timeoutMs: 9000, deadline });
      if (!res.ok || !res.text) return null;
    }
    const config = voeConfig(res.text, id);
    if (!config || !config.source) {
      log('voe: config unavailable');
      return null;
    }
    const origin = (target.match(/^https:\/\/[^/]+/) || [])[0] || '';
    const headers = { 'User-Agent': USER_AGENT, Referer: origin + '/', Origin: origin, Accept: '*/*' };
    const source = String(config.source);
    let streamType = 'mp4';
    let verified = false;
    if (/\.m3u8(?:[?#]|$)/i.test(source)) {
      streamType = 'hls';
      verified = !!(await probeHlsPlaylist(source, headers, deadline));
    } else {
      verified = !!(await probeMp4(source, headers, deadline));
    }
    if (!verified) {
      log('voe: source did not verify');
      return null;
    }
    const subtitles = Array.isArray(config.captions)
      ? config.captions.filter(function (c) { return c && /^https:\/\//i.test(String(c.file || '')); }).map(function (c) {
          return {
            url: String(c.file),
            language: captionLanguage(c.language || c.label || ''),
            label: cleanText(c.label || c.language || 'Subtitles'),
            headers,
          };
        })
      : [];
    return { url: source, headers, streamType, subtitles };
  }

  async function resolveEmbeds(servers, variant) {
    const preferred = { UPNShare: 0, Voe: 1, StreamTape: 2, YourUpload: 3, MP4Upload: 4, HLS: 5 };
    const hosts = {
      UPNShare: /^(?:[a-z0-9-]+\.)*uns\.bio$/i,
      Voe: /^(?:voe\.sx|voe\.to|voe\.network)$/i,
      StreamTape: /^streamtape\.com$/i,
      YourUpload: /^yourupload\.com$/i,
      MP4Upload: /^mp4upload\.com$/i,
      HLS: /^player\.zilla-networks\.com$/i,
    };
    const seenEmbeds = Object.create(null);
    const ordered = (servers || []).filter((item) => {
      const host = (String(item.url || '').match(/^https:\/\/(?:www\.)?([^/:?#]+)/i) || [])[1];
      if (!hosts[item.server] || !hosts[item.server].test(host) || !isStandardPort(item.url) || seenEmbeds[item.url]) return false;
      seenEmbeds[item.url] = true;
      return true;
    }).sort((a, b) => preferred[a.server] - preferred[b.server]);
    const deadline = Date.now() + 12000;
    let next = 0;
    const resolved = [];
    // Bound work to four concurrent site-provided embeds and one resolution budget.
    async function worker() {
      while (next < ordered.length && Date.now() < deadline) {
        const index = next++;
        const item = ordered[index];
        let stream = null;
        try {
          if (item.server === 'UPNShare') {
            stream = await resolveUpnshare(item.url, deadline);
          } else if (item.server === 'Voe') {
            stream = await resolveVoe(item.url, deadline);
          } else if (item.server === 'StreamTape') {
            const url = await resolveStreamTape(item.url, deadline);
            if (url) stream = { url, headers: mp4Headers('https://streamtape.com/') };
          } else if (item.server === 'YourUpload') {
            stream = await resolveYourUpload(item.url, deadline);
          } else if (item.server === 'MP4Upload') {
            stream = await resolveMp4Upload(item.url, deadline);
          } else if (item.server === 'HLS') {
            const playId = (item.url.match(/\/play\/([a-f0-9]{32})(?:[/?#]|$)/) || [])[1];
            if (playId) stream = await probeZillaHls(playId, deadline);
          }
        } catch (_) { log('resolve ' + item.server + ' unavailable'); }
        if (!stream || !isStandardPort(stream.url)) continue;
        const streamType = stream.streamType || 'mp4';
        const label = 'Auto';
        resolved[index] = {
          name: item.server === 'HLS' ? 'AnimeAV1 HLS' : item.server,
          label,
          url: stream.url,
          streamType,
          headers: stream.headers,
          lang: variant === 'DUB' ? 'dub' : 'sub',
          subtitles: stream.subtitles || [],
          qualities: stream.qualities || [{ label, url: stream.url, headers: stream.headers }],
        };
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, ordered.length) }, () => worker()));
    const seen = Object.create(null);
    return resolved.filter((stream) => {
      if (seen[stream.url]) return false;
      seen[stream.url] = true;
      return true;
    });
  }

  /* ------------- Vidhawk backbone (same provider the Synthetiq anime modules run on) -------------
     * Labelled extras only, SUB mode only: its audio tracks are JP/EN(+HI), but its SOFT SUBTITLE
     * set carries many languages — including Spanish on a large share of titles. Site routes stay
     * primary; these routes surface when the site hosts die, with their real caption languages. */
  const VIDHAWK = 'https://vidhawk.buzz';
  const CAPTION_LANG_ALIASES = {
    english: 'en', japanese: 'ja', spanish: 'es', portuguese: 'pt', french: 'fr', german: 'de',
    italian: 'it', russian: 'ru', arabic: 'ar', hindi: 'hi', korean: 'ko', chinese: 'zh',
    'chinese (simplified)': 'zh', 'chinese (traditional)': 'zh', indonesian: 'id', thai: 'th',
    turkish: 'tr', vietnamese: 'vi', dutch: 'nl', polish: 'pl', ukrainian: 'uk', czech: 'cs',
  };
  function captionLanguage(label) {
    const base = String(label || '').toLowerCase().split(/[(-]/)[0].replace(/\s+$/, '').trim();
    return CAPTION_LANG_ALIASES[base] || base || 'und';
  }
  function vidhawkHeaders(accept) {
    return { 'User-Agent': USER_AGENT, Accept: accept || 'application/json,*/*', Referer: VIDHAWK + '/', Origin: VIDHAWK };
  }
  async function resolveAniListId(title) {
    const key = normalizeTitle(title);
    if (!key) return '';
    if (anilistIdCache[key]) return anilistIdCache[key];
    try {
      const artwork = await fetchAniListArtwork(String(title || '').replace(/-/g, ' ').trim());
      if (artwork && artwork.anilistId) return artwork.anilistId;
    } catch (_) {}
    return '';
  }
  async function fetchVidhawkRoutes(anilistId, epNum, deadline) {
    if (!anilistId || hostParked('vidhawk.buzz')) return [];
    try {
      const race = await requestText(
        VIDHAWK + '/api/stream/race?episode=' + encodeURIComponent(String(epNum)) + '&audio=sub&server=flow&anilistId=' + encodeURIComponent(String(anilistId)),
        vidhawkHeaders(), 8000, deadline,
      );
      if (!race.status || race.status >= 400 || !race.text) return [];
      let raceData = null;
      try { raceData = JSON.parse(race.text); } catch (_) { return []; }
      const ticket = raceData && raceData.ticket;
      if (!ticket) return [];
      const play = await requestText(VIDHAWK + '/api/play?t=' + encodeURIComponent(ticket), vidhawkHeaders(), 8000, deadline);
      if (!play.status || play.status >= 400 || !play.text) return [];
      let data = null;
      try { data = JSON.parse(play.text); } catch (_) { return []; }
      const track = (data.tracks || []).find(function (row) { return row && row.id === 'sub' && row.src; });
      if (!track) return [];
      const hlsHeaders = vidhawkHeaders('application/vnd.apple.mpegurl,*/*');
      // Positive validation: playlist first, then real first-segment bytes.
      let playlistText = '';
      let playlistUrl = track.src;
      const master = await requestText(track.src, hlsHeaders, 8000, deadline);
      if (!master.status || !/^#EXTM3U/.test(String(master.text || '').trim())) return [];
      playlistText = master.text;
      if (playlistText.includes('#EXT-X-STREAM-INF:')) {
        const child = firstHlsUri(playlistText);
        if (!child) return [];
        playlistUrl = toAbsoluteUrl(child, track.src);
        const childRes = await requestText(playlistUrl, hlsHeaders, 8000, deadline);
        if (!childRes.status || !/^#EXTM3U/.test(String(childRes.text || '').trim())) return [];
        playlistText = childRes.text;
      }
      const mediaUri = (playlistText.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || firstHlsUri(playlistText);
      const segUrl = toAbsoluteUrl(mediaUri, playlistUrl);
      if (!segUrl) return [];
      const seg = await requestRaw(segUrl, Object.assign({}, hlsHeaders, { Range: 'bytes=0-8191' }), { timeoutMs: 8000, deadline });
      if (!seg.ok || looksHtmlBody(seg.text) || !looksMediaSample(seg.text, seg.headers)) return [];
      const caps = (data.captions && data.captions.sub) || [];
      const seenCaps = Object.create(null);
      const subtitles = [];
      caps.forEach(function (entry) {
        const url = entry && entry.src;
        if (!url || seenCaps[url]) return;
        seenCaps[url] = true;
        subtitles.push({ url: url, language: captionLanguage(entry.label || entry.lang || ''), label: cleanText(entry.label || 'Subtitle'), headers: vidhawkHeaders('*/*') });
      });
      const langs = [];
      subtitles.forEach(function (sub) { if (langs.indexOf(sub.language) === -1) langs.push(sub.language); });
      const langLabel = langs.slice(0, 4).map(function (code) { return code.toUpperCase(); }).join(',');
      const route = {
        name: 'Vidhawk',
        label: langLabel ? 'Vidhawk · subs: ' + langLabel : 'Vidhawk',
        url: track.src,
        streamType: 'hls',
        headers: hlsHeaders,
        qualities: [{ label: 'Auto', url: track.src, headers: hlsHeaders }],
        subtitles: subtitles,
      };
      log('vidhawk route verified (subs: ' + (langLabel || 'none') + ')');
      return [route];
    } catch (_) {
      log('vidhawk route unavailable');
      return [];
    }
  }

  async function extractStreamUrl(episodeHref, lang) {
    const url = toAbsoluteUrl(episodeHref);
    if (!/^https:\/\/animeav1\.com\/media\/[^/?#]+\/\d+(?:\.\d+)?\/?(?:[?#].*)?$/.test(url)) {
      throw new Error('AnimeAV1 episode href is invalid');
    }
    const res = await requestText(url, { Referer: SITE + '/' }, 15000);
    if (!res.status || looksBlockedPage(res.text)) {
      throw new Error('AnimeAV1 episode page is unavailable');
    }

    const requestedVariant = String(lang || '').toLowerCase() === 'dub' ? 'DUB' : 'SUB';
    const embeds = parseEmbeds(res.text);
    const variantEmbeds = embeds[requestedVariant] || [];
    // Outage-resilient backbones (SUB only): the Vidhawk provider and the AniKage rescue fire
    // CONCURRENTLY with the site hosts, so a dead host set can never dead-end a play. Both
    // publish through plain polled fields (the app JS engine does not reliably run reactions
    // chained onto already-settled promises) and both are deadline-bound like every request.
    const backboneDeadline = Date.now() + 12000;
    let vidhawkHalt = null;
    let rescueHalt = null;
    if (requestedVariant === 'SUB') {
      const slugTitle = (url.match(/\/media\/([^/?#]+)/) || [])[1] || '';
      const epNum = (url.match(/\/media\/[^/?#]+\/([\d.]+)/) || [])[1] || '1';
      const wantedTitle = titleFromSlug(slugTitle) || slugTitle.replace(/-/g, ' ');
      const anilistPromise = resolveAniListId(wantedTitle);
      vidhawkHalt = { done: false, result: null };
      rescueHalt = { closed: false, done: false, result: null, deadline: backboneDeadline };
      (async function () {
        try {
          const anilistId = await anilistPromise;
          if (anilistId) vidhawkHalt.result = (await fetchVidhawkRoutes(anilistId, epNum, backboneDeadline)) || [];
        } catch (_) {}
        vidhawkHalt.done = true;
      })();
      (async function () {
        try {
          const anilistId = await anilistPromise;
          await rescueAnikageRoutes(
            { anilistId: anilistId || '', episode: epNum, title: wantedTitle },
            'sub',
            rescueHalt,
          );
        } catch (_) {
          rescueHalt.done = true;
        }
      })();
    }
    const resolved = variantEmbeds.length ? await resolveEmbeds(variantEmbeds, requestedVariant) : [];
    let all = resolved;
    if (requestedVariant === 'SUB' && vidhawkHalt && rescueHalt) {
      const seenRoute = Object.create(null);
      all.forEach(function (row) { if (row && row.url) seenRoute[row.url] = true; });
      if (all.length) {
        // Site hosts delivered: halt the AniKage rescue (doctrine: the rescue engages only when
        // the last mile is empty) and capture any Vidhawk extras verified within a short grace.
        rescueHalt.closed = true;
        const graceDeadline = Math.min(Date.now() + 2500, backboneDeadline);
        while (!vidhawkHalt.done && Date.now() < graceDeadline) await rescueSleep(150);
        const extras = (vidhawkHalt.result || []).filter(function (row) { return row && row.url && !seenRoute[row.url]; });
        if (extras.length) log('vidhawk: +' + extras.length + ' extra route(s)');
        all = all.concat(extras);
      } else {
        // Nothing from the site hosts: wait out both backbones until one delivers (+ a short
        // grace for the sibling) or the shared budget expires. Empty stays an honest no-stream.
        let firstDelivery = 0;
        while (Date.now() < backboneDeadline) {
          const haveAny = (vidhawkHalt.result && vidhawkHalt.result.length) || (rescueHalt.result && rescueHalt.result.length);
          if (haveAny && !firstDelivery) firstDelivery = Date.now();
          if (haveAny && Date.now() - firstDelivery >= 2200) break;
          if (vidhawkHalt.done && rescueHalt.done) break;
          await rescueSleep(150);
        }
        (vidhawkHalt.result || []).concat(rescueHalt.result || []).forEach(function (row) {
          if (row && row.url && !seenRoute[row.url]) { seenRoute[row.url] = true; all.push(row); }
        });
        if (all.length) log('backbones: recovered ' + all.length + ' route(s)');
      }
    }
    if (!all.length) {
      throw new Error('AnimeAV1 ' + requestedVariant + (variantEmbeds.length ? ' hosts could not provide verified media' : ' is not available for this episode'));
    }

    const primary = all[0];
    return {
      url: primary.url,
      stream: primary.url,
      streams: [primary.label, primary.url],
      qualities: primary.qualities,
      servers: all,
      headers: primary.headers,
      quality: primary.label,
      lang: requestedVariant === 'DUB' ? 'dub' : 'sub',
      streamType: primary.streamType,
      subtitles: primary.subtitles,
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
