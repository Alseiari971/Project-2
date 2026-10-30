// Details from a game's public Steam store page: the "About this game" section,
// system requirements, Metacritic score, achievements and features. No key needed.
//
// Steam sends parts of this as HTML. It is converted here into plain blocks
// (heading, paragraph, list, image, video) so no outside HTML reaches the page,
// and only images and videos hosted by Steam are kept.

const USER_AGENT = 'GameShelf/0.3 (+https://github.com/Alseiari971/Project-2)';
const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 300;
const MAX_BLOCKS = 80;

// Features worth showing, in this order. Steam lists many more.
const FEATURES = [
  'Single-player', 'Multi-player', 'Online PvP', 'PvP', 'Co-op', 'Online Co-op', 'Shared/Split Screen',
  'Cross-Platform Multiplayer', 'Remote Play Together', 'Steam Achievements', 'Full controller support',
  'Partial Controller Support', 'Steam Cloud', 'Steam Workshop', 'In-App Purchases', 'Family Sharing',
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', trade: '™', reg: '®', copy: '©', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decode(text) {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
};

/** Only Steam's own image and video servers. */
function steamMedia(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(steamstatic\.com|steampowered\.com|steamusercontent\.com)$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

const tidy = (text) => decode(text).replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Turns Steam's description HTML into a list of safe blocks. */
function htmlToBlocks(html = '') {
  const blocks = [];
  let text = '';
  let heading = false;
  let list = null;
  let video = null;

  const flushText = () => {
    const t = tidy(text);
    text = '';
    if (!t) return;
    if (list) list.items.push(t);
    else blocks.push({ type: heading ? 'heading' : 'paragraph', text: t });
  };

  const tokens = String(html).split(/(<[^>]+>)/);
  for (const token of tokens) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (!token.startsWith('<')) {
      text += token;
      continue;
    }
    const m = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(token);
    if (!m) continue;
    const closing = Boolean(m[1]);
    const tag = m[2].toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      flushText();
      heading = !closing;
    } else if (tag === 'br') {
      // Two line breaks in a row end a paragraph.
      if (/\n$/.test(text) && !list) flushText();
      else text += '\n';
    } else if (tag === 'p' || tag === 'div') {
      flushText();
    } else if (tag === 'ul' || tag === 'ol') {
      flushText();
      if (!closing) list = { type: 'list', items: [] };
      else if (list) {
        if (list.items.length) blocks.push(list);
        list = null;
      }
    } else if (tag === 'li') {
      flushText();
    } else if (tag === 'img' && !closing) {
      flushText();
      const src = steamMedia(attr(token, 'src') || '');
      if (src) blocks.push({ type: 'image', src });
    } else if (tag === 'video') {
      if (!closing) {
        flushText();
        video = { type: 'video', poster: steamMedia(attr(token, 'poster') || ''), src: null };
      } else if (video) {
        if (video.src) blocks.push(video);
        else if (video.poster) blocks.push({ type: 'image', src: video.poster });
        video = null;
      }
    } else if (tag === 'source' && video) {
      const src = steamMedia(attr(token, 'src') || '');
      // Prefer MP4, which every browser plays.
      if (src && (!video.src || /\.mp4(\?|$)/i.test(src))) video.src = src;
    }
  }
  flushText();
  if (list?.items.length) blocks.push(list);
  return blocks;
}

/** "<li><strong>OS:</strong> Windows 10</li>" -> [{ label: 'OS', value: 'Windows 10' }] */
function parseRequirements(html = '') {
  const rows = [];
  for (const item of String(html).split(/<li[^>]*>/i).slice(1)) {
    const label = /<strong>([^<]*)<\/strong>/i.exec(item)?.[1];
    const plain = tidy(item.replace(/<[^>]+>/g, ' '));
    if (!plain) continue;
    if (label) {
      const name = tidy(label).replace(/:\s*$/, '');
      const value = tidy(plain.slice(plain.indexOf(tidy(label)) + tidy(label).length));
      if (value) rows.push({ label: name, value });
    } else {
      rows.push({ label: null, value: plain });
    }
  }
  return rows;
}

/** "English<strong>*</strong>, French" -> [{ name: 'English', audio: true }, ...] */
function parseLanguages(html = '') {
  const first = String(html).split(/<br\s*\/?>/i)[0];
  return first.split(',').map((part) => ({
    name: tidy(part.replace(/<[^>]+>/g, '').replace(/\*/g, '')),
    audio: /\*/.test(part),
  })).filter((l) => l.name);
}

function createSteamStore({ fetchImpl = fetch } = {}) {
  const cache = new Map();

  return {
    /** Store details for a Steam app ID, or null when Steam has none. */
    async details(appId) {
      if (!Number.isInteger(appId) || appId <= 0) return null;
      const hit = cache.get(appId);
      if (hit && hit.expires > Date.now()) return hit.value;

      const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=english`;
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`Steam store request failed with status ${res.status}`);
      const body = (await res.json())?.[appId];
      const d = body?.success ? body.data : null;

      const value = d ? {
        appId,
        about: htmlToBlocks(d.about_the_game || d.detailed_description),
        requirements: {
          minimum: parseRequirements(d.pc_requirements?.minimum),
          recommended: parseRequirements(d.pc_requirements?.recommended),
        },
        metacritic: d.metacritic?.score ? { score: d.metacritic.score, url: steamMetacriticUrl(d.metacritic.url) } : null,
        achievements: d.achievements?.total || 0,
        recommendations: d.recommendations?.total || 0,
        features: FEATURES.filter((f) => (d.categories || []).some((c) => c.description === f)),
        languages: parseLanguages(d.supported_languages),
        microtrailer: microtrailer(d.movies),
        storeUrl: `https://store.steampowered.com/app/${appId}/`,
      } : null;

      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(appId, { value, expires: Date.now() + TTL_MS });
      return value;
    },
  };
}

/**
 * Steam's 6-second, silent, looping preview of a game's first trailer, made
 * for small spaces like the home page's spotlight. Steam keeps it next to the
 * trailer's streaming files, so its address comes from theirs.
 */
function microtrailer(movies) {
  const movie = (movies || []).find((m) => m.highlight) || movies?.[0];
  const stream = movie && (movie.hls_h264 || movie.dash_h264 || movie.dash_av1);
  try {
    const u = new URL(stream);
    if (u.protocol !== 'https:' || !/(^|\.)steamstatic\.com$/.test(u.hostname)) return null;
    u.pathname = u.pathname.replace(/[^/]+$/, 'microtrailer.webm');
    u.search = '';
    return u.href;
  } catch {
    return null;
  }
}

function steamMetacriticUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)metacritic\.com$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

module.exports = { createSteamStore, htmlToBlocks, parseRequirements, parseLanguages, microtrailer };
