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

## Hosting the website on a VPS

`deploy/setup-vps.sh` sets up the website on a fresh Ubuntu or Debian server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/Alseiari971/Project-2/claude/clever-brahmagupta-stqn0m/deploy/setup-vps.sh -o setup-vps.sh && bash setup-vps.sh
```

It installs Node.js 22 and [Caddy](https://caddyserver.com) (which gets the HTTPS certificate), runs GameShelf as a `gameshelf` service under its own user, keeps the database in `/var/lib/gameshelf` with a daily backup in `/var/backups/gameshelf` (two weeks kept; copy them off the server now and then too), and lets only SSH, HTTP and HTTPS through the firewall. Without a domain the site gets `<ip-with-dashes>.sslip.io`, a free name that points at the server; once your own domain's A record points at the server, run `bash setup-vps.sh your-domain.com`. Running the script again also updates GameShelf.

Keys go in `/etc/gameshelf.env` (readable only by root; see Settings below), then `systemctl restart gameshelf`. The log: `journalctl -u gameshelf -n 50`.

**Admins and the Admin Panel.** Accounts are `user`s unless they're admins. Put your username in `ADMIN_USERS` (comma separated; `ARABIC_ADMINS` works too) and that account becomes an admin when the server starts or when it's registered. Admins get **Admin Panel** in the sidebar: the site at a glance, users (make admin, make user; there's always at least one admin), the cloud catalog of Arabic packs (drop a signed pack's .zip to publish it; unpublish or delete versions; download counts), what players ask for, and the Windows installer the website hands out. The server checks the role on every admin request.

Uploaded packs go in `packs/` and the installer in `downloads/` beside the database (or `DATA_DIR`). The website's **Download GameShelf for Windows** button serves the uploaded installer, or redirects to `DOWNLOAD_URL` (a GitHub release, say) when there's none. Packs are only accepted when signed with GameShelf's pack key: its public half is `localizationPackKey` in `desktop/config.json` (or `PACK_PUBLIC_KEY`, the PEM or a file holding it).

## Windows app

GameShelf also comes as a desktop app for Windows. Players sign in with the same account as on the website (`server` in `desktop/config.json`), so their lists and profile are the same everywhere, and they never need keys of their own: the app shows its own copy of the pages and passes `/api` requests through to the server (see `desktop/cloud.js`). The sign-in is kept, so they stay signed in.

- **Try it from the code:** `npm install`, then `npm run app`. `GAMESHELF_SERVER=http://127.0.0.1:3000` points it at a server you run yourself; `GAMESHELF_SERVER=local` runs the whole website inside the app instead, with its own accounts and the `.env` keys, as before.
- **Make the installer:** on a Windows PC with Python 3, run `npm run dist:win`. It first runs `scripts/prepare-dist.js`: GameShelf's pack signing key pair in `../gameshelf-keys/` (made the first time; keep `pack-signing.key` private and backed up), its public half in `desktop/config.json` (commit that, and update the server, so both check packs with it), and Python with the Arabic pack builder for the installer. You get `dist/GameShelf-Setup.exe`, an installer that asks where to install, adds Start menu and desktop shortcuts, and has everything inside: the app, the pack builder with its Python and fonts, REMSG_Converter and the overlay's OCR helper. Upload it in the Admin Panel (Windows app) for the website's download button.
- **Finding games:** the app looks for games installed through Steam (its folder from the registry, every library in `libraryfolders.vdf`, and `SteamLibrary` folders on every drive), the Epic Games Launcher (its manifests, with each game's program) and GOG (Galaxy's registry entries, and each game's `goggame-*.info` file), when it starts and when a player signs in or presses **Rescan PC games** in Library. Library starts with **On this PC**: those games, each with its Arabic at a glance (Arabic on, Arabic ready, Arabic on request). Players can have them put on My games, now and as they install more; Steam games they've played start as Played (playing in the last two weeks: Playing), the rest as Want to play.

Without a server (`GAMESHELF_SERVER=local`), the installed app opens on a welcome page where you paste your IGDB keys (and optionally a Steam key), and accounts and lists are saved in `%APPDATA%\GameShelf` on that PC.

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

- **Native patch:** the Arabic goes into the game itself and shows in the game's own subtitles, dialogue boxes and menus, in an Arabic font (Unreal, Unity, Capcom RE Engine, Ren'Py and Godot games without anti-cheat). It goes in when you press Play, and comes out when you switch it off.
- **Accessibility overlay:** GameShelf reads the game's English subtitles off the screen and shows the Arabic over them, without touching the game. This is what games with anti-cheat, signed files or their own engines get.
- **Unavailable:** there's no Arabic pack for the game (hover for the reason).

**Getting Arabic without leaving the app.** Players need to be signed in. When a game has no pack on the PC yet, the app looks in GameShelf's **cloud catalog** of signed packs: if there's one for the game, the switch shows as available (Native patch or Accessibility overlay), and turning it on (or pressing Play with it on) downloads the pack ("Downloading Arabic pack… 45%"), checks it against the catalog's SHA-256 and GameShelf's signature, and puts it in. A newer version in the catalog comes down the next time Arabic is turned on or the game is started. When the catalog has no pack, the switch becomes one of these:

- **Arabic subtitles** (an approved game): the game's Arabic was approved by an admin. Turning the switch on downloads the signed Arabic, checks GameShelf's signature, and builds the patch on the player's PC from their own copy of the game. Nothing is translated again.
- **Request Arabic subtitles** (a game nobody has approved Arabic for yet): see below.

**Crowd-sourced Arabic: request, approve, everyone plays.** Admins don't need to own the games players ask for:

1. A player presses **Request Arabic subtitles**. GameShelf asks first: *"Allow GameShelf to scan this game's text files on your PC to generate the Arabic subtitles?"*, with **Approve & Generate**.
2. With their OK, the app reads the game's English from their own copy (Ren'Py scripts; Godot `.pck` files and packs built into the `.exe`; Unity asset files, with UnityPy; unencrypted Unreal `.pak` files, with repak; RE Engine paks, with the usual font files found by name in the paks' file tables or from a file list an admin uploaded) and finds the font files the Arabic font goes in place of.
3. GameShelf's server translates the lines it doesn't have yet with its own AI provider (the player needs no key), the patch is built and switched on, so they play in Arabic right away, and the English lines, the engine and the font names go to the server as a submission. The button shows the three steps: *Reading game text… → Translating to Arabic… → Building pack & submitting for review…*
4. In **Admin Panel → Pending approvals**, an admin reads each English line beside its Arabic, fixes lines (kept for everyone as reviewed translations), and presses **Approve, Sign & Publish** in the desktop app: it signs the game's Arabic with `pack-signing.key` (the game isn't needed), and the server checks that signature against GameShelf's key before publishing it.
5. Every player with the game then sees the Arabic switch ready; the player who asked gets the approved version the next time they play.

What players get is the Arabic only (each line by a SHA-256 of its English), signed; each player's app builds the patch from their own copy of the game. The English is kept on the server for admins to review, and never sent to other players; the games' own files never leave anyone's PC. When a player's PC can't read a game (an engine GameShelf can't patch, encrypted files, a Unity or Unreal game without the tools for it), the app tells them and sends the request to the admins with the reason (Admin Panel → Requests), where admins can also upload an RE Engine game's file list.

The app signs the packs it builds with a key made on that PC, which only that copy of the app trusts. It runs the same pack builder as below, with a Python that comes inside the installer (`scripts/bundle-arabic-builder.py` puts it, the builder, REMSG_Converter, repak, UnityPy, BepInEx and XUnity.AutoTranslator in `build-tools/arabic-builder/`; `npm run dist:win` runs it; the tools it can't fetch are left out, and their engines become request-only). From source on Windows, run that script once so `npm run app` can use it, or set `GAMESHELF_PYTHON` (and `GAMESHELF_MSG_TOOL`, `GAMESHELF_REPAK`, `GAMESHELF_UNITY_TOOLS`).

The pieces, in `localization/` and `desktop/localization/`:

**1. The Arabic compiler** (Python, run when a pack is made, not on players' PCs). It turns Arabic translations into text an engine without Arabic support shows correctly (Unity's text, Godot 3 and most custom engines; Unreal Engine, Ren'Py and Godot 4 shape Arabic themselves, so their packs get plain Arabic):
- letters already joined, using only Arabic Presentation Forms-B (U+FE70–U+FEFF), the glyphs game fonts are built from;
- lines over 55 characters wrapped first, in reading order, then each line put in screen order on its own, so two-line subtitles read top to bottom;
- the game's markup kept working: `<color=#fff>…</color>`, Unreal's `</>`, `{0}`, `%s`, `%1$s`, `%PLAYER%`, `[E]`, `[Press E]`, `<sprite=…>`, `<br>` and `\n`.

```bash
pip install -r localization/requirements.txt
```
```bash
cd localization && python -m arabic_compiler translations.csv --out build/my-game
```

The input is a CSV with `source` and `arabic` columns (or JSON). It writes the XUnity.AutoTranslator dictionary, a CSV and JSON of the compiled lines (for other engines' tools), `charset.txt` (every glyph the game's Arabic font needs) and `fingerprints.json` for the overlay (below). Tests: `cd localization && python -m unittest discover -s tests`. To go from a game to a signed pack in one command, see [the pack generator](#making-a-pack-in-one-command).

**2. Checks before launch** (`desktop/localization/`). Before anything is changed, GameShelf:
- looks for anti-cheat software in the game's folder (Easy Anti-Cheat, BattlEye, Riot Vanguard, Ricochet, EA Javelin, PunkBuster, GameGuard, XIGNCODE3, Anti-Cheat Expert and others). If any is found, or the check can't finish, the game's files are never changed; only the overlay is offered;
- works out the engine: Unreal Engine 4/5 (`Engine/` plus `Content/Paks/*.pak` or `.utoc`), Unity (`UnityPlayer.dll`, `<Game>_Data/`, Mono or IL2CPP, and its version), Capcom RE Engine (`re_chunk_000.pak` and its numbered patch files), Ren'Py (`renpy/` next to `game/` with `.rpa`, `.rpyc` or `.rpy` scripts, and its version), Godot 3 or 4 (the engine's program with a `.pck` of the same name, or with the `.pck` inside the program; the version comes from the `.pck` header), or a custom engine (overlay only). Unreal games with signed paks, Unity games that already have BepInEx mods, and Godot games that already have an `override.cfg` also get the overlay only. So do RE Engine games played online with others (Street Fighter 6, Monster Hunter Rise and Wilds, Exoprimal), whatever anti-cheat they ship.

**3. Adding and removing the Arabic files.**
- **Unreal:** a patch pak named like `pakchunk99-ArabicLocalization_P.pak` goes into `Content/Paks`, where the game loads it after its own files.
- **Unity:** BepInEx and XUnity.AutoTranslator, with the compiled dictionary and an Arabic TextMeshPro fallback font. GameShelf writes the AutoTranslator settings itself: no translation service at all, only the dictionary, so nothing is sent anywhere and lookups are instant. The settings also name the fonts: `OverrideFont=` (a Windows font with Arabic for Unity's older UI text, Arial unless the pack says otherwise) and `FallbackFontTextMeshPro=` (the pack's TextMeshPro font bundle).
- **Ren'Py:** the pack's `strings.json` (English line → Arabic) and Arabic font go into `game/tl/arabic/gameshelf/`, with a short script GameShelf writes itself (`desktop/localization/renpy.js`). Ren'Py compiles it when the game starts. It swaps each dialogue line and menu choice for its Arabic as Ren'Py shows it, before `[names]` are filled in, in the pack's font, and turns on Ren'Py's own right-to-left text, which shapes the Arabic. Arabic dialogue lines up on the right of the dialogue box. Lines without Arabic stay in English. Nothing goes into the player's saves or settings.
- **Capcom RE Engine:** these games load numbered patch files after `re_chunk_000.pak` (`re_chunk_000.pak.patch_001.pak`, `patch_002.pak`...), each one's files winning over the ones before; game updates and mod managers use them too. The pack's single `.pak` goes in as the next number: after `patch_003`, it's `re_chunk_000.pak.patch_004.pak`. The game reads the numbers one after another, so the chain is never broken:
  - if the game's patch files already skip a number, nothing is added (a new one wouldn't load) and the overlay is offered;
  - Arabic's patch file comes out only while it's the last one. If a mod manager has added another after it, switching Arabic off says so and changes nothing (taking it out would stop the game loading that one) until that one is gone;
  - a patch file that a game update has replaced isn't GameShelf's any more, and is left alone.
- **Godot 3 and 4:** Godot only reads its own `.pck`, so another `.pck` beside the game would be ignored. What it does read at startup is `override.cfg` beside its program. GameShelf writes one that loads a single script of its own (`desktop/localization/godot.js`) from `gameshelf_arabic/`, next to the pack's `strings.json` and fonts. The script adds the lines as an Arabic translation (by the game's own translation keys, or by the English for games without keys), switches the game to it, and gives the game's fonts the Arabic font as a fallback, so labels, buttons and subtitles show Arabic in the game's own UI. Godot 4 shapes the Arabic itself; Godot 3 packs carry the compiler's shaped text. The game's layout isn't mirrored.

Packs carry data only: RE Engine packs hold one `.pak` (checked to be one), and Ren'Py and Godot packs may add nothing but `strings.json`, `.ttf`/`.otf` fonts and license `.txt` files in their folder, and the scripts that read them are GameShelf's own.

**Fonts.** Every pack that needs a font gets [IBM Plex Sans Arabic](https://github.com/IBM/plex) (`localization/assets/fonts/`, SIL Open Font License, with its license text packed alongside), unless the pack's author picks another with `--font`. It has the Arabic letters, every Arabic Presentation Forms-B glyph the compiler uses, and full Latin, so English text in the same font still reads well.

Files are only ever added, never replaced: if any name is taken, nothing is added. A record is saved before the first file is written, so a crash halfway is undone on the next start. Turning Arabic off removes only files that are still exactly what was added, and folders GameShelf created; anything the player changed or added is left and listed. Nothing is changed while the game is running.

**4. The overlay** (Windows 10 and 11). When the game starts, GameShelf finds its window and keeps a see-through, click-through band over its subtitle area (the bottom 22% unless the pack says otherwise). It never takes focus or clicks, and closes when the game does. It has two looks, picked under App settings, Arabic subtitle packs, and applied at once, even to a game that's running:
- **Floating text (no box)**, the default: white Arabic with a heavy dark outline (drawn under the letters, so it never shows inside them or where letters join) and a soft shadow, with nothing around it, so it reads over bright scenes and the game's HUD stays in view. With no box to hide the game's English, the Arabic goes just above the English subtitles rather than on top of them.
- **Dark background box:** the Arabic on a dark box, which covers the English subtitles when it can (below).
- Windows captures the game's window. A few times a second the subtitle area's brightness is checked against the last frame, which costs well under a millisecond. Only when the text has changed and then held still for one tick (so subtitles that type out or fade in aren't read halfway) is it read with Windows' own OCR. When the text disappears, the Arabic is hidden at once, without OCR.
- What OCR read is looked up in the pack's `fingerprints.json`. That file holds fingerprints of the English lines, not the lines themselves: each line's length, a 64-bit SimHash and its hashed character trigrams. Lookups ignore case, punctuation, spaces and the letters OCR mixes up (I/l/1, O/0, rn/m), allow for names the game fills in (`{0}`), and show the Arabic only when the match scores at least 0.72. A 50,000-line table answers in about a millisecond.
- Names and numbers the game fills in are copied from the screen into the Arabic: "Hello, {0}!" read as "Hello, Arthur!" shows «مرحبًا يا Arthur!». The table keeps, for each slot, only hashes of the two words on either side, and finds them again in what OCR read; when it can't, the Arabic shows "…" there.
- The Arabic is drawn by the app itself, properly joined and right to left, in Thmanyah Sans if it's installed or Alexandria. With the box, it covers the English when the overlay can't end up in the capture (the game's window is captured on its own, or Windows 10 2004 and later); otherwise it sits just above.
- In testing with a stand-in game, the Arabic appeared about 0.16 s after a subtitle changed, plus whatever Windows' OCR takes on the PC. It works with windowed and borderless games, not exclusive full screen. It needs Windows' English OCR, which English Windows has; elsewhere add English under Language settings.

The OCR runs in a Windows PowerShell helper (`desktop/localization/ocr-helper.ps1`), so nothing needs to be compiled. It's one long-running process, started when Play is pressed (while the game is still loading) and shared by every overlay until a minute after the last one closes. PowerShell, the WinRT types and the OCR engine load once, and a blank picture is read at start so Windows loads its OCR model before the first subtitle; after that each subtitle costs only decoding the picture and the OCR itself. Its timings show in the overlay's stats (`window.gameshelfDesktop.arabicInfo(key)` in the developer tools: `ocrMs`). To try the overlay elsewhere, `scripts/fake-ocr-helper.js` stands in for it: run the app with `GAMESHELF_OCR_HELPER=scripts/fake-ocr-helper.js` (and `GAMESHELF_PACK_KEY_FILE` pointing at a test `pack-signing.pub`).

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

### Making a pack in one command

`scripts/build-arabic-pack.py` goes from a game's English to a signed pack: it reads the text, translates what isn't translated yet, compiles it and signs the pack.

```bash
export OPENAI_API_KEY=...
```
```bash
python scripts/build-arabic-pack.py "C:/Games/My Game" --id my-game-ar --version 1.0.0 --steam-app-id 123456 --key ../gameshelf-keys/pack-signing.key --provider openai --model <model> --context "A fantasy RPG set in a desert kingdom"
```

- **What it reads:** a game folder (loose `.locres` files, a Unity game's `_Data` folder, a Ren'Py game, or a Godot project), or a single `.locres`, Unity `.assets`, Ren'Py `.rpy` or `.rpa`, Godot translation CSV (`keys,en,...`), gettext `.po`, CSV (`source`, optional `arabic` and `key` columns), JSON, or XUnity `.txt` file.
  - Unity asset files need `pip install UnityPy`, and the lines it picks out are a best guess, so check them.
  - Ren'Py dialogue and menu choices are read as Ren'Py reads them, from `.rpy` files and from the `.rpy` files inside `.rpa` archives. A game that ships only compiled `.rpyc` scripts has to be decompiled first, from your own copy (unrpyc).
  - Godot games keep their text in their `.pck`: recover the project from your own copy (GDRE Tools) and give that folder. Its translation tables are used if it has them; otherwise the text in scenes and `tr()` calls.
  - RE Engine games: the game's own folder. The message files are taken straight out of `re_chunk_000.pak` and its patch files (each patch's version wins, as in the game), so no extraction tool or file list is needed; files are known by their name hashes, and the Arabic patch puts its files back under the same ones. Turn Arabic off for the game first, so its Arabic patch isn't read as English. Games that compress with zstd need `pip install zstandard` (built into Python 3.14); paks with an encrypted file table, and encrypted files, are refused, as that needs the game's key. A folder you extracted yourself works too (`natives/stm/.../*.msg.<version>`, with or without [REMSG_Converter](https://github.com/dtlnor/REMSG_Converter) dumps), or a single dump with `--msg-path natives/...`.
  - Text inside a game's `.pak` files has to be extracted first, from your own copy, with UnrealPak or FModel. The script never looks for decryption keys.
- **Translating:** `--provider openai` (any OpenAI-compatible API; `--api-base` for others) or `--provider gemini`, with the key in `OPENAI_API_KEY` or `GEMINI_API_KEY`. Lines go out in parallel batches (`--batch`, `--workers`). Every tag and placeholder must come back unchanged or the line is asked for again; lines that still fail are listed, not packed. `--glossary terms.csv` keeps names and terms consistent.
- **Resuming:** every answer is saved to `translation-cache.sqlite` as it arrives, so a run that's stopped or fails continues where it left off, and rebuilding costs nothing.
- **Checking:** it always writes `translations.csv`. Machine translation is a draft: have someone who knows the game read it (`--review` stops there), fix lines, then run the script again, on the edited CSV or with `--translations translations.csv` beside the game's own files (for packs that need them: Unreal, RE Engine). Only blank lines get translated.
- **What it makes** (`--kind`, which defaults to what the source is):
  - `overlay`: `fingerprints.json`, for any game.
  - `unity`: give `--bepinex` and `--autotranslator` (their release zips: BepInEx 5 for Mono games, BepInEx 6 for IL2CPP). For TextMeshPro text, give `--font-bundle` (a TextMeshPro font asset bundle built with the game's Unity version), or `--unity-editor` (that Unity Editor) to have one built from the Arabic font. Unity's older UI text uses Arial, which has Arabic (`--ugui-font` for another Windows font, `--no-ugui-font` to keep the game's).
  - `unreal`: the game's `.locres` with plain Arabic in it (`--shape` if the game turned shaping off), packed into `pakchunk99-ArabicLocalization_P.pak` with [repak](https://github.com/trumank/repak) (`--pak-version` to match the game) or UnrealPak (`--packer-path`). The Arabic font goes into the same pak, under the names of the game's own font files (`.ufont`, `.ttf`, `.otf` under `Content/`), so the game draws its text with it. The names come from the game's pak listing (`--pak-list`, the output of `repak list` or `UnrealPak -List`), a folder you extracted from your own copy (`--extracted`), or `--font-targets`. Bold, Black and Heavy faces get the bold Arabic font. Fonts kept inside `.uasset` files, rather than as separate font files, can't be replaced this way.
  - `renpy`: `strings.json` and the Arabic font for `game/tl/arabic/gameshelf/`.
  - `godot`: `strings.json` and the Arabic fonts for `gameshelf_arabic/`. `--godot 3` for Godot 3 games (shaped text); Godot 4 is the default.
  - `reengine` (or `--engine reengine`): the game's message files with the Arabic in them, packed into an RE Engine `.pak` that GameShelf adds as the game's next patch file.
    - The Arabic goes into the English slot of each message (the language the game is set to); add `--msg-language Arabic` too for games that have an Arabic option.
    - It's shaped (joined letters, screen order) for older RE Engine games, which can't lay Arabic out; `--no-shape` for newer ones that do it themselves.
    - These games line text up on the left, so when the Arabic font goes in, each shorter line is padded with spaces (measured with the font's own letter widths, using `fonttools`) to end where the longest line of its text does, on the right. `--no-align-right` leaves it as the game lays it out.
    - GameShelf doesn't read or write `.msg` files itself (their text is stored scrambled): give `--msg-tool` with REMSG_Converter's `src/main.py` (or its `.exe`). It dumps message files that have no dump yet, and builds the new `.msg` from each original and its Arabic dump; without it, the script stops after writing the Arabic dumps.
    - Arabic letters: games without Arabic keep their fonts in RE Engine's `.oft` container, so the bundled Arabic font is made into that container (`FBFO` and the font, XORed with the format's length-based key, as the open-source REE.Fonts.Cryptor does) and packed under the names of the game's fonts. The names come from `--font-targets` or from `.oft` lines in a list of the game's file names given with `--pak-list` (such as REE.PAK.Tool's lists); only names the game's paks hold are used, read from the paks' file tables. Only our own font is ever encoded; the game's fonts aren't read. `--font-converter-cmd "REE.Fonts.Cryptor.exe {input} {output}"` uses an installed tool instead. Fonts with Bold, Black or Heavy (or `bd`) in their name get the bold face.
    - `--msg-prebuilt` packs message files that already hold Arabic as they are; `--natives <folder>` adds other files you made (an Arabic font for games whose fonts lack it, say) at their `natives/...` paths. The game's fonts are its own: older games may need one of those to show Arabic letters.
- **Output:** `build/arabic-packs/<id>/pack` is the signed pack to add in App settings.

### Shared translation memory

A GameShelf website can keep every Arabic line it has machine-translated, so each line of a game is paid for once and every later build (by anyone) gets it for free.

- **What's stored:** per game (`steam:<app id>` or `game:<GameShelf id>`), a SHA-256 of each English line and its Arabic. The English itself is never stored, and no game files are.
- **Who translates:** only the server, with its own API key. It checks that each line's hash really is that line (so nobody can plant Arabic under another line), and that every tag and placeholder came back unchanged, before keeping anything.
- **Limits:** each account (or desktop app) may have `TRANSLATE_DAILY_LINES` new lines translated a day (default 2000), and the whole server `TRANSLATE_MONTHLY_CHARS` characters a month (default 3,000,000). Lines already in the memory never count. Two people asking for the same game at once don't pay twice.
- **Turning it on:** set `OPENAI_API_KEY` on the server (and optionally `TRANSLATE_MODEL`, default `gpt-4.1-mini`, or `TRANSLATE_API_BASE` for another OpenAI-compatible API). Without a key, the endpoints say it isn't set up.
- **Using it from the pack builder:** make an access token on the website (Edit profile, Access tokens), set it as `GAMESHELF_TOKEN`, and add `--shared https://your-gameshelf-site`. The builder takes what the memory has, has the server translate the rest, and checks every answer again. With `--no-translate` it only takes what's already there; with `--provider` too, lines the server couldn't do (say, over a limit) go to your own API key.
- **The desktop app** uses the same memory without an account: each copy gets its own device token (`POST /api/arabic/devices`, a few per address a day) and the same daily limit as an account.
- **Which games are ready:** pack builds with `--shared` tell the server how many lines the game has; a game is ready once the memory holds 95% of them. `POST /api/arabic/status` `{ games }` says so, with how many players asked; `POST /api/arabic/requests` `{ game, name }` counts a request; `POST /api/arabic/report` is the builders' line count.
- **Admins** (see Admin Panel above): `GET /api/admin/requests` lists the most asked-for games. An admin's build also saves the font names an RE Engine game's patch replaces (from `--pak-list`), so players' apps can build it with no file list: build each RE Engine game once yourself with `--shared` and `--pak-list`.
- **API:** `POST /api/translations/lookup` `{ game, hashes }` and `POST /api/translations/translate` `{ game, lines: [{ hash, english }], context }`, for signed-in users (session or `Authorization: Bearer gst_...`) and desktop apps (`Bearer gsd_...`); tokens at `GET/POST/DELETE /api/me/tokens`.

Translations of a game's script are derived from it, so sharing them is best kept to games whose publishers allow fan translations.

### Pack Studio (Admin Panel, desktop app)

Admins build packs without a command prompt: pick the game's folder (or a file with its text), the engine (or let it detect it), how to translate (GameShelf's shared memory, your own OpenAI or Gemini key, or only your checked translations.csv), and GameShelf's `pack-signing.key`. The Studio runs the same pack builder as `scripts/build-arabic-pack.py`, shows its output as it goes, and signs the pack. Then **Publish to Cloud Catalog** sends it to the server, and every player gets it the next time they turn Arabic on; **Add to this PC** tries it locally first, and **Open translations.csv** is for checking lines and building again with them. API keys are saved encrypted by Windows (or kept until the app closes when it can't). The Studio warns when the chosen key isn't the one players' apps check with.

Packs hold game files where the engine needs them (an RE Engine patch carries the game's message files with the Arabic added, for example), so publishing them shares that game data; the in-app build ("Request Arabic subtitles") makes those patches on each player's PC instead, from their own copy.

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
desktop/localization/ Arabic in games: anti-cheat check, engine detection, signed packs and their files, the scripts GameShelf adds to Ren'Py and Godot games, the subtitle overlay (capture, change detection, OCR helper, fingerprint matching)
desktop/overlay/     the overlay's two windows: the Arabic subtitles, and the hidden capture
localization/        the Arabic compiler (Python) for engines that can't shape Arabic, the overlay's fingerprints, the pack generator (.locres files, Ren'Py and Godot text, translation) and the bundled Arabic font (assets/fonts)
public/css/          the stylesheet
public/fonts/        the Manrope and Alexandria fonts (SIL Open Font License)
public/js/i18n.js    English and Arabic: t() for phrases, tn() for counts; lang/ar.js has the Arabic
public/js/boot.js    sets the page's language and direction before it's drawn
public/js/main.js    navigation and page routing
public/js/palette.js the search pop-up
public/js/preview.js hover previews; discover.js the discovery queue; art-color.js the page tint
public/js/seasons.js when each season runs, and its look (season-fx.js draws its decoration)
public/js/views/     one file per page (home, browse, game, library, profile, edit profile, import, community, log in, about & legal, app settings)
scripts/             developer tools (search-debug, localization-pack, build-arabic-pack, fake-ocr-helper)
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
| POST | `/api/games/match` | `{ games: [{ steamAppId, name }] }` the GameShelf page of each game on a PC (or null) |
| POST | `/api/me/library/installed` | `{ games: [{ steamAppId, name, status }] }` adds the ones not on your list |
| GET | `/api/localization/packs` | The cloud catalog of Arabic packs: `id, version, engine, mode, steamAppId, gameSlug, sha256, size, downloadUrl` |
| GET | `/api/localization/packs/:id/download` | The pack's .zip (signed-in users) |
| GET | `/api/download/info` | Whether the Windows installer is available, and its size |
| GET | `/api/admin/stats`, `/api/admin/users?q=`, `/api/admin/packs`, `/api/admin/requests` | Admin Panel (admins only) |
| PATCH | `/api/admin/users/:username` | `{ role: 'user' \| 'admin' }` |
| POST | `/api/admin/packs` | A signed pack's .zip as the body; checked, then published |
| PATCH / DELETE | `/api/admin/packs/:id/:version` | `{ published }`, or delete that version |
| PUT | `/api/admin/installer` | The Windows installer (.exe) as the body |
| POST | `/api/arabic/submissions` | A player's app: `{ game, name, engine, fontTargets, lines: [English] }` |
| GET | `/api/admin/submissions`, `/api/admin/submissions/:id?q=&offset=&missing=1` | Waiting submissions, and one's lines with their Arabic |
| PATCH | `/api/admin/submissions/:id/lines` | `{ edits: [{ hash, arabic }] }` |
| GET / POST | `/api/admin/submissions/:id/set`, `/api/admin/submissions/:id/approve` | The exact Arabic set to sign; `{ set, signature }` publishes it |
| POST | `/api/admin/submissions/:id/reject` | `{ note }` |
| PUT | `/api/admin/games/:game/file-list` | An RE Engine game's file list (text): its font names are kept for the game |
| GET | `/api/localization/sets/:id/download` | An approved Arabic set and its signature (signed-in users) |

Logins use a cookie session. A native mobile app would most likely switch to token auth (an `Authorization` header), which is a small change in `src/auth.js`.
