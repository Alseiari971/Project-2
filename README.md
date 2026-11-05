# GameShelf

Look up any game in the world, see where to buy it, and keep a public list of the games you've played.

- **Every game:** search and browse every game on Steam, plus games elsewhere from [Wikidata](https://www.wikidata.org), with Arabic titles and each game's engine. No keys needed.
- **Arabic packs are always free:** every finished pack is free for everyone. An optional [GameShelf Supporter](#gameshelf-supporter-memberships) membership pays for the cloud AI that makes new ones.
- **Where to buy:** each game page has "Where to buy" links to the real stores (Steam, Epic, GOG, PlayStation Store, Xbox, Nintendo eShop, itch.io, App Store, Google Play).
- **Live prices:** the best current PC price, every store's price and the all-time low, from [CheapShark](https://www.cheapshark.com) (free, no key needed, US dollars).
- **Accounts with GameShelf Guard:** sign up with a username, email, password and nationality (shown as a flag on your profile). Guard asks for a 6-digit code from an authenticator app or by email whenever you sign in on a new browser or PC, with 8 one-time recovery codes. Security settings list everywhere you're signed in. See [Accounts, Guard, friends and support](#accounts-guard-friends-and-support).
- **Steam, verified:** link your Steam account with Steam's own sign-in, then import your games and hours played. Nobody can import or claim someone else's Steam account.
- **Friends & Activity:** add friends by friend code or @username, and see who's online and what they're playing, including a «يلعب بالعربية» badge when the game runs with GameShelf's Arabic.
- **Support tickets:** players open tickets (account, Steam linking, an Arabic patch, a game request); admins answer them in the Admin Panel.
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
- **Moods:** "What are you in the mood for?" chips (Scary, Chill, With friends, A great story, Competitive, Quick fun, Brain teasers, Open world) each fill a row instantly, from Steam's tags.
- **Discovery queue:** ten well-liked games, full screen, one at a time with their preview loop. Decide with a click, a key (W to want, → to skip) or a swipe on touch screens. Skipped games stay out of later queues on that device.
  Ramadan, Eid and Lunar New Year follow the Islamic (Umm al-Qura) and Chinese calendars built into the browser, so their dates are always right. Every season also has a release countdown for upcoming games. The "Seasonal look" menu at the bottom of the home page can turn seasons off or preview any of them. The spotlight pauses on hover and has a pause button; with "reduce motion" turned on it holds still and plays no video. The sample catalog shows the spotlight only.
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

Game data comes from Steam and Wikidata, with nothing to set up (see [Game data](#game-data-steam-and-wikidata-no-keys)). `GAME_DATA=local` uses a built-in catalog of 35 popular games instead, for working offline.

## Hosting the website on a VPS

`deploy/setup-vps.sh` sets up the website on a fresh Ubuntu or Debian server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/Alseiari971/Project-2/claude/clever-brahmagupta-stqn0m/deploy/setup-vps.sh -o setup-vps.sh && bash setup-vps.sh
```

It installs Node.js 22 and [Caddy](https://caddyserver.com) (which gets the HTTPS certificate), runs GameShelf as a `gameshelf` service under its own user, keeps the database in `/var/lib/gameshelf` with a daily backup in `/var/backups/gameshelf` (two weeks kept; copy them off the server now and then too), and lets only SSH, HTTP and HTTPS through the firewall. Without a domain the site gets `<ip-with-dashes>.sslip.io`, a free name that points at the server; once your own domain's A record points at the server, run `bash setup-vps.sh your-domain.com`. Running the script again also updates GameShelf.

Keys go in `/etc/gameshelf.env` (readable only by root; every setting is listed in `/etc/gameshelf.env.example`, from `deploy/gameshelf.env.example`), then `systemctl restart gameshelf`. The log: `journalctl -u gameshelf -n 50`.

**Admins and the Admin Panel.** Accounts are `user`s unless they're admins. Put your username in `ADMIN_USERS` (comma separated; `ARABIC_ADMINS` works too) and that account becomes an admin when the server starts or when it's registered. Admins get **Admin Panel** in the sidebar: the site at a glance, users (make admin, make user; there's always at least one admin), the cloud catalog of Arabic packs (drop a signed pack's .zip to publish it; unpublish or delete versions; download counts), what players ask for, and the Windows installer the website hands out. The server checks the role on every admin request.

Uploaded packs go in `packs/` and the installer in `downloads/` beside the database (or `DATA_DIR`). The website's **Download GameShelf for Windows** button serves the uploaded installer, or redirects to `DOWNLOAD_URL` (a GitHub release, say) when there's none. Packs are only accepted when signed with GameShelf's pack key: its public half is `localizationPackKey` in `desktop/config.json` (or `PACK_PUBLIC_KEY`, the PEM or a file holding it).

## Windows app

GameShelf also comes as a desktop app for Windows. Players sign in with the same account as on the website (`server` in `desktop/config.json`), so their lists and profile are the same everywhere, and they never need keys of their own: the app shows its own copy of the pages and passes `/api` requests through to the server (see `desktop/cloud.js`). The sign-in is kept, so they stay signed in.

- **Try it from the code:** `npm install`, then `npm run app`. `GAMESHELF_SERVER=http://127.0.0.1:3000` points it at a server you run yourself; `GAMESHELF_SERVER=local` runs the whole website inside the app instead, with its own accounts and the `.env` keys, as before.
- **Make the installer:** on a Windows PC with Python 3, run `npm run dist:win`. It first runs `scripts/prepare-dist.js`: GameShelf's pack signing key pair in `../gameshelf-keys/` (made the first time; keep `pack-signing.key` private and backed up), its public half in `desktop/config.json` (commit that, and update the server, so both check packs with it), and Python with the Arabic pack builder for the installer. You get `dist/GameShelf-Setup.exe`, an installer that asks where to install, adds Start menu and desktop shortcuts, and has everything inside: the app, the pack builder with its Python and fonts, REMSG_Converter and the overlay's OCR helper. Upload it in the Admin Panel (Windows app) for the website's download button.
- **Finding games:** the app looks for games installed through Steam (its folder from the registry, every library in `libraryfolders.vdf`, and `SteamLibrary` folders on every drive), the Epic Games Launcher (its manifests, with each game's program) and GOG (Galaxy's registry entries, and each game's `goggame-*.info` file), when it starts and when a player signs in or presses **Rescan PC games** in Library. Library starts with **On this PC**: those games, each with its Arabic at a glance (Arabic on, Arabic ready, Arabic on request). Players can have them put on My games, now and as they install more; Steam games they've played start as Played (playing in the last two weeks: Playing), the rest as Want to play.

Without a server (`GAMESHELF_SERVER=local`), the installed app gets its game data from Steam and Wikidata itself (a Steam key is optional, for importing a Steam library), and accounts and lists are saved in `%APPDATA%\GameShelf` on that PC.

Good to know:

- The installer isn't code-signed, so the first time Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**. Signing needs a paid code-signing certificate.
- If `npm run dist` stops with "Cannot create symbolic link", turn on **Developer Mode** in Windows Settings (System, For developers) or run the terminal as administrator, then try again.
- **Play installed games:** the app finds games installed through Steam, the Epic Games Launcher and GOG Galaxy. They show up in an "Installed on this PC" row on Home, and their game pages get a **Play** button that starts the game through its launcher. While a game runs, Play turns into a white **Stop** button (this also notices games started from Steam or a shortcut). Stop asks the game to close and forces it after 5 seconds. The arrow on the right of the Play button opens the game's options: which graphics card Windows uses for it (the same setting as Windows' Graphics settings; for Steam and Epic games this appears after you've played once, so GameShelf knows which program is the game), Open game folder, and for Steam games launch options and properties, Verify game files and Uninstall. GOG games can be uninstalled too, and games you added can be removed. Other launchers (Xbox app, EA app, Ubisoft Connect, Battle.net) aren't detected yet, but any game can be added by hand: click **Add a game** at the end of the Home row and pick its `.exe` file. Added games are listed, and can be removed, in App settings.
- Store links and trailers open in your normal web browser. The window's top bar works as the title bar: drag it to move the window, double-click it to maximize. Its round minimize, maximize and close buttons sit at the right, or at the left in Arabic. Mouse back/forward buttons, Alt+Left/Right, F5, F11 and Ctrl +/- zoom work as you'd expect.
- **Discord activity:** while you play a game started from GameShelf, your Discord profile shows it: the game's name, its cover, which launcher, how long you've played, and a "View game" button. Players don't set anything up; it works whenever the Discord app is open on the same PC with **Share your detected activities with others** turned on (Discord settings, Activity Privacy). It can be turned off in App settings. It talks only to the Discord app on the PC; no Discord login is involved.

  **One-time setup for whoever builds GameShelf:** Discord needs to know the activity comes from GameShelf, so GameShelf has its own Discord application, the same for every player (like any app with a Discord activity). Create it once at https://discord.com/developers/applications (**New Application**, named `GameShelf`, with `desktop/icon.png` as its App Icon), then put its **Application ID** in `desktop/config.json` as `discordApplicationId`. The ID is public, not a secret, so it's fine to commit. Until it's set, the Discord option is greyed out.
- Accounts made in the app live on that computer only. To let people see each other's profiles, the website has to be hosted online; the app can then be pointed at it.

### Game data: Steam and Wikidata (no keys)

GameShelf gets its games from two free sources and needs no keys for either:

- **Steam's store items** (`api.steampowered.com/IStoreBrowseService/GetItems`, no key): for up to 50 games in one request, whether each is a game or DLC (search leaves DLC, season passes and currency packs out), its exact artwork (Steam keeps newer games' posters, logos and wide art at hashed addresses) and its trailers (HLS streams: Safari and current Chrome play them natively, other browsers through the bundled hls.js, Apache-2.0, `public/js/vendor/`).
- **The Steam store** (`store.steampowered.com`): search (Steam's games-only search results, then `/api/storesearch`; only games whose name has the words searched for, in order, are shown, and "gta", "cod", "rdr", "ff"... are expanded), each game's `appdetails` (name, header and library art, description, developers, publishers, genres, release date, PC requirements, supported languages, screenshots, Metacritic) and its store link.
- **[Wikidata](https://www.wikidata.org)** (`query.wikidata.org/sparql`, CC0 public domain), matched by Steam ID (P1733), Epic Games Store ID (P6278), GOG ID (P2725) or the exact English or Arabic name of a video game (P31/P279* Q7889). Games are found with Wikidata's search API (fast), then one small query reads them. It adds the **Arabic title and description**, the **game engine** (P408, shown as a badge on the game page: Unreal Engine 4/5, Unity, RE Engine, Creation Engine, Ren'Py, Godot, MT Framework, RAGE…), the Epic and GOG store links, the official website (P856), the platforms (P400, with a link to the console's store), and games that aren't on Steam at all.
- **Wikipedia** (`en`/`ar` `.wikipedia.org/api/rest_v1/page/summary`): the summary of the game's article, for games Steam doesn't describe (and in Arabic when the page is in Arabic), shown with "From Wikipedia, under CC BY-SA 4.0" and a link. Wikipedia's cover images are left out: most are non-free and may only be used on Wikipedia, so games that aren't on Steam show their name on a colored card.

Everything fetched is kept in the database (`games` and `metadata_cache`) for `METADATA_TTL_DAYS` days (7 by default), so most pages never wait on Steam. Requests go out one at a time per site with a pause between them, and when Steam or Wikidata answers 429/403/5xx GameShelf backs off (30 seconds, doubling up to 30 minutes) and serves what it already has. If Wikidata is down, Steam data still works on its own; Wikidata's queries carry the `User-Agent: GameShelf/1.0 (https://gameshelf.ae)` its policy asks for.

`GAME_DATA=local` uses the built-in 35-game sample instead (handy offline); `GAME_DATA=rawg` with `RAWG_API_KEY` uses RAWG. After upgrading an existing server, `scripts/backfill-games.js` fills in Steam and Wikidata details for every game already on players' lists, packs and requests; game IDs, lists, packs and requests are kept as they are. On the VPS, run it as the service's user with the service's settings:

```bash
systemd-run --wait --pipe -p User=gameshelf -p WorkingDirectory=/opt/gameshelf -p EnvironmentFile=/etc/gameshelf.env /usr/bin/node scripts/backfill-games.js
```


### Other optional keys

| Setting | What it unlocks | Where to get it (free) |
| --- | --- | --- |
| `STEAM_API_KEY` | "Import from Steam", and Steam names on linked accounts | https://steamcommunity.com/dev/apikey (any domain works, e.g. `localhost`) |
| `PUBLIC_URL` | The site's own address (`https://gameshelf.example`), used for Steam's sign-in to come back to. Set it on a VPS behind a proxy | Your domain |
| `SMTP_URL` | Email for GameShelf Guard codes and email checks: `smtps://user:password@smtp.example.com:465`, or `smtp://…:587` (STARTTLS is required) | Your mail provider |
| `MAIL_FROM` | The sender address of those emails, e.g. `GameShelf <no-reply@gameshelf.example>` | |
| `MAIL_DEV_LOG` | `1` prints emails to the server log instead of sending them. For development only | |
| `METADATA_TTL_DAYS` | How long Steam and Wikidata details are kept before they're fetched again (7) | |
| `RAWG_API_KEY` | Older alternative game database, with `GAME_DATA=rawg` | https://rawg.io/apidocs |
| `STRIPE_WEBHOOK_SECRET`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `CHECKOUT_URL_MONTHLY`, `CHECKOUT_URL_YEARLY`, `AFFILIATE_*` | Supporter payments and affiliate links, see [GameShelf Supporter](#gameshelf-supporter-memberships) | Your payment provider |

Steam import reads only the Steam account linked to the GameShelf account (Security → Steam account), and only when its **Game details** are set to Public in Steam's privacy settings. Steam games are matched exactly by their Steam ID.

## Accounts, Guard, friends and support

**Signing up** takes a username (3 to 24 lowercase letters, numbers or underscores, checked as you type), an email address, a password (with a strength meter; common passwords and ones containing the username are refused) and a nationality, picked from a searchable list with Arab countries first and stored as its two-letter code. Profiles show it as a flag (drawn with the Twemoji Country Flags font, since Windows has no flag emoji). Accounts made before this have no email address until their owner adds one in Security settings.

**GameShelf Guard** (Settings → Security) is two-step sign-in. Pick one:

- **Authenticator app** (TOTP, RFC 6238): scan the QR code or type the key into Google Authenticator, Microsoft Authenticator, 1Password or any authenticator app. Works without email.
- **Email codes:** a 6-digit code emailed at each new sign-in. Needs a confirmed email address and `SMTP_URL`.

Turning Guard on gives 8 recovery codes, each good once. With Guard on, a browser or PC the account hasn't remembered gets a 6-digit prompt after the password, before any session starts (5 tries, 10 minutes). "Remember this device" skips it there for 180 days. Codes, recovery codes, sign-in attempts and remembered devices are stored only as hashes, and an authenticator code can't be used twice. Security settings also list every active session (browser or desktop app, when, from where), with sign-out for each; changing the password signs out everywhere else.

**Forgot password** (`#/forgot`, linked from sign-in): a 6-digit code goes to the account's email address, and the code plus a new password reset it. The answer is the same whether or not the account exists, so the form can't be used to find out who has one. A reset signs out everywhere and forgets remembered devices; Guard stays on, so with an authenticator app the next sign-in still needs its code. At most 5 reset emails per account an hour.

**Locking out guessing:** besides the limits per address, each account allows 10 wrong passwords and 10 wrong Guard codes in 15 minutes, whatever addresses they come from; after that it waits 15 minutes (even for the right password) or a password reset. With Guard on, deleting the account also needs a Guard or recovery code.

**Emails:** code emails, security alerts and Support replies share one design (GameShelf's dark look, English then Arabic, with a plain-text copy), built to survive Gmail's dark mode. Security alerts go out when the password is changed or reset, when Guard is turned off, and when the email address changes (to the old address). Players with a confirmed address get admins' Support replies by email. `node scripts/send-test-email.js you@example.com` sends a sample with the server's settings and prints any error; failed emails are logged (`journalctl -u gameshelf`).

Without `SMTP_URL`, sign-up still works, email addresses can't be confirmed, Email Guard and password reset by email aren't offered, and no alerts go out; the authenticator app still works.

**Linking Steam** uses Steam's own sign-in (OpenID 2.0). "Sign in through Steam" sends the player to `steamcommunity.com/openid/login`; Steam sends them back to `/api/auth/steam/return`, and GameShelf checks the answer (its return address, Steam's endpoint, the signed fields, its age) and then asks Valve's server directly whether it's genuine before linking that SteamID64. Each attempt works once. One Steam account can be linked to only one GameShelf account, and the other way round. There's no way to type in a Steam ID or profile link.

In the desktop app, Steam's sign-in opens in the normal web browser, which isn't signed in to GameShelf, so the browser shows "Link this Steam account to @you?" first; the app notices the link by itself. The app also reads which Steam account is signed in on the PC (Steam's `config/loginusers.vdf`) and shows it next to the button, but only as a hint: a file on a PC proves nothing, so linking always goes through Steam's sign-in.

**Friends & Activity** is the people button in the top bar. Everyone has a friend code (`GS-XXXX-XXXX`); find people by their code or exact `@username`, send, accept or decline requests, remove friends and block people (blocked players can't add or find you). Presence: the desktop app tells the server every 45 seconds (and at once when a game starts or stops) whether you're online or which game is running and whether its Arabic is on; the website says online while a tab is open. Presence expires 2 minutes after the last heartbeat, and only friends see it.

**Support** (`#/support`): players open tickets by category (Account & 2FA, Steam linking, Broken Arabic patch, Game request, Other), optionally about a game from the catalog, and follow the conversation, which updates by itself. Admins get **Support** in the Admin Panel: the queue filtered by status and category, each sender's nationality, Steam link, Guard and email status and their other tickets, replies, and resolved or closed.

### Checking search results

When using RAWG, if a search shows odd games, `npm run search-debug -- <search words>` prints everything RAWG returned (popularity, stores) and which results GameShelf kept. It uses the RAWG key in your `.env`.

## GameShelf Supporter (memberships)

**Every finished Arabic pack is free for every player to download, install and switch on or off.** No plan, quota, payment or code is ever checked on a pack download (`/api/localization/packs/:id/download`, `/api/localization/sets/:id/download`), and `test/plans.test.js` checks that. What a membership pays for is the cloud compute that makes new translations, and extras around GameShelf itself:

| | Free (مجاني) | GameShelf Supporter (داعم GameShelf) |
| --- | --- | --- |
| Arabic packs | All of them, unlimited | All of them, unlimited |
| Cloud AI translation | `TRANSLATE_DAILY_LINES` new lines a day (2,000), `FREE_DAILY_BUILDS` new games a day (1) | `SUPPORTER_DAILY_LINES` a day (30,000), `SUPPORTER_MONTHLY_STRINGS` a month (150,000), any number of games |
| AI queue | Standard | First in line (`createPriorityGate` in `src/translation-memory.js`) |
| Boost tokens | | `SUPPORTER_MONTHLY_BOOSTS` a month (5) |
| Subtitle Studio (desktop overlay) | | Cairo, Tajawal, Amiri or IBM Plex Sans Arabic; size 80–150%; text color; box opacity |
| Profile | | The gold and emerald «داعم» badge on the profile, account menu and friends lists |
| Support tickets | | Answered first |

Lines already in the shared translation memory never count against anyone. The usage is kept in `compute_ledger`, the plans in `user_subscriptions`.

**Boost tokens (رموز تعزيز).** Supporters spend them on a requested game on `#/arabic`; the most-boosted games go to the top of Admin Panel → Requests and show "مدعوم من المجتمع (X تعزيز)". The pack that comes out of it is free for everyone like any other.

**The Pricing page** is `#/pricing` (العضوية والدعم, in the sidebar and account menu): both plans, the player's plan and usage, and a box for prepaid or gift codes. Its buttons go to `CHECKOUT_URL_MONTHLY` and `CHECKOUT_URL_YEARLY` (any https payment link, e.g. Stripe Payment Links or LemonSqueezy); without them the page says memberships are sold as codes.

**Prepaid and gift codes** (Admin Panel → Supporters & codes): make 1 to 500 codes at a time, each `XXXX-XXXX-XXXX` (60 random bits) for a number of days, with a note. They're shown once, to copy or download as a .txt, and only their SHA-256 fingerprints are stored. Sell them through Ziina, Tabby or Stripe links, or give them away. Batches can be revoked (codes already used keep working), admins can give a player Supporter time by username, and the tab lists current supporters. Redeeming is limited per address and per account, and 8 wrong codes lock an account out of redeeming for an hour.

**Payment webhooks:** `POST /api/billing/webhook` takes signed events from:

- **Stripe** (`Stripe-Signature`, HMAC-SHA256 of `timestamp.body`, at most 5 minutes old) with `STRIPE_WEBHOOK_SECRET`: `checkout.session.completed` (pass the GameShelf user id as `client_reference_id` or `metadata.gameshelf_user_id`; `metadata.days` sets the length, 31 by default), `invoice.paid` (until the period's end) and `customer.subscription.deleted`.
- **LemonSqueezy** (`X-Signature`, HMAC-SHA256 hex) with `LEMONSQUEEZY_WEBHOOK_SECRET`: `order_created`, `subscription_created`/`updated`/`resumed`/`payment_success`, `subscription_cancelled` and `subscription_expired` (pass `custom_data.user_id`).

Each event is handled once (`billing_events`); unsigned, wrongly signed or replayed events are refused, and without its secret a provider's webhook answers 503. GameShelf never sees card details.

**Affiliate links** (`src/affiliate.js`): when set, buy links to these stores get the partner tag, are marked "Affiliate" on the game page and carry `rel="noopener noreferrer sponsored"`. Only `https` links to the exact store domains are changed; everything else is left alone.

| Setting | Store | Query parameter (default; check your partner dashboard) |
| --- | --- | --- |
| `AFFILIATE_GOG_ID` | gog.com | `pp` (`AFFILIATE_GOG_PARAM`) |
| `AFFILIATE_HUMBLE_ID` | humblebundle.com | `partner` (`AFFILIATE_HUMBLE_PARAM`) |
| `AFFILIATE_FANATICAL_ID` | fanatical.com | `ref` (`AFFILIATE_FANATICAL_PARAM`) |
| `AFFILIATE_GMG_ID` | greenmangaming.com | `tap_a` (`AFFILIATE_GMG_PARAM`) |
| `AFFILIATE_EPIC_CREATOR_CODE` | store.epicgames.com | `epic_creator_id` (`AFFILIATE_EPIC_PARAM`) |

Each program's terms and link format can change; check the parameter name in your partner dashboard and set the `*_PARAM` setting if it differs. Values may only use letters, digits, `.`, `_` and `-`.

**Subtitle Studio** is in the desktop app's App settings, under Arabic subtitle packs. The app asks GameShelf whether the account has the perk (`/api/me/plan`); without it the overlay uses its usual look, and saved choices come back when the perk does. The fonts are in `public/fonts/studio/` under the SIL Open Font License. The check is a nicety: it only changes how subtitles look on the player's own PC.

## Arabic

Every page, menu, message and error has an Arabic translation, with Arabic plurals (لعبة واحدة، لعبتان، 3 ألعاب، 11 لعبة). The first visit picks Arabic when the browser or Windows is set to Arabic; after that the visitor's choice is remembered on their device. Numbers use Western digits (2026, $29.99), like the game stores. The About this game text and system requirements come from Steam's Arabic store page when the publisher wrote one, and stay in English otherwise. Game names, store names and what users write stay as they are, and keep their own direction inside Arabic text.

**Fonts.** Arabic text uses [Alexandria](https://fonts.google.com/specimen/Alexandria) (SIL Open Font License), which comes with GameShelf. If [Thmanyah Sans](https://thmanyah.com) is installed on the computer, it's used instead. Thmanyah's license doesn't allow passing its font files on, so they aren't in this repository or the installer. To use Thmanyah on a website you host, put the files you downloaded from Thmanyah in `public/fonts/thmanyah/`, named `regular.otf`, `medium.otf`, `bold.otf` and `black.otf` (that folder is in `.gitignore`).

**Adding a phrase.** Text in the code is written in English and passed through `t()` (from `public/js/i18n.js`). Add its Arabic to `public/js/lang/ar.js`. `npm test` fails if any phrase, or any error message from the server, has no Arabic.

## Arabic subtitles in games

Many single-player games have no Arabic, and most game engines can't draw it: they show Arabic as separate letters in reverse order. In the Windows app, a game page with a **Play** button also has an **Arabic subtitles** switch beside it. Under its name the switch says how Arabic would come:

- **Native patch:** the Arabic goes into the game itself and shows in the game's own subtitles, dialogue boxes and menus, in an Arabic font (Unreal, Unity, Capcom RE Engine, Ren'Py, Godot and Bethesda Creation Engine games without anti-cheat; games made with their own engines whose text is in readable files; single-player games made with their own engines whose UI text goes through Windows' own text functions, through GameShelf's [runtime adapter](#native-runtime-adapter); and games whose text is packed in their own archives, once an admin has attached the game's engine recipe). It goes in when you press Play, and comes out when you switch it off.
- **Accessibility overlay:** GameShelf reads the game's English subtitles off the screen and shows the Arabic over them, without touching the game. This is what games with anti-cheat or signed files get.
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

What players get is the Arabic only (each line by a SHA-256 of its English), signed; each player's app builds the patch from their own copy of the game. The English is kept on the server for admins to review, and never sent to other players; the games' own files never leave anyone's PC. When a player's PC can't read a game (its text is packed and it has no engine recipe yet, encrypted files, a Unity or Unreal game without the tools for it), the app tells them and sends the request to the admins with the reason and the game folder's fingerprint (Admin Panel → Requests): its folder names, the file names at the top, and how many files of each kind and how big, so an admin who doesn't own the game can tell which engine it is and write its [engine recipe](#engine-recipes-packed-engines). Only names inside the game's folder go out, never anything from inside a file or any other path of the PC. Admins can also upload an RE Engine game's file list there.

The app signs the packs it builds with a key made on that PC, which only that copy of the app trusts. It runs the same pack builder as below, with a Python that comes inside the installer (`scripts/bundle-arabic-builder.py` puts it, the builder, REMSG_Converter, repak, retoc, UnityPy, BepInEx, XUnity.AutoTranslator, QuickBMS (for engine recipes) and GameShelf's runtime adapter in `build-tools/arabic-builder/`; `npm run dist:win` runs it; the tools it can't fetch are left out, and their engines become request-only). From source on Windows, run that script once so `npm run app` can use it, or set `GAMESHELF_PYTHON` (and `GAMESHELF_MSG_TOOL`, `GAMESHELF_REPAK`, `GAMESHELF_UNITY_TOOLS`).

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
- works out the engine: Unreal Engine 4/5 (`Engine/` plus `Content/Paks/*.pak` or `.utoc`), Unity (`UnityPlayer.dll`, `<Game>_Data/`, Mono or IL2CPP, and its version), Capcom RE Engine (`re_chunk_000.pak` and its numbered patch files), Ren'Py (`renpy/` next to `game/` with `.rpa`, `.rpyc` or `.rpy` scripts, and its version), Godot 3 or 4 (the engine's program with a `.pck` of the same name, or with the `.pck` inside the program; the version comes from the `.pck` header), Bethesda's Creation Engine (a `Data/` folder with `.esm` plugins and string tables, loose or in `.bsa`/`.ba2` archives: Skyrim Special Edition and Anniversary Edition, Skyrim VR, Fallout 4 and Fallout 4 VR, Starfield), or a custom engine. For a custom engine GameShelf looks for readable text files (the loose-file scanner's quick look: `localization/`, `lang/`, `text/`... folders, or files marked English) and checks which known packed engine it looks like (`localization/custom_engines.json`: God of War's `exec/wad/pc_le/`, REDengine's `archive/pc/content/*.archive`, `*.psarc` ports, Anvil `.forge`, Frostbite `.toc`, RAGE `.rpf`, Source `.vpk`, Decima). Games with readable text get the loose-file patch; packed ones from a known engine get their engine recipe; the rest get the runtime adapter when it can reach their text (a 64-bit program whose modules import Windows' text functions, and a `version.dll` or `dinput8.dll` it loads that the adapter can stand in for, read from the programs' import tables), or else an engine recipe. Unreal games with signed paks, Unity games that already have BepInEx mods, and Godot games that already have an `override.cfg` also get the overlay only. So do RE Engine games played online with others (Street Fighter 6, Monster Hunter Rise and Wilds, Exoprimal), whatever anti-cheat they ship.

**3. Adding and removing the Arabic files.**
- **Unreal:** a patch pak named like `pakchunk99-ArabicLocalization_P.pak` goes into `Content/Paks/~mods`, where the game loads it after its own files (a `~mods` folder the player already has, and the mods in it, stay as they are). UE5 games with IoStore containers get the `.utoc` and `.ucas` of the same name with it every time (with the game's cooked font replacements in them, or empty), made by `retoc to-zen` for the engine version in the game's program, since those games only mount a `.pak` that has them; the three go in and come out together (a pack can't hold a `.utoc` without its `.ucas` and `.pak`).
- **Unity:** BepInEx and XUnity.AutoTranslator, with the compiled dictionary and an Arabic TextMeshPro fallback font. GameShelf writes the AutoTranslator settings itself: no translation service at all, only the dictionary, so nothing is sent anywhere and lookups are instant. The settings also name the fonts: `OverrideFont=` (a Windows font with Arabic for Unity's older UI text, Arial unless the pack says otherwise) and `FallbackFontTextMeshPro=` (the pack's TextMeshPro font bundle).
- **Ren'Py:** the pack's `strings.json` (English line → Arabic) and Arabic font go into `game/tl/arabic/gameshelf/`, with a short script GameShelf writes itself (`desktop/localization/renpy.js`). Ren'Py compiles it when the game starts. It swaps each dialogue line and menu choice for its Arabic as Ren'Py shows it, before `[names]` are filled in, in the pack's font, and turns on Ren'Py's own right-to-left text, which shapes the Arabic. Arabic dialogue lines up on the right of the dialogue box. Beside it, GameShelf writes two of Ren'Py's own translation files from `strings.json`, every string escaped (so a pack still brings no code): `game/tl/arabic/gameshelf_strings.rpy`, a `translate arabic strings:` block (`old "English"` / `new "Arabic"`) for menu choices and interface text marked `_()`, and `game/tl/arabic/gameshelf_font.rpy`, the Arabic font for the arabic language (`translate arabic style default` and the `gui` fonts); the script selects the arabic language for the run. Ren'Py loads `tl/` files over the game's `.rpa` archives and `.rpyc` scripts, which are never repacked. Lines without Arabic stay in English. Nothing goes into the player's saves.
- **Capcom RE Engine:** these games load numbered patch files after `re_chunk_000.pak` (`re_chunk_000.pak.patch_001.pak`, `patch_002.pak`...), each one's files winning over the ones before; game updates and mod managers use them too. The pack's single `.pak` goes in as the next number: after `patch_003`, it's `re_chunk_000.pak.patch_004.pak`. The game reads the numbers one after another, so the chain is never broken:
  - if the game's patch files already skip a number, nothing is added (a new one wouldn't load) and the overlay is offered;
  - Arabic's patch file comes out only while it's the last one. If a mod manager has added another after it, switching Arabic off says so and changes nothing (taking it out would stop the game loading that one) until that one is gone;
  - a patch file that a game update has replaced isn't GameShelf's any more, and is left alone.
- **Godot 3 and 4:** Godot only reads its own `.pck`, so another `.pck` beside the game would be ignored. What it does read at startup is `override.cfg` beside its program. GameShelf writes one that loads a single script of its own (`desktop/localization/godot.js`) from `gameshelf_arabic/`, next to the pack's `strings.json` and fonts. The script adds the lines as an Arabic translation (by the game's own translation keys, or by the English for games without keys), switches the game to it, and gives the game's fonts the Arabic font as a fallback, so labels, buttons and subtitles show Arabic in the game's own UI. Godot 4 shapes the Arabic itself; Godot 3 packs carry the compiler's shaped text. The game's layout isn't mirrored.

- **Bethesda Creation Engine:** the game loads loose files over its archives, so the Arabic goes into copies of the game's English string tables (`<plugin>_english.strings`, `.dlstrings`, `.ilstrings`, or `_en` in Starfield) in `Data/Strings/`, written in UTF-8. The game's interface (Scaleform) can't join Arabic letters or lay them out right to left, so the Arabic goes in shaped and in screen order, wrapped before it's reversed. Its fonts have no Arabic either: `Data/Interface/gameshelf_arabic.swf` holds IBM Plex Sans Arabic (regular and bold, as SWF `DefineFont3` fonts made from the bundled font, only the characters the text uses), and `Data/Interface/fontconfig.txt`, the game's own with that font library added, points its text fonts at it; rune and symbol fonts (dragon script, Daedric, controller buttons) keep theirs. The English tables and `fontconfig.txt` are read from loose files first, then from the game's `.bsa` (versions 104 and 105, zlib and LZ4) and `.ba2` archives (Fallout 4's zlib, Starfield's zlib and LZ4). Skyrim (2011), Fallout 3, New Vegas and Oblivion don't take string tables this way, so they're for an engine recipe instead. Like other interface mods, Fallout 4 may also need `bInvalidateOlderFiles=1` and an empty `sResourceDataDirsFinal=` under `[Archive]` in `Fallout4Custom.ini` to load the loose font files (its string tables load either way).
- **Readable text files (custom engines):** the loose-file scanner (`localization/arabic_compiler/loose.py`) finds the game's English files: JSON, CSV and TSV, XML, gettext `.po` and `.mo`, and line-based text (`key=value` `.txt`, `.ini`, `.cfg`, `.lang`, `.loc`, YAML-style `key: value`, Valve-style `"key" "value"`, Apple-style `.strings`, or one line of text per line), in folders named for text or marked English, holding enough lines that read like text. Files marked for another language are left alone, and tables with a column per language (or JSON objects keyed by language) only have their English changed. Each file is written back in its own format, encoding and layout, with the Arabic shaped in place of the English (and no line breaks put into line-based files). The game's loose fonts in its `fonts/` folders get IBM Plex Sans Arabic in their place, under their own names; icon and symbol fonts are left alone.
  - Engines' own message tables are read and written natively the same way, each back in its own format: **FromSoftware** `.fmg` tables (Dark Souls, Sekiro, Dark Souls III, Elden Ring, Armored Core VI; 32- and 64-bit, either byte order), inside BND4 binders (`msg/engus/item.msgbnd.dcx`, with their path hash tables rebuilt) and DCX compression (`fromsoft.py`: DFLT with zlib, ZSTD with the `zstandard` package, KRAK with the game's own `oo2core` DLL on Windows; GameShelf ships no Oodle), from games unpacked with UXM or a mod loader, never from the encrypted `.bdt` archives; **Rockstar** `.gxt2` string tables (`rage.py`, Jenkins one-at-a-time key hashes) from a mod loader's folder, never from `.rpf` archives; and **Capcom MT Framework** `.gmd` tables (Resident Evil 5/6, 0/1 HD, Revelations, Dragon's Dogma, DMC4, Monster Hunter: World) inside the zlib `.arc` archives in `nativePC` (`mtframework.py`). These engines' fonts aren't made by GameShelf (MT Framework's are bitmap `.gfd`/`.tex`): an admin can stage replacement font files with a recipe. Elden Ring and Armored Core VI ship Easy Anti-Cheat, so their files are never changed.
- **Runtime adapter (custom engines no tool can repack):** the adapter goes into the folder of the game's program as the library it stands in for (`version.dll` or `dinput8.dll`), with `gameshelf_arabic/gameshelf_strings.bin`, the font, and the settings GameShelf writes (`gameshelf_runtime.ini`). Only the exact library this copy of GameShelf ships (checked by SHA-256) is ever put in. See [Native runtime adapter](#native-runtime-adapter).
- **Engine recipes (packed engines):** the files a game's [engine recipe](#engine-recipes-packed-engines) made (a copy of one of the game's archives with the Arabic put in, say) replace the game's own.

Packs carry data only: RE Engine packs hold one `.pak` (checked to be one), Ren'Py and Godot packs may add nothing but `strings.json`, `.ttf`/`.otf` fonts and license `.txt` files in their folder, Bethesda packs only string tables, `fontconfig.txt`, the font library and license texts, and loose-file packs only text, data and font files. No pack may put a program, library or script into a game (`.exe`, `.dll`, `.bat`, `.ps1`, `.js`, `.py`, `.so`...), and the scripts that read Ren'Py and Godot packs are GameShelf's own.

**Fonts.** Every pack that needs a font gets one of three Arabic font styles that come with GameShelf (`localization/assets/fonts/`, all under the SIL Open Font License, with their license text packed alongside), or the pack author's own with `--font`:

| `--font-style` | Font | Suits |
| --- | --- | --- |
| `plex` (the default) | [IBM Plex Sans Arabic](https://github.com/IBM/plex) | clear text anywhere |
| `cairo` | [Cairo](https://github.com/google/fonts/tree/main/ofl/cairo) | modern HUDs and menus |
| `naskh` | [Noto Naskh Arabic](https://github.com/google/fonts/tree/main/ofl/notonaskharabic) | story games, long dialogue |

Each has the Arabic letters, every Arabic Presentation Forms-B glyph the compiler uses (Cairo's were added from its own letter shapes by `scripts/fetch-arabic-fonts.py`, which makes the Regular and Bold files from the Google Fonts originals), and Latin, so English text in the same font still reads well. Which one a game gets:
- **The player:** a game whose patch carries a font (all native patches but Unity's) has an **Arabic font** menu beside its switch. A new pick is made into the game's patch the next time **Play** is pressed (from the game's approved Arabic or the shared memory, so nothing is translated again); if it can't be made then, the game starts with the font it had, and says so.
- **The admin:** **Admin Panel → Pending approvals** has **Arabic font for this game** on each game's review page (`PUT /api/admin/games/:game/font-style`). It goes into the game's signed Arabic set, and players' apps build with it unless the player picked another.
- **Pack authors:** `--font-style` (or `--font`); the pack's `pack.json` says which (`fontStyle`).

Unity games keep the TextMeshPro font bundle their pack was built with (`--font-bundle`, or made from the `--font-style` with `--unity-editor`), since it can only be made with the Unity Editor, so they have no menu. The overlay always draws with the app's own font.

Files are added, never replaced, except by Bethesda, loose-file and engine recipe packs: if any name is taken, nothing is added. Those three replace the game's own files where they must (its English text files, a loose string table or `fontconfig.txt` a mod put there, the archive a recipe repacked). Each original is copied out of the game's folder first, into the app's data folder, and checked to be an exact copy before anything is written. A record is saved before the first file is written, so a crash halfway is undone on the next start, originals put back. Turning Arabic off removes only files that are still exactly what was added, puts each replaced original back byte for byte, and removes folders GameShelf created; anything the player changed or added is left and listed (a file a game update changed since stays, and GameShelf says where its copy of the original is). Nothing is changed while the game is running.

**Game updates (checked at Play).** When a patch goes in, GameShelf notes the size and time of each file it added or replaced, of the copies of the originals it keeps, and of the game's own files the patch depends on: the game's program, and its Unreal `.pak`/`.utoc`/`.ucas`/`.sig` files, RE Engine's `re_chunk_000.pak` and its patch files, Unity's main asset files, Ren'Py's `.rpa`/`.rpyc` files, Godot's `.pck`, a Bethesda game's plugins and archives, or the runtime adapter's folder (up to 400 files). Every time **Play** is pressed with Arabic on, it checks them, hashing a file only when its size or time changed. When Steam, Epic or another store has updated the game since:
- The outdated Arabic comes out **without putting any old copy back over the update**: each file the update wrote stays as the update made it, GameShelf's copies of the old originals are deleted, and its own files are removed. An RE Engine patch file that the game would stop loading without is left in place, and the new Arabic goes in as the next patch file.
- The Arabic is made again from the updated files, the same way as **Request Arabic subtitles** but from the game's signed, approved Arabic (or the shared memory), so only lines the update added need translating. The switch says *"The game was updated: making its Arabic again…"*, and the game starts in Arabic.
- If it can't be made just now (no connection, say), the game starts in English with the update intact, and the app says why; the next Play tries again. Turning Arabic off after an update gives back the updated English, never the English from before it.

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

### Making a pack in one command

`scripts/build-arabic-pack.py` goes from a game's English to a signed pack: it reads the text, translates what isn't translated yet, compiles it and signs the pack.

```bash
export OPENAI_API_KEY=...
```
```bash
python scripts/build-arabic-pack.py "C:/Games/My Game" --id my-game-ar --version 1.0.0 --steam-app-id 123456 --key ../gameshelf-keys/pack-signing.key --provider openai --model <model> --context "A fantasy RPG set in a desert kingdom"
```

- **What it reads:** a game folder (loose `.locres` files, a Unity game's `_Data` folder, a Ren'Py game, a Godot project, a Bethesda game's string tables, or for other engines whatever readable text files the loose-file scanner finds), or a single `.locres`, Unity `.assets`, Ren'Py `.rpy` or `.rpa`, Godot translation CSV (`keys,en,...`), gettext `.po`, CSV (`source`, optional `arabic` and `key` columns), JSON, or XUnity `.txt` file.
  - Unity asset files need `pip install UnityPy`, and the lines it picks out are a best guess, so check them.
  - Ren'Py dialogue and menu choices are read as Ren'Py reads them, from `.rpy` files, from compiled `.rpyc` scripts (RPYC2 slot files and older zlib-only ones) and from either inside `.rpa` archives (RPA-3.0 and 2.0; read as slices of the archive, never changed). `.rpyc` files are pickles of Ren'Py's statements; `renpyc.py` reads them with every class they name replaced by an inert stand-in, so nothing in them ever runs, and takes the dialogue (`Say`), menu choices (`Menu`), speaker names (`Character("...")`) and interface strings marked `_()`, leaving out translations already in the game (`tl/`).
  - Godot games keep their text in their `.pck`: recover the project from your own copy (GDRE Tools) and give that folder. Its translation tables are used if it has them; otherwise the text in scenes and `tr()` calls.
  - RE Engine games: the game's own folder. The message files are taken straight out of `re_chunk_000.pak` and its patch files (each patch's version wins, as in the game), so no extraction tool or file list is needed; files are known by their name hashes, and the Arabic patch puts its files back under the same ones. Turn Arabic off for the game first, so its Arabic patch isn't read as English. Games that compress with zstd need `pip install zstandard` (built into Python 3.14); paks with an encrypted file table, and encrypted files, are refused, as that needs the game's key. A folder you extracted yourself works too (`natives/stm/.../*.msg.<version>`, with or without [REMSG_Converter](https://github.com/dtlnor/REMSG_Converter) dumps), or a single dump with `--msg-path natives/...`.
  - Unreal games: the game's own folder. Its English `Game.locres` and its font files are read from its `.pak` files with [repak](https://github.com/trumank/repak) and, in UE5 games, its IoStore `.utoc`/`.ucas` containers with [retoc](https://github.com/trumank/retoc) (`retoc list --path`, and `retoc get` for a `.locres` kept in a container). In most UE5 games `.locres` and `.ufont` files still sit in the `.pak` beside each container; the containers hold cooked packages, including fonts kept inside them. Encrypted paks and containers (the `.utoc` header says so) are left alone unless an admin attached the game's AES key in a signed **key recipe** (`{"format": 1, "game": {"steamAppId": ...}, "engine": "unreal", "aesKey": "0x<64 hex digits>"}`, checked like every recipe); then the app hands it to the builder in `GAMESHELF_AES_KEY` (never on a command line it shows, or in a log), and the builder passes it to repak and retoc as `--aes-key`, hiding it in their output. GameShelf never looks for a key: not in the game's program, its memory or anywhere else. Without one, **Request Arabic subtitles** sends the request to the admins with the reason, and the same button makes the Arabic once a key recipe is attached. Only attach a key the game's publisher allows modders to use.
- **Translating:** `--provider openai` (any OpenAI-compatible API; `--api-base` for others) or `--provider gemini`, with the key in `OPENAI_API_KEY` or `GEMINI_API_KEY`. Lines go out in parallel batches (`--batch`, `--workers`). Every tag and placeholder must come back unchanged or the line is asked for again; lines that still fail are listed, not packed. `--glossary terms.csv` keeps names and terms consistent.
- **The game's glossary** (before translating, unless `--no-glossary`): the builder picks out the game's character names, places, items and UI terms (capitalized words and phrases that come back across its lines, and short menu-like lines), and one quick request works out how to write each in Arabic (transliterated or translated, as the game would) and whether the game speaks to the player as a man or a woman (with a few lines that tell). It's saved as `glossary.json` beside the pack (edit it to fix a name; a later run uses it as it is). Each batch then gets the glossary terms that appear in its own lines, and the instruction to address the player as `أنتَ` (تستطيع، اذهب) or `أنتِ` (تستطيعين، اذهبي), so names, items and how the player is spoken to stay the same across the whole game. When the player's gender isn't clear, masculine, Arabic's usual default, is used.
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
  - `bethesda`: Arabic copies of the game's English string tables for `Data/Strings/`, the Arabic font library `Data/Interface/gameshelf_arabic.swf` and the game's own `fontconfig.txt` pointed at it (`--no-fonts` for the tables alone).
  - `loose`: the game's own text files with the Arabic in place of the English, at their own paths, and the Arabic font in place of its loose fonts.
  - `custom`: with `--recipe recipe.json` (an [engine recipe](#engine-recipes-packed-engines)) and `--tools-dir` (where the recipe's tool is, `build-tools/arabic-builder/tools` by default): the files the recipe makes.
    - UE5 games whose fonts are cooked packages (the build's log names them): cook replacement font assets from the Arabic font in a blank project of the game's Unreal Engine version, with the same package paths, and give the folder of cooked files (`<Project>/Content/...`, each `.uasset` with its `.uexp`) with `--font-assets`. They go into `pakchunk99-ArabicLocalization_P.utoc` and `.ucas` with `retoc to-zen --version UE5_x`, beside the Arabic `.pak` (retoc keeps that `.pak`; it only writes an empty one when there's none). The version comes from the `++UE5+Release-5.x` text in the game's program, or `--ue-version`. GameShelf doesn't read or rewrite the game's own font packages.
  - `runtime`: the [runtime adapter](#native-runtime-adapter) as `--proxy version.dll` (or `dinput8.dll`) and `gameshelf_arabic/gameshelf_strings.bin`, from the game's folder; `--extra-lines` adds the strings the adapter saw in the game (`untranslated.txt`).
- **Output:** `build/arabic-packs/<id>/pack` is the signed pack to add in App settings.

### Native runtime adapter

For single-player games made with their own C++ engines whose archives no tool can repack, without unpacking or decrypting anything, and without the overlay window. Like BepInEx and XUnity.AutoTranslator in Unity games, it works inside the game: a small library of GameShelf's own (`localization/runtime/`, C, about 90 KB) that the game loads from its own folder as `version.dll` (or `dinput8.dll`), passing every call on to the real Windows library. It runs one of two ways, which the app picks from the game's import tables before anything is installed:
- **Text** (games whose UI text goes through Windows' text functions): it swaps each English string for its Arabic right before Windows lays the text out, so the game's own UI draws the Arabic.
- **Canvas** (games that draw their own text on Direct3D 11, from font atlases, Scaleform or FreeType, whose fonts have no Arabic letters): it watches the strings the game converts, copies and formats, and when one has Arabic, draws that Arabic onto the game's own frames, inside its `IDXGISwapChain::Present` (and `Present1`), with Direct2D and DirectWrite in the bundled Arabic font, on a dark box in the subtitle area (the pack's overlay region, or the bottom of the frame), for a few seconds per line. It's in the game's own frame, so it shows in exclusive fullscreen too, with no window of its own. The game's device is made with BGRA support (`D3D11CreateDevice` gets the flag added) so Direct2D can draw on it.

- **What it reaches:** text the game hands to Windows to draw: GDI's `ExtTextOutW` and `TextOutW`, USER's `DrawTextW` and `DrawTextExW`, and DirectWrite's `IDWriteFactory::CreateTextLayout` and `CreateGdiCompatibleTextLayout` (which Direct2D's `DrawText` uses too), set right to left. It hooks the import tables of the game's program and the libraries in the game's folder, the ones they load later, and `GetProcAddress` for games that look the functions up themselves. Windows joins Arabic letters and lays them out right to left itself in these functions, so the table holds plain Arabic (the bundled IBM Plex Sans Arabic is added for GDI, privately; DirectWrite falls back to Windows' Arabic fonts).
- **Strings in buffers** (both ways): `MultiByteToWideChar`, `WideCharToMultiByte` (UTF-8), `wcscpy_s`, `wcsncpy`, and the C runtime's formatting functions (`_vsnwprintf`, `_vsnprintf`, `vsnprintf`, and the UCRT's `__stdio_common_vswprintf` / `__stdio_common_vsprintf`). The table's length filter lets the many strings no English line is as long as pass without hashing. In text mode a found string's Arabic goes into the game's buffer when it fits (a size query gets the Arabic's size, so the game makes room for it), and a format is swapped only when its Arabic takes the same arguments in the same order; narrow strings are swapped only for games known to use UTF-8. In canvas mode the game's buffers are left as they are, and dialogue the table doesn't have yet (strings that read like lines: three words or more, no paths or keys) is noted for **Translate N new lines**.
- **What it can't reach:** text an engine builds glyph by glyph without passing whole strings through these functions (FreeType itself only ever sees one letter at a time, so it isn't hooked), statically linked C runtimes' copies and formats, and Direct3D 12 frames (no Direct3D 11 device to draw with; the app says so). Direct2D drawing on a game's device hasn't been tried on real games yet. It's 64-bit only.
- **Where the English comes from:** readable text files (the loose-file scanner), then text in the game's `.bin`, `.dat`, `.lang`, `.wad`, `.loc` and `.str` files as they are (runs of UTF-8 and UTF-16, kept when they read like dialogue or menu text, not paths, code or identifiers), never unpacked: files whose bytes look compressed or encrypted are skipped. A game with no readable English gets the adapter with an empty table first: it notes every string it draws without Arabic (outside the game's folder, in the app's data), and **Translate N new lines** beside the switch translates them and rebuilds the table. The English stays on the player's PC and in the server's review queue, like every game's.
- **The table:** `gameshelf_strings.bin`, FNV-1a 64 of each English string (whitespace runs as one space, none at the ends, in UTF-8) to its Arabic in UTF-16, sorted for binary search, with (version 2) a filter of the lengths English lines have (`localization/runtime/gs_core.h`). The adapter's lookups, format checks and UTF-8 code, and Python's table writer, are tested against each other.
- **Safety:** Steam, Epic, GOG and other copies alike, but never in a game whose folder has anti-cheat (Easy Anti-Cheat, BattlEye, Vanguard, Ricochet... the scan runs before any tier is picked), never in a game Steam lists as played only online (no single-player), and never in one Steam lists with Valve Anti-Cheat. Games without a Steam store page (or when it can't be had) rely on the folder scan. Only the exact library this copy of GameShelf ships goes in (packs can't bring their own), it only wakes in the program its settings name, it changes nothing on disk, and it comes out when the switch goes off. Some antivirus programs distrust any `version.dll` in a game's folder, as they do other mod loaders.
- **Building it:** `python scripts/build-runtime-hook.py` (MinGW-w64), into `localization/runtime/prebuilt/` with its SHA-256; `--check` confirms the prebuilt libraries match the sources (the build is reproducible).

### Engine recipes (packed engines)

Some games keep their text in archives only their own tools read (God of War's `.wad` files, Cyberpunk 2077's `.archive`, `.psarc` ports...). For those, an admin writes the game's **engine recipe**: which allowlisted tool takes the text out, which of the files it takes out hold the English, and how the Arabic goes back in. Players never write or see one; it's what lets each player's app make the Arabic natively.

1. A player presses **Request Arabic subtitles**. Their app sees the text is packed and there's no recipe yet, and sends the request with the game folder's fingerprint.
2. In **Admin Panel → Requests**, the admin opens **Game folder** (the engine GameShelf thinks it is, file kinds and sizes, folders) and presses **Attach engine recipe…**, which starts from a template for that engine. **Sign & attach** (desktop app) checks the recipe with the pack builder's rules, signs it with GameShelf's `pack-signing.key`, and sends it; the server checks the signature again and keeps it for the game.
3. That player's button, and every other player's, now makes the Arabic on their own PC: the app fetches the recipe, checks GameShelf's signature (never its own key's), and the pack builder runs it on the player's copy of the game. Like every game's Arabic, it goes to Pending approvals for review.

```json
{
  "format": 1,
  "game": { "steamAppId": 1593500 },
  "engine": "santa-monica",
  "tool": "quickbms",
  "script": "...the QuickBMS script for the game's archives...",
  "extract": [["-o", "{script}", "{game}/exec/wad/pc_le/r_english.wad", "{extracted}"]],
  "text": [{ "glob": "**/*.json", "format": "json" }],
  "copy": [{ "from": "{game}/exec/wad/pc_le/r_english.wad", "to": "{work}/repack/r_english.wad" }],
  "repack": [["-o", "-w", "-r", "{script}", "{work}/repack/r_english.wad", "{edited}"]],
  "stage": [{ "from": "{work}/repack/r_english.wad", "to": "exec/wad/pc_le/r_english.wad" }]
}
```

- `extract` runs the tool to take the game's text files out into `{extracted}`; `text` says which of them hold the English and how to read them (`json`, `csv`, `tsv`, `xml`, `po`, `mo`, `lines`, `ini`, or `bethesda-strings`); the same files with the Arabic in them go to `{edited}`; `copy` and `repack` put them into a copy of the game's archive; `stage` says what goes into the game, and where. `{font}` and `{font_bold}` are the Arabic font, for recipes that put it in place of the game's. `"shape": false` keeps the Arabic unshaped for engines that shape it themselves; `"maxLine"` sets where lines wrap.
- **What a recipe can't do:** run any program but the tools in `localization/custom_engines.json` (QuickBMS, WolvenKit.CLI, repak), found in GameShelf's own tools folder, never at a path a recipe gives; go through a shell; name a path outside the game's folder and the build's work folder (every path starts with a placeholder, and plain arguments can't hold a path at all); write into the game's folder (`{game}` is only for reading, in `extract` and `copy`); or put a program, library or script into a game. Tools run without the player's sign-in in their environment. Recipes never hold encryption keys, and GameShelf never looks for any: a game whose archives are encrypted stays request-only. Executables can't be uploaded; a new tool means a new GameShelf release with it in the allowlist.
- **Presets** in `localization/custom_engines.json`: FromSoftware and Capcom MT Framework games, and Rockstar games with unpacked `.gxt2` tables, need no recipe (their message tables are read natively, above); Rockstar `.rpf`, Ubisoft Anvil/Dunia (`.forge`, `.pck`, Oodle-compressed), REDengine, Decima and the rest need an admin's recipe, with the notes there; an Unreal game's recipe holds only its key (see Unreal, above).
- The game's own files are never written to while a recipe runs: the tool works on copies, and GameShelf swaps the results in at Play, keeping the originals to put back.
- API: `GET /api/arabic/recipes/:game` (signed-in players: `{ recipe, signature }`), `GET /api/admin/recipes` (with `maskedKey`, `verified` and the server's pack `publicKeys`), `POST /api/admin/recipes` `{ game, recipe, signature, title?, container? }`, `POST /api/admin/recipes/batch` `{ items }` (up to 100, each checked on its own), `PUT /api/admin/recipes/:game` (the desktop app), `DELETE /api/admin/recipes/:game` (revoke), and `GET /api/admin/engines` (the registry). `POST /api/arabic/status` says `recipe: true` for games that have one, and `answered: 'key'` to a player whose request a key answered.

### AES Keys & Recipes (Admin Panel)

**Admin Panel → AES Keys & Recipes** (إدارة مفاتيح التشفير ووصفات المحرك) lets an admin give an encrypted Unreal game's AES-256 key at any time, before anyone asks for its Arabic. GameShelf never looks for keys: use the key the game's publisher or modding community published.

- **Quick add:** pick the game from the catalog (or type its Steam app id), the engine (Unreal Engine 5 IoStore `.utoc/.ucas` or Unreal Engine 4 `.pak`), the key (`0x` and 64 hex digits, or 44 characters of base64, checked as you type) and an optional note or container path (e.g. `Content/Paks/~mods`). **Sign & save recipe** (توقيع وحفظ المفتاح) signs the key recipe and sends it.
- **Bulk paste keys:** one `Game name | 0x…` line per game (or a Steam app id / `steam:<id>`). Each name is looked up in the catalog, shown with its match, and only the checked lines are signed and attached together. A game that appears twice is signed once.
- **Signed recipes:** every game with a recipe, its engine, the key masked (`0x4BC8…E01D`), whether its signature verifies against the server's pack key today, the date, and **Update** / **Revoke**.
- **Requests:** a request a player's app made because the game was encrypted gets an **Add AES key…** button (the game filled in). Once a key is attached, those requests show **Ready · key attached**, and the players who asked are emailed (when their address is confirmed). Their app then reads the game with `retoc`/`repak` the next time they press the button; a key attached before anyone asked works on the very first press. Revoking a key puts the requests back to waiting.

**Signing never happens on the server.** It only checks each recipe against GameShelf's public pack key (`localizationPackKey` in `desktop/config.json` or `PACK_PUBLIC_KEY`) and refuses unsigned, altered or wrongly signed recipes, and key recipes with anything but the key.

- **In the desktop app,** the Pack Studio signs with `pack-signing.key` on that PC (the same as Approve, Sign & Publish).
- **In a browser,** **Unlock admin signer (in-browser only)** takes `pack-signing.key` (pick the file or paste it: PEM/PKCS#8, or the raw Ed25519 key as hex or base64). It's checked against the server's public key and kept only in that tab's memory, as a non-extractable WebCrypto Ed25519 key. Browsers without WebCrypto Ed25519 use the pure-JS RFC 8032 code in `public/js/admin-signer.js` instead. The key is never sent, saved or remembered; Lock, leaving the tab or closing the page forgets it. Use it only on your own computer, over HTTPS, without browser extensions you don't trust: anything running in that page could use the key while it's unlocked.

### Shared translation memory

A GameShelf website can keep every Arabic line it has machine-translated, so each line of a game is paid for once and every later build (by anyone) gets it for free.

- **What's stored:** per game (`steam:<app id>` or `game:<GameShelf id>`), a SHA-256 of each English line and its Arabic. The English itself is never stored, and no game files are.
- **Who translates:** only the server, with its own API key. It checks that each line's hash really is that line (so nobody can plant Arabic under another line), and that every tag and placeholder came back unchanged, before keeping anything.
- **Limits:** each account (or desktop app) may have `TRANSLATE_DAILY_LINES` new lines translated a day (default 2000), and the whole server `TRANSLATE_MONTHLY_CHARS` characters a month (default 3,000,000). Lines already in the memory never count. Two people asking for the same game at once don't pay twice.
- **Turning it on:** set `OPENAI_API_KEY` on the server (and optionally `TRANSLATE_MODEL`, default `gpt-4.1-mini`, or `TRANSLATE_API_BASE` for another OpenAI-compatible API). Without a key, the endpoints say it isn't set up.
- **Using it from the pack builder:** make an access token on the website (Edit profile, Access tokens), set it as `GAMESHELF_TOKEN`, and add `--shared https://your-gameshelf-site`. The builder takes what the memory has, has the server translate the rest, and checks every answer again. With `--no-translate` it only takes what's already there; with `--provider` too, lines the server couldn't do (say, over a limit) go to your own API key.
- **Glossaries:** with `--shared` (and in the desktop app's builds), the game's glossary is kept on the server: the first build of a game sends the candidate terms and a few sample lines (`POST /api/translations/glossary`), the server makes the glossary once (counted against the daily line limit), and every later batch the server translates for that game follows it. Admins read and fix it on the game's review page in **Admin Panel → Pending approvals** (names and terms, one per line as `English = Arabic`, and the player character's gender); once an admin has saved it, the automatic pass only adds new terms to it, never changes theirs (`GET` / `PUT /api/admin/glossaries/:game`).
- **The desktop app** uses the same memory without an account: each copy gets its own device token (`POST /api/arabic/devices`, a few per address a day) and the same daily limit as an account.
- **Which games are ready:** pack builds with `--shared` tell the server how many lines the game has; a game is ready once the memory holds 95% of them. `POST /api/arabic/status` `{ games }` says so, with how many players asked; `POST /api/arabic/requests` `{ game, name }` counts a request; `POST /api/arabic/report` is the builders' line count.
- **Admins** (see Admin Panel above): `GET /api/admin/requests` lists the most asked-for games. An admin's build also saves the font names an RE Engine game's patch replaces (from `--pak-list`), so players' apps can build it with no file list: build each RE Engine game once yourself with `--shared` and `--pak-list`.
- **API:** `POST /api/translations/lookup` `{ game, hashes }` and `POST /api/translations/translate` `{ game, lines: [{ hash, english }], context }`, for signed-in users (session or `Authorization: Bearer gst_...`) and desktop apps (`Bearer gsd_...`); tokens at `GET/POST/DELETE /api/me/tokens`.

Translations of a game's script are derived from it, so sharing them is best kept to games whose publishers allow fan translations.

### Players helping: most requested games and translation fixes

- **Most requested games** (`#/arabic` in the sidebar, as **Arabic requests**): the games players want Arabic for that don't have it yet (no approved Arabic, no published pack), most votes first, with how far each has got (partly translated, waiting for an admin, waiting for an engine recipe). Signed-in players press **Upvote request (+1)** on any of them, and press it again to take the vote back; one vote per player per game. A game's **Request Arabic subtitles** in the Windows app is a vote too. **Admin Panel → Requests** is the same list for admins, with each game's folder report. `GET /api/arabic/leaderboard?limit=`, `POST /api/arabic/requests` `{ game, name }` (vote), `DELETE /api/arabic/requests/:game`.
- **Report a translation issue:** games with Arabic on have a **Report a translation issue** button beside the switch. The player searches the game's lines (from the last build on their PC, English and Arabic side by side) or pastes the English and the Arabic they saw, writes better Arabic, and adds a note if they like (`POST /api/arabic/fixes` `{ game, english, current, suggestion, note }`; the same checks as every translation: tags and placeholders must stay as they are). A player's newer report of the same line replaces their older one.
- **Admin Panel → Translation fixes** lists the reports, how many players reported each line, and the Arabic each suggests, which the admin can reword. **Approve** puts it in the shared memory as reviewed Arabic, so every later build of the game has it, and settles the other reports of that line; **Turn down** drops it (`GET /api/admin/fixes?status=`, `POST /api/admin/fixes/:id/approve` `{ arabic }`, `POST /api/admin/fixes/:id/reject`). A game whose approved Arabic is already in the catalog needs it signed again to reach players: **Sign & publish fixes** (desktop app) signs the game's Arabic as it now is with `pack-signing.key` as the next version of its set (`GET /api/admin/sets/:game/next`, `POST /api/admin/sets/:game/publish` `{ set, signature }`, checked against GameShelf's key like an approval), and players get it the next time they play.

### Pack Studio (Admin Panel, desktop app)

Admins build packs without a command prompt: pick the game's folder (or a file with its text), the engine (or let it detect it), how to translate (GameShelf's shared memory, your own OpenAI or Gemini key, or only your checked translations.csv), and GameShelf's `pack-signing.key`. The Studio runs the same pack builder as `scripts/build-arabic-pack.py`, shows its output as it goes, and signs the pack. Then **Publish to Cloud Catalog** sends it to the server, and every player gets it the next time they turn Arabic on; **Add to this PC** tries it locally first, and **Open translations.csv** is for checking lines and building again with them. API keys are saved encrypted by Windows (or kept until the app closes when it can't). The Studio warns when the chosen key isn't the one players' apps check with.

Packs hold game files where the engine needs them (an RE Engine patch carries the game's message files with the Arabic added, for example), so publishing them shares that game data; the in-app build ("Request Arabic subtitles") makes those patches on each player's PC instead, from their own copy.

## Security

What protects players, and where it's tested (`test/security.test.js`, `localization/tests/test_security.py`):

- **Desktop app:** every window is sandboxed (`contextIsolation`, `sandbox`, no Node, `webSecurity`, no insecure content, no `<webview>`). IPC answers only GameShelf's own page in the top frame, never an embedded trailer or another site. Windows can't navigate away or open pop-ups. Only `https://` pages and a short list of launcher links (`steam://rungameid/<number>` and the like) open outside the app. Pages get no camera, microphone or location; only the subtitle capture window may record the screen. Files the Pack Studio uses must be ones the admin chose in the app's own file picker. See `desktop/safety.js`.
- **No shell, ever:** every tool (repak, retoc, QuickBMS, REMSG, Python) runs from an argument list. Python goes through `arabic_compiler/safe_exec.py`, which also refuses `.bat`/`.cmd` tools on Windows (cmd.exe would read `&`, `|` and `%VAR%` in their arguments). Game paths and AES keys reach tools exactly as written.
- **Paths:** zips, pack manifests and recipes can't name a file outside their folder (`..`, absolute paths, drive letters, either slash). The stager, the loose-file scanner and the pack builder resolve real paths and don't follow links. Packs can't put programs into a game.
- **Signatures:** packs and recipes must be signed with GameShelf's Ed25519 key. The server holds only the public key and refuses to start if `PACK_PUBLIC_KEY` is a private key; `pack-signing.key` stays offline with the admin's Pack Studio.
- **Accounts:** passwords use scrypt (N=2^15, upgraded at sign-in from older hashes) with timing-safe comparison, and a wrong username takes as long as a wrong password. Session tokens, Guard codes, recovery codes and remembered devices are stored only as SHA-256 hashes. Cookies are `HttpOnly`, `SameSite=Lax` and `Secure` in production (`NODE_ENV=production`). Steam linking is checked with Valve itself (see above).
- **Limits:** per address and per account on sign-in, Guard codes, password resets, translation, friends and support; translation also has daily and monthly caps.
- **Web:** a strict Content-Security-Policy (`script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, no framing), `X-Frame-Options: DENY`, `nosniff`, HSTS over HTTPS, and no CORS. Requests that change something are refused when a browser says they came from another site. JSON bodies are capped at 500 KB. Errors never show stacks or file paths. Everything players write is shown as text, never as HTML.

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
src/account-api.js   sign-up, sign-in with GameShelf Guard, Security settings (email, Guard, recovery codes, password, sessions)
src/guard.js         Guard's codes: emailed codes, sign-in challenges, recovery codes, remembered devices
src/totp.js          authenticator app codes (RFC 6238)
src/mailer.js        sending email over SMTP (SMTP_URL), no extra packages
src/steam-openid.js  linking Steam with Steam's own sign-in, checked with Valve
src/friends.js       friend codes, requests, blocks and presence
src/support.js       support tickets
src/social-api.js    routes for Steam linking, friends, presence and support
src/countries.js     the nationality list (public/js/countries.js is the browser's copy)
src/plans.js         GameShelf Supporter: plans, compute quota, boosts, prepaid codes
src/billing.js       Stripe and LemonSqueezy webhooks (signed, handled once)
src/plans-api.js     routes for plans, codes, boosts and webhooks
src/affiliate.js     partner tags on store links
src/db.js            SQLite database built into Node (saved to data/gameshelf.db, upgraded automatically)
src/engine-recipes.js signed engine recipes and Unreal AES key recipes, per game, for games whose text is packed or encrypted
src/games/steam-wikidata.js the game data: Steam store search and details, Wikidata (Arabic titles, engines, Epic/GOG links), cached, rate-limited
src/games/rawg.js    the RAWG game database (older alternative)
src/games/local.js   built-in sample catalog (data/games.json)
src/games/stores.js  "where to buy" store links
src/games/genres.js  genres you can browse by
desktop/             the Windows app (Electron): window, settings file, installed and running games, games added by hand, app icon
desktop/localization/ Arabic in games: anti-cheat check, engine detection, signed packs and their files (added, or replacing the game's with the originals kept), the scripts GameShelf adds to Ren'Py and Godot games, engine recipes and game folder fingerprints, the subtitle overlay (capture, change detection, OCR helper, fingerprint matching)
desktop/overlay/     the overlay's two windows: the Arabic subtitles, and the hidden capture
localization/runtime/ the native runtime adapter (C): the string table (gs_core), the Windows hooks (gs_hook) and the stand-in library (gs_proxy), with its prebuilt version.dll and dinput8.dll
localization/        the Arabic compiler (Python) for engines that can't shape Arabic, the overlay's fingerprints, the pack generator (.locres files, Ren'Py, Godot and RE Engine text, Bethesda string tables and archives, the loose-file scanner, engine recipes, translation), the engines and tools recipes may use (custom_engines.json) and the bundled Arabic font (assets/fonts)
public/css/          the stylesheet
public/fonts/        the Manrope and Alexandria fonts (SIL Open Font License), Subtitle Studio's fonts in studio/ (OFL) and Twemoji Country Flags (MIT; flag art CC-BY 4.0)
public/js/friends.js the Friends & Activity drawer; country-picker.js the nationality picker and flags
public/js/i18n.js    English and Arabic: t() for phrases, tn() for counts; lang/ar.js has the Arabic
public/js/boot.js    sets the page's language and direction before it's drawn
public/js/main.js    navigation and page routing
public/js/admin-signer.js the Admin Panel's in-browser Ed25519 signer (WebCrypto, with an RFC 8032 fallback) and key recipes
public/js/palette.js the search pop-up
public/js/preview.js hover previews; discover.js the discovery queue; art-color.js the page tint
public/js/seasons.js when each season runs, and its look (season-fx.js draws its decoration)
public/js/views/     one file per page (home, browse, game, library, profile, edit profile, import, community, log in and sign up, security, support, pricing, about & legal, app settings)
scripts/             developer tools (backfill-games, search-debug, localization-pack, build-arabic-pack, build-runtime-hook, bundle-arabic-builder, fake-ocr-helper)
test/                automated tests: npm test
```

## Brand

GameShelf's mark is a **G drawn with the Arabic letter ع**: the G's bowl runs into the ع's lower arm, its upper arm rises from the same point, and the G ends in an inward curl (drawn from Hamad's sketch, line weight 52 on a 512 grid). It's lime `#e7ff0c` on `#121316`, or dark on lime.

- `public/brand/mark.svg`: the mark alone (`currentColor`), the master for everything below; the header inlines the same two paths beside «GameShelf», or «قيم شلف» on the Arabic site
- `public/favicon.svg`: the mark alone, cropped to its edges so it fills the browser tab (line weight 58 for 16 px), lime in dark browser themes and dark in light ones
- `public/brand/mark-lime-tile.svg`, `public/apple-touch-icon.png` (180 px), `public/og-image.png` (1200 × 630, link previews), `public/brand/discord-badge.png`: dark mark on lime
- `desktop/icon.ico` (256, 64, 48, 32, 16: window, taskbar and installer), `desktop/icon.png` (512, macOS and Linux), `desktop/icons/tray-*.png` (16, 24, 32, lime and `-dark`, for a tray icon)
- `public/img/empty-shelf.svg`: the ع whose tail is a shelf, shown in an empty library

## Data sources and legal notes

GameShelf credits each source where its data appears and on the About & legal page (`#/legal`):

- **Steam store**: game names, art, descriptions, genres, release dates, requirements and screenshots from each game's public store page, linked back to it.
- **Wikidata**: Arabic titles and descriptions, game engines, Epic/GOG links and official websites. Its data is CC0 (public domain), so it can be used in a product that makes money; GameShelf credits it anyway.
- **CheapShark**: prices. Buy buttons use CheapShark's own redirect links, as its terms ask.
- **Wikipedia**: summaries of games that aren't on Steam, under CC BY-SA 4.0, credited and linked on each game page.
- **hls.js** (Apache License 2.0, `public/js/vendor/LICENSE-hls.js.txt`): plays Steam's trailers in browsers without HLS.
- **Steam store pages**: "About this game", system requirements, achievements, features and Metacritic scores, credited and linked back to the store page.
- **YouTube**: trailers play in YouTube's official embedded player (privacy-enhanced mode), only after the visitor presses play.
- **Fonts**: Manrope and Alexandria, and Subtitle Studio's Cairo, Tajawal, Amiri and IBM Plex Sans Arabic, are under the SIL Open Font License (license files in `public/fonts/` and `public/fonts/studio/`). Thmanyah Sans isn't included; see [Arabic](#arabic). Flags use Twemoji Country Flags (MIT), whose flag art is Twitter's Twemoji under CC-BY 4.0, credited on the About & legal page.
- **QR codes**: drawn in the browser with qrcode-generator (MIT, `public/js/vendor/qrcode.mjs`).
- **Steam sign-in**: linking uses Steam's public OpenID sign-in. GameShelf isn't affiliated with Valve.

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
| GET | `/api/auth/username?name=` | `{ username, available, reason }`, for checking a username while typing |
| POST | `/api/auth/register` | `{ username, email, password, confirmPassword, nationality }` (nationality is an ISO code such as `AE`) → `{ user, emailSent }` |
| POST | `/api/auth/login` | `{ username, password }` (username or email) → `{ user }`, or `{ guard: { challenge, method, email } }` when Guard needs a code |
| POST | `/api/auth/guard` | `{ challenge, code, remember }` the 6-digit or recovery code → `{ user, via, backupCodesLeft }` |
| POST | `/api/auth/guard/resend` | `{ challenge }` another emailed code |
| POST | `/api/auth/forgot` | `{ username }` (or email): emails a reset code if the account exists; always `{ sent: true }` |
| POST | `/api/auth/reset` | `{ username, code, password }` sets a new password → `{ reset, user }` (signed in), or `{ reset, signIn: true }` with Guard on |
| POST | `/api/auth/logout` | |
| GET | `/api/me/security` | Email, Guard, Steam link and active sessions |
| POST | `/api/me/email` · `/api/me/email/send` · `/api/me/email/verify` | Change the address (`{ email, password }`), send a code, confirm it (`{ code }`) |
| POST | `/api/me/2fa/totp/start` · `/confirm` | `{ password }` → `{ secret, uri }`; then `{ code }` → `{ backupCodes }` |
| POST | `/api/me/2fa/email/start` · `/confirm` | `{ password }` emails a code; then `{ code }` → `{ backupCodes }` |
| POST | `/api/me/2fa/disable` · `/api/me/2fa/backup-codes` · `/api/me/2fa/code` | `{ password, code }` turn Guard off or make new recovery codes; email a code (Email Guard) |
| POST | `/api/me/password` | `{ current, next }`; signs out every other session |
| GET · DELETE | `/api/me/sessions` · `/api/me/sessions/:id` | Active sessions; sign one out. `POST /api/me/sessions/revoke-others`, `DELETE /api/me/devices` |
| GET | `/api/auth/steam/link` | Redirects to Steam's sign-in (`POST` returns `{ url }`, for the desktop app) |
| GET | `/api/auth/steam/return` | Where Steam sends the player back; links after Valve confirms it |
| GET · DELETE | `/api/me/steam` | The linked Steam account; unlink it |
| GET | `/api/friends` | `{ code, friends (with presence), incoming, outgoing, blocked, online }` |
| GET | `/api/friends/find?q=` | A player by friend code or `@username` |
| POST | `/api/friends/request` · `accept` · `decline` · `remove` · `block` · `unblock` | `{ username }` or `{ code }` |
| POST | `/api/presence/heartbeat` | `{ status: online \| in_game \| offline, gameId, gameTitle, steamAppId, arabicEnabled }`; expires after 2 minutes |
| GET · POST | `/api/support/tickets` | My tickets; `{ category, subject, gameId?, message }` opens one |
| GET | `/api/support/tickets/:id` | A ticket and its messages (`POST …/messages { body }` replies, `POST …/close`) |
| GET | `/api/admin/support?status=&category=` | Admins: the ticket queue (`GET /api/admin/support/:id`, `POST …/messages { body, status? }`, `PATCH { status }`) |
| GET | `/api/plans` | The plans (for `#/pricing`), checkout links, and `packsAlwaysFree: true` |
| GET | `/api/me/plan` | The player's plan, perks, AI usage today and this month, and boost tokens left |
| POST | `/api/me/plan/redeem` | `{ code }` a prepaid or gift code → `{ days, plan, until, summary }` |
| POST | `/api/arabic/boosts` | `{ game, tokens }` (Supporters) → `{ game, boosts, boosters, you }` |
| GET · POST | `/api/admin/plans`, `/api/admin/plans/codes`, `/api/admin/plans/codes/:batch/revoke`, `/api/admin/plans/grant` | Admins: batches and supporters; `{ count, days, note }` makes codes (shown once); revoke a batch's unused codes; `{ username, days }` |
| POST | `/api/billing/webhook` | Stripe or LemonSqueezy events, checked by signature |
| GET | `/api/me` | The logged-in user (or `null`), with `supporter` |
| PATCH | `/api/me` | `{ displayName, headline, bio, country, avatarFrame, background, accent, showcases }` |
| PUT | `/api/me/avatar` | `{ image }` as a JPEG/PNG/WebP data URL |
| DELETE | `/api/me/avatar` | Removes your avatar |
| PUT | `/api/me/library/:gameId` | `{ status, rating }` adds or updates a game on your list (rating 1 to 10, shown as half stars) |
| DELETE | `/api/me/library/:gameId` | Removes a game from your list |
| POST | `/api/me/import/steam/preview` | Reads the linked Steam account's library and matches the games (403 `link_required` without a linked account) |
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
| GET | `/api/arabic/leaderboard?limit=` | The most requested games still without Arabic, with `voted` for the signed-in player |
| DELETE | `/api/arabic/requests/:game` | Takes a player's vote back (`POST /api/arabic/requests` is the vote) |
| POST | `/api/arabic/fixes` | `{ game, english, current, suggestion, note }` reports a line's better Arabic |
| GET / POST | `/api/admin/fixes?status=`, `/api/admin/fixes/:id/approve`, `/api/admin/fixes/:id/reject` | Translation fixes; approving takes `{ arabic }` (the admin's wording) |
| GET / POST | `/api/admin/sets/:game/next`, `/api/admin/sets/:game/publish` | The game's Arabic as it is now, to sign as the next version; `{ set, signature }` publishes it |
| POST | `/api/translations/glossary` | `{ game, terms, samples, context }` the game's glossary (made once, when it has none) |
| GET / PUT | `/api/admin/glossaries/:game` | A game's glossary: `{ terms: { English: Arabic }, player: { gender, name } }` |
| PUT | `/api/admin/games/:game/font-style` | `{ fontStyle: 'plex' \| 'cairo' \| 'naskh' \| null }` the game's Arabic font |

Logins use a cookie session. A native mobile app would most likely switch to token auth (an `Authorization` header), which is a small change in `src/auth.js`.
