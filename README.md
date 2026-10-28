# GameShelf

Look up any game in the world, see where to buy it, and keep a public list of the games you've played.

- **Every game:** search and browse 500,000+ games across PC, console and mobile (through the free [RAWG](https://rawg.io) database).
- **We don't sell anything:** each game page has "Where to buy" buttons that link out to the real stores (Steam, Epic, GOG, PlayStation Store, Xbox, Nintendo eShop, itch.io, App Store, Google Play), plus a price-comparison link.
- **Profiles:** sign up and add games to your list as *Playing*, *Completed*, *Played*, *Want to play* or *Dropped*, with an optional 1–10 rating. Anyone can view your profile at `#/u/<username>`, and each game page shows who on GameShelf has played it.

## Run it

You need [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000.

Out of the box the site uses a small built-in catalog of about 35 popular games, so you can try it right away.

### Unlock every game in the world

1. Get a free API key at https://rawg.io/apidocs.
2. Copy `.env.example` to `.env` and paste the key after `RAWG_API_KEY=`.
3. Restart with `npm start`.

## Project layout

```
server.js            starts the website
src/api.js           JSON API (games, accounts, lists, profiles)
src/auth.js          passwords, login sessions
src/db.js            SQLite database (saved to data/gameshelf.db)
src/games/rawg.js    the RAWG game database (every game)
src/games/local.js   built-in sample catalog (data/games.json)
src/games/stores.js  "where to buy" store links
public/              the website (HTML, CSS, JavaScript)
test/                automated tests: npm test
```

## API (for the future mobile app)

The website talks to the server only through this JSON API, so a phone app can reuse it unchanged.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/games?search=&page=` | Search or browse games |
| GET | `/api/games/:id` | Game details, store links, who's played it |
| POST | `/api/auth/register` | `{ username, password }` |
| POST | `/api/auth/login` | `{ username, password }` |
| POST | `/api/auth/logout` | |
| GET | `/api/me` | The logged-in user (or `null`) |
| PATCH | `/api/me` | `{ displayName, bio }` |
| PUT | `/api/me/library/:gameId` | `{ status, rating }` adds or updates a game on your list |
| DELETE | `/api/me/library/:gameId` | Removes a game from your list |
| GET | `/api/users?search=` | Find people |
| GET | `/api/users/:username` | A profile and their game list |

Logins use a cookie session. A native mobile app would most likely switch to token auth (an `Authorization` header), which is a small change in `src/auth.js`.
