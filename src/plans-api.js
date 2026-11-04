// Routes for GameShelf Supporter (src/plans.js), boosts, prepaid codes and
// payment webhooks (src/billing.js). Arabic packs are never behind any of these.
const { requireUser, requireAdmin, rateLimit, createCounter } = require('./auth');
const { PlanError } = require('./plans');
const { BillingError } = require('./billing');

function mountPlanRoutes(api, { db, plans, billing, env = process.env }) {
  const redeemLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
  const redeemUserLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, by: 'user' });
  const boostLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, by: 'user' });
  const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
  // Wrong codes per account, whatever address they come from.
  const wrongCodes = createCounter({ windowMs: 60 * 60 * 1000, max: 8 });
  const route = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).then((out) => {
    if (out !== undefined && !res.headersSent) res.json(out);
  }).catch((err) => {
    if (err instanceof PlanError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  });
  const checkout = (url) => (/^https:\/\//.test(url || '') ? url : null);

  // What the plans are (the Pricing page), for everyone.
  api.get('/plans', (_req, res) => {
    const { free, supporter } = plans.limits;
    res.json({
      packsAlwaysFree: true,
      plans: {
        free: { dailyLines: free.dailyLines, newGamesPerDay: free.dailyBuilds },
        supporter: { dailyLines: supporter.dailyLines, monthlyStrings: supporter.monthlyStrings, boostsPerMonth: supporter.boostsPerMonth },
      },
      checkout: { monthly: checkout(env.CHECKOUT_URL_MONTHLY), yearly: checkout(env.CHECKOUT_URL_YEARLY) },
    });
  });

  api.get('/me/plan', requireUser, route((req) => plans.summary(req.user)));

  api.post('/me/plan/redeem', requireUser, redeemLimiter, redeemUserLimiter, route((req, res) => {
    if (wrongCodes.blocked(req.user.id)) {
      res.status(429);
      return { error: 'Too many wrong codes. Try again in an hour.', code: 'too-many' };
    }
    try {
      const done = plans.redeem(req.user, req.body?.code);
      wrongCodes.clear(req.user.id);
      return { ...done, summary: plans.summary(req.user) };
    } catch (err) {
      if (err instanceof PlanError && err.code === 'bad-code') wrongCodes.hit(req.user.id);
      throw err;
    }
  }));

  // Boosts: supporters push a requested game up the queue. Its Arabic is free for everyone once made.
  api.post('/arabic/boosts', requireUser, boostLimiter, route((req) => plans.boost(req.user, req.body?.game, req.body?.tokens ?? 1)));

  // ---- Admin Panel → Supporters & codes ----
  api.get('/admin/plans', requireAdmin, route(() => ({ batches: plans.batches(), supporters: plans.supporters() })));
  api.post('/admin/plans/codes', requireAdmin, route((req, res) => {
    res.status(201);
    return plans.createCodes(req.user, req.body || {});
  }));
  api.post('/admin/plans/codes/:batch/revoke', requireAdmin, route((req) => plans.revokeBatch(req.params.batch)));
  api.post('/admin/plans/grant', requireAdmin, route((req) => {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(String(req.body?.username || '').trim().toLowerCase());
    if (!user) throw new PlanError('No player has that username.', 404);
    const days = Number(req.body?.days);
    if (!Number.isInteger(days) || days < 1 || days > 3660) throw new PlanError('Give 1 to 3660 days.');
    return plans.grant(user.id, { days, source: 'admin' });
  }));

  // ---- Payment webhooks (Stripe, LemonSqueezy): signed, checked, handled once ----
  api.post('/billing/webhook', webhookLimiter, (req, res, next) => {
    try {
      res.json(billing.handle(req.rawBody ?? '', req.headers));
    } catch (err) {
      if (err instanceof BillingError || err instanceof PlanError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });
}

module.exports = { mountPlanRoutes };
