(() => {
  'use strict';

  const MODULE_NAME = 'Ev01';
  const SITE = 'https://ev01.ws';
  const DULO_API = 'https://dulo.tv/api';
  const SECONDARY_SITE = 'https://www.lookmovie2.to';
  // Site embeds Videasy (player.videasy.net) for free multi-quality HLS incl. 1080/4K.
  const VIDEASY_API = 'https://api.speedracelight.com';
  const VIDEASY_PLAYER = 'https://player.videasy.to';
  // Server-side Wyzie proxy (keys never ship in the module).
  const SUBS_API = 'https://one.synthetiq.uk/v1/subs';
  // Embedded in dulo.tv's public player bundle; required by its API.
  const DULO_API_KEY = 'WDNUNBUB3HR983Y9ISBADK4O82';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  const RESOLVER_DEADLINE_MS = 16000;
  const VERIFY_TIMEOUT_MS = 3500;
  const VERIFY_RECOVERY_TIMEOUT_MS = 6500;
  const videasySeedCache = Object.create(null);
  const VIDEASY_MAGIC = [0x6d, 0x76, 0x6d, 0x31]; // mvm1

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
    return Promise.race([promise, sleep(waitMs).then(() => fallback)]);
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function toAbsoluteUrl(value, base) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return 'https:' + raw;
    const root = base || SITE;
    if (raw.startsWith('/')) return root + raw;
    return root + '/' + raw;
  }

  function searchTerms(query) {
    const raw = cleanText(query);
    const normalized = cleanText(raw.replace(/[^a-zA-Z0-9\s]/g, ' '));
    const withoutArticle = cleanText(normalized.replace(/^(?:the|an|a)\s+/i, ''));
    const out = [];
    for (const term of [raw, normalized, withoutArticle]) {
      if (term && !out.some((item) => item.toLowerCase() === term.toLowerCase())) out.push(term);
    }
    return out;
  }

  async function requestText(url, extraHeaders, timeoutMs) {
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      extraHeaders || {},
    );
    const doFetch = async () => {
      let res = null;
      if (typeof fetchv2 === 'function') {
        res = await fetchv2(url, headers, 'GET', null);
      } else if (typeof fetch === 'function') {
        res = await fetch(url, { headers });
      }
      const status = Number((res && res.status) || 0);
      if (!res || (status && status >= 400)) {
        throw new Error('Request failed ' + (status || '') + ' for ' + url);
      }
      let text = '';
      if (res && typeof res.text === 'function') text = await res.text();
      if (!text && res && typeof res.body === 'string') text = res.body;
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (_) {}
      }
      if (json == null && res && typeof res.json === 'function') {
        try {
          json = await res.json();
        } catch (_) {}
      }
      return { status, text, json };
    };
    if (timeoutMs) {
      return settleWithin(doFetch(), timeoutMs, { status: 0, text: '', json: null });
    }
    return doFetch();
  }

  /* ------------------------------ catalogue ------------------------------ */

  function looksBlockedPage(html) {
    return /domain has been seized|attention required|just a moment|parked domain|domain is for sale/i.test(
      String(html || ''),
    );
  }

  function parseCards(html) {
    const out = [];
    const seen = Object.create(null);
    const cardRe =
      /<a class="bf-card"[^>]*href="(\/watch\/((?:movie|tv))-[^"]+)"[^>]*title="([^"]+)"[\s\S]*?<img[^>]*src="([^"]+)"/gi;
    let match;
    while ((match = cardRe.exec(String(html || '')))) {
      const href = toAbsoluteUrl(match[1]);
      const mediaType = match[2].toLowerCase() === 'tv' ? 'tv' : 'movie';
      const title = cleanText(match[3]);
      const image = String(match[4] || '').trim();
      if (!href || !title || seen[href]) continue;
      seen[href] = true;
      out.push({
        title,
        href,
        image: image || SITE + '/assets/brands/ev01/favicon.png',
        mediaType,
      });
    }
    return out;
  }

  function parseTmdbFromEmbed(html, mediaType) {
    const raw = String(html || '');
    let match = raw.match(/embed\/movie\/(\d+)/i);
    if (match) return { type: 'movie', tmdb: Number(match[1]) };
    match = raw.match(/embed\/tv\/(\d+)(?:\/(\d+)\/(\d+))?/i);
    if (match) {
      return {
        type: 'tv',
        tmdb: Number(match[1]),
        season: match[2] ? Number(match[2]) : 1,
        episode: match[3] ? Number(match[3]) : 1,
      };
    }
    return mediaType === 'tv' ? { type: 'tv', tmdb: 0 } : null;
  }

  function parseJsonLd(html) {
    const blocks = String(html || '').match(
      /<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi,
    );
    for (const block of blocks || []) {
      const body = block
        .replace(/^<script[^>]*>/i, '')
        .replace(/<\/script>$/i, '');
      try {
        const json = JSON.parse(body);
        if (json && (json['@type'] === 'Movie' || json['@type'] === 'TVSeries')) {
          return json;
        }
      } catch (_) {}
    }
    return null;
  }

  function parseSeasonPills(html) {
    const seasons = [];
    const re = /class="season-pill[^"]*"[^>]*href="[^"]*[?&]s=(\d+)[^"]*"/gi;
    let match;
    const seen = Object.create(null);
    while ((match = re.exec(String(html || '')))) {
      const season = Number(match[1]);
      if (season > 0 && !seen[season]) {
        seen[season] = true;
        seasons.push(season);
      }
    }
    return seasons.sort((a, b) => a - b);
  }

  function parseEpisodeTiles(html, season) {
    const out = [];
    const re =
      /<a href="[^"]*[?&]s=(\d+)&(?:amp;)?e=(\d+)"[^>]*class="ep-tile([^"]*)"[^>]*title="([^"]*)"/gi;
    let match;
    while ((match = re.exec(String(html || '')))) {
      const s = Number(match[1]);
      const e = Number(match[2]);
      if (s !== season || e <= 0) continue;
      const flags = String(match[3] || '');
      const title = cleanText(String(match[4] || '').replace(/\s*\((?:trailer only|coming soon)\)\s*$/i, ''));
      out.push({
        season: s,
        number: e,
        title: title || 'Episode ' + e,
        trailerOnly: /coming|trailer/i.test(flags),
      });
    }
    return out;
  }

  function parseWatchRef(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    let match = raw.match(/^ev01:(movie|tv):(\d+)(?::(\d+):(\d+))?(?::(.+))?$/i);
    if (match) {
      let hint = '';
      try {
        hint = match[5] ? decodeURIComponent(match[5]) : '';
      } catch (_) {
        hint = match[5] || '';
      }
      return {
        type: match[1].toLowerCase(),
        tmdb: Number(match[2]),
        season: match[3] ? Number(match[3]) : null,
        episode: match[4] ? Number(match[4]) : null,
        hint,
      };
    }
    match = raw.match(/\/watch\/(movie|tv)-([^/?#]+)/i);
    if (match) {
      return { type: match[1].toLowerCase(), slug: match[2], url: toAbsoluteUrl(raw, SITE) };
    }
    return null;
  }

  async function searchResults(query) {
    const term = String(query == null ? '' : query).trim();
    // Empty query powers the legacy home: the curated Top IMDB browse page.
    const terms = term ? searchTerms(term) : [''];
    const out = [];
    const seen = Object.create(null);
    for (const candidate of terms) {
      const url = candidate
        ? SITE + '/browser?keyword=' + encodeURIComponent(candidate)
        : SITE + '/top-imdb';
      const res = await requestText(url, { Referer: SITE + '/' }, 15000);
      if (looksBlockedPage(res.text)) {
        log('catalogue page blocked (seizure/park/challenge notice)');
        return [];
      }
      for (const card of parseCards(res.text)) {
        if (seen[card.href]) continue;
        seen[card.href] = true;
        out.push({ title: card.title, href: card.href, image: card.image });
      }
      if (out.length) break;
    }
    return out;
  }

  async function loadWatchPage(ref) {
    const res = await requestText(ref.url, { Referer: SITE + '/' }, 15000);
    if (looksBlockedPage(res.text)) throw new Error('Ev01 page is blocked.');
    return res.text;
  }

  async function resolveSeriesRef(input) {
    const parsed = parseWatchRef(input);
    if (!parsed) throw new Error('Ev01 reference is invalid.');
    if (parsed.tmdb) return parsed;

    const html = await loadWatchPage({ url: parsed.url });
    const embed = parseTmdbFromEmbed(html, parsed.type);
    if (!embed || !embed.tmdb) throw new Error('No playable id found on the Ev01 page.');
    const ld = parseJsonLd(html) || {};
    return {
      type: parsed.type,
      tmdb: embed.tmdb,
      season: embed.season || 1,
      episode: embed.episode || 1,
      title: cleanText(ld.name || ''),
      description: cleanText(ld.description || ''),
      image:
        String(ld.image || '').trim() ||
        (String(html).match(/image\.tmdb\.org\/t\/p\/w\d+[^'" )]+/i)
          ? 'https://image.tmdb.org/t/p/w342' +
            String(html).match(/image\.tmdb\.org\/t\/p\/w\d+([^'" )]+)/i)[1]
          : ''),
    };
  }

  async function extractDetails(urlOrId) {
    const series = await resolveSeriesRef(urlOrId);
    return {
      title: series.title || (series.type === 'tv' ? 'TV Series' : 'Movie'),
      description:
        series.description ||
        (series.type === 'tv'
          ? 'TV series on Ev01.'
          : 'Movie on Ev01.'),
      image: series.image || SITE + '/assets/brands/ev01/favicon.png',
    };
  }

  async function extractEpisodes(seriesId) {
    const parsed = parseWatchRef(seriesId);
    if (!parsed) return [];
    if (parsed.tmdb && parsed.type === 'movie') {
      return [
        {
          number: 1,
          href: 'ev01:movie:' + parsed.tmdb + (parsed.hint ? ':' + encodeURIComponent(parsed.hint) : ''),
          title: 'Movie',
          isMovie: true,
          mediaType: 'movie',
          subAvailable: true,
          dubAvailable: false,
        },
      ];
    }
    if (parsed.tmdb && parsed.type === 'tv' && parsed.season && parsed.episode) {
      return [
        {
          number: parsed.episode,
          season: parsed.season,
          href:
            'ev01:tv:' + parsed.tmdb + ':' + parsed.season + ':' + parsed.episode +
            (parsed.hint ? ':' + encodeURIComponent(parsed.hint) : ''),
          title: 'Episode ' + parsed.episode,
          subAvailable: true,
          dubAvailable: false,
        },
      ];
    }

    // Full listing: fetch each season page and enumerate episode tiles.
    const html = await loadWatchPage({ url: parsed.url });
    const embed = parseTmdbFromEmbed(html, parsed.type);
    if (!embed || !embed.tmdb) return [];
    const ld = parseJsonLd(html) || {};
    const hint = cleanText(ld.name || parsed.slug || '');
    const encodedHint = hint ? ':' + encodeURIComponent(hint) : '';
    if (parsed.type === 'movie') {
      return [
        {
          number: 1,
          href: 'ev01:movie:' + embed.tmdb + encodedHint,
          title: 'Movie',
          isMovie: true,
          mediaType: 'movie',
          subAvailable: true,
          dubAvailable: false,
        },
      ];
    }
    let seasons = parseSeasonPills(html);
    if (!seasons.length) seasons = [embed.season || 1];

    const episodes = [];
    for (const season of seasons) {
      let seasonHtml = html;
      if (season !== (embed.season || 1)) {
        try {
          const url = parsed.url +
            (parsed.url.indexOf('?') >= 0 ? '&' : '?') + 's=' + season + '&e=1';
          const res = await requestText(url, { Referer: parsed.url }, 15000);
          if (res.text) seasonHtml = res.text;
        } catch (error) {
          log('season ' + season + ' page failed: ' + (error && error.message ? error.message : error));
          continue;
        }
      }
      for (const tile of parseEpisodeTiles(seasonHtml, season)) {
        episodes.push({
          number: tile.number,
          season: tile.season,
          href: 'ev01:tv:' + embed.tmdb + ':' + tile.season + ':' + tile.number + encodedHint,
          title: tile.title,
          trailerOnly: tile.trailerOnly === true,
          subAvailable: true,
          dubAvailable: false,
        });
      }
    }
    episodes.sort((a, b) => a.season - b.season || a.number - b.number);
    return episodes;
  }

  /* --------------------- authorized secondary adapter -------------------- */

  const secondaryHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json,text/html,*/*',
    Origin: SECONDARY_SITE,
    Referer: SECONDARY_SITE + '/',
  };

  async function secondaryRequest(path, xhr) {
    const headers = Object.assign({}, secondaryHeaders);
    if (xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
    return requestText(toAbsoluteUrl(path, SECONDARY_SITE), headers, 12000);
  }

  function secondaryRows(payload) {
    return Array.isArray(payload && payload.result) ? payload.result : [];
  }

  function secondaryTitle(value) {
    return cleanText(String(value || '').replace(/\s+-\s+Season\s+\d+\s*$/i, ''));
  }

  function titleScore(query, title) {
    const q = secondaryTitle(query).toLowerCase();
    const t = secondaryTitle(title).toLowerCase();
    if (!q || !t) return 0;
    if (q === t) return 1000;
    if (t.indexOf(q) === 0 || q.indexOf(t) === 0) return 500;
    if (t.indexOf(q) >= 0 || q.indexOf(t) >= 0) return 250;
    const words = q.split(/\s+/).filter(Boolean);
    let matches = 0;
    for (const word of words) if (t.indexOf(word) >= 0) matches += 1;
    return matches * 25;
  }

  async function findSecondaryTitle(ref) {
    const query = secondaryTitle(ref.hint || '');
    if (!query) return null;
    const path = ref.type === 'tv'
      ? '/api/v1/shows/do-search/?q='
      : '/api/v1/movies/do-search/?q=';
    let rows = [];
    for (const term of searchTerms(query)) {
      const res = await secondaryRequest(path + encodeURIComponent(term), true);
      rows = rows.concat(secondaryRows(res.json));
      if (rows.length) break;
    }
    rows.sort((a, b) => titleScore(query, b.title) - titleScore(query, a.title));
    const hit = rows[0];
    if (!hit || titleScore(query, hit.title) < 250) return null;
    if (ref.type === 'tv') {
      return {
        id: Number(hit.id_show || 0),
        slug: String(hit.slug || ''),
        title: cleanText(hit.title || ''),
      };
    }
    return {
      id: Number(hit.id_movie || 0),
      slug: String(hit.slug || ''),
      title: cleanText(hit.title || ''),
    };
  }

  function secondaryPlayPath(html, type) {
    const pattern = type === 'tv'
      ? /href="(\/shows\/play\/[^"]+)"/i
      : /href="(\/movies\/play\/[^"]+)"/i;
    const match = String(html || '').match(pattern);
    return match ? match[1] : '';
  }

  function secondaryAccessFields(html) {
    const text = String(html || '');
    const idMovie = text.match(/id_movie:\s*(\d+)/);
    const idShow = text.match(/id_show:\s*(\d+)/);
    const hash = text.match(/hash:\s*['"]([^'"]+)['"]/);
    const expires = text.match(/expires:\s*(\d+)/);
    return {
      movieId: idMovie ? Number(idMovie[1]) : 0,
      showId: idShow ? Number(idShow[1]) : 0,
      hash: hash ? hash[1] : '',
      expires: expires ? expires[1] : '',
    };
  }

  async function secondaryPlayFields(ref, hit) {
    const viewPath = ref.type === 'tv'
      ? '/shows/view/' + encodeURIComponent(hit.slug || hit.id)
      : '/movies/view/' + encodeURIComponent(hit.slug || hit.id);
    const view = await secondaryRequest(viewPath, false);
    const playPath = secondaryPlayPath(view.text, ref.type);
    if (!playPath) return null;
    const play = await secondaryRequest(playPath, false);
    const fields = secondaryAccessFields(play.text);
    if (!fields.hash || !fields.expires) return null;
    return fields;
  }

  async function secondaryEpisodeId(showId, season, episode) {
    const res = await secondaryRequest(
      '/api/v2/download/episode/list?id=' + encodeURIComponent(String(showId)),
      true,
    );
    const list = (res.json && res.json.list) || {};
    const row = list[String(season)] && list[String(season)][String(episode)];
    return Number((row && (row.id_episode || row.id)) || 0);
  }

  function secondarySources(payload) {
    const streams = (payload && payload.streams) || {};
    const out = [];
    for (const key of Object.keys(streams)) {
      const url = String(streams[key] || '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      out.push({
        title: 'Secondary',
        quality: /p$/i.test(key) ? key : key + 'p',
        type: 'hls',
        url,
        headers: Object.assign({}, secondaryHeaders, {
          Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
        }),
      });
    }
    out.sort((a, b) => {
      const aq = Number((String(a.quality).match(/\d+/) || [0])[0]);
      const bq = Number((String(b.quality).match(/\d+/) || [0])[0]);
      return bq - aq;
    });
    return out;
  }

  async function resolveSecondaryStream(ref) {
    const hit = await findSecondaryTitle(ref);
    if (!hit || !hit.id) return [];
    const fields = await secondaryPlayFields(ref, hit);
    if (!fields) return [];
    let path = '';
    if (ref.type === 'tv') {
      const episodeId = await secondaryEpisodeId(
        hit.id,
        ref.season || 1,
        ref.episode || 1,
      );
      if (!episodeId) return [];
      path =
        '/api/v1/security/episode-access?id_episode=' + encodeURIComponent(String(episodeId)) +
        '&hash=' + encodeURIComponent(fields.hash) +
        '&expires=' + encodeURIComponent(fields.expires);
    } else {
      path =
        '/api/v1/security/movie-access?id_movie=' +
        encodeURIComponent(String(fields.movieId || hit.id)) +
        '&hash=' + encodeURIComponent(fields.hash) +
        '&expires=' + encodeURIComponent(fields.expires);
    }
    const access = await secondaryRequest(path, true);
    if (!access.json || access.json.success !== true) return [];
    const candidates = secondarySources(access.json);
    for (const source of candidates.slice(0, 3)) {
      const check = await settleWithin(
        softVerifySource(source),
        VERIFY_RECOVERY_TIMEOUT_MS,
        { ok: false, source, reason: 'verify_timeout' },
      );
      if (check.ok && check.source.deepVerified) {
        log('secondary route verified for ' + hit.title);
        return [check.source];
      }
    }
    return [];
  }

  function firstNonEmpty(promises) {
    return new Promise((resolve) => {
      let remaining = promises.length;
      let settled = false;
      if (!remaining) return resolve([]);
      for (const promise of promises) {
        Promise.resolve(promise)
          .then((value) => {
            if (settled) return;
            if (Array.isArray(value) && value.length) {
              settled = true;
              resolve(value);
              return;
            }
            remaining -= 1;
            if (!remaining) resolve([]);
          })
          .catch(() => {
            remaining -= 1;
            if (!settled && !remaining) resolve([]);
          });
      }
    });
  }

  /* ------------------------- Videasy (site Server 1 HD) --------------------- */
  // Same free path as X-Stream: seed + enc payload from api.speedracelight.com.
  // Gives real 480–2160 HLS without Dulo (DNS-dead) or LookMovie fallbacks.

  function videasyHeaders() {
    return {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      Origin: VIDEASY_PLAYER,
      Referer: VIDEASY_PLAYER + '/',
    };
  }

  function videasyStreamHeaders() {
    return {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
      Origin: VIDEASY_PLAYER,
      Referer: VIDEASY_PLAYER + '/',
    };
  }

  function videasyImul(a, b) {
    if (typeof Math.imul === 'function') return Math.imul(a, b) >>> 0;
    a = a >>> 0;
    b = b >>> 0;
    const ah = (a >>> 16) & 0xffff;
    const al = a & 0xffff;
    const bh = (b >>> 16) & 0xffff;
    const bl = b & 0xffff;
    return ((al * bl + (((ah * bl + al * bh) << 16) >>> 0)) >>> 0) >>> 0;
  }

  function videasyU32(x) {
    return x >>> 0;
  }

  function videasyMix(e) {
    e = videasyU32(e);
    e ^= e >>> 16;
    e = videasyImul(e, 2246822507);
    e ^= e >>> 13;
    e = videasyImul(e, 3266489909);
    e ^= e >>> 16;
    return videasyU32(e);
  }

  function videasyRotl(e, t) {
    e = videasyU32(e);
    t &= 31;
    if (t === 0) return e;
    return videasyU32((e << t) | (e >>> (32 - t)));
  }

  function videasyB64Decode(input) {
    // Match X-Stream's decoder exactly (url-safe base64, ignore whitespace).
    const s = String(input || '')
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/\s+/g, '');
    const pad = s.length % 4 === 0 ? s : s + '===='.slice(s.length % 4);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const out = [];
    let buf = 0;
    let bits = 0;
    for (let i = 0; i < pad.length; i++) {
      const ch = pad.charAt(i);
      if (ch === '=') break;
      const v = alphabet.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >>> bits) & 0xff);
      }
    }
    return out;
  }

  function videasyUtf8Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; ) {
      const c = bytes[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xe0) {
        const c2 = bytes[i++];
        out += String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f));
      } else if (c < 0xf0) {
        const c2 = bytes[i++];
        const c3 = bytes[i++];
        out += String.fromCharCode(((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f));
      } else {
        const c2 = bytes[i++];
        const c3 = bytes[i++];
        const c4 = bytes[i++];
        let cp = ((c & 7) << 18) | ((c2 & 0x3f) << 12) | ((c3 & 0x3f) << 6) | (c4 & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  function videasyKeystate(seed, mediaId) {
    const seedStr = String(seed || '');
    const tNum = Number(mediaId) || 0;
    const S = Object.create(null);
    let fnv = 2166136261;
    for (let i = 0; i < seedStr.length; i++) {
      fnv = videasyImul(fnv ^ seedStr.charCodeAt(i), 16777619);
    }
    let a = videasyMix(videasyMix(fnv) ^ videasyMix(videasyU32(tNum) ^ 2654435769));
    for (let e = 0; e < 8; e++) {
      const tSlot = a % 61;
      a = videasyRotl(videasyU32(a + 2654435769), 7 + (7 & e));
      S[tSlot] = videasyU32(a ^ videasyMix(a));
      a = videasyMix(videasyU32(a + tSlot));
    }
    return { S: S, acc: videasyMix(videasyU32(2779096485 ^ a)) };
  }

  function videasyNextWord(state, tCounter) {
    const r = state.S;
    let o = state.acc;
    const n = o % 61;
    const present = Object.prototype.hasOwnProperty.call(r, n);
    // present => 0xffffffff (-1 as u32); absent => 0. Must match X-Stream / Videasy.
    const iMask = present ? 0xffffffff : 0;
    const l = present ? videasyU32(r[n]) : 0;
    const aVal = videasyU32(l ^ videasyImul(2654435769, tCounter + 1));
    const s = o;
    let d = videasyU32(videasyU32(s ^ aVal) | videasyU32(s & aVal & iMask));
    d = videasyU32(videasyRotl(videasyU32(d + o), 31 & n) ^ videasyRotl(o, 31 & videasyImul(n, 7)));
    o = videasyMix(videasyU32(d + 2654435769));
    r[n] = o;
    state.acc = o;
    return o;
  }

  function videasyKeystream(seed, mediaId, length) {
    const state = videasyKeystate(seed, mediaId);
    const out = new Array(length);
    let o = 0;
    let e = 0;
    while (e < length) {
      const t = videasyNextWord(state, o++);
      out[e++] = t & 255;
      if (e < length) out[e++] = (t >>> 8) & 255;
      if (e < length) out[e++] = (t >>> 16) & 255;
      if (e < length) out[e++] = (t >>> 24) & 255;
    }
    return out;
  }

  function videasyDecrypt(payload, seed, mediaId) {
    const raw = videasyB64Decode(String(payload || '').trim().replace(/^"|"$/g, ''));
    if (!raw.length) throw new Error('videasy empty payload');
    const ks = videasyKeystream(seed, mediaId, raw.length);
    const plain = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) plain[i] = (raw[i] ^ ks[i]) & 255;
    for (let i = 0; i < 4; i++) {
      if (plain[i] !== VIDEASY_MAGIC[i]) throw new Error('videasy decrypt magic mismatch');
    }
    return videasyUtf8Decode(plain.slice(4));
  }

  async function videasyGetSeed(mediaId) {
    const id = String(mediaId || '');
    const hit = videasySeedCache[id];
    if (hit && hit.expiresAt > Date.now()) return hit.seed;
    let lastErr = 'videasy seed missing';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(400 * attempt);
      const res = await requestText(
        VIDEASY_API + '/seed?mediaId=' + encodeURIComponent(id),
        videasyHeaders(),
        10000,
      );
      if (!res || !res.text) {
        lastErr = 'videasy seed empty';
        continue;
      }
      let json = res.json;
      if (!json) {
        try {
          json = JSON.parse(res.text);
        } catch (_) {
          lastErr = 'videasy seed parse fail';
          continue;
        }
      }
      if (!json || !json.seed) {
        lastErr = 'videasy seed missing';
        continue;
      }
      const ttl = Math.max(5000, Number(json.ttlMs) || 30000);
      videasySeedCache[id] = { seed: json.seed, expiresAt: Date.now() + ttl };
      return json.seed;
    }
    throw new Error(lastErr);
  }

  function videasyHeightFromQuality(q) {
    const raw = String(q || '').toLowerCase();
    if (/2160|4k|uhd/.test(raw)) return 2160;
    if (/1080|fhd|full\s*hd/.test(raw)) return 1080;
    if (/720|hd/.test(raw)) return 720;
    if (/480|sd/.test(raw)) return 480;
    if (/360/.test(raw)) return 360;
    const m = raw.match(/(\d{3,4})\s*p?/);
    return m ? Number(m[1]) : 0;
  }

  function videasyBuildQuery(params) {
    const parts = [];
    const keys = Object.keys(params || {});
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = params[k];
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.join('&');
  }

  function mapVideasySubtitles(rawList) {
    const out = [];
    const seen = Object.create(null);
    const rows = Array.isArray(rawList) ? rawList : [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row !== 'object') continue;
      const file = String(row.url || row.file || row.src || '').trim();
      if (!file || file.indexOf('http') !== 0) continue;
      if (/\/thumbs?\/|sprite|thumbnail/i.test(file)) continue;
      if (seen[file]) continue;
      seen[file] = true;
      const lang = cleanText(row.lang || row.language || row.srclang || row.label || 'und') || 'und';
      const label = cleanText(row.label || row.language || row.lang || lang) || lang;
      const normalizedLanguage = String(lang + ' ' + label).toLowerCase();
      if (!/(^|[^a-z])(en|eng|english)([^a-z]|$)/.test(normalizedLanguage)) {
        continue;
      }
      out.push({
        label: label || 'English',
        language: 'en',
        lang: 'en',
        url: file,
        file: file,
        kind: 'captions',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/vtt,text/plain,application/x-subrip,*/*',
          Origin: VIDEASY_PLAYER,
          Referer: VIDEASY_PLAYER + '/',
        },
      });
    }
    return out;
  }

  function mergeSubtitles(into, extra) {
    const seen = Object.create(null);
    const out = [];
    const all = (Array.isArray(into) ? into : []).concat(Array.isArray(extra) ? extra : []);
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      if (!s || !s.url) continue;
      const key = String(s.url).split('?')[0];
      if (seen[key]) continue;
      seen[key] = true;
      out.push(s);
    }
    return out;
  }

  async function fetchSynthetiqSubs(tmdbId, season, episode) {
    const id = String(tmdbId || '').trim();
    if (!id) return [];
    try {
      const params = { id: id, language: 'en', format: 'srt' };
      if (season != null && Number(season) > 0) params.season = Number(season);
      if (episode != null && Number(episode) > 0) params.episode = Number(episode);
      const url = SUBS_API + '?' + videasyBuildQuery(params);
      const res = await settleWithin(requestText(url, { Accept: 'application/json' }, 8000), 8000, null);
      if (!res || !res.text) return [];
      let data = res.json;
      if (typeof data === 'function') {
        try {
          data = await data();
        } catch (_) {
          data = null;
        }
      }
      if (!data) {
        try {
          data = JSON.parse(res.text);
        } catch (_) {
          return [];
        }
      }
      return mapVideasySubtitles((data && data.subtitles) || []).slice(0, 20);
    } catch (e) {
      log('subs proxy fail: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  async function videasyFetchEndpoint(path, params, mediaId, seed) {
    const empty = { streams: [], subtitles: [] };
    const url = VIDEASY_API + path + '?' + videasyBuildQuery(params);
    const res = await requestText(url, videasyHeaders(), 14000);
    if (!res || !res.text) return empty;
    let plain = '';
    try {
      plain = videasyDecrypt(res.text, seed, mediaId);
    } catch (e) {
      log('videasy decrypt fail ' + path + ': ' + (e && e.message ? e.message : e));
      return empty;
    }
    let data = null;
    try {
      data = JSON.parse(plain);
    } catch (_) {
      return empty;
    }
    const sources = (data && data.sources) || [];
    const out = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      if (!src || !src.url || String(src.url).indexOf('http') !== 0) continue;
      const urlStr = String(src.url);
      if (/\.mpd(\?|$)/i.test(urlStr) || /type=dash/i.test(urlStr) || String(src.type || '').toLowerCase() === 'dash') {
        continue;
      }
      const height = videasyHeightFromQuality(src.quality || src.label || urlStr);
      const labelH = height >= 360 ? height + 'p' : cleanText(src.quality || 'Auto') || 'Auto';
      const isHls =
        /\.m3u8(\?|$)/i.test(urlStr) ||
        /type=m3u8/i.test(urlStr) ||
        String(src.type || '').toLowerCase() === 'm3u8' ||
        String(src.type || '').toLowerCase() === 'hls';
      out.push({
        title: 'Videasy ' + labelH + (isHls ? ' HLS' : ''),
        quality: height >= 360 ? height + 'p' : labelH,
        type: isHls ? 'hls' : 'mp4',
        url: urlStr,
        headers: videasyStreamHeaders(),
        provider: 'videasy',
        height: height || 0,
        playableVerified: true,
        deepVerified: true,
      });
    }
    const subs = mapVideasySubtitles(
      (data && (data.subtitles || data.subs || data.tracks || data.captions)) || [],
    );
    return { streams: out, subtitles: subs };
  }

  async function resolveVideasy(ref) {
    try {
      const mediaId = String(ref.tmdb || '');
      if (!mediaId) return { streams: [], subtitles: [] };
      const title = cleanText(ref.hint || ref.title || '') || mediaId;
      const seed = await videasyGetSeed(mediaId);
      const base = {
        title: title,
        mediaType: ref.type === 'tv' ? 'tv' : 'movie',
        tmdbId: mediaId,
        imdbId: '',
        enc: '2',
        seed: seed,
      };
      if (ref.year) base.year = Number(ref.year);
      if (ref.type === 'tv') {
        base.seasonId = Number(ref.season || 1);
        base.episodeId = Number(ref.episode || 1);
        base.totalSeasons = Number(ref.season || 1);
      }
      const endpoints = [
        '/cdn/sources-with-title',
        '/m4uhd/sources-with-title',
        '/lamovie/sources-with-title',
      ];
      const collected = [];
      let subtitles = [];
      const seen = Object.create(null);
      for (let i = 0; i < endpoints.length; i++) {
        const pack = await settleWithin(
          videasyFetchEndpoint(endpoints[i], base, mediaId, seed),
          12000,
          { streams: [], subtitles: [] },
        );
        const rows = (pack && pack.streams) || [];
        subtitles = mergeSubtitles(subtitles, (pack && pack.subtitles) || []);
        for (let j = 0; j < rows.length; j++) {
          const s = rows[j];
          if (!s || !s.url) continue;
          const key = String(s.url).split('?')[0];
          if (seen[key]) continue;
          seen[key] = true;
          collected.push(s);
        }
        const hasHd = collected.some(function (s) {
          return (Number(s.height) || 0) >= 1080;
        });
        const has4k = collected.some(function (s) {
          return (Number(s.height) || 0) >= 2160;
        });
        if (has4k && i >= 1) break;
        if (hasHd && i >= 1 && subtitles.length) break;
      }
      // Prefer 1080 as primary (reliable default); still expose 4K in the list.
      collected.sort(function (a, b) {
        function score(s) {
          const h = Number(s.height) || 0;
          // Fixed tiers so 1080 always wins over 4K for auto-play.
          if (h === 1080) return 50000;
          if (h >= 2160) return 40000 + h;
          if (h === 720) return 30000 + h;
          if (h === 480) return 20000 + h;
          if (h > 0) return 10000 + h;
          return 0;
        }
        return score(b) - score(a);
      });
      if (collected.length) {
        log(
          'videasy ' +
            mediaId +
            ' qualities=' +
            collected
              .map(function (s) {
                return (s.height || 0) + 'p';
              })
              .join(',') +
            ' subs=' +
            subtitles.length,
        );
      } else {
        log('videasy no sources for ' + mediaId);
      }
      return { streams: collected, subtitles: subtitles };
    } catch (e) {
      log('videasy fail: ' + (e && e.message ? e.message : e));
      return { streams: [], subtitles: [] };
    }
  }

  /* ------------------------- dulo.tv stream resolver ------------------------ */
  // Fallback when Videasy misses. dulo.tv public resolver uses the same TMDB
  // ids. Header policy, one-shot token protection, and worker deep-verification
  // mirror the proven Dulo rules. Note: dulo DNS is often dead.

  const duloHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json,text/plain,*/*',
    Origin: 'https://dulo.tv',
    Referer: 'https://dulo.tv/',
    'X-API-Key': DULO_API_KEY,
    Authorization: 'Bearer ' + DULO_API_KEY,
  };

  let sessionReady = false;
  const cookieJar = {};

  function storeCookies(res) {
    const headers = (res && res.headers) || {};
    let raw = headers['set-cookie'] || headers['Set-Cookie'];
    if (!raw && typeof headers.get === 'function') {
      // node-fetch Headers instance (test harnesses): plain reads miss it.
      raw = headers.get('set-cookie');
      if (!raw && typeof headers.raw === 'function') {
        const rawHeaders = headers.raw();
        if (rawHeaders && rawHeaders['set-cookie']) raw = rawHeaders['set-cookie'];
      }
    }
    if (!raw) return;
    const lines = Array.isArray(raw) ? raw : [raw];
    for (const line of lines) {
      const part = String(line || '').split(';')[0];
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      cookieJar[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }

  function cookieHeader() {
    return Object.keys(cookieJar)
      .map((key) => key + '=' + cookieJar[key])
      .join('; ');
  }

  function sourceHost(url) {
    const match = String(url || '').match(/^https?:\/\/([^/]+)/i);
    return match ? String(match[1]).toLowerCase() : '';
  }

  function isDuloOwnedHost(url) {
    const host = sourceHost(url);
    return (
      host === 'dulo.tv' ||
      host.endsWith('.dulo.tv') ||
      host === 'dulo.cc' ||
      host.endsWith('.dulo.cc')
    );
  }

  async function duloRequest(url, options) {
    const cfg = options || {};
    const duloOwned = isDuloOwnedHost(url);
    const headers = duloOwned
      ? Object.assign({}, duloHeaders, cfg.headers || {})
      : Object.assign(
          {
            'User-Agent': USER_AGENT,
            Accept: 'video/mp4,video/*;q=0.9,application/vnd.apple.mpegurl,*/*;q=0.8',
          },
          cfg.headers || {},
        );
    if (duloOwned) {
      const cookie = cookieHeader();
      if (cookie) headers.Cookie = cookie;
    }
    let res = null;
    try {
      if (typeof fetchv2 === 'function') {
        res = await fetchv2(url, headers, cfg.method || 'GET', cfg.body == null ? null : cfg.body, cfg.fetchOptions || undefined);
      } else if (typeof fetch === 'function') {
        res = await fetch(url, { method: cfg.method || 'GET', headers, body: cfg.body == null ? undefined : cfg.body });
      }
    } catch (error) {
      log('dulo request error: ' + (error && error.message ? error.message : error));
      return { ok: false, status: 0, body: '', json: null };
    }
    if (duloOwned) storeCookies(res);
    const status = Number((res && res.status) || 0);
    let text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    if (!text && res && typeof res.body === 'string') text = res.body;
    let json = null;
    if (res && typeof res.json === 'function') {
      try {
        json = await res.json();
      } catch (_) {}
    }
    if (!json && text) {
      try {
        json = JSON.parse(text);
      } catch (_) {}
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      body: text,
      json,
      bodyDropped: !!(res && (res.bodyDropped === true || res.bodyDropped === 1)),
      bodyBytes: Number((res && res.bodyBytes) || 0),
    };
  }

  async function ensureSession() {
    if (sessionReady) return true;
    const res = await duloRequest(DULO_API + '/session');
    if (res.ok) {
      sessionReady = true;
      return true;
    }
    log('session failed status=' + res.status);
    return false;
  }

  function parseSourceEvents(body) {
    const sources = [];
    const seen = {};
    const blocks = String(body || '').replace(/\r\n/g, '\n').split(/\n\n+/);
    for (const block of blocks) {
      const eventMatch = block.match(/^event:\s*([^\n]+)/m);
      if (!eventMatch || String(eventMatch[1]).trim() !== 'sources') continue;
      const dataMatch = block.match(/^data:\s*(.+)$/m);
      if (!dataMatch) continue;
      let payload = null;
      try {
        payload = JSON.parse(dataMatch[1]);
      } catch (_) {
        continue;
      }
      const rows = Array.isArray(payload && payload.sources) ? payload.sources : [];
      for (const source of rows) {
        const url = String(source && source.url || '').trim();
        if (!url || seen[url]) continue;
        seen[url] = true;
        sources.push(source);
      }
    }
    return sources;
  }

  function isOneShotSignedUrl(url) {
    const value = String(url || '').toLowerCase();
    return (
      /[?&]t=[^&]{8,}/.test(value) &&
      /[?&]s=\d{9,}/.test(value) &&
      /[?&]e=\d{3,}/.test(value)
    );
  }

  function bodyLooksBlocked(body) {
    const text = String(body || '');
    if (!text) return false;
    const lower = text.toLowerCase();
    if (text.indexOf('BOUND_IP_ORB') >= 0) return true;
    if (lower.indexOf('not allowed to use this worker') >= 0) return true;
    if (lower.indexOf('organization is not allowed') >= 0) return true;
    if (lower.indexOf('bound_ip_orb_failed') >= 0) return true;
    if (lower.indexOf('<!doctype html') >= 0) return true;
    if (lower.indexOf('<html') >= 0 && lower.indexOf('worker') >= 0) return true;
    return false;
  }

  function bodyLooksLikeImageError(body) {
    const raw = String(body || '');
    if (!raw) return false;
    const b0 = raw.charCodeAt(0);
    const b1 = raw.length > 1 ? raw.charCodeAt(1) : 0;
    const b2 = raw.length > 2 ? raw.charCodeAt(2) : 0;
    if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return true;
    if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e) return true;
    if (raw.indexOf('GIF8') === 0) return true;
    if (raw.slice(0, 4) === 'RIFF' && raw.indexOf('WEBP') > 0) return true;
    return false;
  }

  function bodyLooksLikeMedia(body) {
    const raw = String(body || '');
    if (!raw) return false;
    if (raw.indexOf('#EXTM3U') >= 0) return true;
    if (raw.charCodeAt(0) === 0x47) return true;
    if (raw.length >= 8 && raw.indexOf('ftyp') >= 4 && raw.indexOf('ftyp') < 12) return true;
    return false;
  }

  function firstPlaylistUri(m3u8Body, baseUrl) {
    const lines = String(m3u8Body || '').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.charAt(0) === '#') continue;
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      if (trimmed.charAt(0) === '/') {
        const origin = String(baseUrl || '').match(/^(https?:\/\/[^/]+)/i);
        return origin ? origin[1] + trimmed : trimmed;
      }
      const cut = String(baseUrl || '').lastIndexOf('/');
      return cut >= 0 ? String(baseUrl).slice(0, cut + 1) + trimmed : trimmed;
    }
    return '';
  }

  function isHlsSource(source) {
    const type = String((source && source.type) || '').toLowerCase();
    const url = String((source && source.url) || '').toLowerCase();
    return type === 'hls' || url.includes('.m3u8') || url.includes('mpegurl');
  }

  function mergeSourceHeaders(source) {
    const fromSource =
      source && source.headers && typeof source.headers === 'object' ? source.headers : {};
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'video/mp4,video/*;q=0.9,application/vnd.apple.mpegurl,*/*;q=0.8',
      Connection: 'keep-alive',
    };
    const declares = !!(
      fromSource.Referer ||
      fromSource.referer ||
      fromSource.Origin ||
      fromSource.origin
    );
    if (declares || isDuloOwnedHost(source && source.url)) {
      headers.Referer = fromSource.Referer || fromSource.referer || 'https://dulo.tv/';
      headers.Origin = fromSource.Origin || fromSource.origin || 'https://dulo.tv';
    }
    return Object.assign(headers, fromSource);
  }

  function scoreSource(source) {
    const url = String(source.url || '').toLowerCase();
    const title = String(source.title || '').toLowerCase();
    const height = Number((String(source.quality || title).match(/(\d{3,4})\s*p/i) || [])[1]) || 0;
    let score = height;
    if (isHlsSource(source) && !url.includes('jay.dulo.tv') && source.deepVerified) score += 320;
    else if (isHlsSource(source) && !url.includes('jay.dulo.tv')) score += 140;
    if (url.includes('workers.dev') || url.includes('proxy.dulo')) {
      score += source.deepVerified ? 30 : -20;
    }
    if (url.includes('jay.dulo.tv')) score += source.playableVerified ? 60 : 20;
    if (source.playableVerified) score += 120;
    if (url.includes('storrrrrrm.site')) score -= 200;
    return score;
  }

  function rankSources(sources) {
    return (Array.isArray(sources) ? sources : [])
      .filter((source) => source && source.url)
      .map((source) => ({ source, score: scoreSource(source) }))
      .sort((a, b) => b.score - a.score)
      .map((row) => row.source);
  }

  async function softVerifySource(source) {
    const url = String((source && source.url) || '').trim();
    if (!url) return { ok: false, source, reason: 'empty' };
    const headers = mergeSourceHeaders(source);

    if (!isHlsSource(source)) {
      if (isOneShotSignedUrl(url)) {
        source.playableVerified = true;
        return { ok: true, source, soft: true };
      }
      const res = await duloRequest(url, {
        headers: Object.assign({}, headers, { Range: 'bytes=0-1023' }),
      });
      const body = String(res.body || '');
      if (!res.ok || bodyLooksBlocked(body) || bodyLooksLikeImageError(body)) {
        return { ok: false, source, reason: 'mp4_blocked' };
      }
      source.playableVerified = bodyLooksLikeMedia(body) || body.length > 0;
      return { ok: true, source, soft: !source.playableVerified };
    }

    let playlistUrl = url;
    let res = await duloRequest(playlistUrl, {
      headers,
      fetchOptions: { maxBytesHint: 4 * 1024 * 1024 },
    });
    for (let depth = 0; depth < 4; depth += 1) {
      const playlistBody = String(res.body || '');
      if (!res.ok || bodyLooksBlocked(playlistBody) || bodyLooksLikeImageError(playlistBody)) {
        return { ok: false, source, reason: 'hls_blocked_or_error' };
      }
      if (playlistBody.indexOf('#EXTM3U') < 0) {
        return { ok: false, source, reason: 'hls_probe_fail' };
      }
      const nextUrl = firstPlaylistUri(playlistBody, playlistUrl);
      if (!nextUrl) return { ok: false, source, reason: 'hls_empty_playlist' };

      if (playlistBody.indexOf('#EXTINF') >= 0) {
        if (isOneShotSignedUrl(nextUrl)) {
          // savefiles-style one-shot tokens: probing would burn the player's
          // only fetch. Playlist structure verified; trust the fresh chain.
          source.resolvedPlaylistUrl = playlistUrl;
          source.playableVerified = true;
          source.oneShotSigned = true;
          return { ok: true, source, soft: true };
        }
        const segment = await duloRequest(nextUrl, {
          headers: Object.assign({}, headers, {
            Range: 'bytes=0-4096',
            Accept: 'video/mp2t,video/*,application/octet-stream,*/*',
          }),
          fetchOptions: { maxBytesHint: 1024 * 1024 },
        });
        const segmentBody = String(segment.body || '');
        if (!segment.ok || bodyLooksBlocked(segmentBody) || bodyLooksLikeImageError(segmentBody)) {
          return { ok: false, source, reason: 'hls_segment_blocked' };
        }
        if (segment.bodyDropped) {
          if (Number(segment.bodyBytes || 0) < 64 * 1024) {
            return { ok: false, source, reason: 'hls_segment_unusable' };
          }
        } else if (!bodyLooksLikeMedia(segmentBody) && segmentBody.length <= 32) {
          return { ok: false, source, reason: 'hls_segment_unusable' };
        }
        source.resolvedPlaylistUrl = playlistUrl;
        source.playableVerified = true;
        source.deepVerified = true;
        return { ok: true, source };
      }

      playlistUrl = nextUrl;
      res = await duloRequest(playlistUrl, {
        headers,
        fetchOptions: { maxBytesHint: 4 * 1024 * 1024 },
      });
    }
    return { ok: false, source, reason: 'playlist chain never reached media' };
  }

  async function resolveStream(ref) {
    await ensureSession();
    const startedAt = Date.now();
    const remainingMs = () => Math.max(0, RESOLVER_DEADLINE_MS - (Date.now() - startedAt));
    const payload =
      ref.type === 'tv'
        ? { type: 'tv', tmdbId: ref.tmdb, season: ref.season || 1, episode: ref.episode || 1 }
        : { type: 'movie', tmdbId: ref.tmdb };

    const live = await settleWithin(
      duloRequest(DULO_API + '/source', {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
      Math.min(13000, remainingMs()),
      { ok: false, status: 0, body: '' },
    );
    let sources = parseSourceEvents(live.body);
    if (!sources.length && remainingMs() > 3000) {
      // One bounded retry after a fresh session; repeat emits are usually fast.
      sessionReady = false;
      await ensureSession();
      const retry = await settleWithin(
        duloRequest(DULO_API + '/source', {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }),
        Math.min(8000, remainingMs()),
        { ok: false, status: 0, body: '' },
      );
      sources = parseSourceEvents(retry.body);
    }
    if (!sources.length) {
      log('no upstream sources for ' + JSON.stringify(payload));
      return [];
    }

    const ranked = rankSources(sources);
    const verified = [];
    const softOk = [];
    let checked = 0;
    for (const source of ranked.slice(0, 6)) {
      if (remainingMs() < 500) break;
      if (!isHlsSource(source)) {
        softOk.push(source);
        continue;
      }
      checked += 1;
      const check = await settleWithin(
        softVerifySource(source),
        Math.min(checked <= 2 ? VERIFY_TIMEOUT_MS : VERIFY_RECOVERY_TIMEOUT_MS, remainingMs()),
        { ok: false, source, reason: 'verify_timeout' },
      );
      if (check.ok && check.source.deepVerified) {
        verified.push(check.source);
        break;
      }
      if (check.ok && check.source.playableVerified) {
        softOk.push(check.source);
      } else if (!check.ok && /blocked|error|unusable/i.test(String(check.reason || ''))) {
        log('drop source: ' + check.reason);
      } else {
        softOk.push(source);
      }
    }

    const out = verified
      .concat(softOk)
      .concat(ranked.filter((s) => verified.indexOf(s) < 0 && softOk.indexOf(s) < 0))
      .filter(
        (source, index, list) =>
          list.findIndex((other) => other.url === source.url) === index &&
          (source.deepVerified || source.playableVerified),
      );
    log('resolver finished in ' + String(Date.now() - startedAt) + 'ms routes=' + out.length);
    return out.slice(0, 4);
  }

  async function extractStreamUrl(episodeHref, lang) {
    const ref = parseWatchRef(episodeHref);
    if (!ref || !ref.tmdb) return { streams: [], subtitles: [] };
    const playbackRef = {
      type: ref.type,
      tmdb: ref.tmdb,
      season: ref.type === 'tv' ? ref.season || 1 : null,
      episode: ref.type === 'tv' ? ref.episode || 1 : null,
      hint: ref.hint || '',
      title: ref.hint || '',
    };

    // Videasy first (same free HD method as X-Stream / site Server 1).
    const videasyPack = await settleWithin(resolveVideasy(playbackRef), 22000, {
      streams: [],
      subtitles: [],
    });
    let sources = (videasyPack && videasyPack.streams) || [];
    let subtitles = (videasyPack && videasyPack.subtitles) || [];

    // Fall back to Dulo / LookMovie only when Videasy has nothing usable.
    if (!sources.length) {
      sources = await settleWithin(
        firstNonEmpty([
          resolveStream(playbackRef),
          resolveSecondaryStream(Object.assign({}, playbackRef, { hint: ref.hint || '' })),
        ]),
        RESOLVER_DEADLINE_MS + 2000,
        [],
      );
    }
    if (!sources.length) {
      log('extractStreamUrl no routes for ' + episodeHref);
      return { streams: [], subtitles: [] };
    }

    const entries = [];
    let primaryHeaders = null;
    for (const source of sources) {
      const streamUrl = String(source.resolvedPlaylistUrl || source.url || '').trim();
      if (!streamUrl) continue;
      let headers =
        source.provider === 'videasy'
          ? Object.assign({}, source.headers || videasyStreamHeaders())
          : mergeSourceHeaders(source);
      if (
        source.provider === 'videasy' ||
        /ironwallnet|solaratom|winterforest|playhq\.net|ourmovie\.net/i.test(streamUrl)
      ) {
        headers = Object.assign({}, headers, videasyStreamHeaders());
      }
      if (!primaryHeaders) primaryHeaders = headers;
      const height = Number(source.height) || videasyHeightFromQuality(source.quality || source.title || '');
      const quality = String(source.quality || (height >= 360 ? height + 'p' : '')).trim();
      entries.push({
        label: source.title || (quality ? 'Stream ' + quality : 'Stream'),
        url: streamUrl,
        height: height || undefined,
        quality: quality || undefined,
        streamType: isHlsSource(source) ? 'hls' : 'mp4',
        headers,
      });
    }
    if (!entries.length) return { streams: [], subtitles: [] };

    const bestHeight =
      Number(entries[0].height) ||
      videasyHeightFromQuality(entries[0].quality || entries[0].label || '') ||
      0;
    let mergedSubs = Array.isArray(subtitles) ? subtitles.slice() : [];
    if (mergedSubs.length < 2) {
      const external = await fetchSynthetiqSubs(
        playbackRef.tmdb,
        playbackRef.type === 'tv' ? playbackRef.season || 1 : null,
        playbackRef.type === 'tv' ? playbackRef.episode || 1 : null,
      );
      mergedSubs = mergeSubtitles(mergedSubs, external);
    }
    const cappedSubs = Array.isArray(mergedSubs) ? mergedSubs.slice(0, 40) : [];

    return {
      streams: entries,
      subtitles: cappedSubs,
      headers: primaryHeaders || { 'User-Agent': USER_AGENT },
      quality: bestHeight >= 360 ? bestHeight + 'p' : 'auto',
      defaultQuality: bestHeight >= 360 ? bestHeight + 'p' : undefined,
      lang: String(lang || '').toLowerCase() === 'dub' ? 'dub' : 'sub',
      streamType: entries[0].streamType || 'hls',
      source: sources[0] && sources[0].provider === 'videasy' ? 'ev01-videasy' : 'ev01-v1',
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
})();
