/**
 * Synthetiq Anime for Synthetiq Player.
 * Live English Sub/Dub via Vidhawk (hard media probe), with a labelled AniKage
 * rescue source used when Vidhawk has no verified media (provider outage or a title
 * Vidhawk does not carry). Rescue routes pass the same byte validation. Fresh resolve on every play.
 */
(function () {
  'use strict';

  var MODULE = 'Synthetiq Anime';
  var SITE = 'https://anicrowd.xyz';
  var ANILIST = 'https://graphql.anilist.co';
  var JIKAN = 'https://api.jikan.moe/v4';
  var VIDHAWK = 'https://vidhawk.buzz';
  var MEGAPLAY = 'https://megaplay.buzz';
  var USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  var FAKE_HLS = /tiktokcdn|ibyteimg|ad-site-i18n|\/obj\/ad-site|\.png(?:\?|$)/i;
  var MEDIA_FIELDS =
    'id idMal title { romaji english native userPreferred } description(asHtml: false) ' +
    'bannerImage coverImage { extraLarge large medium } format status episodes duration ' +
    'season seasonYear averageScore genres nextAiringEpisode { episode }';

  function log(msg) {
    try {
      console.log('[' + MODULE + '] ' + String(msg || ''));
    } catch (_) {}
  }

  function clean(value) {
    return String(value == null ? '' : value)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function headers(extra) {
    var out = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    };
    var src = extra || {};
    Object.keys(src).forEach(function (key) {
      out[key] = src[key];
    });
    return out;
  }

  async function readBody(response) {
    if (!response) return '';
    // Flutter omits raw JSON bodies and retains the parsed value in json().
    if (response.bodyDropped) throw new Error('Response exceeded runtime limit');
    if (response.json) {
      try {
        var parsed = typeof response.json === 'function' ? await response.json() : response.json;
        if (parsed != null) return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      } catch (_) {}
    }
    if (typeof response.body === 'string' && response.body) return response.body;
    if (typeof response.text === 'function') {
      try {
        var text = await response.text();
        if (typeof text === 'string' && text) return text;
      } catch (_) {}
    }
    return '';
  }

  async function request(url, extraHeaders, method, body, options) {
    var hdrs = headers(extraHeaders);
    var response = null;
    var opts = options || {};
    if (opts.session && (opts.session.closed || Date.now() >= opts.session.deadline)) {
      return { ok: false, status: 0, text: '', json: null };
    }
    try {
      if (typeof fetchv2 === 'function') {
        var fetchOpts = null;
        if (opts.followRedirects === false || opts.maxBytesHint) {
          fetchOpts = {};
          if (opts.followRedirects === false) fetchOpts.followRedirects = false;
          if (opts.maxBytesHint) fetchOpts.maxBytesHint = opts.maxBytesHint;
        }
        if (fetchOpts) {
          response = await fetchv2(url, hdrs, method || 'GET', body || null, fetchOpts);
        } else {
          response = await fetchv2(url, hdrs, method || 'GET', body || null);
        }
      } else if (typeof fetch === 'function') {
        response = await fetch(url, {
          method: method || 'GET',
          headers: hdrs,
          body: body || undefined,
          redirect: opts.followRedirects === false ? 'manual' : 'follow',
        });
      }
    } catch (error) {
      return { ok: false, status: 0, text: '', json: null, error: String(error && error.message ? error.message : error) };
    }
    var status = Number(response && response.status) || 0;
    var text = '';
    try {
      text = await readBody(response);
    } catch (_) {
      // Dropped bodies surface through bodyDropped/bodyBytes instead of the text.
      text = '';
    }
    if (typeof fetchv2 !== 'function' && (!text || status === 0 || status >= 500) && typeof fetch === 'function') {
      try {
        var native = await fetch(url, {
          method: method || 'GET',
          headers: hdrs,
          body: body || undefined,
        });
        status = Number(native.status) || 0;
        text = await native.text();
        response = native;
      } catch (_) {}
    }
    var parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (_) {}
    return {
      ok: status >= 200 && status < 300,
      status: status,
      text: text || '',
      json: parsed,
      headers: (response && response.headers) || {},
      bodyDropped: Boolean(response && response.bodyDropped),
      bodyBytes: Number((response && response.bodyBytes) || 0),
      hlsPrefixBytes: Number((response && response.hlsPrefixBytes) || 0),
    };
  }

function raceCap(promise, ms) {
  // Settle the race on a timer: a single stalled request must never hang a caller.
  // Timer-side resolution is proven on the app runtime; an orphaned request finishes in
  // the background and its result is ignored.
  return Promise.race([
    promise,
    new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ capped: true });
      }, ms);
    }),
  ]);
}

  async function anilist(query, variables) {
    var out = await raceCap(anilistCall(query, variables), 9000);
    if (out && out.capped) throw new Error('AniList request capped (stalled)');
    return out;
  }

  async function anilistCall(query, variables) {
    var res = await request(
      ANILIST,
      { Accept: 'application/json', 'Content-Type': 'application/json', Referer: SITE + '/' },
      'POST',
      JSON.stringify({ query: query, variables: variables || {} }),
    );
    if (!res.ok || !res.json || res.json.errors) {
      throw new Error('AniList request failed (' + res.status + ')');
    }
    return res.json.data || {};
  }

  async function jikan(path) {
    var out = await raceCap(jikanCall(path), 9000);
    if (out && out.capped) throw new Error('Jikan request capped (stalled)');
    return out;
  }

  async function jikanCall(path) {
    var res = await request(JIKAN + path, {
      Accept: 'application/json',
      Referer: 'https://jikan.moe/',
    });
    if (!res.ok || !res.json) throw new Error('Jikan request failed (' + res.status + ')');
    return res.json;
  }

  function jikanCard(row) {
    if (!row || !row.mal_id) return null;
    var title = clean(row.title_english || row.title || 'Anime');
    var image =
      (row.images &&
        ((row.images.jpg && (row.images.jpg.large_image_url || row.images.jpg.image_url)) ||
          (row.images.webp && row.images.webp.large_image_url))) ||
      '';
    var href = SITE + '/mal/' + row.mal_id;
    return {
      id: href,
      href: href,
      url: href,
      title: title,
      image: image,
      poster: image,
      type: 'tv',
      anilistId: null,
      malId: row.mal_id,
    };
  }

  function mediaCard(media) {
    if (!media || !media.id) return null;
    var title = clean(
      (media.title && (media.title.english || media.title.romaji || media.title.userPreferred)) || 'Anime',
    );
    var image =
      (media.coverImage && (media.coverImage.extraLarge || media.coverImage.large || media.coverImage.medium)) ||
      media.bannerImage ||
      '';
    var href = SITE + '/anime/' + media.id;
    return {
      id: href,
      href: href,
      url: href,
      title: title,
      image: image,
      poster: image,
      type: 'tv',
      year: media.seasonYear ? String(media.seasonYear) : null,
      format: media.format || null,
      anilistId: media.id,
      malId: media.idMal || null,
    };
  }

  function parseRef(raw) {
    var text = String(raw || '').trim();
    try { text = decodeURIComponent(text); } catch (_) {}
    var queryEp = text.match(/[?&]ep=(\d+)/i);
    var malWatch = text.match(/\/mal\/(\d+)/i);
    var compactMal = text.match(/^anicrowd:mal:(\d+)(?::(\d+))?$/i);
    var watch = text.match(/\/anime\/(\d+)(?:\/watch)?/i);
    var compact = text.match(/^anicrowd:(\d+)(?::(\d+))?$/i);
    var ep = compactMal && compactMal[2]
      ? Number(compactMal[2])
      : compact && compact[2]
        ? Number(compact[2])
        : queryEp
          ? Number(queryEp[1])
          : 0;
    if (malWatch || compactMal) {
      return {
        anilistId: 0,
        malId: Number((malWatch && malWatch[1]) || (compactMal && compactMal[1]) || 0),
        episode: ep,
      };
    }
    return {
      anilistId: compact ? Number(compact[1]) : watch ? Number(watch[1]) : 0,
      malId: 0,
      episode: ep,
    };
  }

  function episodeHref(ref, ep) {
    if (ref.anilistId) return SITE + '/anime/' + ref.anilistId + '/watch?ep=' + ep;
    return SITE + '/mal/' + ref.malId + '/watch?ep=' + ep;
  }

  function vidhawkHeaders(referer) {
    return {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.apple.mpegurl,application/json,*/*',
      Referer: referer || VIDHAWK + '/',
      Origin: VIDHAWK,
    };
  }

  function megaplayHeaders() {
    return {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      Referer: MEGAPLAY + '/',
      Origin: MEGAPLAY,
    };
  }

  function looksFake(value) {
    return FAKE_HLS.test(String(value || ''));
  }

  function resolveUrl(value, base) {
    var href = String(value || '').trim();
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return '';
    var parts = String(base || '').match(/^(https?:\/\/[^/?#]+)([^?#]*)/i);
    if (!parts) return '';
    if (href.indexOf('//') === 0) return parts[1].split(':')[0] + ':' + href;
    if (href.charAt(0) === '?') return parts[1] + (parts[2] || '/') + href;
    if (href.charAt(0) === '#') return String(base).split('#')[0] + href;
    // QuickJS does not provide the browser URL constructor. Keep signed suffixes intact.
    var suffixAt = href.search(/[?#]/);
    var suffix = suffixAt < 0 ? '' : href.slice(suffixAt);
    var path = suffixAt < 0 ? href : href.slice(0, suffixAt);
    if (path.charAt(0) !== '/') path = (parts[2] || '/').replace(/[^/]*$/, '') + path;
    var out = [];
    path.split('/').forEach(function (part) {
      if (part === '..') out.pop();
      else if (part !== '.') out.push(part);
    });
    return parts[1] + '/' + out.join('/').replace(/^\/+/, '') + suffix;
  }

  function firstPlaylistUrl(master, base) {
    var lines = String(master || '').split(/\r?\n/);
    var i;
    for (i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
        var j;
        for (j = i + 1; j < lines.length; j += 1) {
          var next = lines[j].trim();
          if (!next || next.charAt(0) === '#') continue;
          return resolveUrl(next, base);
        }
      }
    }
    for (i = 0; i < lines.length; i += 1) {
      var media = lines[i].trim();
      if (!media || media.charAt(0) === '#') continue;
      return resolveUrl(media, base);
    }
    return '';
  }

  function parseQualities(master, base, hdrs) {
    if (/#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(master)) return [];
    var lines = String(master || '').split(/\r?\n/);
    var out = [];
    var seen = {};
    var i;
    for (i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
      var height = 0;
      var res = line.match(/RESOLUTION=\d+x(\d+)/i);
      if (res) height = Number(res[1]) || 0;
      var next = '';
      var j;
      for (j = i + 1; j < lines.length; j += 1) {
        var cand = lines[j].trim();
        if (!cand || cand.charAt(0) === '#') continue;
        next = cand;
        break;
      }
      if (!next || looksFake(next)) continue;
      var url = resolveUrl(next, base);
      if (!url) continue;
      if (seen[url]) continue;
      seen[url] = true;
      out.push({
        label: height ? height + 'p' : 'Auto',
        height: height || undefined,
        url: url,
        headers: hdrs,
      });
    }
    out.sort(function (a, b) {
      return (b.height || 0) - (a.height || 0);
    });
    return out.slice(0, 8);
  }

  // Qualities for a route we just probed: report the master's real variant heights.
  // "Auto" is reserved for genuinely adaptive masters (2+ variants) or unknown heights.
  function probeQualities(probe, url, hdrs) {
    var parsed = probe && probe.master ? parseQualities(probe.master, url, hdrs) : [];
    return parsed.length ? parsed : [{ label: 'Auto', url: url, headers: hdrs }];
  }

  // Mirrors the released 8.6 session-HLS-proxy rewrite classes: manifest refs are served
  // through /segment.<suffix>, but .m4s/.mp4/.html and /init. refs land in the /segment.mp4
  // route the shipped dispatcher mis-handles. Routes without such refs are preferred when a
  // choice exists; the count is advisory metadata and never changes validation acceptance.
  function countProxyBrokenRefs(body, baseUrl) {
    var lines = String(body || '').split(/\r?\n/);
    var broken = 0;
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-KEY') === 0) continue; // keys are served through /asset.m3u8
      if (line.indexOf('#EXT-X-MAP') === 0) {
        var uri = line.match(/URI="([^"]+)"/);
        if (!uri) continue;
        line = uri[1];
      } else if (line.charAt(0) === '#') {
        continue;
      }
      var abs = resolveUrl(line, baseUrl);
      if (!abs) continue;
      var lower = abs.toLowerCase();
      if (lower.indexOf('.m3u8') !== -1) continue;
      if (/\.(m4s|mp4|html)$/.test(lower) || lower.indexOf('/init.') !== -1) broken += 1;
    }
    return broken;
  }

  async function probeHls(url, hdrs, session) {
    if (!url || looksFake(url)) return { ok: false, reason: 'fake_url' };
    var playlist = await request(url, hdrs, 'GET', null, { session: session });
    if (!playlist.ok || playlist.text.indexOf('#EXTM3U') < 0) {
      return { ok: false, reason: 'not_hls', status: playlist.status };
    }
    if (looksFake(playlist.text)) return { ok: false, reason: 'fake_hls' };
    var child = firstPlaylistUrl(playlist.text, url);
    if (!child) return { ok: false, reason: 'no_media' };
    if (looksFake(child)) return { ok: false, reason: 'fake_hls' };
    var mediaUrl = url;
    var mediaBody = playlist.text;
    if (/#EXT-X-STREAM-INF:/i.test(playlist.text)) {
      var variant = await request(child, hdrs, 'GET', null, { session: session });
      if (!variant.ok || variant.text.indexOf('#EXTM3U') < 0) {
        return { ok: false, reason: 'variant_fail', status: variant.status };
      }
      if (looksFake(variant.text)) return { ok: false, reason: 'fake_hls' };
      mediaUrl = child;
      mediaBody = variant.text;
    }
    if (!/#EXTINF:/i.test(mediaBody)) return { ok: false, reason: 'no_segments' };
    var proxyBrokenRefs = countProxyBrokenRefs(mediaBody, mediaUrl);
    var seg = firstPlaylistUrl(mediaBody, mediaUrl);
    if (!seg || looksFake(seg)) return { ok: false, reason: 'fake_seg' };
    // These CDNs ignore Range and the app bridge drops binary bodies over its 512 KB
    // default cap, so probe with an explicit elevated cap (maxBytesHint). Raised to 4 MiB
    // (trio repair 2026-09-27): ~2.1 MB segments were cut at the old 2 MiB cap and dropped.
    var segment = await request(seg, Object.assign({}, hdrs, { Range: 'bytes=0-4095' }), 'GET', null, {
      session: session,
      maxBytesHint: 4194304,
    });
    if (!segment.ok) return { ok: false, reason: 'seg_' + segment.status, status: segment.status };
    if (segment.bodyDropped) {
      // Range ignored + body cut at the 4 MiB probe cap: reachability evidence only.
      var droppedCt = String((segment.headers && (segment.headers['content-type'] || segment.headers['Content-Type'])) || '').toLowerCase();
      if (segment.status >= 200 && segment.status < 300 && Number(segment.bodyBytes || 0) >= 3145728 && droppedCt.indexOf('html') < 0 && droppedCt.indexOf('json') < 0) {
        return { ok: true, master: playlist.text, kind: 'size_capped', brokenRefs: proxyBrokenRefs, reachabilityOnly: true };
      }
      return { ok: false, reason: 'segment_empty' };
    }
    var sample = segment.text || '';
    // Byte-first classification: the segment suffix and content-type are decoration.
    // A CDN may serve real MPEG-TS under a .jpg name with an image/jpeg header
    // (verified live on the MegaPlay CDN, 0x47 sync at 0/188/376). Reject only on
    // positive error evidence of the wrong content; accept on the media signature.
    var ts = sample.charCodeAt(0) === 0x47;
    var fragment = /^(styp|moof)$/.test(sample.slice(4, 8));
    var pngWrappedTs =
      sample.charCodeAt(0) === 0x89 && sample.charCodeAt(1) === 0x50 && sample.charCodeAt(252) === 0x47;
    if (!ts && !fragment && !pngWrappedTs) {
      if (/^\s*<(?:!doctype|html|svg)/i.test(sample.slice(0, 256))) return { ok: false, reason: 'seg_html' };
      if (/^\s*[{\[]/.test(sample.slice(0, 2))) return { ok: false, reason: 'seg_json' };
      if (/PNG|JFIF|GIF8|WEBP/i.test(sample.slice(0, 64))) return { ok: false, reason: 'seg_image' };
      return { ok: false, reason: 'unrecognized_media' };
    }
    if (fragment) {
      var map = mediaBody.match(/#EXT-X-MAP:.*URI="([^"]+)"/i);
      if (!map) return { ok: false, reason: 'missing_init' };
      var init = await request(resolveUrl(map[1], mediaUrl), Object.assign({}, hdrs, { Range: 'bytes=0-4095' }), 'GET', null, {
        session: session,
        maxBytesHint: 4194304,
      });
      if (!init.ok || !/^(ftyp|moov)$/.test(init.text.slice(4, 8))) return { ok: false, reason: 'invalid_init' };
    }
    return { ok: true, master: playlist.text, brokenRefs: proxyBrokenRefs };
  }

  function mapCaptions(captions, audio, hdrs) {
    var out = [];
    var seen = {};
    function push(item) {
      if (!item || typeof item !== 'object') return;
      var file = String(item.src || item.file || item.url || '').trim();
      if (!/^https?:\/\//i.test(file) || seen[file]) return;
      var lang = clean(item.lang || item.language || '').toLowerCase();
      var aliases = {
        english: 'en', japanese: 'ja', spanish: 'es', arabic: 'ar', french: 'fr',
        italian: 'it', german: 'de', portuguese: 'pt', russian: 'ru', chinese: 'zh',
        korean: 'ko', turkish: 'tr', polish: 'pl', indonesian: 'id', thai: 'th',
        vietnamese: 'vi', dutch: 'nl', ukrainian: 'uk', hindi: 'hi', czech: 'cs',
        danish: 'da', finnish: 'fi', greek: 'el', hebrew: 'he', malay: 'ms',
        norwegian: 'no', swedish: 'sv', romanian: 'ro', hungarian: 'hu',
        bulgarian: 'bg', croatian: 'hr', serbian: 'sr', slovak: 'sk',
        slovenian: 'sl', persian: 'fa', bengali: 'bn', tamil: 'ta', telugu: 'te',
        urdu: 'ur', filipino: 'fil', catalan: 'ca', estonian: 'et', latvian: 'lv',
        lithuanian: 'lt', icelandic: 'is', swahili: 'sw',
      };
      // Provider sometimes sends lang=en on every track; explicit labels identify translations.
      var labelLanguage = clean(item.label || '').toLowerCase().split(/[ (]/)[0];
      var languageName = lang.split(/[ (]/)[0];
      lang = aliases[labelLanguage] || aliases[languageName] || lang;
      if (!lang) lang = 'und';
      seen[file] = true;
      out.push({
        id: file,
        url: file,
        file: file,
        label: clean(item.label || item.language || item.lang || 'Subtitle'),
        language: lang,
        lang: lang,
        kind: 'subtitle',
        default: Boolean(item.default),
        headers: hdrs,
      });
    }
    if (Array.isArray(captions)) {
      captions.forEach(push);
      return out;
    }
    if (captions && typeof captions === 'object') {
      var key = audio === 'dub' ? 'dub' : 'sub';
      // Sub and Dub may be different edits. Never mix their caption timelines.
      if (Array.isArray(captions[key])) captions[key].forEach(push);
    }
    return out;
  }

  function markerPair(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var start = Number(raw.start);
    var end = Number(raw.end);
    if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) return null;
    return { start: Math.floor(start), end: Math.floor(end) };
  }

  function withTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(fallback); }, ms);
      Promise.resolve(promise).then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function () {
        clearTimeout(timer);
        resolve(fallback);
      });
    });
  }

  async function playVidhawkTicket(ticket, want, label, session, referer) {
    if (!ticket) return null;
    var play = await request(VIDHAWK + '/api/play?t=' + encodeURIComponent(ticket), vidhawkHeaders(referer), 'GET', null, { session: session });
    var meta = play.json;
    if (!play.ok || !meta) return null;
    var tracks = Array.isArray(meta.tracks) ? meta.tracks : [];
    var track = tracks.filter(function (row) {
      return row && row.id === want && row.src;
    })[0];
    if (!track || !track.src) return null;
    var hdrs = vidhawkHeaders(referer);
    var probe = await probeHls(track.src, hdrs, session);
    if (!probe.ok) {
      log('probe failed ' + (label || '') + ' ' + (probe.reason || ''));
      return null;
    }
    return {
      name: String(label || meta.serverLabel || meta.server || 'Server'),
      url: track.src,
      headers: hdrs,
      streamType: 'hls',
      lang: want,
      subtitles: mapCaptions(meta.captions, want, hdrs),
      qualities: parseQualities(probe.master, track.src, hdrs),
      intro: markerPair(meta.intro),
      outro: markerPair(meta.outro),
      dubAvailable: tracks.some(function (row) {
        return row && row.id === 'dub' && row.src;
      }),
    };
  }

  async function resolveVidhawk(anilistId, malId, episode, audio, serverName, session) {
    var want = audio === 'dub' ? 'dub' : 'sub';
    var embedPath = anilistId
      ? VIDHAWK + '/embed/ani/' + anilistId + '/' + episode + '/' + want
      : VIDHAWK + '/embed/mal/' + malId + '/' + episode + '/' + want;
    var server = serverName || 'flow';
    var params =
      'episode=' +
      encodeURIComponent(episode) +
      '&audio=' +
      encodeURIComponent(want) +
      '&parentHost=anicrowd.xyz&fast=1&server=' +
      encodeURIComponent(server);
    if (anilistId) params += '&anilistId=' + encodeURIComponent(anilistId);
    if (malId) params += '&malId=' + encodeURIComponent(malId);
    if (!anilistId && !malId) return null;
    var resolved = await request(
      VIDHAWK + '/api/stream/resolve?' + params,
      Object.assign(vidhawkHeaders(), { Referer: embedPath }),
      'GET', null, { session: session },
    );
    var ticket = resolved.json && resolved.json.ticket;
    if (!resolved.ok || !ticket) return null;
    return playVidhawkTicket(ticket, want, resolved.json.serverLabel || server, session, embedPath);
  }

  async function resolveVidhawkPair(anilistId, malId, episode, audio) {
    var session = { closed: false, deadline: Date.now() + 9000 };
    var results = [];
    var firstReady;
    var first = new Promise(function (resolve) { firstReady = resolve; });
    var all = Promise.all(['flow', 'zuri'].map(function (name) {
      return resolveVidhawk(anilistId, malId, episode, audio, name, session).then(function (row) {
        if (!session.closed && row && row.url) {
          results.push(row);
          firstReady();
        }
      }).catch(function () {});
    }));
    await withTimeout(Promise.race([first, all]), 9000, null);
    if (results.length) await withTimeout(all, Math.min(800, Math.max(0, session.deadline - Date.now())), null);
    // An in-flight HTTP request cannot be cancelled by fetchv2. Stop its next step.
    session.closed = true;
    return results.slice();
  }

// ---------------------------------------------------------------- player payload decryption
// The vidstream-style player hosts (megaplay.buzz family) moved their stream descriptor into
// an encrypted `enc` field of the getSources/getSourcesNew response (scheme implemented in the
// host's own newclient.min.js: AES-CBC, key "i?LMTAx0Q6,:}50U" zero-padded to 32 bytes, IV
// "W0;27ToaUpl_P%'c", base64url ciphertext, JSON plaintext). Decrypt locally — these are the
// site-published scheme constants, not user data. Pure ES5, no typed arrays, no WebCrypto.
const PLAYER_PAYLOAD_KEY = 'i?LMTAx0Q6,:}50U';
const PLAYER_PAYLOAD_IV = "W0;27ToaUpl_P%'c";
const AES_SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];
var AES_INV_SBOX = null;
function aesInvSbox() {
  if (AES_INV_SBOX) return AES_INV_SBOX;
  var inv = new Array(256);
  for (var i = 0; i < 256; i += 1) inv[AES_SBOX[i]] = i;
  AES_INV_SBOX = inv;
  return inv;
}
const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d];
function aesExpandKey256(keyBytes) {
  const Nk = 8;
  const total = 60;
  const w = new Array(total);
  for (let i = 0; i < Nk; i += 1) {
    w[i] = (((keyBytes[4 * i] & 255) << 24) | ((keyBytes[4 * i + 1] & 255) << 16) | ((keyBytes[4 * i + 2] & 255) << 8) | (keyBytes[4 * i + 3] & 255)) >>> 0;
  }
  for (let i = Nk; i < total; i += 1) {
    let t = w[i - 1];
    if (i % Nk === 0) {
      t = ((t << 8) | (t >>> 24)) >>> 0;
      t = ((AES_SBOX[(t >>> 24) & 255] << 24) | (AES_SBOX[(t >>> 16) & 255] << 16) | (AES_SBOX[(t >>> 8) & 255] << 8) | AES_SBOX[t & 255]) >>> 0;
      t = (t ^ ((AES_RCON[(i / Nk) - 1] & 255) << 24)) >>> 0;
    } else if (i % Nk === 4) {
      t = ((AES_SBOX[(t >>> 24) & 255] << 24) | (AES_SBOX[(t >>> 16) & 255] << 16) | (AES_SBOX[(t >>> 8) & 255] << 8) | AES_SBOX[t & 255]) >>> 0;
    }
    w[i] = (w[i - Nk] ^ t) >>> 0;
  }
  return w;
}
function gfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i += 1) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 255;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 255;
}
function aesDecryptBlock(block16, w) {
  const inv = aesInvSbox();
  const s = block16.slice(0);
  let i;
  const addRoundKey = function (round) {
    const base = 4 * round;
    for (let j = 0; j < 16; j += 1) s[j] ^= (w[base + (j >> 2)] >>> (24 - 8 * (j & 3))) & 255;
  };
  addRoundKey(14);
  for (let round = 13; round >= 0; round -= 1) {
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    for (i = 0; i < 16; i += 1) s[i] = inv[s[i]];
    addRoundKey(round);
    if (round > 0) {
      for (let c = 0; c < 4; c += 1) {
        const a0 = s[4 * c]; const a1 = s[4 * c + 1]; const a2 = s[4 * c + 2]; const a3 = s[4 * c + 3];
        s[4 * c] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
        s[4 * c + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
        s[4 * c + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
        s[4 * c + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
      }
    }
  }
  return s;
}
const B64URL_LOOKUP = (function () {
  const table = {};
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charAt(i)] = i;
  return table;
})();
function base64UrlBytes(value) {
  const s = String(value || '').replace(/\+/g, '-').replace(/\//g, '_');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charAt(i);
    if (c === '=') break;
    const v = B64URL_LOOKUP[c];
    if (v === undefined) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return out;
}
function bytesToText(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
    else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3;
    } else if (b >= 0xf0 && i + 3 < bytes.length) {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const adj = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff)); i += 4;
    } else { out += String.fromCharCode(b); i += 1; }
  }
  return out;
}
function playerPayloadKeyBytes() {
  const bytes = [];
  for (let i = 0; i < 32; i += 1) bytes.push(i < PLAYER_PAYLOAD_KEY.length ? PLAYER_PAYLOAD_KEY.charCodeAt(i) & 255 : 0);
  return bytes;
}
function decryptPlayerPayload(enc) {
  try {
    if (!enc || typeof enc !== 'string') return null;
    const bytes = base64UrlBytes(enc);
    if (!bytes.length || bytes.length % 16 !== 0) return null;
    const iv = [];
    for (let i = 0; i < 16; i += 1) iv.push(PLAYER_PAYLOAD_IV.charCodeAt(i) & 255);
    const w = aesExpandKey256(playerPayloadKeyBytes());
    const plainBytes = [];
    let prev = iv;
    for (let off = 0; off + 16 <= bytes.length; off += 16) {
      const block = bytes.slice(off, off + 16);
      const dec = aesDecryptBlock(block, w);
      for (let i = 0; i < 16; i += 1) plainBytes.push(dec[i] ^ prev[i]);
      prev = block;
    }
    // PKCS#7 unpad (only when the padding is well formed).
    let outBytes = plainBytes;
    const pad = outBytes.length ? outBytes[outBytes.length - 1] : 0;
    if (pad > 0 && pad <= 16 && pad <= outBytes.length) {
      let ok = true;
      for (let k = 0; k < pad; k += 1) if (outBytes[outBytes.length - 1 - k] !== pad) { ok = false; break; }
      if (ok) outBytes = outBytes.slice(0, outBytes.length - pad);
    }
    const text = bytesToText(outBytes).trim();
    const json = safeJsonParse(text);
    if (json && typeof json === 'object') return json;
    if (/^https?:\/\//i.test(text)) return { file: text };
    return null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- outage rescue (AniKage)
// Vidhawk is the primary provider. When it has no VERIFIED media for a title (provider outage
// or a title it does not carry) the module asks AniKage (anikage.cc, JSON API) as a labelled
// second source. Rescue routes pass the same positive byte validation as primary routes and
// are never substituted across languages. Quota discipline: one sweep per play, stop on 429,
// cache slug lookups (6 h) and verified routes (10 min) so repeat plays cost zero requests.

var ANIKAGE = 'https://anikage.cc';
var RESCUE_PROVIDERS = ['koto', 'wave', 'zen', 'dib', 'neko'];
var RESCUE_MAX_ROUTES = 3;
var RESCUE_MAX_EMBEDS = 4;
var RESCUE_BUDGET_MS = 12000;
var RESCUE_TITLE_TTL = 6 * 60 * 60 * 1000;
var RESCUE_SLUG_TTL = 6 * 60 * 60 * 1000;
var RESCUE_ROUTE_TTL = 10 * 60 * 1000;
var rescueTitles = {};
var rescueSlugs = {};
var rescueRoutes = {};

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function rescueCacheGet(store, key, ttl) {
  var hit = store[key];
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  delete store[key];
  return null;
}

function rescueCacheSet(store, key, value, ttl) {
  store[key] = { at: Date.now(), value: value, ttl: ttl };
}

function rescueTerm(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/['\u2019]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rescueOrigin(url) {
  var m = String(url || '').match(/^https?:\/\/[^\/?#]+/i);
  return m ? m[0] : '';
}

function rescuePick(list, ref, title) {
  if (!Array.isArray(list)) return null;
  if (ref.anilistId) {
    var byId = list.filter(function (item) {
      return item && String(item.anilistId || '') === String(ref.anilistId);
    });
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) return null;
  }
  var wanted = rescueTerm(title);
  if (!wanted) return null;
  var byTitle = list.filter(function (item) {
    if (!item) return false;
    var t = item.title;
    var names = typeof t === 'string' ? [t] : [t && t.english, t && t.romaji, t && t.userPreferred];
    return names.some(function (name) {
      return name && rescueTerm(name) === wanted;
    });
  });
  return byTitle.length === 1 ? byTitle[0] : null;
}

async function rescueTitleFor(ref) {
  var key = ref.anilistId ? 'a' + ref.anilistId : ref.malId ? 'm' + ref.malId : '';
  if (!key) return '';
  var cached = rescueCacheGet(rescueTitles, key, RESCUE_TITLE_TTL);
  if (cached) return cached;
  var title = '';
  try {
    if (ref.anilistId) {
      var data = await anilist(
        'query ($id: Int) { Media(id: $id, type: ANIME) { title { english romaji userPreferred } } }',
        { id: ref.anilistId },
      );
      var t = data && data.Media && data.Media.title;
      title = clean((t && (t.english || t.romaji || t.userPreferred)) || '');
    } else if (ref.malId) {
      var jk = await jikan('/anime/' + ref.malId);
      title = clean((jk && jk.data && (jk.data.title_english || jk.data.title)) || '');
    }
  } catch (_) {}
  if (title) rescueCacheSet(rescueTitles, key, title, RESCUE_TITLE_TTL);
  return title;
}

async function rescueSlugFor(ref, title, session) {
  var key = String(ref.anilistId || ref.malId || rescueTerm(title) || '');
  if (!key) return '';
  var cached = rescueCacheGet(rescueSlugs, key, RESCUE_SLUG_TTL);
  if (cached) return cached;
  if (!title) return '';
  var res = await request(
    ANIKAGE + '/api/media/anime/browse?q=' + encodeURIComponent(title),
    { Accept: 'application/json', Referer: ANIKAGE + '/' },
    'GET',
    null,
    { session: session },
  );
  if (res && res.status === 429) {
    log('rescue search rate limited (429)');
    return '';
  }
  if (!res || !res.ok || !res.json) {
    log('rescue browse unavailable (' + (res ? res.status : 'net') + ')');
    return '';
  }
  var pick = rescuePick(res.json.data, ref, title);
  if (!pick) return '';
  var slug = String(pick.slug || pick.id || '');
  if (!slug) return '';
  rescueCacheSet(rescueSlugs, key, slug, RESCUE_SLUG_TTL);
  return slug;
}

function rescueRank(url) {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 0;
  if (/megaplay\.|vidstream/i.test(url)) return 0;
  if (/echovideo/i.test(url)) return 1;
  if (/otakuhg\.site|otakuvid\.online|playmogo\.com|\.(?:vivi|bibi)\./i.test(url)) return 2;
  return 3;
}

function rescueEmbedUrls(data) {
  var seen = {};
  function url(entry) {
    if (typeof entry === 'string') return entry;
    if (!entry) return '';
    var u = String(entry.url || '').trim();
    if (/^https?:\/\//i.test(u)) return u;
    return String(entry.embedUrl || '');
  }
  var merged = [].concat(
    (data && data.embeds) || [],
    (data && data.embedOptions) || [],
    Array.isArray(data && data.sources) ? data.sources : [],
  );
  return merged
    .map(url)
    .filter(function (u) {
      if (!/^https?:\/\//i.test(u) || seen[u]) return false;
      seen[u] = true;
      return true;
    })
    .sort(function (a, b) {
      return rescueRank(a) - rescueRank(b);
    });
}

function rescuePlayerMeta(html) {
  var src = String(html || '');
  var id = (src.match(/data-id=["']?(\d+)["']?/i) || [])[1] || (src.match(/id:\s*["']?(\d+)["']?/i) || [])[1] || '';
  var type = (src.match(/type:\s*['"](sub|dub|hsub)['"]/i) || [])[1] || '';
  return { id: String(id || '').trim(), type: String(type || '').toLowerCase() };
}

function rescueNormalizeEntries(payload) {
  var out = [];
  var seen = {};
  function push(url, label) {
    var u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u) || seen[u]) return;
    seen[u] = true;
    out.push({ quality: clean(label || 'Auto') || 'Auto', url: u });
  }
  var raw = payload;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    raw = (raw.sources && (raw.sources.file || raw.sources.url || raw.sources)) || raw.file || raw.url || raw;
  }
  if (typeof raw === 'string') {
    push(raw);
  } else if (Array.isArray(raw)) {
    raw.forEach(function (entry) {
      if (entry) push(entry.file || entry.url, entry.label || entry.quality || entry.type);
    });
  } else if (raw && typeof raw === 'object') {
    if (raw.file || raw.url) push(raw.file || raw.url, raw.label || raw.quality);
    ['HQ', 'HD', 'SD'].forEach(function (key) {
      [].concat(raw[key] || []).forEach(function (u) {
        if (typeof u === 'string') push(u, key);
      });
    });
  }
  return out;
}

function unpackPacker(code) {
  try {
    var match = String(code || '').match(/eval\(function\(p,a,c,k,e,[rd]\)\{.*\}\('(.*)',\s*(\d+),\s*(\d+),\s*'([^']*)'\.split\('\|'\)/);
    if (!match) return null;
    var p = match[1];
    var a = parseInt(match[2], 10);
    var c = parseInt(match[3], 10);
    var k = match[4].split('|');
    var e = function (n) {
      return (n < a ? '' : e(parseInt(n / a, 10))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    };
    while (c--) {
      if (k[c]) {
        p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
      }
    }
    return p;
  } catch (_) {
    return null;
  }
}

function rescueSleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function rescueFinish(session, value) {
  // Deliver the result through plain fields: the app JS engine does not reliably run
  // reactions chained onto an already-settled promise, so the caller polls these fields.
  session.result = value;
  session.done = true;
  return value;
}

async function rescuePlayerRoute(embedUrl, want, session) {
  var uaHeaders = { 'User-Agent': USER_AGENT, Referer: ANIKAGE + '/' };

  if (/\.m3u8(?:[?#]|$)/i.test(embedUrl)) {
    var direct = await probeHls(embedUrl, uaHeaders, session);
    if (!direct.ok) return null;
    return {
      name: 'AniKage',
      url: embedUrl,
      headers: uaHeaders,
      streamType: 'hls',
      brokenRefs: direct.brokenRefs || 0,
      lang: want,
      subtitles: [],
      qualities: probeQualities(direct, embedUrl, uaHeaders),
    };
  }

  if (/megaplay\.|vidstream/i.test(embedUrl)) {
    var origin = rescueOrigin(embedUrl);
    var page = await request(embedUrl, Object.assign({ Accept: 'text/html,*/*' }, uaHeaders), 'GET', null, { session: session });
    if (!page.ok) {
      log('rescue mp page ' + page.status);
      return null;
    }
    var meta = rescuePlayerMeta(page.text);
    if (!meta.id) {
      log('rescue mp no-id');
      return null;
    }
    var srcHeaders = { 'User-Agent': USER_AGENT, Accept: '*/*', Referer: origin + '/', Origin: origin };
    var qs = '?id=' + encodeURIComponent(meta.id) + '&id=' + encodeURIComponent(meta.id) + '&type=' + encodeURIComponent(want);
    var data = null;
    var fresh = await request(origin + '/stream/getSourcesNew' + qs, srcHeaders, 'GET', null, { session: session });
    if (fresh && fresh.ok && fresh.json) data = fresh.json;
    if (!data || (!data.sources && !data.enc && !data.file)) {
      var legacy = await request(origin + '/stream/getSources' + qs, srcHeaders, 'GET', null, { session: session });
      if (legacy && legacy.ok && legacy.json) data = legacy.json;
    }
    if (!data) {
      log('rescue mp no-sources');
      return null;
    }
    var entries = rescueNormalizeEntries(data);
    if (!entries.length && data.enc) {
      var decrypted = decryptPlayerPayload(data.enc);
      if (decrypted) entries = rescueNormalizeEntries(decrypted);
    }
    if (!entries.length) {
      log('rescue mp no-entries');
      return null;
    }
    var caps = mapCaptions(data.tracks, want, srcHeaders);
    for (var i = 0; i < entries.length && i < 2; i += 1) {
      var probe = await probeHls(entries[i].url, srcHeaders, session);
      if (probe.ok) {
        return {
          name: 'AniKage \u00b7 MegaPlay',
          url: entries[i].url,
          headers: srcHeaders,
          streamType: 'hls',
          brokenRefs: probe.brokenRefs || 0,
          lang: want,
          subtitles: caps,
          qualities: probeQualities(probe, entries[i].url, srcHeaders),
          intro: markerPair(data.intro),
          outro: markerPair(data.outro),
        };
      }
    }
    log('rescue mp probe ' + (probe && probe.reason ? probe.reason : 'fail'));
    return null;
  }

  var echo = embedUrl.match(/^https:\/\/play\.echovideo\.ru\/(embed-[a-z0-9-]+)\/([^/?#]+)/i);
  if (echo) {
    var echoHeaders = { 'User-Agent': USER_AGENT, Accept: '*/*', Referer: embedUrl, Origin: 'https://play.echovideo.ru' };
    var gs = await request('https://play.echovideo.ru/' + echo[1] + '/getSources?id=' + encodeURIComponent(echo[2]), echoHeaders, 'GET', null, { session: session });
    if (!gs.ok || !gs.json) {
      log('rescue echo sources ' + (gs ? gs.status : 'net'));
      return null;
    }
    var eentries = rescueNormalizeEntries(gs.json);
    for (var e = 0; e < eentries.length && e < 2; e += 1) {
      var eprobe = await probeHls(eentries[e].url, echoHeaders, session);
      if (eprobe.ok) {
        return {
          name: 'AniKage \u00b7 EchoVideo',
          url: eentries[e].url,
          headers: echoHeaders,
          streamType: 'hls',
          brokenRefs: eprobe.brokenRefs || 0,
          lang: want,
          subtitles: mapCaptions(gs.json.tracks, want, echoHeaders),
          qualities: probeQualities(eprobe, eentries[e].url, echoHeaders),
        };
      }
    }
    log('rescue echo probe ' + (eprobe && eprobe.reason ? eprobe.reason : 'fail'));
    return null;
  }

  if (/otakuhg\.site|otakuvid\.online|playmogo\.com|\.(?:vivi|bibi)\.|flixcloud\.|animeapps\.top|mfw09\.org|myvidplay\.com/i.test(embedUrl)) {
    var page2 = await request(embedUrl, Object.assign({ Accept: 'text/html,*/*' }, uaHeaders), 'GET', null, { session: session });
    if (!page2.ok) return null;
    var body = unpackPacker(page2.text) || page2.text;
    var hit = body.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
    if (!hit) return null;
    var hdr2 = { 'User-Agent': USER_AGENT, Referer: embedUrl, Origin: rescueOrigin(embedUrl) };
    var probe2 = await probeHls(hit[0], hdr2, session);
    if (!probe2.ok) return null;
    return {
      name: 'AniKage \u00b7 Player',
      url: hit[0],
      headers: hdr2,
      streamType: 'hls',
      brokenRefs: probe2.brokenRefs || 0,
      lang: want,
      subtitles: [],
      qualities: probeQualities(probe2, hit[0], hdr2),
    };
  }

  log('rescue unsupported embed');
  return null;
}

async function rescueAnikageRoutes(ref, want, halt) {
  var routeKey = String(ref.anilistId || ref.malId || '') + '|' + String(ref.episode) + '|' + want;
  var session = halt || {};
  if (typeof session.closed !== 'boolean') session.closed = false;
  if (!session.deadline) session.deadline = Date.now() + RESCUE_BUDGET_MS;
  var cached = rescueCacheGet(rescueRoutes, routeKey, RESCUE_ROUTE_TTL);
  if (cached && cached.length) return rescueFinish(session, cached);
  var startAt = Date.now();
  var routes = [];
  try {
    var title = await rescueTitleFor(ref);
    if (!title || session.closed) return null;
    var slug = await rescueSlugFor(ref, title, session);
    if (!slug || session.closed) return null;
    log('rescue: ' + slug + ' ep' + ref.episode + ' ' + want);
    var order = 0;
    for (var p = 0; p < RESCUE_PROVIDERS.length; p += 1) {
      if (session.closed || Date.now() >= session.deadline) break;
      // Return the first verified route immediately — never make the user wait while a
      // backup provider probes (a straggler probe here cost 8 s of the offline wait once).
      if (routes.length) break;
      var provider = RESCUE_PROVIDERS[p];
      var url =
        ANIKAGE +
        '/api/media/anime/' + encodeURIComponent(slug) +
        '/episodes/' + encodeURIComponent(ref.episode) +
        '/sources?provider=' + provider +
        '&lang=' + want;
      var res = await request(url, { Accept: 'application/json', Referer: ANIKAGE + '/anime/watch/' + slug }, 'GET', null, { session: session });
      if (res && res.status === 429) {
        log('rescue sweep rate limited (429)');
        break;
      }
      if (!res || !res.ok || !res.json) {
        log('rescue ' + provider + ' unavailable (' + (res ? res.status : 'net') + ')');
        continue;
      }
      var data = res.json;
      if (
        String(data.slug || '') !== String(slug) ||
        Number(data.number) !== Number(ref.episode) ||
        String(data.subType || '').toLowerCase() !== want
      ) {
        log('rescue ' + provider + ' shape mismatch');
        continue;
      }
      var embeds = rescueEmbedUrls(data).slice(0, RESCUE_MAX_EMBEDS);
      log('rescue ' + provider + ' embeds=' + embeds.length);
      var providerStart = Date.now();
      for (var e2 = 0; e2 < embeds.length && routes.length < RESCUE_MAX_ROUTES; e2 += 2) {
        if (session.closed || Date.now() >= session.deadline) break;
        // Bound each provider's share so one slow provider cannot starve the rest (a single
        // hung koto embed once ate 8 s of a 10 s budget and starved wave/zen, which were the
        // providers that actually carried the episode).
        if (e2 > 0 && Date.now() >= providerStart + 3200) break;
        var group = embeds.slice(e2, e2 + 2);
        var groupStart = Date.now();
        var providerLabel = provider;
        // Probe the group in PARALLEL but poll the shared route array for the first verified
        // route — the app JS engine does not reliably propagate nested racing-promise
        // reactions, while timers and .then handlers are proven to run (a hanging first
        // embed must never block a sibling that verifies in ~1.3 s).
        group.forEach(function (embed) {
          rescuePlayerRoute(embed, want, session)
            .then(function (route) {
              if (!route || routes.length >= RESCUE_MAX_ROUTES) return null;
              if (routes.some(function (known) { return known.url === route.url; })) return null;
              route.name += ' (' + providerLabel + ')';
              route.order = order++;
              routes.push(route);
              log('rescue route ' + route.name + ' +' + (Date.now() - startAt) + 'ms');
              return route;
            })
            .catch(function () {
              log('rescue embed error');
              return null;
            });
        });
        var groupDeadline = Math.min(Date.now() + 3000, providerStart + 3400, session.deadline);
        while (routes.length === 0 && !session.closed && Date.now() < groupDeadline) {
          await rescueSleep(350);
        }
        if (!routes.length) {
          log('rescue ' + provider + ' group' + (e2 / 2) + ' ' + (Date.now() - groupStart) + 'ms none');
        }
        if (routes.length) break;
      }
    }
    log('rescue routes=' + routes.length + ' in ' + (Date.now() - startAt) + 'ms');
    if (routes.length > 1) {
      // Prefer routes the released session proxy can serve end-to-end — i.e. without
      // .html/.mp4/.m4s/init refs that the 8.6 dispatcher mis-routes. Stable within
      // equal-safety groups; order is the only behaviour this changes.
      routes.sort(function (a, b) {
        return (a.brokenRefs === 0 ? 0 : 1) - (b.brokenRefs === 0 ? 0 : 1) || ((a.order || 0) - (b.order || 0));
      });
    }
    if (routes.length) rescueCacheSet(rescueRoutes, routeKey, routes, RESCUE_ROUTE_TTL);
    return rescueFinish(session, routes.length ? routes : null);
  } catch (error) {
    log('rescue error ' + (error && error.message ? error.message : error));
    return rescueFinish(session, null);
  } finally {
    session.closed = true;
  }
}

  function packStream(primary, extras, lang) {
    if (!primary || !primary.url) {
      return {
        streams: [],
        subtitles: [],
        lang: lang,
        error: { message: 'Synthetiq Anime has no playable stream for this episode yet.' },
      };
    }
    var servers = [];
    var seen = {};
    [primary].concat(extras || []).forEach(function (row) {
      if (!row || !row.url || seen[row.url]) return;
      seen[row.url] = true;
      var entry = {
        name: row.name || 'Server',
        label: row.name || 'Server',
        url: row.url,
        headers: row.headers || {},
        streamType: row.streamType || 'hls',
        lang: row.lang || lang,
        subtitles: row.subtitles || [],
        qualities: row.qualities || [],
      };
      if (row.intro) {
        entry.intro = [row.intro.start, row.intro.end];
      }
      if (row.outro) {
        entry.outro = [row.outro.start, row.outro.end];
      }
      servers.push(entry);
    });
    var qualities = Array.isArray(primary.qualities) ? primary.qualities : [];
    var merged = [];
    var seenQuality = {};
    function addQuality(label, url, hdrs, height) {
      if (!url || seenQuality[url]) return;
      seenQuality[url] = true;
      merged.push({
        label: label || 'Auto',
        url: url,
        headers: hdrs || primary.headers || {},
        height: height || undefined,
      });
    }
    var hasRealHeights = false;
    qualities.forEach(function (q) {
      if (q && /^\d+p$/.test(String(q.label || ''))) hasRealHeights = true;
    });
    // "Auto" is only honest for a genuinely adaptive master (2+ real heights) or unknown
    // dimensions; a single-verified-height route must report that height, never a bare Auto.
    if (!qualities.length || qualities.length > 1 || !hasRealHeights) {
      addQuality('Auto', primary.url, primary.headers);
    }
    qualities.forEach(function (q) {
      if (q && q.url) addQuality(q.label, q.url, q.headers, q.height);
    });
    if (!merged.length) addQuality('Auto', primary.url, primary.headers);
    var defaultLabel = merged[0].label;
    var streams = [(lang === 'dub' ? 'dub ' : 'sub ') + defaultLabel, primary.url];
    merged.forEach(function (q) {
      streams.push(q.label, q.url);
    });
    var payload = {
      url: primary.url,
      streams: streams,
      headers: primary.headers || {},
      streamType: 'hls',
      lang: lang,
      quality: defaultLabel,
      defaultQuality: defaultLabel,
      qualities: merged,
      subtitles: primary.subtitles || [],
      servers: servers,
    };
    if (primary.intro) {
      payload.intro = primary.intro;
      payload.introStartSeconds = primary.intro.start;
      payload.introEndSeconds = primary.intro.end;
    }
    if (primary.outro) {
      payload.outro = primary.outro;
      payload.outroStartSeconds = primary.outro.start;
      payload.outroEndSeconds = primary.outro.end;
    }
    return payload;
  }

  /* Season-aware ordering (owner report: searching a show name must surface every season).
   * AniList's SEARCH_MATCH ranking interleaves seasons with movies/OVAs/specials, so on a
   * phone the first screenful can hide Season 2+ and users resort to typing "Season N"
   * explicitly. Group season/part variants of the same series next to their best-matching
   * entry and order them naturally (base, Cour/Part, Season 2, Season 3, ... then
   * movies/OVAs/specials); unrelated results keep AniList's relevance order. */
  function coreTitleOf(title) {
    var t = String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    t = t
      .replace(/\b(?:the\s+)?final\s+season\b.*$/, ' ')
      .replace(/\b\d+(?:st|nd|rd|th)\s+season\b.*$/, ' ')
      .replace(/\bseason\b.*$/, ' ')
      .replace(/\bcour\b.*$/, ' ')
      .replace(/\bpart\b.*$/, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  function seasonNumberOf(title) {
    var t = String(title || '').toLowerCase();
    if (/\bfinal\s+season\b/.test(t)) return 99;
    var m = t.match(/\bseason\s*(\d+)/) || t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
    return m ? parseInt(m[1], 10) : 1;
  }

  function partNumberOf(title) {
    var t = String(title || '').toLowerCase();
    var m = t.match(/\bpart\s*(\d+)/) || t.match(/\bcour\s*(\d+)/);
    return m ? Math.max(parseInt(m[1], 10) - 1, 0) : 0;
  }

  function isSpecialCard(card) {
    var f = String((card && card.format) || '').toUpperCase();
    if (f === 'MOVIE' || f === 'SPECIAL' || f === 'MUSIC') return true;
    return /\b(ova|special|movie|recap|film)\b/.test(String((card && card.title) || '').toLowerCase());
  }

  function orderSeasons(cards) {
    if (!cards || cards.length < 2) return cards || [];
    var groups = [];
    var index = {};
    for (var i = 0; i < cards.length; i++) {
      var key = coreTitleOf(cards[i].title) || '~' + i;
      if (!index[key]) {
        index[key] = { min: i, items: [] };
        groups.push(index[key]);
      }
      index[key].items.push({ i: i, card: cards[i] });
      if (i < index[key].min) index[key].min = i;
    }
    for (var g = 0; g < groups.length; g++) {
      groups[g].items.sort(function (a, b) {
        var sa = isSpecialCard(a.card) ? 1 : 0;
        var sb = isSpecialCard(b.card) ? 1 : 0;
        if (sa !== sb) return sa - sb;
        if (sa === 0) {
          var na = seasonNumberOf(a.card.title);
          var nb = seasonNumberOf(b.card.title);
          if (na !== nb) return na - nb;
          var pa = partNumberOf(a.card.title);
          var pb = partNumberOf(b.card.title);
          if (pa !== pb) return pa - pb;
        }
        return a.i - b.i;
      });
    }
    groups.sort(function (a, b) {
      return a.min - b.min;
    });
    var out = [];
    for (var g2 = 0; g2 < groups.length; g2++) {
      for (var j = 0; j < groups[g2].items.length; j++) out.push(groups[g2].items[j].card);
    }
    return out;
  }

  async function searchResults(query) {
    var q = clean(query);
    try {
      if (!q) {
        var trending = await anilist(
          'query ($page:Int){ Page(page:$page, perPage:20){ media(type:ANIME, sort:TRENDING_DESC){ ' +
            MEDIA_FIELDS +
            ' } } }',
          { page: 1 },
        );
        return ((trending.Page && trending.Page.media) || []).map(mediaCard).filter(Boolean);
      }
      var data = await anilist(
        'query ($q:String){ Page(page:1, perPage:20){ media(search:$q, type:ANIME, sort:SEARCH_MATCH){ ' +
          MEDIA_FIELDS +
          ' } } }',
        { q: q },
      );
      return orderSeasons(
        ((data.Page && data.Page.media) || []).map(mediaCard).filter(Boolean),
      );
    } catch (error) {
      log('anilist search fallback jikan: ' + (error && error.message ? error.message : error));
      try {
        var path = q
          ? '/anime?q=' + encodeURIComponent(q) + '&limit=20&sfw=true'
          : '/top/anime?limit=20';
        var jk = await jikan(path);
        return orderSeasons((jk.data || []).map(jikanCard).filter(Boolean));
      } catch (err) {
        log('catalogue temporarily unavailable');
        return [];
      }
    }
  }

  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref.anilistId && !ref.malId) {
      var found = await searchResults(urlOrId);
      return found[0]
        ? {
            id: found[0].href,
            href: found[0].href,
            title: found[0].title,
            image: found[0].image,
            description: '',
            malId: found[0].malId,
            anilistId: found[0].anilistId,
          }
        : { title: 'Unavailable', description: '' };
    }
    if (ref.anilistId) {
      try {
        var data = await anilist('query ($id:Int){ Media(id:$id, type:ANIME){ ' + MEDIA_FIELDS + ' } }', {
          id: ref.anilistId,
        });
        var media = data.Media;
        var card = mediaCard(media) || {};
        return {
          id: card.href,
          href: card.href,
          title: card.title,
          name: card.title,
          image: card.image,
          poster: card.image,
          description: clean(media && media.description),
          synopsis: clean(media && media.description),
          genres: (media && media.genres) || [],
          year: media && media.seasonYear,
          status: media && media.status,
          episodes: media && media.episodes,
          anilistId: ref.anilistId,
          malId: media && media.idMal,
        };
      } catch (_) {}
    }
    if (ref.malId) {
      try {
        var jk = await jikan('/anime/' + ref.malId);
        var row = jk.data || {};
        var cardJ = jikanCard(row) || {};
        return {
          id: cardJ.href,
          href: cardJ.href,
          title: cardJ.title,
          name: cardJ.title,
          image: cardJ.image,
          poster: cardJ.image,
          description: clean(row.synopsis),
          synopsis: clean(row.synopsis),
          genres: (row.genres || []).map(function (g) { return g && g.name; }).filter(Boolean),
          year: row.year,
          status: row.status,
          episodes: row.episodes,
          anilistId: 0,
          malId: row.mal_id,
        };
      } catch (_) {}
    }
    return { title: 'Unavailable', description: '', href: urlOrId };
  }

  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref.anilistId && !ref.malId) return [];
    var total = 0;
    var airedLimitKnown = false;
    var episodeCountKnown = false;
    var metadataFailures = [];
    if (ref.anilistId) {
      try {
        var data = await anilist(
          'query ($id:Int){ Media(id:$id, type:ANIME){ id idMal episodes nextAiringEpisode { episode } } }',
          { id: ref.anilistId },
        );
        var media = data.Media || {};
        total = Number(media.episodes) || 0;
        episodeCountKnown = typeof media.episodes === 'number' && isFinite(media.episodes) && media.episodes >= 0;
        var next = media.nextAiringEpisode && Number(media.nextAiringEpisode.episode);
        if (next && next > 0) {
          airedLimitKnown = true;
          if (next === 1) episodeCountKnown = true;
          total = total ? Math.min(total, next - 1) : next - 1;
        }
        if (media.idMal && !ref.malId) ref.malId = media.idMal;
      } catch (error) {
        metadataFailures.push(error && error.message ? error.message : 'AniList lookup failed');
      }
    }
    if (!total && ref.malId && !airedLimitKnown) {
      try {
        var jk = await jikan('/anime/' + ref.malId);
        var jikanEpisodes = jk.data && jk.data.episodes;
        episodeCountKnown = typeof jikanEpisodes === 'number' && isFinite(jikanEpisodes) && jikanEpisodes >= 0;
        total = Number(jikanEpisodes) || 0;
      } catch (error) {
        metadataFailures.push(error && error.message ? error.message : 'Jikan lookup failed');
      }
    }
    if (!total) {
      if (!episodeCountKnown && metadataFailures.length) {
        throw new Error('Episode metadata temporarily unavailable. Retry this lookup. ' + metadataFailures.join('; '));
      }
      return [];
    }
    var out = [];
    var i;
    for (i = 1; i <= total && i <= 2000; i += 1) {
      out.push({
        id: episodeHref(ref, i),
        href: episodeHref(ref, i),
        number: i,
        episodeNumber: i,
        title: 'Episode ' + i,
        subAvailable: true,
      });
    }
    return out;
  }

  async function extractStreamUrl(episodeHref, lang) {
    var want = String(lang || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub';
    var ref = parseRef(episodeHref);
    if ((!ref.anilistId && !ref.malId) || !ref.episode) {
      return { streams: [], subtitles: [], error: { message: 'Invalid Synthetiq Anime episode.' } };
    }
    var extras = [];
    var primary = null;
    // The AniKage rescue starts in parallel with the primary chain and is halted the moment
    // the primary serves a verified route. A provider outage then costs ONE wait (not the
    // sum of both chains), and a slow app-bridge request can never strand a verified route.
    var rescueHalt = { closed: false, result: null, done: false };
    rescueAnikageRoutes(ref, want, rescueHalt).catch(function (error) {
      log('rescue skip ' + (error && error.message ? error.message : error));
      return null;
    });
    try {
      var servers = await raceCap(resolveVidhawkPair(ref.anilistId || 0, ref.malId || 0, ref.episode, want), 10000);
      if (!servers || servers.capped) servers = [];
      primary = servers[0] || null;
      extras = servers.slice(1);
    } catch (error) {
      log('vidhawk failed ' + (error && error.message ? error.message : error));
    }
    if (primary) {
      rescueHalt.closed = true;
    } else {
      log('rescue engage');
      // Poll the rescue result fields — the app JS engine does not reliably run reactions
      // chained onto an already-settled promise, so a promise await can starve here.
      var rescueWaited = 0;
      while (!rescueHalt.done && rescueWaited < 11000) {
        await rescueSleep(300);
        rescueWaited += 300;
      }
      var rescued = rescueHalt.result || null;
      if (rescued && rescued.length) {
        primary = rescued[0];
        extras = rescued.slice(1);
      }
    }
    return packStream(primary, extras, want);
  }

  async function discoveryHome() {
    try {
      var data = await anilist(
        'query { trending: Page(page:1, perPage:16){ media(type:ANIME, sort:TRENDING_DESC){ ' +
          MEDIA_FIELDS +
          ' } } popular: Page(page:1, perPage:16){ media(type:ANIME, sort:POPULARITY_DESC){ ' +
          MEDIA_FIELDS +
          ' } } }',
      );
      var trending = ((data.trending && data.trending.media) || []).map(mediaCard).filter(Boolean);
      var popular = ((data.popular && data.popular.media) || []).map(mediaCard).filter(Boolean);
      return {
        sections: [
          { id: 'sa-trending', title: 'Trending', style: 'hero', items: trending.slice(0, 8), viewAll: { mode: 'feed', feedId: 'trending' } },
          { id: 'sa-popular', title: 'Popular', style: 'poster', items: popular, viewAll: { mode: 'feed', feedId: 'popular' } },
        ],
      };
    } catch (error) {
      try {
        var jk = await jikan('/top/anime?limit=16');
        var items = (jk.data || []).map(jikanCard).filter(Boolean);
        return {
          sections: [{ id: 'sa-popular', title: 'Popular', style: 'poster', items: items, viewAll: { mode: 'feed', feedId: 'jikan-popular' } }],
        };
      } catch (_) {
        return { sections: [] };
      }
    }
  }

  async function discoveryFeed(feedId, page) {
    var pageNumber = Math.max(1, Number(page) || 1);
    if (feedId === 'jikan-popular') {
      var jk = await jikan('/top/anime?limit=20&page=' + pageNumber);
      return { page: pageNumber, items: (jk.data || []).map(jikanCard).filter(Boolean), hasMore: Boolean(jk.pagination && jk.pagination.has_next_page) };
    }
    var sort = String(feedId || '').indexOf('popular') >= 0 ? 'POPULARITY_DESC' : 'TRENDING_DESC';
    try {
      var data = await anilist(
        'query ($page:Int, $sort:[MediaSort]){ Page(page:$page, perPage:20){ pageInfo { hasNextPage } media(type:ANIME, sort:$sort){ ' +
          MEDIA_FIELDS +
          ' } } }',
        { page: pageNumber, sort: [sort] },
      );
      var items = ((data.Page && data.Page.media) || []).map(mediaCard).filter(Boolean);
      return { feedId: feedId || 'trending', page: pageNumber, items: items, hasMore: Boolean(data.Page && data.Page.pageInfo && data.Page.pageInfo.hasNextPage) };
    } catch (error) {
      throw new Error('Catalogue page temporarily unavailable. Retry this page.');
    }
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
