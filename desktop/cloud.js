// The desktop app and GameShelf's server (config.json's "server"): players sign
// in to the same account as on the website, so their lists, profile and Arabic
// packs follow them, and they need no game-database keys of their own.
//
// The window still shows the app's own copy of the pages, from its built-in
// server on 127.0.0.1, so the bridge that can start games and change game
// files only ever runs GameShelf's own code. That built-in server passes
// /api requests through to GameShelf's server (createPassThrough). The sign-in
// cookie comes back without its "Secure" flag, since the window's address is
// plain http on this PC, and Electron keeps it, so players stay signed in.
//
// The app's own requests (Arabic packs, matching installed games) go straight
// to the server with the same sign-in (createCloudClient).
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { securityHeaders } = require('../server');

const SESSION_COOKIE = 'gs_session';
// Headers that belong to one connection, not to the request passed on.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization'];

class CloudError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** The app's built-in server in cloud mode: the pages from `publicDir`, /api and /download from `target`. */
function createPassThrough({ target, publicDir }) {
  const base = new URL(target);
  const agent = base.protocol === 'https:' ? https : http;
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  const forward = (req, res) => {
    const url = new URL(req.originalUrl, base);
    const headers = { ...req.headers, host: url.host };
    for (const name of HOP_BY_HOP) delete headers[name];
    // The server sees the request as coming from its own pages.
    if (headers.origin) headers.origin = base.origin;
    if (headers.referer) headers.referer = base.origin + new URL(headers.referer, 'http://x').pathname;
    const upstream = agent.request(url, { method: req.method, headers }, (reply) => {
      const out = { ...reply.headers };
      for (const name of HOP_BY_HOP) delete out[name];
      if (out['set-cookie']) {
        out['set-cookie'] = out['set-cookie'].map((c) => c.replace(/;\s*Secure/gi, '').replace(/;\s*Domain=[^;]*/gi, ''));
      }
      if (out.location?.startsWith(base.origin)) out.location = out.location.slice(base.origin.length) || '/';
      res.writeHead(reply.statusCode, out);
      reply.pipe(res);
    });
    upstream.setTimeout(120000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.status(502).json({ error: 'GameShelf couldn\'t reach its server. Check your internet connection.' });
    });
    req.pipe(upstream);
  };
  app.use('/api', forward);
  app.use('/download', forward);
  app.use(express.static(publicDir));
  return app;
}

/**
 * Requests to GameShelf's server with the signed-in player's session.
 * `server()` is the server's address; `session()` the sign-in cookie's value, or null.
 */
function createCloudClient({ server, session, fetch = globalThis.fetch, timeoutMs = 30000 }) {
  async function request(route, { method = 'GET', body, raw, type, timeout = timeoutMs, auth = true } = {}) {
    const headers = {};
    const value = auth ? await session() : null;
    if (value) headers.Cookie = `${SESSION_COOKIE}=${value}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = type || 'application/octet-stream';
    let res;
    try {
      res = await fetch(new URL(route, server()), { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new CloudError('GameShelf couldn\'t reach its server. Check your internet connection.');
    }
    return res;
  }

  async function json(route, options) {
    const res = await request(route, options);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new CloudError('Log in to GameShelf first.', 401);
    if (!res.ok) throw new CloudError(data.error || 'GameShelf\'s server didn\'t answer as expected.', res.status);
    return data;
  }

  return {
    server,
    session,
    request,
    json,
    /** The signed-in player ({ username, role, ... }), or null. */
    async me() {
      if (!(await session())) return null;
      try {
        return (await json('/api/me')).user || null;
      } catch {
        return null;
      }
    },
    /**
     * Saves a download to `file`, reporting { done, total } as it goes, and
     * resolves to its SHA-256 (hex) and size. Partial files never stay behind.
     */
    async download(route, file, { onProgress = () => {}, maxBytes = 1024 * 1024 * 1024 } = {}) {
      const res = await request(route, { timeout: 30 * 60 * 1000 });
      if (res.status === 401) throw new CloudError('Log in to GameShelf first.', 401);
      if (!res.ok) throw new CloudError((await res.json().catch(() => ({}))).error || 'The download didn\'t start.', res.status);
      const total = Number(res.headers.get('content-length')) || 0;
      const hash = crypto.createHash('sha256');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const out = fs.createWriteStream(file);
      let done = 0;
      try {
        for await (const chunk of res.body) {
          done += chunk.length;
          if (done > maxBytes) throw new CloudError('The download is too big.');
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
          onProgress({ done, total });
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      } catch (err) {
        out.destroy();
        await fs.promises.rm(file, { force: true });
        throw err instanceof CloudError ? err : new CloudError('The download stopped. Check your internet connection.');
      }
      return { sha256: hash.digest('hex'), size: done, headers: res.headers };
    },
  };
}

/**
 * The game database, through GameShelf's server: what the app needs to put
 * installed games on their pages, in the shape of a local game provider.
 */
function createRemoteGames(cloud) {
  let source = 'remote';
  cloud.json('/api/info', { auth: false }).then((info) => { source = info.source || source; }).catch(() => {});
  return {
    get name() {
      return source;
    },
    async matchSteamGames(list) {
      const { matches } = await cloud.json('/api/games/match', { method: 'POST', body: { games: list.map((g) => ({ steamAppId: g.appid, name: g.name })) }, auth: false });
      return matches;
    },
    async search({ query }) {
      const { matches } = await cloud.json('/api/games/match', { method: 'POST', body: { games: [{ name: query }] }, auth: false });
      return { results: matches.filter(Boolean) };
    },
  };
}

module.exports = { createPassThrough, createCloudClient, createRemoteGames, CloudError, SESSION_COOKIE };
