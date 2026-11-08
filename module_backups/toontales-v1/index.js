const MODULE_NAME = 'ToonTales';
const BASE_URL = 'https://www.toontales.net';

/* ---------- helpers ---------- */

async function request(url, options = {}) {
  // Empty-string bodies on GET/HEAD are rejected by strict HTTP clients (undici throws
  // "Request with GET/HEAD method cannot have body"); pass null for bodyless requests.
  const res = await fetchv2(url, options.headers || {}, options.method || 'GET', options.body || null);
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: () => text };
}

function decodeHtml(html) {
  return html
    .replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '-')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8230;/g, '...')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8218;/g, ',')
    .replace(/&#8242;/g, "'")
    .replace(/&#8243;/g, '"')
    .replace(/&#x2F;/g, '/');
}

/* ---------- contract ---------- */

async function searchResults(query) {
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  const res = await request(url);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);

  const html = await res.text();
  const results = [];

  // Match article blocks in search results
  const articleRegex = /<article[^>]*class="[^"]*post-\d+[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1];

    // Extract link - only include actual video shorts
    const linkMatch = block.match(/<a href="(https:\/\/www\.toontales\.net\/short\/[^"]+)"/);
    if (!linkMatch) continue;
    const href = linkMatch[1];

    // Extract title
    const titleMatch = block.match(/<h3[^>]*class="title"[^>]*>(.*?)<\/h3>/i);
    if (!titleMatch) continue;
    const title = decodeHtml(titleMatch[1].replace(/<[^>]+>/g, '').trim());

    // Extract image
    let image = '';
    const imgMatch = block.match(/<img[^>]+src="([^"]+)"/);
    if (imgMatch) image = imgMatch[1];

    results.push({ title, href, image });
  }

  // Deduplicate by href
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.href)) return false;
    seen.add(r.href);
    return true;
  });
}

async function extractDetails(href) {
  const res = await request(href);
  if (!res.ok) throw new Error(`Details failed: ${res.status}`);

  const html = await res.text();

  // Title from og:title or page title
  let title = '';
  const ogTitle = html.match(/property="og:title" content="([^"]+)"/);
  if (ogTitle) {
    title = decodeHtml(ogTitle[1].trim());
  } else {
    const titleMatch = html.match(/<title>(.*?)<\/title>/);
    if (titleMatch) title = decodeHtml(titleMatch[1].split('|')[0].trim());
  }

  // Description
  let description = '';
  const ogDesc = html.match(/property="og:description" content="([^"]+)"/);
  if (ogDesc) description = decodeHtml(ogDesc[1].trim());

  // Image
  let image = '';
  const ogImage = html.match(/property="og:image" content="([^"]+)"/);
  if (ogImage) image = ogImage[1];

  return {
    title,
    description,
    image,
    href,
  };
}

async function extractEpisodes(seriesHref) {
  // Each "series" in ToonTales is actually a single short cartoon
  // Return one episode pointing back to the same URL
  const details = await extractDetails(seriesHref);

  return [{
    title: details.title || 'Watch',
    number: 1,
    href: seriesHref,
  }];
}

async function extractStreamUrl(episodeHref, lang) {
  const res = await request(episodeHref);
  if (!res.ok) throw new Error(`Stream failed: ${res.status}`);

  const html = await res.text();

  // Try jwplayer file config first
  let streamUrl = '';
  const fileMatch = html.match(/file:\s*"([^"]+\.mp4)"/);
  if (fileMatch) {
    streamUrl = fileMatch[1];
  }

  // Fallback: contentUrl schema
  if (!streamUrl) {
    const contentUrlMatch = html.match(/"contentUrl"\s*:\s*"([^"]+\.mp4)"/);
    if (contentUrlMatch) streamUrl = contentUrlMatch[1];
  }

  // Fallback: any direct mp4
  if (!streamUrl) {
    const mp4Match = html.match(/(https?:\/\/[^\s"'<>]+\.mp4)/);
    if (mp4Match) streamUrl = mp4Match[1];
  }

  if (!streamUrl) {
    throw new Error('No stream URL found');
  }

  return {
    streams: ['HD', streamUrl],
    subtitles: [],
    headers: {
      Referer: BASE_URL + '/',
      Origin: BASE_URL,
    },
    intro: { start: 0, end: 0 },
    outro: { start: 0, end: 0 },
  };
}

/* ---------- exports ---------- */

globalThis.exports = {
  searchResults,
  extractDetails,
  extractEpisodes,
  extractStreamUrl,
};

globalThis.searchResults = searchResults;
globalThis.extractDetails = extractDetails;
globalThis.extractEpisodes = extractEpisodes;
globalThis.extractStreamUrl = extractStreamUrl;
