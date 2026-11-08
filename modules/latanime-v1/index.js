(() => {
  'use strict';

  const MODULE_NAME = 'Latanime';
  const SITE = 'https://latanime.org';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  let csrfToken = null;

  function log(message) {
    try { console.log('[' + MODULE_NAME + '] ' + String(message || '')); } catch (_) {}
  }

  function base64Decode(str) {
    try {
      if (typeof Buffer !== 'undefined') return Buffer.from(str, 'base64').toString('utf-8');
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      let result = '', i = 0;
      str = str.replace(/[^A-Za-z0-9+/=]/g, '');
      while (i < str.length) {
        const a = chars.indexOf(str.charAt(i++)), b = chars.indexOf(str.charAt(i++));
        const c = chars.indexOf(str.charAt(i++)), d = chars.indexOf(str.charAt(i++));
        result += String.fromCharCode(((a << 2) | (b >> 4)) & 255);
        if (c !== 64) result += String.fromCharCode(((b & 15) << 4) | (c >> 2) & 255);
        if (d !== 64) result += String.fromCharCode(((c & 3) << 6) | d);
      }
      return result;
    } catch (_) { return ''; }
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
  }

  function toAbsoluteUrl(value, base) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return 'https:' + raw;
    const root = base || SITE;
    return raw.startsWith('/') ? root + raw : root + '/' + raw;
  }

  function imageUrl(tag) {
    const lazy = String(tag || '').match(/\bdata-src=["']([^"']+)["']/i);
    const src = String(tag || '').match(/\bsrc=["']([^"']+)["']/i);
    return toAbsoluteUrl((lazy || src || [])[1] || '');
  }

  async function ensureCsrfToken() {
    if (csrfToken) return csrfToken;
    try {
      const res = await requestText(SITE);
      const match = res.match(/meta\s+name="csrf-token"\s+content="([^"]+)"/i);
      if (match) csrfToken = match[1];
    } catch (_) {}
    return csrfToken;
  }

  async function requestText(url, extraHeaders) {
    const headers = Object.assign(
      { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json,*/*', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' },
      extraHeaders || {},
    );
    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, headers, 'GET', null);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { headers });
    }
    const status = Number((res && res.status) || 0);
    if (!res || status >= 400) {
      throw new Error('HTTP ' + (status || '') + ' for ' + url);
    }
    let text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    if (!text && res && typeof res.body === 'string') text = res.body;
    return text || '';
  }

  // ========== Stream URL Extraction ==========

  const ASSET_EXT_RE = /\.(css|js|svg|png|jpe?g|gif|ico|webp|woff2?|ttf|map|pdf)(\?|#|$)/i;
  const DECOY_RE = /test-videos\.co\.uk|bigbuckbunny|sample-videos|samplelib\.com|commondatastorage/i;
  const DEAD_FILE_RE = /no longer available|file (was |has been )?(deleted|removed)|expired or has been deleted/i;

  // Collects EVERY media candidate. The extension must sit at a real path
  // boundary (".mp4" inside a hostname like mp4upload.com, or inside an asset
  // like videojs.min.css, must never match). First-match-wins regexes were the
  // 2026-08-20 false-PASS root cause — never collapse this to a single match.
  function streamsFromText(text) {
    const s = String(text || '')
      .replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const found = [];
    const seen = {};
    const collect = (re, kind) => {
      let m;
      while ((m = re.exec(s)) !== null) {
        const u = m[0];
        if (!u || seen[u]) continue;
        if (DECOY_RE.test(u)) continue;
        if (ASSET_EXT_RE.test(u)) continue;
        seen[u] = true;
        found.push({ url: u, kind });
      }
    };
    collect(/https?:\/\/[^"'\s<>\\]+?\.mp4(?:\?[^"'\s<>\\]*)?(?=[\s<>"']|$)/gi, 'mp4');
    collect(/https?:\/\/[^"'\s<>\\]+?\.m3u8(?:\?[^"'\s<>\\]*)?(?=[\s<>"']|$)/gi, 'hls');
    // Prefer MP4 (seekable, downloadable) over HLS variants on this site.
    found.sort((a, b) => (a.kind === 'mp4' ? 0 : 1) - (b.kind === 'mp4' ? 0 : 1));
    return found;
  }

  function streamFromText(text) {
    const all = streamsFromText(text);
    return all.length > 0 ? all[0] : null;
  }

  function findStreamInPage(page) {
    if (!page) return null;
    const html = String((page && page.html) || '');

    // 1) Real media requests captured during the page load — prefer master HLS.
    const events = (page && page.events) || [];
    if (Array.isArray(events)) {
      const mediaUrls = [];
      for (const ev of events) {
        if (!ev) continue;
        const u = String(ev.url || '');
        const found = streamFromText(u);
        if (found) mediaUrls.push(found);
      }
      if (mediaUrls.length > 0) {
        const master = mediaUrls.find((s) => /master/i.test(s.url) && s.kind === 'hls');
        return master || mediaUrls[0];
      }
      const bodies = [];
      for (const ev of events.slice(-40)) {
        if (!ev) continue;
        const body = String(ev.body || '');
        if (body.indexOf('.m3u8') >= 0 || body.indexOf('.mp4') >= 0) bodies.push(body);
      }
      for (const text of bodies) {
        const found = streamFromText(text);
        if (found) return found;
      }
    }

    return streamFromText(html);
  }

  function isChallenge(html) {
    return /just a moment|attention required|cloudflare challenge|enable javascript/i.test(String(html || ''));
  }

  // HTTP resolution — fast, shares the app's network session. Returns an array
  // of candidates ({url, kind, referer}); empty when the host needs real JS.
  async function resolveWithHttp(embedUrl) {
    try {
      const html = await requestText(embedUrl, { Referer: SITE + '/' });
      if (isChallenge(html)) return [];
      if (DEAD_FILE_RE.test(html)) return [];
      return streamsFromText(html).map((s) => ({ url: s.url, kind: s.kind, referer: embedUrl }));
    } catch (_) {
      return [];
    }
  }

  // Mixdrop — fingerprint gate first, then the real player page. Parked-domain
  // mirrors (mixdrop.is was sold 2026) are rejected up front.
  async function resolveMixdrop(embedUrl) {
    try {
      let html = await requestText(embedUrl, { Referer: SITE + '/' });
      if (/abovedomains|forsale\.min\.js|domain.*for sale/i.test(html)) return [];
      const gate = html.match(/redirect_link\s*=\s*'([^']+)'/i);
      if (gate) {
        html = await requestText(gate[1] + 'fp=-7', { Referer: embedUrl });
      }
      if (isChallenge(html)) return [];
      if (DEAD_FILE_RE.test(html)) return [];
      return streamsFromText(html).map((s) => ({ url: s.url, kind: s.kind, referer: embedUrl }));
    } catch (_) {
      return [];
    }
  }

  // pagev2 resolution — WKWebView, only for JS-heavy embeds.
  async function resolveWithPageV2(embedUrl, timeoutMs) {
    if (typeof pagev2 !== 'function') return null;
    const CLICK_PLAY_SCRIPT = `(() => {
      try {
        if (typeof player_start === 'function') { try { player_start(); } catch (_) {} }
        const clickables = document.querySelectorAll('.vjs-big-play-button, .play-button, .play-overlay, .playhover, [class*="play"]');
        for (const el of clickables) { try { el.click(); } catch (_) {} }
        const v = document.querySelector('video');
        if (v) {
          try { v.muted = true; v.playsInline = true; v.setAttribute('muted', 'true'); v.setAttribute('playsinline', 'true'); } catch (_) {}
          try { v.play(); } catch (_) {}
        }
      } catch (_) {}
      return true;
    })()`;
    const LIVE_SOURCE_SCRIPT = `(() => {
      try {
        const pick = (el) => {
          try { return (el && (el.currentSrc || el.src)) || ''; } catch (_) { return ''; }
        };
        let u = pick(document.querySelector('video'));
        if (!u) {
          const srcs = document.querySelectorAll('video source');
          for (const s of srcs) { u = pick(s); if (u) break; }
        }
        if (!u) {
          for (const p of document.querySelectorAll('video[data-src], video[src]')) { u = pick(p); if (u) break; }
        }
        if (!u) {
          try {
            const jw = document.querySelector('.jw-video, #vplayer, [id*="player"] video');
            if (jw) u = pick(jw);
          } catch (_) {}
        }
        return String(u || '');
      } catch (_) { return ''; }
    })()`;
    try {
      const result = await pagev2({
        url: embedUrl,
        timeoutMs: timeoutMs || 12000,
        settleMs: 1500,
        includeHtml: true,
        captureResponseBodies: true,
        maxResponseChars: 400000,
        maxEntries: 60,
        userAgent: USER_AGENT,
        actionScript: CLICK_PLAY_SCRIPT,
        waitForResponseUrlIncludes: '.m3u8',
        returnScript: LIVE_SOURCE_SCRIPT,
      });
      const finalUrl = String((result && result.finalUrl) || embedUrl);

      // 1) Live player source reported by the page itself.
      const live = String((result && result.evalData) || '');
      if (/^https?:\/\//i.test(live) && /\.(m3u8|mp4)/i.test(live)) {
        const fromLive = streamFromText(live);
        if (fromLive) return { ...fromLive, referer: finalUrl };
      }

      // 2) Real media requests captured during the page load.
      const stream = findStreamInPage(result);
      if (stream) return { ...stream, referer: finalUrl };
      return null;
    } catch (_) {
      return null;
    }
  }

  // OK.ru — data-options metadata when present, else generic link scan.
  // Returns an array like the other HTTP resolvers.
  async function resolveOkRu(embedUrl) {
    try {
      const httpsUrl = embedUrl.replace(/^http:\/\//, 'https://');
      const html = await requestText(httpsUrl, { Referer: SITE + '/' });
      if (isChallenge(html) || DEAD_FILE_RE.test(html)) return [];
      const optMatch = html.match(/data-options="([^"]+)"/i);
      if (optMatch) {
        const raw = optMatch[1].replace(/&quot;/g, '"');
        const parsed = JSON.parse(raw);
        const meta = JSON.parse(parsed.flashvars.metadata);
        const videos = (meta && meta.videos) || [];
        if (videos.length > 0) {
          return videos
            .slice()
            .sort((a, b) => (b.size || 0) - (a.size || 0))
            .filter((v) => v && v.url)
            .map((v) => ({ url: v.url, kind: 'mp4', referer: httpsUrl }));
        }
      }
      return streamsFromText(html).map((s) => ({ url: s.url, kind: s.kind, referer: httpsUrl }));
    } catch (_) {}
    return [];
  }

  // ========== searchResults ==========
  async function searchResults(query) {
    log('search: ' + query);

    if (!query || !query.trim()) {
      const home = await discoveryHome();
      const allItems = (home.sections || []).flatMap((s) => s.items || []);
      return allItems.slice(0, 50);
    }

    const token = await ensureCsrfToken();
    if (token) {
      try {
        const headers = {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': token,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
        };
        const body = JSON.stringify({ q: query });
        let res = null;
        if (typeof fetchv2 === 'function') {
          res = await fetchv2(SITE + '/buscar_ajax', headers, 'POST', body);
        } else if (typeof fetch === 'function') {
          res = await fetch(SITE + '/buscar_ajax', { method: 'POST', headers, body });
        }
        if (res && res.status >= 200 && res.status < 300) {
          let text = '';
          if (typeof res.text === 'function') text = await res.text();
          else if (typeof res.body === 'string') text = res.body;
          const data = JSON.parse(text);
          if (Array.isArray(data)) {
            return data.map((item) => ({
              href: item.url || '',
              image: item.imagen || '',
              title: item.nombre || '',
            })).filter((item) => item.href && item.title);
          }
        }
      } catch (e) {
        log('AJAX search failed: ' + (e.message || '').slice(0, 80));
      }
    }

    try {
      const html = await requestText(SITE + '/buscar?q=' + encodeURIComponent(query));
      return parseAnimeCards(html);
    } catch (_) { return []; }
  }

  // ========== extractDetails ==========
  async function extractDetails(urlOrId) {
    log('details: ' + urlOrId);
    const url = toAbsoluteUrl(urlOrId);
    const html = await requestText(url);

    const titleMatch = html.match(/<h2[^>]*>([^<]+)<\/h2>/i);
    const altTitleMatch = html.match(/<h3[^>]*class="[^"]*opacity-75[^"]*"[^>]*>([^<]+)<\/h3>/i);
    const descMatch = html.match(/<p[^>]*class="[^"]*opacity-75[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const episodeCountMatch = html.match(/Episodios:\s*(\d+)/i);
    const statusMatch = html.match(/<span[^>]*class="[^"]*btn-estado[^"]*"[^>]*>([^<]+)<\/span>/i);
    const yearMatch = html.match(/Estreno:\s*[^0-9]*(\d{4})/i);

    const genres = [];
    const genreRe = /<a[^>]*href="[^"]*\/genero\/([^"]+)"[^>]*><div[^>]*class="btn"[^>]*>([^<]+)<\/div><\/a>/gi;
    let gm;
    while ((gm = genreRe.exec(html)) !== null) genres.push(cleanText(gm[2]));

    const imageTags = html.match(/<img\b[^>]*>/gi) || [];
    const poster = imageTags.find((tag) => /\b(?:serieimgficha|img-fluid2)\b/i.test(tag)) || '';

    return {
      href: url,
      title: titleMatch ? cleanText(titleMatch[1]) : '',
      altTitle: altTitleMatch ? cleanText(altTitleMatch[1]) : '',
      description: descMatch ? cleanText(descMatch[1]) : '',
      image: imageUrl(poster),
      episodeCount: episodeCountMatch ? parseInt(episodeCountMatch[1], 10) : 0,
      status: statusMatch ? cleanText(statusMatch[1]) : '',
      year: yearMatch ? yearMatch[1] : '',
      genres,
    };
  }

  // ========== extractEpisodes ==========
  async function extractEpisodes(seriesId) {
    log('episodes: ' + seriesId);
    const url = toAbsoluteUrl(seriesId);
    const html = await requestText(url);
    const episodes = [];

    const re = /<a[^>]*href="([^"]*?-episodio-(\d+))"[^>]*>[\s\S]*?<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const num = parseInt(m[2], 10);
      episodes.push({
        number: num, href: m[1], title: 'Episodio ' + num,
        image: imageUrl((m[0].match(/<img\b[^>]*>/i) || [])[0]), subAvailable: false, dubAvailable: true,
      });
    }

    if (episodes.length === 0) {
      const re2 = /<a[^>]*href="([^"]*\/ver\/[^"]*?-episodio-(\d+))"[^>]*>/gi;
      while ((m = re2.exec(html)) !== null) {
        episodes.push({
          number: parseInt(m[2], 10), href: m[1],
          title: 'Episodio ' + parseInt(m[2], 10),
          image: '', subAvailable: false, dubAvailable: true,
        });
      }
    }

    const seen = new Set();
    return episodes.filter((ep) => {
      if (seen.has(ep.number)) return false;
      seen.add(ep.number);
      return true;
    }).sort((a, b) => a.number - b.number);
  }

  // ========== extractStreamUrl ==========
  async function extractStreamUrl(episodeHref, lang) {
    log('stream: ' + episodeHref + ' lang=' + (lang || ''));
    // Latanime exposes dubbed audio only. Never satisfy a subtitle request
    // with a dubbed route: the app should keep the unavailable mode hidden.
    if (String(lang || '').toLowerCase() === 'sub') {
      return { streams: [], qualities: [], error: 'Subtitles are unavailable for this episode' };
    }
    const url = toAbsoluteUrl(episodeHref);
    const html = await requestText(url);

    const players = [];
    const re = /<a[^>]*class="[^"]*play-video[^"]*"[^>]*data-player="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const decoded = base64Decode(m[1]);
      if (decoded && /^https?:\/\//i.test(decoded)) {
        const label = (cleanText(m[2]) || 'Source').toLowerCase();
        const lower = decoded.toLowerCase();
        // Skip known-dead / auth-walled hosts.
        if (lower.includes('wolfstream')) continue;
        if (lower.includes('mega.nz')) continue;
        players.push({ label: label, embedUrl: decoded });
      }
    }

    if (players.length === 0) return { streams: [], error: 'No video sources found' };

    // Verified-working plain-HTTP hosts first; JS-gated hosts (voe, filemoon,
    // dood, lulu, swdyu, listeamed, vidply) skip Phase 1 entirely so they never
    // burn the 6s parallel budget — pagev2 is their only path.
    const httpPriority = (p) => {
      const l = p.embedUrl.toLowerCase();
      if (l.includes('yourupload') || l.includes('vidcache')) return 0;
      if (l.includes('mp4upload')) return 1;
      if (l.includes('ok.ru')) return 2;
      if (l.includes('mixdrop') || l.includes('mxdrop')) return 3;
      return 9;
    };
    const JS_ONLY_RE = /voe\.|filemoon|dood|luluvdo|swdyu|listeamed|vidply/i;
    const httpPlayers = players.filter((p) => !JS_ONLY_RE.test(p.embedUrl));
    const jsPlayers = players.filter((p) => JS_ONLY_RE.test(p.embedUrl));
    httpPlayers.sort((a, b) => httpPriority(a) - httpPriority(b));

    // Liveness probe: Range bytes=0-1. The native bridge caps/drops huge bodies
    // itself, so a range-ignoring host cannot blow up memory here.
    async function probeStream(candidate) {
      try {
        const res = await fetchv2(
          candidate.url,
          { 'User-Agent': USER_AGENT, Referer: candidate.referer || SITE + '/', Range: 'bytes=0-1' },
          'GET',
          null,
        );
        const status = Number((res && res.status) || 0);
        return status >= 200 && status < 400;
      } catch (_) {
        return false;
      }
    }

    const resolved = [];

    // Phase 1: fast HTTP pass, all plain-HTTP players in parallel, then probe
    // every candidate in parallel. Only verified-alive streams lead the result.
    const httpResults = await Promise.all(
      httpPlayers.map((p) => Promise.race([
        (async () => {
          let candidates = [];
          if (/ok\.ru/i.test(p.embedUrl)) candidates = await resolveOkRu(p.embedUrl);
          else if (/mixdrop|mxdrop/i.test(p.embedUrl)) candidates = await resolveMixdrop(p.embedUrl);
          else candidates = await resolveWithHttp(p.embedUrl);
          return (candidates || []).slice(0, 2).map((c) => ({
            label: p.label, url: c.url, kind: c.kind || 'mp4', referer: c.referer || p.embedUrl,
          }));
        })(),
        new Promise((resolve) => setTimeout(() => resolve([]), 6000)),
      ])),
    );
    const flat = [];
    for (const list of httpResults) for (const c of list || []) flat.push(c);

    const probeResults = await Promise.all(
      flat.map((c) => Promise.race([
        probeStream(c).then((alive) => ({ c, alive })),
        new Promise((resolve) => setTimeout(() => resolve({ c, alive: null }), 3500)),
      ])),
    );
    const verified = [];
    const unprobed = [];
    for (const r of probeResults) {
      if (r.alive === true) verified.push(r.c);
      else if (r.alive === null) unprobed.push(r.c); // probe inconclusive — keep as fallback
    }
    resolved.push(...verified, ...unprobed);

    // Phase 2: pagev2 (WKWebView) only if HTTP verified nothing — sequential,
    // first success wins, global deadline so the app never waits too long.
    if (verified.length === 0) {
      const deadline = Date.now() + 17000;
      for (const p of jsPlayers.concat(httpPlayers)) {
        if (Date.now() + 11000 > deadline) break;
        const r = await resolveWithPageV2(p.embedUrl, 11000);
        if (r && r.url) {
          resolved.unshift({ label: p.label, url: r.url, kind: r.kind || 'hls', referer: r.referer || p.embedUrl });
          break;
        }
        if (Date.now() + 11000 > deadline) break;
      }
    }

    if (resolved.length === 0) return { streams: [], error: 'No playable streams resolved' };

    // Per-stream headers travel in `qualities` (the runtime reads headers per
    // entry there); flat `streams` pairs stay for legacy compatibility.
    const flatStreams = [];
    const qualities = [];
    const servers = [];
    const seenUrls = {};
    for (const s of resolved) {
      if (!s.url || seenUrls[s.url]) continue;
      seenUrls[s.url] = true;
      const label = 'DUB ' + (s.label || 'source');
      const hdrs = { 'User-Agent': USER_AGENT, Referer: s.referer || SITE + '/' };
      flatStreams.push(label, s.url);
      qualities.push({ label, url: s.url, headers: hdrs });
      servers.push({ id: s.url, name: s.label || 'Source', url: s.url,
        lang: 'dub', streamType: s.kind, headers: hdrs });
    }
    return {
      streams: flatStreams,
      qualities,
      servers,
      headers: {
        'User-Agent': USER_AGENT,
        Referer: resolved[0].referer || SITE + '/',
      },
    };
  }

  // ========== Card Parsing (directory / emision / home grids) ==========

  function parseAnimeCards(html) {
    const items = [];
    const re = /<a[^>]*href="(https?:\/\/latanime\.org\/anime\/[^"]+)"[\s\S]{0,1500}?<img[^>]*(?:data-src="([^"]+)"|src="([^"]+)")[\s\S]{0,800}?<h3[^>]*>([^<]+)<\/h3>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      items.push({ href: m[1], image: m[2] || m[3] || '', title: cleanText(m[4]) });
    }
    return items;
  }

  // ========== discoveryHome ==========
  async function discoveryHome() {
    log('discoveryHome');
    try {
      const [homeHtml, emisionHtml] = await Promise.all([
        requestText(SITE).catch(() => ''),
        requestText(SITE + '/emision').catch(() => ''),
      ]);
      const sections = [];

      // Featured carousel (hero) — backdrop image + span-slider title
      const sliderItems = [];
      const sliderRe = /<a[^>]*href="(https?:\/\/latanime\.org\/anime\/[^"]+)"[\s\S]{0,900}?<img[^>]*(?:data-src="([^"]+)"|src="([^"]+)")[\s\S]{0,500}?<span[^>]*class="[^"]*span-slider[^"]*"[^>]*>([^<]+)<\/span>/gi;
      let m;
      while ((m = sliderRe.exec(homeHtml)) !== null) {
        sliderItems.push({
          href: m[1],
          image: m[2] || m[3] || '',
          title: cleanText(m[4]),
        });
      }
      if (sliderItems.length > 0) {
        sections.push({ id: 'featured', title: 'Destacados', style: 'hero', items: sliderItems.slice(0, 8) });
      }

      // Series recientes (home grid = directory page 1)
      const recentItems = parseAnimeCards(homeHtml);
      if (recentItems.length > 0) {
        sections.push({
          id: 'series_recientes', title: 'Series Recientes', style: 'poster',
          viewAll: { mode: 'feed', feedId: 'directory' },
          items: recentItems.slice(0, 30),
        });
      }

      // Anime en emisión
      const emisionItems = parseAnimeCards(emisionHtml);
      if (emisionItems.length > 0) {
        sections.push({
          id: 'en_emision', title: 'Anime en Emisión', style: 'poster',
          viewAll: { mode: 'feed', feedId: 'emision' },
          items: emisionItems.slice(0, 30),
        });
      }

      return { sections };
    } catch (e) {
      log('discoveryHome failed: ' + (e.message || '').slice(0, 80));
      return { sections: [] };
    }
  }

  // ========== discoveryFeed ==========
  async function discoveryFeed(feedId, page) {
    log('discoveryFeed: ' + feedId + ' page=' + page);
    try {
      let url;
      if (feedId === 'emision') url = SITE + '/emision';
      else if (feedId === 'calendario') url = SITE + '/calendario';
      else url = SITE + '/animes';

      if (page > 1) url += (url.includes('?') ? '&' : '?') + 'p=' + page;

      const html = await requestText(url);
      const items = parseAnimeCards(html);

      const nextPattern = (feedId === 'emision' ? 'emision?p=' : 'animes?p=') + (page + 1);
      const hasMore = html.includes(nextPattern);

      return { items, page, hasMore };
    } catch (e) {
      log('discoveryFeed failed: ' + (e.message || '').slice(0, 80));
      return { items: [], page, hasMore: false };
    }
  }

  // ========== Register ==========
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
