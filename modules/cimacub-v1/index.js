/*
 * CimaClub (w.cimacub.com) - Synthetiq Player module
 *
 * Content: Arabic subtitled movies, series and anime.
 * Contract: V2/V4 (searchResults / extractDetails / extractEpisodes / extractStreamUrl / discoveryHome / discoveryFeed).
 *
 * CATALOGUE - the site is WordPress and its REST API is open, so nothing is scraped for listing:
 *   GET /wp-json/wp/v2/posts?search=<q>&_embed=wp:featuredmedia   -> cards (posts ARE episodes/movies)
 *   GET /wp-json/wp/v2/posts?orderby=date&order=desc              -> newest (home + feed)
 *   Episode titles read "<type> <series> الحلقة <n> مترجمة"; the series page (/series/<slug>/) only
 *   renders the newest episode, so the episode list is rebuilt from a REST search on the series name
 *   (that is exactly the recent window the site actually carries - older episodes are not in the DB).
 *
 * PLAYER - each episode's /watch page lists servers as  <li data-watch="<embed url>"> :
 *   - doodstream (9 per episode) 301s to playmogo.com behind a Cloudflare bot challenge that is served
 *     even to a real browser, so no media URL can be obtained from a runtime like ours -> skipped.
 *   - mixdrop.ps (9 per episode) 302s to mxdrop.top/e/<ref>. The embed page carries a Dean-Edwards
 *     packed block; unpacking it yields
 *         MDCore.wurl = //<vserver>.mxcontent.net/v2/<ref>.mp4?s=..&e=..&_t=..
 *     which is a SIGNED, EXPIRING (about 4 h) mp4 url: resolved per play, never cached. The CDN accepts
 *     it only with the EMBED PAGE as Referer (a CDN referer answers 403), and a deleted file simply has
 *     no wurl at all, so the cascade skips dead mirrors on its own.
 */
(() => {
  'use strict';

  const MODULE_NAME = 'CimaClub';
  const SITE = 'https://w.cimacub.com';
  const REST = SITE + '/wp-json/wp/v2';
  const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const PAGE_HEADERS = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    Referer: SITE + '/',
  };

  const JSON_HEADERS = {
    'User-Agent': UA,
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    Referer: SITE + '/',
  };

  const STREAM_DEADLINE_MS = 16000;
  const MAX_CARDS = 40;
  const MAX_EPISODES = 600;
  // Server families on this site: mixdrop (playable when the file is alive), doodstream (Cloudflare
  // bot wall) and cybervynx (playlists filled with TikTok ad PNGs, verified 2026-10-05). Only mixdrop
  // is offered; the other two cannot produce a verifiable media route.
  const MAX_MIRROR_TRIES = 8;
  const MIXDROP_HOST_RE = /^https?:\/\/(?:www\.)?(?:mixdrop|mxdrop)[a-z0-9.-]*\//i;
  const STREAM_HEADERS = { 'User-Agent': UA, Accept: '*/*' };

  function log(msg) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(msg == null ? '' : msg));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(1, Number(ms) || 0)));
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([promise, sleep(waitMs).then(() => fallback)]);
  }

  function decodeEntities(value) {
    return String(value == null ? '' : value)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#8217;/g, "'")
      .replace(/&#8211;/g, '-')
      .replace(/&hellip;/gi, '...');
  }

  function cleanText(value) {
    return decodeEntities(
      String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' '),
    ).trim();
  }

  function safeJsonParse(text) {
    if (text !== null && typeof text === 'object') return text;
    try {
      return JSON.parse(String(text == null ? '' : text).trim());
    } catch (_) {
      return null;
    }
  }

  function absUrl(value) {
    const raw = decodeEntities(String(value == null ? '' : value)).trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.indexOf('//') === 0) return 'https:' + raw;
    if (raw.charAt(0) === '/') return SITE + raw;
    return SITE + '/' + raw.replace(/^\.?\//, '');
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

  async function request(url, options) {
    const cfg = options || {};
    const method = cfg.method || 'GET';
    const headers = Object.assign({}, cfg.headers || PAGE_HEADERS);
    const body = cfg.body == null ? null : cfg.body;
    const timeoutMs = Math.max(1000, Number(cfg.timeoutMs) || 12000);
    try {
      if (typeof fetchv2 === 'function') {
        const res = await settleWithin(fetchv2(url, headers, method, body), timeoutMs, null);
        if (!res) return { ok: false, status: 0, body: '', json: null, headers: {} };
        const status = Number((res && res.status) || 0);
        const text = await readResponseBody(res);
        return {
          ok: status >= 200 && status < 300,
          status: status,
          body: text,
          json: safeJsonParse(text),
          headers: (res && res.headers) || {},
        };
      }
      if (typeof fetch === 'function') {
        const res = await settleWithin(fetch(url, { method: method, headers: headers, body: body }), timeoutMs, null);
        if (!res) return { ok: false, status: 0, body: '', json: null, headers: {} };
        const text = await res.text();
        return {
          ok: !!res.ok,
          status: Number(res.status || 0),
          body: text,
          json: safeJsonParse(text),
          headers: {},
        };
      }
    } catch (e) {
      log('request error: ' + (e && e.message ? e.message : String(e)));
    }
    return { ok: false, status: 0, body: '', json: null, headers: {} };
  }

  function pickMeta(html, key) {
    const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      '<meta[^>]*?(?:property|name)=["\']' + esc + '["\'][^>]*?content=["\']([^"\']*)["\']',
      'i',
    );
    const m = re.exec(html);
    return m ? decodeEntities(m[1]) : '';
  }

  // ------------------------------------------------------------------ catalogue (WP REST)

  function imageFromPost(post) {
    try {
      const emb = post && post._embedded && post._embedded['wp:featuredmedia'];
      if (emb && emb.length) {
        const media = emb[0] || {};
        if (media.source_url) return String(media.source_url);
        const sizes = (media.media_details && media.media_details.sizes) || {};
        const order = ['medium_large', 'large', 'full', 'medium'];
        for (let i = 0; i < order.length; i++) {
          const s = sizes[order[i]];
          if (s && s.source_url) return String(s.source_url);
        }
      }
    } catch (_) {}
    return '';
  }

  function cardFromPost(post) {
    if (!post || !post.link) return null;
    const title = cleanText((post.title && post.title.rendered) || '');
    if (!title) return null;
    return {
      title: title,
      image: imageFromPost(post),
      href: String(post.link),
      id: String(post.id || ''),
    };
  }

  function postsFromBody(body) {
    const parsed = safeJsonParse(body);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return [];
  }

  async function restPosts(queryString, timeoutMs) {
    const url = REST + '/posts?' + queryString;
    const res = await request(url, { headers: JSON_HEADERS, timeoutMs: timeoutMs || 11000 });
    if (!res.ok) {
      log('rest ' + res.status + ' for ' + queryString.slice(0, 60));
      return [];
    }
    return postsFromBody(res.body);
  }

  async function searchResults(query) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return [];
    try {
      const posts = await restPosts(
        'search=' + encodeURIComponent(q) + '&per_page=' + MAX_CARDS + '&orderby=date&order=desc&_embed=wp%3Afeaturedmedia',
        11000,
      );
      const cards = [];
      const seen = Object.create(null);
      for (let i = 0; i < posts.length; i++) {
        const card = cardFromPost(posts[i]);
        if (!card || seen[card.href]) continue;
        seen[card.href] = 1;
        cards.push(card);
        if (cards.length >= MAX_CARDS) break;
      }
      log('search "' + q + '" -> ' + cards.length + ' cards');
      return cards;
    } catch (e) {
      log('search failed: ' + (e && e.message ? e.message : String(e)));
      return [];
    }
  }

  async function newestPosts(page, perPage) {
    const p = Math.max(1, Number(page) || 1);
    const n = Math.min(100, Math.max(1, Number(perPage) || 30));
    return restPosts(
      'per_page=' + n + '&page=' + p + '&orderby=date&order=desc&_embed=wp%3Afeaturedmedia',
      11000,
    );
  }

  function cardsFrom(posts) {
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < posts.length; i++) {
      const card = cardFromPost(posts[i]);
      if (!card || seen[card.href]) continue;
      seen[card.href] = 1;
      out.push(card);
    }
    return out;
  }

  // ------------------------------------------------------------------ titles

  const EP_NUMBER_RE = /(?:الحلقة|الحلقه|حلقة)\s*(\d{1,4})/;
  const MOVIE_RE = /(?:^|\s)(?:فيلم|فلم)(?:\s|$)/;

  function isMovieTitle(title) {
    return MOVIE_RE.test(String(title || ''));
  }

  function episodeNumber(title, href) {
    const t = String(title || '');
    let m = EP_NUMBER_RE.exec(t);
    if (m) return parseInt(m[1], 10);
    const u = decodeURIComponent(String(href || ''));
    m = /(?:الحلقة|الحلقه)[-\s]*(\d{1,4})/.exec(u) || /-(\d{1,4})-/.exec(u);
    return m ? parseInt(m[1], 10) : 0;
  }

  // "انمي One Piece الحلقة 1180 مترجمة" -> "One Piece"
  function seriesNameFromTitle(title) {
    let name = cleanText(title);
    if (!name) return '';
    name = name.replace(EP_NUMBER_RE, '').replace(/\s+/g, ' ').trim();
    name = name
      .replace(/^(?:انمي|أنمي|مسلسل|مشاهدة|فيلم|فلم|برنامج|كرتون)\s+/i, '')
      .replace(/\s+(?:مترجمة|مترجم|مدبلجة|مدبلج|كاملة|كامل|اون لاين|اون لاين)\s*$/i, '')
      .replace(/\s+(?:الموسم|موسم)\s+\S+\s*$/i, '')
      .trim();
    return name;
  }

  function seriesNameFromSeriesUrl(url) {
    const raw = decodeURIComponent(String(url || ''));
    const m = /\/series\/([^/?#]+)\/?/i.exec(raw);
    if (!m) return '';
    return String(m[1]).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const BRAND_RE = /\s*[-|]\s*(?:سيما كلوب|CimaClub|CIMACLUB)\s*$/i;

  function looksLikeBrand(value) {
    const t = cleanText(value);
    if (!t) return true;
    return /^(?:سيما كلوب|CimaClub|CIMACLUB|سيما)$/i.test(t);
  }

  // The site sets og:title to the bare brand, so the readable title lives in <h1> / <title>.
  // Series pages put the newest episode in <h1>, so those prefer the document title.
  function pageTitleFromHtml(html, preferDoc) {
    const src = String(html || '');
    const h1 = cleanText((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(src) || [null, ''])[1]);
    const doc = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src) || [null, ''])[1]);
    const clean = (v) => (v && !looksLikeBrand(v) ? v.replace(BRAND_RE, '').trim() : '');
    if (preferDoc) return clean(doc) || clean(h1);
    return clean(h1) || clean(doc);
  }

  function slugFromUrl(url) {
    const raw = String(url == null ? '' : url).split('?')[0].split('#')[0].replace(/\/+$/, '');
    const segs = raw.split('/').filter((s) => s.length);
    const last = segs[segs.length - 1] || '';
    if (!last || /^watch$/i.test(last)) return '';
    if (segs[segs.length - 2] === 'series') return '';
    return decodeURIComponent(last);
  }

  async function restPostBySlug(slug) {
    if (!slug) return null;
    const posts = await restPosts('slug=' + encodeURIComponent(slug) + '&_fields=title,link,id', 9000);
    return posts && posts.length ? posts[0] : null;
  }

  // ------------------------------------------------------------------ details / episodes

  async function extractDetails(urlOrId) {
    const input = String(urlOrId == null ? '' : urlOrId).trim();
    const target = /^https?:\/\//i.test(input) ? input : absUrl(input);
    const fallbackTitle = decodeURIComponent(
      target.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, ''),
    ).replace(/[-_]+/g, ' ');

    const res = await request(target, { headers: PAGE_HEADERS, timeoutMs: 12000 });
    const html = res.body || '';
    if (!html) {
      return { title: fallbackTitle, description: '', image: '', href: target, url: target };
    }

    const isSeriesUrl = /\/series\//i.test(target);
    let title = pageTitleFromHtml(html, isSeriesUrl);
    if (!title) {
      const bySlug = await restPostBySlug(slugFromUrl(target));
      if (bySlug && bySlug.title && bySlug.title.rendered) title = cleanText(bySlug.title.rendered);
    }
    if (!title) title = fallbackTitle;

    const description =
      pickMeta(html, 'og:description') || pickMeta(html, 'description') || '';
    const image = pickMeta(html, 'og:image') || '';
    const seriesMatch = /"url"\s*:\s*"(https?:\/\/[^"]*\/series\/[^"]+)"/i.exec(html);
    const seriesUrl = seriesMatch ? decodeEntities(seriesMatch[1]) : '';

    return {
      title: title,
      description: description,
      image: image,
      href: target,
      url: target,
      author: seriesUrl ? 'CimaClub' : '',
      status: isMovieTitle(title) ? 'Movie' : 'Series',
    };
  }

  async function seriesPosts(seriesName) {
    const name = String(seriesName || '').trim();
    if (!name) return [];
    const out = [];
    const seen = Object.create(null);
    let pages = 0;
    for (let page = 1; page <= 2; page++) {
      const posts = await restPosts(
        'search=' + encodeURIComponent(name) + '&per_page=100&page=' + page + '&orderby=date&order=desc',
        11000,
      );
      pages++;
      if (!posts.length) break;
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        const title = cleanText((post.title && post.title.rendered) || '');
        if (!title || seen[post.link]) continue;
        // keep only real episodes of THIS series: the title must carry the name and an episode number
        if (title.indexOf(name) < 0) continue;
        if (!EP_NUMBER_RE.test(title)) continue;
        seen[post.link] = 1;
        out.push({ title: title, href: String(post.link), number: episodeNumber(title, post.link) });
      }
      if (posts.length < 100 || out.length >= MAX_EPISODES) break;
      if (page < 2) await sleep(250);
    }
    log('series "' + name + '": ' + out.length + ' episodes from ' + pages + ' page(s)');
    return out;
  }

  async function extractEpisodes(seriesId) {
    const input = String(seriesId == null ? '' : seriesId).trim();
    const target = /^https?:\/\//i.test(input) ? input : absUrl(input);
    if (!target) return [];

    const isSeriesUrl = /\/series\//i.test(target);
    const res = await request(target, { headers: PAGE_HEADERS, timeoutMs: 12000 });
    const html = res.body || '';

    let pageTitle = pageTitleFromHtml(html, isSeriesUrl);
    if (!isSeriesUrl) {
      // Post pages: the REST title is the authoritative, uncluttered source for the series name.
      const bySlug = await restPostBySlug(slugFromUrl(target));
      if (bySlug && bySlug.title && bySlug.title.rendered) pageTitle = cleanText(bySlug.title.rendered);
    }

    let seriesName = seriesNameFromTitle(pageTitle) || seriesNameFromSeriesUrl(target);

    // A movie is a single playable item: no episode list to enumerate.
    if (isMovieTitle(pageTitle) || isMovieTitle(seriesName)) {
      log('movie title -> single item');
      return [{ number: 1, href: target, title: pageTitle || seriesName, subAvailable: true, dubAvailable: false }];
    }

    let episodes = [];
    if (seriesName) episodes = await seriesPosts(seriesName);

    // Fallback: whatever the series page itself links, plus the requested episode.
    if (!episodes.length) {
      const linkRe = new RegExp('href="(' + SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"]*?-\\d{1,4}-[^"]*?)"', 'gi');
      let m;
      while ((m = linkRe.exec(html)) !== null) {
        const href = decodeEntities(m[1]);
        const title = seriesName + ' ' + String(episodeNumber('', href));
        episodes.push({ title: title, href: href, number: episodeNumber('', href) });
      }
      if (!episodes.length) {
        episodes = [{ title: pageTitle || seriesName || 'Episode', href: target, number: episodeNumber(pageTitle, target) || 1 }];
      }
    }

    // Newest post wins for a duplicated episode number; then ascending order.
    const byNumber = Object.create(null);
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const key = String(ep.number || 0);
      if (!byNumber[key]) byNumber[key] = ep;
    }
    const list = Object.keys(byNumber)
      .map((k) => byNumber[k])
      .sort((a, b) => (a.number || 0) - (b.number || 0))
      .slice(0, MAX_EPISODES);

    const out = [];
    for (let i = 0; i < list.length; i++) {
      const ep = list[i];
      const title = String(ep.title || '');
      const dubbed = /مدبلج/i.test(title);
      out.push({
        number: ep.number || i + 1,
        href: ep.href,
        title: title,
        subAvailable: !dubbed,
        dubAvailable: dubbed,
      });
    }
    log('episodes: ' + out.length);
    return out;
  }

  // ------------------------------------------------------------------ streams

  // Dean-Edwards packer:  eval(function(p,a,c,k,e,d){...}('<payload>',<base>,<count>,'k0|k1|...'.split('|'),0,{}))
  function unpackPacker(html) {
    const m = /}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/.exec(String(html || ''));
    if (!m) return '';
    const payload = m[1];
    const base = parseInt(m[2], 10) || 10;
    const words = m[4].split('|');
    // base 10 packs index tokens as digits, base 36 as short alphanumerics (1j, 3b, 4c).
    // Substitute whole runs only - a rolling window would chew through long ids and signed urls.
    return String(payload).replace(/[0-9A-Za-z]+/g, function (run) {
      if (base > 10) {
        if (run.length > 5) return run;
        const n36 = parseInt(run, 36);
        if (!(n36 >= 0) || n36 >= words.length || words[n36] === undefined) return run;
        return words[n36];
      }
      if (!/^[0-9]+$/.test(run)) return run;
      const n = parseInt(run, 10);
      if (!(n >= 0) || n >= words.length || words[n] === undefined) return run;
      return words[n];
    });
  }

  function watchServers(html) {
    const src = String(html || '');
    const out = [];
    const seen = Object.create(null);

    // One file can appear as /e/ (embed), /f/ (file page) and /d/ (download) on several mirrors;
    // they are the same media, so dedupe per family+ref instead of fetching each shape.
    const keyOf = (url) => {
      const m = /^https?:\/\/(?:www\.)?([a-z0-9.-]+)\/(?:e|f|d|embed|v)\/([A-Za-z0-9_-]+)/i.exec(url);
      if (!m) return url;
      let fam = m[1];
      if (/mixdrop|mxdrop/i.test(fam)) fam = 'mixdrop';
      else if (/doodstream|playmogo|dood\.|ds2play/i.test(fam)) fam = 'doodstream';
      else if (/cybervynx/i.test(fam)) fam = 'cybervynx';
      return fam + ':' + m[2];
    };
    const push = (value) => {
      const url = absUrl(decodeEntities(value));
      if (!url) return;
      const key = keyOf(url);
      if (seen[key]) return;
      seen[key] = 1;
      out.push(url);
    };

    let m;
    const dw = /data-watch\s*=\s*["']([^"']+)["']/gi;
    while ((m = dw.exec(src)) !== null) push(m[1]);

    // The download block repeats the players and sometimes carries a mirror the server list omits -
    // verified: an episode whose three listed mirrors were all deleted played from a download-only
    // ref. /f/<ref> and /d/<ref> map to the same media as the /e/<ref> embed.
    const href = /href\s*=\s*["'](https?:\/\/[^"']+\/(?:e|f|d)\/[A-Za-z0-9_-]+)["']/gi;
    while ((m = href.exec(src)) !== null) {
      const raw = m[1];
      if (!/(mixdrop|mxdrop|doodstream|playmogo|cybervynx|ds2play|dood\.)/i.test(raw)) continue;
      push(raw.replace(/\/(f|d)\//, '/e/'));
    }

    return out;
  }

  function qualityLabel(html) {
    const m = /\[(\d{3,4}p)\]/i.exec(String(html || ''));
    return m ? m[1] : '';
  }

  async function resolveMirror(embedUrl, timeoutMs) {
    const res = await request(embedUrl, { headers: PAGE_HEADERS, timeoutMs: timeoutMs || 9000 });
    if (!res.ok || !res.body) {
      log('mirror ' + embedUrl.slice(-14) + ' -> http ' + res.status);
      return null;
    }
    const source = unpackPacker(res.body);
    if (!source) {
      log('mirror ' + embedUrl.slice(-14) + ' -> no packer / deleted');
      return null;
    }
    const wurl = /MDCore\.wurl\s*=\s*["']([^"']+)["']/i.exec(source);
    if (!wurl || !wurl[1]) {
      log('mirror ' + embedUrl.slice(-14) + ' -> no wurl (file deleted)');
      return null;
    }
    let media = decodeEntities(wurl[1]).replace(/\\\//g, '/').trim();
    if (media.indexOf('//') === 0) media = 'https:' + media;
    if (!/^https?:\/\//i.test(media)) return null;
    return { media: media, quality: qualityLabel(res.body) || 'auto', referer: embedUrl };
  }

  async function extractStreamUrl(episodeHref, lang) {
    const started = Date.now();
    const input = String(episodeHref == null ? '' : episodeHref).trim();
    if (!input) return { streams: [], subtitles: [] };
    const base = absUrl(input).replace(/\/+$/, '');
    const watchUrl = /\/watch$/i.test(base) ? base + '/' : base + '/watch/';

    const res = await request(watchUrl, { headers: PAGE_HEADERS, timeoutMs: 10000 });
    const html = res.body || '';
    if (!html) {
      log('watch page unavailable (' + res.status + ')');
      return { streams: [], subtitles: [] };
    }

    const servers = watchServers(html);
    const mirrors = servers.filter((u) => MIXDROP_HOST_RE.test(u));
    const dood = servers.length - mirrors.length;
    log(
      'watch: ' + servers.length + ' servers (' + mirrors.length + ' mixdrop, ' + dood +
      ' doodstream/cybervynx not usable)',
    );

    const streams = [];
    const qualities = [];
    let tries = 0;
    const streamType = 'mp4';

    for (let i = 0; i < mirrors.length && tries < MAX_MIRROR_TRIES; i++) {
      if (Date.now() - started > STREAM_DEADLINE_MS - 3000) {
        log('deadline reached, stopping mirror cascade');
        break;
      }
      tries++;
      let resolved = null;
      try {
        resolved = await resolveMirror(mirrors[i], 9000);
      } catch (e) {
        log('mirror error: ' + (e && e.message ? e.message : String(e)));
      }
      if (!resolved) continue;
      const headers = { 'User-Agent': UA, Referer: resolved.referer, Accept: '*/*' };
      const label = resolved.quality || 'auto';
      streams.push(label, resolved.media);
      qualities.push({ label: label, url: resolved.media, headers: headers });
      log(
        'resolved ' + label + ' via mixdrop (' + tries + ') in ' +
        Math.round((Date.now() - started) / 100) / 10 + 's',
      );
      break;
    }

    if (!streams.length) {
      log('no playable mirror for ' + watchUrl);
      return { streams: [], subtitles: [] };
    }

    return {
      streams: streams,
      headers: qualities[0].headers,
      qualities: qualities,
      subtitles: [],
      streamType: 'mp4',
      isLive: false,
    };
  }

  // ------------------------------------------------------------------ discovery

  async function discoveryHome() {
    const sections = [];

    // The newest page and the three themed rows are independent; fetching them in sequence cost
    // ~8s on device. They run together now (three searches - within caps.maxConcurrentRequests).
    const rows = [
      { id: 'movies', title: 'أفلام مترجمة', query: 'مشاهدة فيلم' },
      { id: 'series', title: 'مسلسلات مترجمة', query: 'مسلسل' },
      { id: 'anime', title: 'أنمي مترجم', query: 'انمي' },
    ];
    const results = await Promise.all(
      [newestPosts(1, 40).catch(function () { return []; })].concat(
        rows.map(function (row) {
          return searchResults(row.query).catch(function () { return []; });
        }),
      ),
    );

    const newest = cardsFrom(results[0] || []);
    if (newest.length) {
      sections.push({
        id: 'latest',
        title: 'أحدث الإضافات',
        style: 'hero',
        items: newest.slice(0, 8),
        viewAll: { mode: 'feed', feedId: 'latest' },
      });
      if (newest.length > 8) {
        sections.push({
          id: 'latest-row',
          title: 'أحدث الحلقات والأفلام',
          style: 'poster',
          items: newest.slice(8, 38),
          viewAll: { mode: 'feed', feedId: 'latest' },
        });
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const cards = results[i + 1] || [];
      if (!cards.length) continue;
      sections.push({
        id: rows[i].id,
        title: rows[i].title,
        style: 'poster',
        items: cards.slice(0, 30),
        viewAll: { mode: 'search', query: rows[i].query },
      });
    }

    log('discovery sections: ' + sections.length);
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    const p = Math.max(1, Number(page) || 1);
    try {
      const cards = cardsFrom(await newestPosts(p, 50));
      return { items: cards.slice(0, 50), page: p, hasMore: cards.length >= 20 };
    } catch (e) {
      return { items: [], page: p, hasMore: false };
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
