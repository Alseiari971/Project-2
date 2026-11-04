// Routes for linking Steam (src/steam-openid.js), friends and presence
// (src/friends.js) and customer support (src/support.js).
const { requireUser, requireAdmin, rateLimit } = require('./auth');
const { SteamLinkError, baseUrl } = require('./steam-openid');
const { FriendError } = require('./friends');
const { SupportError } = require('./support');

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A small page of its own, for Steam's sign-in coming back (in English and Arabic). */
function page(res, status, { title, titleAr, body, bodyAr, extra = '' }) {
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · GameShelf</title>
<link rel="stylesheet" href="/css/standalone.css"></head><body><main class="standalone">
<a class="standalone-logo" href="/">Game<span>Shelf</span></a>
<h1>${escape(title)}</h1><p>${body}</p>${extra}
<div dir="rtl" lang="ar" class="standalone-ar"><h2>${escape(titleAr)}</h2><p>${bodyAr}</p></div>
</main></body></html>`);
}

function mountSocialRoutes(api, { steamOpenId, friends, support }) {
  const friendLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
  const beatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
  const ticketLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
  const steamLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
  const json = (ErrorClass) => (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).then((out) => {
    if (out !== undefined && !res.headersSent) res.json(out);
  }).catch((err) => {
    if (err instanceof ErrorClass) return res.status(err.status).json({ error: err.message });
    next(err);
  });
  const steamRoute = json(SteamLinkError);
  const friendRoute = json(FriendError);
  const supportRoute = json(SupportError);

  // ---- Steam ----

  // The website: straight to Steam's sign-in.
  api.get('/auth/steam/link', steamLimiter, (req, res) => {
    if (!req.user) return res.redirect(302, '/#/login');
    res.redirect(302, steamOpenId.begin(req.user.id, baseUrl(req)).url);
  });
  // The desktop app: the address, opened in the system browser.
  api.post('/auth/steam/link', requireUser, steamLimiter, steamRoute((req) => ({ url: steamOpenId.begin(req.user.id, baseUrl(req)).url })));

  api.get('/auth/steam/return', steamLimiter, async (req, res) => {
    const back = `${baseUrl(req)}/#/settings/security`;
    try {
      const done = await steamOpenId.complete(req.query, baseUrl(req), req.user?.id ?? null);
      if (done.linked) return res.redirect(302, `${back}?steam=linked`);
      const form = `<form method="post" action="/api/auth/steam/confirm">
<input type="hidden" name="state" value="${escape(req.query.state)}"><input type="hidden" name="token" value="${escape(done.confirm)}">
<button class="standalone-btn" type="submit">Link · ربط</button></form>`;
      return page(res, 200, {
        title: 'Link this Steam account?',
        titleAr: 'ربط حساب Steam هذا؟',
        body: `Steam confirmed you signed in as account <b>${escape(done.steamId)}</b>. Link it to the GameShelf account <b>@${escape(done.username)}</b>? Only link it if you started this from GameShelf yourself.`,
        bodyAr: `أكّد Steam أنك سجّلت الدخول بالحساب <b>${escape(done.steamId)}</b>. هل تربطه بحساب GameShelf <b dir="ltr">@${escape(done.username)}</b>؟ لا تربطه إلا إذا بدأت هذا من GameShelf بنفسك.`,
        extra: form,
      });
    } catch (err) {
      if (!(err instanceof SteamLinkError)) throw err;
      if (req.user) return res.redirect(302, `${back}?steam=error&reason=${encodeURIComponent(err.message)}`);
      return page(res, err.status, { title: 'Steam wasn\'t linked', titleAr: 'لم يُربط Steam', body: escape(err.message), bodyAr: 'لم يتم ربط حساب Steam. ارجع إلى GameShelf وحاول مرة أخرى.' });
    }
  });

  api.post('/auth/steam/confirm', steamLimiter, require('express').urlencoded({ extended: false, limit: '4kb' }), async (req, res, next) => {
    try {
      await steamOpenId.confirm(req.body?.state, req.body?.token);
      page(res, 200, {
        title: 'Steam account linked',
        titleAr: 'تم ربط حساب Steam',
        body: 'You can close this page and go back to GameShelf.',
        bodyAr: 'يمكنك إغلاق هذه الصفحة والعودة إلى GameShelf.',
      });
    } catch (err) {
      if (!(err instanceof SteamLinkError)) return next(err);
      page(res, err.status, { title: 'Steam wasn\'t linked', titleAr: 'لم يُربط Steam', body: escape(err.message), bodyAr: 'لم يتم ربط حساب Steam. ارجع إلى GameShelf وحاول مرة أخرى.' });
    }
  });

  api.get('/me/steam', requireUser, steamRoute((req) => steamOpenId.statusOf(req.user.id)));
  api.delete('/me/steam', requireUser, steamRoute((req) => steamOpenId.unlink(req.user.id)));

  // ---- Friends and presence ----

  api.get('/friends', requireUser, friendRoute((req) => friends.list(req.user)));
  api.get('/friends/find', requireUser, friendLimiter, friendRoute((req) => friends.lookup(req.user, req.query.q)));
  const target = (req) => (req.body?.username ? { username: String(req.body.username) } : req.body?.target ?? req.body?.code);
  for (const action of ['request', 'accept', 'decline', 'remove', 'block', 'unblock']) {
    api.post(`/friends/${action}`, requireUser, friendLimiter, friendRoute((req) => ({ ...friends[action](req.user, target(req)), ...friends.list(req.user) })));
  }
  api.post('/presence/heartbeat', requireUser, beatLimiter, friendRoute((req) => ({
    presence: friends.heartbeat(req.user, req.body || {}, /\bElectron\//.test(req.headers['user-agent'] || '') ? 'desktop' : 'web'),
  })));

  // ---- Support ----

  api.get('/support/tickets', requireUser, supportRoute((req) => support.mine(req.user)));
  api.post('/support/tickets', requireUser, ticketLimiter, supportRoute(async (req, res) => {
    const made = await support.create(req.user, req.body || {});
    res.status(201);
    return made;
  }));
  api.get('/support/tickets/:id', requireUser, supportRoute((req) => support.get(req.user, req.params.id)));
  api.post('/support/tickets/:id/messages', requireUser, ticketLimiter, supportRoute((req) => support.reply(req.user, req.params.id, req.body?.body)));
  api.post('/support/tickets/:id/close', requireUser, supportRoute((req) => support.close(req.user, req.params.id)));

  api.get('/admin/support', requireAdmin, supportRoute((req) => support.queue({ status: String(req.query.status || ''), category: String(req.query.category || '') })));
  api.get('/admin/support/:id', requireAdmin, supportRoute((req) => support.adminGet(req.params.id)));
  api.post('/admin/support/:id/messages', requireAdmin, supportRoute((req) => support.adminReply(req.user, req.params.id, req.body?.body, req.body?.status || null)));
  api.patch('/admin/support/:id', requireAdmin, supportRoute((req) => support.adminStatus(req.params.id, String(req.body?.status || ''))));
}

module.exports = { mountSocialRoutes };
