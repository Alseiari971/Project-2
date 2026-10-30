# GameShelf

Look up any game in the world, see where to buy it, and keep a public list of the games you've played.

- **Every game:** search and browse games on every platform, PC, PlayStation, Xbox, Nintendo and mobile, through [IGDB](https://www.igdb.com), the free game database run by Twitch.
- **We don't sell anything:** each game page has "Where to buy" links to the real stores (Steam, Epic, GOG, PlayStation Store, Xbox, Nintendo eShop, itch.io, App Store, Google Play).
- **Live prices:** the best current PC price, every store's price and the all-time low, from [CheapShark](https://www.cheapshark.com) (free, no key needed, US dollars).
- **Steam import:** paste your Steam profile link to bring in your games and hours played.
- **Game launcher look:** a sidebar with your games, a search pop-up (Ctrl+K or `/`), a featured carousel, a Top 10 poster row, a Library page with grid and list views, and a bottom tab bar on phones.
- **Steam-style profiles:** add games to your list as *Playing*, *Completed*, *Played*, *Want to play* or *Dropped* with a half-star rating, then customize your profile:
  - an avatar (upload your own) with an animated frame
  - a background, either a preset scene or art from any game on your list
  - a theme color, a headline, a location and a bio
  - up to 4 showcases: favorite game, a hand-picked collection, highest rated, completed games, stats or a custom text box
  - levels, XP and bronze/silver/gold badges earned from your list, plus a comment wall
- Each game page shows who on GameShelf has played it.

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
- Store links and trailers open in your normal web browser. The window's top bar works as the title bar: drag it to move the window. Mouse back/forward buttons, Alt+Left/Right, F5, F11 and Ctrl +/- zoom work as you'd expect.
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

## Project layout

```
server.js            starts the website
src/api.js           JSON API (games, accounts, lists, profiles, comments)
src/profile.js       profile customization, levels and badges
src/steam.js         reading a Steam library
src/prices.js        live prices from CheapShark
src/steam-store.js   About, requirements, Metacritic and achievements from Steam store pages
src/auth.js          passwords, login sessions
src/db.js            SQLite database built into Node (saved to data/gameshelf.db, upgraded automatically)
src/games/igdb.js    the IGDB game database (every game, every platform)
src/games/rawg.js    the RAWG game database (older alternative)
src/games/local.js   built-in sample catalog (data/games.json)
src/games/stores.js  "where to buy" store links
src/games/genres.js  genres you can browse by
desktop/             the Windows app (Electron): window, settings file, app icon
public/css/          the stylesheet
public/fonts/        the Manrope font (SIL Open Font License)
public/js/main.js    navigation and page routing
public/js/palette.js the search pop-up
public/js/views/     one file per page (home, browse, game, library, profile, edit profile, import, community, log in, about & legal, app settings)
scripts/             developer tools (search-debug)
test/                automated tests: npm test
```

## Data sources and legal notes

GameShelf credits each source where its data appears and on the About & legal page (`#/legal`):

- **IGDB** (Twitch): game data, covers, screenshots and trailers. IGDB's terms require attribution; using it in a product that makes money needs a separate agreement with Twitch.
- **CheapShark**: prices. Buy buttons use CheapShark's own redirect links, as its terms ask.
- **Steam store pages**: "About this game", system requirements, achievements, features and Metacritic scores, credited and linked back to the store page.
- **YouTube**: trailers play in YouTube's official embedded player (privacy-enhanced mode), only after the visitor presses play.

Users can delete their account and all their data from Edit profile. This isn't legal advice; check each service's current terms before launching publicly.

## API (for the future mobile app)

The website talks to the server only through this JSON API, so a phone app can reuse it unchanged.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/home` | Featured games and rows for the home screen |
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
