(() => {
  'use strict';

  const BASE = 'https://onepace.net';
  const WATCH_URL = BASE + '/en/watch';
  const PIXEL_LIST = 'https://pixeldrain.net/api/list/';
  const PIXEL_FILE = 'https://pixeldrain.net/api/file/';
  // Series artwork: a real episode still served by the source's CDN (never the site favicon).
  const ARTWORK = 'https://pixeldrain.net/api/file/bFMfAycQ/thumbnail';
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
    'Referer': BASE + '/',
  };
  const STREAM_HEADERS = {
    'User-Agent': UA,
    'Referer': 'https://pixeldrain.net/',
  };
  const cache = {
    watchHtml: '',
    watchAt: 0,
    lists: {},
    episodes: null,
    episodesAt: 0,
  };
  const CACHE_MS = 10 * 60 * 1000;
  function now() { return Date.now ? Date.now() : new Date().getTime(); }

  function textOf(res) {
    if (!res) return '';
    if (typeof res.text === 'function') return res.text();
    return Promise.resolve(String(res.body || ''));
  }

  async function getText(url, headers) {
    const res = await fetchv2(url, headers || HEADERS, 'GET', null);
    const body = await textOf(res);
    if (!res || res.ok === false || (res.status && res.status >= 400)) {
      throw new Error('Request failed: ' + url + ' (' + (res && res.status ? res.status : 'unknown') + ')');
    }
    return body;
  }

  async function getJson(url, headers) {
    const res = await fetchv2(url, headers || HEADERS, 'GET', null);
    if (!res || res.ok === false || (res.status && res.status >= 400)) {
      throw new Error('Request failed: ' + url + ' (' + (res && res.status ? res.status : 'unknown') + ')');
    }
    if (typeof res.json === 'function') {
      try { return await res.json(); } catch (_) {}
    }
    if (res.json && typeof res.json === 'object') return res.json;
    const body = await textOf(res);
    return JSON.parse(body || '{}');
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;|&#039;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function unique(values) {
    const seen = {};
    const out = [];
    for (const v of values || []) {
      const key = String(v || '').trim();
      if (key && !seen[key]) { seen[key] = true; out.push(key); }
    }
    return out;
  }

  function extractListIds(html) {
    const ids = [];
    const re = /https?:\/\/pixeldrain\.net\/l\/([A-Za-z0-9]+)/g;
    let m;
    while ((m = re.exec(String(html || ''))) !== null) ids.push(m[1]);
    return unique(ids);
  }

  async function getWatchHtml() {
    if (cache.watchHtml && now() - cache.watchAt < CACHE_MS) return cache.watchHtml;
    const html = await getText(WATCH_URL, HEADERS);
    cache.watchHtml = html;
    cache.watchAt = now();
    return html;
  }

  async function getList(id) {
    if (cache.lists[id] && now() - cache.lists[id].at < CACHE_MS) return cache.lists[id].value;
    const json = await getJson(PIXEL_LIST + encodeURIComponent(id), {
      'User-Agent': UA,
      'Accept': 'application/json,text/plain,*/*',
      'Referer': WATCH_URL,
    });
    if (!json || json.success === false) throw new Error('Pixeldrain list failed: ' + id);
    cache.lists[id] = { value: json, at: now() };
    return json;
  }

  async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const index = next++;
        try { results[index] = await mapper(items[index], index); }
        catch (error) { results[index] = { __error: String(error && error.message ? error.message : error) }; }
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  function qualityFrom(value) {
    const m = String(value || '').match(/\[(2160p|1440p|1080p|720p|480p|360p)\]/i);
    return m ? m[1].toLowerCase() : 'Auto';
  }

  function langFrom(value) {
    return explicitLanguageFrom(value) || 'sub';
  }

  function explicitLanguageFrom(value) {
    const text = String(value || '');
    if (/\bDub\b/i.test(text)) return 'dub';
    if (/\bCC\b/i.test(text)) return 'cc';
    if (/\bSub\b/i.test(text)) return 'sub';
    return null;
  }

  function explicitVariantLanguage(variants) {
    for (const key of Object.keys(variants || {})) {
      const variant = variants[key];
      const label = variant && (variant.name || variant.title || variant.label);
      const language = explicitLanguageFrom(label);
      if (language) return language;
    }
    return null;
  }

  function arcFromListTitle(title) {
    let t = cleanText(title)
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/\[(?:En\s*)?(?:Sub|Dub|CC)\]/ig, '')
      .replace(/\[(?:2160p|1440p|1080p|720p|480p|360p)\]/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) t = 'One Pace';
    return t;
  }

  function episodeNumberFromName(name, fallback) {
    const value = String(name || '');
    let m = value.match(/\]\[(\d{1,4})(?:-\d{1,4})?\]/);
    if (m) return Number(m[1]);
    m = value.match(/(?:^|\s)(\d{1,4})(?:\s|\.|$)/);
    if (m) return Number(m[1]);
    return fallback;
  }

  function titleBaseFromName(name, listTitle) {
    let t = cleanText(String(name || ''))
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/^\[One Pace\]/i, '')
      .replace(/^\[[^\]]+\]/, '')
      .replace(/\[(?:2160p|1440p|1080p|720p|480p|360p)\]/ig, '')
      .replace(/\[(?:En\s*)?(?:Sub|Dub|CC)\]/ig, '')
      .replace(/\[[A-F0-9]{6,12}\]/ig, '')
      .replace(/\s+/g, ' ')
      .replace(/(\d{1,3})\s+\((April Fools[^)]*)\)\s+\1\s*$/i, '$1 ($2)')
      .trim();
    if (!t) t = arcFromListTitle(listTitle);
    return t;
  }

  function hrefFromGroup(group) {
    const byLanguage = group.variantsByLanguage || {};
    const defaultLanguage = byLanguage.sub
      ? 'sub'
      : (byLanguage.cc ? 'cc' : (byLanguage.dub ? 'dub' : null));
    return 'onepace:' + encodeURIComponent(JSON.stringify({
      title: group.title,
      number: group.number,
      defaultLanguage,
      variantsByLanguage: byLanguage,
      variants: byLanguage.sub || byLanguage.cc || byLanguage.dub,
    }));
  }

  function groupKey(title) {
    return cleanText(title).toLowerCase();
  }

  async function buildEpisodes() {
    if (cache.episodes && now() - cache.episodesAt < CACHE_MS) return cache.episodes;
    const html = await getWatchHtml();
    const ids = extractListIds(html);
    if (!ids.length) throw new Error('No One Pace watch lists were found.');

    const lists = await mapLimit(ids, 6, async (id) => getList(id));
    const groups = {};
    let fallbackNumber = 1;
    let orderCounter = 1;

    for (const list of lists) {
      if (!list || list.__error || !list.files || !list.files.length) continue;
      const listTitle = cleanText(list.title || 'One Pace');
      const listQuality = qualityFrom(listTitle);
      const listLanguage = langFrom(listTitle);
      for (const file of list.files) {
        if (!file || !file.id) continue;
        const name = cleanText(file.name || listTitle);
        if (!/\.mp4($|\?)/i.test(name) && !/video/i.test(String(file.mime_type || file.type || ''))) continue;
        const title = titleBaseFromName(name, listTitle);
        const number = episodeNumberFromName(name, fallbackNumber++);
        const quality = qualityFrom(name) === 'Auto' ? listQuality : qualityFrom(name);
        const language = explicitLanguageFrom(name) || listLanguage;
        const key = groupKey(title);
        if (!groups[key]) {
          groups[key] = {
            title,
            sourceNumber: number,
            number: orderCounter++,
            variantsByLanguage: {},
          };
        }
        if (!groups[key].variantsByLanguage[language]) groups[key].variantsByLanguage[language] = {};
        const bucket = groups[key].variantsByLanguage[language];
        if (!bucket[quality] || Number(file.size || 0) > Number(bucket[quality].size || 0)) {
          bucket[quality] = {
            fileId: String(file.id),
            size: Number(file.size || 0),
            name,
          };
        }
      }
    }

    const sortedGroups = Object.keys(groups).map((k) => groups[k]).sort((a, b) => a.number - b.number);

    const episodes = sortedGroups.map((group, index) => ({
      number: group.number || index + 1,
      href: hrefFromGroup(group),
      title: group.title,
      subAvailable: !!group.variantsByLanguage.sub,
      dubAvailable: !!(group.variantsByLanguage.dub || group.variantsByLanguage.cc),
    }));

    if (!episodes.length) throw new Error('No playable One Pace MP4 files were found.');
    cache.episodes = episodes;
    cache.episodesAt = now();
    return episodes;
  }

  function unpackHref(href) {
    const raw = String(href || '');
    const indexed = raw.match(/^onepace-index:(\d+)$/);
    if (indexed) return { indexNumber: Number(indexed[1]) };
    if (raw.indexOf('onepace:') === 0) {
      try { return JSON.parse(decodeURIComponent(raw.slice('onepace:'.length))); } catch (_) {}
    }
    if (/^[A-Za-z0-9]+$/.test(raw)) {
      return { title: 'One Pace', variants: { Auto: { fileId: raw } } };
    }
    throw new Error('Invalid One Pace episode id.');
  }

  globalThis.searchResults = async function searchResults(query) {
    const q = cleanText(query).toLowerCase();
    if (q && !/(one\s*pace|one\s*piece|pace|luffy|anime)/i.test(q)) return [];
    return [{
      title: 'One Pace',
      image: ARTWORK,
      id: 'onepace',
      href: 'onepace',
      url: WATCH_URL,
    }];
  };

  globalThis.extractDetails = async function extractDetails(urlOrId) {
    return {
      title: 'One Pace',
      description: 'A streamlined One Piece watch order with sub, dub, and caption variants where available. Streams are resolved from the watch lists at playback time.',
      image: ARTWORK,
      author: 'One Pace',
      status: 'Ongoing',
      episodeIndexVersion: 'live-watch-list',
      url: WATCH_URL,
      id: 'onepace',
    };
  };

  globalThis.extractEpisodes = async function extractEpisodes(seriesId) {
    void seriesId;
    // Never return a fixed placeholder count. One Pace is split across arc,
    // language, and quality lists; build one ordered episode catalogue and
    // merge those lists by normalized arc title.
    return await buildEpisodes();
  };

  globalThis.extractStreamUrl = async function extractStreamUrl(episodeHref, lang) {
    let payload = unpackHref(episodeHref);
    if (payload.indexNumber) {
      const episodes = await buildEpisodes();
      const episode = episodes.find((item) => item.number === payload.indexNumber);
      if (!episode) {
        throw new Error('This One Pace episode is not currently listed by the source.');
      }
      payload = unpackHref(episode.href);
    }
    const byLang = payload.variantsByLanguage || {};
    const requested = String(lang || '').toLowerCase().trim();
    const legacyVariants = payload.variants || null;
    const legacyLanguage = explicitLanguageFrom(payload.defaultLanguage) ||
      explicitLanguageFrom(payload.language) ||
      explicitVariantLanguage(legacyVariants);
    let variants = null;
    if (requested === 'dub') {
      variants = byLang.dub || byLang.cc ||
        (legacyVariants && (legacyLanguage === 'dub' || legacyLanguage === 'cc') ? legacyVariants : null);
    } else if (requested === 'sub') {
      variants = byLang.sub ||
        (legacyVariants && legacyLanguage === 'sub' ? legacyVariants : null);
    } else if (requested === 'cc') {
      variants = byLang.cc ||
        (legacyVariants && legacyLanguage === 'cc' ? legacyVariants : null);
    } else {
      variants = byLang.sub || byLang.cc || byLang.dub || legacyVariants;
    }
    if (!variants) {
      throw new Error(requested === 'dub'
        ? 'One Pace has no DUB source for this episode.'
        : 'One Pace has no subtitle source for this episode.');
    }
    const order = ['360p', '480p', '720p', '1080p', '1440p', '2160p', 'Auto'];
    const streams = [];
    for (const q of order) {
      const v = variants[q];
      if (v && v.fileId) streams.push(q, PIXEL_FILE + encodeURIComponent(v.fileId));
    }
    for (const q of Object.keys(variants)) {
      if (order.indexOf(q) >= 0) continue;
      const v = variants[q];
      if (v && v.fileId) streams.push(q, PIXEL_FILE + encodeURIComponent(v.fileId));
    }
    if (!streams.length) throw new Error('No stream variants found for this One Pace episode.');
    return {
      streams,
      subtitles: [],
      headers: STREAM_HEADERS,
    };
  };
})();
