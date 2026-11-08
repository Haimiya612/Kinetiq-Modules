/* Anime4up — Synthetiq video module.
 * Built around the developer AniKoto pattern:
 * search -> title context -> title-bound episode ids -> episode/player resolution.
 */
(function () {
  'use strict';

  const SITE = 'https://w1.anime4up.rest';
  const CATALOGUE = SITE + '/%D9%82%D8%A7%D8%A6%D9%85%D8%A9-%D8%A7%D9%84%D8%A7%D9%86%D9%85%D9%8A/';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
  const HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ar,en;q=0.7'
  };

  const now = () => Date.now();
  const remaining = (deadline, cap) => Math.max(700, Math.min(deadline - now(), cap));

  function cleanText(v) {
    return String(v == null ? '' : v)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch (_) { return ''; } })
      .replace(/\s+/g, ' ').trim();
  }

  function absolute(href, base) {
    const v = String(href == null ? '' : href).trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    try { return new URL(v, base || SITE + '/').href; } catch (_) {
      const b = String(base || SITE + '/').replace(/#.*$/, '');
      const origin = (b.match(/^https?:\/\/[^/]+/i) || [])[0] || SITE;
      if (v.charAt(0) === '/') return origin + v;
      if (v.charAt(0) === '?') return b.replace(/[?#].*$/, '') + v;
      return b.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + v;
    }
  }

  async function requestText(url, headers, timeoutMs, method, body) {
    // Fragments are client-side only; forwarding them creates noisy/invalid
    // URLs in some module runtimes and can break server candidates.
    const requestUrl = String(url || '').replace(/#.*$/, '');
    const res = await fetchv2(requestUrl, headers || {}, method || 'GET', body == null ? null : body, { timeoutMs: timeoutMs || 12000 });
    let text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    else if (res && typeof res.body === 'string') text = res.body;
    else if (res && res.body != null) text = String(res.body);
    // The app's fetchv2 polyfill keeps JSON responses in memory and returns an EMPTY text() for
    // them (the parsed value is only exposed through json()). A JSON endpoint read through text()
    // alone therefore looks like an empty body - which is exactly how every Share4Max mirror list
    // was being lost. Backfill from json() before reporting the body, and expose it to callers.
    let parsed = null;
    if (res && typeof res.json === 'function') {
      try { parsed = await res.json(); } catch (_) { parsed = null; }
    } else if (res && res.json != null) {
      parsed = res.json;
    }
    if (!text && parsed != null) {
      try { text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed); } catch (_) {}
    }
    return { status: Number(res && res.status) || 0, text, json: parsed, headers: (res && res.headers) || {}, finalUrl: String((res && (res.finalUrl || res.url)) || '') };
  }

  function firstAttr(block, attr) {
    const s = String(block || '');
    const n = String(attr || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dq = s.match(new RegExp(n + '\\s*=\\s*"([^"]*)"', 'i'));
    if (dq) return dq[1];
    const sq = s.match(new RegExp(n + "\\s*=\\s*'([^']*)'", 'i'));
    return sq ? sq[1] : '';
  }

  function meta(html, key, attr) {
    const k = String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const a = String(attr || 'property').replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re1 = new RegExp('<meta[^>]+(?:' + a + ')=\"' + k + '\"[^>]+content=\"([^\"]*)', 'i');
    const re2 = new RegExp('<meta[^>]+content=\"([^\"]*)\"[^>]+(?:' + a + ')=\"' + k + '\"', 'i');
    let m = String(html).match(re1);
    if (m) return cleanText(m[1]);
    m = String(html).match(re2);
    return m ? cleanText(m[1]) : '';
  }

  function titleFromCard(block, href) {
    const s = String(block || '');
    // Prefer the visible heading/link text used by Anime4up cards.
    const heading = s.match(/<(?:h1|h2|h3|h4|h5|strong)\b[^>]*>([\s\S]*?)<\/(?:h1|h2|h3|h4|h5|strong)>/i);
    if (heading) {
      const t = cleanText(heading[1]);
      if (t && !/^(tv|movie|ona|ova)$/i.test(t)) return stripCardMeta(t);
    }
    const attrs = ['data-title','aria-label','title','alt'];
    for (const a of attrs) {
      const v = firstAttr(s, a);
      const t = stripCardMeta(cleanText(v));
      if (t && t.length > 1 && !/^(tv|movie|ona|ova)$/i.test(t)) return t;
    }
    // Finally use the anchor's textual content, removing the type/rating labels.
    const t = stripCardMeta(cleanText(s.replace(/<img\b[^>]*>/gi, ' ')));
    if (t) return t;
    const slug = (String(href || '').match(/\/anime\/([^/?#]+)/i) || ['', ''])[1];
    return stripCardMeta(decodeURIComponent(slug || '').replace(/[-_]+/g, ' '));
  }

  function stripCardMeta(v) {
    return cleanText(v)
      .replace(/\b(?:TV|Movie|ONA|OVA)\b/gi, ' ')
      .replace(/(?:rating|التقييم)\s*[:：]?\s*\d+(?:\.\d+)?/gi, ' ')
      .replace(/\s*[-|•]\s*$/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function imageFromAnchor(block, base) {
    const s = String(block || '');
    let image = '';
    // Anime4up uses several lazy-loading variants depending on the page/cache.
    for (const a of [
      'data-src','data-lazy-src','data-original','data-image','data-img',
      'data-original-src','data-url','data-thumb','src'
    ]) {
      image = firstAttr(s, a);
      if (image && !/^data:image\//i.test(image)) break;
      image = '';
    }
    if (!image) {
      for (const a of ['data-srcset','data-lazy-srcset','srcset']) {
        const ss = firstAttr(s, a);
        if (ss) {
          const candidates = ss.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
          if (candidates.length) { image = candidates[candidates.length - 1]; break; }
        }
      }
    }
    // Some WordPress themes put the real poster in an inline background.
    if (!image) {
      const style = firstAttr(s, 'style');
      const bm = style.match(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (bm) image = bm[1];
    }
    return absolute(image, base);
  }

  function animeArtwork(html, base, title) {
    const target = normalize(title || '');
    let best = '', bestScore = -1;
    const re = /<img\b[^>]*>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      const tag = m[0];
      const alt = cleanText(firstAttr(tag, 'alt') || firstAttr(tag, 'title'));
      const image = imageFromAnchor(tag, base);
      if (!image) continue;
      let path = image;
      try { path = new URL(image).pathname; } catch (_) {}
      if (/(?:anime4up|logo|placeholder|no[-_]?image|images\.png|145dfg5s6d6gh5)/i.test(alt + ' ' + path)) continue;
      const label = normalize(alt);
      let score = 1;
      if (target && label === target) score += 100;
      else if (target && label && (target.includes(label) || label.includes(target))) score += 50;
      if (/\/wp-content\/uploads\//i.test(path)) score += 5;
      if (/-\d{2,4}x\d{2,4}(?=\.)/i.test(path)) score -= 10;
      if (score > bestScore) { best = image; bestScore = score; }
    }
    return best;
  }

  function artworkMetaFallback(html, base) {
    const candidate = absolute(meta(html, 'og:image', 'property') || meta(html, 'twitter:image', 'name'), base);
    if (!candidate) return '';
    let path = candidate;
    try { path = new URL(candidate).pathname; } catch (_) {}
    return /(?:anime4up|logo|images\.png|145dfg5s6d6gh5|placeholder|no[-_]?image)/i.test(path) ? '' : candidate;
  }

  function parseAnimeCards(html) {
    const src = String(html || '');
    const out = [], seen = {};

    // Anime4up's catalogue currently renders each card as two adjacent links:
    //   1) an image-only <a> whose href points to the image file
    //   2) an <a href="/anime/SLUG/"> containing the title
    // They are NOT the same href. Therefore image->anime matching by URL is
    // inherently unsafe and caused posters to shift onto other anime.
    // Instead, walk the card anchors in document order and bind the nearest
    // preceding image anchor to the following anime title anchor.
    const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
    const anchors = [];
    let m;
    while ((m = anchorRe.exec(src))) {
      const block = m[0];
      anchors.push({ href: absolute(m[1]), rawHref: m[1], block, index: m.index, end: anchorRe.lastIndex });
    }

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (!/\/anime\/[^/?#]+/i.test(a.href || '')) continue;

      const title = titleFromCard(a.block, a.href);
      if (!title || title.length < 2 || /^(tv|movie|ona|ova)$/i.test(title)) continue;
      if (seen[a.href]) continue;

      let image = '';

      // First choice: the immediately preceding anchor is Anime4up's image
      // anchor for this exact card. Require that it contains an <img> and is
      // close enough that it cannot belong to the previous card.
      if (i > 0) {
        const prev = anchors[i - 1];
        const gap = a.index - prev.end;
        if (gap >= 0 && gap < 1800 && /<img\b/i.test(prev.block)) {
          image = imageFromAnchor(prev.block, SITE + '/');
          if (!image) {
            // The clickable image itself may use its href as the image URL.
            const rh = String(prev.rawHref || '');
            if (/\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$/i.test(rh)) image = absolute(rh, SITE + '/');
          }
        }
      }

      // Fallback: find an image anchor in the same short card region, but
      // stop at the previous anime title anchor so cards can never cross-pair.
      if (!image) {
        let j = i - 1;
        let distance = 0;
        while (j >= 0 && distance < 1800) {
          const prev = anchors[j];
          distance = a.index - prev.index;
          if (/\/anime\/[^/?#]+/i.test(prev.href || '')) break;
          if (/<img\b/i.test(prev.block)) {
            image = imageFromAnchor(prev.block, SITE + '/');
            if (!image && /\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$/i.test(String(prev.rawHref || '')))
              image = absolute(prev.rawHref, SITE + '/');
            break;
          }
          j--;
        }
      }

      // Strong fallback: locate an actual <img> belonging to this card and
      // bind it to the next anime title anchor. This handles lazy-loaded
      // markup where the image and title are wrapped in different elements.
      if (!image) {
        const regionStart = i > 0 ? anchors[i - 1].end : Math.max(0, a.index - 3000);
        const region = src.slice(regionStart, a.index);
        const imgs = region.match(/<img\b[\s\S]*?>/gi) || [];
        for (let k = imgs.length - 1; k >= 0; k--) {
          const candidate = imageFromAnchor(imgs[k], SITE + '/');
          if (candidate) { image = candidate; break; }
        }
      }

      // Last fallback: image attributes in the title anchor itself.
      if (!image) image = imageFromAnchor(a.block, a.href);

      seen[a.href] = 1;
      out.push({ id: a.href, href: a.href, title, image, poster: image });
    }

    return out;
  }

  function normalize(v) {
    return cleanText(v).toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function matches(item, q) {
    const query = normalize(q);
    const title = normalize(item.title);
    const slug = normalize((item.href.match(/\/anime\/([^/?#]+)/i) || ['', ''])[1]);
    if (!query) return true;
    if (title === query || slug === query) return true;
    const words = query.split(' ').filter(Boolean);
    const hay = title + ' ' + slug;
    return hay.indexOf(query) >= 0 || words.every(w => hay.indexOf(w) >= 0);
  }

  async function searchResults(query) {
    const q = String(query || '').trim();
    if (!q) return parseAnimeCards((await requestText(CATALOGUE, HEADERS, 14000)).text).slice(0, 50);

    // Anime4up's public search is WordPress-style. Try the normal search
    // endpoint first, then the catalogue with the query as a parameter.
    const candidates = [
      SITE + '/?s=' + encodeURIComponent(q),
      CATALOGUE + '?s=' + encodeURIComponent(q),
      SITE + '/search/?q=' + encodeURIComponent(q)
    ];
    for (let i = 0; i < candidates.length; i++) {
      const r = await requestText(candidates[i], Object.assign({}, HEADERS, { Referer: CATALOGUE }), 12000);
      if (r.status !== 200 || !r.text) continue;
      const items = parseAnimeCards(r.text);
      const filtered = items.filter(x => matches(x, q));
      if (filtered.length) return filtered.slice(0, 50);
    }

    // Last-resort catalogue search: fetch the first few catalogue pages and
    // filter locally. This keeps search Anime4up-only even if its search route
    // changes or is blocked by a cache/proxy.
    const all = [];
    const seen = {};
    for (let p = 1; p <= 4 && all.length < 200; p++) {
      const u = p === 1 ? CATALOGUE : CATALOGUE.replace(/\/$/, '') + '/page/' + p + '/';
      const r = await requestText(u, HEADERS, 9000);
      if (r.status !== 200 || !r.text) break;
      const page = parseAnimeCards(r.text);
      if (!page.length) break;
      let added = 0;
      page.forEach(x => { if (!seen[x.href]) { seen[x.href] = 1; all.push(x); added++; } });
      if (!added) break;
    }
    return all.filter(x => matches(x, q)).slice(0, 50);
  }

  function parseGenres(html) {
    const out = [], seen = {};
    const re = /<a\b[^>]+href=["'][^"']*(?:genre|genres|تصنيف)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      const g = cleanText(m[1]);
      // Anime4up sometimes exposes a generic "Video" tag alongside the
      // real anime genres. It is not a genre, so never surface it in details.
      const key = g.toLowerCase().replace(/\s+/g, ' ').trim();
      if (g && key !== 'video' && key !== 'videos' && key !== 'فيديو' && key !== 'فيديوهات' && !seen[g]) {
        seen[g] = 1;
        out.push(g);
      }
    }
    return out;
  }

  async function extractDetails(urlOrId) {
    let url = absolute(urlOrId);
    if (!/\/anime\/[^/?#]+/i.test(url)) {
      const found = await searchResults(urlOrId);
      if (!found.length) throw new Error('Anime4up title not found');
      url = found[0].href;
    }
    const r = await requestText(url, Object.assign({}, HEADERS, { Referer: SITE + '/' }), 12000);
    if (r.status !== 200 || !r.text) throw new Error('Anime4up details HTTP ' + r.status);
    const html = r.text;
    const title = cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || meta(html, 'og:title', 'property');
    const description = meta(html, 'og:description', 'property') || cleanText((html.match(/(?:class|id)=["'][^"']*(?:story|synopsis|description|desc)[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1] || '');
    const image = animeArtwork(html, url, title) || artworkMetaFallback(html, url);
    const slug = (url.match(/\/anime\/([^/?#]+)/i) || ['', ''])[1].toLowerCase();
    const year = ((html.match(/(?:بداية العرض|السنة|year)[^\d]{0,30}(\d{4})/i) || [])[1] || '');
    const ctx = 'A4SHOW|anime|' + slug + '|' + encodeURIComponent(url);
    return {
      id: ctx, href: url, url,
      title: title || slug.replace(/[-_]+/g, ' '),
      description: cleanText(description), synopsis: cleanText(description),
      image, poster: image, banner: image, genres: parseGenres(html),
      ...(year ? { year } : {})
    };
  }

  function parseShowId(raw) {
    const p = String(raw || '').split('|');
    if (p.length >= 4 && p[0] === 'A4SHOW') return { slug: p[2], url: decodeURIComponent(p.slice(3).join('|')) };
    return null;
  }

  function episodeNumber(text, href) {
    let decodedHref = String(href || '');
    try { decodedHref = decodeURIComponent(decodedHref); } catch (_) {}
    const s = cleanText(decodeEntities(text) + ' ' + decodedHref);
    let m = s.match(/(?:الحلقة|حلقة|episode|ep)\s*[-_:#：]?\s*(\d+(?:\.\d+)?)/i);
    if (m) return Number(m[1]);
    m = decodedHref.match(/(?:الحلقة|episode|ep)[-_ ]+.*?[-_](\d+(?:\.\d+)?)(?:[-_/?]|$)/i);
    if (!m) m = decodedHref.match(/(?:^|[-_/])(?:الحلقة|episode|ep)[-_ ]*(\d+(?:\.\d+)?)(?:[-_/?]|$)/i);
    if (m) return Number(m[1]);
    return NaN;
  }

  function parseEpisodes(html, baseUrl) {
    const out = [], seen = {};
    // Accept regular hrefs and lazy/encoded link attributes used by alternate
    // Anime4up templates; still require a decoded /episode/ path.
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      const attrs = m[1];
      const rawHref = decodeEntities(firstAttr(attrs, 'href') || firstAttr(attrs, 'data-href') || firstAttr(attrs, 'data-url'));
      if (!rawHref) continue;
      let decodedPath = rawHref;
      try { decodedPath = decodeURIComponent(rawHref); } catch (_) {}
      if (!/\/episode\//i.test(decodedPath)) continue;
      const href = absolute(rawHref, baseUrl);
      const n = episodeNumber(m[2] + ' ' + firstAttr(attrs, 'aria-label') + ' ' + firstAttr(attrs, 'title'), href);
      if (!href || !Number.isFinite(n) || n <= 0 || n > 10000 || seen[n]) continue;
      seen[n] = 1;
      out.push({ href, number: n, title: 'Episode ' + n });
    }
    out.sort((a, b) => a.number - b.number);
    return out;
  }

  function parseEpisodeId(raw) {
    const p = String(raw || '').split('|');
    if (p.length >= 4 && p[0] === 'A4EP') return { slug: p[1], number: Number(p[2]), url: decodeURIComponent(p.slice(3).join('|')) };
    return null;
  }

  async function extractEpisodes(seriesId) {
    const ctx = parseShowId(seriesId);
    let url = ctx ? ctx.url : absolute(seriesId);
    if (!url || !/\/anime\//i.test(url)) return [];
    let slug = (url.match(/\/anime\/([^/?#]+)/i) || ['', ''])[1].toLowerCase();
    if (!slug) return [];
    const r = await requestText(url, Object.assign({}, HEADERS, { Referer: CATALOGUE }), 12000);
    if (r.status !== 200 || !r.text) return [];

    const canonical = absolute(meta(r.text, 'og:url', 'property') || url);
    let pageUrl = url;
    const siteAnimePrefix = SITE.toLowerCase().replace(/\/$/, '') + '/anime/';
    if (canonical && canonical.toLowerCase().indexOf(siteAnimePrefix) === 0) {
      pageUrl = canonical;
      slug = ((canonical.match(/\/anime\/([^/?#]+)/i) || ['', slug])[1]).toLowerCase();
    }

    let episodeHtml = r.text;
    let parsed = parseEpisodes(episodeHtml, pageUrl);
    const pageText = cleanText(r.text);
    const expected = Number(((pageText.match(/(?:عدد\s+الحلقات|عدد\s+حلقات|episodes?)\s*[:：]?\s*(\d{1,4})/i) || [])[1]) || 0);
    // Retry ascending order when links are missing or clearly incomplete, then
    // merge rather than discard links from the original response.
    if (!parsed.length || (expected > 0 && parsed.length < expected)) {
      const retryUrl = pageUrl + (pageUrl.indexOf('?') >= 0 ? '&' : '?') + 'ep_order=asc';
      const retry = await requestText(retryUrl, Object.assign({}, HEADERS, { Referer: pageUrl }), 9000);
      if (retry.status === 200 && retry.text) {
        episodeHtml = retry.text;
        const fromRetry = parseEpisodes(episodeHtml, retry.finalUrl || retryUrl);
        const merged = Object.create(null);
        parsed.concat(fromRetry).forEach(ep => { if (!merged[ep.number]) merged[ep.number] = ep; });
        parsed = Object.keys(merged).map(n => merged[n]).sort((a, b) => a.number - b.number);
      }
    }
    const title = cleanText((episodeHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || meta(episodeHtml, 'og:title', 'property');
    const artwork = animeArtwork(episodeHtml, pageUrl, title) || artworkMetaFallback(episodeHtml, pageUrl);
    return parsed.map(ep => ({
      id: 'A4EP|' + slug + '|' + ep.number + '|' + encodeURIComponent(ep.href),
      href: 'A4EP|' + slug + '|' + ep.number + '|' + encodeURIComponent(ep.href),
      number: ep.number,
      episodeNumber: ep.number,
      title: 'Episode ' + ep.number,
      ...(artwork ? { image: artwork, poster: artwork, banner: artwork } : {}),
      season: 1,
      subAvailable: true
    }));
  }

  // ======================================================================
  // v13 — player discovery + per-host resolvers
  // ======================================================================
  const SOCIAL = /(?:facebook\.com|twitter\.com|\/\/x\.com|reddit\.com|pinterest\.com|t\.me|whatsapp:|google-analytics|googletagmanager|doubleclick|cdnjs\.cloudflare|googleapis\.com|gstatic\.com|cdn-cgi)/i;

  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&#0*38;|&amp;|&#x26;/gi, '&')
      .replace(/&#0*47;|&#x2f;/gi, '/')
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCharCode(parseInt(n, 16)); } catch (_) { return ''; } })
      .replace(/&quot;|&#0*34;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/').replace(/\\u003a/gi, ':')
      .replace(/\\x26/gi, '&').replace(/\\x2f/gi, '/').replace(/\\x3a/gi, ':').replace(/\\\//g, '/');
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64decode(str) {
    const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    let out = '', bits = 0, acc = 0;
    for (let i = 0; i < s.length; i++) {
      acc = (acc << 6) | B64.indexOf(s[i]); bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); acc &= (1 << bits) - 1; }
    }
    return out;
  }

  // Dean Edwards p.a.c.k.e.r unpacker (used by StreamRuby / StreamWish-family hosts).
  function unpackPacked(src) {
    const s = String(src || '');
    const m = s.match(/\}\('((?:[^'\\]|\\[\s\S])*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\[\s\S])*)'\.split\('\|'\)/);
    if (!m) return '';
    const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const a = Number(m[2]);
    let c = Number(m[3]);
    const k = m[4].split('|');
    const e = (n) => (n < a ? '' : e(parseInt(n / a, 10))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const d = {};
    while (c--) d[e(c)] = k[c] || e(c);
    return payload.replace(/\b\w+\b/g, (w) => (d[w] != null ? d[w] : w));
  }

  function rot13(s) {
    return String(s).replace(/[A-Za-z]/g, (ch) => {
      const base = ch <= 'Z' ? 65 : 97;
      return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
    });
  }

  function originOf(u) { return (String(u || '').match(/^(https?:\/\/[^/]+)/i) || [])[1] || ''; }

  function kindOf(u) {
    const s = String(u || '').toLowerCase();
    if (/mp4upload\./.test(s)) return 'mp4upload';
    if (/uqload\./.test(s)) return 'uqload';
    if (/rubyvidhub|streamruby|streamwish|vidhide|filelions|swhoi|awish|dwish/.test(s)) return 'ruby';
    if (/voe\.sx|voe-network|\bvoe\d*\./.test(s)) return 'voe';
    if (/playmogo|dood|dsvplay|ds2play|d000d|vide0\./.test(s)) return 'dood';
    if (/vkvideo\.|\/\/vk\.com|\/\/m\.vk\.com|vk\.ru/.test(s)) return 'vk';
    if (/videa\.hu/.test(s)) return 'videa';
    if (/share4max|megamax\.me\/(?:iframe|embed)|\/iframe\//.test(s)) return 'megamax';
    if (/anime4up-s\d|5zm9iup/.test(s)) return 'a4';
    return 'generic';
  }

  // Only genuine embed/player URLs — never download pages such as /d/ID.
  function isEmbedUrl(u) {
    return /\/(?:e|v|embed|iframe)[\/-]|embed-|video_ext\.php|\/player\?|Anime4up-S\d/i.test(u);
  }

  // Share4Max's wrapper is not itself a video: it is a quality/server picker.
  // Resolve its mirrors first so the app's primary stream is a selected actual
  // host (normally 1080p), rather than an unrelated UQLoad item from the page.
  const KIND_RANK = { megamax: 0, mp4upload: 1, voe: 2, ruby: 3, vk: 4, dood: 5, uqload: 6, a4: 7, videa: 8, generic: 9 };
  const KIND_NAME = { mp4upload: 'Mp4upload', uqload: 'UQLoad', ruby: 'Streamruby', voe: 'VOE', dood: 'DoodStream', vk: 'VK', videa: 'Videa', megamax: 'Megamax', a4: 'Anime4up', generic: 'Player' };

  function qualityOf(label) {
    const m = String(label || '').match(/\b(FHD|HD|SD)\b/i);
    return m ? m[1].toUpperCase() : '';
  }

  function parsePlayerLinks(html, base) {
    // Some module fetches return a serialized HTML copy even though browsers
    // render the server tabs normally. Normalize HTML entities and JS escapes.
    const src = decodeEntities(String(html || ''))
      .replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>')
      .replace(/\\u0022|\\x22/gi, '"').replace(/\\u0027|\\x27/gi, "'")
      .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\//g, '/');
    const out = [], seen = {};

    const add = (raw, label, trusted) => {
      let u = decodeEntities(raw).trim();
      if (!u || u === '#' || /^(?:javascript|mailto|whatsapp|tel):/i.test(u)) return;
      u = absolute(u, base);
      if (!/^https?:\/\//i.test(u) || seen[u] || SOCIAL.test(u)) return;
      u = u.replace(/#.*$/, '');
      const path = u.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
      if (/\/(?:e|embed|iframe|v)\/?$/i.test(path)) return; // empty player endpoint
      if (/\/(?:d|download|file|dl)\/[^/]/i.test(u)) return; // download pages are not players
      if (u.indexOf(SITE) === 0 && !/Anime4up-S\d|\/mal\//i.test(u) && !/\/(?:embed|player|iframe)\b/i.test(u)) return;
      const kind = kindOf(u);
      // Known hosts need an embed-style path; unknown hosts are only trusted when the
      // markup itself says "this is a server" (iframe, or a server-labelled tag).
      if (kind !== 'generic' && !isEmbedUrl(u)) return;
      if (kind === 'generic' && !trusted) return;
      seen[u] = 1;
      const q = qualityOf(label);
      out.push({ url: u, kind, quality: q, name: (KIND_NAME[kind] || 'Player') + (q ? ' ' + q : '') });
    };

    // 1) Every opening tag: read ALL attributes (the server URL may live in href,
    //    data-url, data-ep-url, data-embed, value, ... — we don't guess the name).
    const tagRe = /<(a|button|li|div|span|option|iframe)\b([^>]*)>/gi;
    let m;
    while ((m = tagRe.exec(src))) {
      const attrs = m[2];
      const isIframe = m[1].toLowerCase() === 'iframe';
      const label = cleanText(src.slice(tagRe.lastIndex, tagRe.lastIndex + 220).split(/<\/(?:a|li|button|option)>/i)[0]);
      const serverish = /(?:megamax|anime4up\d?|videa|vidmoly|voe|vk|uqload|dood|mp4upload|streamruby|ruby|سيرفر|server)/i.test(label + ' ' + attrs);
      const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let am;
      while ((am = attrRe.exec(attrs))) {
        const name = am[1].toLowerCase();
        const val = am[2] != null ? am[2] : am[3];
        if (!val || /^(?:class|id|style|title|alt|rel|target|lang|dir|type|name)$/.test(name)) continue;
        if (/^(?:https?:)?\/\//i.test(val.trim()) || /Anime4up-S\d/i.test(val)) add(val, label, isIframe || serverish);
        else if (name === 'onclick') (val.match(/https?:\/\/[^'"\s)]+/gi) || []).forEach(u => add(u, label, serverish));
      }
    }

    // The primary Anime4up server list uses data-watch for player URLs.
    // Inspect it independently so escaped wrappers cannot hide all candidates.
    const watchRe = /data-watch\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    while ((m = watchRe.exec(src))) add(m[1] || m[2] || m[3], 'Anime4up server', true);

    // 2) Any raw URL in the page (inline JS config, JSON, comments).
    const rawSrc = decodeEntities(src);
    const raw = rawSrc.match(/https?:\/\/[^\s'"<>\\]+/gi) || [];
    raw.forEach(u => add(u, '', false));

    return out.slice(0, 30);
  }

  function parseMedia(html, base) {
    const out = [], seen = {};
    const blockedHosts = /(?:cdnjs\.cloudflare\.com|ajax\.googleapis\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|facebook\.com|twitter\.com|x\.com|reddit\.com|pinterest\.com|t\.me|google-analytics\.com|googletagmanager\.com|doubleclick\.net)$/i;
    const add = (raw) => {
      let u = decodeEntities(raw).trim();
      if (!u) return;
      try { u = absolute(u, base); } catch (_) { return; }
      if (!u || !/^https?:\/\//i.test(u)) return;
      const parts = u.match(/^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
      if (!parts) return;
      const hostname = parts[1].replace(/:\d+$/, '').toLowerCase();
      if (!hostname || !hostname.includes('.') || blockedHosts.test(hostname)) return;
      const path = (parts[2] || '/').toLowerCase();
      const search = (parts[3] || '').toLowerCase();
      const directExt = /\.(?:m3u8|mp4|m4v|webm|mkv)(?:$|[?#])/i.test(path);
      const mediaQuery = /(?:^|[?&])(?:file|source|src|video|video_url|stream|manifest)=https?/i.test(search);
      const mediaPath = /\/(?:hls|dash|stream|streams|video|videos|media|manifest)(?:\/|$)/i.test(path);
      if (!(directExt || mediaQuery || mediaPath)) return;
      if (/\.(?:js|css|json|html?|php|jpe?g|png|webp|gif|svg|vtt|srt|ico|woff2?|ttf)(?:$|[?#])/i.test(path)) return;
      if (seen[u]) return;
      seen[u] = 1;
      out.push(u);
    };

    const src = decodeEntities(html);
    let m;

    const elementRe = /<(?:video|source)[^>]+\b(?:src|data-src|data-url)=['"]([^'"]+)['"]/gi;
    while ((m = elementRe.exec(src))) add(m[1]);

    // Explicit media keys: file / src / source(s) / hls2 / url720 / video_url ...
    const configRe = /["']?(?:file|src|sources?|source|hls\d?|m3u8|mp4|dash|manifest_url|video|video_url|media_url|play_url|url\d{3,4}|stream_url)["']?\s*[:=]\s*\[?\s*\{?\s*(?:["']?(?:file|src|url)["']?\s*:\s*)?["']([^"']+)["']/gi;
    while ((m = configRe.exec(src))) add(m[1]);

    // Quoted relative media paths (common in packed HLS configs).
    const relRe = /["'](\/[^"'\s]+\.(?:m3u8|mp4)(?:\?[^"'\s]*)?)["']/gi;
    while ((m = relRe.exec(src))) add(m[1]);

    const urlRe = /https?:\/\/[^'"<>\s\\]+/gi;
    while ((m = urlRe.exec(src))) add(m[0]);
    return out;
  }

  function decodeInlineMediaConfig(source) {
    const text = decodeEntities(source);
    let expanded = '';
    const patterns = [
      /(?:atob|base64_decode|base64\.decode)\s*\(\s*["']([A-Za-z0-9+/_=-]{24,})["']\s*\)/gi,
      /["'](?:file|src|source|video|stream|hls|data)["']\s*:\s*["']([A-Za-z0-9+/_=-]{32,})["']/gi
    ];
    patterns.forEach(re => {
      let m;
      while ((m = re.exec(text))) {
        const decoded = b64decode(m[1]);
        if (/https?:|\.m3u8|\.mp4|\.mpd|\/video|\/stream/i.test(decoded)) expanded += '\n' + decoded;
      }
    });
    return expanded;
  }

  function mediaResult(url, headers, lang, server) {
    const u = String(url || '');
    return {
      url: u,
      headers: headers || {},
      streamType: /\.m3u8(?:$|[?#])/i.test(u) ? 'hls' : 'mp4',
      lang: String(lang || 'sub'),
      server: server || 'Anime4up'
    };
  }

  function pageHeaders(referer, extra) {
    const h = Object.assign({ 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'ar,en;q=0.7' }, extra || {});
    if (referer) h.Referer = referer;
    return h;
  }

  function playHeaders(pageUrl) {
    const o = originOf(pageUrl);
    return { 'User-Agent': UA, Referer: o ? o + '/' : pageUrl, Origin: o || undefined };
  }

  // ---- generic resolver: follow iframes/servers up to depth 2, collect media ----
  async function resolveGeneric(startUrl, episodeUrl, deadline, lang, name, trace) {
    const queue = [{ url: startUrl, depth: 0, referrer: episodeUrl }];
    const seen = {}, results = [];
    while (queue.length && now() < deadline && results.length < 4) {
      const node = queue.shift();
      const u = String(node.url || '').trim();
      if (!u || seen[u] || node.depth > 2) continue;
      seen[u] = 1;
      try {
        const p = await requestText(u, pageHeaders(node.referrer), remaining(deadline, 5000));
        trace.push('generic ' + originOf(u) + ' → ' + p.status);
        if (p.status !== 200 || !p.text) continue;
        let text = p.text;
        const unpacked = /eval\(function\(p,a,c,k,e,/.test(text) ? unpackPacked(text) : '';
        if (unpacked) text += '\n' + unpacked;
        text += '\n' + decodeInlineMediaConfig(text);
        const media = parseMedia(text, p.finalUrl || u);
        media.forEach(x => results.push(mediaResult(x, playHeaders(p.finalUrl || u), lang, name)));
        if (results.length) continue;
        parsePlayerLinks(p.text, u).forEach(c => { if (c.url !== u && queue.length < 8) queue.push({ url: c.url, depth: node.depth + 1, referrer: u }); });
      } catch (e) { trace.push('generic err ' + (e && e.message || e)); }
    }
    return results;
  }

  // ---- per-host resolvers ----
  async function resolveMp4upload(c, ep, deadline, lang, trace) {
    const p = await requestText(c.url, pageHeaders(ep), remaining(deadline, 6000));
    trace.push('mp4upload → ' + p.status);
    if (p.status !== 200 || !p.text) return [];
    const t = decodeEntities(p.text);
    const m = t.match(/(?:player\.src\(\s*\{[^}]*?)?\bsrc\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) || t.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    const urls = m ? [m[1]] : parseMedia(t, c.url);
    return urls.map(u => mediaResult(u, { 'User-Agent': UA, Referer: 'https://www.mp4upload.com/' }, lang, c.name));
  }

  async function resolveUqload(c, ep, deadline, lang, trace) {
    const p = await requestText(c.url, pageHeaders(ep), remaining(deadline, 6000));
    trace.push('uqload → ' + p.status);
    if (p.status !== 200 || !p.text) return [];
    let t = decodeEntities(p.text);
    let base = p.finalUrl || c.url;
    let urls = parseMedia(t, base);
    // UQLoad's current embed is a button-backed form. A GET only returns the
    // play button; POST its hidden fields to /dl to obtain the actual player.
    if (!urls.length && now() < deadline && /<form\b[^>]*\bid=["']F1["']/i.test(t)) {
      const form = (t.match(/<form\b[^>]*\bid=["']F1["'][^>]*>/i) || [])[0] || '';
      const fields = Object.create(null);
      const inputRe = /<input\b[^>]*>/gi;
      let input;
      while ((input = inputRe.exec(t))) {
        const tag = input[0];
        const name = firstAttr(tag, 'name');
        if (name) fields[name] = firstAttr(tag, 'value');
      }
      let code = fields.file_code || ((base.match(/\/e\/([^/?#]+)/i) || [])[1]) || '';
      if (code) {
        fields.op = fields.op || 'embed';
        fields.file_code = code;
        fields.auto = fields.auto || '1';
        fields.referer = fields.referer || ep;
        const origin = originOf(base);
        const action = absolute(firstAttr(form, 'action') || '/dl', base);
        const postHeaders = pageHeaders(base, { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin });
        const formBody = Object.keys(fields).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(fields[k] || '')).join('&');
        const submitted = await requestText(action, postHeaders, remaining(deadline, 6000), 'POST', formBody);
        trace.push('uqload form → ' + submitted.status);
        if (submitted.status === 200 && submitted.text) {
          base = submitted.finalUrl || action;
          const postedHtml = decodeEntities(submitted.text);
          const packedPlayer = /eval\(function\(p,a,c,k,e,/.test(postedHtml) ? unpackPacked(postedHtml) : '';
          const inlinePlayer = decodeInlineMediaConfig(postedHtml);
          // UQLoad currently keeps the JWPlayer source inside a Dean Edwards
          // packed setup() call. The unexpanded page also contains poster and
          // thumbnail assets, so resolve only after unpacking its real config.
          t += '\n' + postedHtml + (packedPlayer ? '\n' + packedPlayer : '');
          urls = parseMedia(postedHtml + '\n' + packedPlayer + '\n' + inlinePlayer, base);
          if (packedPlayer) trace.push('uqload player config unpacked');
        }
      }
    }
    const sources = t.match(/sources\s*:\s*\[\s*["']([^"']+)["']/i);
    if (!urls.length && sources) urls = [absolute(sources[1], base)];
    return urls.filter(Boolean).map(u => mediaResult(u, playHeaders(base), lang, c.name));
  }

  // Share4Max does not expose a <video>/<source> in the initial embed HTML.
  // Its Inertia app fetches the actual quality/mirror list as a partial prop;
  // the listed links then point to ordinary video hosts handled below.
  //
  // Two payload shapes exist in the wild, and the original build only accepted
  // the first: a paginator ({ props: { streams: { data: [...] } } }) and a plain
  // array ({ props: { streams: [...] } }). Mirror rows vary too (mirrors /
  // sources / links) and the URL may sit in link / url / src, so read all of them
  // instead of failing the episode with "no mirror list".
  function share4maxQualities(payload) {
    const prop = payload && payload.props && payload.props.streams;
    if (Array.isArray(prop)) return prop;
    if (prop && typeof prop === 'object') {
      const key = ['data', 'items', 'list'].find(k => Array.isArray(prop[k]));
      if (key) return prop[key];
    }
    return null;
  }

  function share4maxMirrors(q) {
    if (!q || typeof q !== 'object') return [];
    const key = ['mirrors', 'sources', 'links', 'files', 'servers', 'players'].find(k => Array.isArray(q[k]));
    return key ? q[key] : [];
  }

  // Compact description of an unexpected payload (keys + types only, no values)
  // so a playback report shows exactly what the provider sent.
  function shapeSummary(value, depth) {
    const d = depth == null ? 0 : depth;
    if (value == null) return String(value);
    if (Array.isArray(value)) return 'array[' + value.length + ']' + (d < 2 && value.length ? ' of ' + shapeSummary(value[0], d + 1) : '');
    if (typeof value !== 'object') return typeof value;
    if (d >= 2) return 'object{…}';
    return 'object{' + Object.keys(value).slice(0, 10).map(k => k + ': ' + shapeSummary(value[k], d + 1)).join(', ') + '}';
  }

  async function resolveShare4max(c, ep, deadline, lang, trace) {
    // Bounded share: this wrapper expands into several host requests, and the
    // episode still needs budget for its other candidates. Previously it could
    // spend the whole 20s episode deadline here.
    const phaseDeadline = Math.min(deadline, now() + 9000);
    const page = await requestText(c.url, pageHeaders(ep), remaining(phaseDeadline, 5500));
    trace.push('share4max page → ' + page.status);
    if (page.status !== 200 || !page.text) return [];
    const pageHtml = decodeEntities(page.text).replace(/\\"/g, '"').replace(/\\\//g, '/');
    const component = (pageHtml.match(/["']component["']\s*:\s*["']([^"']+)["']/i) || [])[1] || 'files/mirror/video';
    const version = (pageHtml.match(/["']version["']\s*:\s*["']([^"']+)["']/i) || [])[1] || '';

    // The page itself embeds the Inertia payload; keep it as a fallback for when
    // the partial request does not return JSON (e.g. the X-Inertia headers are
    // ignored and the full page comes back).
    let inlinePayload = null;
    const inline = pageHtml.match(/<script[^>]*data-page\s*=\s*["']app["'][^>]*>([\s\S]*?)<\/script>/i);
    if (inline && inline[1]) {
      try { inlinePayload = JSON.parse(decodeEntities(inline[1])); } catch (_) {}
    }

    let payload = null;
    if (version) {
      const h = pageHeaders(c.url, {
        'X-Inertia': 'true',
        'X-Inertia-Version': version,
        'X-Inertia-Partial-Component': component.replace(/\\\//g, '/'),
        'X-Inertia-Partial-Data': 'streams',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*'
      });
      const partial = await requestText(c.url, h, remaining(phaseDeadline, 5500));
      trace.push('share4max streams → ' + partial.status);
      if (partial.json && typeof partial.json === 'object') {
        payload = partial.json;
      } else if (partial.status === 200 && partial.text) {
        try { payload = JSON.parse(partial.text); } catch (_) { trace.push('share4max partial not JSON (' + partial.text.length + ' bytes)'); }
      }
    } else {
      trace.push('share4max missing Inertia version');
    }
    if (!payload && inlinePayload) {
      payload = inlinePayload;
      trace.push('share4max using inline page payload');
    }
    if (!payload) return [];

    const qualities = share4maxQualities(payload);
    if (!Array.isArray(qualities)) {
      trace.push('share4max unexpected streams shape: ' + shapeSummary(payload && payload.props));
      return [];
    }
    if (!qualities.length) { trace.push('share4max empty mirror list'); return []; }

    const mirrors = [];
    qualities.forEach(q => share4maxMirrors(q).forEach(m => {
      const link = absolute(decodeEntities(m.link || m.url || m.src || m.file || ''), c.url);
      if (!link || mirrors.some(x => x.url === link)) return;
      const quality = cleanText(q.label || q.resolution || q.quality || 'Auto');
      const driver = cleanText(m.driver || m.name || m.host || 'Mirror');
      const kind = kindOf(link);
      const priority = { mp4upload: 0, ruby: 1, voe: 2, uqload: 3, dood: 4, vk: 5, generic: 6 };
      mirrors.push({ url: link, kind, quality, driver, priority: priority[kind] == null ? 6 : priority[kind], name: 'Share4Max ' + quality + ' · ' + driver });
    }));
    trace.push('share4max mirrors found: ' + mirrors.length);
    const qualityRank = q => /1080|source|fhd/i.test(q) ? 0 : /720|hd/i.test(q) ? 1 : /480|sd/i.test(q) ? 2 : 3;
    mirrors.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality) || a.priority - b.priority);

    const results = [];
    // Quality order is supplied by the page (usually 1080p, 720p, then SD).
    // Two batches at most: the first successfully resolved route becomes the
    // default and the rest are alternates, so walking every mirror costs the
    // episode budget without changing what the app can play.
    for (let i = 0; i < mirrors.length && i < 6 && now() < phaseDeadline && results.length < 3; i += 3) {
      const batch = mirrors.slice(i, Math.min(i + 3, 6));
      const lists = await Promise.all(batch.map(x => resolveCandidate(x, c.url, phaseDeadline, lang, trace).catch(() => [])));
      lists.forEach((list, index) => list.forEach(item => {
        if (item && item.url && !results.some(existing => existing.url === item.url) && results.length < 3) {
          item.server = batch[index].name;
          results.push(item);
        }
      }));
    }
    return results;
  }

  async function resolveRuby(c, ep, deadline, lang, trace) {
    const p = await requestText(c.url, pageHeaders(ep), remaining(deadline, 6000));
    trace.push('ruby → ' + p.status);
    if (p.status !== 200 || !p.text) return [];
    let t = p.text;
    if (/eval\(function\(p,a,c,k,e,/.test(t)) t += '\n' + unpackPacked(t);
    t += '\n' + decodeInlineMediaConfig(t);
    const base = p.finalUrl || c.url;
    return parseMedia(t, base).map(u => mediaResult(u, playHeaders(base), lang, c.name));
  }

  async function resolveVk(c, ep, deadline, lang, trace) {
    const p = await requestText(c.url, pageHeaders('https://vkvideo.ru/'), remaining(deadline, 6000));
    trace.push('vk → ' + p.status);
    if (p.status !== 200 || !p.text) return [];
    const t = decodeEntities(p.text);
    const res = [];
    const mp4 = [];
    let m; const re = /"url(\d{3,4})"\s*:\s*"(https?:[^"]+)"/g;
    while ((m = re.exec(t))) mp4.push({ q: Number(m[1]), u: m[2] });
    mp4.sort((a, b) => b.q - a.q);
    const hdr = { 'User-Agent': UA, Referer: 'https://vkvideo.ru/' };
    const hls = t.match(/"hls(?:_ondemand)?"\s*:\s*"(https?:[^"]+)"/);
    if (hls) res.push(mediaResult(hls[1], hdr, lang, c.name));
    mp4.slice(0, 2).forEach(x => res.push(mediaResult(x.u, hdr, lang, c.name + ' ' + x.q + 'p')));
    return res;
  }

  async function resolveDood(c, ep, deadline, lang, trace) {
    const embed = c.url.replace(/\/d\//, '/e/');
    const p = await requestText(embed, pageHeaders(ep), remaining(deadline, 5000));
    trace.push('dood → ' + p.status);
    if (p.status !== 200 || !p.text) return [];
    const base = originOf(p.finalUrl || embed);
    const m = p.text.match(/\/pass_md5\/[^'"\s<]+/);
    if (!m) return [];
    const token = m[0].split('/').pop();
    const r = await requestText(base + m[0], pageHeaders(embed), remaining(deadline, 5000));
    const prefix = String(r.text || '').trim();
    trace.push('dood md5 → ' + r.status);
    if (!/^https?:\/\//i.test(prefix)) return [];
    let rand = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 10; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    const url = prefix + rand + '?token=' + token + '&expiry=' + Date.now();
    return [mediaResult(url, { 'User-Agent': UA, Referer: base + '/' }, lang, c.name)];
  }

  function decodeVoePayload(enc) {
    let s = rot13(enc);
    ['@$', '^^', '~@', '%?', '*~', '!!', '#&'].forEach(tk => { s = s.split(tk).join(''); });
    s = b64decode(s);
    s = s.split('').map(ch => String.fromCharCode(ch.charCodeAt(0) - 3)).join('');
    s = s.split('').reverse().join('');
    return JSON.parse(b64decode(s));
  }

  async function resolveVoe(c, ep, deadline, lang, trace) {
    let url = c.url, text = '', finalUrl = url;
    for (let hop = 0; hop < 3 && now() < deadline; hop++) {
      const p = await requestText(url, pageHeaders(ep), remaining(deadline, 5000));
      trace.push('voe → ' + p.status);
      text = p.text || ''; finalUrl = p.finalUrl || url;
      if (p.status !== 200 || !text) return [];
      const redir = text.match(/(?:window\.location(?:\.href)?\s*=|location\.replace\()\s*['"](https?:[^'"]+)['"]/);
      if (redir && text.length < 6000) { url = redir[1]; continue; }
      break;
    }
    const found = [];
    ['hls', 'mp4'].forEach(k => {
      const m = text.match(new RegExp('[\'"]' + k + '[\'"]\\s*:\\s*[\'"]([A-Za-z0-9+/=_-]{20,})[\'"]'));
      if (m) { const d = b64decode(m[1]); if (/^https?:\/\//i.test(d)) found.push(d); }
    });
    const enc = text.match(/<script[^>]*type=["']application\/json["'][^>]*>\s*\[?\s*"([^"]+)"\s*\]?\s*<\/script>/i);
    if (enc) {
      try {
        const j = decodeVoePayload(enc[1]);
        [j.source, j.direct_access_url, j.file].forEach(x => { if (x && /^https?:\/\//i.test(x)) found.push(x); });
      } catch (e) { trace.push('voe decode failed'); }
    }
    if (!found.length) parseMedia(text, finalUrl).forEach(x => found.push(x));
    return found.map(u => mediaResult(u, playHeaders(finalUrl), lang, c.name));
  }

  async function resolveCandidate(c, ep, deadline, lang, trace) {
    let res = [];
    try {
      if (c.kind === 'mp4upload') res = await resolveMp4upload(c, ep, deadline, lang, trace);
      else if (c.kind === 'uqload') res = await resolveUqload(c, ep, deadline, lang, trace);
      else if (c.kind === 'megamax') res = await resolveShare4max(c, ep, deadline, lang, trace);
      else if (c.kind === 'ruby') res = await resolveRuby(c, ep, deadline, lang, trace);
      else if (c.kind === 'vk') res = await resolveVk(c, ep, deadline, lang, trace);
      else if (c.kind === 'dood') res = await resolveDood(c, ep, deadline, lang, trace);
      else if (c.kind === 'voe') res = await resolveVoe(c, ep, deadline, lang, trace);
    } catch (e) { trace.push(c.kind + ' err ' + (e && e.message || e)); }
    if (!res.length && now() < deadline) {
      try { res = await resolveGeneric(c.url, ep, deadline, lang, c.name, trace); }
      catch (e) { trace.push('generic err ' + (e && e.message || e)); }
    }
    return res;
  }

  // ---- download-table fallback (kept from v12) ----
  function parseDownloadLinks(html, base) {
    const out = [], seen = {};
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      const text = cleanText(m[0].replace(/<[^>]*>/g, ' '));
      const u = absolute(decodeEntities(m[1]), base);
      if (!u || seen[u] || SOCIAL.test(u)) continue;
      const path = u.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
      if (!path || path === '/' || /\/(?:e|embed|iframe|v)\/?$/i.test(path)) continue;
      if (!/(تحميل|download|megamax\.me|workupload|mediafire|gofile|streamruby\.com\/d|mp4upload\.com\/[a-z0-9]{12}|voe\.sx\/[a-z0-9]+$|dsvplay\.com\/d)/i.test(text + ' ' + u)) continue;
      seen[u] = 1;
      out.push({ url: u, name: text || 'Download' });
    }
    return out.slice(0, 20);
  }

  async function resolveDownloadTree(startUrl, episodeUrl, deadline, lang, name, trace) {
    const results = [];
    try {
      const p = await requestText(startUrl, pageHeaders(episodeUrl), remaining(deadline, 3500));
      trace.push('download ' + originOf(startUrl) + ' → ' + p.status);
      const fin = String(p.finalUrl || '');
      const ct = String((p.headers && (p.headers['content-type'] || p.headers['Content-Type'])) || '').toLowerCase();
      if (fin && (/^video\//.test(ct) || /\.(?:m3u8|mp4|m4v|webm)(?:$|[?#])/i.test(fin))) { results.push(mediaResult(fin, playHeaders(startUrl), lang, name)); return results; }
      if (p.text) parseMedia(p.text, startUrl).forEach(x => results.push(mediaResult(x, playHeaders(startUrl), lang, name)));
    } catch (e) { trace.push('download err ' + (e && e.message || e)); }
    return results;
  }

  function episodeIdOf(x) {
    if (x && typeof x === 'object') x = x.id || x.href || x.url || '';
    return String(x || '');
  }

  async function extractStreamUrl(episodeHref, lang) {
    const raw = episodeIdOf(episodeHref);
    let ctx = parseEpisodeId(raw);
    if (!ctx && /^https?:\/\/.+\/episode\//i.test(raw)) ctx = { slug: '', number: 0, url: raw };
    if (!ctx) return { streams: [], error: { message: 'Anime4up: unrecognised episode id' } };
    const episodeUrl = ctx.url;
    if (!/^https?:\/\//i.test(episodeUrl) || episodeUrl.indexOf('/episode/') < 0) return { streams: [], error: { message: 'Anime4up: bad episode url' } };

    const trace = [];
    const deadline = now() + 20000;
    const r = await requestText(episodeUrl, Object.assign({}, HEADERS, { Referer: ctx.slug ? SITE + '/anime/' + ctx.slug + '/' : SITE + '/' }), remaining(deadline, 9000));
    trace.push('episode page → ' + r.status);
    if (r.status !== 200 || !r.text) {
      return { streams: [], lang: String(lang || 'sub'), error: { message: 'Anime4up episode page HTTP ' + r.status } };
    }

    const players = parsePlayerLinks(r.text, episodeUrl);
    trace.push('servers found: ' + (players.map(p => p.kind).join(',') || 'none'));

    const uniquePlayers = [], seenPlayers = Object.create(null);
    players.forEach(p => {
      const key = p.kind === 'megamax'
        ? p.url.replace(/\/(?:e|embed|iframe)\//i, '/share4max/')
        : p.url;
      if (!seenPlayers[key]) { seenPlayers[key] = 1; uniquePlayers.push(p); }
    });
    // One best entry per host first (FHD > multi/HD > SD), the rest afterwards.
    const qs = (p) => (p.quality === 'FHD' ? 0 : p.quality === 'SD' ? 2 : 1);
    uniquePlayers.sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (qs(a) - qs(b)));
    const firstPass = [], rest = [], kindsSeen = {};
    uniquePlayers.forEach(p => { if (!kindsSeen[p.kind]) { kindsSeen[p.kind] = 1; firstPass.push(p); } else rest.push(p); });
    const candidates = firstPass.concat(rest);

    const allStreams = [];
    const addStream = (s) => { if (s && s.url && !allStreams.some(x => x.url === s.url) && allStreams.length < 8) allStreams.push(s); };

    // Resolve 3 at a time (module cap: 3 concurrent requests). Keep resolving
    // after the first URL: an individual host can return stale/unplayable media,
    // so the app needs alternate servers to recover from a playback error.
    for (let i = 0; i < candidates.length && now() < deadline && allStreams.length < 8;) {
      const window = candidates.slice(i, i + 3);
      // Share4Max expands one candidate into up to three host requests itself;
      // isolate it from outer batches to keep total concurrency at three.
      const batch = window.some(x => x.kind === 'megamax') ? [candidates[i]] : window;
      const lists = await Promise.all(batch.map(c => resolveCandidate(c, episodeUrl, deadline, lang, trace).catch(() => [])));
      lists.forEach(l => l.forEach(addStream));
      i += batch.length;
    }

    if (!allStreams.length) {
      return {
        streams: [],
        lang: String(lang || 'sub'),
        error: { message: 'Anime4up: no playable media. Trace: ' + trace.join(' | ') }
      };
    }

    const primary = allStreams[0];
    const mapRow = (x) => ({ name: x.server, label: x.server, url: x.url, headers: x.headers, streamType: x.streamType, lang: x.lang });
    return {
      url: primary.url,
      headers: primary.headers,
      streamType: primary.streamType,
      lang: primary.lang,
      quality: 'Auto',
      defaultQuality: 'Auto',
      streams: allStreams.map(mapRow),
      servers: allStreams.map(mapRow)
    };
  }

  async function discoveryHome() {
    const r = await requestText(CATALOGUE, Object.assign({}, HEADERS, { Referer: SITE + '/' }), 14000);
    if (r.status !== 200 || !r.text) return { sections: [] };
    const items = parseAnimeCards(r.text).slice(0, 30);
    return { sections: [{ id: 'catalogue', title: 'قائمة الأنمي', style: 'poster', items, viewAll: { mode: 'feed', feedId: 'catalogue' } }] };
  }

  function nextPageUrl(html, currentPage) {
    const re = /<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      const text = cleanText(m[2]);
      const href = absolute(m[1]);
      if (!href) continue;
      if (/next|التالي|›|»/i.test(text)) return href;
      const pm = href.match(/\/page\/(\d+)\/?$/i);
      if (pm && Number(pm[1]) === Number(currentPage) + 1) return href;
    }
    return '';
  }

  async function discoveryFeed(feedId, page) {
    const p = Math.max(1, Number(page) || 1);
    const url = p === 1 ? CATALOGUE : CATALOGUE.replace(/\/$/, '') + '/page/' + p + '/';
    const r = await requestText(url, Object.assign({}, HEADERS, { Referer: CATALOGUE }), 14000);
    if (r.status !== 200 || !r.text) return { feedId: feedId || 'catalogue', page: p, items: [], hasMore: false };
    const items = parseAnimeCards(r.text).slice(0, 30);
    const next = nextPageUrl(r.text, p);
    return { feedId: feedId || 'catalogue', page: p, items, hasMore: !!next || items.length >= 20 };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
