// GameShelf's game data: Steam's public store API and Wikidata (CC0), no keys needed.
//
// - Steam (store.steampowered.com): search (storesearch), browse lists (the
//   store's search results: names, release dates, review scores and tags in
//   one request), and each game's page (appdetails: description, developers,
//   publishers, genres, requirements, screenshots, languages, artwork).
// - Steam's store items (api.steampowered.com IStoreBrowseService/GetItems, no
//   key): for many games in one request, whether each is a game or DLC, its exact
//   artwork (Steam keeps newer games' art at hashed addresses) and its trailers.
// - Wikidata (query.wikidata.org, CC0 public domain): matched by Steam app ID
//   (P1733), or by name for games that aren't on Steam. It adds the official
//   Arabic title and description, the game engine (P408, mapped to the engines
//   GameShelf can patch), the Epic (P6278) and GOG (P2725) store IDs and the
//   official website (P856), the platforms (P400) and the game's Wikipedia articles.
// - Wikipedia: the summary of a game's article (CC BY-SA 4.0, credited on the
//   page) for games Steam doesn't describe, in English and Arabic.
//
// Everything fetched is kept in SQLite: each game in `games` (whose id is the
// GameShelf id players' lists, Arabic requests and packs point at) and every
// response in `metadata_cache`, fresh for METADATA_TTL_DAYS (7 by default).
// Requests to each site go one at a time with a minimum gap, and a refusal
// (429, 403, 5xx) backs off exponentially; while backing off, cached data is
// served even when old. If Wikidata is down, Steam's data stands alone.
const { buildBuyLinks } = require('./stores');
const { GENRES, findGenre } = require('./genres');
const { normalizeTitle } = require('../text');

const STORE = 'https://store.steampowered.com';
const STEAM_API = 'https://api.steampowered.com';
const ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/';
const VIDEOS = 'https://video.akamai.steamstatic.com/store_trailers/';
// Steam store item types (IStoreBrowseService): 0 is a game; DLC, soundtracks, videos and the rest aren't.
const STEAM_GAME = 0;
const SPARQL = 'https://query.wikidata.org/sparql';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
// How long a search waits for Wikidata before answering with Steam's games alone (the answer is still kept for next time).
const WIKI_SEARCH_WAIT_MS = 5000;
const USER_AGENT = 'GameShelf/1.0 (https://gameshelf.ae)';
const DAY = 24 * 60 * 60 * 1000;
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_TTL_MS = DAY;

// Steam's store tags (store.steampowered.com/tag/browse) for the site's genres
// and for the words the seasonal sections and moods use (src/seasons.js).
const TAGS = {
  action: 19, adventure: 21, 'role-playing': 122, rpg: 122, shooter: 1774, indie: 492, strategy: 9, platform: 1625, platformer: 1625,
  simulator: 599, simulation: 599, puzzle: 1664, racing: 699, sport: 701, sports: 701, fighting: 1743, casual: 597, family: 5350, kids: 5350,
  horror: 1667, thriller: 4064, 'co-operative': 1685, multiplayer: 3859, 'split screen': 10816, sandbox: 3810, 'open world': 1695,
  fantasy: 1684, historical: 3987, party: 7178, card: 1666, quiz: 10437, music: 1621, 'visual novel': 3799, drama: 5984, mystery: 5716,
  'science fiction': 3942, 'battle royale': 176981, moba: 1718, 'real time strategy': 1676, 'turn-based strategy': 1741, tactical: 1708,
  'point-and-click': 1698, arcade: 1773, 'hack and slash': 1646, warfare: 1678, war: 1678, erotic: 12095, pinball: 6621,
};
const GENRE_TAGS = Object.fromEntries(GENRES.map((g) => [g.name, g.steamTag || null]));
const SORTS = { popular: '_ASC', top: 'Reviews_DESC', new: 'Released_DESC', year: 'Reviews_DESC', upcoming: '_ASC' };
// Wikidata's platforms (P400) to names, and to the store a game for it is sold on.
const PLATFORMS = {
  Q5014725: ['PlayStation 4', 'playstation'], Q63184502: ['PlayStation 5', 'playstation'], Q10683: ['PlayStation 3', 'playstation'],
  Q188808: ['PlayStation Vita', 'playstation'], Q13361286: ['Xbox One', 'xbox'], Q64513817: ['Xbox Series X/S', 'xbox'],
  Q48263: ['Xbox 360', 'xbox'], Q19610114: ['Nintendo Switch', 'nintendo'], Q125449584: ['Nintendo Switch 2', 'nintendo'],
  Q56942: ['Wii U', 'nintendo'], Q203597: ['Nintendo 3DS', 'nintendo'], Q1406: ['PC', null], Q14116: ['macOS', null],
  Q388: ['Linux', null], Q48493: ['iOS', 'apple'], Q94: ['Android', 'googleplay'],
};
// Short names players type for long ones ("gta 5" is Grand Theft Auto V).
const SHORT_NAMES = {
  gta: 'grand theft auto', cod: 'call of duty', rdr: 'red dead redemption', ff: 'final fantasy', mk: 'mortal kombat',
  nfs: 'need for speed', botw: 'zelda breath of the wild', totk: 'zelda tears of the kingdom', pubg: 'pubg battlegrounds', csgo: 'counter-strike',
};
const expandShortNames = (term) => String(term).trim().replace(/^(\w+)\b/, (w) => SHORT_NAMES[w.toLowerCase()] || w);
// Store items that sell something for a game (search leaves them out unless asked for by name).
const EXTRAS = /\b(starter pack|season pass|battle pass|points|currency|coins|upgrade|dlc|soundtrack|artbook|art book|wallpapers?|bundle|costume|skin pack|cosmetic|operators?|vault edition upgrade)\b/i;

// Wikidata's engine items, by name, to the engines GameShelf makes Arabic for.
const ENGINE_MAP = [
  [/^unreal engine/i, 'unreal'],
  [/^unity\b/i, 'unity'],
  [/^re engine/i, 'reengine'],
  [/creation engine|gamebryo/i, 'bethesda'],
  [/ren'?py/i, 'renpy'],
  [/^godot/i, 'godot'],
  [/^mt framework/i, 'mtframework'],
  [/rockstar advanced game engine|^rage\b/i, 'rage'],
];
const mapEngine = (label) => (label ? ENGINE_MAP.find(([re]) => re.test(label))?.[1] || null : null);

const asset = (appId, file) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${file}`;
// Steam's newer artwork lives under a per-upload folder; the small capsule's
// folder holds the big capsule too. The old fixed address is the fallback.
const bigCapsule = (url) => (url ? String(url).replace(/capsule_(231x87|184x69|sm_120|120x45)/, 'capsule_616x353').replace(/\?.*$/, '') : null);
const slugify = (name) => String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/['’®™©]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'game';
const htmlText = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();
const sparqlString = (s) => `"${String(s).replace(/[\\"\n\r]/g, ' ').slice(0, 120)}"`;
const isArabicText = (s) => /[؀-ۿ]/.test(s);
/** Whether Wikidata's description of an item ("2017 video game", "لعبة فيديو") is a game, not a series, a character or an add-on. */
const isGameDescription = (text) => {
  const d = String(text || '');
  if (/[؀-ۿ]/.test(d)) return /لعبة|ألعاب فيديو/.test(d) && !/سلسلة|شخصية|امتياز|حزمة توسعة|موسيقى/.test(d);
  return /\bvideo ?game\b/i.test(d) && !/\b(series|franchise|character|soundtrack|film|expansion|downloadable|album|engine|company|developer|publisher|console|platform|mod|tournament|esports?|award)\b/i.test(d);
};
// ---- Matching old ids to games ----
// "baldurs-gate-iii" is Baldur's Gate 3, "disco-elysium" is "Disco Elysium - The
// Final Cut", "rainbow-six-siege" is "Tom Clancy's Rainbow Six Siege".
const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10', xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15', xvi: '16' };
/**
 * A title as comparable words: no ™ (before NFKD makes it "TM"), accents, apostrophes
 * or dots; & as "and", Δ as "delta", Roman numerals as digits, and no "the".
 */
const titleWords = (name) => String(name).replace(/[™®©]/g, '').replace(/[Δδ]/g, ' delta ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/['’`]/g, '').replace(/(\d)[,.](\d)/g, '$1$2').replace(/\./g, '').replace(/&/g, ' and ')
  .split(/[^a-z0-9]+/).filter((w) => w && w !== 'the').map((w) => ROMAN[w] || w);
// Words an edition adds to a game's name. A name made only of the game's words and these is still that game.
const EDITION_WORDS = new Set(['edition', 'editions', 'ultimate', 'definitive', 'complete', 'goty', 'game', 'of', 'the', 'year', 'directors',
  'cut', 'final', 'reloaded', 'enhanced', 'remastered', 'remaster', 'deluxe', 'standard', 'digital', 'anniversary', 'special', 'gold', 'premium', 'hd', 'classic', 'redux']);
// Store items that sell something for a game rather than the game.
const ADD_ON = /\b(upgrade|dlc|season pass|expansion pass|toolkit|soundtrack|artbook|art book|demo|playtest|bundle|costume|skin|cosmetic|operators)\b/i;
const isYear = (w) => /^(19|20)\d\d$/.test(w);
const extraOk = (w) => EDITION_WORDS.has(w) || isYear(w);
/**
 * How surely a store or Wikidata name is the game an old id names (0: it isn't).
 * 100 the same words; 80 the same plus edition words; 60 a brand in front
 * ("Tom Clancy's", "Marvel's") of a name of two or more words.
 */
function titleScore(candidate, target) {
  const a = titleWords(candidate);
  const b = titleWords(target);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 100;
  if (ADD_ON.test(candidate)) return 0;
  const startsWith = (long, short) => short.every((w, i) => long[i] === w);
  if (a.length > b.length && startsWith(a, b) && a.slice(b.length).every(extraOk)) return 80;
  if (b.length > a.length && startsWith(b, a) && b.slice(a.length).every(extraOk)) return 75;
  // A brand only counts when it's possessive ("Tom Clancy's", "Marvel's"), and bundles ("A | B") never do.
  if (b.length >= 2 && /['’]s\b/i.test(candidate) && !/[|+]/.test(candidate)) {
    for (let at = 1; at <= Math.min(3, a.length - b.length); at += 1) {
      if (b.every((w, i) => a[at + i] === w) && a.slice(at + b.length).every(extraOk)) return 60;
    }
  }
  return 0;
}
const bestMatch = (items, target, nameOf) => items.map((it) => ({ it, score: titleScore(nameOf(it), target) }))
  .filter((m) => m.score > 0).sort((x, y) => y.score - x.score)[0]?.it || null;

// Store search also finds soundtracks and art books; those aren't games.
const NOT_A_GAME = /\b(soundtrack|ost|artbook|art book|wallpapers?)\b/i;

function isoDate(text) {
  const t = Date.parse(String(text || '').trim());
  if (!Number.isFinite(t)) return null;
  return new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

class MetadataError extends Error {}

/**
 * A polite client for one site: one request at a time, at least `gapMs`
 * apart, and exponential backoff (up to 30 minutes) after a refusal.
 */
function createPoliteClient({ fetchImpl, gapMs, name, now, sleep }) {
  let chain = Promise.resolve();
  let last = 0;
  let strikes = 0;
  let coolUntil = 0;
  return {
    get cooling() {
      return now() < coolUntil;
    },
    request(url, init = {}) {
      const run = async () => {
        if (now() < coolUntil) throw new MetadataError(`${name} asked us to slow down; using saved data for now.`);
        const wait = last + gapMs - now();
        if (wait > 0) await sleep(wait);
        last = now();
        let res;
        try {
          res = await fetchImpl(url, { ...init, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
        } catch (err) {
          throw new MetadataError(`${name} didn't answer: ${err.message}`);
        }
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          strikes += 1;
          coolUntil = now() + Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** (strikes - 1));
          throw new MetadataError(`${name} refused (${res.status}); backing off.`);
        }
        if (!res.ok) throw new MetadataError(`${name} answered ${res.status}.`);
        strikes = 0;
        return res.json();
      };
      const result = chain.then(run, run);
      chain = result.catch(() => {});
      return result;
    },
  };
}

function createSteamWikidataProvider({
  db, fetchImpl = fetch, env = process.env, now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  // Steam's appdetails allows about 200 requests in 5 minutes; search and lists are lighter.
  steamGapMs = 1600, steamListGapMs = 350, wikidataGapMs = 1000, steamApiGapMs = 400, wikipediaGapMs = 300,
} = {}) {
  if (!db) throw new Error('The Steam + Wikidata provider needs the database for its cache.');
  const TTL_MS = (Number(env.METADATA_TTL_DAYS) > 0 ? Number(env.METADATA_TTL_DAYS) : 7) * DAY;
  const steamHttp = createPoliteClient({ fetchImpl, gapMs: steamGapMs, name: 'Steam', now, sleep });
  const steamListHttp = createPoliteClient({ fetchImpl, gapMs: steamListGapMs, name: 'Steam', now, sleep });
  const wikiHttp = createPoliteClient({ fetchImpl, gapMs: wikidataGapMs, name: 'Wikidata', now, sleep });
  const steamApiHttp = createPoliteClient({ fetchImpl, gapMs: steamApiGapMs, name: 'Steam', now, sleep });
  const wikipediaHttp = createPoliteClient({ fetchImpl, gapMs: wikipediaGapMs, name: 'Wikipedia', now, sleep });
  const wikiApiHttp = createPoliteClient({ fetchImpl, gapMs: wikipediaGapMs, name: 'Wikidata', now, sleep });

  const q = {
    cacheGet: db.prepare('SELECT body, fetched_at FROM metadata_cache WHERE key = ?'),
    cachePut: db.prepare('INSERT INTO metadata_cache (key, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at'),
    byId: db.prepare('SELECT * FROM games WHERE id = ?'),
    byApp: db.prepare('SELECT * FROM games WHERE steam_appid = ?'),
    byQid: db.prepare('SELECT * FROM games WHERE wikidata_qid = ?'),
    aliasOf: db.prepare('SELECT g.* FROM game_aliases a JOIN games g ON g.id = a.game_id WHERE a.alias = ?'),
    addAlias: db.prepare('INSERT OR IGNORE INTO game_aliases (alias, game_id) VALUES (?, ?)'),
    insert: db.prepare(`INSERT INTO games (id, name, steam_appid, wikidata_qid, image, released, review_percent, review_count)
      VALUES (@id, @name, @appid, @qid, @image, @released, @percent, @count)`),
    touchList: db.prepare(`UPDATE games SET name = COALESCE(NULLIF(@name, ''), name), image = COALESCE(@image, image),
      released = COALESCE(@released, released), review_percent = COALESCE(@percent, review_percent), review_count = COALESCE(@count, review_count) WHERE id = @id`),
    details: db.prepare(`UPDATE games SET name = @name, description = @description, released = @released, image = COALESCE(@image, image),
      header_image = @header, backdrop = @backdrop, genres = @genres, developers = @developers, publishers = @publishers,
      platforms = @platforms, website = COALESCE(website, @website), details_at = @at WHERE id = @id`),
    wiki: db.prepare(`UPDATE games SET wikidata_qid = COALESCE(@qid, wikidata_qid), title_ar = @titleAr, description_ar = @descriptionAr,
      detected_engine = @engine, engine_label = @engineLabel, epic_slug = @epic, gog_slug = @gog,
      website = COALESCE(@website, website), poster = COALESCE(poster, @poster), wiki_en = COALESCE(@wikiEn, wiki_en),
      wiki_ar = COALESCE(@wikiAr, wiki_ar), platforms = COALESCE(@platforms, platforms), wikidata_at = @at WHERE id = @id`),
    assets: db.prepare(`UPDATE games SET steam_type = @type, image = COALESCE(@image, image), header_image = COALESCE(@header, header_image),
      poster = @poster, backdrop = COALESCE(@backdrop, backdrop), logo = @logo, assets_at = @at WHERE id = @id`),
  };

  // ---- Cache ----

  /** `fetcher()`'s result, kept for `ttl`; an old copy is used when fetching fails. */
  async function cached(key, ttl, fetcher) {
    const row = q.cacheGet.get(key);
    if (row && now() - row.fetched_at < ttl) return JSON.parse(row.body);
    try {
      const fresh = await fetcher();
      q.cachePut.run(key, JSON.stringify(fresh), now());
      return fresh;
    } catch (err) {
      if (row) return JSON.parse(row.body);
      throw err;
    }
  }

  // ---- The games table: GameShelf ids for Steam apps and Wikidata items ----

  function uniqueId(name, suffix) {
    const base = slugify(name);
    if (!q.byId.get(base)) return base;
    const withSuffix = `${base}-${suffix}`.slice(0, 100);
    return q.byId.get(withSuffix) ? `${withSuffix}-${Date.now().toString(36)}` : withSuffix;
  }

  /** The row for a Steam app, made on first sight. `seen` updates what a list showed. */
  function rowForApp(appid, seen = {}) {
    const id = Number(appid);
    let row = q.byApp.get(id);
    const listed = { image: seen.image || null, released: seen.released || null, percent: seen.percent ?? null, count: seen.count ?? null, name: seen.name || '' };
    if (!row) {
      if (!seen.name) return null;
      q.insert.run({ id: uniqueId(seen.name, id), name: seen.name, appid: id, qid: null, ...listed });
      return q.byApp.get(id);
    }
    if (seen.name || seen.image || seen.released || seen.percent != null) {
      q.touchList.run({ id: row.id, ...listed });
      row = q.byId.get(row.id);
    }
    return row;
  }

  const json = (text, fallback = []) => {
    try {
      return text ? JSON.parse(text) : fallback;
    } catch {
      return fallback;
    }
  };

  /** A game row as the summary every page uses. */
  function summary(row) {
    const appid = row.steam_appid;
    // Steam's exact artwork once its store item was read (assets_at); before that, the old fixed addresses.
    const exact = Boolean(row.assets_at);
    const legacy = appid && !exact ? asset(appid, 'capsule_616x353.jpg') : null;
    const image = row.image || row.header_image || legacy || row.poster || null;
    return {
      id: row.id,
      name: row.name,
      nameAr: row.title_ar || null,
      released: row.released || null,
      image,
      // When Steam's newer artwork address is missing, the page falls back to this.
      fallbackImage: row.header_image && row.header_image !== image ? row.header_image : (legacy !== image ? legacy : null),
      backdrop: row.backdrop || (appid && !exact ? asset(appid, 'library_hero.jpg') : null),
      logo: row.logo || (appid && !exact ? asset(appid, 'logo.png') : null),
      poster: row.poster || (appid && !exact ? asset(appid, 'library_600x900_2x.jpg') : null),
      artHasTitle: Boolean(appid),
      steamAppId: appid || null,
      wikidataId: row.wikidata_qid || null,
      engine: row.detected_engine || null,
      genres: json(row.genres),
      platforms: json(row.platforms, appid ? ['PC'] : []),
      description: row.description || null,
      popularity: row.review_count || 0,
    };
  }

  // ---- Steam ----

  /** Steam's search results page (names, dates, review scores, tags), as rows. */
  function parseSearchHtml(html) {
    const out = [];
    for (const block of String(html || '').split(/<a\s+href="https:\/\/store\.steampowered\.com\/(?:app|bundle|sub)\//).slice(1)) {
      const appid = Number(/data-ds-appid="(\d+)"/.exec(block)?.[1]);
      const name = htmlText(/<span class="title">([\s\S]*?)<\/span>/.exec(block)?.[1]);
      if (!appid || !name) continue;
      const review = /data-tooltip-html="[^"]*?(\d+)% of the ([\d,]+) user reviews/.exec(block);
      out.push({
        appid,
        name,
        image: bigCapsule(/<div class="search_capsule"><img src="([^"]+)"/.exec(block)?.[1]),
        released: isoDate(htmlText(/<div class="search_released[^"]*">([\s\S]*?)<\/div>/.exec(block)?.[1])),
        percent: review ? Number(review[1]) : null,
        count: review ? Number(review[2].replace(/,/g, '')) : null,
        tags: json(/data-ds-tagids="(\[[\d,]*\])"/.exec(block)?.[1]),
      });
    }
    return out;
  }

  async function steamList({ tags = [], untags = [], sort = 'popular', start = 0, count = 30, term = '' }) {
    const params = new URLSearchParams({ start: String(start), count: String(Math.min(count, 50)), category1: '998', infinite: '1', cc: 'US', l: 'english', sort_by: SORTS[sort] || '_ASC' });
    if (term) params.set('term', term);
    if (tags.length) params.set('tags', tags.join(','));
    if (untags.length) params.set('untags', untags.join(','));
    if (sort === 'upcoming') params.set('filter', 'popularcomingsoon');
    // "Newest": Steam's popular new releases, not every game that came out today.
    if (sort === 'new') params.set('filter', 'popularnew');
    const key = `steam:list:${params}`;
    const body = await cached(key, LIST_TTL_MS, () => steamListHttp.request(`${STORE}/search/results/?${params}`));
    // Steam may send more than asked for.
    return { rows: parseSearchHtml(body.results_html).slice(0, Math.min(count, 50)), total: Number(body.total_count) || 0 };
  }

  async function storeSearch(term) {
    const params = new URLSearchParams({ term, l: 'english', cc: 'US' });
    const body = await cached(`steam:search:${term.toLowerCase()}`, SEARCH_TTL_MS, () => steamListHttp.request(`${STORE}/api/storesearch/?${params}`));
    return (body.items || []).filter((i) => i.type === 'app' && i.id && i.name && !NOT_A_GAME.test(i.name)).map((i) => ({ appid: Number(i.id), name: i.name, image: bigCapsule(i.tiny_image) }));
  }

  async function appDetails(appid) {
    const body = await cached(`steam:app:${appid}`, TTL_MS, () => steamHttp.request(`${STORE}/api/appdetails?appids=${Number(appid)}&l=english&cc=US`));
    const entry = body?.[String(appid)];
    return entry?.success ? entry.data : null;
  }

  /** One of Steam's store items, kept small: { type, art, trailers }. */
  function slimItem(it) {
    const a = it.assets || {};
    const at = (file) => (file && a.asset_url_format ? ASSETS + a.asset_url_format.replace('${FILENAME}', file) : null);
    const trailers = [...(it.trailers?.highlights || []), ...(it.trailers?.other_trailers || [])].slice(0, 6).map((tr) => {
      const shot = (file) => (file && tr.trailer_url_format ? ASSETS + tr.trailer_url_format.replace('${FILENAME}', file) : null);
      const hls = (tr.adaptive_trailers || []).find((x) => x.encoding === 'hls_h264');
      const clip = (tr.microtrailer || []).find((x) => x.type === 'video/mp4');
      return hls ? {
        name: String(tr.trailer_name || 'Trailer').slice(0, 120),
        hls: VIDEOS + hls.cdn_path,
        preview: clip ? VIDEOS + clip.filename : null,
        thumb: shot(tr.screenshot_full) || shot(tr.screenshot_medium),
      } : null;
    }).filter(Boolean);
    return {
      type: Number.isInteger(it.type) ? it.type : null,
      art: {
        image: at(a.main_capsule),
        header: at(a.header),
        poster: at(a.library_capsule_2x) || at(a.library_capsule) || at(a.hero_capsule_2x) || at(a.hero_capsule),
        backdrop: at(a.library_hero_2x) || at(a.library_hero) || at(a.page_background),
        logo: at(a.library_logo_2x) || at(a.library_logo),
      },
      trailers,
    };
  }

  /** Steam's store items for these apps, many per request: appid -> { type, art, trailers } or null. */
  async function storeItems(appids) {
    const out = new Map();
    const missing = [];
    for (const appid of [...new Set(appids.map(Number).filter(Boolean))]) {
      const row = q.cacheGet.get(`steam:item:${appid}`);
      if (row && now() - row.fetched_at < TTL_MS) out.set(appid, JSON.parse(row.body));
      else missing.push(appid);
    }
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      const input = { ids: chunk.map((appid) => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true, include_trailers: true } };
      try {
        const body = await steamApiHttp.request(`${STEAM_API}/IStoreBrowseService/GetItems/v1/?${new URLSearchParams({ input_json: JSON.stringify(input) })}`);
        const items = body?.response?.store_items || [];
        for (const appid of chunk) {
          const it = items.find((x) => Number(x.appid) === appid && x.success !== 2);
          const slim = it && (it.name || it.assets) ? slimItem(it) : null;
          q.cachePut.run(`steam:item:${appid}`, JSON.stringify(slim), now());
          out.set(appid, slim);
        }
      } catch {
        // Steam's API is optional: old answers are used, or the art stays as it was.
        for (const appid of chunk) {
          const row = q.cacheGet.get(`steam:item:${appid}`);
          if (row) out.set(appid, JSON.parse(row.body));
        }
      }
    }
    return out;
  }

  /**
   * Steam's exact art (and item type) for rows not read yet or past the TTL, in one
   * request. With `gamesOnly`, rows Steam says aren't games (DLC, soundtracks) are left out.
   */
  async function withItems(rows, { gamesOnly = false } = {}) {
    const stale = rows.filter((r) => r?.steam_appid && (!r.assets_at || now() - r.assets_at > TTL_MS));
    const items = stale.length ? await storeItems(stale.map((r) => r.steam_appid)) : new Map();
    const fresh = rows.map((r) => {
      const item = r?.steam_appid ? items.get(r.steam_appid) : undefined;
      if (!item) return r;
      q.assets.run({ id: r.id, type: item.type, ...item.art, at: now() });
      return q.byId.get(r.id);
    });
    return gamesOnly ? fresh.filter((r) => r && (r.steam_type == null || r.steam_type === STEAM_GAME)) : fresh;
  }

  // ---- Wikipedia ----

  /** The summary of a Wikipedia article ({ text, url }), or null. CC BY-SA 4.0: shown with a link to the article. */
  async function wikipediaSummary(lang, title) {
    if (!title || !['en', 'ar'].includes(lang)) return null;
    try {
      const page = await cached(`wp:${lang}:${title}`, TTL_MS, () => wikipediaHttp.request(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(title).replace(/ /g, '_'))}`));
      const text = String(page?.extract || '').trim();
      return text && page.type !== 'disambiguation' ? { text: text.slice(0, 1500), url: page.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}` } : null;
    } catch {
      return null;
    }
  }

  // ---- Wikidata ----

  const WIKI_FIELDS = `?item ?steam ?label ?ar ?arDesc ?engineLabel ?epic ?gog ?site ?image ?date ?platform ?enwiki ?arwiki`;
  const WIKI_OPTIONALS = `
    OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "en") }
    OPTIONAL { ?item rdfs:label ?ar FILTER(LANG(?ar) = "ar") }
    OPTIONAL { ?item schema:description ?arDesc FILTER(LANG(?arDesc) = "ar") }
    OPTIONAL { ?item wdt:P408 ?engine . ?engine rdfs:label ?engineLabel FILTER(LANG(?engineLabel) = "en") }
    OPTIONAL { ?item wdt:P6278 ?epic }
    OPTIONAL { ?item wdt:P2725 ?gog }
    OPTIONAL { ?item wdt:P856 ?site }
    OPTIONAL { ?item wdt:P18 ?image }
    OPTIONAL { ?item wdt:P577 ?date }
    OPTIONAL { ?item wdt:P400 ?platform }
    OPTIONAL { ?enArticle schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?enwiki }
    OPTIONAL { ?arArticle schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>; schema:name ?arwiki }`;

  async function sparql(query) {
    const body = await wikiHttp.request(`${SPARQL}?${new URLSearchParams({ query, format: 'json' })}`, { headers: { Accept: 'application/sparql-results+json' } });
    return (body?.results?.bindings || []).map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  }

  /** Wikidata's rows grouped per item, with the engine mapped. */
  function wikiItems(rows) {
    const items = new Map();
    for (const r of rows) {
      const qid = /Q\d+$/.exec(r.item || '')?.[0];
      if (!qid) continue;
      const item = items.get(qid) || { qid, steam: null, label: null, titleAr: null, descriptionAr: null, engineLabel: null, engine: null, epic: null, gog: null, website: null, image: null, released: null, platforms: [], enwiki: null, arwiki: null };
      const platform = PLATFORMS[/Q\d+$/.exec(r.platform || '')?.[0]]?.[0];
      if (platform && !item.platforms.includes(platform)) item.platforms.push(platform);
      item.enwiki ||= r.enwiki || null;
      item.arwiki ||= r.arwiki || null;
      item.steam ||= r.steam ? Number(r.steam) : null;
      item.label ||= r.label || null;
      item.titleAr ||= r.ar || null;
      item.descriptionAr ||= r.arDesc || null;
      // Several engines: the first one GameShelf can patch wins.
      if (r.engineLabel && (!item.engine || !mapEngine(item.engineLabel))) {
        if (mapEngine(r.engineLabel) || !item.engineLabel) {
          item.engineLabel = r.engineLabel;
          item.engine = mapEngine(r.engineLabel);
        }
      }
      item.epic ||= r.epic || null;
      item.gog ||= r.gog || null;
      item.website ||= /^https?:\/\//.test(r.site || '') ? r.site : null;
      item.image ||= r.image ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(decodeURIComponent(r.image.split('/').pop()))}?width=600` : null;
      item.released ||= r.date ? r.date.slice(0, 10) : null;
      items.set(qid, item);
    }
    return [...items.values()];
  }

  /** Wikidata for these Steam apps (one query for all that aren't cached): appid -> item or null. */
  async function wikidataForApps(appids) {
    const out = new Map();
    const missing = [];
    for (const appid of appids) {
      const row = q.cacheGet.get(`wd:steam:${appid}`);
      if (row && now() - row.fetched_at < TTL_MS) out.set(appid, JSON.parse(row.body));
      else missing.push(appid);
    }
    for (let i = 0; i < missing.length; i += 40) {
      const chunk = missing.slice(i, i + 40);
      try {
        const items = wikiItems(await sparql(`SELECT ${WIKI_FIELDS} WHERE { VALUES ?steam { ${chunk.map((a) => sparqlString(a)).join(' ')} } ?item wdt:P1733 ?steam . ${WIKI_OPTIONALS} }`));
        for (const appid of chunk) {
          const item = items.find((it) => it.steam === appid) || null;
          q.cachePut.run(`wd:steam:${appid}`, JSON.stringify(item), now());
          out.set(appid, item);
        }
      } catch {
        // Wikidata is optional: Steam's data stands alone (old cached answers are still used).
        for (const appid of chunk) {
          const row = q.cacheGet.get(`wd:steam:${appid}`);
          out.set(appid, row ? JSON.parse(row.body) : null);
        }
      }
    }
    return out;
  }

  /**
   * Video games on Wikidata whose English or Arabic name matches `term` (for games
   * not on Steam): Wikidata's own search finds the items (fast, and outside the
   * query service's time budget), then one small query reads just those.
   */
  async function wikidataSearch(term) {
    const lang = isArabicText(term) ? 'ar' : 'en';
    return cached(`wd:find:${lang}:${term.toLowerCase()}`, SEARCH_TTL_MS, async () => {
      const params = new URLSearchParams({ action: 'wbsearchentities', search: String(term).slice(0, 100), language: lang, uselang: lang, type: 'item', limit: '20', format: 'json' });
      const found = await wikiApiHttp.request(`${WIKIDATA_API}?${params}`);
      // Wikidata's short description says what each item is: "1986 video game" stays; a series,
      // a character or a person doesn't. (Checking the item's type in the query takes far longer.)
      const ids = (found?.search || []).filter((s) => /^Q\d+$/.test(s.id) && isGameDescription(s.description)).map((s) => s.id);
      if (!ids.length) return [];
      const items = wikiItems(await sparql(`SELECT ${WIKI_FIELDS} WHERE { VALUES ?item { ${ids.map((id) => `wd:${id}`).join(' ')} }
        OPTIONAL { ?item wdt:P1733 ?steam } ${WIKI_OPTIONALS} }`));
      // In Wikidata's own order (its best match first).
      return items.sort((a, b) => ids.indexOf(a.qid) - ids.indexOf(b.qid));
    });
  }

  function applyWiki(row, item) {
    if (!item) return row;
    q.wiki.run({
      id: row.id, qid: item.qid, titleAr: item.titleAr, descriptionAr: item.descriptionAr, engine: item.engine, engineLabel: item.engineLabel,
      epic: item.epic, gog: item.gog, website: item.website, poster: row.steam_appid ? null : item.image,
      wikiEn: item.enwiki || null, wikiAr: item.arwiki || null,
      // A Steam game keeps Steam's platforms; Wikidata's are for games that aren't on Steam.
      platforms: !row.steam_appid && item.platforms?.length ? JSON.stringify(item.platforms) : null,
      at: now(),
    });
    return q.byId.get(row.id);
  }

  /** A row for a Wikidata-only game (Epic or GOG exclusive, console, older games). */
  function rowForWikiItem(item) {
    // A Steam game keeps Steam's name; Wikidata only adds to it.
    if (item.steam) {
      const row = q.byApp.get(item.steam) || (item.label ? rowForApp(item.steam, { name: item.label }) : null);
      return row ? applyWiki(row, item) : null;
    }
    let row = q.byQid.get(item.qid);
    if (!row) {
      const name = item.label || item.titleAr;
      if (!name) return null;
      q.insert.run({ id: uniqueId(name, item.qid.toLowerCase()), name, appid: null, qid: item.qid, image: item.image, released: item.released, percent: null, count: null });
      row = q.byQid.get(item.qid);
    }
    return applyWiki(row, item);
  }

  /** Fills the games table from Steam's page for the app (and Wikidata), within the cache's TTL. */
  async function refresh(row, { wiki = true } = {}) {
    let current = row;
    if (current.steam_appid && (!current.details_at || now() - current.details_at > TTL_MS)) {
      try {
        const d = await appDetails(current.steam_appid);
        if (d) {
          const platforms = ['windows', 'mac', 'linux'].filter((p) => d.platforms?.[p]).map((p) => ({ windows: 'PC', mac: 'macOS', linux: 'Linux' })[p]);
          const steamGenres = (d.genres || []).map((g) => g.description);
          const genres = GENRES.map((g) => g.name).filter((name) => steamGenres.some((s) => s.toLowerCase() === name.toLowerCase() || (name === 'Simulation' && /simulat/i.test(s)) || (name === 'Sports' && /sport/i.test(s))));
          q.details.run({
            id: current.id,
            name: d.name || current.name,
            description: htmlText(d.short_description) || null,
            released: d.release_date?.coming_soon ? null : isoDate(d.release_date?.date) || current.released,
            image: null,
            header: d.header_image ? String(d.header_image).replace(/\?.*$/, '') : null,
            backdrop: d.screenshots?.[0]?.path_full ? String(d.screenshots[0].path_full).replace(/\?.*$/, '') : null,
            genres: JSON.stringify(genres.length ? genres : steamGenres.slice(0, 3)),
            developers: JSON.stringify(d.developers || []),
            publishers: JSON.stringify(d.publishers || []),
            platforms: JSON.stringify(platforms.length ? platforms : ['PC']),
            website: /^https?:\/\//.test(d.website || '') ? d.website : null,
            at: now(),
          });
          current = q.byId.get(current.id);
        }
      } catch {
        // Steam unreachable or backing off: what's saved is shown.
      }
    }
    if (wiki && current.steam_appid && (!current.wikidata_at || now() - current.wikidata_at > TTL_MS)) {
      const item = (await wikidataForApps([current.steam_appid])).get(current.steam_appid);
      current = item ? applyWiki(current, item) : current;
    }
    return current;
  }

  /** Adds what Wikidata knows to many rows at once (one query), skipping fresh ones. */
  async function enrichWiki(rows) {
    const stale = rows.filter((r) => r.steam_appid && (!r.wikidata_at || now() - r.wikidata_at > TTL_MS));
    if (!stale.length) return rows;
    const found = await wikidataForApps(stale.map((r) => r.steam_appid));
    return rows.map((r) => (found.get(r.steam_appid) ? applyWiki(r, found.get(r.steam_appid)) : r));
  }

  /** The row for an id: saved, or (for ids from before, such as old IGDB slugs) found by name once and kept. */
  async function resolve(id) {
    const saved = q.byId.get(id) || q.aliasOf.get(id);
    if (saved) return saved;
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) return null;
    // Old ids may carry a suffix that isn't part of the name: "dead-space--1" (IGDB's
    // second "Dead Space"), "hollow-knight-367520", "zelda-q12345".
    const bare = id.replace(/--\d+$/, '').replace(/-(\d{5,}|q\d+)$/, '');
    const words = bare.replace(/-+/g, ' ').trim();
    if (!words) return null;
    const keep = (row) => {
      if (row && row.id !== id) q.addAlias.run(id, row.id);
      return row;
    };
    // Steam first: the words as they are, then with Roman numerals as digits, then
    // the first words (Steam's search misses "mouse pi for hire" but finds "mouse").
    const digits = titleWords(words).join(' ');
    const firstTwo = words.split(' ').slice(0, 2).join(' ');
    const firstOne = words.split(' ')[0];
    let match = null;
    for (const attempt of [...new Set([words, digits, firstTwo, firstOne])].filter((a) => a.length >= 4)) {
      try {
        match = bestMatch(await storeSearch(attempt), words, (s) => s.name);
      } catch {}
      if (match) break;
    }
    if (match) {
      const existing = q.byApp.get(match.appid);
      // Another id already points at this app: this id becomes another name for it.
      if (existing) return keep(existing);
      q.insert.run({ id, name: match.name, appid: match.appid, qid: null, image: match.image, released: null, percent: null, count: null });
      return q.byId.get(id);
    }
    try {
      const item = bestMatch(await wikidataSearch(words), words, (it) => it.label || '');
      if (item && !item.steam && !q.byQid.get(item.qid)) {
        q.insert.run({ id, name: item.label, appid: null, qid: item.qid, image: item.image, released: item.released, percent: null, count: null });
        return applyWiki(q.byId.get(id), item);
      }
      if (item) return keep(rowForWikiItem(item));
    } catch {}
    return null;
  }

  const tagsFor = (words = []) => words.map((w) => TAGS[String(w).toLowerCase()]).filter(Boolean);

  // Wikidata for lists is added in the background: lists show at once, and
  // Arabic titles and engines appear the next time (or on the game's page).
  let backgroundWiki = Promise.resolve();
  const enrichLater = (rows) => {
    backgroundWiki = backgroundWiki.then(() => enrichWiki(rows)).catch(() => {});
    return backgroundWiki;
  };

  async function listed(opts, pageSize, { wait = false } = {}) {
    const { rows } = await steamList({ ...opts, count: pageSize });
    // Steam's exact art for the whole list: one request, then cached.
    const games = await withItems(rows.map((r) => rowForApp(r.appid, r)).filter(Boolean));
    if (wait) return enrichWiki(games);
    enrichLater(games);
    return games;
  }

  function parseLanguages(html) {
    // "English<strong>*</strong>, French<strong>*</strong>, Arabic<br><strong>*</strong>languages with full audio support"
    const text = String(html || '').split(/<br\s*\/?>/i)[0];
    return text.split(',').map((part) => {
      const name = htmlText(part.replace(/<strong>\*<\/strong>/g, '')).replace(/\*$/, '').trim();
      return name ? { name, interface: true, subtitles: true, audio: /<strong>\*<\/strong>|\*/.test(part) } : null;
    }).filter(Boolean);
  }

  return {
    name: 'steam',

    async search({ query: text = '', genre = '', sort = 'popular', page = 1, pageSize = 24 }) {
      const term = expandShortNames(String(text).trim());
      if (term) {
        if (page !== 1) return { count: 0, hasMore: false, results: [] };
        // Games only, and only ones whose name has the words searched for ("black ops 7"
        // finds Black Ops 7, not its season passes or other games); the exact name first.
        const words = titleWords(term);
        // The words together and in order ("the last of us" isn't "The Last Kich Of Us"); the last may be half typed.
        const relevant = (name) => {
          const have = titleWords(name);
          const same = (h, w, last) => h === w || (last && w.length >= 2 && h?.startsWith(w));
          for (let at = 0; at + words.length <= have.length; at += 1) {
            if (words.every((w, i) => same(have[at + i], w, i === words.length - 1))) return true;
          }
          return !words.length;
        };
        const wanted = (name) => relevant(name) && (!EXTRAS.test(name) || EXTRAS.test(term));
        let rows = [];
        if (!isArabicText(term)) {
          try {
            const { rows: found } = await steamList({ term, count: 50 });
            rows = found.filter((r) => wanted(r.name)).slice(0, 24).map((r) => rowForApp(r.appid, r));
          } catch {}
          if (!rows.length) {
            try {
              // Steam's quick search knows some names its results page misses; still only matching ones.
              rows = (await storeSearch(term)).filter((s) => wanted(s.name)).map((s) => rowForApp(s.appid, s));
            } catch {}
          }
        }
        rows = await withItems(rows.filter(Boolean), { gamesOnly: true });
        // Few or no Steam games: Wikidata has games that aren't on Steam (console, Epic, GOG).
        if (rows.length < 3) {
          const asked = wikidataSearch(term).catch(() => []);
          const items = await Promise.race([asked, new Promise((resolve) => { setTimeout(() => resolve([]), WIKI_SEARCH_WAIT_MS).unref?.(); })]);
          const editions = new Set(['edition', 'deluxe', 'bundle', 'pack', 'collection', 'expansion', 'dlc']);
          for (const item of items) {
            // The same rule as Steam's results: the words searched for, in its English (or Arabic) name.
            if (!isArabicText(term) && !wanted(item.label || '')) continue;
            // Editions and bundles of a game aren't another game, unless asked for.
            if (titleWords(item.label || '').some((w) => editions.has(w) && !words.includes(w))) continue;
            const row = rowForWikiItem(item);
            if (row && !rows.some((f) => f.id === row.id)) rows.push(row);
          }
        }
        // Wikidata may point at a Steam app that's an add-on: Steam's type decides again.
        rows = (await withItems(rows.filter(Boolean), { gamesOnly: true }))
          .map((r, i) => ({ r, i, score: Math.max(titleScore(r.name, term), r.title_ar && titleScore(r.title_ar, term) ? 100 : 0) }))
          .sort((a, b) => b.score - a.score || a.i - b.i).map(({ r }) => r);
        // Arabic titles and engines come in the background (Wikidata can be slow).
        enrichLater(rows);
        return { count: rows.length, hasMore: false, results: rows.map(summary) };
      }
      const tag = genre ? GENRE_TAGS[findGenre(genre)?.name] : null;
      if (genre && !tag) return { count: 0, hasMore: false, results: [] };
      const rows = await listed({ tags: tag ? [tag] : [], untags: [TAGS.erotic], sort, start: (page - 1) * pageSize }, pageSize);
      return { count: rows.length, hasMore: rows.length === pageSize, results: rows.map(summary) };
    },

    /** Games for a seasonal section or mood (src/seasons.js): each group's first known word is a Steam tag. */
    async collection({ all = [], not = {}, sort = 'popular', pageSize = 24 }) {
      const tags = [];
      for (const group of all) {
        const tag = tagsFor([...(group.themes || []), ...(group.genres || []), ...(group.modes || [])])[0];
        if (!tag) return [];
        tags.push(tag);
      }
      const untags = [...new Set([TAGS.erotic, ...tagsFor([...(not.themes || []), ...(not.genres || [])])])];
      const rows = await listed({ tags, untags, sort }, pageSize);
      return rows.map(summary);
    },

    /** Fills in Steam's real artwork and dates for a few games at a time (the rest come from the cache later). */
    async addSteamArt(games) {
      const rows = games.map((g) => (g?.id ? q.byId.get(g.id) : null));
      const fresh = await withItems(rows.filter(Boolean));
      const byId = new Map(fresh.map((r) => [r.id, r]));
      for (const g of games) if (g?.id && byId.has(g.id)) Object.assign(g, summary(byId.get(g.id)));
      return games;
    },

    // Steam app ids map straight to rows: exact, and no requests.
    async matchSteamGames(steamGames) {
      return steamGames.map((s) => {
        const row = rowForApp(s.appid, { name: s.name });
        return row ? summary(row) : null;
      });
    },

    async getGame(id) {
      let row = await resolve(String(id));
      if (!row) return null;
      row = await refresh(row);
      // Wikidata for a game that isn't on Steam (its platforms and Wikipedia articles), when not read yet.
      if (!row.steam_appid && /^Q\d+$/.test(row.wikidata_qid || '')) {
        try {
          const qid = row.wikidata_qid;
          const [item] = await cached(`wd:item:${qid}`, TTL_MS, async () => wikiItems(await sparql(`SELECT ${WIKI_FIELDS} WHERE { BIND(wd:${qid} AS ?item) ${WIKI_OPTIONALS} }`)));
          if (item) row = applyWiki(row, item);
        } catch {}
      }
      [row] = await withItems([row]);
      const base = summary(row);
      const details = row.steam_appid ? await appDetails(row.steam_appid).catch(() => null) : null;
      const item = row.steam_appid ? (await storeItems([row.steam_appid])).get(row.steam_appid) : null;
      // Steam describes its games; for the others (and in Arabic), Wikipedia's summary, credited.
      const steamText = base.description || (details ? htmlText(details.short_description) : null) || null;
      const wikiEn = steamText ? null : await wikipediaSummary('en', row.wiki_en);
      const wikiAr = await wikipediaSummary('ar', row.wiki_ar);
      const platformStores = json(row.platforms).map((p) => Object.values(PLATFORMS).find(([name]) => name === p)?.[1]).filter(Boolean);
      const stores = [
        { key: 'steam', url: row.steam_appid ? `${STORE}/app/${row.steam_appid}/` : undefined, when: row.steam_appid },
        { key: 'epic', url: row.epic_slug ? `https://store.epicgames.com/p/${encodeURIComponent(row.epic_slug)}` : undefined, when: row.epic_slug },
        { key: 'gog', url: row.gog_slug ? `https://www.gog.com/en/${row.gog_slug.replace(/[^\w/-]/g, '')}` : undefined, when: row.gog_slug },
        // Console and phone games: a search on their store (Wikidata has no product pages for them).
        ...[...new Set(platformStores)].map((key) => ({ key, when: true })),
      ].filter((s) => s.when).map(({ key, url }) => ({ key, url }));

      let similar = [];
      try {
        const genre = base.genres[0];
        if (genre && GENRE_TAGS[genre]) similar = (await listed({ tags: [GENRE_TAGS[genre]], untags: [TAGS.erotic] }, 14)).filter((r) => r.id !== row.id).slice(0, 12).map(summary);
      } catch {}

      // Trailers first (Steam streams them as HLS; the page plays them), then screenshots.
      const trailers = (item?.trailers || []).map((tr) => ({ type: 'video', name: tr.name, thumb: tr.thumb || base.image, hls: tr.hls, preview: tr.preview }));
      const media = [...trailers, ...(details?.screenshots || []).slice(0, 14).map((s) => ({ type: 'image', thumb: s.path_thumbnail, full: s.path_full }))];
      const links = [
        row.website ? { label: 'Official website', url: row.website } : null,
        row.wikidata_qid ? { label: 'Wikidata', url: `https://www.wikidata.org/wiki/${row.wikidata_qid}` } : null,
      ].filter(Boolean);
      return {
        ...base,
        description: steamText || wikiEn?.text || null,
        descriptionAr: wikiAr?.text || row.description_ar || null,
        // Text from Wikipedia is CC BY-SA: the page says so and links the article.
        descriptionSource: !steamText && wikiEn ? { name: 'Wikipedia', url: wikiEn.url, license: 'CC BY-SA 4.0' } : null,
        descriptionArSource: wikiAr ? { name: 'ويكيبيديا', url: wikiAr.url, license: 'CC BY-SA 4.0' } : null,
        engineLabel: row.engine_label || null,
        developers: json(row.developers),
        publishers: json(row.publishers),
        website: row.website || null,
        buy: buildBuyLinks(row.name, stores),
        similar,
        media,
        scores: {
          critics: details?.metacritic?.score ? { score: details.metacritic.score, count: null } : null,
          players: row.review_percent != null && row.review_count ? { score: row.review_percent, count: row.review_count } : null,
        },
        features: (details?.categories || []).map((c) => c.description).slice(0, 12),
        languages: parseLanguages(details?.supported_languages),
        links,
        editions: [],
        addons: [],
        epicSlug: row.epic_slug || null,
        gogSlug: row.gog_slug || null,
      };
    },

    // For tests and the backfill script.
    resolve,
    refresh,
    settled: () => backgroundWiki,
  };
}

module.exports = { createSteamWikidataProvider, mapEngine, slugify, titleScore, TAGS, MetadataError, USER_AGENT };
