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
    // External audio and subtitle renditions require their master playlist.
    const externalRenditions=r.body.split(/\r?\n/).some(line=>{
      if (!/^\s*#EXT-X-MEDIA:/i.test(line)) return false;
      const attrs={};
      const re=/(?:^|,)\s*([A-Z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/gi;
      let match;
      const list=line.slice(line.indexOf(':')+1);
      while ((match=re.exec(list))) attrs[match[1].toUpperCase()]=match[2].trim().replace(/^"|"$/g,'');
      return /^(?:AUDIO|SUBTITLES)$/i.test(attrs.TYPE||'') && !!attrs.URI;
    });
    if (externalRenditions) return Object.assign({},candidate,{url:r.url,streamType:'hls',qualities:[{label:'Auto',url:r.url,headers}]});
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

(function () {
  'use strict';

  const BASE_URL = 'https://www.animeunity.co';
  const VIX_BASE = 'https://vixcloud.co';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  let sessionPromise = null;
  let sessionCache = null;
  let archiveQueue = Promise.resolve();
  const showCache = {};
  const episodeCache = {};
  const companionCache = {};

  function log(msg) {
    if (typeof console !== 'undefined' && console.log) {
      console.log('[AnimeUnity] ' + msg);
    }
  }

  function cleanText(t) {
    if (!t) return '';
    return String(t)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .trim();
  }

  async function parseJson(res) {
    if (!res) return null;
    if (typeof res.json === 'function') {
      try {
        const j = await res.json();
        if (j !== undefined && j !== null) return j;
      } catch (_) {}
    }
    if (res.json !== undefined && res.json !== null && typeof res.json === 'object') {
      return res.json;
    }
    let body = '';
    if (typeof res.text === 'function') {
      try {
        body = await res.text();
      } catch (_) {}
    }
    if (!body && typeof res.body === 'string') {
      body = res.body;
    }
    if (body && typeof body === 'string' && body.trim()) {
      try {
        return JSON.parse(body.trim());
      } catch (_) {}
    }
    return null;
  }

  async function parseText(res) {
    if (!res) return '';
    if (typeof res.text === 'function') {
      try {
        const t = await res.text();
        if (typeof t === 'string') return t;
      } catch (_) {}
    }
    if (typeof res.body === 'string') {
      return res.body;
    }
    return '';
  }

  async function getSession(forceRefresh = false) {
    if (!forceRefresh && sessionCache && Date.now() - sessionCache.timestamp < 25 * 60 * 1000) {
      return sessionCache;
    }
    if (sessionPromise) {
      return sessionPromise;
    }

    sessionPromise = (async () => {
      try {
        const res = await globalThis.fetchv2(BASE_URL + '/', { 'User-Agent': USER_AGENT });
        const html = await parseText(res);
        const csrf = (html.match(/<meta name="csrf-token" content="([^"]+)"/i) || [])[1] || '';

        const rawCookies = (res && res.headers && res.headers['set-cookie']) || '';
        const cookies = [];
        if (Array.isArray(rawCookies)) {
          for (let i = 0; i < rawCookies.length; i++) {
            cookies.push(rawCookies[i].split(';')[0]);
          }
        } else if (typeof rawCookies === 'string' && rawCookies) {
          const parts = rawCookies.split(/,(?=[^;]+=[^;]+)/);
          for (let i = 0; i < parts.length; i++) {
            cookies.push(parts[i].split(';')[0].trim());
          }
        }

        sessionCache = {
          csrf: csrf,
          cookieHeader: cookies.join('; '),
          timestamp: Date.now()
        };
        return sessionCache;
      } catch (e) {
        log('getSession error: ' + (e && e.message ? e.message : e));
        return { csrf: '', cookieHeader: '', timestamp: Date.now() };
      } finally {
        sessionPromise = null;
      }
    })();

    return sessionPromise;
  }

  function postArchive(payload) {
    // CSRF refreshes rotate the same session; serialize these small catalogue calls.
    const pending = archiveQueue.then(() => postArchiveRequest(payload));
    archiveQueue = pending.catch(() => {});
    return pending;
  }

  async function postArchiveRequest(payload, retry = true) {
    const session = await getSession();
    const headers = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'X-CSRF-TOKEN': session.csrf,
      'Cookie': session.cookieHeader,
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': BASE_URL,
      'Referer': BASE_URL + '/archivio'
    };

    const res = await globalThis.fetchv2(
      BASE_URL + '/archivio/get-animes',
      headers,
      'POST',
      JSON.stringify(payload)
    );

    if (res && res.status === 419 && retry) {
      log('CSRF token expired (419), refreshing session...');
      await getSession(true);
      return postArchiveRequest(payload, false);
    }

    const json = await parseJson(res);
    return json || {};
  }

  function normalize(value) {
    return String(value || '')
      .replace(/\[(?:[^\]]*\b(?:sub|dub|ita|eng|english|spanish|french|german|arabic|hindi)\b[^\]]*)\]/gi, ' ')
      .replace(/\((?:ita|sub|dub)\)/gi, ' ')
      .normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
  }

  function cleanQuery(q) {
    return String(q || '')
      .replace(/[’‘`]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[:\-–—._!?]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseSeasonNumber(str) {
    if (!str) return null;
    const m = String(str).match(/\b(?:season|s|stagione)\s*(\d+)\b/i) ||
              String(str).match(/\bpart\s*(\d+)\b/i) ||
              String(str).match(/\b(\d+)(?:st|nd|rd|th)\s*season\b/i) ||
              String(str).match(/\b2nd\s*season\b/i) ||
              String(str).match(/\b3rd\s*season\b/i) ||
              String(str).match(/\b4th\s*season\b/i);
    if (m) {
      if (m[0].toLowerCase().includes('2nd')) return 2;
      if (m[0].toLowerCase().includes('3rd')) return 3;
      if (m[0].toLowerCase().includes('4th')) return 4;
      return parseInt(m[1], 10);
    }
    return null;
  }

  function chooseBestTitle(r) {
    // Display source identity, never rename sequels/specials to the user's query.
    return [r.title_it, r.title_eng, r.title, r.slug ? r.slug.replace(/-/g, ' ') : '']
      .map(cleanText).find(Boolean) || 'Anime';
  }

  function mapRecordToCard(r, rank, query) {
    const isDub = r.dub === 1 || r.dub === true || r.dub === '1';
    const rawTitle = chooseBestTitle(r, query);
    const tag = isDub
      ? (rawTitle.indexOf('ITA') < 0 ? ' [ITA DUB]' : '')
      : (rawTitle.indexOf('SUB') < 0 ? ' [ITA SUB]' : '');
    const href = '/anime/' + r.id + '-' + (r.slug || 'anime');
    const poster = r.imageurl || r.imageurl_cover || '';
    const banner = r.imageurl_cover || r.imageurl || '';

    // Prime cache
    showCache[href] = {
      id: String(r.id),
      slug: r.slug || '',
      episodesCount: r.real_episodes_count || r.episodes_count || 0,
      title: rawTitle + tag,
      rawTitle: rawTitle,
      plot: r.plot || '',
      poster: poster,
      banner: banner,
      date: r.date || '',
      status: r.status || '',
      score: r.score || undefined,
      dub: isDub,
      type: r.type || 'TV',
      savedAt: Date.now()
    };

    return {
      id: href,
      href: href,
      title: rawTitle + tag,
      name: rawTitle + tag,
      image: poster,
      poster: poster,
      posterUrl: poster,
      cover: poster,
      coverUrl: poster,
      backdrop: banner,
      backdropUrl: banner,
      type: r.type || 'TV',
      status: r.status === 'Terminato' ? 'Completed' : (r.status === 'In corso' ? 'Ongoing' : (r.status || '')),
      score: r.score ? String(r.score) : undefined,
      description: r.plot || '',
      synopsis: r.plot || '',
      language: isDub ? 'Italian (Dub)' : 'Italian (Sub)',
      rank: rank
    };
  }

  async function searchResults(keyword, page = 0) {
    try {
      const rawQ = typeof keyword === 'string' ? keyword.trim() : '';
      if (!rawQ) {
        const json = await postArchive({
          title: '',
          type: false,
          year: false,
          order: 'popolarita',
          status: false,
          genres: false,
          offset: (page || 0) * 30,
          dubbed: false,
          season: false
        });
        const records = (json && json.records) || [];
        return records.map((r, idx) => mapRecordToCard(r, idx + 1, ''));
      }

      const qClean = cleanQuery(rawQ);
      const qSeason = parseSeasonNumber(rawQ);
      const isMovieQuery = /\b(movie|film|il film)\b/i.test(rawQ);

      const queries = [rawQ];
      if (qClean && qClean !== rawQ) queries.push(qClean);

      const words = qClean.split(/\s+/).filter(w => w.length > 1);
      if (words.length >= 2) queries.push(words.slice(0, 2).join(' '));
      if (words.length >= 3) queries.push(words.slice(0, 3).join(' '));

      const lowerQ = rawQ.toLowerCase();
      if (lowerQ.includes('parasyte')) queries.push('Kiseijuu', 'Parasyte');
      if (lowerQ.includes('your name')) queries.push('Kimi no Na wa', 'Your Name');
      if (lowerQ.includes('howl')) queries.push('Il castello errante di Howl', 'Howl');
      if (lowerQ.includes('k-on')) queries.push('K-ON! 2', 'K-On', 'K-On!!');
      if (lowerQ.includes('saiki')) queries.push('Saiki Kusuo', 'Saiki');
      if (lowerQ.includes('fire force')) queries.push('Fire Force 2', 'Fire Force', 'Enen no Shouboutai');
      if (lowerQ.includes('princess mononoke')) queries.push('Principessa Mononoke', 'Mononoke');
      if (lowerQ.includes('legend of the galactic heroes')) queries.push('Ginga Eiyuu Densetsu', 'Legend of the Galactic Heroes');
      if (lowerQ.includes('gto') || lowerQ.includes('great teacher onizuka')) queries.push('Great Teacher Onizuka', 'GTO');
      if (lowerQ.includes('tomorrow') || lowerQ.includes('joe')) queries.push('Rocky Joe 2', 'Rocky Joe', 'Ashita no Joe');
      if (lowerQ.includes('jojo')) queries.push('Le bizzarre avventure di JoJo', 'JoJo');
      if (lowerQ.includes('slime')) queries.push('That Time I Got Reincarnated as a Slime', 'Tensei shitara Slime');
      if (lowerQ.includes('gintama')) queries.push('Gintama 2', 'Gintama 3', 'Gintama');

      const uniqueQueries = [...new Set(queries.filter(Boolean))];
      const candidateMap = {};

      for (const query of uniqueQueries) {
        const res = await postArchive({
          title: query,
          type: false,
          year: false,
          order: 'popolarita',
          status: false,
          genres: false,
          offset: 0,
          dubbed: false,
          season: false
        });
        const records = (res && res.records) || [];
        for (const r of records) {
          if (r && r.id && !candidateMap[r.id]) {
            candidateMap[r.id] = r;
          }
        }
      }

      const candidates = Object.values(candidateMap);
      if (!candidates.length) return [];

      const validCandidates = candidates.filter(c => {
        const cAll = [c.title_eng || '', c.title_it || '', c.title || '', c.slug || ''].join(' ').toLowerCase();

        if (lowerQ.includes('k-on') && !cAll.includes('k-on') && !cAll.includes('keion')) return false;
        if (lowerQ.includes('gintama') && !cAll.includes('gintama')) return false;
        if (lowerQ.includes('fire force') && !cAll.includes('fire force') && !cAll.includes('enen')) return false;
        if (lowerQ.includes('frieren') && !cAll.includes('frieren')) return false;
        if (lowerQ.includes('slime') && !cAll.includes('slime')) return false;
        if (lowerQ.includes('tomorrow') && !cAll.includes('joe') && !cAll.includes('ashita')) return false;

        if (qSeason !== null) {
          const cSeason = parseSeasonNumber(cAll);
          if (qSeason === 2 && !cAll.includes(' 2') && !cAll.includes('ii') && !cAll.includes('ni no') && cSeason !== 2) return false;
          if (qSeason === 3 && !cAll.includes(' 3') && !cAll.includes('iii') && !cAll.includes('san no') && cSeason !== 3) return false;
          if (qSeason >= 4 && !cAll.includes(' 4') && !cAll.includes('iv') && cSeason !== 4) return false;
        }

        let matched = 0;
        for (const w of words.map(x => x.toLowerCase())) {
          if (cAll.includes(w)) matched++;
        }
        return matched >= 1;
      });

      if (!validCandidates.length) return [];

      const qWords = words.map(w => w.toLowerCase());
      const qLower = qClean.toLowerCase();

      validCandidates.sort((a, b) => {
        const aEng = (a.title_eng || '').toLowerCase();
        const aIt = (a.title_it || '').toLowerCase();
        const aTitle = (a.title || '').toLowerCase();
        const aSlug = (a.slug || '').toLowerCase();
        const aAll = [aEng, aIt, aTitle, aSlug].join(' ');

        const bEng = (b.title_eng || '').toLowerCase();
        const bIt = (b.title_it || '').toLowerCase();
        const bTitle = (b.title || '').toLowerCase();
        const bSlug = (b.slug || '').toLowerCase();
        const bAll = [bEng, bIt, bTitle, bSlug].join(' ');

        let aScore = 0;
        let bScore = 0;

        if (aEng === qLower || aTitle === qLower || aIt === qLower) aScore += 2000;
        if (bEng === qLower || bTitle === qLower || bIt === qLower) bScore += 2000;

        if (aEng.startsWith(qLower) || aTitle.startsWith(qLower)) aScore += 500;
        if (bEng.startsWith(qLower) || bTitle.startsWith(qLower)) bScore += 500;

        const aIsMovie = a.type === 'Movie' || aAll.includes('movie') || aAll.includes('film');
        const bIsMovie = b.type === 'Movie' || bAll.includes('movie') || bAll.includes('film');
        if (isMovieQuery) {
          if (aIsMovie) aScore += 800;
          if (bIsMovie) bScore += 800;
        } else {
          if (!aIsMovie) aScore += 800;
          if (!bIsMovie) bScore += 800;
        }

        if (qSeason !== null) {
          const aSeason = parseSeasonNumber(aAll);
          const bSeason = parseSeasonNumber(bAll);
          if (aSeason === qSeason || aAll.includes(String(qSeason))) aScore += 1000;
          if (bSeason === qSeason || bAll.includes(String(qSeason))) bScore += 1000;
        }

        for (const w of qWords) {
          if (aAll.includes(w)) aScore += 50;
          if (bAll.includes(w)) bScore += 50;
        }

        return bScore - aScore;
      });

      return validCandidates.map((r, idx) => mapRecordToCard(r, idx + 1, rawQ));
    } catch (e) {
      log('searchResults error: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  async function extractDetails(urlOrId) {
    try {
      let slug = '';
      let id = '';
      const str = String(urlOrId).replace(/^https?:\/\/[^\/]+/i, '');
      const m = str.match(/\/anime\/(\d+)(?:-([^/?#]+))?/i) || str.match(/^(\d+)(?:-([^/?#]+))?$/);
      if (m) {
        id = m[1];
        slug = m[2] || '';
      } else {
        id = str;
      }

      const cacheKey = '/anime/' + id + (slug ? '-' + slug : '');
      const cached = showCache[cacheKey];

      let anime = {};
      let totalEpisodes = 0;

      const pageUrl = BASE_URL + '/anime/' + id + (slug ? '-' + slug : '');
      const res = await globalThis.fetchv2(pageUrl, { 'User-Agent': USER_AGENT });
      const html = await parseText(res);

      const playerM = html.match(/<video-player anime="([^"]+)"/i);
      if (playerM) {
        try {
          anime = JSON.parse(
            playerM[1]
              .replace(/&quot;/g, '"')
              .replace(/&#039;/g, "'")
              .replace(/&amp;/g, '&')
          );
        } catch (_) {}
      }

      const countM = html.match(/episodes_count="(\d+)"/i);
      if (countM) {
        totalEpisodes = parseInt(countM[1], 10);
      } else {
        totalEpisodes = anime.real_episodes_count || anime.episodes_count || (cached && cached.episodesCount) || 0;
      }

      const rawTitle = cleanText(anime.title_eng || anime.title || anime.title_it || (cached && cached.title) || slug || '');
      const isDub = anime.dub == null ? !!(cached && cached.dub) : anime.dub === 1 || anime.dub === true || anime.dub === '1';
      const tag = isDub
        ? (rawTitle.indexOf('ITA') < 0 ? ' [ITA DUB]' : '')
        : (rawTitle.indexOf('SUB') < 0 ? ' [ITA SUB]' : '');
      const poster = anime.imageurl || anime.imageurl_cover || (cached && cached.poster) || '';
      const banner = anime.imageurl_cover || anime.imageurl || (cached && cached.banner) || '';

      const detailsObj = {
        id: cacheKey,
        href: cacheKey,
        seriesId: id,
        title: rawTitle + tag,
        rawTitle: rawTitle,
        name: rawTitle + tag,
        description: anime.plot || (cached && cached.plot) || '',
        synopsis: anime.plot || (cached && cached.plot) || '',
        poster: poster,
        posterUrl: poster,
        cover: poster,
        coverUrl: poster,
        backdrop: banner,
        backdropUrl: banner,
        banner: banner,
        status: anime.status === 'Terminato' ? 'Completed' : (anime.status === 'In corso' ? 'Ongoing' : (anime.status || '')),
        year: anime.date ? parseInt(anime.date, 10) : undefined,
        genres: Array.isArray(anime.genres) ? anime.genres.map(g => g.name || g) : [],
        rating: anime.score ? parseFloat(anime.score) : undefined,
        episodesCount: totalEpisodes,
        type: anime.type || (cached && cached.type) || 'TV',
        slug: anime.slug || slug || (cached && cached.slug) || '',
        dub: isDub
      };

      showCache[cacheKey] = Object.assign({}, detailsObj, { savedAt: Date.now() });
      return detailsObj;
    } catch (e) {
      log('extractDetails error: ' + (e && e.message ? e.message : e));
      return {
        id: String(urlOrId),
        title: 'Anime',
        description: '',
        episodesCount: 0,
        genres: []
      };
    }
  }

  async function extractEpisodes(seriesId) {
    try {
      const details = await extractDetails(seriesId);
      let id = details.seriesId || '';
      let slug = details.slug || '';
      const str = String(seriesId).replace(/^https?:\/\/[^\/]+/i, '');
      const m = str.match(/\/anime\/(\d+)(?:-([^/?#]+))?/i) || str.match(/^(\d+)(?:-([^/?#]+))?$/);
      if (m) {
        id = m[1];
        if (!slug) slug = m[2] || '';
      } else if (!id) {
        id = details.id.replace(/\D/g, '') || str;
      }
      if (!slug) slug = 'anime';

      const total = Math.max(1, details.episodesCount || 1);
      const chunkSize = 120;
      const totalChunks = Math.ceil(total / chunkSize);
      const chunkJobs = [];

      for (let i = 0; i < totalChunks; i++) {
        const start = 1 + i * chunkSize;
        const end = Math.min(total, (i + 1) * chunkSize);
        const chunkUrl = BASE_URL + '/info_api/' + id + '/' + slug + '?start_range=' + start + '&end_range=' + end;
        chunkJobs.push(() =>
          globalThis.fetchv2(chunkUrl, {
            'User-Agent': USER_AGENT,
            'X-Requested-With': 'XMLHttpRequest'
          }).then(async res => {
            const j = await parseJson(res);
            return j || {};
          }).catch(() => ({}))
        );
      }

      const chunkResults = [];
      for (let start = 0; start < chunkJobs.length; start += 3) {
        chunkResults.push(...await Promise.all(chunkJobs.slice(start, start + 3).map(job => job())));
      }
      const allEpisodes = [];
      const cleanSeriesTitle = details.rawTitle || details.title || slug;

      for (let c = 0; c < chunkResults.length; c++) {
        const eps = (chunkResults[c] && chunkResults[c].episodes) || [];
        for (let j = 0; j < eps.length; j++) {
          const ep = eps[j];
          if (!ep || !ep.id) continue;
          const cleanName = ep.file_name
            ? ep.file_name.replace(/\.mkv$/i, '').replace(/\.mp4$/i, '').replace(/_/g, ' ')
            : 'Episodio ' + ep.number;
          const num = Number(ep.number);
          if (!Number.isFinite(num) || num < 0 || allEpisodes.some(row => row.id === String(ep.id))) continue;

          const epHref = '/embed-url/' + ep.id + '?scws=' + (ep.scws_id || '') +
            '&ep=' + num + '&series=' + id + '&slug=' + slug + '&dub=' + (details.dub ? '1' : '0') +
            '&title=' + encodeURIComponent(cleanSeriesTitle);

          // Store in episode cache for smart SUB/DUB lookups
          episodeCache[String(ep.id)] = {
            id: String(ep.id),
            number: num,
            seriesId: String(id),
            slug: slug,
            dub: details.dub,
            title: cleanSeriesTitle,
            episodesCount: details.episodesCount
          };

          allEpisodes.push({
            id: String(ep.id),
            number: num,
            episodeNumber: num,
            season: 1,
            seasonNumber: 1,
            name: cleanName,
            title: cleanName,
            subAvailable: !details.dub,
            dubAvailable: !!details.dub,
            href: epHref
          });
        }
      }

      allEpisodes.sort((a, b) => a.number - b.number);
      return allEpisodes;
    } catch (e) {
      log('extractEpisodes error: ' + (e && e.message ? e.message : e));
      return [];
    }
  }

  async function findCompanionSeries(rawTitle, wantDub, currentEpsCount) {
    if (!rawTitle || rawTitle === 'Anime') return null;

    const clean = rawTitle
      .replace(/\s*\(ITA\)/gi, '')
      .replace(/\s*\[ITA\s*(?:DUB|SUB)\]/gi, '')
      .replace(/\s*ITA\s*$/gi, '')
      .trim();

    if (!clean || clean.length < 2) return null;

    const cacheKey = clean.toLowerCase() + '|' + (wantDub ? 'dub' : 'sub');
    if (companionCache[cacheKey]) {
      return companionCache[cacheKey];
    }

    try {
      const json = await postArchive({
        title: clean,
        type: false,
        year: false,
        order: 'popolarita',
        status: false,
        genres: false,
        offset: 0,
        dubbed: wantDub,
        season: false
      });

      const records = (json && json.records) || [];
      const targetTitleNorm = clean.toLowerCase();
      const candidates = records.filter(r => (r.dub === 1 || r.dub === true || r.dub === '1') === wantDub);

      if (!candidates.length) {
        return null;
      }

      // Filter candidates to ensure close title matching
      const matchingCandidates = candidates.filter(c => {
        const cTitle = (c.title_eng || c.title || c.title_it || c.slug || '').toLowerCase().replace(/\s*\(ita\)/g, '').trim();
        return normalize(cTitle) === normalize(targetTitleNorm);
      });

      if (!matchingCandidates.length) {
        return null;
      }

      matchingCandidates.sort((a, b) => {
        const aTitle = (a.title_eng || a.title || a.title_it || '').toLowerCase().replace(/\s*\(ita\)/g, '').trim();
        const bTitle = (b.title_eng || b.title || b.title_it || b.slug || '').toLowerCase().replace(/\s*\(ita\)/g, '').trim();
        let aScore = 0;
        let bScore = 0;
        if (aTitle === targetTitleNorm) aScore += 1000;
        if (bTitle === targetTitleNorm) bScore += 1000;
        if (currentEpsCount > 1) {
          const aCount = a.real_episodes_count || a.episodes_count || 1;
          const bCount = b.real_episodes_count || b.episodes_count || 1;
          if (aCount > 1) aScore += 500;
          if (bCount > 1) bScore += 500;
          aScore -= Math.abs(aCount - currentEpsCount);
          bScore -= Math.abs(bCount - currentEpsCount);
        }
        return bScore - aScore;
      });

      const best = matchingCandidates[0] || null;
      if (best) {
        companionCache[cacheKey] = best;
      }
      return best;
    } catch (e) {
      log('findCompanionSeries error: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  async function resolveTargetEpisodeId(episodeHref, requestedLang) {
    const m = String(episodeHref).match(/^(?:https?:\/\/[^/]+)?\/embed-url\/(\d+)(?:[?#]|$)/i) || String(episodeHref).match(/^(\d+)$/);
    if (!m) return null;
    let epId = m[1];

    // Read query params from href if present
    const epMatch = String(episodeHref).match(/[?&]ep=(\d+(?:\.\d+)?)(?:&|$)/i);
    const epNumber = epMatch ? Number(epMatch[1]) : null;
    const dubMatch = String(episodeHref).match(/[?&]dub=([01])/i);
    const hrefIsDub = dubMatch ? dubMatch[1] === '1' : null;
    const titleMatch = String(episodeHref).match(/[?&]title=([^&]+)/i);
    const hrefTitle = titleMatch ? decodeURIComponent(titleMatch[1]) : '';
    const seriesMatch = String(episodeHref).match(/[?&]series=(\d+)/i);
    const hrefSeriesId = seriesMatch ? seriesMatch[1] : '';

    const cachedEp = episodeCache[epId];
    const currentIsDub = hrefIsDub !== null ? hrefIsDub : (cachedEp ? cachedEp.dub : false);
    const targetIsDub = requestedLang === 'dub';

    // If requested language matches current series language, use original episode ID
    if (currentIsDub === targetIsDub) return epId;
    if (epNumber === null) return null;

    // Determine series title
    let seriesTitle = hrefTitle || (cachedEp ? cachedEp.title : '');
    let totalEps = cachedEp ? cachedEp.episodesCount : 100;

    if (!seriesTitle && hrefSeriesId) {
      const d = await extractDetails(hrefSeriesId);
      seriesTitle = d.rawTitle || d.title || '';
      totalEps = d.episodesCount || totalEps;
    }

    // Attempt to switch to companion SUB or DUB series
    const companion = await findCompanionSeries(seriesTitle, targetIsDub, totalEps);

    if (companion && companion.id) {
      log('Switching to companion ' + (targetIsDub ? 'DUB' : 'SUB') + ' series: ' + companion.id + ' (' + (companion.title_eng || companion.title) + ') for Ep ' + epNumber);
      const compSlug = companion.slug || 'anime';
      const chunkRes = await globalThis.fetchv2(
        BASE_URL + '/info_api/' + companion.id + '/' + compSlug + '?start_range=' + epNumber + '&end_range=' + epNumber,
        { 'User-Agent': USER_AGENT, 'X-Requested-With': 'XMLHttpRequest' }
      );
      const chunkData = await parseJson(chunkRes);
      const eps = (chunkData && chunkData.episodes) || [];
      const exactEp = eps.find(e => Number(e.number) === epNumber);
      if (exactEp && exactEp.id) {
        log('Found companion episode ID: ' + exactEp.id + ' (scws: ' + exactEp.scws_id + ')');
        return String(exactEp.id);
      }
    }

    // If DUB was requested on a SUB anime and no companion Italian DUB exists, return null so we don't return Japanese audio as DUB
    if (targetIsDub && !currentIsDub) {
      log('No Italian DUB available for this anime. DUB stream will not be returned.');
      return null;
    }

    return null;
  }

  function playlistSubtitles(text, base, headers) {
    const rows = [];
    const seen = {};
    for (const line of text.split(/\r?\n/)) {
      if (!/^#EXT-X-MEDIA:/.test(line)) continue;
      const attributes = {};
      line.replace(/([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g, (_, key, value) => {
        attributes[key] = value.replace(/^"|"$/g, '');
        return '';
      });
      if (attributes.TYPE !== 'SUBTITLES' || !attributes.URI) continue;
      const url = globalThis.__trioMedia.absolute(attributes.URI, base);
      if (!/^https:\/\//i.test(url) || seen[url]) continue;
      seen[url] = true;
      rows.push({url, file: url, label: attributes.NAME || attributes.LANGUAGE || 'Subtitles',
        language: attributes.LANGUAGE || 'und', kind: 'subtitles',
        default: attributes.DEFAULT === 'YES', headers});
    }
    return rows;
  }

  async function extractStreamUrl(episodeHref, lang = 'sub') {
    const empty = {streams: [], servers: [], subtitles: [], lang};
    try {
      if (lang !== 'sub' && lang !== 'dub') return empty;
      const episodeId = await resolveTargetEpisodeId(episodeHref, lang);
      if (!episodeId) return empty;
      const embedRes = await globalThis.fetchv2(BASE_URL + '/embed-url/' + episodeId, {
        'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/'
      });
      const embedUrl = (await parseText(embedRes)).trim();
      const embedHost = embedUrl.match(/^(https:\/\/vixcloud\.(?:co|cc))\/embed\//i);
      if (!embedHost) return empty;
      const playerOrigin = embedHost[1];
      const vixRes = await globalThis.fetchv2(embedUrl, {
        'User-Agent': USER_AGENT, 'Referer': BASE_URL + '/'
      });
      const html = await parseText(vixRes);
      const token = (html.match(/['"]token['"]:\s*['"]([^'"]+)['"]/i) || [])[1];
      const expires = (html.match(/['"]expires['"]:\s*['"]([^'"]+)['"]/i) || [])[1];
      const asn = (html.match(/['"]asn['"]:\s*['"]([^'"]*)['"]/i) || [])[1] || '';
      const videoId = (embedUrl.match(/\/embed\/(\d+)/) || [])[1];
      if (!token || !expires || !videoId) return empty;
      let sources = [];
      const streamsMatch = html.match(/window\.streams\s*=\s*(\[[\s\S]*?\])\s*;/i);
      if (streamsMatch) {
        try { sources = JSON.parse(streamsMatch[1]); } catch (_) {}
      }
      sources = sources.filter(row => row && /^https:\/\/vixcloud\.(?:co|cc)\/playlist\//i.test(String(row.url || '')));
      if (!sources.length) sources = ['ub', 'ab', 'b'].map((key, i) => ({
        name: 'Server ' + (i + 1), url: playerOrigin + '/playlist/' + videoId + '?' + key + '=1'
      }));
      const active = row => row.active === true || row.active === 1 || row.active === '1';
      sources.sort((a, b) => Number(active(b)) - Number(active(a)));
      const headers = {'User-Agent': USER_AGENT, 'Referer': embedUrl, 'Origin': playerOrigin};
      const fullHD = /canPlayFHD\s*=\s*true/i.test(html) || /[?&]canPlayFHD=1/i.test(embedUrl);
      const deadline = Date.now() + 22000;
      const rows = [], seen = {};
      for (const source of sources.slice(0, 6)) {
        if (Date.now() >= deadline || seen[source.url]) continue;
        seen[source.url] = true;
        const params = ['token=' + encodeURIComponent(token), 'expires=' + encodeURIComponent(expires)];
        if (asn) params.push('asn=' + encodeURIComponent(asn));
        if (fullHD) params.push('h=1');
        const url = source.url + (source.url.includes('?') ? '&' : '?') + params.join('&');
        const playlist = await globalThis.__trioMedia.get(url, headers, deadline, false);
        if (!playlist || !/^\s*#EXTM3U/.test(playlist.body)) continue;
        const checked = await globalThis.__trioMedia.check({
          url: playlist.url, headers, streamType: 'hls', kind: 'hls',
          name: cleanText(source.name) || 'VixCloud', provider: 'animeunity-vixcloud',
          subtitles: playlistSubtitles(playlist.body, playlist.url, headers)
        }, deadline);
        if (checked) rows.push(checked);
      }
      // The optional download route is checked, not assumed to be 1080p media.
      const download = (html.match(/window\.downloadUrl\s*=\s*['"]([^'"]+)['"]/i) || [])[1];
      if (download && /^https:\/\//i.test(download) && Date.now() < deadline) {
        const direct = await globalThis.__trioMedia.check({
          url: download, headers, streamType: 'mp4', kind: 'mp4',
          name: 'Direct download', provider: 'animeunity-vixcloud', subtitles: []
        }, deadline);
        if (direct) rows.push(direct);
      }
      return globalThis.__trioMedia.result(rows, lang);
    } catch (_) {
      log('Stream resolution failed; no substitute episode or language returned.');
      return empty;
    }
  }

  async function discoveryHome() {
    try {
      const [popRes, dubRes] = await Promise.all([
        postArchive({
          title: '',
          type: false,
          year: false,
          order: 'popolarita',
          status: false,
          genres: false,
          offset: 0,
          dubbed: false,
          season: false
        }),
        postArchive({
          title: '',
          type: false,
          year: false,
          order: 'popolarita',
          status: false,
          genres: false,
          offset: 0,
          dubbed: true,
          season: false
        })
      ]);

      const popRecords = (popRes && popRes.records) || [];
      const dubRecords = (dubRes && dubRes.records) || [];

      const sections = [];

      if (popRecords.length) {
        sections.push({
          id: 'featured',
          title: 'In Evidenza',
          style: 'hero',
          items: popRecords.slice(0, 8).map((r, i) => mapRecordToCard(r, i + 1))
        });

        sections.push({
          id: 'popular',
          title: 'I Più Popolari',
          style: 'poster',
          items: popRecords.slice(0, 24).map((r, i) => mapRecordToCard(r, i + 1)),
          viewAll: { mode: 'feed', feedId: 'popular' }
        });
      }

      if (dubRecords.length) {
        sections.push({
          id: 'dubbed',
          title: 'Doppiati in Italiano (ITA)',
          style: 'poster',
          items: dubRecords.slice(0, 24).map((r, i) => mapRecordToCard(r, i + 1)),
          viewAll: { mode: 'feed', feedId: 'dubbed' }
        });
      }

      return { sections: sections };
    } catch (e) {
      log('discoveryHome error: ' + (e && e.message ? e.message : e));
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedId, page = 1) {
    try {
      const p = Math.max(1, Number(page) || 1);
      const isDub = feedId === 'dubbed';
      const order = feedId === 'latest' ? 'data' : 'popolarita';

      const json = await postArchive({
        title: '',
        type: false,
        year: false,
        order: order,
        status: false,
        genres: false,
        offset: (p - 1) * 30,
        dubbed: isDub,
        season: false
      });

      const records = (json && json.records) || [];
      const total = (json && json.tot) || 0;

      return {
        items: records.map((r, i) => mapRecordToCard(r, (p - 1) * 30 + i + 1)),
        page: p,
        hasMore: p * 30 < total
      };
    } catch (e) {
      log('discoveryFeed error: ' + (e && e.message ? e.message : e));
      return { items: [], page: Number(page) || 1, hasMore: false };
    }
  }

  // Export to global scope
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      searchResults: searchResults,
      extractDetails: extractDetails,
      extractEpisodes: extractEpisodes,
      extractStreamUrl: extractStreamUrl,
      discoveryHome: discoveryHome,
      discoveryFeed: discoveryFeed
    };
  }
})();
