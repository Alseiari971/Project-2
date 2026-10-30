# GameShelf

Look up any game in the world, see where to buy it, and keep a public list of the games you've played.

- **Every game:** search and browse games on every platform, PC, PlayStation, Xbox, Nintendo and mobile, through [IGDB](https://www.igdb.com), the free game database run by Twitch.
- **We don't sell anything:** each game page has "Where to buy" links to the real stores (Steam, Epic, GOG, PlayStation Store, Xbox, Nintendo eShop, itch.io, App Store, Google Play).
- **Live prices:** the best current PC price, every store's price and the all-time low, from [CheapShark](https://www.cheapshark.com) (free, no key needed, US dollars).
- **Steam import:** paste your Steam profile link to bring in your games and hours played.
- **Game launcher look:** a sidebar with your games, a search pop-up (Ctrl+K or `/`), a Top 10 poster row, a Library page with grid and list views, and a bottom tab bar on phones.
- **A home page that changes with the seasons:** a full-width spotlight plays each game's silent 6-second Steam preview loop behind its logo, rotating through six games. The season sets the colors, a moving decoration and its own sections:
  - *Fright Night* (Halloween, Oct 17 to Nov 2): embers, survival horror, co-op horror, new horror
  - *Winter Shelf* (Dec 10 to Jan 6): snow, the best of the year, your year on GameShelf, cozy and couch co-op games
  - *Ramadan Nights* (the month of Ramadan): a crescent moon and stars, co-op for after iftar, party games for the majlis, long stories for late nights
  - *Eid Mubarak* (Eid al-Fitr and Eid al-Adha): sparkles, gift-worthy and family games
  - *Lunar New Year* (its first 15 days): lanterns, family, fighting and legend games
  - *Summer Heat* (Jun 15 to Aug 31): drifting light, open worlds and summer co-op

  The page itself takes on the colors of the game in the spotlight, shifting with each one.
- **Hover previews:** rest the mouse on any game card on the home page and it opens a bigger card playing the game's preview loop, with View game, Want to play and (in the Windows app) Play.
- **Moods:** "What are you in the mood for?" chips (Scary, Chill, With friends, A great story, Competitive, Quick fun, Brain teasers, Open world) each fill a row instantly. Needs IGDB.
- **Discovery queue:** ten well-liked games, full screen, one at a time with their preview loop. Decide with a click, a key (W to want, → to skip) or a swipe on touch screens. Skipped games stay out of later queues on that device.
  Ramadan, Eid and Lunar New Year follow the Islamic (Umm al-Qura) and Chinese calendars built into the browser, so their dates are always right. Every season also has a release countdown for upcoming games. The "Seasonal look" menu at the bottom of the home page can turn seasons off or preview any of them. The spotlight pauses on hover and has a pause button; with "reduce motion" turned on it holds still and plays no video. Seasonal sections need IGDB; the sample catalog shows the spotlight only.
- **Steam-style profiles:** add games to your list as *Playing*, *Completed*, *Played*, *Want to play* or *Dropped* with a half-star rating, then customize your profile:
  - an avatar (upload your own) with an animated frame
  - a background, either a preset scene or art from any game on your list
  - a theme color, a headline, a location and a bio
  - up to 4 showcases: favorite game, a hand-picked collection, highest rated, completed games, stats or a custom text box
  - levels, XP and bronze/silver/gold badges earned from your list, plus a comment wall
- Each game page shows who on GameShelf has played it.
- **English and Arabic:** the whole site and app in either language, switched with the globe button in the top bar (or in App settings). Arabic turns everything right to left: the sidebar moves to the right, arrows point the other way, and in the Windows app the window buttons move to the left. See [Arabic](#arabic) below.

## Run it

You need [Node.js](https://nodejs.org) 22.13 or newer (the LTS download is fine). Nothing gets compiled during install: the database is the SQLite built into Node.

```bash
npm install
npm start
```

Then open http://localhost:3000.

Out of the box the site uses a small built-in catalog of about 35 popular games, so you can try it right away.

## Windows app

GameShelf also comes as a desktop app. It runs everything on your computer, so it works without hosting the website anywhere.

- **Try it from the code:** `npm install`, then `npm run app`. It uses the same `.env` keys and database as `npm start`.
- **Make the installer:** on a Windows PC, run `npm run dist`. You get `dist/GameShelf-Setup-0.1.0.exe`. Double-click it to install; it adds GameShelf to the Start menu and the desktop.

The installed app opens on a welcome page where you paste your IGDB keys (and optionally a Steam key). You can change them later with the settings button next to your avatar. The keys, your accounts and your lists are saved in `%APPDATA%\GameShelf` on that PC.

Good to know:

- The installer isn't code-signed, so the first time Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**. Signing needs a paid code-signing certificate.
- If `npm run dist` stops with "Cannot create symbolic link", turn on **Developer Mode** in Windows Settings (System, For developers) or run the terminal as administrator, then try again.
- **Play installed games:** the app finds games installed through Steam, the Epic Games Launcher and GOG Galaxy. They show up in an "Installed on this PC" row on Home, and their game pages get a **Play** button that starts the game through its launcher. While a game runs, Play turns into a white **Stop** button (this also notices games started from Steam or a shortcut). Stop asks the game to close and forces it after 5 seconds. The arrow on the right of the Play button opens the game's options: which graphics card Windows uses for it (the same setting as Windows' Graphics settings; for Steam and Epic games this appears after you've played once, so GameShelf knows which program is the game), Open game folder, and for Steam games launch options and properties, Verify game files and Uninstall. GOG games can be uninstalled too, and games you added can be removed. Other launchers (Xbox app, EA app, Ubisoft Connect, Battle.net) aren't detected yet, but any game can be added by hand: click **Add a game** at the end of the Home row and pick its `.exe` file. Added games are listed, and can be removed, in App settings.
- Store links and trailers open in your normal web browser. The window's top bar works as the title bar: drag it to move the window, double-click it to maximize. Its round minimize, maximize and close buttons sit at the right, or at the left in Arabic. Mouse back/forward buttons, Alt+Left/Right, F5, F11 and Ctrl +/- zoom work as you'd expect.
- **Discord activity:** while you play a game started from GameShelf, your Discord profile shows it: the game's name, its cover, which launcher, how long you've played, and a "View game" button. Players don't set anything up; it works whenever the Discord app is open on the same PC with **Share your detected activities with others** turned on (Discord settings, Activity Privacy). It can be turned off in App settings. It talks only to the Discord app on the PC; no Discord login is involved.

  **One-time setup for whoever builds GameShelf:** Discord needs to know the activity comes from GameShelf, so GameShelf has its own Discord application, the same for every player (like any app with a Discord activity). Create it once at https://discord.com/developers/applications (**New Application**, named `GameShelf`, with `desktop/icon.png` as its App Icon), then put its **Application ID** in `desktop/config.json` as `discordApplicationId`. The ID is public, not a secret, so it's fine to commit. Until it's set, the Discord option is greyed out.
- Accounts made in the app live on that computer only. To let people see each other's profiles, the website has to be hosted online; the app can then be pointed at it.

### Connect the full game database (IGDB)

Out of the box GameShelf shows a 35-game sample. Connect IGDB, the game database run by Twitch, to get every game on every platform with official cover art. It's free:

1. Sign in at https://dev.twitch.tv/console/apps with a Twitch account. Twitch requires two-factor login for this; turn it on in your Twitch security settings if it asks.
2. Click **Register Your Application** and fill in:
   - **Name:** anything unique, for example `GameShelf-yourname`
   - **OAuth Redirect URLs:** `https://localhost` (GameShelf doesn't use it, but Twitch requires one; leave no empty rows)
   - **Category:** Website Integration
   - **Client Type:** Confidential (not Public: public apps get no Client Secret)
3. Click **Create**, then **Manage** next to the new app. Copy the **Client ID**, then click **New Secret** and copy the **Client Secret**.
4. Put both in your `.env` file (copy `.env.example` if you don't have one):
   ```
   IGDB_CLIENT_ID=your-client-id
   IGDB_CLIENT_SECRET=your-client-secret
   ```
5. Restart with `npm start`. The terminal should say `Game data: IGDB.`

Keep the Client Secret private: don't share it or commit it. `.env` is excluded from git.

### Other optional keys

| Setting | What it unlocks | Where to get it (free) |
| --- | --- | --- |
| `STEAM_API_KEY` | "Import from Steam" | https://steamcommunity.com/dev/apikey (any domain works, e.g. `localhost`) |
| `RAWG_API_KEY` | Older alternative game database, used only when IGDB isn't set up | https://rawg.io/apidocs |

Steam import only works for profiles whose **Game details** are set to Public in Steam's privacy settings. With IGDB, Steam games are matched exactly by their Steam ID.

### Checking search results

When using RAWG, if a search shows odd games, `npm run search-debug -- <search words>` prints everything RAWG returned (popularity, stores) and which results GameShelf kept. It uses the RAWG key in your `.env`.

## Arabic

Every page, menu, message and error has an Arabic translation, with Arabic plurals (لعبة واحدة، لعبتان، 3 ألعاب، 11 لعبة). The first visit picks Arabic when the browser or Windows is set to Arabic; after that the visitor's choice is remembered on their device. Numbers use Western digits (2026, $29.99), like the game stores. The About this game text and system requirements come from Steam's Arabic store page when the publisher wrote one, and stay in English otherwise. Game names, store names and what users write stay as they are, and keep their own direction inside Arabic text.

**Fonts.** Arabic text uses [Alexandria](https://fonts.google.com/specimen/Alexandria) (SIL Open Font License), which comes with GameShelf. If [Thmanyah Sans](https://thmanyah.com) is installed on the computer, it's used instead. Thmanyah's license doesn't allow passing its font files on, so they aren't in this repository or the installer. To use Thmanyah on a website you host, put the files you downloaded from Thmanyah in `public/fonts/thmanyah/`, named `regular.otf`, `medium.otf`, `bold.otf` and `black.otf` (that folder is in `.gitignore`).

**Adding a phrase.** Text in the code is written in English and passed through `t()` (from `public/js/i18n.js`). Add its Arabic to `public/js/lang/ar.js`. `npm test` fails if any phrase, or any error message from the server, has no Arabic.

## Arabic subtitles in games

Many single-player games have no Arabic, and most game engines can't draw it: they show Arabic as separate letters in reverse order. In the Windows app, a game page with a **Play** button also has an **Arabic subtitles** switch beside it. Under its name the switch says how Arabic would come:

- **Native patch:** the game's engine takes an added Arabic patch (Unreal and Unity games without anti-cheat). It goes in when you press Play, and comes out when you switch it off.
- **Accessibility overlay:** GameShelf reads the game's English subtitles off the screen and shows the Arabic over them, without touching the game. This is what games with anti-cheat, signed files or their own engines get.
- **Unavailable:** there's no Arabic pack for the game (hover for the reason).

The pieces, in `localization/` and `desktop/localization/`:

**1. The Arabic compiler** (Python, run when a pack is made, not on players' PCs). It turns Arabic translations into text a left-to-right engine shows correctly:
- letters already joined, using only Arabic Presentation Forms-B (U+FE70–U+FEFF), the glyphs game fonts are built from;
- lines over 55 characters wrapped first, in reading order, then each line put in screen order on its own, so two-line subtitles read top to bottom;
- the game's markup kept working: `<color=#fff>…</color>`, Unreal's `</>`, `{0}`, `%s`, `%1$s`, `%PLAYER%`, `[E]`, `[Press E]`, `<sprite=…>`, `<br>` and `\n`.

```bash
pip install -r localization/requirements.txt
```
```bash
cd localization && python -m arabic_compiler translations.csv --out build/my-game
```

The input is a CSV with `source` and `arabic` columns (or JSON). It writes the XUnity.AutoTranslator dictionary, a CSV and JSON of the compiled lines (for Unreal `.locres` tools), `charset.txt` (every glyph the game's Arabic font needs) and `fingerprints.json` for the overlay (below). Tests: `cd localization && python -m unittest discover -s tests`.

**2. Checks before launch** (`desktop/localization/`). Before anything is changed, GameShelf:
- looks for anti-cheat software in the game's folder (Easy Anti-Cheat, BattlEye, Riot Vanguard, Ricochet, EA Javelin, PunkBuster, GameGuard, XIGNCODE3, Anti-Cheat Expert and others). If any is found, or the check can't finish, the game's files are never changed; only the overlay is offered;
- works out the engine: Unreal Engine 4/5 (`Engine/` plus `Content/Paks/*.pak` or `.utoc`), Unity (`UnityPlayer.dll`, `<Game>_Data/`, Mono or IL2CPP, and its version), or a custom engine (overlay only). Unreal games with signed paks, and Unity games that already have BepInEx mods, also get the overlay only.

**3. Adding and removing the Arabic files.**
- **Unreal:** a patch pak named like `pakchunk99-ArabicLocalization_P.pak` goes into `Content/Paks`, where the game loads it after its own files.
- **Unity:** BepInEx and XUnity.AutoTranslator, with the compiled dictionary and an Arabic TextMeshPro fallback font. GameShelf writes the AutoTranslator settings itself: no translation service at all, only the dictionary, so nothing is sent anywhere and lookups are instant.

Files are only ever added, never replaced: if any name is taken, nothing is added. A record is saved before the first file is written, so a crash halfway is undone on the next start. Turning Arabic off removes only files that are still exactly what was added, and folders GameShelf created; anything the player changed or added is left and listed. Nothing is changed while the game is running.

**4. The overlay** (Windows 10 and 11). When the game starts, GameShelf finds its window and keeps a see-through, click-through band over its subtitle area (the bottom 22% unless the pack says otherwise). It never takes focus or clicks, and closes when the game does.
- Windows captures the game's window. A few times a second the subtitle area's brightness is checked against the last frame, which costs well under a millisecond. Only when the text has changed and then held still for one tick (so subtitles that type out or fade in aren't read halfway) is it read with Windows' own OCR. When the text disappears, the Arabic is hidden at once, without OCR.
- What OCR read is looked up in the pack's `fingerprints.json`. That file holds fingerprints of the English lines, not the lines themselves: each line's length, a 64-bit SimHash and its hashed character trigrams. Lookups ignore case, punctuation, spaces and the letters OCR mixes up (I/l/1, O/0, rn/m), allow for names the game fills in (`{0}`), and show the Arabic only when the match scores at least 0.72. A 50,000-line table answers in about a millisecond.
- The Arabic is drawn by the app itself, properly joined and right to left, in Thmanyah Sans if it's installed or Alexandria. It covers the English when the overlay can't end up in the capture (the game's window is captured on its own, or Windows 10 2004 and later); otherwise it sits just above.
- In testing with a stand-in game, the Arabic appeared about 0.16 s after a subtitle changed, plus whatever Windows' OCR takes on the PC. It works with windowed and borderless games, not exclusive full screen. It needs Windows' English OCR, which English Windows has; elsewhere add English under Language settings.

The OCR runs in a Windows PowerShell helper (`desktop/localization/ocr-helper.ps1`), so nothing needs to be compiled. To try the overlay elsewhere, `scripts/fake-ocr-helper.js` stands in for it: run the app with `GAMESHELF_OCR_HELPER=scripts/fake-ocr-helper.js` (and `GAMESHELF_PACK_KEY_FILE` pointing at a test `pack-signing.pub`).

**Packs** come from a folder with `pack.json` (each file's place and SHA-256) and `pack.json.sig`. Add them in App settings under **Arabic subtitle packs**. Each pack says which game it's for (a Steam app ID or a GameShelf game ID). A Unity pack puts a DLL in the game's folder, so packs must be signed with GameShelf's key, and each file must match its hash. Make the key once, and keep `pack-signing.key` secret, outside the repository:

```bash
node scripts/localization-pack.js keygen ../gameshelf-keys
```

Put the contents of `pack-signing.pub` in `desktop/config.json` as `"localizationPackKey"`. Until it's set, no pack is accepted. Then sign each pack:

```bash
node scripts/localization-pack.js make my-pack --engine unity --id my-game-ar --version 1.0.0 --steam-app-id 123456 --key ../gameshelf-keys/pack-signing.key --font-bundle gameshelf_arabic_sdf --backend mono
```

An overlay pack holds just the compiler's `fingerprints.json` (in `my-pack/payload/`). `--region x,y,w,h` moves the subtitle area, `--text-luma` sets how bright subtitle text is, `--dark-text` is for dark subtitles on light boxes, and `--threshold` sets how sure a match must be:

```bash
node scripts/localization-pack.js make my-pack --engine overlay --id my-game-ar-overlay --version 1.0.0 --steam-app-id 123456 --title "My Game in Arabic" --key ../gameshelf-keys/pack-signing.key
```

**Before publishing packs:** a translation of a game's text is based on the publisher's work, so a pack needs the publisher's permission, or a community translation the publisher allows. Some games' terms also forbid changing their files even offline, so only make packs for games whose publishers allow mods. Packs never get around encrypted or signed game files. Fingerprints keep the English script out of plain sight, but someone determined could rebuild much of a line from them, so they don't replace that permission.

Still to come: downloading packs from a server (for now they're added in App settings).

## Project layout

```
server.js            starts the website
src/api.js           JSON API (games, accounts, lists, profiles, comments)
src/profile.js       profile customization, levels and badges
src/steam.js         reading a Steam library
src/prices.js        live prices from CheapShark
src/steam-store.js   About, requirements, Metacritic, achievements and preview loops from Steam store pages
src/seasons.js       which games each season's home page sections show
src/auth.js          passwords, login sessions
src/db.js            SQLite database built into Node (saved to data/gameshelf.db, upgraded automatically)
src/games/igdb.js    the IGDB game database (every game, every platform)
src/games/rawg.js    the RAWG game database (older alternative)
src/games/local.js   built-in sample catalog (data/games.json)
src/games/stores.js  "where to buy" store links
src/games/genres.js  genres you can browse by
desktop/             the Windows app (Electron): window, settings file, installed and running games, games added by hand, app icon
desktop/localization/ Arabic in games: anti-cheat check, engine detection, signed packs and their files, the subtitle overlay (capture, change detection, OCR helper, fingerprint matching)
desktop/overlay/     the overlay's two windows: the Arabic subtitles, and the hidden capture
localization/        the Arabic compiler (Python) for engines that can't shape Arabic
public/css/          the stylesheet
public/fonts/        the Manrope and Alexandria fonts (SIL Open Font License)
public/js/i18n.js    English and Arabic: t() for phrases, tn() for counts; lang/ar.js has the Arabic
public/js/boot.js    sets the page's language and direction before it's drawn
public/js/main.js    navigation and page routing
public/js/palette.js the search pop-up
public/js/preview.js hover previews; discover.js the discovery queue; art-color.js the page tint
public/js/seasons.js when each season runs, and its look (season-fx.js draws its decoration)
public/js/views/     one file per page (home, browse, game, library, profile, edit profile, import, community, log in, about & legal, app settings)
scripts/             developer tools (search-debug, localization-pack, fake-ocr-helper)
test/                automated tests: npm test
```

## Data sources and legal notes

GameShelf credits each source where its data appears and on the About & legal page (`#/legal`):

- **IGDB** (Twitch): game data, covers, screenshots and trailers. IGDB's terms require attribution; using it in a product that makes money needs a separate agreement with Twitch.
- **CheapShark**: prices. Buy buttons use CheapShark's own redirect links, as its terms ask.
- **Steam store pages**: "About this game", system requirements, achievements, features and Metacritic scores, credited and linked back to the store page.
- **YouTube**: trailers play in YouTube's official embedded player (privacy-enhanced mode), only after the visitor presses play.
- **Fonts**: Manrope and Alexandria are under the SIL Open Font License (license files in `public/fonts/`). Thmanyah Sans isn't included; see [Arabic](#arabic).

Users can delete their account and all their data from Edit profile. This isn't legal advice; check each service's current terms before launching publicly.

## API (for the future mobile app)

The website talks to the server only through this JSON API, so a phone app can reuse it unchanged.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/home?season=` | The home screen: spotlight, the season's sections and rows (`season`: fright-night, winter, ramadan, eid, lunar-new-year, summer) |
| GET | `/api/steam/:appId/microtrailer` | Steam's silent 6-second preview loop for a game |
| GET | `/api/moods/:id` | A row of games for a mood (scary, chill, friends, story, competitive, quick, brainy, open-world) |
| GET | `/api/discover?skip=` | Ten games for the discovery queue, leaving out your list and the IDs in `skip` |
| GET | `/api/games?search=&genre=&sort=&page=` | Search or browse games (`sort`: popular, new, top) |
| GET | `/api/games/:id` | Game details, store links, who's played it |
| GET | `/api/games/:id/prices` | Current PC deals (cheapest first) and the all-time low |
| POST | `/api/auth/register` | `{ username, password }` |
| POST | `/api/auth/login` | `{ username, password }` |
| POST | `/api/auth/logout` | |
| GET | `/api/me` | The logged-in user (or `null`) |
| PATCH | `/api/me` | `{ displayName, headline, bio, country, avatarFrame, background, accent, showcases }` |
| PUT | `/api/me/avatar` | `{ image }` as a JPEG/PNG/WebP data URL |
| DELETE | `/api/me/avatar` | Removes your avatar |
| PUT | `/api/me/library/:gameId` | `{ status, rating }` adds or updates a game on your list (rating 1 to 10, shown as half stars) |
| DELETE | `/api/me/library/:gameId` | Removes a game from your list |
| POST | `/api/me/import/steam/preview` | `{ profile }` reads a Steam library and matches the games |
| POST | `/api/me/import/steam/commit` | `{ previewId, items: [{ appid, status }] }` adds the chosen games |
| GET | `/api/users?search=` | Find people |
| GET | `/api/users/:username` | A profile: game list, showcases, level, badges, comments |
| POST | `/api/users/:username/comments` | `{ body }` leaves a comment on a profile |
| DELETE | `/api/comments/:id` | Deletes a comment (its author or the profile owner) |

Logins use a cookie session. A native mobile app would most likely switch to token auth (an `Authorization` header), which is a small change in `src/auth.js`.
