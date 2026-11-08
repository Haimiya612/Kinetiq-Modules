(() => {
  'use strict';

  const MODULE_NAME = 'KickAssAnime';
  const BASE_URL = 'https://kaa.lt';
  const IMG_BASE = BASE_URL + '/image/poster/';
  const KRUSS_ORIGIN = 'https://krussdomi.com';
  const MAX_EPISODES = 1500;
  const PAGE_FETCH_TIMEOUT_MS = 9000;
  const EMBED_TIMEOUT_MS = 8000;
  const STREAM_DEADLINE_MS = 18000;

  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  const defaultHeaders = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    Referer: BASE_URL + '/',
    Origin: BASE_URL,
  };

  const HLS_HEADERS = {
    'User-Agent': USER_AGENT,
    Referer: KRUSS_ORIGIN + '/',
    Origin: KRUSS_ORIGIN,
    Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp4,*/*',
  };

  const searchResultCache = {};
  const showCache = {};
  const catalogCache = {};
  let catalogMaxPage = 0;

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
    return Promise.race([promise, sleep(waitMs).then(function () { return typeof fallback === 'function' ? fallback() : fallback; })]);
  }

  function decodeHtml(str) {
    return String(str || '')
      .replace(/\\u([0-9a-f]{4})/gi, function (_, h) {
        return String.fromCharCode(parseInt(h, 16));
      })
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#038;/g, '&')
      .replace(/^"|"$/g, '')
      .trim();
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
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

  async function request(url, options) {
    const cfg = options || {};
    const method = cfg.method || 'GET';
    const headers = Object.assign({}, defaultHeaders, cfg.headers || {});
    let body = cfg.body == null ? null : cfg.body;
    if (body && typeof body === 'object') {
      body = JSON.stringify(body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
    const fetchOpts = {};
    if (cfg.followRedirects === false) fetchOpts.followRedirects = false;

    try {
      if (typeof fetchv2 === 'function') {
        const res = await fetchv2(url, headers, method, body, fetchOpts);
        const status = Number((res && res.status) || 0);
        const textBody = await readResponseBody(res);
        const hdrs = headerMap(res && res.headers);
        return {
          ok: isResponseOk(res, status),
          status,
          body: textBody,
          json: await readResponseJson(res, textBody),
          headers: hdrs,
          finalUrl: (res && res.finalUrl) || '',
        };
      }

      if (typeof fetch === 'function') {
        const res = await fetch(url, {
          method,
          headers,
          body,
          redirect: cfg.followRedirects === false ? 'manual' : 'follow',
        });
        const textBody = await res.text();
        return {
          ok: !!res.ok,
          status: Number(res.status || 0),
          body: textBody,
          json: safeJsonParse(textBody),
          headers: headerMap(res.headers),
          finalUrl: res.url || '',
        };
      }

      return { ok: false, status: 0, body: '', json: null, headers: {}, finalUrl: '' };
    } catch (error) {
      log('request error: ' + (error && error.message ? error.message : String(error)));
      return { ok: false, status: 0, body: '', json: null, headers: {}, finalUrl: '' };
    }
  }

  function buildPosterUrl(poster) {
    if (!poster) return '';
    const key = poster.hq || poster.sm || '';
    if (!key) return '';
    return IMG_BASE + key + '.webp';
  }

  function cardFromItem(item) {
    const slug = String((item && item.slug) || '').trim();
    if (!slug) return null;
    return {
      title: decodeHtml((item && (item.title_en || item.title)) || slug),
      href: slug,
      image: buildPosterUrl(item && item.poster),
      year: item && item.year ? String(item.year) : null,
      type: (item && item.type) || null,
    };
  }

  function normalizeSlug(href) {
    const parsed = parseEpisodeRef(href);
    return parsed.slug || '';
  }

  function slugifyQuery(query) {
    return String(query || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function normForMatch(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[’'`´:;.!?&,+()\[\]{}<>/\\|–—"]/g, ' ')
      .replace(/[\u2010-\u2015\u00b7]/g, ' ')
      .replace(/\bs\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactForMatch(value) {
    return normForMatch(value).replace(/[^a-z0-9]/g, '');
  }

  function isLowValueTitle(item) {
    const title = decodeHtml((item && (item.title_en || item.title)) || '').toLowerCase();
    const type = String((item && item.type) || '').toLowerCase();
    if (type === 'cm') return true;
    return /\b(recaps?|digest|collab|campaign|snickers|picture drama)\b/i.test(title);
  }

  function rankSearchItem(item, query) {
    const q = String(query || '').trim().toLowerCase();
    const slugQ = slugifyQuery(q);
    const normQ = normForMatch(q);
    const compactQ = compactForMatch(q);
    const title = decodeHtml((item && (item.title || item.title_en)) || '').toLowerCase();
    const titleEn = decodeHtml((item && (item.title_en || item.title)) || '').toLowerCase();
    const slug = String((item && item.slug) || '').toLowerCase();
    const type = String((item && item.type) || '').toLowerCase();
    if (!q) return 5;
    if (isLowValueTitle(item)) return 14;
    if (item && item._noLocales) return 13;

    const titleNorm = normForMatch(title);
    const titleEnNorm = normForMatch(titleEn);
    const titleCompact = compactForMatch(title);
    const slugCompact = compactForMatch(slug);

    if (compactQ && compactQ.length >= 3) {
      if (titleEnNorm === normQ || titleNorm === normQ || titleCompact === compactQ) {
        if (type === 'tv' || type === 'ona' || type === 'ova') return 0;
        return 1;
      }
      if (/\(2011\)/.test(titleEn) && compactQ === 'hunterxhunter') return 0;
      if (titleCompact.includes(compactQ) && compactQ.length >= 4) return 2;
    }
    if (slug === slugQ) return 3;
    if (new RegExp('^' + slugQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-z0-9]+$').test(slug)) {
      return 4;
    }
    if (titleEnNorm.includes(normQ) || titleNorm.includes(normQ)) return 5;
    if (slugCompact.includes(compactQ) && compactQ.length >= 3) return 6;
    if (titleEn.includes(q) || title.includes(q)) return 7;
    if (slug.startsWith(slugQ + '-')) return 8;
    if (slug.includes(slugQ)) return 9;
    return 10;
  }

  function sortSearchItems(items, query) {
    const ranked = [];
    const seen = new Set();
    for (let i = 0; i < (items || []).length; i += 1) {
      const item = items[i];
      const slug = String((item && item.slug) || '').trim();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      ranked.push({
        item: item,
        rank: rankSearchItem(item, query),
        slugLen: slug.length,
      });
    }
    ranked.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.slugLen - b.slugLen;
    });
    const out = [];
    for (let i = 0; i < ranked.length && out.length < 30; i += 1) {
      const card = cardFromItem(ranked[i].item);
      if (card) out.push(card);
    }
    return orderSeasonFamilies(out);
  }

  /* Season-aware ordering: a show-name search must surface every season in order. The catalogue's
   * own ranking interleaves seasons with movies/OVAs/specials, so on a phone the first screenful
   * can hide Season 2+ and users type the season explicitly. Group season/part variants of the
   * same series (familyKey) and order them naturally after their best-ranked member; unrelated
   * results keep their rank order. */
  function seasonNumberOf(title) {
    const t = String(title || '').toLowerCase();
    if (/\b(?:the\s+)?final\s+season\b/.test(t)) return 99;
    let m = t.match(/\bseason\s*(\d+)/) || t.match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/);
    if (m) return parseInt(m[1], 10);
    m = t.match(/\b(iii|iv|v)\b/);
    if (m) return { iii: 3, iv: 4, v: 5 }[m[1]];
    if (/\bii\b/.test(t)) return 2;
    return 1;
  }

  function partNumberOf(title) {
    const t = String(title || '').toLowerCase();
    const m = t.match(/\bpart\s*(\d+)/) || t.match(/\bcour\s*(\d+)/);
    return m ? Math.max(parseInt(m[1], 10) - 1, 0) : 0;
  }

  function isExtraTitle(title, type) {
    const ty = String(type || '').toLowerCase();
    if (ty === 'movie' || ty === 'ova' || ty === 'special' || ty === 'tv_special' || ty === 'oad') return true;
    return /\b(ova|oad|special|movie|recap|film|picture drama)\b/.test(String(title || '').toLowerCase());
  }

  function orderSeasonFamilies(cards) {
    if (!cards || cards.length < 2) return cards || [];
    const groups = [];
    const index = {};
    for (let i = 0; i < cards.length; i += 1) {
      const key = familyKey(cards[i].title) || '~' + i;
      if (!index[key]) {
        index[key] = { min: i, items: [] };
        groups.push(index[key]);
      }
      index[key].items.push({ i: i, card: cards[i] });
    }
    for (let g = 0; g < groups.length; g += 1) {
      groups[g].items.sort(function (a, b) {
        const sa = isExtraTitle(a.card.title, a.card.type) ? 1 : 0;
        const sb = isExtraTitle(b.card.title, b.card.type) ? 1 : 0;
        if (sa !== sb) return sa - sb;
        if (sa === 0) {
          const na = seasonNumberOf(a.card.title);
          const nb = seasonNumberOf(b.card.title);
          if (na !== nb) return na - nb;
          const pa = partNumberOf(a.card.title);
          const pb = partNumberOf(b.card.title);
          if (pa !== pb) return pa - pb;
        }
        return a.i - b.i;
      });
    }
    groups.sort(function (a, b) { return a.min - b.min; });
    const ordered = [];
    for (let g2 = 0; g2 < groups.length; g2 += 1) {
      for (let j = 0; j < groups[g2].items.length; j += 1) ordered.push(groups[g2].items[j].card);
    }
    return ordered;
  }

  async function fetchCatalogPage(page) {
    if (catalogCache[page] !== undefined) return catalogCache[page];
    const res = await settleWithin(
      request(BASE_URL + '/api/anime?page=' + page + '&perPage=30', {
        headers: { Accept: 'application/json' },
      }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    if (!res || !res.ok || !res.json || !Array.isArray(res.json.result)) {
      delete catalogCache[page];
      return null;
    }
    catalogCache[page] = res.json.result;
    const maxPage = Number(res.json.maxPage || 0);
    if (maxPage > catalogMaxPage) catalogMaxPage = maxPage;
    return res.json.result;
  }

  async function fsearch(query, page) {
    const res = await settleWithin(
      request(BASE_URL + '/api/fsearch', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: { query: String(query || ''), page: Math.max(1, Number(page) || 1) },
      }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    if (!res || !res.ok || !res.json) return [];
    if (Array.isArray(res.json.result)) return res.json.result;
    if (Array.isArray(res.json)) return res.json;
    return [];
  }

  async function quickSearch(query) {
    const res = await settleWithin(
      request(BASE_URL + '/api/search', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: { query: String(query || '') },
      }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    if (!res || !res.ok || !res.json) return [];
    if (Array.isArray(res.json)) return res.json;
    if (Array.isArray(res.json.result)) return res.json.result;
    return [];
  }

  async function fetchShowDetails(slug) {
    const key = String(slug || '').trim();
    if (!key) return null;
    if (showCache[key]) return showCache[key];
    const res = await settleWithin(
      request(BASE_URL + '/api/show/' + encodeURIComponent(key), {
        headers: { Accept: 'application/json' },
      }),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    if (!res || !res.ok || !res.json || !res.json.slug) return null;
    showCache[key] = res.json;
    return res.json;
  }

  function queryVariants(query) {
    const q = String(query || '').trim();
    const lower = q.toLowerCase();
    const out = [q];
    const aliases = {
      'steins gate': ['steins;gate'],
      'fullmetal alchemist brotherhood': [
        'fullmetal alchemist: brotherhood',
        'fullmetal alchemist',
      ],
      'dr stone': ['dr. stone'],
      'mushishi': ['mushi-shi'],
      'hunter x hunter': ['hunter x hunter'],
    };
    const extra = aliases[lower] || [];
    for (let i = 0; i < extra.length; i += 1) out.push(extra[i]);
    /* The catalogue's search is literal: it matches the TITLE'S punctuation, so plain-word
     * queries for punctuated titles return nothing ("re zero" 0 hits vs "re:zero" 16,
     * "dr stone" 1 vs "dr. stone" 9, "kaguya sama love is war" 0 vs "kaguya-sama: love is war" 8).
     * Generate the common punctuation shapes from the query itself. */
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const t1 = tokens[0];
      const rest1 = tokens.slice(1).join(' ');
      out.push(t1 + ':' + rest1);
      out.push(t1 + '.' + ' ' + rest1);
      out.push(t1 + '-' + rest1);
      out.push(t1 + ';' + rest1);
      /* The canonical shapes put the colon after the MAIN title, at any word boundary
       * ("attack on titan: final season", "demon slayer: kimetsu no yaiba",
       * "spy x family: code white"), so try each candidate boundary on the raw query AND on
       * the "dr."-style normalised form. */
      const forms = [q, t1 + '. ' + rest1];
      for (let fi = 0; fi < forms.length; fi += 1) {
        const ft = forms[fi].split(/\s+/).filter(Boolean);
        const bounds = [2, 3, 4];
        for (let bi = 0; bi < bounds.length; bi += 1) {
          const b = bounds[bi];
          if (ft.length > b) {
            out.push(ft.slice(0, b).join(' ') + ': ' + ft.slice(b).join(' '));
          }
        }
      }
      if (tokens.length >= 3) {
        const t2 = tokens[1];
        const rest2 = tokens.slice(2).join(' ');
        out.push(t1 + '-' + t2 + ': ' + rest2);
      }
      /* Year-suffixed titles are stored with parentheses ("Hunter x Hunter (2011)"). */
      const last = tokens[tokens.length - 1];
      if (/^(19|20)\d{2}$/.test(last) && tokens.length >= 3) {
        out.push(tokens.slice(0, -1).join(' ') + ' (' + last + ')');
      }
    }
    if (lower.indexOf('.') < 0 && /\bdr\b/i.test(q)) {
      out.push(q.replace(/\bdr\b/i, 'dr.'));
    }
    if (lower.indexOf(';') < 0 && /\bgate\b/i.test(lower)) {
      out.push(q.replace(/\s+gate/i, ';gate'));
    }
    const uniq = [];
    const seen = {};
    for (let i = 0; i < out.length; i += 1) {
      const key = String(out[i] || '').toLowerCase();
      if (!key || seen[key]) continue;
      seen[key] = true;
      uniq.push(out[i]);
    }
    return uniq;
  }

  async function markUnplayable(items) {
    const slice = (items || []).slice(0, 8);
    await Promise.all(
      slice.map(function (item) {
        const slug = String((item && item.slug) || '').trim();
        if (!slug) return null;
        return fetchShowDetails(slug).then(function (show) {
          const locales = show && Array.isArray(show.locales) ? show.locales : [];
          item._noLocales = !locales.length;
          return show;
        });
      }),
    );
    return items;
  }

  async function searchByQuery(query) {
    const q = String(query || '').trim();
    if (!q) {
      const pageItems = await fetchCatalogPage(1);
      const out = [];
      for (let i = 0; i < (pageItems || []).length && out.length < 30; i += 1) {
        const card = cardFromItem(pageItems[i]);
        if (card) out.push(card);
      }
      return out;
    }

    const variants = queryVariants(q);
    let items = [];
    const mergedSlugs = {};
    for (let i = 0; i < variants.length; i += 1) {
      const found = await fsearch(variants[i], 1);
      for (let k = 0; k < found.length; k += 1) {
        const slug = String((found[k] && found[k].slug) || '');
        if (!slug || mergedSlugs[slug]) continue;
        mergedSlugs[slug] = true;
        items.push(found[k]);
      }
      /* Merge instead of stopping at the first variant that answers: the literal query may
       * return only a stray collab while the punctuated form carries the real show. */
      if (items.length >= 12) break;
    }
    const tailTokens = q.split(/\s+/).filter(Boolean);
    if (!items.length && tailTokens.length >= 4) {
      /* Last resort: the tail of a long query is usually still an exact substring of the
       * canonical title ("miss nagatoro" in "Don't Toy with Me, Miss Nagatoro"). */
      const tail = tailTokens.slice(-2).join(' ');
      let found = await fsearch(tail, 1);
      if (!found.length) found = await fsearch(tailTokens[tailTokens.length - 1], 1);
      for (let k = 0; k < found.length; k += 1) {
        const slug = String((found[k] && found[k].slug) || '');
        if (!slug || mergedSlugs[slug]) continue;
        mergedSlugs[slug] = true;
        items.push(found[k]);
      }
    }
    if (!items.length) items = await quickSearch(q);
    if (!items.length) {
      const direct = await fetchShowDetails(slugifyQuery(q));
      if (direct) items = [direct];
    }
    if (!items.length) {
      const pageItems = await fetchCatalogPage(1);
      const compactQ = compactForMatch(q);
      const normQ = normForMatch(q);
      items = (pageItems || []).filter(function (item) {
        const title = decodeHtml(item.title_en || item.title || '');
        return (
          compactForMatch(title).indexOf(compactQ) >= 0 ||
          normForMatch(title).indexOf(normQ) >= 0
        );
      });
    }
    await markUnplayable(items);
    const playable = items.filter(function (item) { return !item._noLocales; });
    if (playable.length) items = playable;
    return sortSearchItems(items, q);
  }

  function unescapeManifest(text) {
    let t = String(text || '');
    t = t.replace(/\\u0026/g, '&').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
    t = t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
    return t;
  }

  function familyKey(title) {
    let t = normForMatch(title);
    t = t.replace(/\b(season|part|cour|series)\s*\d+\b/g, ' ');
    t = t.replace(/\b\d+(st|nd|rd|th)\s+season\b/g, ' ');
    t = t.replace(/\b(final season|the final chapters|the missing pieces)\b/g, ' ');
    t = t.replace(/\b(movie|film|ova|oad|special|recaps?)\b/g, ' ');
    t = t.replace(/\b(ii|iii|iv)\b/g, ' ');
    t = t.replace(/\s+([1-9]|1[0-9]|20)$/g, ' ');
    return compactForMatch(t);
  }

  function uniqueCards(items, limit, usedHrefs, usedFamilies) {
    const out = [];
    const hrefs = usedHrefs || new Set();
    const families = usedFamilies || new Set();
    for (let i = 0; i < (items || []).length; i += 1) {
      const card = items[i] && items[i].href ? items[i] : cardFromItem(items[i]);
      if (!card || !card.href || hrefs.has(card.href)) continue;
      if (isLowValueTitle({ title: card.title, title_en: card.title, type: items[i] && items[i].type })) {
        continue;
      }
      const fam = familyKey(card.title);
      if (fam && families.has(fam)) continue;
      hrefs.add(card.href);
      if (fam) families.add(fam);
      out.push(card);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  function normalizeStreamUrl(url) {
    let raw = String(url || '').trim().replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    if (!raw) return '';
    raw = raw.replace(/^https:\/\/\//i, 'https://').replace(/^http:\/\/\//i, 'http://');
    if (raw.startsWith('//')) return 'https:' + raw;
    if (/^\/subbl\.|^\/subst\./i.test(raw)) return 'https://' + raw.slice(1);
    return raw;
  }

  function absoluteUrl(base, maybe) {
    const value = normalizeStreamUrl(maybe);
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    const root = String(base || '');
    try {
      return new URL(value, root).href;
    } catch (_) {
      const cut = root.lastIndexOf('/');
      return cut >= 0 ? root.slice(0, cut + 1) + value.replace(/^\//, '') : value;
    }
  }

  function extractKaaServers(html) {
    const source = decodeHtml(String(html || ''));
    const match = source.match(/servers:\[(\{.+?\}(?:,\{.+?\})*)\]/s);
    if (!match) return [];
    const raw = match[1];
    const nameMatches = [];
    const srcMatches = [];
    const nameRe = /name:"([^"]+)"/g;
    const srcRe = /src:"([^"]+)"/g;
    let nameHit = nameRe.exec(raw);
    while (nameHit) {
      nameMatches.push(nameHit[1]);
      nameHit = nameRe.exec(raw);
    }
    let srcHit = srcRe.exec(raw);
    while (srcHit) {
      srcMatches.push(srcHit[1]);
      srcHit = srcRe.exec(raw);
    }
    const servers = [];
    for (let i = 0; i < srcMatches.length; i += 1) {
      const src = normalizeStreamUrl(decodeHtml(srcMatches[i]));
      if (!src || !src.startsWith('http')) continue;
      const name = nameMatches[i] ? decodeHtml(nameMatches[i]) : 'Server ' + (i + 1);
      const isDash = /[?&]type=dash\b/i.test(src) || /\/dash\b/i.test(src);
      servers.push({ name: name, src: src, dash: isDash });
    }
    servers.sort(function (a, b) {
      if (a.dash !== b.dash) return a.dash ? 1 : -1;
      const aVid = /vidstream/i.test(a.name + a.src) ? 0 : 1;
      const bVid = /vidstream/i.test(b.name + b.src) ? 0 : 1;
      return aVid - bVid;
    });
    return servers;
  }

  function pickStreamFromHtml(html) {
    const text = unescapeManifest(decodeHtml(String(html || '')));
    const manifestMatch =
      text.match(/"manifest"\s*:\s*\[[^\]]*"(https?:\/\/[^"]+?\.m3u8[^"]*)"/i) ||
      text.match(/"manifest"\s*:\s*\[[^\]]*"(\/\/[^"]+?\.m3u8[^"]*)"/i) ||
      text.match(/manifest\s*:\s*\[[^\]]*"(https?:\/\/[^"]+?\.m3u8[^"]*)"/i) ||
      text.match(/manifest\s*:\s*\[[^\]]*"(\/\/[^"]+?\.m3u8[^"]*)"/i);
    if (manifestMatch && manifestMatch[1]) {
      return { url: normalizeStreamUrl(manifestMatch[1]), streamType: 'hls' };
    }
    const m3u8 =
      text.match(/https?:\/\/[^"'\s<>]+?\.m3u8(?:\?[^"'\s<>]*)?/i) ||
      text.match(/\/\/[a-z0-9.-]+\/[^"'\s<>]+?\.m3u8(?:\?[^"'\s<>]*)?/i);
    if (m3u8 && m3u8[0]) return { url: normalizeStreamUrl(m3u8[0]), streamType: 'hls' };
    const mp4 =
      text.match(/https?:\/\/[^"'\s<>]+?\.mp4(?:\?[^"'\s<>]*)?/i) ||
      text.match(/\/\/[a-z0-9.-]+\/[^"'\s<>]+?\.mp4(?:\?[^"'\s<>]*)?/i);
    if (mp4 && mp4[0]) return { url: normalizeStreamUrl(mp4[0]), streamType: 'mp4' };
    return null;
  }

  function pickSubtitlesFromHtml(html, embedUrl) {
    const text = unescapeManifest(decodeHtml(String(html || '')));
    const found = [];
    const seen = new Set();
    function pushSub(url, language, label) {
      const cleaned = normalizeStreamUrl(url);
      if (!cleaned || !/^https?:\/\//i.test(cleaned) || seen.has(cleaned)) return;
      if (!/\.(srt|vtt)(\?|$)/i.test(cleaned)) return;
      seen.add(cleaned);
      found.push({
        url: cleaned,
        file: cleaned,
        language: String(language || 'und').toLowerCase(),
        label: decodeHtml(label || language || 'Unknown language'),
        kind: 'captions',
      });
    }
    // Provider records may use Astro's [type, value] serialization.
    // Parse each complete record so adjacent tracks cannot exchange labels.
    function scalar(value) {
      if (Array.isArray(value) && value.length === 2 && value[0] === 0) return value[1];
      return value;
    }
    const re = /\{[^{}]*\}/g;
    let match;
    while ((match = re.exec(text))) {
      const record = safeJsonParse(match[0]);
      if (!record) continue;
      const url = scalar(record.src || record.file || record.url);
      const language = scalar(record.language || record.srclang || record.lang);
      const label = scalar(record.name || record.label);
      if (typeof url !== 'string') continue;
      pushSub(url, typeof language === 'string' ? language : '', typeof label === 'string' ? label : '');
    }
    const loose = text.match(/https?:\/\/\/?[^\s"']+\.(?:vtt|srt)(?:\?[^\s"']*)?/gi) || [];
    for (let i = 0; i < loose.length; i += 1) {
      pushSub(loose[i], 'und', 'Unknown language');
    }
    void embedUrl;
    return found;
  }

  function parseAudioLanguages(masterBody) {
    const languages = [];
    const re = /#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO[^\r\n]*/gi;
    let match;
    while ((match = re.exec(String(masterBody || '')))) {
      const line = match[0];
      const lang = ((line.match(/LANGUAGE\s*=\s*"([^"]+)"/i) || [])[1] || '').toLowerCase();
      const name = ((line.match(/NAME\s*=\s*"([^"]+)"/i) || [])[1] || '').toLowerCase();
      const isDefault = /DEFAULT\s*=\s*YES/i.test(line);
      languages.push({ lang: lang, name: name, isDefault: isDefault, line: line });
    }
    return languages;
  }

  function hasEnglishAudio(languages) {
    for (let i = 0; i < (languages || []).length; i += 1) {
      const item = languages[i];
      if (
        /^(en|eng|english)(-|$)/i.test(item.lang) ||
        item.name === 'english' ||
        item.name.indexOf('english') >= 0
      ) {
        return true;
      }
    }
    return false;
  }

  function hasJapaneseAudio(languages) {
    for (let i = 0; i < (languages || []).length; i += 1) {
      const item = languages[i];
      if (
        /^(ja|jp|jpn|japanese)(-|$)/i.test(item.lang) ||
        item.name === 'japanese' ||
        item.name.indexOf('japanese') >= 0
      ) {
        return true;
      }
    }
    return false;
  }

  async function resolveRedirect(url, headers) {
    const raw = String(url || '').trim();
    if (!raw) return raw;
    const res = await settleWithin(
      request(raw, {
        headers: Object.assign({}, headers || {}, { Range: 'bytes=0-1' }),
        followRedirects: false,
      }),
      5000,
      null,
    );
    if (!res) return raw;
    const loc = (res.headers && (res.headers.location || res.headers.Location)) || '';
    if (loc) return absoluteUrl(raw, loc);
    if (res.finalUrl && /^https?:\/\//i.test(res.finalUrl) && res.finalUrl !== raw) {
      return res.finalUrl;
    }
    return raw;
  }

  async function inspectMaster(url) {
    const res = await settleWithin(
      request(url, { headers: HLS_HEADERS }),
      EMBED_TIMEOUT_MS,
      null,
    );
    if (!res || !res.body || String(res.body).indexOf('#EXTM3U') < 0) return null;
    const languages = parseAudioLanguages(res.body);
    return { body: res.body, languages: languages, qualities: parseHlsQualities(res.body, url) };
  }

  function parseHlsQualities(body, masterUrl) {
    const lines = String(body || '').split(/\r?\n/).map(function (line) { return line.trim(); });
    const externalAudio = {};
    lines.forEach(function (line) {
      if (!/^#EXT-X-MEDIA:/i.test(line) || !/TYPE=AUDIO/i.test(line) || !/URI="[^"]+"/i.test(line)) return;
      const group = (line.match(/GROUP-ID="([^"]+)"/i) || [])[1];
      if (group) externalAudio[group] = true;
    });
    const result = [], seen = {};
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
      const height = Number((lines[i].match(/RESOLUTION=\d+x(\d+)/i) || [])[1]);
      const group = (lines[i].match(/AUDIO="([^"]+)"/i) || [])[1];
      // A child playlist alone would lose separately delivered audio.
      if (!height || externalAudio[group]) continue;
      let j = i + 1;
      while (j < lines.length && !lines[j]) j += 1;
      if (j >= lines.length || lines[j].charAt(0) === '#') continue;
      const url = absoluteUrl(masterUrl, lines[j]);
      if (!/^https?:\/\//i.test(url) || seen[height]) continue;
      seen[height] = true;
      result.push({ label: height + 'p', url: url });
    }
    return result.sort(function (a, b) { return parseInt(b.label, 10) - parseInt(a.label, 10); });
  }

  function playbackPayload(entries, label) {
    if (!entries.length) return { streams: [] };
    const primary = entries[0];
    const streams = ['Auto', primary.url];
    (primary.qualities || []).forEach(function (quality) { streams.push(quality.label, quality.url); });
    return {
      streams: streams, url: primary.url, lang: label, quality: 'auto',
      streamType: primary.streamType, headers: primary.headers,
      subtitles: primary.subtitles || [], audioLanguages: primary.audioLanguages || [],
      servers: entries.map(function (entry) {
        return { name: entry.name, url: entry.url, lang: label, streamType: entry.streamType,
          headers: entry.headers, subtitles: entry.subtitles || [] };
      }),
    };
  }

  function withPlayerLang(embedUrl, wantDub) {
    let url = String(embedUrl || '');
    const ln = wantDub ? 'en-US' : 'ja-JP';
    if (/[?&]ln=/i.test(url)) {
      return url.replace(/([?&]ln=)[^&]*/i, '$1' + ln);
    }
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'ln=' + ln;
  }

  async function resolveEmbedStream(embedUrl, wantDub) {
    const candidates = [];
    const rewritten = withPlayerLang(embedUrl, wantDub);
    candidates.push(rewritten);
    if (rewritten !== embedUrl) candidates.push(String(embedUrl || ''));
    let lastBody = '';
    let playerUrl = rewritten;
    let picked = null;
    for (let i = 0; i < candidates.length && !picked; i += 1) {
      playerUrl = candidates[i];
      const res = await settleWithin(
        request(playerUrl, {
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*',
            Referer: BASE_URL + '/',
            Origin: BASE_URL,
          },
        }),
        EMBED_TIMEOUT_MS,
        null,
      );
      if (!res || !res.ok || !res.body) continue;
      lastBody = res.body;
      picked = pickStreamFromHtml(res.body);
    }
    if (!picked || !picked.url) return null;
    const subtitles = pickSubtitlesFromHtml(lastBody, playerUrl);
    let streamUrl = picked.url;
    if (picked.streamType === 'mp4') {
      streamUrl = await resolveRedirect(streamUrl, {
        'User-Agent': USER_AGENT,
        Referer: playerUrl,
        Origin: KRUSS_ORIGIN,
        Range: 'bytes=0-1',
      });
    }
    const inspection =
      picked.streamType === 'hls' ? await inspectMaster(streamUrl) : { languages: [] };
    if (picked.streamType === 'hls' && !inspection) return null;
    const languages = (inspection && inspection.languages) || [];
    return {
      url: streamUrl,
      streamType: picked.streamType,
      headers: Object.assign({}, HLS_HEADERS),
      subtitles: subtitles,
      audioLanguages: languages.map(function (item) {
        return item.lang || item.name;
      }),
      qualities: (inspection && inspection.qualities) || [],
      hasEnglishAudio: hasEnglishAudio(languages),
      hasJapaneseAudio: hasJapaneseAudio(languages) || languages.length === 0,
    };
  }

  function parseEpisodeRef(raw) {
    let value = String(raw || '').trim();
    if (!value) return { slug: '', epSlug: '', epString: '', ja: '', en: '' };
    if (
      (value.charAt(0) === '{' && value.charAt(value.length - 1) === '}') ||
      (value.charAt(0) === '"' && value.indexOf('{') >= 0)
    ) {
      const json = safeJsonParse(value.charAt(0) === '"' ? safeJsonParse(value) || value : value);
      if (json && typeof json === 'object') {
        return {
          slug: String(json.s || json.slug || '').replace(/^\//, ''),
          epSlug: String(json.ep || json.ja || json.en || ''),
          epString: String(json.e || json.n || ''),
          ja: String(json.ja || ''),
          en: String(json.en || ''),
        };
      }
    }
    value = value.replace(/^https?:\/\/[^/]+/i, '');
    let query = '';
    const qIdx = value.indexOf('?');
    if (qIdx >= 0) {
      query = value.slice(qIdx + 1);
      value = value.slice(0, qIdx);
    }
    value = value.replace(/^\//, '');
    const parts = value.split('/');
    const slug = parts[0] || '';
    const epPart = parts[1] || '';
    const epMatch = epPart.match(/^ep-([^-]+)(?:-(.+))?$/i);
    const params = {};
    query.split('&').forEach(function (pair) {
      const bits = pair.split('=');
      if (bits[0]) params[decodeURIComponent(bits[0])] = decodeURIComponent(bits[1] || '');
    });
    return {
      slug: slug,
      epSlug: epMatch ? String(epMatch[2] || '') : '',
      epString: epMatch ? String(epMatch[1] || '') : '',
      ja: params.ja || '',
      en: params.en || '',
    };
  }

  function buildEpisodeHref(slug, epString, jaSlug, enSlug) {
    const primary = jaSlug || enSlug || '';
    let href = '/' + slug + '/ep-' + epString + (primary ? '-' + primary : '');
    const q = [];
    if (jaSlug) q.push('ja=' + encodeURIComponent(jaSlug));
    if (enSlug) q.push('en=' + encodeURIComponent(enSlug));
    if (q.length) href += '?' + q.join('&');
    return href;
  }

  async function searchResults(query, page) {
    const q = String(query == null ? '' : query).trim();
    const pageNumber = Math.max(1, Number(page) + 1 || 1);
    const cacheKey = 'q:' + q;
    try {
      let all = searchResultCache[cacheKey];
      if (!all) {
        all = await searchByQuery(q);
        searchResultCache[cacheKey] = all;
      }
      if (pageNumber <= 1) return all;
      if (q) {
        const extra = await fsearch(q, pageNumber);
        return sortSearchItems(extra, q);
      }
      const start = (pageNumber - 1) * 30;
      return all.slice(start, start + 30);
    } catch (e) {
      log('search error: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  async function extractDetails(urlOrId) {
    const slug = normalizeSlug(urlOrId);
    if (!slug) {
      return { title: 'Unknown', description: 'No description available.' };
    }
    const data = await fetchShowDetails(slug);
    if (data) {
      const locales = Array.isArray(data.locales) ? data.locales : [];
      return {
        title: decodeHtml(data.title_en || data.title || slug),
        description: decodeHtml(data.synopsis || ''),
        airdate: data.year ? String(data.year) : '',
        image: buildPosterUrl(data.poster),
        locales: locales,
      };
    }
    return { title: slug, description: 'No description available.' };
  }

  async function fetchEpisodesPage(slug, page, lang) {
    const res = await settleWithin(
      request(
        BASE_URL +
          '/api/show/' +
          encodeURIComponent(slug) +
          '/episodes?page=' +
          page +
          '&lang=' +
          encodeURIComponent(lang),
        { headers: { Accept: 'application/json' } },
      ),
      PAGE_FETCH_TIMEOUT_MS,
      null,
    );
    if (!res || !res.ok || !res.json) return null;
    return res.json;
  }

  async function fetchAllEpisodeRows(slug, lang) {
    const first = await fetchEpisodesPage(slug, 1, lang);
    if (!first || !Array.isArray(first.result) || !first.result.length) return [];
    const rows = first.result.slice();
    const pagesN = Array.isArray(first.pages) ? first.pages.length : 1;
    const remaining = [];
    for (let page = 2; page <= pagesN && page <= 40; page += 1) remaining.push(page);
    for (let i = 0; i < remaining.length; i += 4) {
      const batch = remaining.slice(i, i + 4);
      const parts = await Promise.all(
        batch.map(function (page) {
          return fetchEpisodesPage(slug, page, lang);
        }),
      );
      for (let p = 0; p < parts.length; p += 1) {
        if (parts[p] && Array.isArray(parts[p].result)) rows.push.apply(rows, parts[p].result);
      }
    }
    return rows;
  }

  function rowEpisodeNumber(row) {
    const n = Number(row && (row.episode_number || row.episodeNumber));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  async function extractEpisodes(seriesId) {
    const slug = normalizeSlug(seriesId);
    if (!slug) return [];

    const pair = await Promise.all([
      fetchAllEpisodeRows(slug, 'ja-JP'),
      fetchAllEpisodeRows(slug, 'en-US'),
    ]);
    const subRows = pair[0] || [];
    const dubRows = pair[1] || [];
    const byNumber = {};

    function absorb(rows, langKey) {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const epNum = rowEpisodeNumber(row);
        if (epNum < 1) continue;
        const epSlug = String(row.slug || '').trim();
        const epString = String(row.episode_string || String(epNum));
        if (!byNumber[epNum]) {
          byNumber[epNum] = {
            number: epNum,
            epString: epString,
            title: String(row.title || '').trim(),
            ja: '',
            en: '',
          };
        }
        if (langKey === 'ja' && epSlug) byNumber[epNum].ja = epSlug;
        if (langKey === 'en' && epSlug) byNumber[epNum].en = epSlug;
        if (!byNumber[epNum].title && row.title) {
          byNumber[epNum].title = String(row.title).trim();
        }
      }
    }
    absorb(subRows, 'ja');
    absorb(dubRows, 'en');

    const numbers = Object.keys(byNumber)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      });
    const dubSamples = [];
    for (let i = 0; i < numbers.length && dubSamples.length < 2; i += 1) {
      const row = byNumber[numbers[i]];
      if (row.en) dubSamples.push(row);
    }
    for (let i = numbers.length - 1; i >= 0 && dubSamples.length < 2; i -= 1) {
      const row = byNumber[numbers[i]];
      if (row.en && dubSamples.indexOf(row) < 0) dubSamples.push(row);
    }
    let dubPlayersExist = dubSamples.length === 0;
    for (let i = 0; i < dubSamples.length; i += 1) {
      const row = dubSamples[i];
      const dubPath = '/' + slug + '/ep-' + row.epString + '-' + row.en;
      const resolved = await resolveEpisodeServers(dubPath);
      if (resolved.servers && resolved.servers.length) {
        dubPlayersExist = true;
        break;
      }
    }
    if (dubSamples.length && !dubPlayersExist) dubPlayersExist = false;

    const episodes = [];
    for (let i = 0; i < numbers.length && episodes.length < MAX_EPISODES; i += 1) {
      const row = byNumber[numbers[i]];
      episodes.push({
        number: row.number,
        href: buildEpisodeHref(slug, row.epString, row.ja, row.en),
        title: row.title,
        subAvailable: !!row.ja,
        dubAvailable: !!row.en && dubPlayersExist,
      });
    }
    if (episodes.length) return episodes;

    const show = await fetchShowDetails(slug);
    const watchUri = show && show.watch_uri ? String(show.watch_uri) : '';
    if (watchUri) {
      return [
        {
          number: 1,
          href: watchUri.charAt(0) === '/' ? watchUri : '/' + watchUri,
          subAvailable: true,
          dubAvailable: Array.isArray(show.locales) && show.locales.indexOf('en-US') >= 0,
        },
      ];
    }
    return [];
  }

  async function resolveEpisodeServers(episodePath) {
    const currentPath = String(episodePath || '').trim();
    if (!currentPath) return { servers: [], epPath: '', epUrl: '' };
    const epUrl = currentPath.startsWith('http')
      ? currentPath
      : BASE_URL + (currentPath.startsWith('/') ? currentPath : '/' + currentPath);
    const epRes = await settleWithin(
      request(epUrl, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      }),
      7000,
      null,
    );
    if (!epRes || !epRes.ok || !epRes.body) return { servers: [], epPath: currentPath, epUrl: epUrl };
    return { servers: extractKaaServers(epRes.body), epPath: currentPath, epUrl: epUrl };
  }

  function episodeWatchPath(ref, wantDub) {
    const epSlug = wantDub ? ref.en || ref.ja || ref.epSlug : ref.ja || ref.en || ref.epSlug;
    if (!ref.slug) return '';
    if (!epSlug) return '/' + ref.slug;
    const epString = ref.epString || '1';
    return '/' + ref.slug + '/ep-' + epString + '-' + epSlug;
  }

  async function extractStreamUrl(episodeHref, lang) {
    const ref = parseEpisodeRef(episodeHref);
    if (!ref.slug && !String(episodeHref || '').trim()) return { streams: [] };
    const wantDub = String(lang || '').toLowerCase() === 'dub';
    const label = wantDub ? 'dub' : 'sub';
    const resolvedEntries = [];
    const deadline = Date.now() + STREAM_DEADLINE_MS - 500;

    return settleWithin(
      (async function () {
        const paths = [];
        const preferred = episodeWatchPath(ref, wantDub);
        const fallback = episodeWatchPath(ref, !wantDub);
        if (preferred) paths.push(preferred);
        if (fallback && fallback !== preferred) paths.push(fallback);
        const raw = String(episodeHref || '').trim();
        if (raw && raw.indexOf('{') !== 0) {
          const stripped = raw.replace(/^https?:\/\/[^/]+/i, '');
          const noQuery = stripped.split('?')[0];
          if (noQuery && paths.indexOf(noQuery) < 0 && paths.indexOf(noQuery.replace(/^\//, '/')) < 0) {
            paths.push(noQuery.charAt(0) === '/' ? noQuery : '/' + noQuery);
          }
        }

        const seenSrc = {};
        for (let i = 0; i < paths.length; i += 1) {
          if (Date.now() >= deadline) break;
          const resolved = await resolveEpisodeServers(paths[i]);
          const servers = (resolved && resolved.servers) || [];
          const fromDubPage = wantDub && !!ref.en && paths[i] ===
            '/' + ref.slug + '/ep-' + (ref.epString || '1') + '-' + ref.en;
          const collected = [];
          for (let s = 0; s < servers.length; s += 1) {
            const src = String(servers[s].src || '');
            if (!src || seenSrc[src]) continue;
            seenSrc[src] = true;
            collected.push(Object.assign({ fromDubPage: fromDubPage }, servers[s]));
          }
        collected.sort(function (a, b) {
          if (a.dash !== b.dash) return a.dash ? 1 : -1;
          if (!!a.fromDubPage !== !!b.fromDubPage) return a.fromDubPage ? -1 : 1;
          const aVid = /vidstream|catstream/i.test(a.name + a.src) ? 0 : 1;
          const bVid = /vidstream|catstream/i.test(b.name + b.src) ? 0 : 1;
          return aVid - bVid;
        });
        for (let s = 0; s < collected.length; s += 1) {
          if (Date.now() >= deadline) break;
          const server = collected[s];
          if (server.dash) continue;
          const embed = await resolveEmbedStream(server.src, wantDub);
          if (!embed || !embed.url) continue;
          const knownAudio = embed.audioLanguages && embed.audioLanguages.length > 0;
          if (wantDub && !embed.hasEnglishAudio && (!server.fromDubPage || knownAudio)) continue;
          if (!wantDub && knownAudio && !embed.hasJapaneseAudio) continue;
          if (resolvedEntries.some(function (entry) { return entry.url === embed.url; })) continue;
          resolvedEntries.push(Object.assign({ name: server.name || 'Server ' + (s + 1) }, embed));
        }
          // Only stop page fallback after a usable stream, not merely an embed.
          if (resolvedEntries.length) break;
        }
        return playbackPayload(resolvedEntries, label);
      })(),
      STREAM_DEADLINE_MS,
      function () { return playbackPayload(resolvedEntries, label); },
    );
  }

  /* The site's /recent and /popular pages are server-rendered with an inline payload
   * (window.KAA=(function(a,b,...){...}(...))) whose item fields keep quoted string values
   * (slug/title/title_en/poster.sm|hq) even though the object keys are minified away, so cards
   * can be recovered with a bounded window scan ending at each slug. */
  /* The inline payload's repeated strings are hoisted into the IIFE call's argument list, so an
   * item may carry title_en:C / poster:{sm:B,...} instead of a literal. Args map to the function's
   * parameter names positionally (a..z = 0..25, A..Z = 26..51 in this minifier). */
  var SSR_REF_NAMES = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function ssrPayloadArgs(text) {
    const marker = 'window.KAA=(function(';
    const at = text.indexOf(marker);
    if (at < 0) return null;
    const paramsEnd = text.indexOf(')', at + marker.length);
    if (paramsEnd < 0) return null;
    const bodyOpen = text.indexOf('{', paramsEnd);
    if (bodyOpen < 0) return null;
    let depth = 0;
    let i = bodyOpen;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (ch === '"' || ch === "'") {
        const q = ch;
        i += 1;
        while (i < text.length && text.charAt(i) !== q) {
          if (text.charAt(i) === '\\') i += 1;
          i += 1;
        }
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    if (depth !== 0) return null;
    const callOpen = text.indexOf('(', i);
    if (callOpen < 0) return null;
    /* parse the call's args (string-aware, depth-aware) */
    const args = [];
    let cur = '';
    let d2 = 0;
    let k = callOpen + 1;
    while (k < text.length) {
      const ch = text.charAt(k);
      if (ch === '"' || ch === "'") {
        const q = ch;
        cur += ch;
        k += 1;
        while (k < text.length && text.charAt(k) !== q) {
          if (text.charAt(k) === '\\') { cur += text.charAt(k); k += 1; }
          cur += text.charAt(k);
          k += 1;
        }
        cur += k < text.length ? text.charAt(k) : '';
        k += 1;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') { d2 += 1; cur += ch; } else if (ch === ')' || ch === ']' || ch === '}') {
        if (ch === ')' && d2 === 0) { args.push(cur); break; }
        d2 -= 1;
        cur += ch;
      } else if (ch === ',' && d2 === 0) { args.push(cur); cur = ''; } else { cur += ch; }
      k += 1;
    }
    return args;
  }

  function refOrLiteral(raw, args) {
    const value = String(raw == null ? '' : raw).trim();
    if (value.length === 1 && args && SSR_REF_NAMES.indexOf(value) >= 0) {
      const resolved = args[SSR_REF_NAMES.indexOf(value)];
      return resolved == null ? '' : String(resolved);
    }
    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') || (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      return value.slice(1, -1);
    }
    return value;
  }

  function cardsFromSsrPage(html, limit) {
    const text = String(html || '');
    const args = ssrPayloadArgs(text);
    const out = [];
    const seen = {};
    const slugRe = /slug:"([a-z0-9\-]+)"/g;
    let prevEnd = 0;
    let m;
    while ((m = slugRe.exec(text)) !== null) {
      const slug = m[1];
      /* Each item's own fields sit between the previous item's slug and this one (title,
       * synopsis and poster all precede the slug; only watch_uri follows), so bound the scan
       * by the previous slug instead of a fixed window - long synopses made a fixed window
       * miss the title entirely. Values may be literals or hoisted arg refs. */
      prevEnd = m.index + m[0].length;
      if (!slug || seen[slug]) continue;
      /* Title fields always precede the slug; the poster sits before the slug on /recent and
       * after it on /popular (opposite serializers), so collect poster candidates from BOTH
       * sides and keep the one sharing the longest prefix with the slug. */
      const titleWindow = text.slice(Math.max(0, m.index - 6000), m.index);
      let title = '';
      let hit = null;
      let re = /title_en:((?:"(?:[^"\\]|\\.)*")|(?:[a-zA-Z]\b))/g;
      while ((hit = re.exec(titleWindow)) !== null) title = hit[1];
      if (!title) {
        re = /title:((?:"(?:[^"\\]|\\.)*")|(?:[a-zA-Z]\b))/g;
        while ((hit = re.exec(titleWindow)) !== null) title = hit[1];
      }
      const rightWindow = text.slice(m.index + m[0].length, m.index + m[0].length + 6000);
      const posterRe = /(?:hq|sm):((?:"[a-z0-9\-]+")|(?:[a-zA-Z]\b))/g;
      const candidates = [];
      let cm = null;
      while ((cm = posterRe.exec(titleWindow)) !== null) candidates.push(cm[1]);
      posterRe.lastIndex = 0;
      while ((cm = posterRe.exec(rightWindow)) !== null) candidates.push(cm[1]);
      let bestPoster = '';
      let bestScore = 0;
      for (let ci = 0; ci < candidates.length; ci += 1) {
        const v = refOrLiteral(candidates[ci], args).replace(/"/g, '');
        if (!/^[a-z0-9\-]+$/i.test(v)) continue;
        let n = 0;
        while (n < v.length && n < slug.length && v.charAt(n) === slug.charAt(n) && n < 24) n += 1;
        if (n > bestScore) {
          bestScore = n;
          bestPoster = v;
        }
      }
      const titleText = decodeHtml(
        unescapeManifest(refOrLiteral(title, args).replace(/\\'/g, "'")),
      );
      /* Unresolved or mismatched items are skipped rather than shown as slugs / bare cards. */
      if (!titleText || titleText === slug) continue;
      if (!bestPoster || bestScore < 6) continue;
      seen[slug] = true;
      out.push({
        title: titleText,
        href: slug,
        image: IMG_BASE + bestPoster + '.webp',
      });
      if (out.length >= (limit || 24)) break;
    }
    return out;
  }

  async function discoveryHome() {
    const sections = [];
    const usedHrefs = new Set();
    const usedFamilies = new Set();
    try {
      /* Independent rows belong in ONE fan-out: a sequential home is a user-visible defect. */
      const results = await Promise.all([
        settleWithin(
          request(BASE_URL + '/api/anime_trending', { headers: { Accept: 'application/json' } }),
          PAGE_FETCH_TIMEOUT_MS,
          null,
        ),
        settleWithin(
          request(BASE_URL + '/api/schedule', { headers: { Accept: 'application/json' } }),
          PAGE_FETCH_TIMEOUT_MS,
          null,
        ),
        settleWithin(request(BASE_URL + '/recent', {}), PAGE_FETCH_TIMEOUT_MS, null),
        settleWithin(request(BASE_URL + '/popular', {}), PAGE_FETCH_TIMEOUT_MS, null),
        fetchCatalogPage(1),
      ]);
      const trendingRes = results[0];
      const scheduleRes = results[1];
      const recentRes = results[2];
      const popularRes = results[3];
      const pageItems = results[4];

      const trendingJson = trendingRes && trendingRes.json;
      const trendingList = Array.isArray(trendingJson)
        ? trendingJson
        : trendingJson && Array.isArray(trendingJson.result)
          ? trendingJson.result
          : [];

      const featured = uniqueCards(trendingList, 8, usedHrefs, usedFamilies);
      if (featured.length) {
        sections.push({ id: 'featured', title: 'Featured', style: 'hero', items: featured });
      }

      const trendingCards = uniqueCards(trendingList, 16, usedHrefs, usedFamilies);
      if (trendingCards.length) {
        sections.push({
          id: 'trending',
          title: 'Trending',
          style: 'poster',
          items: trendingCards,
          viewAll: { mode: 'feed', feedId: 'trending' },
        });
      }

      const recentCards = uniqueCards(cardsFromSsrPage(recentRes && recentRes.body, 34), 24, usedHrefs, usedFamilies);
      if (recentCards.length) {
        sections.push({
          id: 'recent',
          title: 'Recently Added',
          style: 'poster',
          items: recentCards,
          viewAll: { mode: 'feed', feedId: 'recent' },
        });
      }

      const popularCards = uniqueCards(cardsFromSsrPage(popularRes && popularRes.body, 30), 20, usedHrefs, usedFamilies);
      if (popularCards.length) {
        sections.push({
          id: 'popular',
          title: 'Popular Shows',
          style: 'poster',
          items: popularCards,
          viewAll: { mode: 'feed', feedId: 'popular' },
        });
      }

      const scheduleJson = scheduleRes && scheduleRes.json;
      const scheduleList = Array.isArray(scheduleJson)
        ? scheduleJson
        : scheduleJson && Array.isArray(scheduleJson.result)
          ? scheduleJson.result
          : [];
      const upcoming = [];
      for (let i = 0; i < scheduleList.length; i += 1) {
        if (scheduleList[i] && scheduleList[i].ts) upcoming.push(scheduleList[i]);
      }
      upcoming.sort(function (a, b) {
        return (a.ts || 0) - (b.ts || 0);
      });
      const soonCards = [];
      for (let i = 0; i < upcoming.length && soonCards.length < 16; i += 1) {
        const card = cardFromItem(upcoming[i]);
        if (card) soonCards.push(card);
      }
      const soonDeduped = uniqueCards(soonCards, 16, usedHrefs, usedFamilies);
      if (soonDeduped.length) {
        sections.push({
          id: 'coming-soon',
          title: 'Coming Soon',
          style: 'poster',
          items: soonDeduped,
          viewAll: { mode: 'feed', feedId: 'schedule' },
        });
      }

      const browseCards = uniqueCards(pageItems || [], 24, usedHrefs, usedFamilies);
      if (browseCards.length) {
        sections.push({
          id: 'browse',
          title: 'Browse',
          style: 'poster',
          items: browseCards,
          viewAll: { mode: 'feed', feedId: 'browse' },
        });
      }
    } catch (e) {
      log('discovery error: ' + (e && e.message ? e.message : String(e)));
    }
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    const key = String(feedId || '').trim().toLowerCase();
    const pageNumber = Math.max(1, Number(page) || 1);
    const items = [];
    if (key === 'trending' || key === 'trend') {
      const trendingRes = await settleWithin(
        request(BASE_URL + '/api/anime_trending', { headers: { Accept: 'application/json' } }),
        PAGE_FETCH_TIMEOUT_MS,
        null,
      );
      const trendingJson = trendingRes && trendingRes.json;
      const trendingList = Array.isArray(trendingJson)
        ? trendingJson
        : trendingJson && Array.isArray(trendingJson.result)
          ? trendingJson.result
          : [];
      for (let i = 0; i < trendingList.length; i += 1) {
        const card = cardFromItem(trendingList[i]);
        if (card) items.push(card);
      }
      return { items: items, page: 1, hasMore: false };
    }

    if (key === 'recent' || key === 'popular') {
      const res = await settleWithin(request(BASE_URL + '/' + key, {}), PAGE_FETCH_TIMEOUT_MS, null);
      const cards = cardsFromSsrPage(res && res.body, 50);
      for (let i = 0; i < cards.length; i += 1) items.push(cards[i]);
      return { items: items, page: 1, hasMore: false };
    }

    if (key === 'schedule') {
      const res = await settleWithin(
        request(BASE_URL + '/api/schedule', { headers: { Accept: 'application/json' } }),
        PAGE_FETCH_TIMEOUT_MS,
        null,
      );
      const json = res && res.json;
      const list = Array.isArray(json) ? json : json && Array.isArray(json.result) ? json.result : [];
      list.sort(function (a, b) {
        return (a.ts || 0) - (b.ts || 0);
      });
      for (let i = 0; i < list.length; i += 1) {
        const card = cardFromItem(list[i]);
        if (card) items.push(card);
      }
      return { items: items, page: 1, hasMore: false };
    }

    const pageItems = await fetchCatalogPage(pageNumber);
    if (Array.isArray(pageItems)) {
      for (let i = 0; i < pageItems.length; i += 1) {
        const card = cardFromItem(pageItems[i]);
        if (card) items.push(card);
      }
    }
    const maxPage = catalogMaxPage || pageNumber;
    return { items: items, page: pageNumber, hasMore: pageNumber < maxPage };
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
      discoveryFeed: discoveryFeed,
    };
  }
})();
