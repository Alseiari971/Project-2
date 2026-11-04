// GameShelf's plans: Free ("مجاني") and Supporter ("داعم GameShelf").
//
// THE RULE: every finished Arabic pack is free for everyone, forever: to
// download, install, and switch on or off. Nothing here is ever checked
// before a pack is served. What a plan changes is only:
//   - cloud AI translation compute (how many new lines the server's AI
//     translates for you, how many new games a day, and queue priority),
//   - boost tokens for pushing requested games up the queue,
//   - the desktop app's Subtitle Studio (font, size, color, background),
//   - profile cosmetics (the داعم badge) and priority support.
//
// Quotas are counted in compute_ledger; plans live in user_subscriptions;
// prepaid / gift codes in gift_codes (only hashes, like passwords).
const crypto = require('node:crypto');

class PlanError extends Error {
  constructor(message, status = 400, code = 'plan') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const DAY = 24 * 60 * 60 * 1000;
const STUDIO_FONTS = ['cairo', 'tajawal', 'amiri', 'ibm-plex-sans-arabic'];

const num = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

/** What each plan allows (from the environment, see deploy/gameshelf.env.example). */
function planLimits(env = process.env) {
  return {
    free: {
      dailyLines: num(env.TRANSLATE_DAILY_LINES, 2000),
      monthlyStrings: null,
      dailyBuilds: num(env.FREE_DAILY_BUILDS, 1),
      priority: 0,
      boostsPerMonth: 0,
      subtitleStudio: false,
      prioritySupport: false,
    },
    supporter: {
      dailyLines: num(env.SUPPORTER_DAILY_LINES, 30000),
      monthlyStrings: num(env.SUPPORTER_MONTHLY_STRINGS, 150000),
      dailyBuilds: null,
      priority: 1,
      boostsPerMonth: num(env.SUPPORTER_MONTHLY_BOOSTS, 5),
      subtitleStudio: true,
      prioritySupport: true,
    },
  };
}

/** A new code: XXXX-XXXX-XXXX from 32 letters and digits (60 bits). */
function newCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
const normalizeCode = (text) => {
  const raw = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 12 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}` : '';
};
const codeHash = (code) => crypto.createHash('sha256').update(`gameshelf-code:${code}`).digest('hex');

function createPlans({ db, env = process.env, now = () => Date.now() } = {}) {
  const limits = planLimits(env);
  const q = {
    sub: db.prepare('SELECT * FROM user_subscriptions WHERE user_id = ?'),
    upsert: db.prepare(`INSERT INTO user_subscriptions (user_id, plan, status, source, external_id, period_end, created_at, updated_at)
      VALUES (@user, @plan, @status, @source, @external, @end, @now, @now)
      ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, source = excluded.source,
        external_id = COALESCE(excluded.external_id, user_subscriptions.external_id), period_end = excluded.period_end, updated_at = excluded.updated_at`),
    setStatus: db.prepare('UPDATE user_subscriptions SET status = ?, updated_at = ? WHERE user_id = ?'),
    byExternal: db.prepare('SELECT user_id FROM user_subscriptions WHERE external_id = ?'),
    spentSince: db.prepare("SELECT COALESCE(SUM(strings), 0) AS strings, COALESCE(SUM(chars), 0) AS chars FROM compute_ledger WHERE user_id = ? AND kind = 'translate' AND created_at >= ?"),
    gamesSince: db.prepare("SELECT DISTINCT game FROM compute_ledger WHERE user_id = ? AND kind = 'translate' AND created_at >= ?"),
    record: db.prepare('INSERT INTO compute_ledger (user_id, kind, game, strings, chars, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    boostsSince: db.prepare('SELECT COALESCE(SUM(tokens), 0) AS n FROM game_boosts WHERE user_id = ? AND created_at >= ?'),
    addBoost: db.prepare('INSERT INTO game_boosts (user_id, game, tokens, created_at) VALUES (?, ?, ?, ?)'),
    boostTotal: db.prepare('SELECT COALESCE(SUM(tokens), 0) AS n, COUNT(DISTINCT user_id) AS people FROM game_boosts WHERE game = ?'),
    requested: db.prepare('SELECT 1 FROM arabic_requests WHERE game = ? LIMIT 1'),
    insertCode: db.prepare('INSERT INTO gift_codes (code_hash, hint, plan, days, note, batch, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    code: db.prepare('SELECT * FROM gift_codes WHERE code_hash = ?'),
    useCode: db.prepare('UPDATE gift_codes SET redeemed_by = ?, redeemed_at = ? WHERE code_hash = ? AND redeemed_by IS NULL AND revoked = 0'),
    batches: db.prepare(`SELECT batch, MIN(note) AS note, MIN(days) AS days, COUNT(*) AS codes, SUM(redeemed_by IS NOT NULL) AS redeemed,
      SUM(revoked) AS revoked, MIN(created_at) AS created_at FROM gift_codes GROUP BY batch ORDER BY created_at DESC LIMIT 100`),
    revokeBatch: db.prepare('UPDATE gift_codes SET revoked = 1 WHERE batch = ? AND redeemed_by IS NULL'),
    supporters: db.prepare(`SELECT s.*, u.username, u.display_name FROM user_subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.plan = 'supporter' AND s.period_end > ? ORDER BY s.period_end DESC LIMIT 500`),
  };

  const monthStart = (t = now()) => {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  };
  const dayStart = (t = now()) => {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };

  /** The plan in force: 'supporter' while paid up (a cancelled one runs to its end), else 'free'. */
  function planOf(userId) {
    const s = userId ? q.sub.get(userId) : null;
    if (!s || s.plan !== 'supporter' || s.status === 'expired') return 'free';
    return s.period_end && s.period_end > now() ? 'supporter' : 'free';
  }
  const isSupporter = (userId) => planOf(userId) === 'supporter';

  function subscription(userId) {
    const s = q.sub.get(userId);
    const plan = planOf(userId);
    return {
      plan,
      status: s?.status || null,
      source: s?.source || null,
      until: plan === 'supporter' ? s.period_end : null,
      renews: plan === 'supporter' && s.status === 'active' && ['stripe', 'lemonsqueezy'].includes(s.source),
    };
  }

  /** Makes `userId` a supporter for `days` more (added to any time left), or until `until`. */
  function grant(userId, { days = 0, until = null, source = 'admin', externalId = null } = {}) {
    if (!userId) throw new PlanError('No such player.', 404);
    const current = q.sub.get(userId);
    const from = Math.max(now(), current?.plan === 'supporter' && current.status !== 'expired' ? current.period_end || 0 : 0);
    const end = until ? Math.max(until, now()) : from + Math.round(days * DAY);
    if (!(end > now())) throw new PlanError('That would end before it starts.');
    q.upsert.run({ user: userId, plan: 'supporter', status: 'active', source, external: externalId, end, now: now() });
    return subscription(userId);
  }

  /** A cancelled plan stays until its paid time runs out; an expired one ends now. */
  function setStatus(userId, status) {
    if (!['active', 'canceled', 'expired'].includes(status)) throw new PlanError('Unknown status.');
    q.setStatus.run(status, now(), userId);
    return subscription(userId);
  }

  const userForExternal = (externalId) => (externalId ? q.byExternal.get(String(externalId))?.user_id || null : null);

  // ---- Cloud AI translation compute ----

  /**
   * What `user` may ask the server's AI to translate for `game` right now:
   * { ok, reason, dailyLines (left today), maxLines (left this month), priority }.
   * Lines already in the shared memory are free and don't count.
   */
  function allowance(user, game) {
    const plan = planOf(user?.id);
    const l = limits[plan];
    const today = q.spentSince.get(user.id, dayStart());
    const month = q.spentSince.get(user.id, monthStart());
    const base = { plan, priority: l.priority, dailyLines: Math.max(0, l.dailyLines - today.strings), maxLines: l.monthlyStrings == null ? null : Math.max(0, l.monthlyStrings - month.strings) };
    if (l.dailyBuilds != null) {
      const games = q.gamesSince.all(user.id, dayStart()).map((r) => r.game);
      if (!games.includes(String(game)) && games.length >= l.dailyBuilds) {
        return { ...base, ok: false, code: 'build-limit', reason: 'You\'ve used today\'s new games for the free plan\'s AI. Come back tomorrow, or become a GameShelf Supporter for more. Finished Arabic packs are always free.' };
      }
    }
    if (base.dailyLines <= 0) return { ...base, ok: false, code: 'daily-limit', reason: 'You\'ve used today\'s AI translation. It resets at midnight (UTC). Finished Arabic packs are always free.' };
    if (base.maxLines !== null && base.maxLines <= 0) return { ...base, ok: false, code: 'monthly-limit', reason: 'You\'ve used this month\'s AI translation. It resets on the 1st. Finished Arabic packs are always free.' };
    return { ...base, ok: true };
  }

  function record(userId, game, strings, chars = 0) {
    if (strings > 0) q.record.run(userId, 'translate', String(game || ''), Math.round(strings), Math.round(chars), now());
  }

  // ---- Boost tokens ----

  function boostsLeft(userId) {
    const l = limits[planOf(userId)];
    const spent = q.boostsSince.get(userId, monthStart()).n;
    return { perMonth: l.boostsPerMonth, spent, left: Math.max(0, l.boostsPerMonth - spent) };
  }

  /** Spends `tokens` boosts on a requested game; the game's Arabic, once made, is free for everyone. */
  function boost(user, game, tokens = 1) {
    const n = Number(tokens);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new PlanError('Boost with 1 to 10 tokens at a time.');
    if (!/^(steam:\d{1,10}|game:[a-z0-9][a-z0-9-]{0,99})$/.test(String(game))) throw new PlanError('That isn\'t a game GameShelf knows.');
    if (!q.requested.get(String(game))) throw new PlanError('Only games players have asked Arabic for can be boosted.', 404);
    if (!isSupporter(user.id)) throw new PlanError('Boosts are a GameShelf Supporter perk.', 402, 'supporter-only');
    const { left } = boostsLeft(user.id);
    if (n > left) throw new PlanError(left ? 'You don\'t have that many boosts left this month.' : 'You\'ve used this month\'s boosts. New ones come on the 1st.', 429, 'no-boosts');
    q.addBoost.run(user.id, String(game), n, now());
    return { game: String(game), ...boostTotal(game), you: boostsLeft(user.id) };
  }

  const boostTotal = (game) => {
    const r = q.boostTotal.get(String(game));
    return { boosts: r.n, boosters: r.people };
  };

  // ---- Prepaid / gift codes ----

  /** Makes `count` codes for `days` of Supporter. The codes are shown once; only hashes are kept. */
  function createCodes(admin, { count = 1, days = 30, note = '' } = {}) {
    const n = Number(count);
    const d = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new PlanError('Make 1 to 500 codes at a time.');
    if (!Number.isInteger(d) || d < 1 || d > 3660) throw new PlanError('Codes give 1 to 3660 days.');
    const batch = `b${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const codes = [];
    db.exec('BEGIN');
    try {
      while (codes.length < n) {
        const code = newCode();
        if (q.code.get(codeHash(code))) continue;
        q.insertCode.run(codeHash(code), code.slice(-4), 'supporter', d, String(note).slice(0, 120), batch, admin?.id || null, now());
        codes.push(code);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { batch, days: d, note: String(note).slice(0, 120), codes };
  }

  /** Redeems a code for `user`: Supporter time added. Each code works once. */
  function redeem(user, text) {
    const code = normalizeCode(text);
    if (!CODE_RE.test(code)) throw new PlanError('Codes look like XXXX-XXXX-XXXX.');
    const hash = codeHash(code);
    const row = q.code.get(hash);
    if (!row || row.revoked) throw new PlanError('That code isn\'t valid.', 404, 'bad-code');
    if (row.redeemed_by) throw new PlanError('That code was already used.', 409, 'used-code');
    if (q.useCode.run(user.id, now(), hash).changes !== 1) throw new PlanError('That code was already used.', 409, 'used-code');
    return { days: row.days, ...grant(user.id, { days: row.days, source: 'code' }) };
  }

  const batches = () => q.batches.all().map((b) => ({ batch: b.batch, note: b.note, days: b.days, codes: b.codes, redeemed: b.redeemed, revoked: b.revoked, createdAt: b.created_at }));
  const revokeBatch = (batch) => ({ revoked: q.revokeBatch.run(String(batch)).changes });
  const supporters = () => q.supporters.all(now()).map((s) => ({ username: s.username, displayName: s.display_name, until: s.period_end, status: s.status, source: s.source }));

  /** Everything the Pricing page and the desktop app show about a player's plan. */
  function summary(user) {
    const plan = planOf(user.id);
    const l = limits[plan];
    const today = q.spentSince.get(user.id, dayStart());
    const month = q.spentSince.get(user.id, monthStart());
    return {
      ...subscription(user.id),
      perks: {
        supporterBadge: plan === 'supporter',
        subtitleStudio: l.subtitleStudio ? { fonts: STUDIO_FONTS, sizeMin: 80, sizeMax: 150, color: true, background: true } : null,
        prioritySupport: l.prioritySupport,
        priorityQueue: l.priority > 0,
      },
      compute: {
        today: { used: today.strings, limit: l.dailyLines },
        month: { used: month.strings, limit: l.monthlyStrings },
        newGamesToday: q.gamesSince.all(user.id, dayStart()).length,
        newGamesPerDay: l.dailyBuilds,
      },
      boosts: boostsLeft(user.id),
      // Said in every answer so no screen can forget it.
      packsAlwaysFree: true,
    };
  }

  return { planOf, isSupporter, subscription, grant, setStatus, userForExternal, allowance, record, boost, boostTotal, boostsLeft, createCodes, redeem, batches, revokeBatch, supporters, summary, limits };
}

module.exports = { createPlans, planLimits, PlanError, newCode, normalizeCode, CODE_RE, STUDIO_FONTS };
