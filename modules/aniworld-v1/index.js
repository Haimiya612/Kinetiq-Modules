// Bundled into each module. No remote code or new runtime APIs.
globalThis.__trioMedia = (() => {
  const parked = Object.create(null);
  function absolute(value, base) {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.indexOf('//') === 0) return 'https:' + value;
    const origin = (base.match(/^https?:\/\/[^/]+/i) || [''])[0];
    if (value[0] === '/') return origin + value;
    const joined=base.split('?')[0].replace(/[^/]*$/, '')+value;
    const suffix=joined.slice(origin.length), parts=suffix.split('/'), clean=[];
    for(const part of parts){if(part==='..')clean.pop();else if(part!=='.')clean.push(part);}
    return origin+clean.join('/');
  }
  async function get(url, headers, deadline, range) {
    for (let hop=0;hop<5;hop++) {
      const host=(url.match(/^https?:\/\/([^/]+)/i)||[])[1];
      if (!host || Date.now() >= deadline || parked[host] > Date.now()) return null;
      const h=Object.assign({},headers,range ? {Range:'bytes=0-1023'} : {});
      let timer;
      let r=await Promise.race([
        fetchv2(url,h,'GET',null,{followRedirects:false,maxBytesHint:range?2048:1048576}),
        new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,deadline-Date.now()));})
      ]).finally(()=>{if(typeof clearTimeout==='function') clearTimeout(timer);});
      if (!r) return null;
      const status=Number(r.status), rh=r.headers||{};
      if (status===429 || status===403) {parked[host]=Date.now()+900000;return null;}
      const loc=rh.location||rh.Location;
      if (status>=300 && status<400 && loc) {url=absolute(loc,url);continue;}
      if (!(status>=200 && status<300)) return null;
      // The shipped bridge deliberately returns no body for manual redirects.
      // Once the final URL is known, read the playlist through the text bridge.
      if (!range && !r.body && Date.now()<deadline) {
        let bodyTimer;
        r=await Promise.race([fetchv2(url,h,'GET',null,{followRedirects:true,maxBytesHint:1048576}),new Promise(resolve=>{bodyTimer=setTimeout(()=>resolve(null),Math.max(1,deadline-Date.now()));})]).finally(()=>{if(typeof clearTimeout==='function')clearTimeout(bodyTimer);});
        if (!r || Number(r.status)<200 || Number(r.status)>=300) return null;
      }
      let body=typeof r.body==='string'?r.body:'';
      if (!body && typeof r.text==='function') body=await r.text();
      console.log('[media-check] '+host+' status='+status+' type='+String(rh['content-type']||rh['Content-Type']||'')+' chars='+body.length);
      return {url,body:body||'',type:String(rh['content-type']||rh['Content-Type']||'')};
    }
    return null;
  }
  async function check(candidate, deadline) {
    const headers=candidate.headers||{};
    const hls=candidate.streamType==='hls'||/\.m3u8(?:[?#]|$)/i.test(candidate.url);
    const r=await get(candidate.url,headers,deadline,!hls);
    if (!r || /text\/html|image\//i.test(r.type) || /^\s*(?:<!doctype|<html)/i.test(r.body)) return null;
    if (!hls) {
      // Runtime text bridges may drop binary bodies; require media MIME there.
      if (!/video\/|application\/octet-stream/i.test(r.type) && !/ftyp/.test(r.body.slice(0,32))) return null;
      return Object.assign({},candidate,{url:r.url,streamType:'mp4',qualities:[{label:'Auto',url:r.url,headers}]});
    }
    if (!/^\s*#EXTM3U/.test(r.body)) return null;
    const variants=[];
    const re=/#EXT-X-STREAM-INF:([^\r\n]*)[\r\n]+([^#\r\n][^\r\n]*)/g;
    let m;
    while ((m=re.exec(r.body))) {
      const height=Number((m[1].match(/RESOLUTION=\d+x(\d+)/i)||[])[1])||0;
      variants.push({label:height?height+'p':'Auto',height,url:absolute(m[2].trim(),r.url),headers});
    }
    const checked=[];
    for (const v of variants.length?variants:[{label:'Auto',url:r.url,headers}]) {
      if (Date.now()>=deadline) break;
      const p=variants.length?await get(v.url,headers,deadline,false):r;
      if (!p || !/^\s*#EXTM3U/.test(p.body) || /\.(?:jpg|jpeg|png|webp)(?:[?#\s]|$)/i.test(p.body)) continue;
      const segment=p.body.split(/\r?\n/).map(x=>x.trim()).find(x=>x && x[0]!=='#');
      if (!segment || !/#EXTINF:/.test(p.body)) continue;
      const bytes=await get(absolute(segment,p.url),headers,deadline,true);
      if (!bytes || /image\/|text\/html/i.test(bytes.type) || /^\s*(?:<!doctype|<html)/i.test(bytes.body)) continue;
      if (!/video\/|application\/octet-stream/i.test(bytes.type) && bytes.body[0]!=='G' && !/styp|ftyp|moof/.test(bytes.body.slice(0,40))) continue;
      checked.push(Object.assign({},v,{url:p.url}));
    }
    if (!checked.length) return null;
    checked.sort((a,b)=>(b.height||0)-(a.height||0));
    // Preserve external audio groups by keeping their master as the default.
    const externalAudio=/#EXT-X-MEDIA:.*TYPE=AUDIO.*URI=/i.test(r.body);
    if (externalAudio) return Object.assign({},candidate,{url:r.url,streamType:'hls',qualities:[{label:'Auto',url:r.url,headers}]});
    return Object.assign({},candidate,{url:checked[0].url,streamType:'hls',qualities:checked});
  }
  function result(rows, lang) {
    const seen=Object.create(null);
    const servers=rows.filter(r=>{
      const key=r.url+JSON.stringify(r.headers||{})+JSON.stringify(r.subtitles||[]);
      if (seen[key]) return false; seen[key]=true; return true;
    }).map((r,i)=>Object.assign({},r,{id:'server-'+(i+1),name:r.name||'Server '+(i+1),lang,
      streams:r.qualities.flatMap(q=>[q.label,q.url]),subtitles:r.subtitles||[]}));
    if (!servers.length) return {streams:[],servers:[],subtitles:[],lang};
    const first=servers[0];
    return Object.assign({},first,{servers,streams:first.qualities.flatMap(q=>[q.label,q.url])});
  }
  return {absolute,get,check,result};
})();

(() => {
  'use strict';

  const MODULE_NAME = 'Aniworld';
  const SITE = 'https://aniworld.to';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  const LANG_KEYS = { dub: '1', sub: '2', deSub: '3' };
  const LANG_LABELS = { '1': 'Deutsch', '2': 'EN Subs', '3': 'DE Subs' };
  const HOSTER_PRIORITY = ['Vidmoly', 'Filemoon', 'VOE', 'Doodstream'];
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  const streamCache = Object.create(null);
  const hostParked = Object.create(null);
  const anilistIdCache = Object.create(null);
  const HOST_COOLDOWN_MS = 10 * 60 * 1000;
  function hostOf(url) {
    return (String(url || '').match(/^https?:\/\/([^/]+)/i) || [])[1] || '';
  }
  function retryAfterMs(headers) {
    const raw = headerValue(headers, 'retry-after');
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, HOST_COOLDOWN_MS);
    return 0;
  }
  function parkHost(host, ms, why) {
    if (!host) return;
    const wait = Math.max(60000, Math.min(Number(ms) || HOST_COOLDOWN_MS, HOST_COOLDOWN_MS));
    hostParked[host] = Date.now() + wait;
    log('cooldown ' + host + ' ' + Math.round(wait / 1000) + 's' + (why ? ' (' + why + ')' : ''));
  }

  function log(message) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(message || ''));
    } catch (_) {}
  }

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#8230;/gi, '...')
      .replace(/&auml;|&Auml;|&ouml;|&Ouml;|&uuml;|&Uuml;|&szlig;/gi, function (m) {
        return {
          '&auml;': '\u00e4',
          '&Auml;': '\u00c4',
          '&ouml;': '\u00f6',
          '&Ouml;': '\u00d6',
          '&uuml;': '\u00fc',
          '&Uuml;': '\u00dc',
          '&szlig;': '\u00df',
        }[m];
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([promise, sleep(waitMs).then(() => fallback)]);
  }

  function toAbsolute(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.indexOf('//') === 0) return 'https:' + raw;
    if (raw.charAt(0) === '/') return SITE + raw;
    return SITE + '/' + raw;
  }

  function slugFromHref(input) {
    const m = String(input || '').match(/\/anime\/stream\/([a-z0-9-]+)(?:\/|$)/i);
    if (!m || !m[1]) return '';
    const slug = m[1];
    if (/staffel|episode|filme|film/i.test(slug)) return '';
    return slug;
  }

  /* -------------------- HTTP -------------------- */

  async function readBody(res) {
    if (!res) return '';
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

  function headerValue(headers, name) {
    if (!headers) return '';
    const lower = String(name || '').toLowerCase();
    if (typeof headers.get === 'function') {
      try {
        const v = headers.get(name) || headers.get(lower);
        if (v) return v;
      } catch (_) {}
    }
    if (typeof headers === 'object') {
      const keys = Object.keys(headers);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === lower) return String(headers[keys[i]] || '');
      }
    }
    return '';
  }

  async function rawRequest(url, options) {
    const cfg = options || {};
    const host = hostOf(url);
    if (host && hostParked[host] > Date.now()) {
      log('skip parked host ' + host);
      return { ok: false, status: 0, body: '', headers: {}, url: url, parked: true };
    }
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: cfg.accept || '*/*',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
      cfg.headers || {},
    );
    const method = cfg.method || 'GET';
    const body = cfg.body == null ? null : cfg.body;
    let res = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (typeof fetchv2 === 'function') {
          res = await fetchv2(url, headers, method, body, {followRedirects:cfg.followRedirects !== false});
        } else if (typeof fetch === 'function') {
          res = await fetch(url, { method: method, headers: headers, body: body });
        } else {
          throw new Error('No fetch available');
        }
      } catch (_) { res = null; }
      const status = Number((res && res.status) || 0);
      if (res && attempt === 0 && (status === 429 || status === 403 || status >= 500)) {
        await sleep(Math.min(retryAfterMs(res.headers) || 700, 4000));
        continue;
      }
      if (res && (status === 429 || status === 403 || status >= 500)) {
        if (/aniworld\.to$/i.test(host)) {
          // The catalogue site is the module's lifeline: per-URL failures (dead redirects,
          // transient CF rules) must never block the whole site. Keep attempting each fetch.
          log('site fetch failed HTTP ' + status + ' (not parked)');
        } else {
          parkHost(host, retryAfterMs(res.headers) || (/anilist/.test(host) ? 60000 : HOST_COOLDOWN_MS), 'HTTP ' + status);
        }
      }
      break;
    }
    const status = Number((res && res.status) || 0);
    const ok =
      res &&
      (res.ok === true ||
        res.ok === 1 ||
        (!status && res.ok !== false) ||
        (status >= 200 && status < 400));
    const text = await readBody(res);
    return { ok: !!ok, status: status, body: text || '', headers: (res && res.headers) || {}, url: url };
  }

  async function request(url, options) {
    return rawRequest(url, options || {});
  }

  async function followGet(url, options) {
    let current = url;
    let res = null;
    for (let i = 0; i < 6; i++) {
      res = await request(current, Object.assign({},options||{},{followRedirects:false}));
      const status = Number(res.status || 0);
      if (status >= 300 && status < 400) {
        const loc = headerValue(res.headers, 'location');
        if (loc) {
          current = globalThis.__trioMedia.absolute(loc, current);
          continue;
        }
      }
      if (!res.body && status>=200 && status<300) {
        res=await request(current,Object.assign({},options||{},{followRedirects:true}));
        res.url=current;
      }
      break;
    }
    return res;
  }

  /* -------------------- card / page parsers -------------------- */

  function parseSeriesCards(html) {
    const out=[],seen=Object.create(null);
    const re=/<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while((m=re.exec(String(html||'')))){
      const link=(m[1].match(/\bhref=["'](\/anime\/stream\/[a-z0-9-]+\/?)["']/i)||[])[1];
      if(!link)continue;
      const slug=slugFromHref(link),inner=m[2];
      const title=cleanText((inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)||[])[1]||'');
      const cover=(inner.match(/(?:data-src|src)=["'](\/public\/img\/(?:cover|home)\/[^"']+)["']/i)||[])[1];
      if(!slug||!title||!cover||seen[slug])continue;
      seen[slug]=true;
      const href=SITE+'/anime/stream/'+slug,image=SITE+cover;
      out.push({id:href,href,title,image,poster:image,type:'tv',mediaType:'tv'});
    }
    return out;
  }

  function parseHomeSections(html) {
    const sections = [];
    const parts = String(html || '').split(/<h2[^>]*>/i);
    for (let i = 1; i < parts.length; i++) {
      const chunk = parts[i];
      const heading = cleanText((chunk.match(/^([\s\S]{0,80}?)<\/h2>/i) || [])[1] || '');
      if (!heading) continue;
      const rest = chunk.replace(/^[\s\S]{0,80}?<\/h2>/i, '');
      const items = parseSeriesCards(rest).slice(0, 30);
      if (!items.length) continue;
      sections.push({ heading: heading, items: items });
    }
    return sections;
  }

  function parseSeasonNumbers(html, slug) {
    const seasons = [];
    const seen = Object.create(null);
    const re = new RegExp('\\/anime\\/stream\\/' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/(?:staffel-(\\d+)|(filme))(?=[/"\x27?#\\s]|$)', 'g');
    let m;
    while ((m = re.exec(String(html || '')))) {
      const n = m[2] ? 0 : Number(m[1]);
      if ((m[2] || n > 0) && !seen[n]) {
        seen[n] = true;
        seasons.push(n);
      }
    }
    return seasons.sort((a, b) => a - b);
  }

  function parseEpisodeRows(html, slug, season) {
    const out = [];
    const seen = Object.create(null);
    const rowRe = /<tr[^>]*data-episode-id="[^"]+"[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(String(html || '')))) {
      const row = rm[1];
      const match = row.match(/\/anime\/stream\/([a-z0-9-]+)\/(?:staffel-(\d+)\/episode-(\d+)|filme\/film-(\d+))(?=["'?#\s]|$)/i);
      if (!match || match[1] !== slug) continue;
      const link = match[0];
      const s = match[4] ? 0 : Number(match[2]);
      const e = Number(match[4] || match[3]);
      if (s !== season || !e || seen[e]) continue;
      seen[e] = true;
      const deTitle = cleanText((row.match(/<strong>([\s\S]*?)<\/strong>/i) || [])[1] || '');
      const origTitle = cleanText((row.match(/<span>([\s\S]*?)<\/span>/i) || [])[1] || '');
      const title =
        (deTitle ? (origTitle ? deTitle + ' (' + origTitle + ')' : deTitle) : origTitle) ||
        'Episode ' + e;
      out.push({
        number: e,
        season: s,
        title: (s === 0 ? 'Film ' + e : 'S' + s + 'E' + e) + ' - ' + title,
        href: SITE + link,
        subAvailable: /japanese-(?:english|german)\.svg/i.test(row),
        dubAvailable: /\/german\.svg/i.test(row),
      });
    }
    out.sort((a, b) => Number(a.number) - Number(b.number));
    return out;
  }

  /* -------------------- search -------------------- */

  async function homeCards() {
    const res = await request(SITE + '/', { accept: 'text/html,*/*' });
    return parseSeriesCards((res && res.body) || '').slice(0, 40);
  }

  async function fetchCoverForSlug(slug) {
    try {
      const res = await settleWithin(
        request(SITE + '/anime/stream/' + slug, { accept: 'text/html,*/*' }),
        6000,
        null,
      );
      const m = ((res && res.body) || '').match(/data-src="(\/public\/img\/cover\/[^"]+)"/i);
      return m ? SITE + m[1] : '';
    } catch (_) {
      return '';
    }
  }

  async function enrichSearchPosters(results) {
    const limit = Math.min(6, results.length);
    const CONCURRENCY = 3;
    for (let i = 0; i < limit; i += CONCURRENCY) {
      const chunk = results.slice(i, i + CONCURRENCY);
      const covers = await Promise.all(
        chunk.map((item) => fetchCoverForSlug(slugFromHref(item.href))),
      );
      for (let j = 0; j < chunk.length; j++) {
        if (covers[j]) {
          chunk[j].image = covers[j];
          chunk[j].poster = covers[j];
        }
      }
    }
    return results;
  }

  async function searchResults(query) {
    const q = String(query == null ? '' : query).trim();
    if (!q) {
      try {
        return await homeCards();
      } catch (e) {
        log('home search fail: ' + (e && e.message ? e.message : e));
        return [];
      }
    }
    try {
      const forms = searchForms(q);
      const out = [];
      const seen = Object.create(null);
      for (let fi = 0; fi < forms.length; fi++) {
        const form = forms[fi];
        let rows = [];
        try {
          rows = await siteSearch(form);
        } catch (e) {
          rows = [];
        }
        if (!rows.length) continue;
        const isFallback = fi > 0;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const slug = slugFromHref(row.href);
          if (!slug || seen[slug]) continue;
          if (isFallback && queryRelevance(q, row.title) < 1) continue;
          seen[slug] = true;
          out.push(row);
        }
        if (out.length) break;
      }
      if (out.length) await enrichSearchPosters(out);
      return out;
    } catch (e) {
      log('search error: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  function searchForms(query) {
    const q = String(query || '').trim();
    const forms = [q];
    const noPunct = q
      .replace(/['\u2019`´.]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (noPunct && noPunct !== q) forms.push(noPunct);
    const words = noPunct.split(/\s+/).filter(Boolean);
    if (words.length > 2) forms.push(words.slice(0, 2).join(' '));
    if (words.length > 1) forms.push(words[0]);
    if (words.length > 2) forms.push(words[words.length - 1]);
    const noArticle = noPunct.replace(/^(the|a|an)\s+/i, '');
    if (noArticle && noArticle !== noPunct) forms.push(noArticle);
    const seen = Object.create(null);
    return forms.filter((f) => {
      if (!f || seen[f]) return false;
      seen[f] = true;
      return true;
    });
  }

  function queryRelevance(query, title) {
    const q = String(query || '')
      .toLowerCase()
      .replace(/['\u2019`´.]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
    const t = String(title || '')
      .toLowerCase()
      .replace(/['\u2019`´.]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
    if (!q.length) return 0;
    let score = 0;
    for (const w of q) {
      if (t.indexOf(w) >= 0) score += 1;
    }
    if (t.join(' ').indexOf(q.join(' ')) >= 0) score += 3;
    return score;
  }

  async function siteSearch(keyword) {
    const res = await request(SITE + '/ajax/search', {
      method: 'POST',
      accept: 'application/json,*/*',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: SITE + '/search',
      },
      body: 'keyword=' + encodeURIComponent(keyword),
    });
    let rows = [];
    try {
      rows = JSON.parse(res.body);
    } catch (_) {
      rows = [];
    }
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const href = toAbsolute(row && row.link);
      const slug = slugFromHref(href);
      const title = cleanText(String((row && row.title) || '').replace(/<\/?em>/gi, ''));
      if (!href || !slug || !title || seen[slug]) continue;
      seen[slug] = true;
      out.push({
        id: href,
        href: href,
        title: title,
        image: '',
        type: 'tv',
        mediaType: 'tv',
      });
    }
    return out;
  }

  /* -------------------- details -------------------- */

  async function extractDetails(urlOrId) {
    const slug = slugFromHref(urlOrId);
    if (!slug) {
      return { title: 'Unknown title', description: 'Unable to resolve this title.' };
    }

    const res = await request(SITE + '/anime/stream/' + slug, { accept: 'text/html,*/*' });
    const html = (res && res.body) || '';
    const title = cleanText((String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||[])[1]||'') || slug;
    const description =
      cleanText((String(html).match(/data-full-description="([^"]+)"/i) || [])[1] || '') ||
      'No description available.';
    let image = (String(html).match(/data-src="(\/public\/img\/cover\/[^"]+)"/i) || [])[1] || '';
    image = image ? SITE + image : '';

    const seasons = parseSeasonNumbers(html, slug);
    const details = {
      id: SITE + '/anime/stream/' + slug,
      href: SITE + '/anime/stream/' + slug,
      url: SITE + '/anime/stream/' + slug,
      title: title,
      description: description,
      image: image,
      poster: image,
      type: 'tv',
      mediaType: 'tv',
      seasons: seasons.length || 1,
      seasonNumbers: seasons,
      isMovie: false,
    };
    return details;
  }

  /* -------------------- episodes -------------------- */

  async function extractEpisodes(seriesId) {
    const slug = slugFromHref(seriesId);
    if (!slug) return [];

    let seasons = [];
    try {
      const details = await extractDetails(SITE + '/anime/stream/' + slug);
      seasons = (details.seasonNumbers || []).slice();
    } catch (_) {}
    if (!seasons.length) seasons = [1];

    const episodes = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < seasons.length; i += CONCURRENCY) {
      const chunk = seasons.slice(i, i + CONCURRENCY);
      const pages = await Promise.all(
        chunk.map(async (season) => {
          const url = SITE + '/anime/stream/' + slug + (season === 0 ? '/filme' : '/staffel-' + season);
          const res = await request(url, { accept: 'text/html,*/*' });
          return parseEpisodeRows((res && res.body) || '', slug, season);
        }),
      );
      for (let j = 0; j < pages.length; j++) {
        for (let k = 0; k < pages[j].length; k++) episodes.push(pages[j][k]);
      }
    }

    episodes.sort((a, b) => {
      const s = Number(a.season) - Number(b.season);
      if (s !== 0) return s;
      return Number(a.number || 0) - Number(b.number || 0);
    });
    return episodes;
  }

  /* -------------------- hoster / streams -------------------- */

  function parseHosterLinks(html) {
    const byLang = Object.create(null);
    const re =
      /<li[^>]*class="[^"]*episodeLink\d+"[^>]*data-lang-key="(\d+)"[^>]*data-link-id="(\d+)"[^>]*data-link-target="(\/redirect\/\d+)"[\s\S]*?<h4>([\s\S]*?)<\/h4>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      const lang = m[1];
      const hoster = cleanText(m[4]);
      if (!hoster) continue;
      if (!byLang[lang]) byLang[lang] = [];
      byLang[lang].push({ hoster: hoster, target: m[3], id: m[2] });
    }
    for (const k of Object.keys(byLang)) {
      byLang[k].sort((a, b) => {
        const ia = HOSTER_PRIORITY.indexOf(a.hoster);
        const ib = HOSTER_PRIORITY.indexOf(b.hoster);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    }
    return byLang;
  }

  function hosterHeaders(referer) {
    return {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
      Referer: referer || SITE + '/',
    };
  }

  async function resolveVidmoly(target) {
    const res = await followGet(SITE + target, {
      accept: 'text/html,*/*',
      headers: { Referer: SITE + '/' },
    });
    const body = (res && res.body) || '';
    if (!body || /just a moment|attention required|cloudflare/i.test(body)) return null;
    const file =
      (body.match(/sources:\s*\[\s*\{[\s\S]*?file:\s*['"]([^'"]+)['"]/i) || [])[1] || '';
    if (!file || file.indexOf('http') !== 0) return null;
    const kind = /\.m3u8(\?|$)/i.test(file) ? 'hls' : 'mp4';
    return {
      url: file,
      kind: kind,
      container: kind === 'hls' ? 'hls' : '',
      headers: hosterHeaders('https://vidmoly.biz/'),
      provider: 'vidmoly',
      playable: true,
    };
  }

  async function resolveVoe(target) {
    const res = await followGet(SITE + target, {
      accept: 'text/html,*/*',
      headers: { Referer: SITE + '/' },
    });
    const body = (res && res.body) || '';
    if (!body || /just a moment|attention required|cloudflare/i.test(body)) return null;
    const mirror =
      (body.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i) || [])[1] || '';
    const embedUrl = mirror || (/^https?:\/\//i.test(res.url || '') ? res.url : '');
    if (!embedUrl) return null;
    const embed = await followGet(embedUrl, {
      accept: 'text/html,*/*',
      headers: { Referer: SITE + '/' },
    });
    const ebody = (embed && embed.body) || '';
    if (!ebody || /just a moment|attention required|cloudflare/i.test(ebody)) return null;
    const file =
      (ebody.match(/sources:\s*\[[\s\S]*?file:\s*['"]([^'"]+)['"]/i) || [])[1] ||
      (ebody.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i) || [])[0] ||
      '';
    if (!file || file.indexOf('http') !== 0) return null;
    const kind = /\.m3u8(\?|$)/i.test(file) ? 'hls' : 'mp4';
    return {
      url: file,
      kind: kind,
      container: kind === 'hls' ? 'hls' : '',
      headers: hosterHeaders(embedUrl),
      provider: 'voe',
      playable: true,
    };
  }

  async function resolveDoodstream(target) {
    const res = await followGet(SITE + target, {
      accept: 'text/html,*/*',
      headers: { Referer: SITE + '/' },
    });
    const body = (res && res.body) || '';
    const embedUrl = (res && res.url) || '';
    if (!body || !/^https?:/i.test(embedUrl) || /just a moment|attention required|cloudflare/i.test(body)) return null;
    const hostM = embedUrl.match(/^https?:\/\/([^/]+)/i);
    const host = hostM ? hostM[1] : '';
    if (!host) return null;
    const passPath = (body.match(/(\/pass_md5\/[A-Za-z0-9._\/-]+)/) || [])[1] || '';
    const token =
      (body.match(/[?&]token=([A-Za-z0-9._-]+)/) || [])[1] ||
      (body.match(/token['"]?\s*[:=]\s*['"]([A-Za-z0-9._-]+)['"]/i) || [])[1] ||
      '';
    if (!passPath) return null;
    const pass = await followGet('https://' + host + passPath, {
      accept: '*/*',
      headers: { Referer: embedUrl, 'User-Agent': USER_AGENT },
    });
    const prefix = (((pass && pass.body) || '').trim().split('\n')[0] || '').trim();
    if (!/^https?:\/\//.test(prefix)) return null;
    let rnd = '';
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 10; i++) rnd += alphabet[Math.floor(Math.random() * alphabet.length)];
    const url = prefix + rnd + '?token=' + token + '&expiry=' + Date.now();
    return {
      url: url,
      kind: 'mp4',
      container: '',
      headers: hosterHeaders(embedUrl),
      provider: 'doodstream',
      playable: true,
    };
  }

  /* -------- Filemoon (byse) hoster — the 4th site server --------------------------------
   * The site's Filemoon links redirect to a byse SPA. The stream config comes from a
   * public JSON API: GET /api/videos/<code> -> playback {algorithm: AES-256-GCM, iv,
   * payload, key_parts, version}. Key = b64u(key_parts[v-1]) || b64u(key_parts[31-v-1]),
   * payload = ciphertext||tag. The decrypt below is a self-contained, dependency-free
   * AES-256-GCM (FIPS-197 checked) using plain-Array byte math — no TypedArrays, no atob,
   * no crypto.subtle — matching the module runtime's constraints. */
  var _FM_SBOX = (function () {
    function rotl8(x, s) { return ((x << s) | (x >>> (8 - s))) & 0xff; }
    var sbox = new Array(256);
    var p = 1, q = 1;
    do {
      p = (p ^ ((p << 1) & 0xff) ^ ((p & 0x80) ? 0x1b : 0)) & 0xff;
      q = q ^ (q << 1);
      q = q ^ (q << 2);
      q = q ^ (q << 4);
      q = q & 0xff;
      if (q & 0x80) q = q ^ 0x09;
      sbox[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
    } while (p !== 1);
    sbox[0] = 0x63;
    return sbox;
  })();
  var _FM_RCON = (function () {
    var r = [0];
    for (var i = 1; i <= 10; i++) { var v = (r[i - 1] === 0) ? 1 : (r[i - 1] << 1); r[i] = (v > 0xff) ? (v ^ 0x11b) & 0xff : v; }
    return r;
  })();
  function _fmExpandKey(key) {
    var Nk = 8, Nr = 14, w = [], i;
    for (i = 0; i < Nk; i++) w[i] = (((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0);
    for (i = Nk; i < 4 * (Nr + 1); i++) {
      var t = w[i - 1];
      if (i % Nk === 0) {
        t = (((_FM_SBOX[(t >>> 16) & 0xff] << 24) | (_FM_SBOX[(t >>> 8) & 0xff] << 16) | (_FM_SBOX[t & 0xff] << 8) | _FM_SBOX[(t >>> 24) & 0xff]) >>> 0) ^ (_FM_RCON[(i / Nk) | 0] << 24);
      } else if (i % Nk === 4) {
        t = (((_FM_SBOX[(t >>> 24) & 0xff] << 24) | (_FM_SBOX[(t >>> 16) & 0xff] << 16) | (_FM_SBOX[(t >>> 8) & 0xff] << 8) | _FM_SBOX[t & 0xff]) >>> 0);
      }
      w[i] = (w[i - Nk] ^ t) >>> 0;
    }
    return w;
  }
  function _fmEncryptBlock(w, block) {
    var s = block.slice();
    function xt(b) { return ((b << 1) & 0xff) ^ ((b & 0x80) ? 0x1b : 0); }
    function addRoundKey(round) {
      var wb = [w[round * 4], w[round * 4 + 1], w[round * 4 + 2], w[round * 4 + 3]];
      for (var k = 0; k < 4; k++) {
        s[4 * k] ^= (wb[k] >>> 24) & 0xff;
        s[4 * k + 1] ^= (wb[k] >>> 16) & 0xff;
        s[4 * k + 2] ^= (wb[k] >>> 8) & 0xff;
        s[4 * k + 3] ^= wb[k] & 0xff;
      }
    }
    function subShift() {
      for (var k = 0; k < 16; k++) s[k] = _FM_SBOX[s[k]];
      var t = s.slice();
      for (var ro = 0; ro < 4; ro++) for (var c = 0; c < 4; c++) s[4 * ro + c] = t[4 * ((ro + c) % 4) + c];
    }
    function mixColumns() {
      for (var c = 0; c < 4; c++) {
        var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
        var x0 = a0 ^ a1 ^ a2 ^ a3;
        s[4 * c] = (a0 ^ x0 ^ xt(a0 ^ a1)) & 0xff;
        s[4 * c + 1] = (a1 ^ x0 ^ xt(a1 ^ a2)) & 0xff;
        s[4 * c + 2] = (a2 ^ x0 ^ xt(a2 ^ a3)) & 0xff;
        s[4 * c + 3] = (a3 ^ x0 ^ xt(a3 ^ a0)) & 0xff;
      }
    }
    var r;
    addRoundKey(0);
    for (r = 1; r < 14; r++) { subShift(); mixColumns(); addRoundKey(r); }
    subShift(); addRoundKey(14);
    return s;
  }
  function _fmGfMul(x, y) {
    var z = [], v = x.slice(), i, j, lsb;
    for (i = 0; i < 16; i++) z[i] = 0;
    for (i = 0; i < 128; i++) {
      if ((y[(i >> 3)] >> (7 - (i & 7))) & 1) for (j = 0; j < 16; j++) z[j] = z[j] ^ v[j];
      lsb = v[15] & 1;
      for (j = 15; j > 0; j--) v[j] = ((v[j] >>> 1) | ((v[j - 1] & 1) << 7)) & 0xff;
      v[0] = v[0] >>> 1;
      if (lsb) v[0] = v[0] ^ 0xe1;
    }
    return z;
  }
  function _fmGhash(H, ct) {
    var y = [], i, j, off = 0;
    for (i = 0; i < 16; i++) y[i] = 0;
    while (off < ct.length) {
      var blk = [], have = Math.min(16, ct.length - off);
      for (j = 0; j < 16; j++) blk[j] = ((j < have ? ct[off + j] : 0) ^ y[j]);
      y = _fmGfMul(blk, H);
      off += 16;
    }
    var lenBlk = [], bitLen = ct.length * 8;
    for (j = 0; j < 16; j++) lenBlk[j] = 0;
    for (j = 15; j >= 8; j--) { lenBlk[j] = bitLen & 0xff; bitLen = Math.floor(bitLen / 256); }
    for (j = 0; j < 16; j++) lenBlk[j] = lenBlk[j] ^ y[j];
    return _fmGfMul(lenBlk, H);
  }
  function _fmInc32(counter) {
    var c = counter.slice();
    for (var i = 15; i >= 12; i--) { c[i] = (c[i] + 1) & 0xff; if (c[i] !== 0) break; }
    return c;
  }
  function _fmAesGcmOpen(key, iv, data) {
    if (key.length !== 32 || iv.length !== 12 || data.length < 16) return null;
    var w = _fmExpandKey(key), zero = [], i, j;
    for (i = 0; i < 16; i++) zero[i] = 0;
    var H = _fmEncryptBlock(w, zero);
    var J0 = iv.concat([0, 0, 0, 1]);
    var tag = data.slice(data.length - 16), ct = data.slice(0, data.length - 16);
    var g = _fmGhash(H, ct);
    var ek = _fmEncryptBlock(w, J0);
    var diff = 0;
    for (j = 0; j < 16; j++) diff |= (g[j] ^ ek[j] ^ tag[j]) & 0xff;
    if (diff !== 0) return null;
    var out = [], counter = J0.slice();
    for (var off = 0; off < ct.length; off += 16) {
      counter = _fmInc32(counter);
      var ks = _fmEncryptBlock(w, counter);
      for (j = 0; j < 16 && off + j < ct.length; j++) out.push(ct[off + j] ^ ks[j]);
    }
    return out;
  }
  function _fmB64u(str) {
    var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = [], buf = 0, bits = 0, i;
    for (i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '=') break;
      var v = chars.indexOf(c);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >>> bits) & 0xff); }
    }
    return out;
  }
  function _fmUtf8(bytes) {
    var s = '', i = 0;
    while (i < bytes.length) {
      var b = bytes[i++];
      if (b < 0x80) { s += String.fromCharCode(b); }
      else if (b >= 0xc0 && b < 0xe0) { s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f)); }
      else if (b >= 0xe0 && b < 0xf0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)); }
      else {
        var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return s;
  }
  function filemoonPlayback(pb) {
    try {
      if (!pb || String(pb.algorithm || '').toUpperCase().indexOf('GCM') < 0) return null;
      var parts = pb.key_parts;
      if (!parts || typeof parts.length !== 'number') return null;
      var v = Number(pb.version);
      if (!(v > 0 && v <= 20)) return null;
      var a = v, b = 31 - v;
      if (a < 1 || b < 1 || a > parts.length || b > parts.length) return null;
      var ka = _fmB64u(parts[a - 1]), kb = _fmB64u(parts[b - 1]);
      if (ka.length + kb.length !== 32) return null;
      var out = _fmAesGcmOpen(ka.concat(kb), _fmB64u(pb.iv), _fmB64u(pb.payload));
      if (!out) return null;
      return JSON.parse(_fmUtf8(out));
    } catch (_) { return null; }
  }
  async function resolveFilemoon(target) {
    const res = await followGet(SITE + target, {
      accept: 'text/html,*/*',
      headers: { Referer: SITE + '/' },
    });
    const finalUrl = (res && res.url) || '';
    const body = (res && res.body) || '';
    if (!finalUrl && !body) return null;
    let host = (String(finalUrl).match(/^https?:\/\/([^/]+)/i) || [])[1] || '';
    let code = (String(finalUrl).match(/\/(?:d|e)\/([A-Za-z0-9]+)/) || [])[1] || '';
    if (!code && body) code = (body.match(/\/(?:d|e)\/([A-Za-z0-9]{6,})/) || [])[1] || '';
    if (!host) host = (body.match(/https?:\/\/([^/'"\s]+)\/(?:d|e)\//) || [])[1] || '';
    if (!host || !code) return null;
    const origin = 'https://' + host;
    const apiUrl = origin + '/api/videos/' + code;
    const apiRes = await followGet(apiUrl, {
      accept: 'application/json,*/*',
      headers: { Referer: finalUrl || (origin + '/d/' + code), Origin: origin },
    });
    const raw = (apiRes && apiRes.body) || '';
    if (!raw || raw.charAt(0) !== '{') return null;
    let info = null;
    try { info = JSON.parse(raw); } catch (_) { return null; }
    const dec = filemoonPlayback(info && info.playback);
    const sources = (dec && dec.sources) || [];
    let url = '', kind = '';
    for (let i = 0; i < sources.length && !url; i++) {
      const s = sources[i] || {};
      if (typeof s.url !== 'string' || s.url.indexOf('http') !== 0) continue;
      if (/\.m3u8(\?|$)/i.test(s.url) || /mpegurl/i.test(String(s.mime_type || s.mimeType || ''))) { url = s.url; kind = 'hls'; }
    }
    if (!url) {
      for (let i = 0; i < sources.length && !url; i++) {
        const s = sources[i] || {};
        if (typeof s.url === 'string' && s.url.indexOf('http') === 0) { url = s.url; kind = 'mp4'; }
      }
    }
    if (!url) return null;
    return {
      url: url,
      kind: kind,
      container: kind === 'hls' ? 'hls' : '',
      headers: hosterHeaders(origin + '/'),
      provider: 'filemoon',
      playable: true,
    };
  }

  async function sniffHeight(url, headers) {
    try {
      const res = await settleWithin(
        request(url, {
          accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
          headers: headers,
        }),
        5000,
        null,
      );
      const body = (res && res.body) || '';
      const m = body.match(/RESOLUTION=(\d+)x(\d+)/i);
      if (m) return Number(m[2]) || 0;
    } catch (_) {}
    return 0;
  }

  /* -------- Vidhawk backbone (the Synthetiq Anime / Synthetiq Flux provider pattern) --------
   * Labelled last-resort in SUB mode only: JP audio with soft subtitles — German on a
   * share of titles, English broadly. German site hosters stay primary; this engages
   * only when the hoster race leaves fewer than two verified routes (or none). */
  const VIDHAWK = 'https://vidhawk.buzz';
  const CAPTION_LANG_ALIASES = {
    english: 'en', japanese: 'ja', spanish: 'es', portuguese: 'pt', french: 'fr', german: 'de',
    italian: 'it', russian: 'ru', arabic: 'ar', hindi: 'hi', korean: 'ko', chinese: 'zh',
    'chinese (simplified)': 'zh', 'chinese (traditional)': 'zh', indonesian: 'id', thai: 'th',
    turkish: 'tr', vietnamese: 'vi', dutch: 'nl', polish: 'pl', ukrainian: 'uk', czech: 'cs',
  };
  function captionLanguage(label) {
    const base = String(label || '').toLowerCase().split(/[(-]/)[0].replace(/\s+$/, '').trim();
    return CAPTION_LANG_ALIASES[base] || base || 'und';
  }
  function vidhawkHeaders(accept) {
    return { 'User-Agent': USER_AGENT, Accept: accept || 'application/json,*/*', Referer: VIDHAWK + '/', Origin: VIDHAWK };
  }
  async function fetchAniListIdForSlug(slug) {
    const key = String(slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key) return '';
    if (anilistIdCache[key] !== undefined) return anilistIdCache[key];
    let id = '';
    try {
      const res = await request('https://graphql.anilist.co', {
        method: 'POST',
        accept: 'application/json',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query: 'query($s:String){Media(search:$s,type:ANIME){id}}',
          variables: { s: String(slug || '').replace(/-/g, ' ') },
        }),
      });
      if (res.status >= 200 && res.status < 300) {
        try {
          const j = JSON.parse(res.body || '');
          id = j && j.data && j.data.Media && j.data.Media.id ? String(j.data.Media.id) : '';
        } catch (_) {}
      }
    } catch (_) {}
    anilistIdCache[key] = id;
    return id;
  }
  async function fetchVidhawkRoute(anilistId, epNum, deadline) {
    if (!anilistId || hostParked['vidhawk.buzz'] > Date.now()) return null;
    try {
      const race = await request(
        VIDHAWK + '/api/stream/race?episode=' + encodeURIComponent(String(epNum)) + '&audio=sub&server=flow&anilistId=' + encodeURIComponent(String(anilistId)),
        { accept: 'application/json', headers: vidhawkHeaders() },
      );
      if (!race.ok || !race.body) return null;
      let rd = null;
      try { rd = JSON.parse(race.body); } catch (_) { return null; }
      const ticket = rd && rd.ticket;
      if (!ticket) return null;
      const play = await request(VIDHAWK + '/api/play?t=' + encodeURIComponent(ticket), { accept: 'application/json', headers: vidhawkHeaders() });
      if (!play.ok || !play.body) return null;
      let data = null;
      try { data = JSON.parse(play.body); } catch (_) { return null; }
      const track = (data.tracks || []).find(function (row) { return row && row.id === 'sub' && row.src; });
      if (!track) return null;
      const caps = (data.captions && data.captions.sub) || [];
      const seenCaps = Object.create(null);
      const subtitles = [];
      caps.forEach(function (entry) {
        const url = entry && entry.src;
        if (!url || seenCaps[url]) return;
        seenCaps[url] = true;
        subtitles.push({ url: url, language: captionLanguage(entry.label || entry.lang || ''), label: cleanText(entry.label || 'Subtitle'), headers: vidhawkHeaders('*/*') });
      });
      // Verify before exposing: the provider's caption lists routinely include empty
      // placeholder files ("WEBVTT" with zero cues). Surface only captions with real
      // cues — an empty German track reads to the user as "subtitles do not display".
      const usable = [];
      for (let i = 0; i < subtitles.length; i++) {
        if (Date.now() >= deadline) break;
        const sub = subtitles[i];
        try {
          const vtt = await request(sub.url, { accept: 'text/vtt,*/*', headers: sub.headers });
          if (vtt && vtt.status >= 200 && vtt.status < 300 && vtt.body && (vtt.body.match(/-->/g) || []).length >= 3) usable.push(sub);
        } catch (_) {}
      }
      // German captions are preferred on this German source: stable de-first order.
      const orderedSubs = [];
      for (let pass = 0; pass < 3; pass++) {
        const want = pass === 0 ? 'de' : pass === 1 ? 'en' : '';
        for (let i = 0; i < usable.length; i++) {
          const code = usable[i].language;
          if (pass < 2 ? code === want : (code !== 'de' && code !== 'en')) orderedSubs.push(usable[i]);
        }
      }
      const langs = [];
      orderedSubs.forEach(function (sub) { if (langs.indexOf(sub.language) === -1) langs.push(sub.language); });
      langs.sort(function (a, b) {
        const rank = function (code) { return code === 'de' ? 0 : code === 'en' ? 1 : 2; };
        return rank(a) - rank(b);
      });
      const langLabel = langs.slice(0, 4).map(function (code) { return code.toUpperCase(); }).join(',');
      return {
        name: 'Vidhawk',
        label: langLabel ? 'Vidhawk · subs: ' + langLabel : 'Vidhawk',
        url: track.src,
        streamType: 'hls',
        headers: vidhawkHeaders('application/vnd.apple.mpegurl,*/*'),
        subtitles: orderedSubs,
      };
    } catch (_) {
      log('vidhawk fallback unavailable');
      return null;
    }
  }

  async function extractStreamUrl(episodeHref, lang) {
    const label = String(lang || 'sub').toLowerCase();
    if (!/^(sub|dub)$/.test(label) || !slugFromHref(episodeHref) || !/^https:\/\/aniworld\.to\/anime\/stream\/[a-z0-9-]+\/(?:staffel-\d+\/episode-\d+|filme\/film-\d+)(?:[?#].*)?$/.test(toAbsolute(episodeHref))) return {streams:[]};
    const abs=toAbsolute(episodeHref);
    const cacheKey=label+'|'+abs;
    const cached=streamCache[cacheKey];
    if (cached && cached.expires>Date.now()) { log('stream cache hit ('+label+')'); return cached.value; }
    const deadline=Date.now()+24000;
    const res=await request(abs,{accept:'text/html,*/*'});
    const groups=parseHosterLinks(res.body||'');
    // German captions are preferred for this German source. Never fall back to dubbed speech for Sub.
    const keys=label==='dub'?['1']:['3','2'];
    const candidates=[];
    for (const key of keys) {
      for (const link of groups[key]||[]) {
        const hoster=String(link.hoster||'');
        let resolver=null;
        if (/vidmoly/i.test(hoster)) resolver=resolveVidmoly;
        else if (/voe/i.test(hoster)) resolver=resolveVoe;
        else if (/dood|playmogo/i.test(hoster)) resolver=resolveDoodstream;
        else if (/filemoon|byse/i.test(hoster)) resolver=resolveFilemoon;
        if (resolver) candidates.push({link:link,key:key,resolver:resolver});
      }
    }
    // Bounded race (Synthetiq first-ready pattern): up to three hoster resolvers run
    // concurrently; the first verified route leads and the rest get a short grace
    // window as extra server choices.
    const resolved=[];
    const seenRoute=Object.create(null);
    let cursor=0;
    let firstVerifiedAt=0;
    async function worker() {
      while (true) {
        if (Date.now()>=deadline) return;
        if (firstVerifiedAt && Date.now()>=firstVerifiedAt+3500) return;
        const c=candidates[cursor++];
        if (!c) return;
        try {
          const route=await c.resolver(c.link.target);
          if (!route || Date.now()>=deadline) continue;
          route.name=c.link.hoster+' '+LANG_LABELS[c.key];
          route.streamType=route.kind;
          route.subtitleLanguage=c.key==='3'?'de':c.key==='2'?'en':undefined;
          route._tier=c.key==='3'?0:1;
          const checked=await globalThis.__trioMedia.check(route,deadline);
          if (checked && checked.url && !seenRoute[checked.url]) {
            seenRoute[checked.url]=true;
            resolved.push(checked);
            if (!firstVerifiedAt) firstVerifiedAt=Date.now();
          }
        } catch (_) {}
      }
    }
    await Promise.all(Array.from({length:Math.min(3,candidates.length)},worker));
    // Subtitles-only backbone: Vidhawk joins in SUB mode whenever no route carries a
    // German caption track (site hosters ship none — the usual case), and its VERIFIED
    // captions attach to every route so the German track stays pickable even when the
    // media relay cannot serve a stream (captions ride a separate endpoint). Its own
    // stream remains a labelled extra server.
    if (label==='sub' && Date.now()<deadline-4000 && !resolved.some(function (r) { return (r.subtitles||[]).some(function (s) { return s.language === 'de'; }); })) {
      try {
        const slug=slugFromHref(episodeHref);
        const epNum=(String(episodeHref).match(/episode-(\d+)/)||[])[1];
        if (slug && epNum) {
          const anilistId=await fetchAniListIdForSlug(slug);
          if (anilistId && Date.now()<deadline-2000) {
            const route=await fetchVidhawkRoute(anilistId,epNum,deadline);
            if (route) {
              const captions=(route.subtitles||[]);
              if (captions.length) {
                for (let i=0;i<resolved.length;i++) {
                  const row=resolved[i];
                  if (!row.subtitles || !row.subtitles.length) row.subtitles=captions.slice();
                }
              }
              const checked=await globalThis.__trioMedia.check(route,deadline);
              if (checked && checked.url && !seenRoute[checked.url]) {
                seenRoute[checked.url]=true;
                if (!checked.subtitles || !checked.subtitles.length) checked.subtitles=captions.slice();
                checked._tier=2;
                resolved.push(checked);
                log('vidhawk fallback attached ('+(route.label||'')+')');
              } else if (captions.length) {
                log('vidhawk captions attached without route');
              }
            }
          }
        }
      } catch (_) { log('vidhawk fallback unavailable'); }
    }
    // Deterministic route order: the German-sub route leads, then the English-sub
    // route, then the captions backbone — never first-to-resolve randomness.
    const ordered=[];
    for (let tier=0;tier<3;tier++) {
      for (let i=0;i<resolved.length;i++) {
        const row=resolved[i];
        if ((row._tier===undefined?2:row._tier)===tier) { delete row._tier; ordered.push(row); }
      }
    }
    const value=globalThis.__trioMedia.result(ordered,label);
    if (value && (value.streams||[]).length) streamCache[cacheKey]={expires:Date.now()+240000,value:value};
    else streamCache[cacheKey]={expires:Date.now()+20000,value:value};
    log('resolved '+resolved.length+' route(s) for '+label);
    return value;
  }

  /* -------------------- discovery -------------------- */

  const HOME_LABEL_MAP = {
    'Beliebt bei AniWorld': { id: 'home-popular', style: 'hero', feed: 'popular' },
    'Neue Animes': { id: 'home-new', style: 'poster', feed: 'new' },
    'Derzeit beliebt': { id: 'home-trending', style: 'top10', feed: 'popular' },
    'Das sehen andere AniWorld Nutzer': { id: 'home-social', style: 'poster', feed: 'popular' },
  };

  async function discoveryHome() {
    const [homeRes, popRes, kataRes, actionRes] = await Promise.all([
      request(SITE + '/', { accept: 'text/html,*/*' }).catch(() => ({ body: '' })),
      request(SITE + '/beliebte-animes', { accept: 'text/html,*/*' }).catch(() => ({ body: '' })),
      request(SITE + '/katalog/A', { accept: 'text/html,*/*' }).catch(() => ({ body: '' })),
      request(SITE + '/genre/action', { accept: 'text/html,*/*' }).catch(() => ({ body: '' })),
    ]);

    const sections = [];
    const homeSections = parseHomeSections((homeRes && homeRes.body) || '');
    for (let i = 0; i < homeSections.length; i++) {
      const s = homeSections[i];
      const cfg = HOME_LABEL_MAP[s.heading];
      if (!cfg) continue;
      const cap = cfg.style === 'hero' ? 8 : cfg.style === 'top10' ? 10 : 30;
      sections.push({
        id: cfg.id,
        title: s.heading,
        style: cfg.style,
        items: s.items.slice(0, cap),
        viewAll: { mode: 'feed', feedId: cfg.feed },
      });
    }

    const popular = parseSeriesCards((popRes && popRes.body) || '').slice(0, 45);
    if (popular.length) {
      sections.push({
        id: 'popular',
        title: 'Beliebte Animes',
        style: 'top10',
        items: popular.slice(0, 10),
        viewAll: { mode: 'feed', feedId: 'popular' },
      });
    }

    const catalog = parseSeriesCards((kataRes && kataRes.body) || '').slice(0, 30);
    if (catalog.length) {
      sections.push({
        id: 'catalog',
        title: 'Browse A-Z',
        style: 'poster',
        items: catalog,
        viewAll: { mode: 'feed', feedId: 'catalog' },
      });
    }

    const action = parseSeriesCards((actionRes && actionRes.body) || '').slice(0, 30);
    if (action.length) {
      sections.push({
        id: 'genre-action',
        title: 'Action Anime',
        style: 'poster',
        items: action,
        viewAll: { mode: 'feed', feedId: 'genre:action' },
      });
    }

    return { sections: sections.slice(0, 12) };
  }

  const catalogCursors={1:{letter:0,inner:1}};
  const catalogResults=Object.create(null);
  async function discoveryFeed(feedId, page) {
    const id = String(feedId || '');
    const pageNum = Math.max(1, Number(page) || 1);

    if (id === 'popular' || id === 'trending') {
      if (pageNum > 1) return { items: [], page: pageNum, hasMore: false };
      const res = await request(SITE + '/beliebte-animes', { accept: 'text/html,*/*' });
      return { items: parseSeriesCards((res && res.body) || '').slice(0, 45), page: 1, hasMore: false };
    }

    if (id === 'new') {
      if (pageNum > 1) return { items: [], page: pageNum, hasMore: false };
      const res = await request(SITE + '/', { accept: 'text/html,*/*' });
      const hs = parseHomeSections((res && res.body) || '');
      let items = [];
      for (let i = 0; i < hs.length; i++) {
        if (hs[i].heading === 'Neue Animes') {
          items = hs[i].items;
          break;
        }
      }
      return { items: items.slice(0, 30), page: 1, hasMore: false };
    }

    if (id === 'catalog') {
      if (pageNum>300) return {items:[],page:pageNum,hasMore:false};
      for(let n=1;n<=pageNum;n++){
        if(catalogResults[n])continue;
        const cursor=catalogCursors[n];
        if(!cursor || cursor.letter>=LETTERS.length)return {items:[],page:pageNum,hasMore:false};
        const base=SITE+'/katalog/'+LETTERS[cursor.letter];
        const res=await request(base+(cursor.inner>1?'/'+cursor.inner:''),{accept:'text/html,*/*'});
        const html=res.body||'';
        const hasNext=html.indexOf(base+'/'+(cursor.inner+1)+'"')>=0;
        const next=hasNext?{letter:cursor.letter,inner:cursor.inner+1}:{letter:cursor.letter+1,inner:1};
        catalogCursors[n+1]=next;
        catalogResults[n]={items:parseSeriesCards(html),page:n,hasMore:next.letter<LETTERS.length};
      }
      return catalogResults[pageNum];
    }

    if (id.indexOf('genre:') === 0) {
      const slug = id.slice(6);
      const url =
        SITE + '/genre/' + encodeURIComponent(slug) + (pageNum > 1 ? '/' + pageNum : '');
      const res = await request(url, { accept: 'text/html,*/*' });
      const items = parseSeriesCards((res && res.body) || '').slice(0, 30);
      return { items: items, page: pageNum, hasMore: items.length >= 30 };
    }

    return { items: [], page: pageNum, hasMore: false };
  }

  /* -------------------- exports -------------------- */

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
