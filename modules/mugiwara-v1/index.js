(() => {
  'use strict';

  const MODULE_NAME = 'Mugiwara';
  const SITE = 'https://www.mugiwara-no-streaming.com';
  const SIBNET = 'https://video.sibnet.ru';
  const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const MAX_EPISODES_CAP = 3000;
  const episodeScripts = new Map();
  let episodeScriptBytes = 0;
  let episodeScriptBlockedUntil = 0;

  function rateLimitError() {
    const error = new Error('Mugiwara is limiting requests. Please wait ' + Math.max(1, Math.ceil((episodeScriptBlockedUntil-Date.now())/1000)) + ' seconds before retrying.');
    error.code = 'RATE_LIMITED';
    return error;
  }

  function log(message) {
    try {
      if (typeof debugPrint === 'function') debugPrint('[' + MODULE_NAME + '] ' + String(message || ''));
      else console.log('[' + MODULE_NAME + '] ' + String(message || ''));
    } catch (_) {}
  }

  function decodeHtml(text) {
    return String(text || '')
      .replace(/&#0?39;|&#x27;|&apos;/g, "'")
      .replace(/&#8217;/g, "'")
      .replace(/&#8211;|&ndash;/g, '-')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  // ---------- HTTP bridge ----------

  async function requestJson(url, extraHeaders, method = 'GET', body = null) {
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      Referer: SITE + '/',
    }, extraHeaders || {});
    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, headers, method, body);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { headers, method, body });
    }
    const status = Number((res && res.status) || 0);
    if (status < 200 || status >= 400) {
      throw new Error('Mugiwara: request failed (HTTP ' + status + ') for ' + url);
    }
    if (res && typeof res.json === 'function') {
      try {
        const j = await res.json();
        if (j) return j;
      } catch (_) {}
    }
    if (res && res.json && typeof res.json === 'object') {
      return res.json;
    }
    let text = '';
    if (res && typeof res.text === 'function') { try { text = await res.text(); } catch (_) {} }
    else if (res && typeof res.body === 'string') text = res.body;
    if (text) {
      try { return JSON.parse(text); } catch (_) {}
    }
    throw new Error('Mugiwara: response from ' + url + ' was not valid JSON');
  }

  async function requestText(url, extraHeaders, session) {
    if (session && (session.closed || Date.now() >= session.deadline)) throw new Error('Lookup expired');
    const episodeScript = url.startsWith(SITE + '/api/episodes-script?');
    if (episodeScript) {
      const cached = episodeScripts.get(url);
      if (cached && Date.now()-cached.at < 300000) return cached.response;
      if (cached) { episodeScriptBytes -= cached.response.text.length; episodeScripts.delete(url); }
      if (Date.now() < episodeScriptBlockedUntil) throw rateLimitError();
    }
    const headers = Object.assign({
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: SITE + '/',
    }, extraHeaders || {});
    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, headers, 'GET', null);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { headers });
    }
    const status = Number((res && res.status) || 0);
    if (episodeScript && status === 429) {
      const headers = (res && res.headers) || {};
      const retry = headers['retry-after'] || headers['Retry-After'];
      const wait = /^\d+$/.test(String(retry || '')) ? Number(retry)*1000 : Date.parse(retry)-Date.now();
      episodeScriptBlockedUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? wait : 60000);
      throw rateLimitError();
    }
    let text = '';
    if (res && typeof res.text === 'function') { try { text = await res.text(); } catch (_) {} }
    else if (res && typeof res.body === 'string') text = res.body;
    if (!text && res && typeof res.json === 'function') {
      try {
        const j = await res.json();
        if (j) text = JSON.stringify(j);
      } catch (_) {}
    } else if (!text && res && res.json && typeof res.json === 'object') {
      text = JSON.stringify(res.json);
    }
    const response = { status: status, ok: status >= 200 && status < 300, text: text || '', headers: (res && res.headers) || {} };
    // Cache only bounded episode metadata, never resolved video URLs or failed replies.
    if (episodeScript && response.ok && /var\s+eps\d+\s*=/.test(text) && text.length <= 262144) {
      while (episodeScripts.size && (episodeScripts.size >= 32 || episodeScriptBytes+text.length > 1048576)) {
        const key = episodeScripts.keys().next().value;
        episodeScriptBytes -= episodeScripts.get(key).response.text.length;
        episodeScripts.delete(key);
      }
      episodeScripts.set(url,{at:Date.now(),response}); episodeScriptBytes += text.length;
    }
    return response;
  }

  // ---------- image formatting ----------

  const STATIC_CDN = 'https://static.mugiwara-no-streaming.com';

  function formatImageUrl(slug, rawImage) {
    if (!rawImage || typeof rawImage !== 'string') return '';
    const trimmed = rawImage.trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) {
      if (trimmed.includes('raw.githubusercontent.com/NOUSSS/mugiwara-no-streaming-images')) {
        const cleanPath = trimmed.replace(/^https?:\/\/raw\.githubusercontent\.com\/NOUSSS\/mugiwara-no-streaming-images\/main\/(?:Animes\/)?/i, '');
        return STATIC_CDN + '/Animes/' + cleanPath;
      }
      return trimmed;
    }
    const cleanPath = trimmed.replace(/^\/+/, '');
    if (slug) {
      if (cleanPath.startsWith('Animes/')) {
        return STATIC_CDN + '/' + cleanPath;
      }
      return STATIC_CDN + '/Animes/' + slug + '/' + cleanPath;
    }
    return STATIC_CDN + '/' + cleanPath;
  }

  function scoreImage(url) {
    if (!url) return -100;
    const lower = url.toLowerCase();
    if (lower.includes('heroines') || lower.includes('elbaf') || lower.includes('scan') || lower.includes('kai')) return -50;
    if (lower.includes('affiche')) return 100;
    if (lower.includes('saison1.') || lower.includes('saison1/') || lower.includes('saison1.jpg') || lower.includes('saison1.webp') || lower.includes('saison1.jpeg')) return 90;
    if (lower.includes('films/1.') || lower.includes('film1.')) return 85;
    if (lower.includes('saison')) return 70;
    return 10;
  }

  // ---------- catalogue ----------

  const catalogueCache = { at: 0, items: [] };

  async function fetchCatalogue() {
    if (catalogueCache.items.length && Date.now() - catalogueCache.at < 10 * 60 * 1000) {
      return catalogueCache.items;
    }

    const bySlug = {};

    // 1. Fetch full database via catalogue-filters (1200+ titles)
    try {
      const [page1Res, page2Res] = await Promise.all([
        requestJson(
          SITE + '/api/catalogue-filters',
          { 'Content-Type': 'application/json' },
          'POST',
          JSON.stringify({ page: 1, itemsPerPage: 1000 })
        ).catch(() => null),
        requestJson(
          SITE + '/api/catalogue-filters',
          { 'Content-Type': 'application/json' },
          'POST',
          JSON.stringify({ page: 2, itemsPerPage: 1000 })
        ).catch(() => null),
      ]);

      const allAnimes = [
        ...((page1Res && page1Res.animes) || []),
        ...((page2Res && page2Res.animes) || []),
      ];

      for (const a of allAnimes) {
        const slug = String(a.slug || '').trim();
        if (!slug) continue;
        const title = String(a.anime || a.title || slug).trim();
        const wallpaper = String(a.wallpaper || '');
        const imgUrl = formatImageUrl(slug, wallpaper);
        bySlug[slug] = {
          slug: slug,
          title: title,
          image: imgUrl,
          category: 'Catalogue',
          disponibles: a.disponibles || [],
          images: [imgUrl].filter(Boolean),
        };
      }
    } catch (err) {
      log('catalogue-filters preload failed, falling back to get-catalogues: ' + err);
    }

    // 2. Enrich with category metadata from get-catalogues
    try {
      const data = await requestJson(SITE + '/api/get-catalogues');
      for (const cat of ((data && data.catalogues) || [])) {
        const category = String(cat.category || '').trim();
        for (const entry of (cat.names || [])) {
          const slug = String(entry.slug || '').trim();
          if (!slug) continue;
          const rawImg = String((entry.data && entry.data.image) || '');
          const img = formatImageUrl(slug, rawImg);
          const title = String(entry.animeName || entry.title || slug).trim();
          const disponibles = (entry.data && entry.data.disponibles) || [];

          if (!bySlug[slug]) {
            bySlug[slug] = {
              slug: slug,
              title: title,
              image: img,
              category: category || 'Catalogue',
              disponibles: disponibles,
              images: [img].filter(Boolean),
            };
          } else {
            if (img && !bySlug[slug].images.includes(img)) bySlug[slug].images.push(img);
            if (img && scoreImage(img) > scoreImage(bySlug[slug].image)) {
              bySlug[slug].image = img;
            }
            if (category && (!bySlug[slug].category || bySlug[slug].category === 'Catalogue' || bySlug[slug].category === 'Nouveautés')) {
              bySlug[slug].category = category;
            }
            if (disponibles.length && !bySlug[slug].disponibles.length) {
              bySlug[slug].disponibles = disponibles;
            }
          }
        }
      }
    } catch (err) {
      log('get-catalogues fetch failed: ' + err);
    }

    const items = Object.values(bySlug);
    if (!items.length) throw new Error('Mugiwara: catalogue returned no titles');
    catalogueCache.at = Date.now();
    catalogueCache.items = items;
    return items;
  }

  // ---------- search ----------

  async function searchResults(query) {
    const q = String(query || '').trim();

    // 1. Direct server-side search via catalogue-filters when query is present
    if (q) {
      try {
        const data = await requestJson(
          SITE + '/api/catalogue-filters',
          { 'Content-Type': 'application/json' },
          'POST',
          JSON.stringify({ input: q, page: 1, itemsPerPage: 50 })
        );
        const animes = (data && data.animes) || [];
        if (animes.length) {
          return animes.map((a) => {
            const slug = String(a.slug || '').trim();
            const title = String(a.anime || a.title || slug).trim();
            const rawImg = a.wallpaper || (a.data && a.data.image) || '';
            return {
              href: SITE + '/catalogue/' + slug,
              id: slug,
              title: title,
              image: formatImageUrl(slug, rawImg),
            };
          });
        }
      } catch (err) {
        log('Server search failed, falling back to local catalogue: ' + err);
      }
    }

    // 2. Local catalogue search fallback or empty query
    const items = await fetchCatalogue();
    if (!q) {
      return items.slice(0, 50).map((i) => ({
        href: SITE + '/catalogue/' + i.slug,
        id: i.slug,
        title: i.title,
        image: formatImageUrl(i.slug, i.image),
      }));
    }

    const qNorm = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const qTokens = qNorm.split(/\s+/).filter(Boolean);

    const scored = [];
    for (const item of items) {
      const tNorm = (item.title + ' ' + item.slug).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      let matches = true;
      let score = 0;
      for (const tok of qTokens) {
        if (tNorm.includes(tok)) {
          score += 10;
          if (item.title.toLowerCase().startsWith(tok)) score += 20;
        } else {
          matches = false;
          break;
        }
      }
      if (matches) {
        scored.push({ item: item, score: score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => ({
      href: SITE + '/catalogue/' + s.item.slug,
      id: s.item.slug,
      title: s.item.title,
      image: formatImageUrl(s.item.slug, s.item.image),
    }));
  }

  // ---------- JSON parsing helpers ----------

  function matchObjectEnd(str, open) {
    let depth = 0, inStr = false, strCh = '', esc = false;
    for (let j = open; j < str.length; j++) {
      const ch = str.charAt(j);
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === '\\') { esc = true; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) return j + 1; }
    }
    return -1;
  }

  function matchArrayEnd(str, open) {
    let depth = 0, inStr = false, strCh = '', esc = false;
    for (let j = open; j < str.length; j++) {
      const ch = str.charAt(j);
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === '\\') { esc = true; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
      if (ch === '[') depth += 1;
      else if (ch === ']') { depth -= 1; if (depth === 0) return j + 1; }
    }
    return -1;
  }

  function extractJsonObjects(html, key) {
    // Decode Next's JSON string transport before parsing nested metadata.
    // Blind unescaping corrupts quoted titles and escaped media URLs.
    const documents = [];
    const transport = /self\.__next_f\.push\(\[\d+,("(?:\\.|[^"\\])*")\]\)/g;
    let part;
    while ((part = transport.exec(String(html || ''))) !== null) {
      try { documents.push(JSON.parse(part[1])); } catch (_) {}
    }
    documents.push(String(html || ''));
    for (const normalized of documents) {
      const idx = normalized.indexOf('"' + key + '":');
      if (idx < 0) continue;
      const start = normalized.indexOf('{', idx);
      if (start < 0 || !/^\s*\{/.test(normalized.slice(idx + key.length + 3))) continue;
      const end = matchObjectEnd(normalized, start);
      if (end < 0) continue;
      try {
        return JSON.parse(normalized.slice(start, end));
      } catch (_) {}
    }
    return null;
  }

  function extractJsonStrings(html, key) {
    const normalized = String(html || '').replace(/\\"/g, '"');
    const idx = normalized.indexOf(key);
    if (idx < 0) return '';
    return normalized.slice(idx);
  }

  // ---------- details ----------

  async function extractDetails(urlOrId) {
    let slug = String(urlOrId || '').trim();
    if (/^https?:\/\//i.test(slug)) {
      const m = slug.match(/\/catalogue\/([^/?#]+)/i);
      slug = m ? m[1] : '';
    } else {
      slug = slug.replace(/^\/?catalogue\//i, '').replace(/^\/+|\/+$/g, '').split('/')[0];
    }
    if (!slug) throw new Error('Mugiwara: extractDetails received an empty or foreign URL');

    const items = await fetchCatalogue();
    const known = items.find((i) => i.slug === slug);

    let res = await requestText(SITE + '/catalogue/' + slug + '/episodes');
    if (!res.ok) {
      res = await requestText(SITE + '/catalogue/' + slug + '/films');
    }
    if (!res.ok) {
      res = await requestText(SITE + '/catalogue/' + slug);
    }

    const og = (prop) => {
      const needle = 'og:' + prop;
      const tagRe = /<meta\b[^>]*>/gi;
      let tag;
      while ((tag = tagRe.exec(res.text)) !== null) {
        const t = tag[0];
        if (t.indexOf(needle) < 0) continue;
        const c = t.match(/content\s*=\s*"([^"]*)"/i) || t.match(/content\s*=\s*'([^']*)'/i);
        if (c) return decodeHtml(c[1]);
      }
      return '';
    };

    const window2 = extractJsonStrings(res.text, 'EPISODES_OPTIONS') || extractJsonStrings(res.text, 'FILM_OPTIONS') || extractJsonStrings(res.text, '"saisons"');
    const genresM = window2.match(/"genres":\[([^\]]*)\]/);
    const genres = genresM
      ? genresM[1].split(',').map((g) => decodeHtml(String(g).replace(/"/g, ''))).filter(Boolean)
      : [];

    return {
      href: SITE + '/catalogue/' + slug,
      id: slug,
      title: ((known && known.title) || og('title') || slug).replace(/\s*[-–|]\s*Mugiwara.*$/i, '').trim(),
      description: og('description') || 'Anime disponible sur Mugiwara No Streaming.',
      image: formatImageUrl(slug, (known && known.image) || og('image') || ''),
      genres: genres,
    };
  }

  // ---------- episodes & player parsing ----------

  function parseEpisodesJs(jsText) {
    const players = [];
    const re = /var\s+(?:eps\d+)\s*=\s*\[([\s\S]*?)\];/g;
    let m;
    while ((m = re.exec(String(jsText || ''))) !== null) {
      const urls = [];
      const urlRe = /(?:^|,)\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,]*)/g;
      let u;
      while ((u = urlRe.exec(m[1])) !== null) {
        const token = u[1].trim();
        let decoded = '';
        if (token.startsWith('"')) { try { decoded = JSON.parse(token); } catch (_) {} }
        else if (token.startsWith("'")) decoded = token.slice(1, -1).replace(/\\\//g, '/').replace(/\\t/g, '\t');
        const url = decodeHtml(decoded).trim();
        urls.push(/^https?:\/\//i.test(url) ? url : url.startsWith('//') ? 'https:' + url : '');
        if (!u[0].length) urlRe.lastIndex += 1;
      }
      if (urls.some(Boolean)) players.push(urls);
    }
    return players;
  }

  function sibnetVideoId(playerUrl) {
    const m = String(playerUrl || '').match(/[?&]videoid=(\d+)/i) || String(playerUrl || '').match(/sibnet\.ru\/shell\.php\?videoid=(\d+)/i);
    return m ? m[1] : '';
  }

  function sortMirrorsSibnetFirst(urls) {
    const arr = (urls || []).filter(x => typeof x === 'string').map(x => x.trim()).filter(x => /^https?:\/\//i.test(x));
    arr.sort((a, b) => {
      const aSib = /sibnet\.ru/i.test(a) ? 1 : 0;
      const bSib = /sibnet\.ru/i.test(b) ? 1 : 0;
      return bSib - aSib;
    });
    return arr;
  }

  function parseInlineSeasons(html) {
    const options = extractJsonObjects(html, 'options');
    if (options && Array.isArray(options.saisons)) {
      return options.saisons.filter(s => s && s.id && s.lang && typeof s.lang === 'object').map(s => ({
        id: String(s.id),
        vfMirrors: Array.isArray(s.lang.vf) ? s.lang.vf : [],
        vostMirrors: Array.isArray(s.lang.vostfr) ? s.lang.vostfr : [],
      }));
    }
    const normalized = String(html || '').replace(/\\"/g, '"');
    const marker = normalized.indexOf('"saisons":[');
    if (marker < 0) return [];
    const arrOpen = normalized.indexOf('[', marker);
    const arrClose = matchArrayEnd(normalized, arrOpen);
    if (arrClose < 0) return [];
    const region = normalized.slice(arrOpen + 1, arrClose);

    const seasons = [];
    let i = 0;
    while (i < region.length && seasons.length < 30) {
      while (i < region.length && /[\s,]/.test(region.charAt(i))) i += 1;
      if (region.charAt(i) !== '{') break;
      const objEnd = matchObjectEnd(region, i);
      if (objEnd < 0) break;
      const objStr = region.slice(i, objEnd);

      try {
        const parsed = JSON.parse(objStr);
        if (parsed && parsed.id && parsed.lang) {
          const vfMirrors = Array.isArray(parsed.lang.vf) ? parsed.lang.vf : [];
          const vostMirrors = Array.isArray(parsed.lang.vostfr) ? parsed.lang.vostfr : [];
          seasons.push({
            id: String(parsed.id),
            vfMirrors: vfMirrors,
            vostMirrors: vostMirrors,
          });
        }
      } catch (_) {}
      i = objEnd;
    }

    seasons.sort((a, b) => {
      const na = Number(a.id), nb = Number(b.id);
      const aIsNum = !isNaN(na) && /^[0-9]+$/.test(a.id);
      const bIsNum = !isNaN(nb) && /^[0-9]+$/.test(b.id);
      if (aIsNum && bIsNum) return na - nb;
      if (aIsNum) return -1;
      if (bIsNum) return 1;
      return a.id.localeCompare(b.id);
    });

    return seasons;
  }

  async function extractEpisodes(seriesId) {
    let slug = String(seriesId || '').trim();
    if (/^https?:\/\//i.test(slug)) {
      const m = slug.match(/\/catalogue\/([^/?#]+)/i);
      slug = m ? m[1] : '';
    } else {
      slug = slug.replace(/^\/?catalogue\//i, '').replace(/^\/+|\/+$/g, '').split('/')[0];
    }
    if (!slug) throw new Error('Mugiwara: extractEpisodes received an empty or foreign URL');

    let html = '';
    let isFilmPage = false;
    let res = await requestText(SITE + '/catalogue/' + slug + '/episodes');
    if (res.ok) html = res.text;

    const norm = html.replace(/\\"/g, '"');
    const hasInline = norm.includes('"saisons":[') && !norm.includes('"saisons":[]');
    const hasScriptOptions = norm.includes('EPISODES_OPTIONS');

    // --- CASE 1: Inline Seasons (One Piece, Titans, etc.) ---
    if (hasInline) {
      const inlineSeasons = parseInlineSeasons(html);
      if (inlineSeasons.length) {
        const episodes = [];
        let globalNumber = 0;

        for (const season of inlineSeasons) {
          const vostCount = season.vostMirrors ? season.vostMirrors.reduce((max, arr) => Math.max(max, (arr || []).length), 0) : 0;
          const vfCount = season.vfMirrors ? season.vfMirrors.reduce((max, arr) => Math.max(max, (arr || []).length), 0) : 0;
          const maxLen = Math.max(vostCount, vfCount);
          if (!maxLen) continue;

          for (let i = 0; i < maxLen; i++) {
            globalNumber += 1;
            const subCandidates = [];
            for (const mirrorArr of (season.vostMirrors || [])) {
              if (mirrorArr && mirrorArr[i]) subCandidates.push(mirrorArr[i]);
            }
            const dubCandidates = [];
            for (const mirrorArr of (season.vfMirrors || [])) {
              if (mirrorArr && mirrorArr[i]) dubCandidates.push(mirrorArr[i]);
            }

            episodes.push({
              number: globalNumber,
              title: '\u00c9pisode ' + globalNumber + (Number(season.id) > 1 || !/^[0-9]+$/.test(season.id) ? ' (S' + season.id + ')' : ''),
              href: 'mugi-dual:' + JSON.stringify({
                sub: sortMirrorsSibnetFirst(subCandidates),
                dub: sortMirrorsSibnetFirst(dubCandidates),
              }),
              subAvailable: subCandidates.length > 0,
              dubAvailable: dubCandidates.length > 0,
              image: '',
            });
            if (episodes.length >= MAX_EPISODES_CAP) break;
          }
          if (episodes.length >= MAX_EPISODES_CAP) break;
        }

        if (episodes.length) {
          log('inline canonical seasons parsed: ' + episodes.length + ' episodes for ' + slug);
          return episodes;
        }
      }
    }

    // --- CASE 2: External Script Seasons via EPISODES_OPTIONS (Naruto, Bleach, Solo Leveling, etc.) ---
    if (hasScriptOptions) {
      const window2 = extractJsonStrings(html, 'EPISODES_OPTIONS') || extractJsonStrings(html, 'saisons');
      const unescaped = (window2 || html).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const options = extractJsonObjects(html, 'options');
      const episodeOptions = extractJsonObjects(html, 'EPISODES_OPTIONS');
      const scriptM = unescaped.match(/"SCRIPT_URL":"([^"]+)"/);
      let rawScript = episodeOptions ? String(episodeOptions.SCRIPT_URL || '') : scriptM ? decodeHtml(scriptM[1]).trim() : '';
      const hasDeclaredScript = !!rawScript && !['$undefined','undefined','null'].includes(rawScript);
      if (!rawScript || rawScript === '$undefined' || rawScript === 'undefined' || rawScript === 'null') {
        rawScript = slug;
      }
      const scriptBase = rawScript.replace(/\/?$/, '/');

      const seasons = [];
      for (const season of (options && Array.isArray(options.saisons) ? options.saisons : [])) {
        if (!season || !/^[a-zA-Z0-9._-]+$/.test(String(season.id || ''))) continue;
        seasons.push({id:String(season.id),name:String(season.name || ''),langs:season.langToShow || ['vostfr','vf']});
      }
      const saisonRe = /\{"id":"([a-zA-Z0-9._-]+)","name":"([^"]*)"(?:[^}]*?"langToShow":\[([^\]]*)\])?/g;
      let sm;
      while (!options && (sm = saisonRe.exec(unescaped)) !== null) {
        const sId = sm[1];
        if (seasons.some((s) => s.id === sId)) continue;
        const rawLangs = sm[3] ? sm[3].split(',').map((l) => l.replace(/["\s]/g, '')).filter(Boolean) : ['vostfr', 'vf'];
        seasons.push({ id: sId, name: decodeHtml(sm[2]), langs: rawLangs.length ? rawLangs : ['vostfr', 'vf'] });
      }
      if (!seasons.length) {
        seasons.push({ id: '1', name: 'Saison 1', langs: ['vostfr', 'vf'] });
      }

      const episodes = [];
      let globalNumber = 0;

      for (const season of seasons.slice(0, 25)) {
        let vostPlayers = [];
        let vfPlayers = [];

        // Some providers exist only in the server-rendered season payload.
        const loadSeasonPage = async () => {
          const page = await requestText(SITE + '/catalogue/' + slug + '/episodes/saison' + season.id);
          if (!page.ok) return;
          const current = parseInlineSeasons(page.text).find(s => s.id === season.id);
          if (current) {
            if (!vostPlayers.length) vostPlayers = current.vostMirrors;
            if (!vfPlayers.length) vfPlayers = current.vfMirrors;
          }
        };
        if (!hasDeclaredScript) await loadSeasonPage();

        // Try primary scriptBase, fallback to slug if needed
        const scriptBasesToTry = [scriptBase];
        if (scriptBase !== slug + '/') scriptBasesToTry.push(slug + '/');

        for (const base of scriptBasesToTry) {
          if (vostPlayers.length || vfPlayers.length) break;
          if (!vostPlayers.length) {
            try {
              const jsVost = await requestText(SITE + '/api/episodes-script?url=' + encodeURIComponent(base + 'saison' + season.id + '/vostfr/episodes.js'));
              if (jsVost.ok) vostPlayers = parseEpisodesJs(jsVost.text);
            } catch (error) { if (error.code === 'RATE_LIMITED') throw error; }
          }
          if (!vfPlayers.length) {
            try {
              const jsVf = await requestText(SITE + '/api/episodes-script?url=' + encodeURIComponent(base + 'saison' + season.id + '/vf/episodes.js'));
              if (jsVf.ok) vfPlayers = parseEpisodesJs(jsVf.text);
            } catch (error) { if (error.code === 'RATE_LIMITED') throw error; }
          }
          if (vostPlayers.length || vfPlayers.length) break;
        }
        if (hasDeclaredScript && !vostPlayers.length && !vfPlayers.length) await loadSeasonPage();

        const vostCount = vostPlayers.reduce((max, arr) => Math.max(max, arr.length), 0);
        const vfCount = vfPlayers.reduce((max, arr) => Math.max(max, arr.length), 0);
        const maxLen = Math.max(vostCount, vfCount);
        if (!maxLen) continue;

        for (let i = 0; i < maxLen; i++) {
          globalNumber += 1;
          const subCandidates = [];
          for (const playerArr of vostPlayers) {
            if (playerArr[i]) subCandidates.push(playerArr[i]);
          }
          const dubCandidates = [];
          for (const playerArr of vfPlayers) {
            if (playerArr[i]) dubCandidates.push(playerArr[i]);
          }

          episodes.push({
            number: globalNumber,
            title: '\u00c9pisode ' + globalNumber + (seasons.length > 1 ? ' (S' + season.id + ')' : ''),
            href: 'mugi-dual:' + JSON.stringify({
              sub: sortMirrorsSibnetFirst(subCandidates),
              dub: sortMirrorsSibnetFirst(dubCandidates),
            }),
            subAvailable: subCandidates.length > 0,
            dubAvailable: dubCandidates.length > 0,
            image: '',
          });
          if (episodes.length >= MAX_EPISODES_CAP) break;
        }
        if (episodes.length >= MAX_EPISODES_CAP) break;
      }

      if (episodes.length) {
        log('script seasons parsed: ' + episodes.length + ' episodes for ' + slug);
        return episodes;
      }
    }

    // --- CASE 3: Films & Anime Movies (Her Blue Sky, Your Name, Look Back, A Silent Voice, etc.) ---
    if (!html.includes('FILM_OPTIONS')) {
      const filmRes = await requestText(SITE + '/catalogue/' + slug + '/films');
      if (filmRes.ok) html = filmRes.text;
    }

    const filmOpts = extractJsonObjects(html, 'FILM_OPTIONS');
    if (filmOpts && filmOpts.lang && typeof filmOpts.lang === 'object') {
      const vfMirrors = Array.isArray(filmOpts.lang.vf) ? filmOpts.lang.vf : [];
      const vostMirrors = Array.isArray(filmOpts.lang.vostfr) ? filmOpts.lang.vostfr : [];
      const vostCount = vostMirrors.reduce((max, arr) => Math.max(max, (arr || []).length), 0);
      const vfCount = vfMirrors.reduce((max, arr) => Math.max(max, (arr || []).length), 0);
      const maxFilms = Math.max(1, Math.max(vostCount, vfCount));
      const episodes = [];

      for (let i = 0; i < maxFilms; i++) {
        const subCandidates = [];
        for (const mirrorArr of vostMirrors) {
          if (mirrorArr && mirrorArr[i]) subCandidates.push(mirrorArr[i]);
        }
        const dubCandidates = [];
        for (const mirrorArr of vfMirrors) {
          if (mirrorArr && mirrorArr[i]) dubCandidates.push(mirrorArr[i]);
        }
        const filmName = filmOpts.names && filmOpts.names[i] && filmOpts.names[i].name ? filmOpts.names[i].name : '';

        episodes.push({
          number: i + 1,
          title: 'Film ' + (i + 1) + (filmName ? ' - ' + filmName : ''),
          href: 'mugi-dual:' + JSON.stringify({
            sub: sortMirrorsSibnetFirst(subCandidates),
            dub: sortMirrorsSibnetFirst(dubCandidates),
          }),
          subAvailable: subCandidates.length > 0,
          dubAvailable: dubCandidates.length > 0,
          image: '',
        });
      }
      if (episodes.length) {
        log('films parsed: ' + episodes.length + ' films for ' + slug);
        return episodes;
      }
    }

    // Fallback: Check external film script (e.g. A Silent Voice, Suzume, etc.)
    const anime = extractJsonObjects(html, 'animeServer');
    const sourceFilmBase = filmOpts && typeof filmOpts.SCRIPT_URL === 'string' && filmOpts.SCRIPT_URL !== '$undefined'
      ? filmOpts.SCRIPT_URL : anime && anime.as_slug;
    const filmBase = typeof sourceFilmBase === 'string' && /^[a-zA-Z0-9_-]+\/?$/.test(sourceFilmBase) ? sourceFilmBase.replace(/\/$/, '') : slug;
    const filmScriptCandidates = [
      filmBase + '/film/vostfr/episodes.js',
      filmBase + '/film/vf/episodes.js',
      filmBase + '/films/vostfr/episodes.js',
      filmBase + '/films/vf/episodes.js',
    ];
    let filmVost = [];
    let filmVf = [];
    for (const p of filmScriptCandidates) {
      if (p.includes('/vostfr/') && !filmVost.length) {
        try {
          const js = await requestText(SITE + '/api/episodes-script?url=' + encodeURIComponent(p));
          if (js.ok) filmVost = parseEpisodesJs(js.text);
        } catch (error) { if (error.code === 'RATE_LIMITED') throw error; }
      } else if (p.includes('/vf/') && !filmVf.length) {
        try {
          const js = await requestText(SITE + '/api/episodes-script?url=' + encodeURIComponent(p));
          if (js.ok) filmVf = parseEpisodesJs(js.text);
        } catch (error) { if (error.code === 'RATE_LIMITED') throw error; }
      }
    }
    const maxFilmScript = Math.max(0, ...filmVost.map(x => x.length), ...filmVf.map(x => x.length));
    if (maxFilmScript > 0) {
      const episodes = [];
      for (let i = 0; i < maxFilmScript; i++) {
        const subCandidates = filmVost.map(x => x[i]).filter(Boolean);
        const dubCandidates = filmVf.map(x => x[i]).filter(Boolean);
        episodes.push({
          number: i + 1,
          title: 'Film ' + (i + 1),
          href: 'mugi-dual:' + JSON.stringify({
            sub: sortMirrorsSibnetFirst(subCandidates),
            dub: sortMirrorsSibnetFirst(dubCandidates),
          }),
          subAvailable: subCandidates.length > 0,
          dubAvailable: dubCandidates.length > 0,
          image: '',
        });
      }
      if (episodes.length) {
        log('external film script parsed: ' + episodes.length + ' films for ' + slug);
        return episodes;
      }
    }

    throw new Error('Mugiwara: no episodes or films found for ' + slug);
  }

  // ---------- stream resolution ----------

  function absoluteUrl(raw, base) {
    if (/^https?:\/\//i.test(raw)) return raw;
    const origin = base.match(/^https?:\/\/[^/]+/i);
    if (!origin) return '';
    if (raw.startsWith('//')) return 'https:' + raw;
    if (raw.startsWith('/')) return origin[0] + raw;
    const parts = (base.split(/[?#]/)[0].replace(/\/[^/]*$/, '/') + raw).split('/');
    const out = [];
    for (const part of parts) { if (part === '..' && out.length > 3) out.pop(); else if (part !== '.') out.push(part); }
    return out.join('/');
  }

  async function checkedMedia(url, headers, session, hls) {
    if (!hls) {
      const p = await requestText(url, Object.assign({}, headers, { Range: 'bytes=0-1023' }), session);
      if (!p.ok || p.text.slice(4, 8) !== 'ftyp') throw new Error('Not verified MP4 media');
      return [];
    }
    const master = await requestText(url, headers, session);
    if (!master.ok || !master.text.trim().startsWith('#EXTM3U')) throw new Error('Invalid HLS');
    const lines = master.text.split(/\r?\n/).map(x => x.trim());
    const qualities = [];
    for (let i=0;i<lines.length;i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const next = lines.slice(i+1).find(x => x && !x.startsWith('#'));
      const height = lines[i].match(/RESOLUTION=\d+x(\d+)/);
      if (next && height) qualities.push({ label: height[1]+'p', url: absoluteUrl(next,url), headers });
    }
    let current = master, currentUrl = url;
    for (let depth=0;depth<3;depth++) {
      const target = current.text.split(/\r?\n/).map(x=>x.trim()).find(x=>x&&!x.startsWith('#'));
      if (!target) throw new Error('Empty HLS');
      const next = absoluteUrl(target,currentUrl);
      if (/\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(next)) throw new Error('Image playlist rejected');
      if (current.text.includes('#EXT-X-STREAM-INF:')) {
        currentUrl=next; current=await requestText(next,headers,session);
        if (!current.ok || !current.text.trim().startsWith('#EXTM3U')) throw new Error('Invalid variant');
      } else {
        const media=await requestText(next,Object.assign({},headers,{Range:'bytes=0-1023'}),session);
        const type=String(media.headers['content-type']||'');
        if (!media.ok || !((media.text[0]==='G' && /video|octet-stream/i.test(type)) || /^(ftyp|styp|moof)$/.test(media.text.slice(4,8)))) throw new Error('Invalid HLS segment');
        return qualities;
      }
    }
    throw new Error('HLS nesting limit');
  }

  async function resolveAnsembed(embedUrl, session) {
    const page = await requestText(embedUrl, { Referer: SITE + '/' }, session);
    if (!page.ok) throw new Error('Ansembed request failed (HTTP ' + page.status + ')');
    const m = page.text.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
    if (!m) throw new Error('Ansembed m3u8 playlist not found');
    const streamUrl = m[0].replace(/\\/g, '');
    const headers = {
      'User-Agent': USER_AGENT,
      Referer: embedUrl,
    };
    const qualities = await checkedMedia(streamUrl, headers, session, true);
    return {
      url: streamUrl,
      headers: headers,
      streamType: 'hls',
      quality: 'Auto',
      serverName: 'Ansembed',
      streams: [{ label: 'Ansembed', url: streamUrl, headers: headers }],
      qualities: [{ label: 'Auto', url: streamUrl, headers: headers }].concat(qualities),
    };
  }

  async function resolveSibnetMp4(videoId, session) {
    const shellUrl = SIBNET + '/shell.php?videoid=' + videoId;
    const page = await requestText(shellUrl, { Referer: SITE + '/' }, session);
    if (!page.ok) throw new Error('Mugiwara: Sibnet shell request failed (HTTP ' + page.status + ')');

    const m = page.text.match(/"(\/v\/[a-zA-Z0-9_\/-]+\.mp4)"/)
      || page.text.match(/'(\/v\/[a-zA-Z0-9_\/-]+\.mp4)'/)
      || page.text.match(/src:\s*"(\/v\/[^"]+\.mp4)"/);
    if (!m) throw new Error('Mugiwara: Sibnet stream unavailable or removed for video ' + videoId);

    const relativePath = m[1];
    const frontRouterUrl = SIBNET + relativePath;

    let directCdnUrl = frontRouterUrl;
    let probeHeaders = {
      'User-Agent': USER_AGENT,
      Referer: shellUrl,
      Origin: SIBNET,
      Range: 'bytes=0-1',
    };

    if (typeof fetchv2 === 'function') {
      try {
        if (session && (session.closed || Date.now() >= session.deadline)) throw new Error('Lookup expired');
        const probeRes = await fetchv2(frontRouterUrl, probeHeaders, 'GET', null, { followRedirects: false });
        const location = probeRes && probeRes.headers && (probeRes.headers.location || probeRes.headers.Location);
        if (location && /^(?:https?:)?\/\//i.test(location)) {
          directCdnUrl = absoluteUrl(location, frontRouterUrl);
        }
      } catch (_) {}
    } else if (typeof fetch === 'function') {
      try {
        const probeRes = await fetch(frontRouterUrl, {
          method: 'GET',
          headers: probeHeaders,
          redirect: 'manual',
        });
        const location = probeRes.headers.get('location');
        if (location && /^(?:https?:)?\/\//i.test(location)) {
          directCdnUrl = absoluteUrl(location, frontRouterUrl);
        }
      } catch (_) {}
    }

    const authorizedHeaders = {
      'User-Agent': USER_AGENT,
      Referer: shellUrl,
      Origin: SIBNET,
    };

    await checkedMedia(directCdnUrl, authorizedHeaders, session, false);
    return {
      url: directCdnUrl,
      headers: authorizedHeaders,
      streamType: 'mp4',
      quality: 'Auto',
      serverName: 'Sibnet',
      streams: [
        { label: 'Sibnet', url: directCdnUrl, headers: authorizedHeaders },
      ],
      qualities: [
        { label: 'Auto', url: directCdnUrl, headers: authorizedHeaders },
      ],
    };
  }

  async function resolveSingleCandidate(targetUrl, session) {
    if (!targetUrl) throw new Error('Empty candidate URL');
    if (targetUrl.startsWith('mugi-embed:')) targetUrl=targetUrl.slice('mugi-embed:'.length);
    if (targetUrl.startsWith('mugi-sibnet:')) {
      const vid = targetUrl.slice('mugi-sibnet:'.length);
      return await resolveSibnetMp4(vid, session);
    }
    if (targetUrl.includes('sibnet.ru')) {
      const vid = sibnetVideoId(targetUrl);
      if (vid) return await resolveSibnetMp4(vid, session);
    }
    if (targetUrl.includes('ansembed.net') || targetUrl.includes('ansplayer.com')) {
      return await resolveAnsembed(targetUrl, session);
    }
    if (/^https?:\/\/[^?#]+\.mp4(?:[?#]|$)/i.test(targetUrl)) {
      await checkedMedia(targetUrl, { 'User-Agent': USER_AGENT, Referer: SITE + '/' }, session, false);
      return {
        url: targetUrl,
        headers: { 'User-Agent': USER_AGENT, Referer: SITE + '/' },
        streamType: 'mp4',
        quality: 'Auto',
        streams: [{ label: 'Web Stream', url: targetUrl, headers: { 'User-Agent': USER_AGENT, Referer: SITE + '/' } }],
        qualities: [{ label: 'Auto', url: targetUrl, headers: { 'User-Agent': USER_AGENT, Referer: SITE + '/' } }],
      };
    }
    throw new Error('Unsupported URL format ' + targetUrl);
  }

  async function extractStreamUrl(episodeHref, lang) {
    const raw = String(episodeHref || '').trim();
    if (!raw) throw new Error('Mugiwara: extractStreamUrl received empty href');

    let candidates = [];
    if (raw.startsWith('mugi-dual:')) {
      const jsonBlob = raw.slice('mugi-dual:'.length);
      let parsed = null;
      try { parsed = JSON.parse(jsonBlob); } catch (_) {}
      if (parsed) {
        const isDub = String(lang || '').toLowerCase() === 'dub';
        const primary = isDub ? (parsed.dub || []) : (parsed.sub || []);

        const toList = (x) => Array.isArray(x) ? x : (x ? [x] : []);
        candidates = toList(primary);
      }
    } else {
      candidates = [raw];
    }

    if (!candidates.length) {
      throw new Error('Mugiwara: requested ' + String(lang || 'sub').toUpperCase() + ' stream is not available for this episode');
    }

    candidates = [...new Set(candidates.filter(x=>typeof x==='string'))];
    const session={closed:false,deadline:Date.now()+24000};
    const results=new Array(candidates.length);let cursor=0;
    async function worker(){while(cursor<candidates.length&&!session.closed&&Date.now()<session.deadline){const i=cursor++;try{results[i]=await resolveSingleCandidate(candidates[i],session);}catch(_){} }}
    let timer;
    await Promise.race([Promise.all([worker(),worker()]),new Promise(resolve=>{timer=setTimeout(resolve,24000);})]);
    if (typeof clearTimeout === 'function') clearTimeout(timer);
    session.closed=true;
    const found=results.filter(x=>x&&x.url);
    if (!found.length) return {streams:[],subtitles:[],error:{message:'Mugiwara: no validated server available for this episode and language.'}};
    const primary=found[0], seen=new Set();
    const servers=found.filter(x=>{if(seen.has(x.url))return false;seen.add(x.url);return true;}).map(x=>({name:x.serverName||'Direct',url:x.url,headers:x.headers,streamType:x.streamType,qualities:x.qualities,subtitles:x.subtitles||[],lang:String(lang||'sub')}));
    return Object.assign({},primary,{servers,subtitles:primary.subtitles||[],lang:String(lang||'sub')});
  }

  // ---------- discovery ----------

  async function discoveryHome() {
    const items = await fetchCatalogue();
    const byCat = {};
    for (const item of items) {
      const cat = item.category || 'Catalogue';
      (byCat[cat] = byCat[cat] || []).push(item);
    }

    const popularTitles = ['one-piece', 'solo-leveling', 'bleach', 'lattaque-des-titans', 'naruto-shippuden', 'chainsaw-man', 'dan-da-dan', 'jujutsu-kaisen'];
    const heroItems = [];
    for (const slug of popularTitles) {
      const found = items.find((i) => i.slug === slug);
      if (found) heroItems.push(found);
    }
    if (heroItems.length < 5) {
      for (const item of items.slice(0, 8)) {
        if (!heroItems.includes(item)) heroItems.push(item);
      }
    }

    const filmItems = items.filter((i) => (i.disponibles || []).includes('Films') || (i.category || '').toLowerCase().includes('film'));

    const sections = [];

    // 1. Hero Featured Carousel
    sections.push({
      id: 'featured_trending',
      title: '\u00c0 l\x27affiche (Tendances VOSTFR & VF)',
      style: 'hero',
      viewAll: { mode: 'feed', feedId: 'featured' },
      items: heroItems.slice(0, 8).map((i) => ({
        href: SITE + '/catalogue/' + i.slug,
        id: i.slug,
        title: i.title,
        image: i.image,
        poster: i.image,
      })),
    });

    // 2. Top 10 Popular
    const top10 = items.slice(0, 10);
    sections.push({
      id: 'top10_populaires',
      title: 'Top 10 Animes Populaires',
      style: 'top10',
      viewAll: { mode: 'feed', feedId: 'top10' },
      items: top10.map((i) => ({
        href: SITE + '/catalogue/' + i.slug,
        id: i.slug,
        title: i.title,
        image: i.image,
        poster: i.image,
      })),
    });

    // 3. Films d'Animation
    if (filmItems.length) {
      sections.push({
        id: 'films_animation',
        title: 'Films d\x27Animation & Longs-m\u00e9trages',
        style: 'poster',
        viewAll: { mode: 'feed', feedId: 'films' },
        items: filmItems.slice(0, 24).map((i) => ({
          href: SITE + '/catalogue/' + i.slug,
          id: i.slug,
          title: i.title,
          image: i.image,
          poster: i.image,
        })),
      });
    }

    // 4. Categorized Discovery Sections
    const cats = Object.keys(byCat).sort((a, b) => b.length - a.length);
    for (const cat of cats.slice(0, 5)) {
      if (cat === 'Catalogue') continue;
      const cleanId = 'cat_' + cat.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40);
      sections.push({
        id: cleanId,
        title: cat,
        style: 'poster',
        viewAll: { mode: 'feed', feedId: cat },
        items: byCat[cat].slice(0, 24).map((i) => ({
          href: SITE + '/catalogue/' + i.slug,
          id: i.slug,
          title: i.title,
          image: i.image,
          poster: i.image,
        })),
      });
    }

    // The app extends the final poster/feed section vertically on Home.
    // Category rows alone eventually exhaust a small subset of the catalogue.
    sections.push({
      id: 'catalogue_all', title: 'Tous les animes', style: 'poster',
      viewAll: { mode: 'feed', feedId: 'all' },
      items: items.slice(0, 24).map(i => ({
        href: SITE + '/catalogue/' + i.slug, id: i.slug,
        title: i.title, image: i.image, poster: i.image,
      })),
    });
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    const pageNumber = Math.max(1, Number(page) || 1);
    const items = await fetchCatalogue();
    const target = String(feedId || '').toLowerCase();

    let filtered = items;
    if (target === 'films') {
      filtered = items.filter((i) => (i.disponibles || []).includes('Films') || (i.category || '').toLowerCase().includes('film'));
    } else if (target === 'top10' || target === 'featured' || target === 'all') {
      filtered = items;
    } else if (target) {
      const match = items.filter((i) => (i.category || '').toLowerCase() === target);
      if (match.length) filtered = match;
    }

    const pageSize = 24;
    const offset = (pageNumber - 1) * pageSize;
    const slice = filtered.slice(offset, offset + pageSize);

    return {
      items: slice.map((i) => ({
        href: SITE + '/catalogue/' + i.slug,
        id: i.slug,
        title: i.title,
        image: i.image,
        poster: i.image,
      })),
      page: pageNumber,
      hasMore: offset + slice.length < filtered.length,
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
      searchResults,
      extractDetails,
      extractEpisodes,
      extractStreamUrl,
      discoveryHome,
      discoveryFeed,
    };
  }
})();
