/**
 * yFlix Content Module for Synthetiq Player (Contract Version 4)
 * Target: https://yflix.ws
 */
(function () {
  'use strict';

  const MODULE_NAME = 'yFlix';
  const SITE = 'https://yflix.ws';
  const VIDEASY_API = 'https://api.speedracelight.com';
  const VIDEASY_PLAYER = 'https://player.videasy.to';
  const LOOKMOVIE_API = 'https://www.lookmovie2.to';
  const SUBS_API = 'https://one.synthetiq.uk/v1/subs';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  const VIDEASY_MAGIC = [0x6d, 0x76, 0x6d, 0x31]; // 'mvm1'
  const videasySeedCache = Object.create(null);
  const inFlightSeedMap = Object.create(null);
  const detailsCache = Object.create(null);

  function log(msg) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(msg || ''));
    } catch (_) {}
  }

  function cleanText(v) {
    return String(v == null ? '' : v)
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#(x[\da-f]+|\d+);/gi, function (_, n) {
        const num = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
        return num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : '';
      })
      .replace(/&(amp|quot|apos|nbsp|lt|gt|mdash|ndash|hellip|eacute|rsquo|lsquo|rdquo|ldquo);/g, function (_, n) {
        const map = {
          amp: '&',
          quot: '"',
          apos: "'",
          nbsp: ' ',
          lt: '<',
          gt: '>',
          mdash: '—',
          ndash: '–',
          hellip: '…',
          eacute: 'é',
          rsquo: "'",
          lsquo: "'",
          rdquo: '"',
          ldquo: '"',
        };
        return map[n] || '';
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  function decodeEntities(str) {
    return cleanText(str);
  }

  function absoluteUrl(url, base) {
    const v = String(url || '').trim().replace(/&amp;/g, '&');
    if (!v || /^(?:javascript|mailto|tel|data):/i.test(v)) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    const root = (base || SITE).match(/^https?:\/\/[^/]+/i);
    if (!root) return '';
    if (v[0] === '/') return root[0] + v;
    return (base || SITE + '/').replace(/[?#].*$/, '').replace(/[^/]*$/, '') + v;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([
      promise,
      sleep(waitMs).then(function () {
        return fallback;
      }),
    ]);
  }

  // Resolve as soon as ONE resolver yields usable streams (with a small grace window for the
  // other to join so multi-server results still merge). When none yield, wait for all — each
  // bounded by its own settleWithin cap. A dead/slow resolver no longer adds its full timeout
  // to every playback (videasy host can take the whole 15 s cap while lookmovie is ready in ~3 s).
  function firstUsable(promises, graceMs) {
    return new Promise(function (resolve) {
      const settled = new Array(promises.length);
      let remaining = promises.length;
      let finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        resolve(settled);
      }
      function onSettle(index, res) {
        settled[index] = res;
        remaining -= 1;
        if (remaining <= 0) {
          finish();
          return;
        }
        if (res && res.streams && res.streams.length) {
          sleep(Math.max(0, Number(graceMs) || 0)).then(finish);
        }
      }
      promises.forEach(function (p, index) {
        Promise.resolve(p).then(
          function (res) {
            onSettle(index, res);
          },
          function () {
            onSettle(index, { streams: [], subtitles: [] });
          }
        );
      });
    });
  }

  async function request(url, options) {
    const cfg = options || {};
    const method = cfg.method || 'GET';
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      cfg.headers || {}
    );
    const body = cfg.body || null;

    if (typeof fetchv2 === 'function') {
      const res = await fetchv2(url, headers, method, body, {
        followRedirects: cfg.followRedirects !== false,
        timeoutMs: cfg.timeoutMs || 25000,
      });
      let textBody = '';
      if (res && typeof res.text === 'function') {
        textBody = await res.text();
      } else if (res && typeof res.body === 'string') {
        textBody = res.body;
      }
      let jsonBody = res && typeof res.json === 'object' ? res.json : null;
      if (textBody) {
        try {
          jsonBody = JSON.parse(textBody);
        } catch (_) {}
      }
      if (jsonBody === null && res && typeof res.json === 'function') {
        try {
          jsonBody = await res.json();
        } catch (_) {}
      }
      const ok = !!(res && (res.ok || (res.status >= 200 && res.status < 300)));
      return {
        ok: ok,
        status: Number((res && res.status) || 0),
        text: textBody,
        json: jsonBody,
        headers: (res && res.headers) || {},
        finalUrl: (res && (res.finalUrl || res.url)) || url,
      };
    }

    if (typeof fetch === 'function') {
      const res = await fetch(url, {
        method: method,
        headers: headers,
        body: body,
        redirect: cfg.followRedirects === false ? 'manual' : 'follow',
      });
      const textBody = await res.text();
      let jsonBody = null;
      try {
        jsonBody = JSON.parse(textBody);
      } catch (_) {}
      return {
        ok: res.ok,
        status: Number(res.status || 0),
        text: textBody,
        json: jsonBody,
        headers: Object.fromEntries(res.headers.entries()),
        finalUrl: res.url || url,
      };
    }

    throw new Error('No HTTP transport available (fetchv2/fetch missing)');
  }

  /* -------------------------------------------------------------------------- */
  /*                            HTML CARD PARSING                               */
  /* -------------------------------------------------------------------------- */

  function parseCards(html) {
    const out = [];
    const seen = Object.create(null);
    if (!html) return out;

    const cardRe =
      /<article[^>]*class="[^"]*content-card[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
    let match;
    while ((match = cardRe.exec(html))) {
      const cardHtml = match[1];
      const fullArticle = match[0];
      const linkMatch = cardHtml.match(/<a[^>]+href="([^"]+)"(?:[^>]*title="([^"]*)")?/i);
      if (!linkMatch) continue;

      const rawHref = linkMatch[1];
      const href = absoluteUrl(rawHref, SITE);
      if (!href || seen[href]) continue;

      const titleMatch =
        cardHtml.match(/<h3[^>]*class="[^"]*card-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i) ||
        linkMatch[2];
      const rawTitle = typeof titleMatch === 'string' ? titleMatch : (titleMatch ? titleMatch[1] : '');
      const title = cleanText(rawTitle);
      if (!title) continue;

      let image = '';
      const imgMatch = cardHtml.match(/<img[^>]+src="([^"]+)"/i);
      if (imgMatch) {
        image = absoluteUrl(imgMatch[1], SITE);
      }

      let year = undefined;
      const yearMatch = cardHtml.match(/<time[^>]*datetime="(\d{4})"[^>]*>(\d{4})<\/time>/i) ||
                        cardHtml.match(/<time[^>]*>(\d{4})<\/time>/i) ||
                        href.match(/-(\d{4})(?:-hd)?$/i);
      if (yearMatch) {
        year = Number(yearMatch[1]);
      }

      const isTv = href.indexOf('/tv/') >= 0 ||
                   /TVSeries/i.test(fullArticle) ||
                   /<span>TV<\/span>/i.test(cardHtml);

      seen[href] = true;
      out.push({
        title: title,
        href: href,
        image: image || '',
        year: year,
        type: isTv ? 'tv' : 'movie',
      });
    }

    // Fallback: If no content-card articles found, match general links
    if (out.length === 0) {
      const fallbackRe =
        /<a[^>]+href="((?:https:\/\/yflix\.ws)?\/(?:movie|tv)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let fbMatch;
      while ((fbMatch = fallbackRe.exec(html))) {
        const h = absoluteUrl(fbMatch[1], SITE);
        if (!h || seen[h]) continue;
        const inner = fbMatch[2];
        const tMatch = inner.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i) || [null, inner];
        const t = cleanText(tMatch[1]);
        if (!t || t.length > 100) continue;
        const iMatch = inner.match(/<img[^>]+src="([^"]+)"/i);
        const img = iMatch ? absoluteUrl(iMatch[1], SITE) : '';
        const isTv = h.indexOf('/tv/') >= 0;
        seen[h] = true;
        out.push({
          title: t,
          href: h,
          image: img || '',
          type: isTv ? 'tv' : 'movie',
        });
      }
    }

    return out;
  }

  /* -------------------------------------------------------------------------- */
  /*                            SEARCH & RANKING                                */
  /* -------------------------------------------------------------------------- */

  function searchTerms(query) {
    const raw = cleanText(query);
    if (!raw) return [''];
    const normalized = cleanText(raw.replace(/[:\-–—_.,!?]/g, ' '));
    const withoutThe = cleanText(raw.replace(/^(?:the|a|an)\s+/i, ''));
    const withThe = !/^(?:the|a|an)\s+/i.test(raw) ? 'The ' + raw : '';
    const terms = [];
    for (const t of [raw, withoutThe, withThe, normalized]) {
      if (t && !terms.includes(t)) {
        terms.push(t);
      }
    }
    return terms;
  }

  function rankSearchResults(items, query) {
    if (!query || !items.length) return items;
    const qClean = cleanText(query).toLowerCase();
    const qNorm = qClean.replace(/[^a-z0-9]/g, '');

    return items.slice().sort(function (a, b) {
      const aTitle = cleanText(a.title || '').toLowerCase();
      const bTitle = cleanText(b.title || '').toLowerCase();
      const aNorm = aTitle.replace(/[^a-z0-9]/g, '');
      const bNorm = bTitle.replace(/[^a-z0-9]/g, '');

      function score(title, norm, isTv, year) {
        let sc = 0;
        if (title === qClean || norm === qNorm) {
          sc = 2000;
          // Prefer TV show for exact series queries so anime/shows aren't hidden by movies
          if (isTv) sc += 200;
          // For older foundational works on identical name, slightly prefer earlier year
          if (year) sc += Math.max(0, 2050 - year);
        } else if (title.indexOf(qClean) === 0 || norm.indexOf(qNorm) === 0) {
          sc = 1000 - title.length;
        } else if (title.indexOf(qClean) >= 0 || norm.indexOf(qNorm) >= 0) {
          sc = 500 - title.length;
        }
        return sc;
      }

      const aScore = score(aTitle, aNorm, a.type === 'tv' || (a.href && a.href.indexOf('/tv/') >= 0), a.year);
      const bScore = score(bTitle, bNorm, b.type === 'tv' || (b.href && b.href.indexOf('/tv/') >= 0), b.year);
      return bScore - aScore;
    });
  }

  /* -------------------------------------------------------------------------- */
  /*                            DISCOVERY V1 API                                */
  /* -------------------------------------------------------------------------- */

  // Upcoming titles often ship without artwork; the site's own pages fall back to the
  // template logo. The title's watch page carries the real poster as og:image — resolve
  // it (cached, bounded) instead of ever showing the logo.
  const ogImageCache = Object.create(null);
  async function ogImageFor(href) {
    const key = String(href || '');
    if (!key) return '';
    if (key in ogImageCache) return ogImageCache[key];
    let img = '';
    try {
      const res = await request(key, { timeoutMs: 12000 });
      const m = res.text.match(/property="og:image"[^>]*content="([^"]+)"/i) ||
                res.text.match(/content="([^"]+)"[^>]*property="og:image"/i);
      if (m && m[1] && /^https?:\/\//i.test(m[1]) && !/logo\.png/i.test(m[1])) img = m[1];
    } catch (_) {}
    ogImageCache[key] = img;
    return img;
  }

  async function discoveryHome() {
    try {
      const welcomePromise = request(SITE + '/welcome', { timeoutMs: 15000 });
      const homePromise = request(SITE + '/', { timeoutMs: 15000 });
      const actionPromise = request(SITE + '/watch-movies-online/genre/action-online', { timeoutMs: 12000 });
      const comedyPromise = request(SITE + '/watch-movies-online/genre/comedy-online', { timeoutMs: 12000 });
      const scifiPromise = request(SITE + '/watch-movies-online/genre/science-fiction-online', { timeoutMs: 12000 });
      const animPromise = request(SITE + '/watch-movies-online/genre/animation-online', { timeoutMs: 12000 });

      const [welcomeRes, homeRes, actionRes, comedyRes, scifiRes, animRes] = await Promise.all([
        welcomePromise,
        homePromise,
        actionPromise,
        comedyPromise,
        scifiPromise,
        animPromise,
      ]);

      const sections = [];
      const globalSeen = Object.create(null);

      function dedupeCards(cards, limit) {
        const res = [];
        for (let i = 0; i < cards.length; i++) {
          const c = cards[i];
          if (!c || !c.href || globalSeen[c.href]) continue;
          globalSeen[c.href] = true;
          res.push({
            title: c.title,
            href: c.href,
            image: c.image,
          });
          if (limit && res.length >= limit) break;
        }
        return res;
      }

      // 1. Featured / Hero Section
      const homeCards = parseCards(homeRes.text);
      const welcomeCards = parseCards(welcomeRes.text);
      let heroItems = dedupeCards(homeCards.concat(welcomeCards), 8);
      // Resolve real posters for cards that shipped without artwork (bounded: only the
      // imageless ones, max 8, cached per href for the session).
      const needArt = heroItems.filter(function (x) { return !x.image; }).slice(0, 8);
      if (needArt.length > 0) {
        const artByHref = Object.create(null);
        await Promise.all(needArt.map(async function (item) {
          const img = await ogImageFor(item.href);
          if (img) artByHref[item.href] = img;
        }));
        heroItems = heroItems.map(function (item) {
          return item.image ? item : Object.assign({}, item, { image: artByHref[item.href] || '' });
        });
      }
      if (heroItems.length > 0) {
        sections.push({
          id: 'featured',
          title: 'Featured & Trending',
          style: 'hero',
          items: heroItems,
          viewAll: { mode: 'feed', feedId: 'featured' },
        });
      }

      // 2. Latest Movies
      const movieSectionMatch = welcomeRes.text.match(/<h2[^>]*>Latest Movies<\/h2>[\s\S]*?(?=<h2|<\/section>)/i);
      const movieCards = movieSectionMatch ? parseCards(movieSectionMatch[0]) : welcomeCards.filter(c => c.type === 'movie');
      const movieItems = dedupeCards(movieCards, 24);
      if (movieItems.length > 0) {
        sections.push({
          id: 'latest-movies',
          title: 'Latest Movies',
          style: 'landscape',
          items: movieItems,
          viewAll: { mode: 'feed', feedId: 'movies' },
        });
      }

      // 3. Latest TV Shows
      const tvSectionMatch = welcomeRes.text.match(/<h2[^>]*>Latest TV Shows<\/h2>[\s\S]*?(?=<h2|<\/section>)/i);
      const tvCards = tvSectionMatch ? parseCards(tvSectionMatch[0]) : welcomeCards.filter(c => c.type === 'tv');
      const tvItems = dedupeCards(tvCards, 24);
      if (tvItems.length > 0) {
        sections.push({
          id: 'latest-tv',
          title: 'Latest TV Shows',
          style: 'poster',
          items: tvItems,
          viewAll: { mode: 'feed', feedId: 'tv-shows' },
        });
      }

      // 4. Action Movies
      const actionItems = dedupeCards(parseCards(actionRes.text), 20);
      if (actionItems.length > 0) {
        sections.push({
          id: 'action',
          title: 'Action & Adventure',
          style: 'poster',
          items: actionItems,
          viewAll: { mode: 'feed', feedId: 'action' },
        });
      }

      // 5. Sci-Fi & Fantasy
      const scifiItems = dedupeCards(parseCards(scifiRes.text), 20);
      if (scifiItems.length > 0) {
        sections.push({
          id: 'scifi',
          title: 'Sci-Fi & Fantasy',
          style: 'poster',
          items: scifiItems,
          viewAll: { mode: 'feed', feedId: 'scifi' },
        });
      }

      // 6. Animation
      const animItems = dedupeCards(parseCards(animRes.text), 20);
      if (animItems.length > 0) {
        sections.push({
          id: 'animation',
          title: 'Animation',
          style: 'poster',
          items: animItems,
          viewAll: { mode: 'feed', feedId: 'animation' },
        });
      }

      // 7. Comedy
      const comedyItems = dedupeCards(parseCards(comedyRes.text), 20);
      if (comedyItems.length > 0) {
        sections.push({
          id: 'comedy',
          title: 'Comedy',
          style: 'poster',
          items: comedyItems,
          viewAll: { mode: 'feed', feedId: 'comedy' },
        });
      }

      return { sections: sections };
    } catch (e) {
      log('discoveryHome failed: ' + (e && e.message ? e.message : e));
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedId, page) {
    try {
      const p = Math.max(1, Number(page) || 1);
      let endpoint = '';
      const id = String(feedId || '').toLowerCase().trim();

      if (id === 'movies' || id === 'latest-movies' || id === 'featured') {
        endpoint = SITE + '/watch-movies-online' + (p > 1 ? '?page=' + p : '');
      } else if (id === 'tv-shows' || id === 'latest-tv') {
        endpoint = SITE + '/tv-shows' + (p > 1 ? '?page=' + p : '');
      } else if (id === 'action') {
        endpoint = SITE + '/watch-movies-online/genre/action-online' + (p > 1 ? '?page=' + p : '');
      } else if (id === 'comedy') {
        endpoint = SITE + '/watch-movies-online/genre/comedy-online' + (p > 1 ? '?page=' + p : '');
      } else if (id === 'scifi') {
        endpoint = SITE + '/watch-movies-online/genre/science-fiction-online' + (p > 1 ? '?page=' + p : '');
      } else if (id === 'animation') {
        endpoint = SITE + '/watch-movies-online/genre/animation-online' + (p > 1 ? '?page=' + p : '');
      } else if (id === 'drama') {
        endpoint = SITE + '/watch-movies-online/genre/drama-online' + (p > 1 ? '?page=' + p : '');
      } else if (id === 'horror') {
        endpoint = SITE + '/watch-movies-online/genre/horror-online' + (p > 1 ? '?page=' + p : '');
      } else {
        endpoint = SITE + '/watch-movies-online' + (p > 1 ? '?page=' + p : '');
      }

      const res = await request(endpoint, { timeoutMs: 15000 });
      const cards = parseCards(res.text);

      const items = cards.map(function (c) {
        return {
          title: c.title,
          href: c.href,
          image: c.image,
        };
      });

      return {
        items: items,
        page: p,
        hasMore: items.length >= 20,
      };
    } catch (e) {
      log('discoveryFeed failed: ' + (e && e.message ? e.message : e));
      return { items: [], page: page || 1, hasMore: false };
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            SEARCH RESULTS                                  */
  /* -------------------------------------------------------------------------- */

  async function searchResults(query) {
    try {
      const q = cleanText(query);
      if (!q) {
        // Empty query: Curated homepage catalogue
        const res = await request(SITE + '/welcome', { timeoutMs: 15000 });
        const cards = parseCards(res.text);
        return cards.map(function (c) {
          return {
            title: c.title,
            href: c.href,
            image: c.image,
          };
        });
      }

      const terms = searchTerms(q);
      const out = [];
      const seen = Object.create(null);

      for (let tIdx = 0; tIdx < terms.length; tIdx++) {
        const candidateTerm = terms[tIdx];
        const searchUrl = SITE + '/search?q=' + encodeURIComponent(candidateTerm);
        const res = await request(searchUrl, { timeoutMs: 15000 });
        const cards = parseCards(res.text);

        for (let i = 0; i < cards.length; i++) {
          const c = cards[i];
          if (seen[c.href]) continue;
          seen[c.href] = true;
          out.push(c);
        }

        // If we found good matches on the primary term, no need to query all fallbacks
        if (out.length >= 5) break;
      }

      const ranked = rankSearchResults(out, q);
      return ranked.map(function (c) {
        return {
          title: c.title,
          href: c.href,
          image: c.image,
        };
      });
    } catch (e) {
      log('searchResults failed: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            EXTRACT DETAILS                                 */
  /* -------------------------------------------------------------------------- */

  function parseJsonLd(html) {
    const blocks = String(html || '').match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (!blocks) return null;
    for (let i = 0; i < blocks.length; i++) {
      const inner = blocks[i].replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
      try {
        const obj = JSON.parse(inner);
        if (obj && (obj['@type'] === 'Movie' || obj['@type'] === 'TVSeries')) {
          return obj;
        }
      } catch (_) {}
    }
    return null;
  }

  function titleFromSlug(slugOrUrl) {
    const raw = String(slugOrUrl || '');
    const m = raw.match(/\/(?:movie|tv)\/watch-[a-z0-9]+-(.+?)(?:-\d{4})?(?:-hd)?$/i) ||
              raw.match(/watch-[a-z0-9]+-(.+?)(?:-\d{4})?(?:-hd)?$/i);
    if (m) {
      return m[1].replace(/-/g, ' ').replace(/\b\w/g, function (l) {
        return l.toUpperCase();
      });
    }
    return '';
  }

  async function extractDetails(urlOrId) {
    try {
      const raw = String(urlOrId || '').trim();
      const targetUrl = absoluteUrl(raw, SITE);

      if (detailsCache[targetUrl]) return detailsCache[targetUrl];

      const res = await request(targetUrl, { timeoutMs: 15000 });
      const html = res.text;

      const ld = parseJsonLd(html) || {};

      // Title
      let title = cleanText(ld.name || '');
      if (!title) {
        const h1Match = html.match(/<h1[^>]*class="[^"]*detail-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
                        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        title = cleanText(h1Match ? h1Match[1] : '');
      }
      if (!title) {
        title = titleFromSlug(targetUrl);
      }

      // Description
      let description = cleanText(ld.description || '');
      if (!description) {
        const descMatch = html.match(/<p[^>]*class="[^"]*detail-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
                          html.match(/<div[^>]*class="[^"]*detail-synopsis[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        description = cleanText(descMatch ? descMatch[1] : '');
      }

      // Poster Image
      let image = '';
      if (ld.image) {
        image = typeof ld.image === 'string' ? ld.image : (ld.image.url || '');
      }
      if (!image) {
        const imgMatch = html.match(/<div class="detail-poster-wrap"[\s\S]*?<img[^>]+src="([^"]+)"/i) ||
                         html.match(/<img[^>]+class="[^"]*detail-poster-img[^"]*"[^>]+src="([^"]+)"/i);
        image = imgMatch ? absoluteUrl(imgMatch[1], SITE) : '';
      }
      if (!image) {
        const ogMatch = html.match(/property="og:image"[^>]*content="([^"]+)"/i) ||
                        html.match(/content="([^"]+)"[^>]*property="og:image"/i);
        if (ogMatch && ogMatch[1] && !/logo\.png/i.test(ogMatch[1])) image = absoluteUrl(ogMatch[1], SITE);
      }

      // Year & Date
      let year = '';
      if (ld.datePublished) {
        const yMatch = String(ld.datePublished).match(/\b(19\d\d|20\d\d)\b/);
        if (yMatch) year = yMatch[1];
      }
      if (!year) {
        const yearBadge = html.match(/class="badge badge-genre"[^>]*>(\d{4})<\/a>/i) ||
                          targetUrl.match(/-(\d{4})(?:-hd)?$/i);
        if (yearBadge) year = yearBadge[1];
      }

      // Rating
      let rating = '';
      if (ld.aggregateRating && ld.aggregateRating.ratingValue) {
        rating = String(ld.aggregateRating.ratingValue);
      }
      if (!rating) {
        const imdbMatch = html.match(/class="badge badge-imdb"[^>]*>IMDb\s*([\d.]+)/i);
        if (imdbMatch) rating = imdbMatch[1];
      }

      // Genres
      let genres = [];
      if (Array.isArray(ld.genre)) {
        genres = ld.genre.map(cleanText).filter(Boolean);
      } else if (typeof ld.genre === 'string') {
        genres = [cleanText(ld.genre)];
      }
      if (!genres.length) {
        const genreMatches = [...html.matchAll(/href="[^"]*\/genre\/[^"]*"[^>]*>([^<]+)<\/a>/gi)];
        genres = genreMatches.map(m => cleanText(m[1])).filter(Boolean);
      }

      const isTv = targetUrl.indexOf('/tv/') >= 0 || ld['@type'] === 'TVSeries';

      const details = {
        title: title || (isTv ? 'TV Series' : 'Movie'),
        description: description || (isTv ? 'Watch TV series online on yFlix.' : 'Watch movie online on yFlix.'),
        image: image || '',
        year: year ? Number(year) : undefined,
        rating: rating || undefined,
        genres: genres.length ? genres : undefined,
        mediaType: isTv ? 'tv' : 'movie',
        isMovie: !isTv,
      };

      detailsCache[targetUrl] = details;
      const urlSlugMatch = targetUrl.match(/\/(?:tv|movie)\/(?:watch-)?([a-z0-9]+)/i);
      if (urlSlugMatch) detailsCache[urlSlugMatch[1]] = details;
      return details;
    } catch (e) {
      log('extractDetails failed: ' + (e && e.message ? e.message : e));
      return {
        title: 'Unknown Title',
        description: 'yFlix streaming media.',
        image: '',
      };
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            EXTRACT EPISODES                                */
  /* -------------------------------------------------------------------------- */

  async function extractEpisodes(seriesId) {
    try {
      const raw = String(seriesId || '').trim();
      const targetUrl = absoluteUrl(raw, SITE);

      // Check if it is a Movie URL
      if (targetUrl.indexOf('/movie/') >= 0) {
        const details = await extractDetails(targetUrl);
        return [
          {
            number: 1,
            season: 1,
            title: details.title || 'Full Movie',
            href: targetUrl,
            isMovie: true,
            mediaType: 'movie',
            subAvailable: true,
            dubAvailable: false,
          },
        ];
      }

      // TV Series: Fetch watch page and enumerate all seasons + episodes
      const res = await request(targetUrl, { timeoutMs: 15000 });
      const html = res.text;

      // Extract seriesSlug from page (e.g. data-series-slug="l1pfsn" or URL)
      let seriesSlug = '';
      const slugMatch = html.match(/data-series-slug="([^"]+)"/i);
      if (slugMatch) {
        seriesSlug = slugMatch[1];
      } else {
        const urlSlugMatch = targetUrl.match(/\/tv\/watch-([a-z0-9]+)-/i);
        if (urlSlugMatch) seriesSlug = urlSlugMatch[1];
      }

      // Pre-cache details from page to avoid extra requests
      const details = await extractDetails(targetUrl);
      if (seriesSlug && details) {
        detailsCache[seriesSlug] = details;
      }

      const episodes = [];
      const seen = Object.create(null);

      // Parse all season panels
      const panelRe = /<div[^>]*class="[^"]*season-panel[^"]*"[^>]*data-season="(\d+)"[\s\S]*?(?=<div[^>]*class="[^"]*season-panel|<div class="server-select"|<\/div>\s*<\/div>\s*<\/section>|$)/gi;
      let pMatch;
      while ((pMatch = panelRe.exec(html))) {
        const seasonNum = Number(pMatch[1]) || 1;
        const panelHtml = pMatch[0];
        const epRe = /<div class="episode-item"[^>]*data-season="(\d+)"[^>]*data-episode="(\d+)"/gi;
        let epMatch;
        while ((epMatch = epRe.exec(panelHtml))) {
          const s = Number(epMatch[1]) || seasonNum;
          const e = Number(epMatch[2]) || 1;
          const key = s + ':' + e;
          if (seen[key]) continue;
          seen[key] = true;

          const epHref = seriesSlug
            ? SITE + '/tv/' + seriesSlug + '/episode/' + s + '/' + e
            : targetUrl + '#s' + s + '-e' + e;

          episodes.push({
            number: e,
            season: s,
            title: 'Season ' + s + ' Episode ' + e,
            href: epHref,
            subAvailable: true,
            dubAvailable: false,
          });
        }
      }

      // Fallback: If panels weren't matched separately, scan all episode items
      if (episodes.length === 0) {
        const epRe = /<div class="episode-item"[^>]*data-season="(\d+)"[^>]*data-episode="(\d+)"/gi;
        let epMatch;
        while ((epMatch = epRe.exec(html))) {
          const s = Number(epMatch[1]) || 1;
          const e = Number(epMatch[2]) || 1;
          const key = s + ':' + e;
          if (seen[key]) continue;
          seen[key] = true;

          const epHref = seriesSlug
            ? SITE + '/tv/' + seriesSlug + '/episode/' + s + '/' + e
            : targetUrl + '#s' + s + '-e' + e;

          episodes.push({
            number: e,
            season: s,
            title: 'Season ' + s + ' Episode ' + e,
            href: epHref,
            subAvailable: true,
            dubAvailable: false,
          });
        }
      }

      // Sort episodes by season ascending, then episode number ascending
      episodes.sort(function (a, b) {
        return (a.season || 1) - (b.season || 1) || (a.number || 1) - (b.number || 1);
      });

      return episodes;
    } catch (e) {
      log('extractEpisodes failed: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            VIDEASY STREAM RESOLVER                         */
  /* -------------------------------------------------------------------------- */

  function videasyImul(a, b) {
    if (typeof Math.imul === 'function') return Math.imul(a, b) >>> 0;
    a = a >>> 0;
    b = b >>> 0;
    const ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    const bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
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
    const s = String(input || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const pad = s.length % 4 === 0 ? s : s + '===='.slice(s.length % 4);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const out = [];
    let buf = 0, bits = 0;
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
    const tNum = Number(mediaId) || 0;
    const S = Object.create(null);
    let fnv = 2166136261;
    const seedStr = String(seed || '');
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
    let o = 0, e = 0;
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
    for (let i = 0; i < raw.length; i++) plain[i] = raw[i] ^ ks[i];
    for (let i = 0; i < VIDEASY_MAGIC.length; i++) {
      if (plain[i] !== VIDEASY_MAGIC[i]) throw new Error('videasy decrypt magic mismatch');
    }
    return videasyUtf8Decode(plain.slice(4));
  }

  async function videasyGetSeed(mediaId) {
    const id = String(mediaId || '');
    if (!id) return '';
    const hit = videasySeedCache[id];
    if (hit && hit.expiresAt - 3000 > Date.now() && hit.seed) return hit.seed;
    if (inFlightSeedMap[id]) return inFlightSeedMap[id];

    const inFlight = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(300 * attempt);
        try {
          const res = await request(
            VIDEASY_API + '/seed?mediaId=' + encodeURIComponent(id),
            {
              headers: {
                'User-Agent': USER_AGENT,
                Origin: VIDEASY_PLAYER,
                Referer: VIDEASY_PLAYER + '/',
              },
              timeoutMs: 8000,
            }
          );
          if (res.json && res.json.seed) {
            const ttl = Number(res.json.ttlMs) || 30000;
            videasySeedCache[id] = { seed: res.json.seed, expiresAt: Date.now() + ttl };
            return res.json.seed;
          }
        } catch (_) {}
      }
      return '';
    })();

    inFlightSeedMap[id] = inFlight;
    try {
      return await inFlight;
    } finally {
      delete inFlightSeedMap[id];
    }
  }

  function videasyStreamHeaders() {
    return {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
      Origin: VIDEASY_PLAYER,
      Referer: VIDEASY_PLAYER + '/',
    };
  }

  function parseQualityHeight(q) {
    const s = String(q || '').toLowerCase();
    if (/4k|2160|uhd/.test(s)) return 2160;
    if (/1080/.test(s)) return 1080;
    if (/720/.test(s)) return 720;
    if (/540/.test(s)) return 540;
    if (/480/.test(s)) return 480;
    if (/360/.test(s)) return 360;
    return 0;
  }

  function mapSubtitles(rawList, sourceHeaders, baseUrl) {
    const out = [];
    const seen = Object.create(null);
    const perLang = Object.create(null);
    let undCount = 0;
    const rows = Array.isArray(rawList) ? rawList : [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row !== 'object') continue;
      const rawFile = String(row.url || row.file || row.src || '').trim();
      // Providers may hand back relative caption paths (lookmovie now uses
      // `/storage5/...`): resolve them against the provider base instead of
      // dropping the track.
      const file =
        rawFile.indexOf('//') === 0
          ? 'https:' + rawFile
          : rawFile.indexOf('http') === 0
            ? rawFile
            : rawFile.indexOf('/') === 0 && baseUrl
              ? String(baseUrl).replace(/\/+$/, '') + rawFile
              : '';
      if (!file) continue;
      if (/\/thumbs?\/|sprite|thumbnail/i.test(file)) continue;
      if (seen[file]) continue;
      seen[file] = true;

      const rawLang = cleanText(row.lang || row.language || row.srclang || row.label || '').toLowerCase();
      const baseLang = rawLang.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
      const names = { english: 'en', arabic: 'ar', french: 'fr', spanish: 'es', italian: 'it', german: 'de', portuguese: 'pt', protuguese: 'pt', japanese: 'ja', korean: 'ko', chinese: 'zh', hindi: 'hi', turkish: 'tr', russian: 'ru', persian: 'fa', dutch: 'nl', hebrew: 'he', greek: 'el', serbian: 'sr', croatian: 'hr', romanian: 'ro', ukrainian: 'uk', bulgarian: 'bg', hungarian: 'hu', czech: 'cs', slovak: 'sk', finnish: 'fi', swedish: 'sv', norwegian: 'no', danish: 'da', vietnamese: 'vi', thai: 'th', indonesian: 'id', malay: 'ms', bengali: 'bn', tamil: 'ta', telugu: 'te', urdu: 'ur', filipino: 'tl' };
      const lang = names[rawLang] || names[baseLang] || (/^[a-z]{2,3}(?:[-_][a-z0-9]+)*$/i.test(baseLang) ? baseLang.replace(/_/g, '-') : 'und');
      const label = cleanText(row.label || row.language || row.lang || 'Unknown language');

      // Keep every LANGUAGE the provider carries, but cap duplicate variants so the
      // picker and payload stay sane (one title can list 600+ near-identical rows).
      if (lang === 'und') {
        if (undCount >= 8) continue;
        undCount += 1;
      } else {
        perLang[lang] = (perLang[lang] || 0) + 1;
        if (perLang[lang] > 4) continue;
      }
      if (out.length >= 250) break;

      out.push({
        label: label,
        language: lang,
        lang: lang,
        url: file,
        file: file,
        kind: 'captions',
        headers: Object.assign({
          'User-Agent': USER_AGENT,
          Accept: 'text/vtt,text/plain,application/x-subrip,*/*',
        }, sourceHeaders || {}, row.headers || {}),
      });
    }
    return out;
  }

  async function resolveVideasy(mediaId, title, isTv, season, episode) {
    try {
      const seed = await videasyGetSeed(mediaId);
      if (!seed) return { streams: [], subtitles: [] };

      const baseParams = {
        title: title || String(mediaId),
        mediaType: isTv ? 'tv' : 'movie',
        tmdbId: String(mediaId),
        imdbId: '',
        enc: '2',
        seed: seed,
      };
      if (isTv) {
        baseParams.seasonId = Number(season) || 1;
        baseParams.episodeId = Number(episode) || 1;
      }

      const endpoints = ['/cdn/sources-with-title', '/m4uhd/sources-with-title', '/lamovie/sources-with-title'];
      const streams = [];
      let subs = [];
      const seenUrl = Object.create(null);

      for (let epIdx = 0; epIdx < endpoints.length; epIdx++) {
        const ep = endpoints[epIdx];
        try {
          const qParts = [];
          Object.keys(baseParams).forEach(function (k) {
            if (baseParams[k] != null && baseParams[k] !== '') {
              qParts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(baseParams[k])));
            }
          });
          const url = VIDEASY_API + ep + '?' + qParts.join('&');

          const res = await request(url, {
            headers: {
              'User-Agent': USER_AGENT,
              Origin: VIDEASY_PLAYER,
              Referer: VIDEASY_PLAYER + '/',
            },
            timeoutMs: 12000,
          });

          if (!res.text) continue;

          const plain = videasyDecrypt(res.text, seed, mediaId);
          const data = JSON.parse(plain);

          const sources = (data && data.sources) || [];
          for (let sIdx = 0; sIdx < sources.length; sIdx++) {
            const src = sources[sIdx];
            if (!src || !src.url || String(src.url).indexOf('http') !== 0) continue;
            const srcUrl = String(src.url);
            if (/\.mpd(\?|$)/i.test(srcUrl)) continue; // skip DASH
            if (seenUrl[srcUrl]) continue;
            seenUrl[srcUrl] = true;

            const height = parseQualityHeight(src.quality || src.label || srcUrl);
            const label = height >= 360 ? height + 'p' : cleanText(src.quality || 'Auto');

            streams.push({
              label: label,
              height: height,
              url: srcUrl,
              headers: videasyStreamHeaders(),
              server: ['Videasy CDN', 'M4UHD', 'LaMovie'][epIdx],
              subtitles: mapSubtitles(data.subtitles || data.subs || data.tracks, { Origin: VIDEASY_PLAYER, Referer: VIDEASY_PLAYER + '/' }),
            });
          }

          if (data && (data.subtitles || data.subs || data.tracks)) {
            subs = subs.concat(mapSubtitles(data.subtitles || data.subs || data.tracks, { Origin: VIDEASY_PLAYER, Referer: VIDEASY_PLAYER + '/' }));
          }
        } catch (_) {}
      }

      // Smart sorting: 1080p is preferred primary auto-play default, followed by 4K, 720p, 480p, 360p
      streams.sort(function (a, b) {
        function score(s) {
          const h = Number(s.height) || 0;
          if (h === 1080) return 50000;
          if (h >= 2160) return 40000 + h;
          if (h === 720) return 30000 + h;
          if (h === 480) return 20000 + h;
          if (h > 0) return 10000 + h;
          return 0;
        }
        return score(b) - score(a);
      });

      return { streams: streams, subtitles: subs };
    } catch (e) {
      log('resolveVideasy failed: ' + (e && e.message ? e.message : e));
      return { streams: [], subtitles: [] };
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            LOOKMOVIE FALLBACK RESOLVER                     */
  /* -------------------------------------------------------------------------- */

  async function resolveLookmovie(title, isTv, season, episode, tmdbId, yearHint) {
    try {
      const q = cleanText(title);
      if (!q) return { streams: [], subtitles: [] };

      const searchPath = isTv ? '/api/v1/shows/do-search/?q=' : '/api/v1/movies/do-search/?q=';
      const searchRes = await request(LOOKMOVIE_API + searchPath + encodeURIComponent(q), {
        headers: {
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: LOOKMOVIE_API + '/',
        },
        timeoutMs: 10000,
      });

      const list = (searchRes.json && searchRes.json.result) || [];
      if (!list.length) return { streams: [], subtitles: [] };

      // Never substitute a different title for the requested film. Identity ladder:
      // 1) exact tmdb id when the result carries one (the site stopped exposing tmdb_id in
      //    2026-09; kept in case it returns),
      // 2) exact normalized title match, disambiguated by the year from the target URL slug.
      let hit = null;
      const wantedTmdb = String(tmdbId || '');
      if (wantedTmdb) {
        const byTmdb = list.filter(function (item) {
          return String(item.tmdb_id || item.tmdbId || '') === wantedTmdb;
        });
        if (byTmdb.length === 1) hit = byTmdb[0];
      }
      if (!hit) {
        const normalizeTitle = function (value) {
          return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        };
        const wantedTitle = normalizeTitle(q);
        let byTitle = list.filter(function (item) {
          return normalizeTitle(item.title) === wantedTitle;
        });
        if (byTitle.length > 1 && yearHint) {
          const byYear = byTitle.filter(function (item) {
            return String(item.year || '') === String(yearHint);
          });
          if (byYear.length) byTitle = byYear;
        }
        if (byTitle.length === 1) hit = byTitle[0];
      }
      if (!hit) return { streams: [], subtitles: [] };
      const viewPath = isTv
        ? '/shows/view/' + encodeURIComponent(hit.slug || hit.id_show)
        : '/movies/view/' + encodeURIComponent(hit.slug || hit.id_movie);

      const viewRes = await request(LOOKMOVIE_API + viewPath, {
        headers: { 'User-Agent': USER_AGENT, Referer: LOOKMOVIE_API + '/' },
        timeoutMs: 10000,
      });

      const playPathMatch = viewRes.text.match(/href="(\/(?:shows|movies)\/play\/[^"]+)"/i);
      if (!playPathMatch) return { streams: [], subtitles: [] };

      const playRes = await request(LOOKMOVIE_API + playPathMatch[1], {
        headers: { 'User-Agent': USER_AGENT, Referer: LOOKMOVIE_API + '/' },
        timeoutMs: 10000,
      });

      const hashMatch = playRes.text.match(/hash:\s*['"]([^'"]+)['"]/);
      const expiresMatch = playRes.text.match(/expires:\s*(\d+)/);
      if (!hashMatch || !expiresMatch) return { streams: [], subtitles: [] };

      const hash = hashMatch[1];
      const expires = expiresMatch[1];

      let accessUrl = '';
      if (isTv) {
        const epListRes = await request(
          LOOKMOVIE_API + '/api/v2/download/episode/list?id=' + encodeURIComponent(hit.id_show || hit.id),
          {
            headers: { 'User-Agent': USER_AGENT, 'X-Requested-With': 'XMLHttpRequest', Referer: LOOKMOVIE_API + '/' },
            timeoutMs: 8000,
          }
        );
        const epObj = (epListRes.json && epListRes.json.list && epListRes.json.list[String(season || 1)]) || {};
        const epItem = epObj[String(episode || 1)] || {};
        const episodeId = epItem.id_episode || epItem.id;
        if (!episodeId) return { streams: [], subtitles: [] };

        accessUrl =
          LOOKMOVIE_API +
          '/api/v1/security/episode-access?id_episode=' +
          encodeURIComponent(String(episodeId)) +
          '&hash=' +
          encodeURIComponent(hash) +
          '&expires=' +
          encodeURIComponent(expires);
      } else {
        const movieId = hit.id_movie || hit.id;
        accessUrl =
          LOOKMOVIE_API +
          '/api/v1/security/movie-access?id_movie=' +
          encodeURIComponent(String(movieId)) +
          '&hash=' +
          encodeURIComponent(hash) +
          '&expires=' +
          encodeURIComponent(expires);
      }

      const accessRes = await request(accessUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: LOOKMOVIE_API + '/',
        },
        timeoutMs: 10000,
      });

      const streamsObj = (accessRes.json && accessRes.json.streams) || {};
      const streams = [];
      const keys = Object.keys(streamsObj);
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        const u = String(streamsObj[key] || '').trim();
        if (!/^https?:\/\//i.test(u)) continue;
        const height = parseQualityHeight(key);
        streams.push({
          label: height ? height + 'p' : 'Auto',
          server: 'Lookmovie',
          height: height,
          url: u,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
            Origin: LOOKMOVIE_API,
            Referer: LOOKMOVIE_API + '/',
          },
        });
      }

      streams.sort(function (a, b) {
        return (b.height || 0) - (a.height || 0);
      });

      const subs = mapSubtitles((accessRes.json && accessRes.json.subtitles) || [], { Origin: LOOKMOVIE_API, Referer: LOOKMOVIE_API + '/' }, LOOKMOVIE_API);
      streams.forEach(function (stream) { stream.subtitles = subs; });
      return { streams: streams, subtitles: subs };
    } catch (e) {
      log('resolveLookmovie failed: ' + (e && e.message ? e.message : e));
      return { streams: [], subtitles: [] };
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            SUBS PROXY HELPER                               */
  /* -------------------------------------------------------------------------- */

  async function fetchExternalSubs(tmdbId, season, episode) {
    try {
      const id = String(tmdbId || '').trim();
      if (!id) return [];
      let url = SUBS_API + '?id=' + encodeURIComponent(id) + '&language=en&format=srt';
      if (season != null && Number(season) > 0) url += '&season=' + Number(season);
      if (episode != null && Number(episode) > 0) url += '&episode=' + Number(episode);

      const res = await request(url, {
        headers: { Accept: 'application/json' },
        timeoutMs: 5000,
      });

      if (!res.json || !Array.isArray(res.json.subtitles)) return [];
      return mapSubtitles(res.json.subtitles);
    } catch (_) {
      return [];
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            EXTRACT STREAM URL                              */
  /* -------------------------------------------------------------------------- */

  async function extractStreamUrl(episodeHref, lang) {
    try {
      const raw = String(episodeHref || '').trim();
      const targetUrl = absoluteUrl(raw, SITE);

      // Stream URLs expire. Always resolve on an explicit play/retry request.

      let tmdbId = '';
      let title = '';
      let isTv = false;
      let season = 1;
      let episode = 1;

      // Case 1: Custom formatted identifier yflix:movie:19995 or yflix:tv:1396:1:1
      const customMatch = raw.match(/^yflix:(movie|tv):(\d+)(?::(\d+):(\d+))?(?::(.+))?$/i);
      if (customMatch) {
        isTv = customMatch[1].toLowerCase() === 'tv';
        tmdbId = customMatch[2];
        season = customMatch[3] ? Number(customMatch[3]) : 1;
        episode = customMatch[4] ? Number(customMatch[4]) : 1;
        title = customMatch[5] ? decodeURIComponent(customMatch[5]) : '';
      }

      // Case 2: TV Episode AJAX endpoint https://yflix.ws/tv/<slug>/episode/<s>/<e>
      if (!tmdbId) {
        const tvApiMatch = targetUrl.match(/\/tv\/([^/]+)\/episode\/(\d+)\/(\d+)/i);
        if (tvApiMatch) {
          isTv = true;
          const slug = tvApiMatch[1];
          season = Number(tvApiMatch[2]) || 1;
          episode = Number(tvApiMatch[3]) || 1;

          const epRes = await request(targetUrl, {
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
              Referer: SITE + '/tv/watch-' + slug + '-online',
            },
            timeoutMs: 15000,
          });

          if (epRes.json && Array.isArray(epRes.json.playerSources)) {
            const sources = epRes.json.playerSources;
            for (let i = 0; i < sources.length; i++) {
              const srcUrl = String(sources[i].url || '');
              const idMatch = srcUrl.match(/\/tv\/(\d+)/i) || srcUrl.match(/tmdb=(\d+)/i);
              if (idMatch) {
                tmdbId = idMatch[1];
                break;
              }
            }
          }

          // Check if we already have the series details cached by slug or URL
          if (detailsCache[slug] && detailsCache[slug].title) {
            title = detailsCache[slug].title;
          } else {
            const cachedSeriesUrl = SITE + '/tv/watch-' + slug + '-online';
            if (detailsCache[cachedSeriesUrl] && detailsCache[cachedSeriesUrl].title) {
              title = detailsCache[cachedSeriesUrl].title;
            }
          }
        }
      }

      // Case 3: Movie Page https://yflix.ws/movie/watch-...
      if (!tmdbId && targetUrl.indexOf('/movie/') >= 0) {
        isTv = false;
        const pageRes = await request(targetUrl, { timeoutMs: 15000 });
        const html = pageRes.text;

        const pwMatch = html.match(/<div class="player-wrap"[^>]*data-sources="([^"]*)"/i);
        if (pwMatch) {
          try {
            const rawSources = decodeEntities(pwMatch[1]);
            const sources = JSON.parse(rawSources);
            for (let i = 0; i < sources.length; i++) {
              const srcUrl = String(sources[i].url || '');
              const idMatch = srcUrl.match(/\/movie\/(\d+)/i) || srcUrl.match(/tmdb=(\d+)/i);
              if (idMatch) {
                tmdbId = idMatch[1];
                break;
              }
            }
          } catch (_) {}
        }

        const titleMatch = html.match(/<h1[^>]*class="[^"]*detail-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
        if (titleMatch) title = cleanText(titleMatch[1]);
      }

      // Case 4: TV Show Watch Page with hash or parameters https://yflix.ws/tv/watch-...#s1-e1
      if (!tmdbId && targetUrl.indexOf('/tv/') >= 0) {
        isTv = true;
        const sMatch = targetUrl.match(/[#&?]s(?:eason)?=?(\d+)/i);
        const eMatch = targetUrl.match(/[#&?-]e(?:pisode)?=?(\d+)/i);
        season = sMatch ? Number(sMatch[1]) : season;
        episode = eMatch ? Number(eMatch[1]) : episode;

        const pageRes = await request(targetUrl, { timeoutMs: 15000 });
        const html = pageRes.text;

        let seriesSlug = '';
        const slugMatch = html.match(/data-series-slug="([^"]+)"/i);
        if (slugMatch) seriesSlug = slugMatch[1];

        if (seriesSlug) {
          const epRes = await request(SITE + '/tv/' + seriesSlug + '/episode/' + season + '/' + episode, {
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
              Referer: targetUrl,
            },
            timeoutMs: 12000,
          });
          if (epRes.json && Array.isArray(epRes.json.playerSources)) {
            const sources = epRes.json.playerSources;
            for (let i = 0; i < sources.length; i++) {
              const srcUrl = String(sources[i].url || '');
              const idMatch = srcUrl.match(/\/tv\/(\d+)/i) || srcUrl.match(/tmdb=(\d+)/i);
              if (idMatch) {
                tmdbId = idMatch[1];
                break;
              }
            }
          }
        }

        const titleMatch = html.match(/<h1[^>]*class="[^"]*detail-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
        if (titleMatch) title = cleanText(titleMatch[1]);
      }

      if (!title && tmdbId && !customMatch) {
        const d = await extractDetails(targetUrl);
        title = d.title;
      }

      log('Resolving streams for tmdb=' + tmdbId + ' title="' + title + '" isTv=' + isTv + ' s=' + season + ' e=' + episode);

      // Run resolvers in parallel
      const yearHint = (String(targetUrl || '').match(/-(\d{4})(?:[-/]|$)/) || [])[1] || '';

      const videasyPromise = tmdbId
        ? resolveVideasy(tmdbId, title, isTv, season, episode)
        : Promise.resolve({ streams: [], subtitles: [] });

      const lookmoviePromise = title
        ? resolveLookmovie(title, isTv, season, episode, tmdbId, yearHint)
        : Promise.resolve({ streams: [], subtitles: [] });

      const settledResults = await firstUsable(
        [
          settleWithin(videasyPromise, 15000, { streams: [], subtitles: [] }),
          settleWithin(lookmoviePromise, 12000, { streams: [], subtitles: [] }),
        ],
        1200
      );
      const vdRes = settledResults[0] || { streams: [], subtitles: [] };
      const lmRes = settledResults[1] || { streams: [], subtitles: [] };

      const allStreams = [];
      const seenStreamUrls = Object.create(null);

      // Add Videasy streams (primary)
      if (vdRes && Array.isArray(vdRes.streams)) {
        for (let i = 0; i < vdRes.streams.length; i++) {
          const s = vdRes.streams[i];
          if (!s || !s.url || seenStreamUrls[s.url]) continue;
          seenStreamUrls[s.url] = true;
          allStreams.push(s);
        }
      }

      // Add Lookmovie streams (fallback)
      if (lmRes && Array.isArray(lmRes.streams)) {
        for (let i = 0; i < lmRes.streams.length; i++) {
          const s = lmRes.streams[i];
          if (!s || !s.url || seenStreamUrls[s.url]) continue;
          seenStreamUrls[s.url] = true;
          allStreams.push(s);
        }
      }

      if (allStreams.length === 0) {
        throw new Error('No playable stream found for ' + (title || targetUrl));
      }

      // Build streams array [label, url, label, url, ...]
      const streamsArray = [];
      const qualities = [];

      for (let i = 0; i < allStreams.length; i++) {
        const s = allStreams[i];
        if (s.server !== allStreams[0].server) continue;
        const lbl = s.label || 'Auto';
        streamsArray.push(lbl);
        streamsArray.push(s.url);
        qualities.push({
          label: lbl,
          height: s.height || parseQualityHeight(lbl),
          url: s.url,
          headers: s.headers || videasyStreamHeaders(),
        });
      }

      // Merge subtitles
      const allSubs = [];
      const seenSubs = Object.create(null);

      // Captions belong to the selected provider's cut, not every fallback.
      let subSources = allStreams[0].subtitles || [];
      if (!subSources.length && tmdbId) {
        subSources = await settleWithin(fetchExternalSubs(tmdbId, isTv ? season : null, isTv ? episode : null), 6000, []);
      }

      for (let i = 0; i < subSources.length; i++) {
        const sub = subSources[i];
        if (!sub || !sub.url || seenSubs[sub.url]) continue;
        seenSubs[sub.url] = true;
        allSubs.push(sub);
      }

      const primaryHeaders = allStreams[0].headers || videasyStreamHeaders();
      const primaryUrl = allStreams[0].url;
      const primaryLabel = allStreams[0].label || 'Auto';

      const result = {
        url: primaryUrl,
        stream: primaryUrl,
        quality: primaryLabel,
        streamType: /\.m3u8(?:[?#]|$)/i.test(primaryUrl) ? 'hls' : (/\.mp4(?:[?#]|$)/i.test(primaryUrl) ? 'mp4' : ''),
        streams: streamsArray,
        headers: primaryHeaders,
        subtitles: allSubs,
        qualities: qualities,
        servers: allStreams.map(function (s) {
          return { name: (s.server || 'Provider') + ' - ' + (s.label || 'Auto'), url: s.url, headers: s.headers,
            subtitles: s.subtitles && s.subtitles.length ? s.subtitles : (s === allStreams[0] ? allSubs : []),
            streamType: /\.m3u8(?:[?#]|$)/i.test(s.url) ? 'hls' : (/\.mp4(?:[?#]|$)/i.test(s.url) ? 'mp4' : '') };
        }),
      };

      return result;
    } catch (e) {
      log('extractStreamUrl failed: ' + (e && e.message ? e.message : e));
      throw e;
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            GLOBAL EXPORTS                                  */
  /* -------------------------------------------------------------------------- */

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
