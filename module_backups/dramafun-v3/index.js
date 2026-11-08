(() => {
  'use strict';
  const BASE = 'https://dah.dramafuntv.com';
  const UA = 'Mozilla/5.0';
  const SITE_HOST = /^(?:dah|ama|ww5|ww6)\.dramafuntv\.com$/;
  const HOSTS = {
    'vidmoly.org': 'Vidmoly', 'voe.sx': 'Voe', 'bysezejataos.com': 'Bysezejataos',
    'vidspeed.org': 'Vidspeed', 'hlswish.com': 'Hlswish', 'uqload.vc': 'Uqload',
    'dsvplay.com': 'Dsvplay', 'vidspeeds.com': 'Vidspeed', 'ok.ru': 'OK',
    'uqload.cx': 'Uqload', 'uqload.is': 'Uqload', 'uqload.co': 'Uqload', 'uqload.to': 'Uqload', 'uqload.net': 'Uqload',
  };
  const catalogueCache = new Map();
  const active = new Map();

  function entities(value) {
    const named = { amp: '&', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é',
      iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü' };
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, key) => {
      if (key[0] === '#') {
        const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      const decoded = named[key.toLowerCase()];
      return decoded === undefined ? all : key[0] === key[0].toUpperCase() ? decoded.toUpperCase() : decoded;
    });
  }
  function clean(value) {
    return entities(String(value || '').replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }
  function attr(tag, key) {
    const m = String(tag).match(new RegExp('(?:^|\\s)' + key + '\\s*=\\s*(?:"([^"<>]*)"|\'([^\'<>]*)\')', 'i'));
    return m ? entities(m[1] === undefined ? m[2] : m[1]) : '';
  }
  function origin(url) { return String(url).match(/^https:\/\/[^/?#]+/i)?.[0] || ''; }
  function host(url) { return origin(url).slice(8).toLowerCase(); }
  function safeUrl(input, base) {
    let value = entities(input).trim().replace(/\\\//g, '/');
    if (!value || /[\s\\\x00-\x1f]/.test(value)) return '';
    base = base || BASE + '/';
    if (value.startsWith('//')) value = 'https:' + value;
    if (!/^https:/i.test(value)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
      const root = origin(base);
      value = value[0] === '/' ? root + value : value[0] === '?' ? base.split(/[?#]/)[0] + value : base.split(/[?#]/)[0].replace(/[^/]*$/, '') + value;
    }
    const match = value.match(/^https:\/\/([a-z0-9.-]+)(\/[^#]*)?(?:#.*)?$/i);
    if (!match) return '';
    const name = match[1].toLowerCase();
    if (!name.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(name) || /^[0-9.]+$/.test(name)) return '';
    const tail = match[2] || '/';
    const split = tail.indexOf('?');
    const pathname = split < 0 ? tail : tail.slice(0, split);
    const parts = [];
    for (const part of pathname.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return 'https://' + name + '/' + parts.join('/') + (pathname.endsWith('/') && parts.length ? '/' : '') + (split < 0 ? '' : tail.slice(split));
  }
  function siteUrl(input) {
    const url = safeUrl(input, BASE + '/');
    if (!SITE_HOST.test(host(url))) throw new Error('Unsupported DramaFun catalogue address');
    return BASE + url.slice(origin(url).length);
  }
  function imageUrl(input) {
    const url = safeUrl(input, BASE + '/');
    return SITE_HOST.test(host(url)) ? BASE + url.slice(origin(url).length) : url;
  }
  function unique(items, key) {
    const seen = new Set();
    return items.filter(item => { const value = key(item); if (!value || seen.has(value)) return false; seen.add(value); return true; });
  }
  function ctx(ms) { return { until: Date.now() + ms, requests: 0 }; }
  function check(context) {
    if (Date.now() >= context.until || context.requests >= 65) throw new Error('DramaFun request budget exhausted');
  }
  async function request(url, headers, context, cap, range) {
    check(context);
    url = safeUrl(url);
    if (!url) throw new Error('Unsafe source address');
    context.requests++;
    const extra = range ? { Range: range } : {};
    const requestHeaders = Object.assign({ 'User-Agent': UA }, headers || {}, extra);
    let response = await fetchv2(url, requestHeaders, 'GET', null,
      { followRedirects: false, maxBytesHint: cap || 500000, responseClass: range ? 'probe' : 'document' });
    check(context);
    // Older Player's no-redirect bridge deliberately returns headers only.
    // Resolve redirect hops first, then fetch the body from the verified endpoint.
    if (response && response.status >= 200 && response.status < 300 && !response.body && response.bodyBytes > 0 && !response.bodyDropped) {
      context.requests++;
      response = await fetchv2(url, requestHeaders, 'GET', null,
        { followRedirects: true, maxBytesHint: cap || 500000, responseClass: range ? 'probe' : 'document' });
      check(context);
    }
    if (!response || response.bodyDropped) throw new Error('Source response unavailable or oversized');
    const status = Number(response.status);
    const rawHeaders = response.headers || {};
    const normalized = {};
    for (const key of Object.keys(rawHeaders)) normalized[key.toLowerCase()] = String(rawHeaders[key]);
    let text = typeof response.body === 'string' ? response.body : '';
    if (!text && typeof response.text === 'function') text = await response.text();
    if (!text && response.json) {
      try {
        const json = typeof response.json === 'function' ? await response.json() : response.json;
        text = JSON.stringify(json);
      } catch { /* Non-JSON and empty responses remain empty; never fabricate a body. */ }
    }
    if (String(text).length > (cap || 500000)) throw new Error('Source response too large');
    return { status, text: String(text || ''), headers: normalized, bytes: response.bodyBytes || String(text || '').length, url };
  }
  async function get(url, headers, context, cap, range) {
    for (let i = 0; i < 4; i++) {
      const res = await request(url, headers, context, cap, range);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const next = safeUrl(res.headers.location, url);
        if (!next) throw new Error('Invalid provider redirect');
        url = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new Error('Source HTTP ' + res.status);
      return res;
    }
    throw new Error('Too many provider redirects');
  }
  async function page(url, context) {
    const key = siteUrl(url);
    const cached = catalogueCache.get(key);
    if (cached && Date.now() - cached.at < 45000) return cached.text;
    const res = await get(key, { Referer: BASE + '/' }, context, 1400000);
    if (!SITE_HOST.test(host(res.url))) throw new Error('Catalogue redirected outside DramaFun');
    if (!/<(?:html|title)\b/i.test(res.text)) throw new Error('Catalogue returned an invalid page');
    if (catalogueCache.size >= 8) catalogueCache.delete(catalogueCache.keys().next().value);
    catalogueCache.set(key, { at: Date.now(), text: res.text });
    return res.text;
  }
  function meta(html, name) {
    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
      if ((attr(match[0], 'property') || attr(match[0], 'name')).toLowerCase() === name) return attr(match[0], 'content');
    }
    return '';
  }
  function titleOf(html) { return clean(meta(html, 'og:title') || html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]); }
  function seriesTitle(title) { return clean(title).replace(/\s+(?:cap[íi]tulo|episodio|episode)\s*\d+.*$/i, '').replace(/\s+[-|]\s*DramaFun.*$/i, '').trim(); }
  function cards(html) {
    const result = [];
    for (const match of html.matchAll(/<li\b[^>]*class=["'][^"']*col-[^"']*["'][\s\S]*?<\/li>/gi)) {
      const block = match[0];
      const link = [...block.matchAll(/<a\b[^>]*>/gi)].find(m => /watch\.php\?vid=/.test(attr(m[0], 'href')));
      if (!link) continue;
      const title = seriesTitle(attr(link[0], 'title') || attr(block.match(/<img\b[^>]*>/i)?.[0] || '', 'alt'));
      let href;
      try { href = siteUrl(attr(link[0], 'href')); } catch { continue; }
      const img = block.match(/<img\b[^>]*>/i)?.[0] || '';
      if (title) result.push({ title, href, id: href, url: href, image: imageUrl(attr(img, 'data-echo') || attr(img, 'src')) });
    }
    return unique(result, card => card.title.toLowerCase());
  }
  async function listing(query, pageNumber) {
    const q = String(query || '').trim();
    const n = Math.max(1, Math.floor(Number(pageNumber) || 1));
    const url = q ? BASE + '/search.php?keywords=' + encodeURIComponent(q) + '&page=' + n : BASE + '/newvideos.php?page=' + n;
    const html = await page(url, ctx(7500));
    const more = [...html.matchAll(/<a\b[^>]*>/gi)].some(m => {
      const href = attr(m[0], 'href');
      return /(?:newvideos|search)\.php/.test(href) && Number(href.match(/[?&]page=(\d+)/)?.[1]) === n + 1;
    });
    return { items: cards(html), page: n, hasMore: more };
  }
  async function searchResults(query, n) { return (await listing(query, n)).items; }
  async function discoveryHome() {
    const result = await listing('', 1);
    if (!result.items.length) throw new Error('DramaFun catalogue returned no titles');
    const sections = [{ id: 'featured', title: 'Latest on DramaFun', style: 'hero', items: result.items.slice(0, 6), viewAll: { mode: 'feed', feedId: 'latest' } }];
    if (result.items.length > 6) sections.push({ id: 'latest', title: 'More titles', style: 'poster', items: result.items.slice(6), viewAll: { mode: 'feed', feedId: 'latest' } });
    return { sections };
  }
  async function discoveryFeed(id, n) {
    if (id !== 'latest') throw new Error('Unknown DramaFun feed');
    return listing('', n);
  }
  function episodes(html, currentUrl) {
    const result = [];
    // Restrict extraction to the episode lists, excluding recommendations below.
    for (const group of html.matchAll(/<div\b[^>]*id=["']Season(\d+)["'][^>]*>([\s\S]*?)<\/ul>/gi)) {
      for (const link of group[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const raw = attr(link[1], 'href');
        if (!/watch\.php\?vid=/.test(raw)) continue;
        const title = clean(attr(link[1], 'title') || link[2]);
        const number = Number(link[2].match(/<em>(\d+)<\/em>/i)?.[1] || title.match(/(?:cap[íi]tulo|episodio|episode)\s*(\d+)/i)?.[1]);
        if (!number) continue;
        let href;
        try { href = siteUrl(raw); } catch { continue; }
        result.push({ number, season: Number(group[1]), title, href, id: href, subAvailable: true, dubAvailable: false });
      }
    }
    if (!result.length && /(?:watch|play)\.php\?vid=/.test(currentUrl)) {
      const title = titleOf(html);
      const n = Number(title.match(/(?:cap[íi]tulo|episodio|episode)\s*(\d+)/i)?.[1]);
      const hasPlayer = /data-embed-url=|play\.php\?vid=/.test(html);
      // A movie/single-video watch page has its own player and no series mapping.
      // Never manufacture Episode 1 for an empty series listing.
      if (hasPlayer && title && (n || !/view-serie\.php\?name=/.test(html))) result.push({ number: n || 1, season: 1, title, href: currentUrl, id: currentUrl, subAvailable: true, dubAvailable: false });
    }
    return unique(result, e => e.href).sort((a, b) => a.season - b.season || a.number - b.number);
  }
  async function extractEpisodes(input) { const url = siteUrl(input); return episodes(await page(url, ctx(10000)), url); }
  async function extractDetails(input) {
    const url = siteUrl(input), html = await page(url, ctx(10000));
    const title = seriesTitle(titleOf(html));
    if (!title || /404|not found|forbidden/i.test(title)) throw new Error('DramaFun title unavailable');
    return { title, description: clean(meta(html, 'og:description') || meta(html, 'description')), image: imageUrl(meta(html, 'og:image')), href: url, url, id: url, totalEpisodes: episodes(html, url).length, status: 'Unknown' };
  }
  function serversFrom(html) {
    const out = [];
    for (const list of html.matchAll(/<ul\b([^>]*)>([\s\S]*?)<\/ul>/gi)) {
      if (!attr(list[1], 'class').split(/\s+/).includes('WatchList')) continue;
      for (const item of list[2].matchAll(/<li\b([^>]*)>/gi)) {
        const url = safeUrl(attr(item[1], 'data-embed-url'));
        const name = HOSTS[host(url).replace(/^www\./, '')];
        if (name && /\/(?:e\/[a-z0-9]+|embed-[a-z0-9]+\.html)(?:\?|$)/i.test(url)) out.push({ name, url });
      }
    }
    // Older Vidspeed uploads can pass an initial range probe yet stall on seeks.
    // Prefer the independently decoded alternative; retain every checked server.
    const rank = { Uqload: 1, Vidmoly: 2, Hlswish: 3, Vidspeed: 4, Voe: 5, Bysezejataos: 6, Dsvplay: 7 };
    return unique(out, s => s.url).sort((a, b) => (rank[a.name] || 9) - (rank[b.name] || 9));
  }
  function unpack(html) {
    let output = String(html);
    // Decode the published P.A.C.K.E.R string table without executing provider JS.
    const pattern = /\}\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+)\s*,\s*\d+\s*,\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/g;
    for (const match of html.matchAll(pattern)) {
      const radix = Number(match[2]);
      if (radix < 2 || radix > 62) continue;
      const words = match[3].replace(/\\'/g, "'").replace(/\\\\/g, '\\').split('|');
      const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const decoded = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\b[0-9a-zA-Z]+\b/g, token => {
        let n = 0;
        for (const c of token) { const digit = alphabet.indexOf(c); if (digit >= radix) return token; n = n * radix + digit; if (n > words.length) return token; }
        return words[n] || token;
      });
      output += '\n' + decoded;
    }
    return output;
  }
  function hlsAttrs(line) {
    const out = {};
    for (const m of line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,\s]*))/g)) out[m[1]] = m[2] === undefined ? m[3] : m[2];
    return out;
  }
  function tracksFrom(html, base) {
    const out = [];
    function add(data) {
      if (!/^(?:captions|subtitles)$/i.test(data.kind || '')) return;
      const url = safeUrl(data.file || data.src, base);
      if (!url) return;
      const language = clean(data.srclang || data.language);
      out.push({ url, label: clean(data.label) || language || 'Source captions', ...(language ? { language } : {}) });
    }
    for (const block of html.matchAll(/\{[^{}]*\}/g)) {
      try { add(JSON.parse(block[0])); continue; } catch { /* Legacy player config is a JS object, not JSON. */ }
      const data = {};
      for (const pair of block[0].matchAll(/(?:^|[,\s{])["']?(kind|file|src|label|srclang|language)["']?\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/gi)) {
        data[pair[1].toLowerCase()] = pair[3].replace(/\\(['"\\/])/g, '$1');
      }
      add(data);
    }
    for (const tag of html.matchAll(/<track\b[^>]*>/gi)) {
      add({ kind: attr(tag[0], 'kind'), src: attr(tag[0], 'src'), label: attr(tag[0], 'label'), srclang: attr(tag[0], 'srclang') });
    }
    return unique(out, t => t.url);
  }
  function hasCaptionText(text) {
    if (/<html/i.test(text)) return false;
    for (const cue of text.matchAll(/-->\s*(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}[^\r\n]*\r?\n([\s\S]*?)(?=\r?\n\s*\r?\n|$)/g)) {
      if (clean(cue[1])) return true;
    }
    return false;
  }
  async function checkMedia(url, headers, context) {
    const res = await get(url, headers, context, 32768, 'bytes=0-8191');
    const type = res.headers['content-type'] || '';
    if (/text\/html|image\//i.test(type) || /^\s*</.test(res.text)) throw new Error('Provider returned non-video bytes');
    // UTF-8 bridge retains ASCII sync/box signatures; full decoding is checked by S2.
    const ts = res.text.charCodeAt(0) === 0x47 && /(?:video\/mp2t|octet-stream)/i.test(type) && res.bytes >= 188;
    const mp4 = /^(?:ftyp|styp|moof)$/.test(res.text.slice(4, 8));
    if (!ts && !mp4) throw new Error('Unrecognised media signature');
    return { url: res.url, type: mp4 ? 'mp4' : 'mpegts' };
  }
  async function validate(url, headers, context) {
    if (/\.mp4(?:\?|$)/i.test(url)) {
      const media = await checkMedia(url, headers, context);
      if (media.type !== 'mp4') throw new Error('MP4 source mismatch');
      return { url: media.url, streamType: 'mp4', qualities: [], subtitles: [] };
    }
    const master = await get(url, headers, context, 450000);
    if (!master.text.trimStart().startsWith('#EXTM3U')) throw new Error('Provider returned no HLS playlist');
    const lines = master.text.trim().split(/\r?\n/).map(s => s.trim());
    const choices = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const info = hlsAttrs(lines[i]);
      const height = Number(info.RESOLUTION?.split('x')[1]) || 0;
      const child = safeUrl(lines[i + 1], master.url);
      // Keep master-selected audio groups intact; do not detach video from its audio.
      if (child) choices.push({ url: child, height, externalAudio: Boolean(info.AUDIO) });
    }
    const subtitles = [];
    for (const line of lines.filter(s => s.startsWith('#EXT-X-MEDIA:'))) {
      const data = hlsAttrs(line), track = safeUrl(data.URI, master.url);
      if (data.TYPE === 'SUBTITLES' && /\.vtt(?:\?|$)/i.test(track)) subtitles.push({ url: track, label: data.NAME || data.LANGUAGE || 'Source captions', ...(data.LANGUAGE ? { language: data.LANGUAGE } : {}) });
    }
    const qualities = [];
    let valid = 0;
    for (const choice of (choices.length ? choices : [{ url: master.url, height: 0 }]).slice(0, 5)) {
      try {
        const media = choice.url === master.url ? master : await get(choice.url, headers, context, 450000);
        if (!media.text.trimStart().startsWith('#EXTM3U') || !/#EXTINF:/.test(media.text)) continue;
        if (/#EXT-X-KEY:.*METHOD=(?!NONE)/.test(media.text)) continue;
        const segment = media.text.split(/\r?\n/).map(s => s.trim()).find(s => s && s[0] !== '#');
        const init = media.text.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
        await checkMedia(safeUrl(init || segment, media.url), headers, context);
        valid++;
        if (choice.height && !choice.externalAudio) qualities.push({ label: choice.height + 'p', height: choice.height, url: media.url, headers });
      } catch { /* A bad rendition must not discard another verified rendition. */ }
    }
    if (!valid) throw new Error('No HLS rendition passed media checks');
    qualities.sort((a, b) => b.height - a.height);
    // Return a checked rendition by default; retain Auto only when every advertised child passed.
    const autoSafe = valid === (choices.length || 1) && choices.length <= 5;
    const selected = autoSafe ? master.url : qualities[0]?.url;
    if (!selected) throw new Error('No safe default rendition');
    if (autoSafe && choices.length) qualities.push({ label: 'Auto', url: master.url, headers });
    return { url: selected, streamType: 'hls', qualities, subtitles };
  }
  async function resolveServer(server, context) {
    let embed = await get(server.url, { Referer: BASE + '/' }, context, 400000);
    if (server.name === 'Voe') {
      const redirect = embed.text.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/)?.[1];
      const next = safeUrl(redirect);
      if (next && host(next) === 'johnfullwonder.com') embed = await get(next, { Referer: BASE + '/' }, context, 400000);
    }
    const html = unpack(embed.text);
    const headers = { 'User-Agent': UA, Referer: origin(embed.url) + '/', Origin: origin(embed.url) };
    const candidates = unique([...html.matchAll(/(?:["']?(?:file|src|hls[234]?|mp4)["']?\s*[:=]\s*|sources\s*:\s*\[\s*)['"]([^'"]+)['"]/gi)]
      .map(m => ({ url: safeUrl(m[1], embed.url) })).filter(c => /\.(?:m3u8|mp4)(?:\?|$)/i.test(c.url)), c => c.url);
    for (const candidate of candidates.slice(0, 3)) {
      try {
        const media = await validate(candidate.url, headers, context);
        const tracks = unique(tracksFrom(html, embed.url).concat(media.subtitles), t => t.url);
        const subtitles = [];
        for (const track of tracks.slice(0, 12)) {
          try {
            const res = await get(track.url, headers, context, 200000);
            if (hasCaptionText(res.text)) subtitles.push({ ...track, url: res.url, headers });
          } catch { /* Only expose caption files that can be fetched and parsed. */ }
        }
        return { ...media, name: server.name, server: server.name, headers, subtitles, lang: 'sub' };
      } catch { check(context); }
    }
    throw new Error(server.name + ' supplied no verified media');
  }
  async function resolveEpisode(url) {
    const context = ctx(23000);
    const id = url.match(/[?&]vid=([a-z0-9]+)/i)?.[1];
    if (!id) throw new Error('DramaFun episode identity is missing');
    // No signed source cache: retry always obtains a new provider mapping and token.
    const html = (await get(BASE + '/play.php?vid=' + id, { Referer: url }, context, 1400000)).text;
    const providers = serversFrom(html);
    if (!providers.length) throw new Error('DramaFun has no supported providers for this episode');
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < providers.length && Date.now() < context.until) {
        const i = cursor++;
        try { const stream = await resolveServer(providers[i], context); results.push({ i, stream }); } catch { /* Continue to the next published provider, within the shared budget. */ }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    results.sort((a, b) => a.i - b.i);
    const servers = unique(results.map(r => r.stream), s => s.url);
    if (!servers.length) throw new Error('DramaFun could not verify a working source. Please retry or choose another module.');
    const primary = servers[0];
    const qualities = primary.qualities;
    const streams = qualities.length ? qualities.flatMap(q => ['sub ' + q.label, q.url]) : ['sub Auto', primary.url];
    return { ...primary, streams, qualities, servers };
  }
  async function extractStreamUrl(input, lang) {
    if (String(lang || 'sub').toLowerCase() === 'dub') throw new Error('DramaFun does not expose a separate dub track. Use the source audio option.');
    const url = siteUrl(input);
    if (active.has(url)) return active.get(url);
    const promise = resolveEpisode(url);
    active.set(url, promise);
    try { return await promise; } finally { active.delete(url); }
  }
  Object.assign(globalThis, { searchResults, extractDetails, extractEpisodes, extractStreamUrl, discoveryHome, discoveryFeed });
})();
