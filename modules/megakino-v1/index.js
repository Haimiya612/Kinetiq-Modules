(function () {
  'use strict';
  // The site rotates its numbered host (…19 → …20 → …21) and 302s the old ones to the current one.
  // That redirect is fatal for session cookies: the client stores the token under the host it
  // actually reached, so a request that enters on the stale host and lands on the live one arrives
  // without its `yg_token` and gets the token-stub again (the module then reads "no playable
  // stream" / empty search). Address the current host directly and keep one bounded fallback.
  // Current host first; this list seeds the one-time redirect resolution below and doubles as the
  // bounded fallback when a host answers but serves a broken page.
  const SITE_HOSTS = ['https://megakino23.com', 'https://megakino22.com', 'https://megakino21.com', 'https://megakino20.com'];
  let SITE = SITE_HOSTS[0];
  let siteResolved = false;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  let cookie = '';
  let sessionPromise = null;
  const pages = new Map();

  function text(s) {
    return String(s || '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ')
      .replace(/&#(x[\da-f]+|\d+);/gi, function (_, n) {
        const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
        return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : '';
      }).replace(/&(amp|quot|apos|nbsp|lt|gt|auml|ouml|uuml|Auml|Ouml|Uuml|szlig);/g, function (_, n) {
        return { amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>', auml: '\u00e4',
          ouml: '\u00f6', uuml: '\u00fc', Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc', szlig: '\u00df' }[n];
      }).replace(/\s+/g, ' ').trim();
  }
  function attr(tag, name) {
    const m = String(tag).match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(["\'])([\\s\\S]*?)\\1', 'i'));
    return m ? text(m[2]) : '';
  }
  function absolute(value, base) {
    const v = String(value || '').trim().replace(/&amp;/g, '&');
    if (/^https:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    if (/^[a-z][a-z\d+.-]*:/i.test(v)) return '';
    const root = (base || SITE).match(/^https:\/\/[^/]+/i);
    if (!root) return '';
    if (v[0] === '/') return root[0] + v;
    return (base || SITE + '/').replace(/[?#].*$/, '').replace(/[^/]*$/, '') + v;
  }
  function origin(url) { return (String(url).match(/^https:\/\/[^/]+/) || [''])[0]; }
  function publicHttps(url) {
    const m = String(url).match(/^https:\/\/([a-z\d.-]+)(?::443)?(?:\/|$)/i);
    return !!m && !/(?:^|\.)(localhost|local|internal)$/i.test(m[1]) && !/^\d+(?:\.\d+){3}$/.test(m[1]);
  }
  function siteUrl(value) {
    const u = absolute(String(value || '').split('#')[0].replace(/^https:\/\/megakino\d+\.com(?=\/)/i, SITE), SITE + '/');
    if (!u.startsWith(SITE + '/') || !/\/[^/?]+\/\d+-[^/?]+\.html$/.test(u)) throw new Error('Invalid MegaKino title link.');
    return u;
  }
  function header(headers, name) {
    const key = Object.keys(headers || {}).find(function (k) { return k.toLowerCase() === name.toLowerCase(); });
    const value = key ? headers[key] : '';
    return Array.isArray(value) ? value.join(', ') : String(value || '');
  }
  async function request(url, headers, method, body) {
    if (!publicHttps(url)) throw new Error('Invalid source address.');
    const r = await fetchv2(url, Object.assign({ 'User-Agent': UA, Accept: '*/*' }, headers || {}), method || 'GET', body || null, { timeoutMs: 15000 });
    if (!r || r.status < 200 || r.status >= 300 || r.bodyDropped) throw new Error('Source unavailable. Please try again later.');
    const s = typeof r.body === 'string' ? r.body : typeof r.text === 'function' ? await r.text() : '';
    if (s.length > 3000000) throw new Error('Source response too large.');
    return { body: s, headers: r.headers || {} };
  }
  async function startSession() {
    if (!sessionPromise) sessionPromise = (async function () {
      const r = await request(SITE + '/index.php?yg=token', { Referer: SITE + '/' });
      const cookies = header(r.headers, 'set-cookie').split(/,(?=\s*[^;,=\s]+=)/).map(function (c) { return c.trim().split(';')[0]; }).filter(function (c) { return /^[^=\s]+=/.test(c); });
      cookie = cookies.join('; ');
    })().finally(function () { sessionPromise = null; });
    await sessionPromise;
  }
  function mkOrigin(value) {
    const m = String(value || '').match(/^https:\/\/megakino\d+\.com/i);
    return m ? m[0] : '';
  }
  // The family rotates its numbered host and 301s the old ones (…19 → …20 → …21 → …23). That
  // redirect is fatal for the session: the yg_token cookie lands on the host that actually
  // answered, so a later request entering on a stale host arrives without it and reads as an empty
  // page. Resolve the redirect ONCE per session and address the live host directly.
  async function resolveSite() {
    if (siteResolved) return;
    siteResolved = true;
    for (let s = 0; s < SITE_HOSTS.length; s++) {
      let current = SITE_HOSTS[s];
      for (let hop = 0; hop < 4; hop++) {
        let r;
        try {
          r = await fetchv2(current + '/', { 'User-Agent': UA, Accept: '*/*' }, 'GET', null,
            { followRedirects: false, timeoutMs: 15000 });
        } catch (_) { break; }
        if (!r) break;
        if (r.status >= 300 && r.status < 400) {
          const dest = mkOrigin(header(r.headers, 'location')) ||
            mkOrigin(absolute(header(r.headers, 'location'), current + '/'));
          if (!dest || dest === current) break;
          current = dest;
          continue;
        }
        if (r.status >= 200 && r.status < 300) { SITE = current; return; }
        break;
      }
    }
  }
  async function page(url, body) {
    const cached = pages.get(url);
    if (!body && cached && Date.now() - cached.at < 120000) return cached.html;
    await resolveSite();
    const candidates = [SITE].concat(SITE_HOSTS.filter(function (h) { return h !== SITE; }));
    for (let host = 0; host < candidates.length; host++) {
      if (host) { SITE = candidates[host]; cookie = ''; }
      const target = host ? url.replace(/^https:\/\/megakino\d+\.com/i, SITE) : url;
      for (let i = 0; i < 2; i++) {
        const h = { Referer: SITE + '/', 'Accept-Language': 'de-DE,de;q=0.9' };
        if (cookie) h.Cookie = cookie;
        if (body) h['Content-Type'] = 'application/x-www-form-urlencoded';
        const r = await request(target, h, body ? 'POST' : 'GET', body);
        if (/index\.php\?yg=token/.test(r.body) && !/<h1|class="poster/.test(r.body)) { await startSession(); continue; }
        if (!/<html[\s>]/i.test(r.body)) throw new Error('Unexpected catalogue response.');
        if (!body) {
          if (pages.size >= 24) pages.delete(pages.keys().next().value);
          pages.set(url, { html: r.body, at: Date.now() });
        }
        return r.body;
      }
    }
    throw new Error('Catalogue session could not be started.');
  }
  function catalogue(html, kind) {
    const out = [], seen = new Set();
    const re = /<a\b([^>]*\bclass=["'][^"']*\b(?:poster|top)\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      if (kind && !new RegExp('(?:^|\\s)' + kind + '(?:\\s|$)').test(attr(m[1], 'class'))) continue;
      const url = absolute(attr(m[1], 'href').replace(/^https:\/\/megakino\d+\.com(?=\/)/i, SITE), SITE + '/');
      if (!url.startsWith(SITE + '/') || !/\/\d+-[^/?]+\.html$/.test(url) || seen.has(url)) continue;
      const img = (m[2].match(/<img\b[^>]*>/i) || [''])[0];
      const title = attr(img, 'alt') || text((m[2].match(/<(?:h3|div)[^>]*class="(?:poster|top)__title[^>]*>([\s\S]*?)<\//i) || [])[1]);
      if (!title) continue;
      seen.add(url);
      out.push({ title: title, id: url, href: url, image: absolute(attr(img, 'data-src') || attr(img, 'src'), SITE + '/') });
    }
    return out.slice(0, 40);
  }
  async function searchResults(query, pageNumber) {
    const q = String(query || '').trim().slice(0, 180);
    const n = Math.max(1, Math.min(10000, Math.floor(Number(pageNumber) || 1)));
    // Search must be an HTTP GET. The site's search form still posts `do=search&subaction=search`,
    // but that POST response no longer contains any result items (verified 2026-09-26: zero poster
    // anchors over several queries, while the identical query parameters as a GET return the full
    // 20-item result page). The dead POST is why the in-app search bar showed nothing even though
    // the catalogue stayed healthy. Pagination is an offset: the template pages by 20 items.
    if (!q) return catalogue(await page(SITE + (n > 1 ? '/page/' + n + '/' : '/')));
    return catalogue(await page(SITE + '/index.php?do=search&subaction=search&story=' + encodeURIComponent(q) + (n > 1 ? '&search_start=' + ((n - 1) * 20) : '')));
  }
  async function discoveryFeed(feedId, pageNumber) {
    const n = Math.max(1, Math.min(10000, Math.floor(Number(pageNumber) || 1)));
    const root = feedId === 'latest-series' ? '/serials/' : feedId === 'latest-films' ? '/films/' : '/';
    const html = await page(SITE + root + (n > 1 ? 'page/' + n + '/' : ''));
    return { items: catalogue(html, 'poster'), page: n,
      hasMore: html.includes('/page/' + (n + 1) + '/') };
  }
  async function discoveryHome() {
    const html = await page(SITE + '/');
    const featured = catalogue(html, 'top').slice(0, 8);
    const used = new Set(featured.map(function (x) { return x.id; }));
    const latest = catalogue(html, 'poster').filter(function (x) { return !used.has(x.id); });
    const sections = [
      { id: 'featured', title: 'Featured on MegaKino', style: 'hero', items: featured },
      { id: 'latest-films', title: 'Latest films', style: 'poster', items: latest.filter(function (x) { return x.id.includes('/films/'); }) },
      { id: 'latest-series', title: 'Latest series', style: 'poster', items: latest.filter(function (x) { return x.id.includes('/serials/'); }) }
    ];
    // The homepage can contain only films; use the site's actual series category.
    if (!sections[2].items.length) {
      try { sections[2].items = catalogue(await page(SITE + '/serials/'), 'poster').filter(function (x) { return !used.has(x.id); }); } catch (_) {}
    }
    return { sections: sections.filter(function (s) { return s.items.length; }).map(function (s) {
      s.viewAll = {mode: 'feed', feedId: s.id}; return s;
    }) };
  }
  async function extractDetails(id) {
    const url = siteUrl(id), html = await page(url);
    const title = text((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
    if (!title) throw new Error('Title is no longer available.');
    const poster = (html.match(/<img\b[^>]*itemprop="image"[^>]*>/i) || [''])[0];
    return { title: title, url: url, image: absolute(attr(poster, 'data-src') || attr(poster, 'src'), SITE + '/'),
      description: text((html.match(/<div[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]) };
  }
  function episodeGroups(html) {
    const out = []; let m;
    const re = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    while ((m = re.exec(html))) {
      const id = attr(m[1], 'id');
      if (!/^ep\d+$/i.test(id)) continue;
      const hosts = []; let o; const options = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
      while ((o = options.exec(m[2]))) { const u = attr(o[1], 'value'); if (isHost(u)) hosts.push(u); }
      if (hosts.length) out.push({ number: Number(id.slice(2)), hosts: hosts });
    }
    return out.sort(function (a, b) { return a.number - b.number; });
  }
  function isHost(url) { return /^https:\/\/(?:voe\.sx\/e\/[a-z\d]+|watch\.gxplayer\.xyz\/watch\?v=[a-z\d]+)(?:[&#]|$)/i.test(url); }
  function movieHosts(html) {
    const section = html.split('pmovie__player tabs-block')[1];
    if (!section) return [];
    const out = []; let m; const re = /<iframe\b[^>]*>/gi;
    while ((m = re.exec(section.split('pmovie__player-bottom')[0]))) {
      const u = attr(m[0], 'data-src') || attr(m[0], 'src');
      if (isHost(u) && !out.includes(u)) out.push(u);
    }
    return out;
  }
  async function extractEpisodes(id) {
    const url = siteUrl(id), html = await page(url), groups = episodeGroups(html);
    const title = text((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
    const season = Number((title.match(/(?:Staffel\s*(\d+)|(\d+)\.?\s*Staffel)/i) || []).slice(1).find(Boolean)) || 1;
    if (groups.length) return groups.map(function (g) { return { number: g.number, title: 'Episode ' + g.number,
      season: season, href: url + '#ep=' + g.number, subAvailable: false, dubAvailable: true }; });
    if (!movieHosts(html).length) return [];
    return [{ number: 1, title: title || 'Film', href: url + '#movie', subAvailable: false, dubAvailable: true }];
  }
  function b64(value) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', input = String(value).replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1) throw new Error('Unsupported player configuration.');
    let bits = 0, buffer = 0, out = '';
    for (let i = 0; i < input.length && input[i] !== '='; i++) {
      buffer = (buffer << 6) | chars.indexOf(input[i]); bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 255); }
    }
    return out;
  }
  function voeConfig(html, expectedId) {
    // Decode the site's data envelope only. Never execute downloaded scripts.
    const scripts = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scripts.exec(html))) {
      try {
        const arr = JSON.parse(m[1]);
        if (!Array.isArray(arr) || typeof arr[0] !== 'string' || arr[0].length > 200000) continue;
        let s = arr[0].replace(/[a-zA-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)); });
        s = s.replace(/@\$|\^\^|~@|%\?|\*~|!!|#&|_/g, '');
        s = b64(s).split('').map(function (c) { return String.fromCharCode(c.charCodeAt(0) - 3); }).reverse().join('');
        const data = JSON.parse(b64(s));
        if (data.file_code === expectedId && publicHttps(data.source) && !/test-videos|big.?buck.?bunny/i.test(data.source)) return data;
      } catch (_) { /* Other JSON blocks are not player configuration. */ }
    }
    throw new Error('VOE player format unavailable.');
  }
  async function resolveVoe(embed) {
    const id = (embed.match(/\/e\/([a-z\d]+)/i) || [])[1];
    let target = embed, r = await request(target, { Referer: SITE + '/' });
    const redirect = r.body.match(/window\.location\.href\s*=\s*['"](https:\/\/[^'"\s]+)['"]/);
    if (redirect) {
      target = redirect[1];
      if (!publicHttps(target) || target.split('?')[0].split('/').pop() !== id) throw new Error('Unexpected VOE redirect.');
      r = await request(target, { Referer: embed });
    }
    const config = voeConfig(r.body, id);
    const headers = { Referer: origin(target) + '/', Origin: origin(target), 'User-Agent': UA };
    const tracks = Array.isArray(config.captions) ? config.captions.filter(function (c) { return c && publicHttps(c.file); }).map(function (c) {
      return { url: c.file, label: text(c.label || c.language || 'Subtitles'), language: c.language || '', headers: headers };
    }) : [];
    return { url: config.source, headers: headers, subtitles: tracks, provider: 'VOE' };
  }
  async function resolveGX(embed) {
    const r = await request(embed, { Referer: SITE + '/' });
    const m = r.body.match(/var\s+video\s*=\s*(\{[^\n]*?\});/);
    if (!m) throw new Error('GXPlayer configuration unavailable.');
    const v = JSON.parse(m[1]), slug = (embed.match(/[?&]v=([a-z\d]+)/i) || [])[1];
    if (v.slug !== slug || !/^\d+$/.test(v.uid) || !/^\d+$/.test(v.id) || !/^[a-f\d]{32}$/i.test(v.md5) || !/^\d+$/.test(v.status)) throw new Error('Invalid GXPlayer video identity.');
    const root = origin(embed);
    return { url: root + '/m3u8/' + v.uid + '/' + v.md5 + '/master.txt?s=1&id=' + v.id + '&cache=' + v.status,
      headers: { Referer: root + '/', Origin: root, 'User-Agent': UA }, subtitles: [], provider: 'GXPlayer' };
  }
  async function verifyHls(candidate) {
    const master = (await request(candidate.url, candidate.headers)).body.trim();
    if (!master.startsWith('#EXTM3U')) throw new Error('Host did not return video.');
    const lines = master.split(/\r?\n/), variants = [];
    candidate.qualities = [];
    for (const line of lines) {
      if (!/^#EXT-X-MEDIA:/.test(line) || !/TYPE=SUBTITLES(?:,|$)/.test(line)) continue;
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      const url = uri && absolute(uri, candidate.url);
      // Do not send a subtitle playlist to a player expecting a VTT/SRT file.
      if (!url || !publicHttps(url) || !/\.(?:vtt|srt)(?:[?#]|$)/i.test(url)) continue;
      if (!candidate.subtitles.some(function (s) { return s.url === url; })) candidate.subtitles.push({
        url: url, label: (line.match(/NAME="([^"]+)"/) || [])[1] || 'Subtitles',
        language: (line.match(/LANGUAGE="([^"]+)"/) || [])[1] || '', headers: candidate.headers
      });
    }
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const next = lines.slice(i + 1).find(function (s) { return s.trim() && s[0] !== '#'; });
        if (next) {
          const url = absolute(next.trim(), candidate.url);
          variants.push(url);
          const height = (lines[i].match(/RESOLUTION=\d+x(\d+)/i) || [])[1];
          const bandwidth = (lines[i].match(/BANDWIDTH=(\d+)/i) || [])[1];
          candidate.qualities.push({label: height ? height + 'p' : bandwidth ? Math.round(Number(bandwidth) / 1000) + ' kbps' : 'Variant ' + variants.length,
            url: url, headers: candidate.headers});
        }
      }
    }
    const mediaUrl = variants[0] || candidate.url;
    const media = variants.length ? (await request(mediaUrl, candidate.headers)).body.trim() : master;
    if (!media.startsWith('#EXTM3U') || !/#EXTINF:/.test(media)) throw new Error('Empty video playlist.');
    const segments = media.split(/\r?\n/).filter(function (s) { return s.trim() && s[0] !== '#'; });
    if (!segments.length || segments.some(function (s) { return /\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(s); })) throw new Error('Invalid video segments.');
    // GX's .txt master is not detected consistently. Use its verified media
    // playlist only when no separate audio group would be lost.
    if (candidate.provider === 'GXPlayer' && variants.length && !/#EXT-X-MEDIA:.*TYPE=AUDIO/.test(master)) {
      candidate.url = mediaUrl;
    }
    return candidate;
  }
  async function extractStreamUrl(href, lang) {
    // The catalogue offers German-dubbed content; never substitute it for SUB.
    if (String(lang || '').toLowerCase() === 'sub') return { streams: [], subtitles: [] };
    const url = siteUrl(href), html = await page(url), groups = episodeGroups(html);
    const ep = String(href).match(/#ep=(\d+)$/);
    let hosts;
    if (groups.length) {
      const g = ep && groups.find(function (v) { return v.number === Number(ep[1]); });
      if (!g) throw new Error('Episode not found.');
      hosts = g.hosts;
    } else hosts = movieHosts(html);
    // Prefer standard .m3u8 delivery; GX uses a .txt master which some players misdetect.
    hosts = hosts.slice().sort(function (a, b) { return Number(b.includes('voe.sx')) - Number(a.includes('voe.sx')); });
    const candidates = [];
    for (const host of [...new Set(hosts)].slice(0, 3)) {
      try {
        const c = await verifyHls(host.includes('gxplayer') ? await resolveGX(host) : await resolveVoe(host));
        if (!candidates.some(function (s) { return s.url === c.url; })) candidates.push(c);
      } catch (_) { console.log('[MegaKino] Source unavailable; trying the next listed host.'); }
    }
    if (!candidates.length) throw new Error('No working video source for this title. Please try again later.');
    const primary = candidates[0];
    const servers = candidates.map(function (c) { return {name: c.provider, url: c.url,
      headers: c.headers, subtitles: c.subtitles, qualities: c.qualities, lang: 'dub'}; });
    const qualities = [{label: 'Auto', url: primary.url, headers: primary.headers}].concat(primary.qualities);
    return {url: primary.url, server: primary.provider, lang: 'dub',
      streams: ['Deutsch dub Auto - ' + primary.provider, primary.url], servers: servers,
      qualities: qualities, headers: primary.headers, subtitles: primary.subtitles, streamType: 'hls'};
  }
  globalThis.searchResults = searchResults;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
})();
