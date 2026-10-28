# GameShelf

Look up any game in the world, see where to buy it, and keep a public list of the games you've played.

- **Every game:** search and browse 500,000+ games across PC, console and mobile (through the free [RAWG](https://rawg.io) database).
- **We don't sell anything:** each game page has "Where to buy" links to the real stores (Steam, Epic, GOG, PlayStation Store, Xbox, Nintendo eShop, itch.io, App Store, Google Play).
- **Live prices:** the best current PC price, every store's price and the all-time low, from [CheapShark](https://www.cheapshark.com) (free, no key needed, US dollars).
- **Steam import:** paste your Steam profile link to bring in your games and hours played.
- **Streaming-app look:** a featured banner with real game logos, a Top 10 poster row, scrolling rows by genre, and a bottom tab bar on phones.
- **Steam-style profiles:** add games to your list as *Playing*, *Completed*, *Played*, *Want to play* or *Dropped* with a half-star rating, then customize your profile:
  - an avatar (upload your own) with an animated frame
  - a background, either a preset scene or art from any game on your list
  - a theme color, a headline, a location and a bio
  - up to 4 showcases: favorite game, a hand-picked collection, highest rated, completed games, stats or a custom text box
  - levels, XP and bronze/silver/gold badges earned from your list, plus a comment wall
- Each game page shows who on GameShelf has played it.

## Run it

You need [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000.

Out of the box the site uses a small built-in catalog of about 35 popular games, so you can try it right away.

### Optional keys

Copy `.env.example` to `.env`, fill in either key, and restart with `npm start`.

| Setting | What it unlocks | Where to get it (free) |
| --- | --- | --- |
| `RAWG_API_KEY` | Search every game in the world instead of the 35-game sample | https://rawg.io/apidocs |
| `STEAM_API_KEY` | "Import from Steam" | https://steamcommunity.com/dev/apikey (any domain works, e.g. `localhost`) |

Steam import only works for profiles whose **Game details** are set to Public in Steam's privacy settings. With the sample catalog, only games in that catalog can be matched; add a RAWG key to match everything.

### Checking search results

If a search shows odd games, `npm run search-debug -- <search words>` prints everything RAWG returned (popularity, stores) and which results GameShelf kept. It uses the RAWG key in your `.env`.

## Project layout

```
server.js            starts the website
src/api.js           JSON API (games, accounts, lists, profiles, comments)
src/profile.js       profile customization, levels and badges
src/steam.js         reading a Steam library
src/prices.js        live prices from CheapShark
src/auth.js          passwords, login sessions
src/db.js            SQLite database (saved to data/gameshelf.db, upgraded automatically)
src/games/rawg.js    the RAWG game database (every game)
src/games/local.js   built-in sample catalog (data/games.json)
src/games/stores.js  "where to buy" store links
src/games/genres.js  genres you can browse by
public/css/          the stylesheet
public/fonts/        the Manrope font (SIL Open Font License)
public/js/main.js    navigation and page routing
public/js/views/     one file per page (home, browse, game, profile, edit profile, import, community, log in)
scripts/             developer tools (search-debug)
test/                automated tests: npm test
```

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
