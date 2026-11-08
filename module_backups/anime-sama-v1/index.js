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
    // Single-route policy (2026-09-16): expose exactly ONE validated route. Returning
    // several servers let the app open a second concurrent stream over the first
    // (double-audio / "extra song" / audio-persists-on-pause reports). Prefer the first
    // validated route (Sibnet MP4 when healthy, else ansembed HLS); never offer two.
    return Object.assign({},first,{servers:[first],streams:first.qualities.flatMap(q=>[q.label,q.url])});
  }
  return {absolute,get,check,result};
})();

(() => {
  'use strict';

  const MODULE_NAME = 'AnimeSama';
  const SITE = 'https://anime-sama.to';
  const ANILIST_URL = 'https://graphql.anilist.co';
  const SIBNET_HOST = 'https://video.sibnet.ru';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

  const TIMEOUT_MS = 15000;

  // Curated popular French anime with official vertical portrait title covers and horizontal background banners
  const POPULAR_CATALOGUE = [
    {
      title: 'Attack on Titan',
      slug: 'shingeki-no-kyojin',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmneX.jpg'
    },
    {
      title: 'Demon Slayer',
      slug: 'demon-slayer',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-33MtJGsUSxga.jpg'
    },
    {
      title: 'Death Note',
      slug: 'death-note',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/1535.jpg'
    },
    {
      title: 'One Piece',
      slug: 'one-piece',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJmZqs.jpg'
    },
    {
      title: 'Solo Leveling',
      slug: 'solo-leveling',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/151807-37yfQA3ym8PA.jpg'
    },
    {
      title: 'Jujutsu Kaisen',
      slug: 'jujutsu-kaisen',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQBSkxWAAk83.jpg'
    },
    {
      title: 'My Hero Academia',
      slug: 'my-hero-academia',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21459-nYh85uj2Fuwr.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/21459-yeVkolGKdGUV.jpg'
    },
    {
      title: 'Chainsaw Man',
      slug: 'chainsaw-man',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx127230-DdP4vAdssLoz.png',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/127230-o8IRwCGVr9KW.jpg'
    },
    {
      title: 'Bleach',
      slug: 'bleach',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/269-08ar2HJOUAuL.jpg'
    },
    {
      title: 'Naruto',
      slug: 'naruto',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/20-HHxhPj5JD13a.jpg'
    },
    {
      title: 'Naruto Shippuden',
      slug: 'naruto-shippuden',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1735-kGfVm0YqCPcu.png',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/1735.jpg'
    },
    {
      title: 'Hunter x Hunter',
      slug: 'hunter-x-hunter-2011',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/11061-8WkkTZ6duKpq.jpg'
    },
    {
      title: 'Frieren',
      slug: 'frieren',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-ivXNJ23SM1xB.jpg'
    },
    {
      title: 'Fullmetal Alchemist: Brotherhood',
      slug: 'fullmetal-alchemist-brotherhood',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/5114-q0V5URebphSG.jpg'
    },
    {
      title: 'Spy x Family',
      slug: 'spy-x-family',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx140960-Kb6R5nYQfjmP.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/140960-Z7xSvkRxHKfj.jpg'
    },
    {
      title: 'Mushoku Tensei',
      slug: 'mushoku-tensei',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx108465-1ANspF1EWyFx.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/108465-RgsRpTMhP9Sv.jpg'
    },
    {
      title: 'Tokyo Revengers',
      slug: 'tokyo-revengers',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx120120-cWDmnmeEntSe.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/120120-UDYgoHA69peT.jpg'
    },
    {
      title: 'Black Clover',
      slug: 'black-clover',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx97940-fyh8o7gNbha0.png',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/97940-1URQdQ4U1a0b.jpg'
    },
    {
      title: 'Vinland Saga',
      slug: 'vinland-saga',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/101348-pivKKffCAwAY.jpg'
    },
    {
      title: '86 Eighty Six',
      slug: '86-eighty-six',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx116589-KawXHB6sApFt.jpg',
      bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/116589-SqwYWzaZCdD5.jpg'
    }
  ];

  // In-memory caches
  const detailsCache = Object.create(null);
  const episodesCache = Object.create(null);
  const streamCache = Object.create(null);

  function log(message) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(message || ''));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(ms) || 0)));
  }

  function settleWithin(promise, timeoutMs, fallback) {
    const waitMs = Math.max(1, Number(timeoutMs) || 0);
    return Promise.race([promise, sleep(waitMs).then(() => fallback)]);
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function normForMatch(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[’'`´:;.!?&,+()\[\]{}<>/\\|–—"]/g, ' ')
      .replace(/\bs\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function toAbsoluteUrl(value, base) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return 'https:' + raw;
    const root = base || SITE;
    if (raw.startsWith('/')) return root + raw;
    return root + '/' + raw;
  }

  function slugFromAnimeUrl(url) {
    const raw = String(url || '').split('?')[0].replace(/\/+$/, '');
    const match = raw.match(/\/catalogue\/([^/?#]+)/i);
    return match ? match[1] : raw.replace(/^https?:\/\/[^/]+\//, '');
  }

  /* ────────────────────────── HTTP Request Layer ────────────────────────── */

  async function requestText(url, extraHeaders = {}, timeoutMs = TIMEOUT_MS) {
    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json,*/*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      extraHeaders
    );

    const doFetch = async () => {
      try {
        let res = null;
        if (typeof fetchv2 === 'function') {
          res = await fetchv2(url, headers, 'GET', null);
        } else if (typeof fetch === 'function') {
          res = await fetch(url, { headers });
        }
        const status = Number((res && res.status) || 0);
        if (!res || (status && status >= 400)) {
          return { status, text: '', headers: (res && res.headers) || {} };
        }
        let text = '';
        if (res && typeof res.text === 'function') text = await res.text();
        if (!text && res && typeof res.body === 'string') text = res.body;
        return { status, text: String(text || ''), headers: (res && res.headers) || {} };
      } catch (err) {
        log('requestText error for ' + url + ': ' + (err && err.message ? err.message : String(err)));
        return { status: 0, text: '', headers: {} };
      }
    };

    return settleWithin(doFetch(), timeoutMs, { status: 0, text: '', headers: {} });
  }

  /* ────────────────────────── Home & Catalog Card Parser ────────────────────────── */

  function parseCardsFromHtml(html) {
    const out = [];
    const seen = new Set();
    const cardRe =
      /<a[^>]*href="([^"*]*catalogue\/[^"*]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = cardRe.exec(String(html || '')))) {
      const rawHref = match[1];
      const inner = match[2] || '';
      // Types describe the medium; genre tags such as Manhwa do not.
      const typeMatch = inner.match(/<div[^>]*class=["'][^"']*\btype-row\b[^"']*["'][^>]*>[\s\S]*?<p[^>]*class=["'][^"']*\binfo-value\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
      const types = typeMatch ? cleanText(typeMatch[1]).split(',').map(x => x.trim().toLowerCase()) : [];
      if (types.length && !types.some(x => x === 'anime' || x === 'film')) continue;
      if (/\/scans?(?:\/|$)/i.test(rawHref)) continue;
      const cleanHref = rawHref.split('?')[0].replace(/\/+$/, '') + '/';
      const seriesHref = cleanHref.replace(
        /(\/catalogue\/[^/?#]+)\/.*$/i,
        '$1/'
      );

      const slug = slugFromAnimeUrl(seriesHref);
      if (!slug || seen.has(slug)) continue;

      const imgMatch =
        inner.match(/src="([^"*]+contenu[^"*]+)"/i) || inner.match(/src="([^"*]+)"/i);
      let banner = imgMatch ? imgMatch[1].trim() : '';
      if (banner.includes('flag_') || banner.includes('logo_icon')) banner = '';

      const altMatch =
        inner.match(/<h2[^>]*class="[^"]*\bcard-title\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) ||
        inner.match(/alt="([^"*]+)"/i);
      let title = cleanText((altMatch && altMatch[1]) || '');

      if (!title || /^(vostfr|vf|va|var|vkr|vcn|vqc|vf1|vf2)$/i.test(title)) {
        title = slug
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }

      const pop = POPULAR_CATALOGUE.find((p) => p.slug === slug);
      const image = pop ? pop.image : (banner || `https://cdn.jsdelivr.net/gh/Anime-Sama/IMG@img/contenu/thumb/${slug}.webp`);
      const bannerImage = pop ? pop.bannerImage : (banner || image);

      seen.add(slug);
      out.push({
        title,
        slug,
        href: toAbsoluteUrl(seriesHref),
        image: toAbsoluteUrl(image),
        bannerImage: toAbsoluteUrl(bannerImage),
      });
    }

    return out;
  }

  async function getSiteCards(deadline = Date.now() + 18000) {
    const res = await requestText(SITE + '/', { Referer: SITE + '/' }, remaining(deadline, 6000));
    const parsed = await availableCards(parseCardsFromHtml(res.text).slice(0, 40), deadline);

    if (parsed.length > 0) {
      return parsed;
    }

    return [];
  }

  const remaining = (deadline, cap) => Math.max(1, Math.min(cap, deadline - Date.now()));
  const availabilityCache = Object.create(null);
  async function hasReleasedEpisodes(card, deadline = Date.now() + 18000) {
    if (Date.now() >= deadline) return false;
    const slug = card.slug || slugFromAnimeUrl(card.href);
    const collection = selectedPanel(card.href), cacheKey = slug + ':' + collection;
    const cached = availabilityCache[cacheKey];
    if (cached && Date.now() - cached.at < 300000) return cached.ok;
    const root = SITE + '/catalogue/' + slug + '/';
    const page = await requestText(root, { Referer: SITE + '/' }, remaining(deadline, 3000));
    let panels = parseSeasonPanels(page.text).filter(p => /\/(?:vostfr|vf[12]?)$/.test(p.path));
    if (collection) panels = panels.filter(p => p.path.replace(/\/(?:vostfr|vf[12]?)$/, '') === collection);
    else if (panels.some(p => /^saison\d+\//.test(p.path))) panels = panels.filter(p => /^saison\d+\//.test(p.path));
    let ok = false;
    // Probe only a small source-ordered prefix. A timeout/empty result is unknown,
    // omitted for this response and never negative-cached as unavailable.
    for (const panel of panels.slice(0, 3)) {
      if (Date.now() >= deadline) break;
      const key = slug + ':' + panel.path, existing = panelArrays[key];
      let arrays = existing && Date.now() - existing.time < 300000 ? existing.arrays : null;
      if (!arrays || !Object.keys(arrays).some(k => arrays[k].some(Boolean))) {
        const response = await requestText(root + panel.path + '/episodes.js', { Referer: root }, remaining(deadline, 2000));
        arrays = response.status === 200 ? parseEpsArrays(response.text) : {};
        if (Object.keys(arrays).some(k => arrays[k].some(Boolean))) panelArrays[key] = { time: Date.now(), arrays };
      }
      if (Object.keys(arrays).some(k => arrays[k].some(Boolean))) { ok = true; break; }
    }
    if (ok) availabilityCache[cacheKey] = { at: Date.now(), ok };
    return ok;
  }

  async function availableCards(cards, deadline = Date.now() + 18000) {
    const out = [];
    for (let i = 0; i < cards.length && Date.now() < deadline; i += 4) {
      const batch = cards.slice(i, i + 4);
      const available = await Promise.all(batch.map(card => hasReleasedEpisodes(card, deadline)));
      batch.forEach((card, n) => { if (available[n]) out.push(card); });
    }
    return out;
  }

  /* ────────────────────────── AniList Title & Artwork Resolver ────────────────────────── */

  async function queryAniListAliases(query) {
    try {
      const gqlQuery =
        'query($q:String){Media(search:$q,type:ANIME){id title{english romaji native}coverImage{extraLarge large}bannerImage}}';
      let res;
      if (typeof fetchv2 === 'function') {
        res = await fetchv2(
          ANILIST_URL,
          { 'Content-Type': 'application/json', Accept: 'application/json' },
          'POST',
          JSON.stringify({ query: gqlQuery, variables: { q: query } })
        );
      } else if (typeof fetch === 'function') {
        res = await fetch(ANILIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: gqlQuery, variables: { q: query } }),
        });
      }

      const body = res && typeof res.text === 'function' ? await res.text() : (res && res.body) || '';
      const data = JSON.parse(body);
      const media = data && data.data && data.data.Media;
      if (!media) return null;

      const romaji = media.title && media.title.romaji;
      const english = media.title && media.title.english;
      const cover = media.coverImage && (media.coverImage.extraLarge || media.coverImage.large);
      const banner = media.bannerImage || '';

      return {
        romaji: romaji || '',
        english: english || '',
        cover: cover || '',
        banner: banner || '',
        slugs: [
          slugify(query),
          romaji ? slugify(romaji) : '',
          english ? slugify(english) : '',
        ].filter(Boolean),
      };
    } catch (_) {
      return null;
    }
  }

  /* ────────────────────────── Search & Details ────────────────────────── */

  async function searchBase(query, deadline) {
    const term = String(query == null ? '' : query).trim();
    if (!term) {
      const cards = await getSiteCards(deadline);
      return cards.slice(0, 30).map((c) => ({
        id: c.href,
        href: c.href,
        title: c.title,
        image: c.image,
        poster: c.image,
        bannerImage: c.bannerImage,
        type: 'video',
      }));
    }

    const liveSearch=await requestText(SITE+'/catalogue/?search='+encodeURIComponent(term),{Referer:SITE+'/'},remaining(deadline, 6000));
    const liveCards=await availableCards(parseCardsFromHtml(liveSearch.text), deadline);
    if (liveCards.length) return liveCards;
    const normQ = normForMatch(term);
    const siteCards = await getSiteCards(deadline);
    const matches = [];
    const seenHrefs = new Set();

    // 1. Direct match against loaded catalog
    for (const card of siteCards) {
      const normT = normForMatch(card.title);
      const normS = normForMatch(card.slug.replace(/-/g, ' '));
      if (normT.includes(normQ) || normS.includes(normQ) || normQ.includes(normS)) {
        if (!seenHrefs.has(card.href)) {
          seenHrefs.add(card.href);
          matches.push({
            id: card.href,
            href: card.href,
            title: card.title,
            image: card.image,
            poster: card.image,
            bannerImage: card.bannerImage,
            type: 'video',
          });
        }
      }
    }

    if (matches.length > 0) return matches;

    // 2. Query AniList for aliases, vertical Title Covers and Background Covers
    if (Date.now() >= deadline) return [];
    const anilistInfo = await settleWithin(queryAniListAliases(term), remaining(deadline, 4000), null);
    const candidateSlugs = anilistInfo
      ? anilistInfo.slugs
      : [slugify(term)];

    for (const slug of candidateSlugs) {
      if (Date.now() >= deadline) break;
      const candidateUrl = `${SITE}/catalogue/${slug}/`;
      if (seenHrefs.has(candidateUrl)) continue;

      const pageRes = await requestText(candidateUrl, { Referer: SITE + '/' }, remaining(deadline, 3000));
      if (pageRes.status === 200 && await hasReleasedEpisodes({slug, href:candidateUrl}, deadline)) {
        const titleMatch = pageRes.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        const imgMatch =
          pageRes.text.match(
            /https:\/\/cdn\.jsdelivr\.net\/gh\/Anime-Sama\/IMG@img\/contenu\/[^"' \s)]+/gi
          ) || [];

        const title = cleanText((titleMatch && titleMatch[1]) || slug.replace(/-/g, ' '));
        const bannerImage = (anilistInfo && anilistInfo.banner) || imgMatch[0] || `https://cdn.jsdelivr.net/gh/Anime-Sama/IMG@img/contenu/thumb/${slug}.webp`;
        const image = (anilistInfo && anilistInfo.cover) || bannerImage;

        seenHrefs.add(candidateUrl);
        matches.push({
          id: candidateUrl,
          href: candidateUrl,
          title,
          image,
          poster: image,
          bannerImage,
          type: 'video',
        });
        break;
      }
    }

    if (matches.length > 0) return matches;

    // 3. Artwork catalogue fallback still requires live episode entries.
    for (const item of POPULAR_CATALOGUE) {
      const normT = normForMatch(item.title);
      const normS = normForMatch(item.slug.replace(/-/g, ' '));
      if (normT.includes(normQ) || normS.includes(normQ)) {
        const href = `${SITE}/catalogue/${item.slug}/`;
        if (!seenHrefs.has(href) && await hasReleasedEpisodes({slug:item.slug, href}, deadline)) {
          seenHrefs.add(href);
          matches.push({
            id: href,
            href,
            title: item.title,
            image: item.image,
            poster: item.image,
            bannerImage: item.bannerImage,
            type: 'video',
          });
        }
      }
    }

    return matches;
  }

  function selectedPanel(input) {
    const match=String(input||'').match(/\/catalogue\/[^/]+\/(.+?)(?:\/)?(?:[?#].*)?$/);
    return match?match[1].replace(/\/+$/,'').replace(/\/(?:vostfr|vf[12]?)$/,''):'';
  }
  async function searchResults(query) {
    const deadline = Date.now() + 18000;
    const cards=await searchBase(query, deadline);
    if(!String(query||'').trim())return cards;
    const out=cards.slice();
    for(const card of cards.slice(0,3)){
      if (Date.now() >= deadline) break;
      const root=card.href.replace(/\/+$/,'')+'/';
      const page=await requestText(root,{Referer:SITE+'/'},remaining(deadline, 3000));
      const panels=parseSeasonPanels(page.text),seen=Object.create(null);
      if(!panels.some(p=>/^saison\d+\//.test(p.path)))continue;
      for(const panel of panels){
        const base=panel.path.replace(/\/(?:vostfr|vf[12]?)$/,'');
        if(/^saison\d+$/.test(base)||seen[base]||!/(?:vostfr|vf[12]?)$/.test(panel.path))continue;
        seen[base]=true;
        if (!await hasReleasedEpisodes({slug:card.slug || slugFromAnimeUrl(card.href), href:root+panel.path+'/'}, deadline)) continue;
        out.push(Object.assign({},card,{id:root+panel.path+'/',href:root+panel.path+'/',title:card.title+' · '+panel.label}));
      }
    }
    return out;
  }

  async function extractDetails(urlOrId) {
    const inputSlug = slugFromAnimeUrl(toAbsoluteUrl(urlOrId));
    const url = SITE + '/catalogue/' + inputSlug + '/';
    const slug = slugFromAnimeUrl(url);
    if (!slug) throw new Error('Anime-Sama details missing valid URL');
    const collection=selectedPanel(urlOrId);
    if (detailsCache[slug+':'+collection]) return detailsCache[slug+':'+collection];

    const res = await requestText(url, { Referer: SITE + '/' }, 15000);
    const html = res.text;

    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = cleanText((titleMatch && titleMatch[1]) || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

    const synopsisMatch =
      html.match(/id="synopsisText"[^>]*>([\s\S]*?)<\/(?:p|div)>/i) ||
      html.match(/class="synopsis-text"[^>]*>([\s\S]*?)<\/(?:p|div)>/i) ||
      html.match(/<div class="synopsis-content"[^>]*>([\s\S]*?)<\/div>/i);
    let description = cleanText((synopsisMatch && synopsisMatch[1]) || '');

    if (!description) {
      const og = html.match(/property="og:description" content="([^"]+)"/i);
      description = cleanText((og && og[1]) || '');
    }

    const imgMatch = html.match(
      /https:\/\/cdn\.jsdelivr\.net\/gh\/Anime-Sama\/IMG@img\/contenu\/[^"' \s)]+/gi
    ) || [];

    const siteBanner = imgMatch[0] || `https://cdn.jsdelivr.net/gh/Anime-Sama/IMG@img/contenu/thumb/${slug}.webp`;

    // Check popular catalogue for pristine artwork
    const popularMatch = POPULAR_CATALOGUE.find((p) => p.slug === slug);
    let image = popularMatch ? popularMatch.image : '';
    let bannerImage = popularMatch ? popularMatch.bannerImage : siteBanner;

    // If not in popular list, query AniList for portrait cover & banner
    if (!image) {
      const anilistInfo = await queryAniListAliases(title || slug.replace(/-/g, ' '));
      if (anilistInfo && anilistInfo.cover) {
        image = anilistInfo.cover;
        if (anilistInfo.banner) bannerImage = anilistInfo.banner;
      } else {
        image = siteBanner;
      }
    }

    const panel=collection?parseSeasonPanels(html).find(p=>p.path.replace(/\/(?:vostfr|vf[12]?)$/,'')===collection):null;
    const details = {
      title:panel?title+' · '+panel.label:title,
      description: description || `Regarder ${title} en streaming VOSTFR et VF sur Anime-Sama.`,
      image,
      bannerImage,
      url,
      aliases: '',
    };

    detailsCache[slug+':'+collection] = details;
    return details;
  }

  /* ────────────────────────── Episode Extraction ────────────────────────── */

  function parseSeasonPanels(html) {
    const panels = [];
    const seen = Object.create(null);
    const re = /panneauAnime\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/gi;
    let match;

    while ((match = re.exec(String(html || '').replace(/<!--([\s\S]*?)-->|\/\*[\s\S]*?\*\//g, '')))) {
      const label = cleanText(match[1]);
      const path = String(match[2] || '').replace(/^\/+|\/+$/g, '');
      if (!path || path === 'url' || seen[path]) continue;
      seen[path] = true;
      panels.push({ label, path });
    }

    return panels;
  }

  function parseEpsArrays(jsText) {
    const out = {};
    const re = /var\s+(eps[0-9]+)\s*=\s*\[([\s\S]*?)\];/gi;
    let match;

    while ((match = re.exec(String(jsText || '')))) {
      const name = match[1].toLowerCase();
      const urls = [];
      const urlRe = /['"]([^'"]*)['"]/g;
      let urlMatch;
      while ((urlMatch = urlRe.exec(match[2]))) {
        urls.push(/^https?:\/\//i.test(urlMatch[1]) ? urlMatch[1] : '');
      }
      if (urls.length) out[name] = urls;
    }

    return out;
  }

  function episodeCountFromPanels(arrays) {
    let max = 0;
    for (const key of Object.keys(arrays)) {
      max = Math.max(max, arrays[key].length);
    }
    return max;
  }

  const panelArrays = Object.create(null);
  async function arraysFor(slug, panelPath) {
    const key=slug+':'+panelPath;
    const cached=panelArrays[key];
    if (cached && Date.now()-cached.time<300000) return cached.arrays;
    const root=SITE+'/catalogue/'+slug+'/';
    const res=await requestText(root+panelPath+'/episodes.js',{Referer:root},7000);
    const arrays=parseEpsArrays(res.text);
    panelArrays[key]={time:Date.now(),arrays};
    return arrays;
  }
  function sourceEpisodeLabels(html,count) {
    const source=String(html||'').replace(/\/\*[\s\S]*?\*\//g,'');
    const labels=[];
    const calls=/creerListe\(\s*(\d+)\s*,\s*(\d+)\s*\)|newSPF?\(\s*['"]([^'"]+)['"]\s*\)|finirListe\(\s*(\d+)\s*\)/g;
    let m;
    while((m=calls.exec(source))&&labels.length<count){
      if(m[1])for(let n=Number(m[1]);n<=Number(m[2])&&labels.length<count;n++)labels.push(String(n));
      else if(m[3])labels.push(m[3]);
      else if(m[4])for(let n=Number(m[4]);labels.length<count;n++)labels.push(String(n));
    }
    return labels;
  }
  const labelCache=Object.create(null);
  async function labelsFor(slug,panelPath,count) {
    const key=slug+':'+panelPath;
    if(labelCache[key]&&labelCache[key].length===count)return labelCache[key];
    const root=SITE+'/catalogue/'+slug+'/';
    const page=await requestText(root+panelPath+'/',{Referer:root},6000);
    const labels=sourceEpisodeLabels(page.text,count);
    while(labels.length<count)labels.push(String(labels.length+1));
    labelCache[key]=labels;
    return labels;
  }
  async function extractEpisodes(seriesId) {
    const slug=slugFromAnimeUrl(toAbsoluteUrl(seriesId));
    if (!slug) return [];
    const collection=selectedPanel(seriesId),cacheKey=slug+':'+collection;
    if (episodesCache[cacheKey]) return episodesCache[cacheKey];
    const root=SITE+'/catalogue/'+slug+'/';
    const res=await requestText(root,{Referer:SITE+'/'},10000);
    let panels=parseSeasonPanels(res.text).filter(p=>/(?:vostfr|vf[12]?)$/.test(p.path));
    if(collection)panels=panels.filter(p=>p.path.replace(/\/(?:vostfr|vf[12]?)$/,'')===collection);
    else if(panels.some(p=>/^saison\d+\//.test(p.path)))panels=panels.filter(p=>/^saison\d+\//.test(p.path));
    const groups=[],seen=Object.create(null);
    for(const p of panels){const base=p.path.replace(/\/(?:vostfr|vf[12]?)$/,'');if(!seen[base]){seen[base]=true;groups.push({base,label:p.label});}}
    const episodes=[];
    for(let i=0;i<groups.length;i+=3){
      const pages=await Promise.all(groups.slice(i,i+3).map(async group=>{
        const byLang={};
        // These sibling language routes are the site's own videos.js switch targets.
        for(const language of ['vostfr','vf','vf1','vf2']) byLang[language]=await arraysFor(slug,group.base+'/'+language);
        const count=Math.max(...Object.keys(byLang).map(k=>episodeCountFromPanels(byLang[k])));
        const primaryLang=episodeCountFromPanels(byLang.vostfr)?'vostfr':['vf','vf1','vf2'].find(k=>episodeCountFromPanels(byLang[k]));
        const languageLabels={};
        for(const language of Object.keys(byLang)){
          const size=episodeCountFromPanels(byLang[language]);
          languageLabels[language]=size?await labelsFor(slug,group.base+'/'+language,size):[];
        }
        const labels=languageLabels[primaryLang]||[];
        const list=[];
        for(let ep=1;ep<=count;ep++){
          const desired=labels[ep-1]||String(ep);
          const has=k=>{const slot=languageLabels[k].indexOf(desired);return slot>=0&&Object.keys(byLang[k]).some(server=>!!byLang[k][server][slot]);};
          const sub=has('vostfr'),dub=['vf','vf1','vf2'].some(has);
          if(!sub&&!dub)continue;
          const primary=sub?'vostfr':['vf','vf1','vf2'].find(has);
          const season=(group.base.match(/^saison(\d+)$/)||[])[1];
          const display=labels[ep-1]||String(ep),numeric=Number(display);
          list.push({number:Number.isInteger(numeric)&&numeric>0?numeric:ep,season:season?Number(season):null,
            href:'as:'+slug+':'+group.base+'/'+primary+':'+(languageLabels[primary].indexOf(desired)+1),
            title:group.label+' · Épisode '+display,subAvailable:sub,dubAvailable:dub});
        }
        return list;
      }));
      pages.forEach(list=>episodes.push(...list));
    }
    if(episodes.length)episodesCache[cacheKey]=episodes;
    return episodes;
  }

  /* ────────────────────────── Stream URL Extraction ────────────────────────── */

  function pickLecteurs(arrays, episode) {
    const order = [];
    for (const key of Object.keys(arrays)) {
      const urls = arrays[key];
      const url = urls[episode - 1];
      if (!url) continue;
      const hostMatch = String(url).match(/^https?:\/\/([^/]+)/i);
      const host = hostMatch ? hostMatch[1].toLowerCase() : '';
      order.push({ key, url, host });
    }

    // Prioritize Sibnet direct MP4 streams first
    order.sort((a, b) => {
      const rank = (entry) =>
        entry.host.includes('sibnet.ru') ? 0 : entry.host.includes('sendvid') ? 1 : entry.host.includes('ansembed') ? 2 : 3;
      return rank(a) - rank(b);
    });

    return order;
  }

  function parseSibnetSource(html) {
    const raw = String(html || '');
    const match =
      raw.match(/player\.src\(\[\{src:\s*"([^"]+\.mp4[^"]*)"/i) ||
      raw.match(/"file"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
    if (match) return toAbsoluteUrl(match[1], SIBNET_HOST);
    return null;
  }

  async function resolveSibnet(embedUrl) {
    const res = await requestText(embedUrl, { Referer: SITE + '/' }, 10000);
    const rawVideoUrl = parseSibnetSource(res.text);
    if (!rawVideoUrl) throw new Error('Sibnet direct MP4 video link not found');

    // Pre-resolve 302 redirect using Range GET with followRedirects: false so that the direct storage URL is returned immediately.
    // Sibnet explicitly rejects HEAD requests with HTTP 400, so Range GET (bytes=0-1) with manual redirect extraction is required.
    let finalVideoUrl = rawVideoUrl;
    try {
      if (typeof fetchv2 === 'function') {
        const probeRes = await fetchv2(
          rawVideoUrl,
          {
            'User-Agent': USER_AGENT,
            Referer: embedUrl,
            Range: 'bytes=0-1',
          },
          'GET',
          null,
          { followRedirects: false }
        );
        const loc =
          (probeRes &&
            probeRes.headers &&
            (probeRes.headers.location || probeRes.headers.Location)) ||
          '';
        if (loc) {
          finalVideoUrl = loc.startsWith('//')
            ? 'https:' + loc
            : globalThis.__trioMedia.absolute(loc, rawVideoUrl);
        } else if (
          probeRes &&
          probeRes.finalUrl &&
          /^https?:\/\//i.test(probeRes.finalUrl) &&
          !probeRes.finalUrl.includes('video.sibnet.ru/v/')
        ) {
          finalVideoUrl = probeRes.finalUrl;
        }
      } else if (typeof fetch === 'function') {
        const probeRes = await fetch(rawVideoUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            Referer: embedUrl,
            Range: 'bytes=0-1',
          },
        });
        const loc = probeRes.headers.get('location') || '';
        if (loc) {
          finalVideoUrl = loc.startsWith('//')
            ? 'https:' + loc
            : globalThis.__trioMedia.absolute(loc, rawVideoUrl);
        } else if (
          probeRes.url &&
          /^https?:\/\//i.test(probeRes.url) &&
          !probeRes.url.includes('video.sibnet.ru/v/')
        ) {
          finalVideoUrl = probeRes.url;
        }
      }
    } catch (_) {}

    if (finalVideoUrl.startsWith('//')) {
      finalVideoUrl = 'https:' + finalVideoUrl;
    }

    const headers = {
      'User-Agent': USER_AGENT,
      Referer: embedUrl,
      Origin: SIBNET_HOST,
      Accept: 'video/mp4,video/*,*/*',
    };

    return { url: finalVideoUrl, headers };
  }

  function parseVidmolySource(html) {
    const raw = String(html || '');
    const match =
      raw.match(/sources:\s*\[\s*\{[^}]*file:\s*["']([^"']+)["']/i) ||
      raw.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (match) return match[1];
    return null;
  }

  async function resolveVidmoly(embedUrl) {
    const res = await requestText(embedUrl, { Referer: SITE + '/' }, 10000);
    const m3u8Url = parseVidmolySource(res.text);
    if (!m3u8Url) throw new Error('Vidmoly HLS stream link not found');

    const headers = {
      'User-Agent': USER_AGENT,
      Referer: embedUrl,
    };

    return { url: m3u8Url, headers };
  }

  async function extractStreamUrl(episodeHref, lang) {
    const match=String(episodeHref||'').match(/^as:([a-z0-9-]+):([a-z0-9_/-]+):(\d+)$/i);
    if (!match || Number(match[3])<1) return {streams:[]};
    const slug=match[1], path=match[2], episodeNum=Number(match[3]);
    const isVF=/(?:^|\/)vf[0-9]*(?:\/|$)/i.test(path);
    const label=String(lang||(isVF?'dub':'sub')).toLowerCase();
    if (!/^(sub|dub)$/.test(label)) return {streams:[]};
    const deadline=Date.now()+24000;
    const base=path.replace(/\/(?:vostfr|vf[12]?)$/,'');
    const langues=label==='dub'?['vf','vf1','vf2']:['vostfr'];
    const sourceLanguage=(path.match(/\/(vostfr|vf[12]?)$/)||[])[1];
    if(!sourceLanguage)return {streams:[]};
    const sourceArrays=await arraysFor(slug,path);
    if(!Object.keys(sourceArrays).some(k=>sourceArrays[k][episodeNum-1]))return {streams:[]};
    const sourceLabels=await labelsFor(slug,path,episodeCountFromPanels(sourceArrays));
    const desired=sourceLabels[episodeNum-1];
    const lecteurs=[];
    for(const language of langues){
      if(Date.now()>=deadline)break;
      const arrays=await arraysFor(slug,base+'/'+language);
      const labels=await labelsFor(slug,base+'/'+language,episodeCountFromPanels(arrays));
      const index=language===sourceLanguage?episodeNum-1:labels.indexOf(desired);
      if(index<0 || (language!==sourceLanguage && labels.lastIndexOf(desired)!==index))continue;
      pickLecteurs(arrays,index+1).forEach(x=>lecteurs.push(Object.assign({},x,{language})));
    }
    const rows=[];
    for (const lecteur of lecteurs) {
      if (Date.now()>=deadline) break;
      try {
        let route;
        if (lecteur.host.includes('sibnet.ru')) {
          route=await resolveSibnet(lecteur.url); route.streamType='mp4'; route.name='Sibnet';
        } else if (/ansembed|vidmoly|vidspeed/.test(lecteur.host)) {
          route=await resolveVidmoly(lecteur.url); route.streamType='hls'; route.name=lecteur.host;
        }
        if (!route || Date.now()>=deadline) continue;
        route.name+=' '+lecteur.language.toUpperCase();
        const checked=await globalThis.__trioMedia.check(route,deadline);
        if (checked) rows.push(checked);
      } catch (error) { console.log('[media-check] '+String(error.message||error)); }
    }
    return globalThis.__trioMedia.result(rows,label);
  }

  /* ────────────────────────── Discovery Feeds ────────────────────────── */

  async function discoveryHome() {
    const deadline = Date.now() + 18000;
    const siteCards = await getSiteCards(deadline);

    const trending = siteCards.slice(0, 8).map((c) => ({
      id: c.href,
      href: c.href,
      title: c.title,
      image: c.image,
      poster: c.image,
      bannerImage: c.bannerImage,
      type: 'video',
    }));

    const popular = siteCards.slice(8, 32).map((c) => ({
      id: c.href,
      href: c.href,
      title: c.title,
      image: c.image,
      poster: c.image,
      bannerImage: c.bannerImage,
      type: 'video',
    }));

    const latest = (await availableCards(POPULAR_CATALOGUE.map(c => ({...c, href:`${SITE}/catalogue/${c.slug}/`})), deadline)).map((c) => ({
      id: `${SITE}/catalogue/${c.slug}/`,
      href: `${SITE}/catalogue/${c.slug}/`,
      title: c.title,
      image: c.image,
      poster: c.image,
      bannerImage: c.bannerImage,
      type: 'video',
    }));

    return {
      sections: [
        {
          id: 'trending',
          title: 'Tendances Anime (VOSTFR & VF)',
          style: 'hero',
          items: trending,
          viewAll: { mode: 'feed', feedId: 'trending' },
        },
        {
          id: 'popular',
          title: 'Animes Populaires en Français',
          style: 'poster',
          items: popular,
          viewAll: { mode: 'feed', feedId: 'popular' },
        },
        {
          id: 'classics',
          title: 'Grands Classiques Anime-Sama',
          style: 'poster',
          items: latest,
          viewAll: { mode: 'feed', feedId: 'classics' },
        },
      ],
    };
  }

  async function discoveryFeed(feedId, page) {
    const deadline = Date.now() + 18000;
    const pageNum=Math.max(1,Number(page)||1);
    const res=await requestText(SITE+'/catalogue/?page='+pageNum,{Referer:SITE+'/'},remaining(deadline, 6000));
    const items=await availableCards(parseCardsFromHtml(res.text), deadline);
    const next=new RegExp('[?&]page='+String(pageNum+1)+'(?:[&\\"\\\'\\s]|$)');
    return {items:items.slice(0,50),page:pageNum,hasMore:next.test(res.text)};
  }

  /* ────────────────────────── Global Module Exports ────────────────────────── */

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
