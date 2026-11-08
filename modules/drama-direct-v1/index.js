(function () {
  'use strict';
  var BASE = 'https://megavid.buzz';
  var UA = 'Mozilla/5.0';
  var cache = {};
  var pending = {};
  var cooldown = {};
  var cards = {};
  var PICKS = ['Vincenzo', 'Queen of Tears', 'Hidden Love', 'Crash Landing on You',
    'Goblin - Guardian: The Lonely and Great God', 'The Glory Season 1', 'Moving', 'My Demon', 'Hospital Playlist'];

  function host(url) {
    var m = String(url || '').match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/i);
    return m ? m[1].toLowerCase() : '';
  }
  function safe(url) {
    var h = host(url);
    if (!h || /dramacool|anikoto|anicrowd/i.test(h) || /[@:\\]/.test(h) ||
        h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || /\.(local|internal)$/.test(h)) {
      throw new Error('Unsupported provider URL');
    }
    return url;
  }
  function absolute(value, base) {
    var v = String(value || '').trim().replace(/&amp;/g, '&');
    if (/^https:\/\//i.test(v)) return safe(v);
    if (/^\/\//.test(v)) return safe('https:' + v);
    if (!v || /^[a-z][a-z\d+.-]*:/i.test(v) || /\\/.test(v)) throw new Error('Invalid provider URL');
    var m = String(base).match(/^(https:\/\/[^/?#]+)([^?#]*)/);
    if (!m) throw new Error('Invalid URL base');
    if (v[0] === '?') return safe(m[1] + (m[2] || '/') + v);
    var suffix = v.search(/[?#]/);
    var tail = suffix < 0 ? '' : v.slice(suffix);
    var p = suffix < 0 ? v : v.slice(0, suffix);
    if (p[0] !== '/') p = (m[2] || '/').replace(/[^/]*$/, '') + p;
    var parts = [];
    p.split('/').forEach(function (s) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); });
    return safe(m[1] + '/' + parts.join('/').replace(/^\/+/, '') + tail);
  }
  function session() { return { end: Date.now() + 24000 }; }
  function headers(url) {
    // No credentials or cookies are supplied; provider context stays on its own host.
    var h = { 'User-Agent': UA, Accept: '*/*' };
    if (host(url) === host(BASE)) {
      h.Referer = BASE + '/'; h.Origin = BASE;
      // This provider's HLS proxy misframes reused HTTP/1.1 connections.
      // Keep each response separate; do not forward this to other hosts.
      h.Connection = 'close';
    }
    return h;
  }
  async function request(url, run, extra) {
    safe(url);
    var h = host(url);
    if (cooldown[h] > Date.now()) throw new Error('Provider is rate limited. Retry later.');
    if (Date.now() >= run.end) throw new Error('Provider request budget exceeded. Retry later.');
    // The shipped no-redirect transport returns headers only, not JSON bodies.
    var opts = { timeoutMs: Math.min(8000, run.end - Date.now()), followRedirects: true,
      maxBytesHint: extra && extra.Range ? 2097152 : 1048576 };
    var hs = Object.assign(headers(url), extra || {});
    var r;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        if (typeof fetchv2 === 'function') r = await fetchv2(url, hs, 'GET', null, opts);
        else r = await fetch(url, { headers: hs, redirect: 'follow' });
      } catch (e) {
        if (attempt === 0 && Date.now() + 4000 < run.end) continue;
        throw new Error('Provider connection failed. Retry later.');
      }
      if (Date.now() >= run.end) throw new Error('Provider request budget exceeded. Retry later.');
      var retryHeaders = r.headers || {};
      var retryHint = typeof retryHeaders.get === 'function' ? retryHeaders.get('retry-after') : retryHeaders['retry-after'];
      if (attempt === 0 && [500, 502, 503, 504].indexOf(Number(r.status)) >= 0 &&
          !retryHint && Date.now() + 4000 < run.end) {
        if (r.body && typeof r.body.cancel === 'function') await r.body.cancel();
        continue;
      }
      break;
    }
    var status = Number(r && r.status) || 0;
    var rh = (r && r.headers) || {};
    function header(k) { return typeof rh.get === 'function' ? rh.get(k) : rh[k] || rh[k.toLowerCase()] || ''; }
    if (status === 429 || (status === 503 && header('retry-after'))) {
      var retry = header('retry-after');
      var seconds = Number(retry);
      var delay = seconds > 0 ? seconds * 1000 : Date.parse(retry) - Date.now();
      cooldown[h] = Date.now() + Math.max(60000, isFinite(delay) ? delay : 0);
      throw new Error('Provider is rate limited. Retry later.');
    }
    if (status < 200 || status >= 300) throw new Error('Provider HTTP ' + status);
    if (r.bodyDropped) throw new Error('Provider response exceeds the runtime limit');
    var data = null;
    try { data = typeof r.json === 'function' ? await (typeof r.clone === 'function' ? r.clone() : r).json() : r.json; }
    catch (_) {}
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) {} }
    var text = typeof r.body === 'string' ? r.body : '';
    if (!text && data == null && typeof r.text === 'function') text = await r.text();
    if (data == null && text) { try { data = JSON.parse(text); } catch (_) {} }
    return { data: data, text: text || '', type: header('content-type'), status: status,
      contentRange: header('content-range') };
  }
  async function json(url, run, ttl) {
    var saved = cache[url];
    if (saved && saved.until > Date.now()) return saved.data;
    if (pending[url]) return pending[url];
    pending[url] = (async function () {
      var r = await request(url, run);
      if (!r.data || typeof r.data !== 'object') throw new Error('Invalid provider JSON (type=' + typeof r.data + ', textBytes=' + r.text.length + ')');
      if (ttl) {
        var keys = Object.keys(cache);
        if (keys.length >= 80) delete cache[keys[0]];
        cache[url] = { data: r.data, until: Date.now() + ttl };
      }
      return r.data;
    })();
    try { return await pending[url]; } finally { delete pending[url]; }
  }
  function normal(title) { return String(title || '').toLowerCase().replace(/\(\d{4}\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function parse(value, episode) {
    var input = String(value || '').trim();
    if (/^https:\/\//i.test(input)) {
      if (host(input) !== host(BASE)) throw new Error('Invalid drama identity host');
      input = input.slice(BASE.length).replace(/^\//, '');
    } else input = input.replace(/^\//, '');
    try { input = decodeURIComponent(input); } catch (_) { throw new Error('Invalid drama identity encoding'); }
    var m = input.match(/^dd:(\d{1,9})(?::e(\d{1,9}))?$/);
    if (!m || Number(m[1]) < 1 || (episode && !(Number(m[2]) > 0))) throw new Error('Invalid drama identity');
    return { series: Number(m[1]), episode: Number(m[2]) || 0 };
  }
  async function search(query, run) {
    var q = String(query || '').trim();
    if (q.length < 2) return [];
    var data = await json(BASE + '/api/find?kind=kshow&q=' + encodeURIComponent(q), run, 300000);
    if (!Array.isArray(data.results)) throw new Error('Invalid search response');
    var seen = {};
    return data.results.filter(function (r) {
      if (!r || !/^[1-9]\d{0,8}$/.test(String(r.id)) || !r.title || seen[r.id]) return false;
      seen[r.id] = true; return true;
    }).map(function (r) {
      var image = '';
      try { image = safe(r.thumb || ''); } catch (_) {}
      var c = { id: 'dd:' + r.id, href: 'dd:' + r.id, title: String(r.title), image: image };
      if (Object.keys(cards).length >= 200) delete cards[Object.keys(cards)[0]];
      cards[c.id] = c;
      return c;
    }).sort(function (a, b) { return Number(normal(b.title) === normal(q)) - Number(normal(a.title) === normal(q)); });
  }
  async function episodeData(id, run) {
    var data = await json(BASE + '/api/kshow-eps?id=' + id, run, 120000);
    if (!data.title || !Array.isArray(data.episodes)) throw new Error('Invalid episode response');
    return data;
  }
  async function picks(page, run) {
    var list = [], start = (page - 1) * 3, firstError = null;
    for (var i = start; i < Math.min(start + 3, PICKS.length); i++) {
      try {
        var rows = await search(PICKS[i], run);
        var match = rows.filter(function (r) { return normal(r.title) === normal(PICKS[i]); });
        // Ambiguous matches remain searchable instead of selecting a random show.
        if (match.length === 1) list.push(match[0]);
      } catch (e) { if (!firstError) firstError = e; }
    }
    if (!list.length && firstError) throw firstError;
    return list;
  }
  async function searchResults(query) { return String(query || '').trim() ? search(query, session()) : picks(1, session()); }
  async function discoveryHome() {
    return { sections: [{ id: 'selected', title: 'Selected Dramas', style: 'hero',
      items: await picks(1, { end: Date.now() + 7500 }), viewAll: { mode: 'feed', feedId: 'selected' } }] };
  }
  async function discoveryFeed(feed, page) {
    if (feed !== 'selected') throw new Error('Unknown drama feed');
    var n = Math.max(1, Math.floor(Number(page) || 1));
    if (!isFinite(n)) throw new Error('Invalid feed page');
    return { page: n, items: await picks(n, { end: Date.now() + 9500 }), hasMore: n * 3 < PICKS.length };
  }
  async function extractDetails(value) {
    var ref = parse(value), run = session();
    var id = 'dd:' + ref.series;
    var data = await episodeData(ref.series, run);
    if (!cards[id]) await search(data.title, run);
    var c = cards[id] || {};
    return { id: id, title: data.title, image: c.image || '', description: '', href: id };
  }
  async function extractEpisodes(value) {
    var ref = parse(value), data = await episodeData(ref.series, session()), seen = {};
    return data.episodes.filter(function (e) {
      if (!/^[1-9]\d{0,8}$/.test(String(e.id)) || !(Number(e.number) > 0) || !isFinite(Number(e.number)) || seen[e.id]) return false;
      seen[e.id] = true; return true;
    }).map(function (e) {
      return { number: Number(e.number), season: 1, title: 'Episode ' + e.number,
        href: 'dd:' + ref.series + ':e' + e.id, subAvailable: true, dubAvailable: false };
    }).sort(function (a, b) { return a.number - b.number; });
  }
  function variants(text, base) {
    var lines = text.split(/\r?\n/), result = [], seen = {};
    lines.forEach(function (line, i) {
      if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) return;
      var next = String(lines[i + 1] || '').trim();
      if (!next || next[0] === '#') return;
      var url = absolute(next, base);
      if (seen[url]) return;
      seen[url] = true;
      var m = line.match(/RESOLUTION=\d+x(\d+)/);
      result.push({ url: url, height: m ? Number(m[1]) : null });
    });
    return result.slice(0, 6);
  }
  async function validate(url, run) {
    var isPlaylistUrl = /\.m3u8(?:[?#]|$)/i.test(url);
    var root = await request(url, run, isPlaylistUrl ? null : { Range: 'bytes=0-4095' });
    if (root.text.slice(4, 8) === 'ftyp') {
      if (root.status !== 206 || !/^bytes 0-\d+\/\d+$/i.test(root.contentRange || '')) {
        throw new Error('Source MP4 does not provide verified byte ranges');
      }
      return { type: 'mp4', qualities: [] };
    }
    if (!isPlaylistUrl && /^\s*#EXTM3U/.test(root.text)) root = await request(url, run);
    if (!/^\s*#EXTM3U/.test(root.text)) throw new Error('Provider did not return HLS');
    var available = variants(root.text, url);
    var selected = available.slice().sort(function (a, b) { return (a.height || 9999) - (b.height || 9999); })[0];
    var media = selected ? await request(selected.url, run) : root;
    if (!/^\s*#EXTM3U/.test(media.text) || !/#EXTINF:/.test(media.text)) throw new Error('No media segments');
    var segment = media.text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s && s[0] !== '#'; })[0];
    var sample = await request(absolute(segment, selected ? selected.url : url), run, { Range: 'bytes=0-4095' });
    // fetchv2 exposes UTF-8 text, not raw bytes. This is a bounded TS header check;
    // independent byte probes and actual decode remain separate certification gates.
    var body = sample.text;
    var tsHeader = body.length > 16 && body[0] === 'G' && body.slice(0, 3) !== 'GIF' &&
      body.charCodeAt(1) < 128 && body.charCodeAt(3) < 128 && (body.charCodeAt(3) & 48) !== 0;
    var mp4Header = body.length > 24 && ['styp', 'moof'].indexOf(body.slice(4, 8)) >= 0;
    if (mp4Header) {
      var init = media.text.match(/#EXT-X-MAP:.*URI="([^"]+)"/);
      if (!init) throw new Error('Fragmented MP4 initialization is missing');
      var initRes = await request(absolute(init[1], selected ? selected.url : url), run, { Range: 'bytes=0-2047' });
      if (['ftyp', 'moov'].indexOf(initRes.text.slice(4, 8)) < 0) throw new Error('Invalid MP4 initialization');
    }
    if (!tsHeader && !mp4Header) throw new Error('Media header could not be verified in this runtime');
    // A video-only variant drops its external audio group. Keep the original
    // master selectable rather than presenting a silent quality option.
    return { type: 'hls', qualities: /#EXT-X-MEDIA:.*TYPE=AUDIO/.test(root.text) ? [] : available };
  }
  var languages = { english: 'en', arabic: 'ar', indonesia: 'id', indonesian: 'id',
    malay: 'ms', khmer: 'km', dutch: 'nl', spanish: 'es', french: 'fr', german: 'de',
    korean: 'ko', chinese: 'zh', thai: 'th', vietnamese: 'vi', portuguese: 'pt' };
  async function extractStreamUrl(value, lang) {
    if (lang && String(lang).toLowerCase() !== 'sub') throw new Error('Dub is not provided by this module');
    var ref = parse(value, true), run = session();
    var data = await episodeData(ref.series, run);
    if (!data.episodes.some(function (e) { return Number(e.id) === ref.episode; })) throw new Error('Episode does not belong to this drama');
    var embed = BASE + '/kisskh/' + ref.episode;
    var html = await request(embed, run);
    var m = html.text.match(/<script[^>]*id=['"]player-payload['"][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) throw new Error('Provider player payload unavailable');
    var payload = JSON.parse(m[1]);
    if (payload.sourceUrl) {
      var sourceApi = absolute(payload.sourceUrl, embed);
      if (host(sourceApi) !== host(BASE)) throw new Error('Unexpected source API host');
      var res = await request(sourceApi, run, { Referer: embed, Accept: 'application/json' });
      payload = res.data;
    }
    if (!payload || !payload.source) throw new Error('Provider has no source for this episode');
    var source = absolute(payload.source, embed);
    var validated = await validate(source, run);
    var qualityRows = validated.qualities;
    var subtitles = [], seen = {};
    var tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
    for (var i = 0; i < Math.min(tracks.length, 16); i++) {
      var t = tracks[i];
      if (!t || !t.file || !t.label) continue;
      var url;
      try { url = absolute(t.file, embed); } catch (_) { continue; }
      if (seen[url]) continue;
      seen[url] = true;
      var label = String(t.label).trim();
      var language = languages[label.toLowerCase()] || 'und';
      subtitles.push({ file: url, url: url, label: label, lang: language, language: language,
        kind: 'captions', default: language === 'en', headers: headers(url) });
    }
    var english = subtitles.filter(function (t) { return t.language === 'en'; })[0];
    if (!english) throw new Error('No English subtitle track supplied for this episode');
    var caption = await request(english.url, run);
    if (!/\d{2}:\d{2}[.,]\d{3}\s*-->/.test(caption.text)) throw new Error('English subtitle file is unavailable');
    var hs = headers(source);
    var defaultQuality = validated.type === 'mp4' ? 'Source' : 'Auto';
    var qualities = [{ label: defaultQuality, url: source, headers: hs }].concat(qualityRows.map(function (q) {
      return { label: q.height ? q.height + 'p' : 'Source', height: q.height || undefined, url: q.url, headers: headers(q.url) };
    }));
    return { url: source, stream: source, streamType: validated.type, lang: 'sub', audioLanguage: 'und',
      headers: hs, subtitles: subtitles, qualities: qualities, quality: defaultQuality,
      streams: [{ label: 'KissKH via MegaVid', url: source, headers: hs, streamType: validated.type }] };
  }
  function diagnostic(fn) {
    return async function () {
      try { return await fn.apply(null, arguments); }
      catch (e) {
        if (typeof console !== 'undefined') console.log('[DramaDirect] ' + fn.name + ': ' + String(e.message || e).replace(/https?:\/\/[^\s]+/g, '[redacted]'));
        throw e;
      }
    };
  }
  globalThis.searchResults = diagnostic(searchResults);
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
})();
