(() => {
  'use strict';

  const MODULE_NAME = 'SynthetiqMusicHubV110';
  const API = 'https://api.music.vispark.in/api';
  const SITE = 'https://music.vispark.in';
  const FALLBACK_ART = SITE + '/favicon.ico';
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  // robots.txt asks for ~1 request/second; stay well under it.
  const MIN_GAP_MS = 350;
  let lastRequestAt = 0;

  const QUALITY_ORDER = ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps'];

  function log(message) {
    try {
      console.log('[' + MODULE_NAME + '] ' + String(message || ''));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function decodeText(value) {
    return String(value == null ? '' : value)
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function bestImage(image) {
    if (!image) return '';
    if (typeof image === 'string') return image;
    if (Array.isArray(image) && image.length) {
      const last = image[image.length - 1];
      if (last && (last.url || last.link)) return String(last.url || last.link);
      const first = image.find((row) => row && (row.url || row.link));
      return first ? String(first.url || first.link) : '';
    }
    return '';
  }

  function artistsText(artists) {
    if (!artists) return '';
    if (typeof artists === 'string') return decodeText(artists);
    const buckets = [artists.primary, artists.featured, artists.all, artists];
    for (const bucket of buckets) {
      if (Array.isArray(bucket) && bucket.length) {
        return bucket
          .map((row) => decodeText(row && (row.name || row)))
          .filter(Boolean)
          .join(', ');
      }
    }
    return '';
  }

  function albumName(album) {
    if (!album) return '';
    if (typeof album === 'string') return decodeText(album);
    return decodeText(album.name || '');
  }

  function ok(data) {
    return { ok: true, data: JSON.stringify(data) };
  }

  function fail(message) {
    return { ok: false, error: { message: String(message || 'Music module error') } };
  }

  async function apiGet(path, params) {
    const gap = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (gap > 0) await sleep(gap);
    lastRequestAt = Date.now();

    const query = Object.entries(params || {})
      .filter(([, value]) => value != null && value !== '')
      .map(
        ([key, value]) =>
          encodeURIComponent(key) + '=' + encodeURIComponent(String(value)),
      )
      .join('&');
    const url = API + path + (query ? '?' + query : '');
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Referer: SITE + '/',
    };

    let res = null;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, headers, 'GET', null);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { headers });
    }
    const status = Number((res && res.status) || 0);
    if (!res || (status && status >= 400)) {
      throw new Error('Vispark API request failed ' + (status || '') + ' for ' + path);
    }
    // The app runtime's fetchv2 omits the raw body once it has parsed JSON
    // natively (memory pressure), so res.json() must be tried first; text
    // fallback keeps Node/browser shims working.
    let json = null;
    if (res && typeof res.json === 'function') {
      try {
        json = await res.json();
      } catch (_) {}
    }
    if (json == null) {
      let text = '';
      if (res && typeof res.text === 'function') text = await res.text();
      if (!text && res && typeof res.body === 'string') text = res.body;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error('Vispark API returned non-JSON for ' + path);
      }
    }
    if (json && json.success === false) {
      throw new Error('Vispark API error for ' + path + ': ' + (json.message || 'success=false'));
    }
    return json;
  }

  function mapTrack(row) {
    if (!row || !row.id) return null;
    const title = decodeText(row.name || row.title);
    if (!title) return null;
    return {
      id: 'song:' + String(row.id),
      href: 'song:' + String(row.id),
      type: 'track',
      title,
      artist: artistsText(row.artists) || 'Unknown Artist',
      album: albumName(row.album),
      albumId: row.album && row.album.id ? 'album:' + String(row.album.id) : undefined,
      image: bestImage(row.image) || FALLBACK_ART,
      durationSeconds: Number(row.duration) || undefined,
    };
  }

  function mapAlbum(row) {
    if (!row || !row.id) return null;
    const title = decodeText(row.name || row.title);
    if (!title) return null;
    return {
      id: 'album:' + String(row.id),
      href: 'album:' + String(row.id),
      type: 'album',
      title,
      artist: artistsText(row.artists) || decodeText(row.artist) || 'Various Artists',
      image: bestImage(row.image) || FALLBACK_ART,
      year: decodeText(row.year) || undefined,
      genre: decodeText(row.language) || undefined,
      trackCount: Number(row.songCount || row.song_count) || undefined,
    };
  }

  function mapPlaylist(row) {
    if (!row || !row.id) return null;
    const title = decodeText(row.name || row.title);
    if (!title) return null;
    return {
      id: 'playlist:' + String(row.id),
      href: 'playlist:' + String(row.id),
      type: 'playlist',
      title,
      subtitle: decodeText(row.subtitle || row.description) || undefined,
      image: bestImage(row.image) || FALLBACK_ART,
    };
  }

  function dataResults(json) {
    const data = json && json.data;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.results)) return data.results;
    return [];
  }

  async function searchApi(kind, query, page, limit) {
    const json = await apiGet('/search/' + kind, {
      query,
      page: Number(page) || 0,
      limit: Number(limit) || 10,
    });
    return dataResults(json);
  }

  function parseRef(id) {
    const raw = String(id || '').trim();
    const match = raw.match(/^(song|album|playlist):(.+)$/i);
    if (match) {
      return { kind: match[1].toLowerCase(), id: match[2] };
    }
    if (/^https?:\/\//i.test(raw)) {
      const fromUrl = raw.match(/\/(song|album|playlist)\/[^/]*?([A-Za-z0-9_-]{6,})(?:[/?#]|$)/i);
      if (fromUrl) return { kind: fromUrl[1].toLowerCase(), id: fromUrl[2] };
      return null;
    }
    if (raw) return { kind: 'song', id: raw };
    return null;
  }

  async function searchResults(query, page) {
    try {
      const term = String(query == null ? '' : query).trim();
      if (!term) return ok([]);
      const [songs, albums, playlists] = await Promise.all([
        searchApi('songs', term, page, 15),
        searchApi('albums', term, 0, 8),
        searchApi('playlists', term, 0, 8),
      ]);
      const out = [];
      const seen = Object.create(null);
      for (const item of songs.map(mapTrack)) {
        if (item && !seen[item.id]) {
          seen[item.id] = true;
          out.push(item);
        }
      }
      for (const item of albums.map(mapAlbum)) {
        if (item && !seen[item.id]) {
          seen[item.id] = true;
          out.push(item);
        }
      }
      for (const item of playlists.map(mapPlaylist)) {
        if (item && !seen[item.id]) {
          seen[item.id] = true;
          out.push(item);
        }
      }
      return ok(out);
    } catch (e) {
      return fail('Vispark search failed: ' + (e && e.message ? e.message : e));
    }
  }

  async function albumDetails(albumId) {
    const json = await apiGet('/albums', { id: albumId });
    const data = json && json.data ? json.data : {};
    const tracks = (Array.isArray(data.songs) ? data.songs : [])
      .map(mapTrack)
      .filter(Boolean);
    const artist = artistsText(data.artists) || 'Various Artists';
    return {
      id: 'album:' + String(albumId),
      type: 'album',
      title: decodeText(data.name) || 'Album',
      artist,
      image: bestImage(data.image) || FALLBACK_ART,
      description:
        decodeText(data.description) ||
        'Album by ' + artist + ' on Vispark Music (' + tracks.length + ' tracks).',
      year: decodeText(data.year) || undefined,
      genre: decodeText(data.language) || undefined,
      trackCount: Number(data.songCount || tracks.length) || tracks.length,
      tracks,
    };
  }

  async function playlistDetails(playlistId) {
    const json = await apiGet('/playlists', { id: playlistId });
    const data = json && json.data ? json.data : {};
    const tracks = (Array.isArray(data.songs) ? data.songs : [])
      .map(mapTrack)
      .filter(Boolean);
    return {
      id: 'playlist:' + String(playlistId),
      type: 'album',
      title: decodeText(data.name) || 'Playlist',
      artist: 'Vispark',
      image: bestImage(data.image) || FALLBACK_ART,
      description:
        decodeText(data.subtitle || data.description) ||
        'Playlist on Vispark Music (' + tracks.length + ' tracks).',
      trackCount: tracks.length,
      tracks,
    };
  }

  async function songDetails(songId) {
    const json = await apiGet('/songs/' + encodeURIComponent(songId));
    const row = Array.isArray(json && json.data) ? json.data[0] : json && json.data;
    const track = mapTrack(row);
    if (!track) throw new Error('song not found');
    return {
      id: track.id,
      type: 'album',
      title: track.album || track.title,
      artist: track.artist,
      image: track.image,
      description: track.title + ' by ' + track.artist + ' on Vispark Music.',
      trackCount: 1,
      tracks: [track],
    };
  }

  async function extractDetails(id) {
    try {
      const ref = parseRef(id);
      if (!ref) throw new Error('invalid reference');
      if (ref.kind === 'album') return ok(await albumDetails(ref.id));
      if (ref.kind === 'playlist') return ok(await playlistDetails(ref.id));
      return ok(await songDetails(ref.id));
    } catch (e) {
      return fail('Vispark details failed: ' + (e && e.message ? e.message : e));
    }
  }

  async function extractTracks(containerId) {
    try {
      const ref = parseRef(containerId);
      if (!ref) {
        // Treat anything unparseable as a search query fallback.
        const rows = await searchApi('songs', String(containerId || ''), 0, 30);
        return ok(rows.map(mapTrack).filter(Boolean));
      }
      if (ref.kind === 'album') {
        const details = await albumDetails(ref.id);
        return ok(details.tracks);
      }
      if (ref.kind === 'playlist') {
        const details = await playlistDetails(ref.id);
        return ok(details.tracks);
      }
      const details = await songDetails(ref.id);
      return ok(details.tracks);
    } catch (e) {
      return fail('Vispark track list failed: ' + (e && e.message ? e.message : e));
    }
  }

  function pickQuality(downloadUrl, requested) {
    const tiers = (Array.isArray(downloadUrl) ? downloadUrl : [])
      .map((row) => ({
        quality: String(row && row.quality ? row.quality : '').trim(),
        url: String(row && (row.url || row.link) ? row.url || row.link : '').trim(),
      }))
      .filter((row) => row.quality && row.url);
    if (!tiers.length) return null;
    const want = String(requested || '').toLowerCase();
    if (want) {
      const exact = tiers.find((row) => row.quality.toLowerCase() === want);
      if (exact) return exact;
      const numeric = want.match(/\d{2,3}/);
      if (numeric) {
        const byNumber = tiers.find((row) => row.quality.indexOf(numeric[0]) === 0);
        if (byNumber) return byNumber;
      }
    }
    for (const label of QUALITY_ORDER) {
      const tier = tiers.find((row) => row.quality === label);
      if (tier) return tier;
    }
    return tiers[tiers.length - 1];
  }

  async function extractAudioUrl(trackId, quality) {
    try {
      const ref = parseRef(trackId);
      const songId = ref && ref.id ? ref.id : String(trackId || '').trim();
      if (!songId) throw new Error('missing track id');
      const json = await apiGet('/songs/' + encodeURIComponent(songId));
      const row = Array.isArray(json && json.data) ? json.data[0] : json && json.data;
      const tier = pickQuality(row && row.downloadUrl, quality);
      if (!tier) {
        throw new Error('No audio URL available for this track.');
      }
      const track = mapTrack(row) || {};
      return ok({
        url: tier.url,
        headers: {},
        mimeType: 'audio/mp4',
        extension: 'mp4',
        title: track.title || 'Track',
        artist: track.artist || 'Unknown Artist',
        album: track.album || '',
        artwork: track.image || FALLBACK_ART,
        durationSeconds: track.durationSeconds,
        quality: tier.quality,
      });
    } catch (e) {
      return fail('Vispark audio resolution failed: ' + (e && e.message ? e.message : e));
    }
  }

  async function homeSections(page) {
    try {
      if (Number(page) > 0) return ok([]);
      const sections = [];
      const queries = [
        { title: 'Trending Hindi Songs', type: 'track', kind: 'songs', query: 'new hindi songs 2026' },
        { title: 'English Hits', type: 'track', kind: 'songs', query: 'english top hits' },
        { title: 'Punjabi Hits', type: 'track', kind: 'songs', query: 'punjabi hits' },
        { title: 'New Albums', type: 'album', kind: 'albums', query: 'new album 2026' },
        { title: 'Featured Playlists', type: 'playlist', kind: 'playlists', query: 'bollywood hits' },
      ];
      for (const section of queries) {
        try {
          const rows = await searchApi(section.kind, section.query, 0, 12);
          const items =
            section.type === 'track'
              ? rows.map(mapTrack).filter(Boolean)
              : section.type === 'album'
                ? rows.map(mapAlbum).filter(Boolean)
                : rows.map(mapPlaylist).filter(Boolean);
          if (items.length) {
            sections.push({ title: section.title, type: section.type, items });
          }
        } catch (error) {
          log('home section ' + section.title + ' failed: ' + (error && error.message ? error.message : error));
        }
      }
      if (!sections.length) throw new Error('no home sections available');
      return ok(sections);
    } catch (e) {
      return fail('Vispark home failed: ' + (e && e.message ? e.message : e));
    }
  }

  globalThis.searchResults = searchResults;
  globalThis.homeSections = homeSections;
  globalThis.extractDetails = extractDetails;
  globalThis.extractTracks = extractTracks;
  globalThis.extractAudioUrl = extractAudioUrl;
})();
