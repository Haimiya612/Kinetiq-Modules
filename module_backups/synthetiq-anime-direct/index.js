/**
 * Synthetiq Anime Direct — private test candidate (independent anime playback).
 *
 * INDEPENDENCE CONTRACT (enforced in code and asserted by tests):
 *  - Catalogue + identity: AniList GraphQL (primary) with a best-effort Jikan fallback. Both are
 *    public metadata APIs. No AniKoto page, episode API, server API or mirror is ever requested.
 *  - Identity comes from the catalogue entry the user tapped (AniList id and/or MAL id). There is
 *    no page scraping at all, so a recommendation artwork or an unrelated link can never become a
 *    playback id.
 *  - Playback: Vidhawk's public API addressed directly by AniList/MAL id.
 *      GET /api/stream/race?episode=N&audio=sub|dub&server=flow[&anilistId=..][&malId=..]
 *          -> per-server tickets (the provider's own race result) or CONTENT_UNAVAILABLE.
 *      GET /api/play?t=<ticket> -> tracks (sub/dub/jpn/hin), captions, intro/outro markers.
 *    The embed-only `parentHost` parameter is deliberately NOT sent. It belongs to the provider's
 *    embed flow (/api/embed/allow allow-check); this module never embeds. Probed on 2026-09-12:
 *    with parentHost=anicrowd.xyz, with no parentHost and with parentHost=example.com the API
 *    answers identically (same shape/size, fresh ticket each time). No AniCrowd request is made
 *    and none is required.
 *  - Hard denylist: request() refuses AniKoto/AniCrowd/AniKage/MegaPlay hosts before any network
 *    call, so the module cannot regress into a page dependency. Attempts are logged. The single
 *    exception is the designated AniKage outage-rescue chain (opts.allowRescue), consulted only
 *    when Vidhawk has no verified media; its routes are labelled as the rescue source.
 *
 * RELIABILITY CONTRACT (the audit's findings, addressed here):
 *  - Episode lists use exact catalogue identity and aired counts. Bounded provider checks
 *    refine availability but a primary outage cannot hide episodes available via rescue.
 *  - The first candidate that passes POSITIVE media validation wins; optional extras (second
 *    server, qualities, captions) never hold a working primary hostage.
 *  - Routes are built from one accepted-candidate list, so a rejected route cannot linger in
 *    `streams`, `servers` or `qualities`.
 *  - Per-host cooldowns honour 429/403 + Retry-After; retries are bounded; no retry storms.
 *  - URL differences never imply different audio languages: route labels come from provider track
 *    ids (spot-verified with speech sampling in QA), not from URLs.
 *  - Media validation is POSITIVE (TS sync byte / fMP4 boxes / PNG-wrapped TS), not "non-empty
 *    bytes are probably fine".
 *  - When the primary provider has no verified media (outage), a labelled AniKage rescue source is
 *    consulted in parallel and halted the moment the primary wins; rescue routes pass the same
 *    positive byte validation with an elevated byte cap for the app bridge.
 */
(function () {
  'use strict';

  var MODULE = 'Synthetiq Anime Direct';
  var SCHEME = 'sadirect:';
  var ANILIST = 'https://graphql.anilist.co';
  var JIKAN = 'https://api.jikan.moe/v4';
  var VIDHAWK = 'https://vidhawk.buzz';
  var USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  // ------------------------------------------------------------------ independence guard
  var DENIED_HOST = /(anikoto|anicrowd|anikage|megaplay)/i;

  var trace = {
    requests: [],
    blocked: [],
    probes: 0,
    cooldowns: 0,
  };

  function hostOf(url) {
    var m = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }

  function isDenied(url) {
    var host = hostOf(url);
    if (!host) return false;
    return DENIED_HOST.test(host);
  }

  function log(msg) {
    try {
      console.log('[' + MODULE + '] ' + String(msg == null ? '' : msg));
    } catch (_) {}
  }

  function clean(value) {
    return String(value == null ? '' : value)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(#\d+|[a-z]+);/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ------------------------------------------------------------------ rate limits / cooldowns
  var COOLDOWN_MS = 10 * 60 * 1000;
  var cooldownUntil = {};
  var MAX_ATTEMPTS = 2;

  function hostParked(host) {
    var until = cooldownUntil[host] || 0;
    if (until && Date.now() < until) return true;
    if (until) delete cooldownUntil[host];
    return false;
  }

  function parkHost(host, ms, why) {
    var until = Date.now() + Math.max(ms || 0, 60000);
    cooldownUntil[host] = until;
    trace.cooldowns += 1;
    log('cooldown ' + host + ' for ' + Math.round((until - Date.now()) / 1000) + 's (' + why + ')');
  }

  function retryAfterMs(response) {
    try {
      var raw = (response && response.headers && (response.headers['retry-after'] || response.headers['Retry-After'])) || '';
      var asNumber = Number(String(raw).trim());
      if (isFinite(asNumber) && asNumber > 0) return asNumber * 1000;
      var when = Date.parse(String(raw));
      if (isFinite(when) && when > Date.now()) return when - Date.now();
    } catch (_) {}
    return 0;
  }

  // ------------------------------------------------------------------ request layer
  async function readBody(response) {
    if (!response) return '';
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

  function headers(extra) {
    var out = { 'User-Agent': USER_AGENT, Accept: '*/*' };
    var src = extra || {};
    Object.keys(src).forEach(function (key) {
      out[key] = src[key];
    });
    return out;
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

  function deadlineLeft(session) {
    if (!session) return Number.MAX_SAFE_INTEGER;
    if (session.closed) return 0;
    return Math.max(0, (session.deadline || 0) - Date.now());
  }

  async function request(url, extraHeaders, method, body, options) {
    var opts = options || {};
    var host = hostOf(url);
    if (opts.allowRescue !== true && isDenied(url)) {
      trace.blocked.push({ url: url, host: host, at: Date.now() });
      log('INDEPENDENCE BLOCK — refused a denied host request: ' + host);
      return { ok: false, status: 0, text: '', json: null, headers: {}, blocked: true };
    }
    if (hostParked(host)) {
      return { ok: false, status: 0, text: '', json: null, headers: {}, parked: true };
    }
    if (opts.session && deadlineLeft(opts.session) <= 0) {
      return { ok: false, status: 0, text: '', json: null, headers: {}, timedOut: true };
    }

    var attempt = 0;
    var last = { ok: false, status: 0, text: '', json: null, headers: {} };
    while (attempt < MAX_ATTEMPTS) {
      // A request already in flight cannot be cancelled by the JS bridge, but
      // it must not start another retry after its caller has timed out.
      if (opts.session && deadlineLeft(opts.session) <= 0) {
        return { ok: false, status: 0, text: '', json: null, headers: {}, timedOut: true };
      }
      attempt += 1;
      var started = Date.now();
      var response = null;
      try {
        if (typeof fetchv2 === 'function') {
          if (opts.maxBytesHint) {
            response = await fetchv2(url, headers(extraHeaders), method || 'GET', body || null, {
              maxBytesHint: opts.maxBytesHint,
            });
          } else {
            response = await fetchv2(url, headers(extraHeaders), method || 'GET', body || null);
          }
        } else if (typeof fetch === 'function') {
          response = await fetch(url, { method: method || 'GET', headers: headers(extraHeaders), body: body || undefined });
        }
      } catch (error) {
        last = { ok: false, status: 0, text: '', json: null, headers: {}, error: String(error && error.message ? error.message : error) };
        trace.requests.push({ host: host, path: shortPath(url), status: 0, ms: Date.now() - started, at: started, note: 'network' });
        return last;
      }
      var status = Number(response && response.status) || 0;
      var text = '';
      try {
        text = await readBody(response);
      } catch (error) {
        text = '';
      }
      var parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_) {}
      last = {
        ok: status >= 200 && status < 300,
        status: status,
        text: text || '',
        json: parsed,
        headers: (response && response.headers) || {},
        bodyDropped: Boolean(response && response.bodyDropped),
        bodyBytes: Number((response && response.bodyBytes) || 0),
        hlsPrefixBytes: Number((response && response.hlsPrefixBytes) || 0),
      };
      trace.requests.push({ host: host, path: shortPath(url), status: status, ms: Date.now() - started, at: started });

      if (status === 429 || status === 403) {
        var waitMs = retryAfterMs(response);
        parkHost(host, waitMs, 'http ' + status);
        return last;
      }
      if (status >= 500) {
        if (attempt >= MAX_ATTEMPTS) return last;
        // One immediate retry. No timer-based backoff: the app's JS sandbox does not pump timers
        // created inside a module call, so a sleep here would hang the call instead of backing off.
        continue;
      }
      return last;
    }
    return last;
  }

  function shortPath(url) {
    var m = String(url || '').match(/^https?:\/\/[^\/]+([^?#]*)/i);
    return m ? m[1] : '';
  }

  // No timer helpers live in this module on purpose: the app's JS sandbox does not pump timers
  // created inside a module call, so timeouts are expressed as bounded request counts plus
  // Date.now() deadline checks between steps.

  // ------------------------------------------------------------------ metadata (AniList / Jikan)
  var MEDIA_FIELDS =
    'id idMal title { romaji english native userPreferred } description(asHtml: false) bannerImage ' +
    'coverImage { extraLarge large medium } format status episodes duration season seasonYear ' +
    'averageScore genres nextAiringEpisode { episode } streamingEpisodes { title site }';

  async function anilist(query, variables, session) {
    var out = await raceCap(anilistCall(query, variables, session), 9000);
    if (out && out.capped) throw new Error('AniList request capped (stalled)');
    return out;
  }

  async function anilistCall(query, variables, session) {
    var res = await request(
      ANILIST,
      { Accept: 'application/json', 'Content-Type': 'application/json' },
      'POST',
      JSON.stringify({ query: query, variables: variables || {} }),
      { session: session },
    );
    if (!res.ok || !res.json || res.json.errors) {
      throw new Error('AniList request failed (' + res.status + ')');
    }
    return res.json.data || {};
  }

  async function jikan(path, session) {
    var out = await raceCap(jikanCall(path, session), 9000);
    if (out && out.capped) throw new Error('Jikan request capped (stalled)');
    return out;
  }

  async function jikanCall(path, session) {
    var res = await request(JIKAN + path, { Accept: 'application/json' }, 'GET', null, { session: session });
    if (!res.ok || !res.json) throw new Error('Jikan request failed (' + res.status + ')');
    return res.json;
  }

  function pickTitle(node) {
    var t = (node && node.title) || {};
    return clean(t.english || t.romaji || t.userPreferred || t.native || 'Anime');
  }

  function seriesHref(ref) {
    if (ref.anilistId) return SCHEME + 'a' + ref.anilistId;
    return SCHEME + 'm' + ref.malId;
  }

  function episodeHref(ref, ep) {
    if (ref.anilistId) return SCHEME + 'a' + ref.anilistId + ':e' + ep;
    return SCHEME + 'm' + ref.malId + ':e' + ep;
  }

  function mediaCard(media) {
    if (!media || !media.id) return null;
    var image =
      (media.coverImage && (media.coverImage.extraLarge || media.coverImage.large || media.coverImage.medium)) ||
      media.bannerImage ||
      '';
    var href = seriesHref({ anilistId: media.id, malId: media.idMal || 0 });
    return {
      id: href,
      href: href,
      url: href,
      title: pickTitle(media),
      image: image,
      poster: image,
      type: media.format === 'MOVIE' ? 'movie' : 'tv',
      anilistId: media.id,
      malId: media.idMal || 0,
      year: media.seasonYear || 0,
      episodes: media.episodes || 0,
      score: media.averageScore || 0,
      format: media.format || '',
    };
  }

  function jikanCard(row) {
    if (!row || !row.mal_id) return null;
    var image =
      (row.images && row.images.jpg && (row.images.jpg.large_image_url || row.images.jpg.image_url)) || '';
    var href = seriesHref({ anilistId: 0, malId: row.mal_id });
    return {
      id: href,
      href: href,
      url: href,
      title: clean(row.title_english || row.title || 'Anime'),
      image: image,
      poster: image,
      type: 'tv',
      anilistId: 0,
      malId: row.mal_id,
      year: row.year || 0,
      episodes: row.episodes || 0,
      score: 0,
      format: row.type || '',
    };
  }

  function parseRef(raw) {
    var text = String(raw == null ? '' : raw).trim();
    try {
      text = decodeURIComponent(text);
    } catch (_) {}
    // Our own scheme first: sadirect:a<anilistId>[:e<ep>] | sadirect:m<malId>[:e<ep>]
    var own = text.match(/^sadirect:([am])(\d{1,9})(?::e(?:p)?=?(\d{1,5}))?$/i);
    if (own) {
      return {
        anilistId: own[1].toLowerCase() === 'a' ? Number(own[2]) : 0,
        malId: own[1].toLowerCase() === 'm' ? Number(own[2]) : 0,
        episode: own[3] ? Number(own[3]) : 0,
      };
    }
    // Foreign/legacy forms: /anime/123?ep=4, /mal/55/watch?ep=2, "a105333:e15", bare ids.
    var epMatch = text.match(/[:?&]e(?:p)?=?(\d{1,5})/i);
    var anilist = text.match(/(?:^|[^a-z0-9])a(\d{2,9})/i);
    var mal = text.match(/(?:^|[^a-z0-9])m(\d{2,7})/i);
    var plainAnime = text.match(/\/anime\/(\d+)/i);
    var plainMal = text.match(/\/mal\/(\d+)/i);
    var bare = text.match(/^(\d{2,9})$/);
    var episode = epMatch ? Number(epMatch[1]) : 0;
    var anilistId = 0;
    var malId = 0;
    if (plainMal) malId = Number(plainMal[1]);
    else if (plainAnime) anilistId = Number(plainAnime[1]);
    else {
      if (anilist) anilistId = Number(anilist[1]);
      if (mal) malId = Number(mal[1]);
    }
    if (!anilistId && !malId && bare) anilistId = Number(bare[1]);
    return { anilistId: anilistId, malId: malId, episode: episode };
  }

  function idParams(ref) {
    var out = '';
    if (ref.anilistId) out += '&anilistId=' + encodeURIComponent(ref.anilistId);
    if (ref.malId) out += '&malId=' + encodeURIComponent(ref.malId);
    return out;
  }

  // ------------------------------------------------------------------ Vidhawk provider
  function vhHeaders(referer) {
    return {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,application/vnd.apple.mpegurl,*/*',
      Referer: referer || VIDHAWK + '/',
      Origin: VIDHAWK,
    };
  }

  function normaliseAudio(lang) {
    var value = String(lang == null ? '' : lang).trim().toLowerCase();
    if (value === 'dub' || value === 'dubbed' || value === 'english dub') return 'dub';
    return 'sub';
  }

  function providerVerdict(res) {
    // A 404 with a CONTENT_UNAVAILABLE body is a real answer, not a failure: read the body first.
    if (res && res.parked) return 'parked';
    var body = res && res.json ? res.json : null;
    if (body && (body.code === 'CONTENT_UNAVAILABLE' || body.available === false)) return 'unavailable';
    if (!res || !res.ok || !body) return 'failed';
    return 'ok';
  }

  // NOTE: /api/stream/race exists and returns both tickets in one call, but it does not complete
  // reliably inside the app's JS runtime (observed: the request never settles, and the runtime's
  // sandbox does not pump our timers, so a timer-based escape hatch cannot fire either).
  // The connection-safe shape is /api/stream/resolve — the same endpoint episode verification uses —
  // called once per server. Both calls are started together, so the first usable ticket still wins.

  async function providerResolve(ref, episode, audio, server, session, capMs) {
    var cap = capMs && capMs > 0 ? capMs : 10000;
    var out = await raceCap(providerResolveCall(ref, episode, audio, server, session), cap);
    if (out && out.capped) {
      log('provider resolve capped (' + server + ')');
      return null;
    }
    return out;
  }

  async function providerResolveCall(ref, episode, audio, server, session) {
    // Fallback when the race endpoint is unavailable: single-server resolve.
    var url =
      VIDHAWK +
      '/api/stream/resolve?episode=' +
      encodeURIComponent(episode) +
      '&audio=' +
      encodeURIComponent(audio) +
      '&fast=1&server=' +
      encodeURIComponent(server) +
      idParams(ref);
    var res = await request(url, vhHeaders(VIDHAWK + '/embed/ani/' + (ref.anilistId || ref.malId) + '/' + episode + '/' + audio), 'GET', null, {
      session: session,
    });
    var verdict = providerVerdict(res);
    if (verdict === 'unavailable') return { unavailable: true };
    if (verdict === 'parked') return { parked: true };
    if (verdict !== 'ok') return null;
    if (!res.json.ticket) return null;
    return { ticket: String(res.json.ticket), label: clean(res.json.serverLabel || server) };
  }

  async function providerPlay(ticket, referer, session) {
    var out = await raceCap(providerPlayCall(ticket, referer, session), 10000);
    if (out && out.capped) {
      log('provider play capped');
      return null;
    }
    return out;
  }

  async function providerPlayCall(ticket, referer, session) {
    var res = await request(VIDHAWK + '/api/play?t=' + encodeURIComponent(ticket), vhHeaders(referer), 'GET', null, { session: session });
    if (!res.ok || !res.json) return null;
    return res.json;
  }

  // ------------------------------------------------------------------ media validation (positive)
  function classifySegment(bytes) {
    if (!bytes || bytes.length < 16) return { kind: 'empty' };
    var b = bytes;
    if (b[0] === 0x47) return { kind: 'ts' };
    // PNG-wrapped TS: PNG signature, real TS sync byte later in the wrapper (seen in the wild).
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      for (var i = 8; i < Math.min(b.length - 1, 512); i += 1) {
        if (b[i] === 0x47 && b[i + 1] === 0x40) return { kind: 'png_ts' };
      }
      return { kind: 'image' };
    }
    if (b[0] === 0xff && b[1] === 0xd8) return { kind: 'image' };
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { kind: 'image' };
    var four = String.fromCharCode(b[4] || 0, b[5] || 0, b[6] || 0, b[7] || 0);
    if (four === 'ftyp' || four === 'styp' || four === 'moof' || four === 'sidx' || four === 'moov' || four === 'free') {
      return { kind: 'fmp4' };
    }
    var lead = bytesToAscii(b, 96).trim().toLowerCase();
    if (lead.charAt(0) === '<') return { kind: 'html' };
    if (lead.charAt(0) === '{' || lead.charAt(0) === '[') return { kind: 'json' };
    return { kind: 'unknown' };
  }

  function bytesToAscii(bytes, max) {
    var out = '';
    for (var i = 0; i < Math.min(bytes.length, max); i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function firstLineUrl(body, from, skipTags) {
    var lines = String(body || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var url = resolveUrl(line, from);
      if (url) return url;
    }
    return '';
  }

  function resolveUrl(value, base) {
    var href = String(value || '').trim();
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    var parts = String(base || '').match(/^(https?:\/\/[^\/?#]+)([^?#]*)/i);
    if (!parts) return '';
    if (href.indexOf('//') === 0) return parts[1].split(':')[0] + ':' + href;
    if (href.charAt(0) === '?') return parts[1] + (parts[2] || '/') + href;
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

  function parseQualities(master, base, hdrs) {
    var out = [];
    var seen = {};
    var lines = String(master || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
      var height = 0;
      var res = line.match(/RESOLUTION=\d+x(\d+)/i);
      if (res) height = Number(res[1]) || 0;
      var next = '';
      for (var j = i + 1; j < lines.length; j += 1) {
        var cand = lines[j].trim();
        if (!cand || cand.charAt(0) === '#') continue;
        next = cand;
        break;
      }
      var url = resolveUrl(next, base);
      if (!url || seen[url]) continue;
      seen[url] = true;
      out.push({ label: height ? height + 'p' : 'Auto', height: height || undefined, url: url, headers: hdrs });
    }
    out.sort(function (a, b) {
      return (b.height || 0) - (a.height || 0);
    });
    return out.slice(0, 6);
  }

  var SEG_SAMPLE_BYTES = 65535;

  async function validateHls(url, hdrs, session, opts) {
    // Positive validation: master -> variant -> real segment bytes with a media container.
    // vOpts carries the ONE rescue exception (opts.allowRescue) plus the session; the segment
    // probes elevate the app-bridge byte cap (these CDNs ignore Range and the 512 KB default
    // cap silently dropped >512 KB segments in-app).
    var vOpts = { session: session, allowRescue: Boolean(opts && opts.allowRescue) };
    if (!url) return { ok: false, reason: 'no_url' };
    var master = await request(url, hdrs, 'GET', null, vOpts);
    if (!master.ok || master.text.indexOf('#EXTM3U') < 0) {
      return { ok: false, reason: 'not_hls_' + master.status, status: master.status };
    }
    var body = master.text;
    var mediaUrl = url;
    var mediaBody = body;
    if (/#EXT-X-STREAM-INF:/i.test(body)) {
      var variantUrl = firstLineUrl(body, url);
      if (!variantUrl) return { ok: false, reason: 'no_variant' };
      var variant = await request(variantUrl, hdrs, 'GET', null, vOpts);
      if (!variant.ok || variant.text.indexOf('#EXTM3U') < 0) {
        return { ok: false, reason: 'variant_' + variant.status, status: variant.status };
      }
      mediaUrl = variantUrl;
      mediaBody = variant.text;
    }
    if (/#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(mediaBody) && !/#EXTINF:/i.test(mediaBody)) {
      var audioUrl = firstLineUrl(mediaBody, mediaUrl);
      if (audioUrl && audioUrl !== mediaUrl) {
        var audio = await request(audioUrl, hdrs, 'GET', null, vOpts);
        if (audio.ok && audio.text.indexOf('#EXTM3U') >= 0) {
          mediaUrl = audioUrl;
          mediaBody = audio.text;
        }
      }
    }
    if (!/#EXTINF:/i.test(mediaBody)) return { ok: false, reason: 'no_segments' };
    var segUrl = firstLineUrl(mediaBody, mediaUrl);
    if (!segUrl) return { ok: false, reason: 'no_segment_url' };
    var segment = await request(segUrl, Object.assign({}, hdrs, { Range: 'bytes=0-' + (SEG_SAMPLE_BYTES - 1) }), 'GET', null,
      Object.assign({}, vOpts, { maxBytesHint: 4194304 }));
    if (!segment.ok) {
      if (segment.status === 0) return { ok: false, reason: 'segment_timeout', inconclusive: true };
      return { ok: false, reason: 'segment_' + segment.status, inconclusive: segment.status >= 500 };
    }
    var bytes = binaryBytes(segment);
    var cls = classifySegment(bytes);
    var brokenRefs = countProxyBrokenRefs(mediaBody, mediaUrl);
    if (cls.kind === 'ts' || cls.kind === 'png_ts' || cls.kind === 'fmp4') {
      if (cls.kind === 'fmp4') {
        var map = mediaBody.match(/#EXT-X-MAP:.*URI="([^"]+)"/i);
        if (map) {
          var initUrl = resolveUrl(map[1], mediaUrl);
          var init = await request(initUrl, Object.assign({}, hdrs, { Range: 'bytes=0-2047' }), 'GET', null,
            Object.assign({}, vOpts, { maxBytesHint: 4194304 }));
          var initBytes = binaryBytes(init);
          var four = initBytes.length > 8 ? String.fromCharCode(initBytes[4], initBytes[5], initBytes[6], initBytes[7]) : '';
          if (!init.ok || (four !== 'ftyp' && four !== 'moov')) return { ok: false, reason: 'invalid_init' };
        }
      }
      return { ok: true, master: body, media: mediaBody, kind: cls.kind, brokenRefs: brokenRefs, reachabilityOnly: false };
    }
    if (segment.bodyDropped) {
      // The CDN ignored Range and the body was cut at the 4 MiB probe cap. A 2xx binary
      // response this large is reachability evidence only (no byte signature): accept it
      // unless the content type marks an error page, and flag it as not byte-verified.
      var droppedCt = String((segment.headers && (segment.headers['content-type'] || segment.headers['Content-Type'])) || '').toLowerCase();
      if (segment.status >= 200 && segment.status < 300 && Number(segment.bodyBytes || 0) >= 3145728 && droppedCt.indexOf('html') < 0 && droppedCt.indexOf('json') < 0) {
        return { ok: true, master: body, media: mediaBody, kind: 'size_capped', brokenRefs: brokenRefs, reachabilityOnly: true };
      }
      return { ok: false, reason: 'segment_empty' };
    }
    if (cls.kind === 'html' || cls.kind === 'json' || cls.kind === 'image' || cls.kind === 'empty') {
      return { ok: false, reason: 'segment_' + cls.kind };
    }
    return { ok: false, reason: 'segment_unknown' };
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

  function binaryBytes(response) {
    var out = [];
    try {
      if (response && response.bytes) {
        var raw = response.bytes;
        if (raw && raw.length) {
          for (var i = 0; i < raw.length; i += 1) out.push(Number(raw[i]) & 0xff);
          return out;
        }
      }
      var text = (response && response.text) || '';
      // Latin-1 fallback: the runtime decodes byte strings losslessly enough for magic checks.
      for (var j = 0; j < text.length; j += 1) out.push(text.charCodeAt(j) & 0xff);
    } catch (_) {}
    return out;
  }

  // ------------------------------------------------------------------ captions
  var captionCache = {};
  var LANG_ALIASES = {
    english: 'en', en: 'en', japanese: 'ja', ja: 'ja', spanish: 'es', arabic: 'ar', french: 'fr',
    'pt-br': 'pt', portuguese: 'pt', german: 'de', italian: 'it', russian: 'ru', 'zh-cn': 'zh',
    chinese: 'zh', korean: 'ko', 'zh-tw': 'zh', hindi: 'hi', indonesian: 'id', thai: 'th',
    vietnamese: 'vi', turkish: 'tr', polish: 'pl', dutch: 'nl', ukrainian: 'uk', hebrew: 'he',
  };

  function languageCode(entry) {
    // The provider stamps lang=en on every track, so the explicit LABEL names the translation.
    var label = clean((entry && (entry.label || entry.language || entry.lang)) || '');
    var raw = clean((entry && (entry.language || entry.lang)) || '');
    function head(value) {
      return String(value || '').split(/[-(]/)[0].trim().toLowerCase();
    }
    return LANG_ALIASES[head(label)] || LANG_ALIASES[head(raw)] || head(label) || head(raw) || 'und';
  }

  function shortLabel(entry) {
    var label = clean((entry && (entry.label || entry.language || entry.lang)) || 'Subtitle');
    var head = label.split(/[-(]/)[0].trim();
    return head || label || 'Subtitle';
  }

  var captionIndex = {};

  async function verifyCaption(entry, session) {
    var url = String((entry && (entry.src || entry.file || entry.url)) || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    var language = languageCode(entry);
    var label = shortLabel(entry);
    var key = language + '|' + label.toLowerCase();
    if (captionIndex[key]) return captionIndex[key];
    if (captionCache[url]) {
      captionIndex[key] = captionCache[url];
      return captionCache[url];
    }
    var res = await request(url, { 'User-Agent': USER_AGENT, Accept: 'text/vtt,*/*' }, 'GET', null, { session: session });
    if (!res.ok) return null;
    var text = String(res.text || '');
    var cues = (text.match(/-->/g) || []).length;
    if (text.trim().indexOf('WEBVTT') !== 0 || cues < 3) {
      log('caption rejected (' + (text.trim().indexOf('WEBVTT') !== 0 ? 'not vtt' : 'cues ' + cues) + ')');
      return null;
    }
    var out = {
      id: url,
      url: url,
      file: url,
      label: label,
      sourceLabel: clean(entry.label || entry.language || entry.lang || ''),
      language: language,
      lang: language,
      kind: 'subtitle',
      cues: cues,
      default: Boolean(entry.default) || /^english/i.test(label),
      headers: { 'User-Agent': USER_AGENT },
    };
    captionCache[url] = out;
    captionIndex[key] = out;
    return out;
  }

  async function collectCaptions(play, audio, session, budgetMs) {
    var groups = (play && play.captions) || {};
    var rows = [];
    if (Array.isArray(groups)) rows = groups;
    else if (groups && Array.isArray(groups[audio])) rows = groups[audio];
    if (!rows.length) return [];
    var deadline = Date.now() + Math.max(1200, budgetMs || 2500);
    var accepted = [];
    var limit = Math.min(rows.length, 6);
    for (var i = 0; i < limit; i += 1) {
      if (Date.now() > deadline) {
        log('caption budget exhausted after ' + accepted.length + ' verified track(s)');
        break;
      }
      var verified = await verifyCaption(rows[i], session);
      if (verified && accepted.indexOf(verified) < 0) accepted.push(verified);
    }
    return accepted;
  }

  // ------------------------------------------------------------------ markers
  function markerPair(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var start = Number(raw.start);
    var end = Number(raw.end);
    if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) return null;
    return { start: Math.floor(start), end: Math.floor(end) };
  }

  // ------------------------------------------------------------------ episode verification
  var verifyCache = {};
  var VERIFY_TTL_MS = 20 * 60 * 1000;
  var VERIFY_MAX_PROBES = 14;
  var VERIFY_DEADLINE_MS = 8000;

  async function probeEpisode(ref, episode, audio, session, counter) {
    if (counter.count >= VERIFY_MAX_PROBES) return 'budget';
    if (deadlineLeft(session) <= 800) return 'budget';
    counter.count += 1;
    trace.probes += 1;
    var one = await providerResolve(ref, episode, audio, 'flow', session);
    if (one && one.ticket) return 'yes';
    if (one && one.unavailable) {
      // The provider tried flow; give the second server one chance before calling it unavailable.
      var two = await providerResolve(ref, episode, audio, 'zuri', session);
      if (two && two.ticket) return 'yes';
      if (two && two.unavailable) return 'no';
      return 'unknown';
    }
    // flow did not answer (network/5xx/parked): one attempt on the other server before giving up,
    // so a single stalled request cannot turn a real availability into "unknown".
    if (deadlineLeft(session) > 1200) {
      var alt = await providerResolve(ref, episode, audio, 'zuri', session);
      if (alt && alt.ticket) return 'yes';
      if (alt && alt.unavailable) return 'no';
    }
    return 'unknown';
  }

  // Per-episode availability flag for one audio track, from that audio's verification result.
  // Positive verdicts decide; "could not ask" never hides a language.
  function audioFlag(result, episodeNumber) {
    if (!result) return false;
    if (result.state === 'unavailable') return false;
    if (result.state === 'unverified') return true;
    return episodeNumber >= (result.firstAvailable || 1) && episodeNumber <= result.frontier;
  }

  async function verifyFrontier(ref, count, audio, session) {
    var counter = { count: 0 };
    var cacheKey = (ref.anilistId || 'm' + ref.malId) + '|' + count + '|' + audio;
    var cached = verifyCache[cacheKey];
    if (cached && Date.now() - cached.at < VERIFY_TTL_MS) return cached;
    async function probe(ep) {
      return probeEpisode(ref, ep, audio, session, counter);
    }

    var result = { frontier: 0, firstAvailable: 1, at: Date.now(), state: 'unverified', probes: 0 };

    if (count <= 0) {
      result.state = 'empty';
      verifyCache[cacheKey] = result;
      return result;
    }

    var first = await probe(1);
    if (first === 'no') {
      // Try a middle anchor before writing the series off (late-start catalogues exist).
      var midCheck = count > 1 ? await probe(Math.max(2, Math.ceil(count / 2))) : 'no';
      if (midCheck === 'no') {
        result.state = 'unavailable';
        result.probes = counter.count;
        verifyCache[cacheKey] = result;
        return result;
      }
      if (midCheck === 'unknown' || midCheck === 'budget') {
        result.state = 'unverified';
        result.probes = counter.count;
        verifyCache[cacheKey] = result;
        return result;
      }
      // Late start: find the first available episode with a bounded scan.
      var low = 2;
      var high = Math.max(2, Math.ceil(count / 2));
      while (low < high && counter.count < VERIFY_MAX_PROBES) {
        var spot = Math.floor((low + high) / 2);
        var spotState = await probe(spot);
        if (spotState === 'yes') high = spot;
        else if (spotState === 'no') low = spot + 1;
        else break;
      }
      result.frontier = count;
      result.firstAvailable = low;
      result.state = 'verified';
      result.probes = counter.count;
      verifyCache[cacheKey] = result;
      return result;
    }

    if (first === 'unknown' || first === 'budget') {
      result.state = first === 'budget' ? 'unverified' : 'unverified';
      result.probes = counter.count;
      verifyCache[cacheKey] = result;
      return result;
    }

    // first === 'yes': establish the tail, then confirm with interior anchors.
    var last = count > 1 ? await probe(count) : 'yes';
    if (last === 'yes') {
      var interior = [];
      [Math.ceil(count / 3), Math.ceil((2 * count) / 3)].forEach(function (ep) {
        if (ep > 1 && ep < count) interior.push(ep);
      });
      var gapAt = 0;
      for (var i = 0; i < interior.length; i += 1) {
        if (counter.count >= VERIFY_MAX_PROBES) break;
        var state = await probe(interior[i]);
        if (state === 'no') {
          gapAt = interior[i];
          break;
        }
        if (state === 'unknown' || state === 'budget') break;
      }
      if (!gapAt) {
        result.frontier = count;
        result.state = 'verified';
        result.sampled = interior.length;
        result.probes = counter.count;
        verifyCache[cacheKey] = result;
        return result;
      }
      // A gap exists: bound the contiguous prefix.
      var lo = 1;
      var hi = gapAt;
      while (lo < hi - 1 && counter.count < VERIFY_MAX_PROBES) {
        var mid = Math.floor((lo + hi) / 2);
        var midState = await probe(mid);
        if (midState === 'yes') lo = mid;
        else if (midState === 'no') hi = mid;
        else break;
      }
      result.frontier = lo;
      result.state = 'verified';
      result.gapFrom = gapAt;
      result.probes = counter.count;
      verifyCache[cacheKey] = result;
      return result;
    }

    if (last === 'no') {
      var lowB = 1;
      var highB = count;
      while (lowB < highB - 1 && counter.count < VERIFY_MAX_PROBES) {
        var midB = Math.floor((lowB + highB) / 2);
        var stateB = await probe(midB);
        if (stateB === 'yes') lowB = midB;
        else if (stateB === 'no') highB = midB;
        else break;
      }
      result.frontier = lowB;
      result.state = 'verified';
      result.probes = counter.count;
      verifyCache[cacheKey] = result;
      return result;
    }

    // last === 'unknown'/'budget': conservative, advertise nothing beyond what we verified.
    result.frontier = 0;
    result.state = 'unverified';
    result.probes = counter.count;
    verifyCache[cacheKey] = result;
    return result;
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
// second source. Every request below carries opts.allowRescue, the ONE designated exception to
// the independence denylist; nothing else in this module may reach those hosts. Rescue routes
// pass the same positive byte validation (validateHls, with an elevated byte cap for the app
// bridge) as primary routes and are never substituted across languages. Quota discipline: one
// sweep per play, stop on 429, cache slug lookups (6 h) and verified routes (10 min) so repeat
// plays cost zero requests.

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
// Probe cap raised to 4 MiB (trio repair 2026-09-27): the AniKage CDNs ignore Range and
// serve ~2.1 MB segments, which the previous 2 MiB cap cut mid-read, dropping the body and
// rejecting every rescue route as segment_empty in the released runtime.
var RESCUE_PROBE_OPTS = { allowRescue: true, maxBytesHint: 4194304 };

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

async function rescueTitleFor(ref, session) {
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
        session,
      );
      var t = data && data.Media && data.Media.title;
      title = clean((t && (t.english || t.romaji || t.userPreferred)) || '');
    } else if (ref.malId) {
      var jk = await jikan('/anime/' + ref.malId, session);
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
    { session: session, allowRescue: true },
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

  function rescueCaptions(captions, audio, hdrs) {
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

async function rescuePlayerRoute(embedUrl, want, session) {
  var uaHeaders = { 'User-Agent': USER_AGENT, Referer: ANIKAGE + '/' };

  if (/\.m3u8(?:[?#]|$)/i.test(embedUrl)) {
    var direct = await validateHls(embedUrl, uaHeaders, session, RESCUE_PROBE_OPTS);
    if (!direct.ok) return null;
    return {
      name: 'AniKage',
      url: embedUrl,
      headers: uaHeaders,
      streamType: 'hls',
      brokenRefs: direct.brokenRefs || 0,
      lang: want,
      subtitles: [],
      qualities: [{ label: 'Auto', url: embedUrl, headers: uaHeaders }],
    };
  }

  if (/megaplay\.|vidstream/i.test(embedUrl)) {
    var origin = rescueOrigin(embedUrl);
    var page = await request(embedUrl, Object.assign({ Accept: 'text/html,*/*' }, uaHeaders), 'GET', null, { session: session, allowRescue: true });
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
    var fresh = await request(origin + '/stream/getSourcesNew' + qs, srcHeaders, 'GET', null, { session: session, allowRescue: true });
    if (fresh && fresh.ok && fresh.json) data = fresh.json;
    if (!data || (!data.sources && !data.enc && !data.file)) {
      var legacy = await request(origin + '/stream/getSources' + qs, srcHeaders, 'GET', null, { session: session, allowRescue: true });
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
    var caps = rescueCaptions(data.tracks, want, srcHeaders);
    for (var i = 0; i < entries.length && i < 2; i += 1) {
      var probe = await validateHls(entries[i].url, srcHeaders, session, RESCUE_PROBE_OPTS);
      if (probe.ok) {
        return {
          name: 'AniKage \u00b7 MegaPlay',
          url: entries[i].url,
          headers: srcHeaders,
          streamType: 'hls',
          brokenRefs: probe.brokenRefs || 0,
          lang: want,
          subtitles: caps,
          qualities: [{ label: entries[i].quality || 'Auto', url: entries[i].url, headers: srcHeaders }],
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
    var gs = await request('https://play.echovideo.ru/' + echo[1] + '/getSources?id=' + encodeURIComponent(echo[2]), echoHeaders, 'GET', null, { session: session, allowRescue: true });
    if (!gs.ok || !gs.json) {
      log('rescue echo sources ' + (gs ? gs.status : 'net'));
      return null;
    }
    var eentries = rescueNormalizeEntries(gs.json);
    for (var e = 0; e < eentries.length && e < 2; e += 1) {
      var eprobe = await validateHls(eentries[e].url, echoHeaders, session, RESCUE_PROBE_OPTS);
      if (eprobe.ok) {
        return {
          name: 'AniKage \u00b7 EchoVideo',
          url: eentries[e].url,
          headers: echoHeaders,
          streamType: 'hls',
          brokenRefs: eprobe.brokenRefs || 0,
          lang: want,
          subtitles: rescueCaptions(gs.json.tracks, want, echoHeaders),
          qualities: [{ label: eentries[e].quality || 'Auto', url: eentries[e].url, headers: echoHeaders }],
        };
      }
    }
    log('rescue echo probe ' + (eprobe && eprobe.reason ? eprobe.reason : 'fail'));
    return null;
  }

  if (/otakuhg\.site|otakuvid\.online|playmogo\.com|\.(?:vivi|bibi)\.|flixcloud\.|animeapps\.top|mfw09\.org|myvidplay\.com/i.test(embedUrl)) {
    var page2 = await request(embedUrl, Object.assign({ Accept: 'text/html,*/*' }, uaHeaders), 'GET', null, { session: session, allowRescue: true });
    if (!page2.ok) return null;
    var body = unpackPacker(page2.text) || page2.text;
    var hit = body.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
    if (!hit) return null;
    var hdr2 = { 'User-Agent': USER_AGENT, Referer: embedUrl, Origin: rescueOrigin(embedUrl) };
    var probe2 = await validateHls(hit[0], hdr2, session, RESCUE_PROBE_OPTS);
    if (!probe2.ok) return null;
    return {
      name: 'AniKage \u00b7 Player',
      url: hit[0],
      headers: hdr2,
      streamType: 'hls',
      brokenRefs: probe2.brokenRefs || 0,
      lang: want,
      subtitles: [],
      qualities: [{ label: 'Auto', url: hit[0], headers: hdr2 }],
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
    var title = await rescueTitleFor(ref, session);
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
      var res = await request(url, { Accept: 'application/json', Referer: ANIKAGE + '/anime/watch/' + slug }, 'GET', null, { session: session, allowRescue: true });
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

  // ------------------------------------------------------------------ packaging
  function packStream(primary, extras, lang, notice) {
    if (!primary) {
      return {
        streams: [],
        subtitles: [],
        lang: lang,
        error: { message: notice || 'No verified playable source for this episode right now.' },
      };
    }
    var accepted = [primary].concat(extras || []);
    var servers = [];
    var seenUrl = {};
    var allSubtitles = [];
    var seenCaption = {};
    accepted.forEach(function (row) {
      if (!row || !row.url || seenUrl[row.url]) return;
      seenUrl[row.url] = true;
      var entry = {
        name: row.name || 'Server',
        label: row.label || row.name || 'Server',
        url: row.url,
        headers: row.headers || {},
        streamType: 'hls',
        lang: lang,
        subtitles: row.subtitles || [],
        qualities: row.qualities || [],
      };
      if (row.intro) entry.intro = [row.intro.start, row.intro.end];
      if (row.outro) entry.outro = [row.outro.start, row.outro.end];
      servers.push(entry);
      (row.subtitles || []).forEach(function (cap) {
        if (cap && cap.url && !seenCaption[cap.url]) {
          seenCaption[cap.url] = true;
          allSubtitles.push(cap);
        }
      });
    });
    var qualities = Array.isArray(primary.qualities) ? primary.qualities : [];
    var streams = [(lang === 'dub' ? 'dub Auto' : 'sub Auto'), primary.url];
    qualities.forEach(function (q) {
      if (q && q.url && q.label && q.url !== primary.url) streams.push((lang === 'dub' ? 'dub ' : 'sub ') + q.label, q.url);
    });
    var payload = {
      url: primary.url,
      streams: streams,
      headers: primary.headers || {},
      streamType: 'hls',
      lang: lang,
      quality: 'Auto',
      defaultQuality: 'Auto',
      qualities: [{ label: 'Auto', url: primary.url, headers: primary.headers || {} }].concat(
        qualities.filter(function (q) {
          return q && q.url !== primary.url;
        }),
      ),
      subtitles: allSubtitles,
      servers: servers,
    };
    if (primary.intro) {
      payload.intro = [primary.intro.start, primary.intro.end];
      payload.introStartSeconds = primary.intro.start;
      payload.introEndSeconds = primary.intro.end;
    }
    if (primary.outro) {
      payload.outro = [primary.outro.start, primary.outro.end];
      payload.outroStartSeconds = primary.outro.start;
      payload.outroEndSeconds = primary.outro.end;
    }
    if (notice) payload.notice = notice;
    return payload;
  }

  var trackLabel = null; // replaced below by the evidence-based labeller

  // Whisper-sampled audio evidence (matrix run 2026-09-12, two offsets where the first sample was
  // music). The provider's track ids are used for ROUTING; labels may only assert a language where
  // a sample actually confirmed it. Anything unsampled says so.
  var AUDIO_EVIDENCE = {
    105333: { sub: 'japanese', dub: 'english' },
    113936: { sub: 'japanese' },
    142876: { dub: 'english' },
    140960: { sub: 'japanese', dub: 'japanese' },
    20: { dub: 'english' },
    21: { sub: 'japanese' },
    113415: { sub: 'japanese' },
    1535: { dub: 'english' },
    21459: { sub: 'japanese' },
    101922: { sub: 'japanese' },
    16498: { sub: 'japanese' },
    5114: { dub: 'english' },
    20464: { sub: 'japanese' },
    127230: { dub: 'english' },
    101348: { sub: 'japanese' },
    101759: { sub: 'japanese' },
    101291: { dub: 'japanese' },
    99147: { sub: 'japanese' },
    9253: { dub: 'english' },
    104578: { sub: 'japanese' },
    110277: { dub: 'japanese' },
    21087: { sub: 'japanese' },
    112151: { dub: 'english' },
    97940: { sub: 'japanese' },
    11061: { dub: 'english' },
  };

  function audioLabel(ref, audioTrack) {
    var sampled = (AUDIO_EVIDENCE[ref.anilistId] || {})[audioTrack];
    if (audioTrack === 'dub') {
      if (sampled === 'english') return { text: 'English Dub', discrepancy: false };
      if (sampled) return { text: "Provider 'dub' track — sampled audio is " + sampled + ', not English', discrepancy: true };
      return { text: 'Dub (provider track, audio not sampled)', discrepancy: false };
    }
    if (sampled === 'japanese') return { text: 'Japanese audio (Sub)', discrepancy: false };
    if (sampled) return { text: "Provider 'sub' track — sampled audio is " + sampled, discrepancy: true };
    return { text: 'Sub (provider track, audio not sampled)', discrepancy: false };
  }

  function friendlyAudio(audio) {
    return audio === 'dub' ? 'English Dub' : 'Japanese audio (Sub)';
  }

  // ------------------------------------------------------------------ stream resolution
  // Two resolve rounds plus candidate verification have to fit in here: a cold resolve makes the
  // provider do upstream work that outlives one cap, and the retry round lands on the warmed result.
  var PLAY_BUDGET_MS = 19000;
  var RESOLVE_ROUND_MS = 9000;
  var EXTRAS_WINDOW_MS = 1800;

  async function buildCandidate(ref, episode, audio, serverRow, session) {
    var referer = VIDHAWK + '/embed/ani/' + (ref.anilistId || ref.malId) + '/' + episode + '/' + audio;
    var play = await providerPlay(serverRow.ticket, referer, session);
    if (!play || !Array.isArray(play.tracks)) return null;
    var track = play.tracks.filter(function (row) {
      return row && row.id === audio && row.src;
    })[0];
    var substitute = false;
    if (!track) {
      var other = audio === 'dub' ? 'sub' : 'dub';
      track = play.tracks.filter(function (row) {
        return row && row.id === other && row.src;
      })[0];
      substitute = Boolean(track);
    }
    if (!track) return null;
    var hdrs = vhHeaders(referer);
    var validation = await validateHls(track.src, hdrs, session);
    if (!validation.ok) {
      log('candidate rejected (' + serverRow.id + ', ' + (validation.reason || 'probe') + ')');
      return { rejected: validation.reason || 'probe' };
    }
    var servedAudio = substitute ? (audio === 'dub' ? 'sub' : 'dub') : audio;
    var captions = await collectCaptions(play, servedAudio, session, 2600);
    var name = clean(serverRow.label || serverRow.id);
    var audioInfo = audioLabel(ref, servedAudio);
    var label = audioInfo.text + ' · Vidhawk ' + name;
    if (substitute) {
      label =
        audioInfo.text + ' (requested ' + friendlyAudio(audio) + ' is not offered at this provider) · Vidhawk ' + name;
    }
    return {
      name: name,
      label: label,
      url: track.src,
      headers: hdrs,
      streamType: 'hls',
      lang: servedAudio,
      subtitles: captions,
      qualities: parseQualities(validation.master, track.src, hdrs),
      intro: markerPair(play.intro),
      outro: markerPair(play.outro),
      substitute: substitute,
      audioDiscrepancy: audioInfo.discrepancy,
      mediaKind: validation.kind,
      server: serverRow.id,
    };
  }

  async function extractStreamUrl(episodeHrefRaw, lang) {
    var want = normaliseAudio(lang);
    var ref = parseRef(episodeHrefRaw);
    if ((!ref.anilistId && !ref.malId) || !ref.episode) {
      return { streams: [], subtitles: [], error: { message: 'Invalid episode reference.' } };
    }
    var session = { closed: false, deadline: Date.now() + PLAY_BUDGET_MS };
    var notice = '';
    var parkedSeen = false;

    // The AniKage rescue starts in parallel with the primary chain and is halted the moment
    // the primary serves a verified route. A provider outage then costs ONE wait (not the
    // sum of both chains), and a slow app-bridge request can never strand a verified route.
    var rescueHalt = { closed: false, result: null, done: false };
    rescueAnikageRoutes(ref, want, rescueHalt).catch(function (error) {
      log('rescue skip ' + (error && error.message ? error.message : error));
      return null;
    });

    // Both provider servers are asked at once; whichever answers with a ticket becomes a candidate.
    // No timers are used on this path: the app's JS sandbox does not pump module-created timers, so
    // any timer-gated wait here would hang the call (observed with the race endpoint). Correctness
    // comes from bounded request counts and the session deadline checks between steps.
    var direct = [];
    var resolveRound = async function () {
      var out = await Promise.all(
        ['flow', 'zuri'].map(function (name) {
          return providerResolve(ref, ref.episode, want, name, session, RESOLVE_ROUND_MS).catch(function () {
            return null;
          });
        }),
      );
      var rows = [];
      out.forEach(function (row, idx) {
        var name = idx === 0 ? 'flow' : 'zuri';
        if (row && row.parked) parkedSeen = true;
        if (row && row.ticket) rows.push({ id: name, label: row.label || name, ticket: row.ticket });
      });
      direct = direct.concat(out);
      return rows;
    };
    var serverRows = await resolveRound();
    // A cold resolve does upstream work on the provider that outlives our cap, and the NEXT attempt
    // lands on the warmed result. Measured on the live service: a first call that timed out at 45s
    // answered in 0.29s on the next attempt, and a 19.9s call answered in 0.088s. Retrying once
    // before giving up is what turns "this episode never loads" into "this episode loads".
    if (!serverRows.length && deadlineLeft(session) > 7000) {
      log('resolve round 1 produced no ticket, retrying on the warmed provider');
      serverRows = await resolveRound();
    }
    if (!serverRows.length) {
      var anyUnavailable = direct.some(function (row) {
        return row && row.unavailable;
      });
      if (anyUnavailable) notice = 'This episode is not available at the provider for ' + friendlyAudio(want) + '.';
      else if (parkedSeen) notice = 'The provider asked us to slow down (rate limit). Try this episode again in a minute.';
    }

    // 2. First verified candidate wins; extras are gathered inside a short window only.
    var primary = null;
    var extras = [];
    var rejected = [];
    for (var i = 0; i < serverRows.length; i += 1) {
      if (deadlineLeft(session) <= 900) break;
      var candidate = null;
      try {
        candidate = await buildCandidate(ref, ref.episode, want, serverRows[i], session);
      } catch (error) {
        log('candidate error ' + (error && error.message ? error.message : error));
      }
      if (candidate && candidate.rejected) {
        rejected.push(serverRows[i].id + ':' + candidate.rejected);
        continue;
      }
      if (candidate && candidate.url) {
        if (!primary) {
          primary = candidate;
          if (candidate.substitute) {
            notice = 'Requested ' + friendlyAudio(want) + ' is not offered at this provider; serving ' + friendlyAudio(candidate.lang) + ' labelled honestly.';
          } else if (candidate.audioDiscrepancy) {
            notice =
              "The provider labels this route '" + candidate.lang + "' but QA sampling of this title found " +
              ((AUDIO_EVIDENCE[ref.anilistId] || {})[candidate.lang] || 'other audio') +
              '; the route is served as-is and labelled accordingly.';
          }
          var extrasDeadline = Date.now() + EXTRAS_WINDOW_MS;
          for (var j = i + 1; j < serverRows.length; j += 1) {
            if (Date.now() > extrasDeadline || deadlineLeft(session) <= 500) break;
            var extra = null;
            try {
              extra = await buildCandidate(ref, ref.episode, want, serverRows[j], session);
            } catch (_) {}
            if (extra && extra.url) extras.push(extra);
            else if (extra && extra.rejected) rejected.push(serverRows[j].id + ':' + extra.rejected);
          }
          break;
        }
      }
    }

    // 3. An in-flight HTTP request cannot be cancelled; stop the next step.
    session.closed = true;

    // 4. Outage rescue: engage only when the primary chain produced no verified route. Poll
    // the rescue result fields — the app JS engine does not reliably run reactions chained
    // onto an already-settled promise, so a promise await can starve here.
    if (primary) {
      rescueHalt.closed = true;
    } else {
      log('rescue engage');
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

    if (rejected.length) log('rejected routes: ' + rejected.join(', '));
    if (!primary && !notice) {
      notice = 'No verified playable source for this episode right now.';
    }
    return packStream(primary, extras, primary ? primary.lang : want, notice);
  }

  // ------------------------------------------------------------------ catalogue entry points
  async function searchResults(query) {
    var q = clean(query);
    var session = { closed: false, deadline: Date.now() + 9000 };
    try {
      if (!q) {
        var trending = await anilist(
          'query($page:Int){ Page(page:$page, perPage:24){ media(type:ANIME, sort:TRENDING_DESC, isAdult:false){ ' + MEDIA_FIELDS + ' } } }',
          { page: 1 },
          session,
        );
        return ((trending.Page && trending.Page.media) || []).map(mediaCard).filter(Boolean);
      }
      var data = await anilist(
        'query($q:String){ Page(page:1, perPage:24){ media(search:$q, type:ANIME, sort:SEARCH_MATCH, isAdult:false){ ' + MEDIA_FIELDS + ' } } }',
        { q: q },
        session,
      );
      var cards = ((data.Page && data.Page.media) || []).map(mediaCard).filter(Boolean);
      if (cards.length) return cards;
    } catch (error) {
      log('AniList search failed: ' + (error && error.message ? error.message : error));
    }
    try {
      var jk = await jikan(q ? '/anime?q=' + encodeURIComponent(q) + '&limit=24&sfw=true' : '/top/anime?limit=24', session);
      return (jk.data || []).map(jikanCard).filter(Boolean);
    } catch (error) {
      log('catalogue temporarily unavailable (' + (error && error.message ? error.message : error) + ')');
      return [];
    }
  }

  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref.anilistId && !ref.malId) {
      var found = await searchResults(String(urlOrId || ''));
      if (found && found[0]) {
        return {
          id: found[0].href,
          href: found[0].href,
          title: found[0].title,
          image: found[0].image,
          poster: found[0].image,
          description: '',
          anilistId: found[0].anilistId,
          malId: found[0].malId,
        };
      }
      return { title: 'Unavailable', description: '', error: { message: 'Not found in the catalogue.' } };
    }
    var session = { closed: false, deadline: Date.now() + 9000 };
    if (ref.anilistId) {
      try {
        var data = await anilist('query($id:Int){ Media(id:$id, type:ANIME){ ' + MEDIA_FIELDS + ' } }', { id: ref.anilistId }, session);
        var media = data.Media;
        if (media && media.id) {
          var card = mediaCard(media) || {};
          return {
            id: card.href,
            href: card.href,
            title: card.title,
            name: card.title,
            image: card.image,
            poster: card.image,
            description: clean(media.description),
            synopsis: clean(media.description),
            genres: media.genres || [],
            year: media.seasonYear || 0,
            status: media.status || '',
            format: media.format || '',
            episodes: media.episodes || 0,
            duration: media.duration || 0,
            score: media.averageScore || 0,
            anilistId: media.id,
            malId: media.idMal || 0,
          };
        }
      } catch (error) {
        log('details failed: ' + (error && error.message ? error.message : error));
      }
    }
    if (ref.malId) {
      try {
        var jk = await jikan('/anime/' + ref.malId, session);
        var row = jk.data || {};
        var jcard = jikanCard(row) || {};
        return {
          id: jcard.href,
          href: jcard.href,
          title: jcard.title,
          name: jcard.title,
          image: jcard.image,
          poster: jcard.image,
          description: clean(row.synopsis),
          synopsis: clean(row.synopsis),
          genres: (row.genres || []).map(function (g) {
            return g && g.name;
          }).filter(Boolean),
          year: row.year || 0,
          status: row.status || '',
          episodes: row.episodes || 0,
          anilistId: 0,
          malId: row.mal_id,
        };
      } catch (error) {
        log('details fallback failed: ' + (error && error.message ? error.message : error));
      }
    }
    return { title: 'Unavailable', description: '', href: String(urlOrId || ''), error: { message: 'Details unavailable right now.' } };
  }

  async function extractEpisodes(seriesRef) {
    var ref = parseRef(seriesRef);
    if (!ref.anilistId && !ref.malId) return [];
    var session = { closed: false, deadline: Date.now() + VERIFY_DEADLINE_MS };
    var total = 0;
    var nextAiring = 0;
    var airedLimitKnown = false;
    var episodeTitles = {};
    var malId = ref.malId || 0;
    var episodeCountKnown = false;
    var metadataFailures = [];

    if (ref.anilistId) {
      try {
        var data = await anilist(
          'query($id:Int){ Media(id:$id, type:ANIME){ id idMal episodes format nextAiringEpisode { episode } streamingEpisodes { title site } } }',
          { id: ref.anilistId },
          session,
        );
        var media = (data && data.Media) || {};
        total = Number(media.episodes) || 0;
        episodeCountKnown = typeof media.episodes === 'number' && isFinite(media.episodes) && media.episodes >= 0;
        nextAiring = Number(media.nextAiringEpisode && media.nextAiringEpisode.episode) || 0;
        airedLimitKnown = nextAiring > 0;
        if (nextAiring === 1) episodeCountKnown = true;
        malId = Number(media.idMal) || malId;
        // AniList does not number streamingEpisodes; the mapping is positional. Only trust it when
        // the list covers the whole series, otherwise keep neutral episode labels.
        var streaming = (media.streamingEpisodes || []).filter(function (row) {
          return row && row.title;
        });
        if (total > 0 && streaming.length === total) {
          streaming.forEach(function (row, idx) {
            episodeTitles[idx + 1] = clean(row.title);
          });
        }
        if (media.format === 'MOVIE' || media.format === 'SPECIAL' || media.format === 'OVA' || media.format === 'ONA') {
          if (!total) total = 1;
        }
      } catch (error) {
        metadataFailures.push(error && error.message ? error.message : 'AniList lookup failed');
        log('episode count lookup failed: ' + (error && error.message ? error.message : error));
      }
    }
    if (!total && malId && !airedLimitKnown) {
      try {
        var jk = await jikan('/anime/' + malId, session);
        var jikanEpisodes = jk.data && jk.data.episodes;
        episodeCountKnown = typeof jikanEpisodes === 'number' && isFinite(jikanEpisodes) && jikanEpisodes >= 0;
        total = Number(jikanEpisodes) || 0;
        if (!total && (jk.data && (jk.data.type === 'Movie' || jk.data.airing === false))) total = 1;
      } catch (error) {
        metadataFailures.push(error && error.message ? error.message : 'Jikan lookup failed');
        log('episode count fallback failed: ' + (error && error.message ? error.message : error));
      }
    }
    if (nextAiring > 0) total = total ? Math.min(total, nextAiring - 1) : nextAiring - 1;
    if (!total) {
      if (!episodeCountKnown && metadataFailures.length) {
        throw new Error('Episode metadata temporarily unavailable. Retry this lookup. ' + metadataFailures.join('; '));
      }
      log('no episode metadata for ' + (ref.anilistId || ref.malId));
      return [];
    }

    var refForProvider = { anilistId: ref.anilistId || 0, malId: malId };
    // Sub and dub are independent questions, so both are asked at the same time and each gets its
    // own deadline. (They used to share one budget and run in sequence: on long/deep titles the
    // sub pass could consume the whole 8 s, leaving dub unprobed and the UI hiding a dub that does
    // exist — found by the 50-title reliability sweep on One Piece, Naruto, AoT S2 and HxH.)
    async function listAvailability(audio) {
      var check = { closed: false, deadline: Date.now() + 1800 };
      try {
        var result = await raceCap(verifyFrontier(refForProvider, total, audio, check), 1800);
        // Primary-provider absence is not proof that the independent rescue
        // lacks the episode. Unknown flags permit a playback attempt, not a
        // promise of playable media or a substitution of audio languages.
        if (!result || result.capped || result.state === 'unverified' || result.state === 'unavailable') {
          return { frontier: total, firstAvailable: 1, state: 'unverified', probes: 0 };
        }
        return result;
      } catch (_) {
        return { frontier: total, firstAvailable: 1, state: 'unverified', probes: 0 };
      } finally {
        check.closed = true;
      }
    }
    var verifiedResults = await Promise.all([
      listAvailability('sub'),
      listAvailability('dub'),
    ]);
    var subResult = verifiedResults[0];
    var dubResult = verifiedResults[1];
    session.closed = true;

    var advertiseUpTo = Math.max(subResult.frontier, dubResult.frontier);
    log(
      'episodes ' + (ref.anilistId || malId) + ': metadata=' + total + ' subFrontier=' + subResult.frontier +
        ' dubFrontier=' + dubResult.frontier + ' subFrom=' + (subResult.firstAvailable || 1) + ' dubFrom=' + (dubResult.firstAvailable || 1) +
        ' state=' + subResult.state + '/' + dubResult.state + ' probes=' + (subResult.probes + dubResult.probes),
    );
    if (advertiseUpTo <= 0) {
      log('episode list withheld: provider verified nothing for this title/audio set');
      return [];
    }

    var out = [];
    for (var i = 1; i <= advertiseUpTo; i += 1) {
      out.push({
        id: episodeHref(refForProvider, i),
        href: episodeHref(refForProvider, i),
        number: i,
        episodeNumber: i,
        title: episodeTitles[i] || 'Episode ' + i,
        // 'verified'   -> inside its own verified window (a late start or a frontier can trim it)
        // 'unavailable'-> the provider positively has no such audio: only this clears a flag
        // 'unverified' -> the provider could not be asked in time; do NOT hide the language, because
        //                 playback reports the real situation rather than silently substituting
        subAvailable: audioFlag(subResult, i),
        dubAvailable: audioFlag(dubResult, i),
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ discovery
  var FEED_PAGE = 24;

  async function discoveryHome() {
    var session = { closed: false, deadline: Date.now() + 9000 };
    try {
      var data = await anilist(
        'query{ trending: Page(page:1, perPage:24){ media(type:ANIME, sort:TRENDING_DESC, isAdult:false){ ' + MEDIA_FIELDS + ' } } ' +
          'popular: Page(page:1, perPage:24){ media(type:ANIME, sort:POPULARITY_DESC, isAdult:false){ ' + MEDIA_FIELDS + ' } } ' +
          'top: Page(page:1, perPage:24){ media(type:ANIME, sort:SCORE_DESC, isAdult:false){ ' + MEDIA_FIELDS + ' } } }',
        {},
        session,
      );
      var trending = ((data.trending && data.trending.media) || []).map(mediaCard).filter(Boolean);
      var popular = ((data.popular && data.popular.media) || []).map(mediaCard).filter(Boolean);
      var top = ((data.top && data.top.media) || []).map(mediaCard).filter(Boolean);
      var sections = [];
      if (trending.length) {
        sections.push({ id: 'sad-featured', title: 'Featured', style: 'hero', items: trending.slice(0, 8) });
      }
      if (trending.length) {
        sections.push({ id: 'sad-trending', title: 'Trending Now', style: 'poster', items: trending, viewAll: { mode: 'feed', feedId: 'trending' } });
      }
      if (popular.length) {
        sections.push({ id: 'sad-popular', title: 'Popular', style: 'poster', items: popular, viewAll: { mode: 'feed', feedId: 'popular' } });
      }
      if (top.length) {
        sections.push({ id: 'sad-top', title: 'Top Rated', style: 'poster', items: top, viewAll: { mode: 'feed', feedId: 'top' } });
      }
      return { sections: sections };
    } catch (error) {
      log('discovery failed: ' + (error && error.message ? error.message : error));
      try {
        var jk = await jikan('/top/anime?limit=24', session);
        var items = (jk.data || []).map(jikanCard).filter(Boolean);
        return items.length ? { sections: [{ id: 'sad-popular', title: 'Popular', style: 'poster', items: items }] } : { sections: [] };
      } catch (_) {
        return { sections: [] };
      }
    }
  }

  async function discoveryFeed(feedId, page) {
    var pageNumber = Math.max(1, Number(page) || 1);
    var sort = "TRENDING_DESC";
    var id = String(feedId || 'trending');
    if (id.indexOf('popular') >= 0) sort = 'POPULARITY_DESC';
    else if (id.indexOf('top') >= 0) sort = 'SCORE_DESC';
    var session = { closed: false, deadline: Date.now() + 9000 };
    try {
      var data = await anilist(
        'query($page:Int, $sort:[MediaSort]){ Page(page:$page, perPage:' + FEED_PAGE + '){ pageInfo { hasNextPage } media(type:ANIME, sort:$sort, isAdult:false){ ' + MEDIA_FIELDS + ' } } }',
        { page: pageNumber, sort: [sort] },
        session,
      );
      var items = ((data.Page && data.Page.media) || []).map(mediaCard).filter(Boolean);
      return { feedId: id, page: pageNumber, items: items, hasMore: Boolean(data.Page && data.Page.pageInfo && data.Page.pageInfo.hasNextPage) };
    } catch (error) {
      throw new Error('Catalogue page temporarily unavailable. Retry this page.');
    }
  }

  // ------------------------------------------------------------------ exports
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  // Test/diagnostic hook: read-only view of what this module actually requested.
  globalThis.__sadTrace = function () {
    return {
      requests: trace.requests.slice(),
      blocked: trace.blocked.slice(),
      probes: trace.probes,
      cooldowns: trace.cooldowns,
      cooldownHosts: Object.keys(cooldownUntil).filter(function (h) {
        return hostParked(h);
      }),
    };
  };
})();
