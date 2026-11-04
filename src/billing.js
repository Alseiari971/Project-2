// Payment webhooks: POST /api/billing/webhook (Stripe or LemonSqueezy).
//
// Nothing is trusted until its signature checks out with the provider's
// webhook secret (STRIPE_WEBHOOK_SECRET, LEMONSQUEEZY_WEBHOOK_SECRET):
//   - Stripe: header Stripe-Signature "t=<unix>,v1=<hex>": HMAC-SHA256 of
//     "<t>.<raw body>", within 5 minutes of now.
//   - LemonSqueezy: header X-Signature "<hex>": HMAC-SHA256 of the raw body.
// Comparisons are constant-time. Each event is handled once (billing_events),
// so a replayed or retried webhook changes nothing the second time.
//
// The player is named by the checkout: Stripe's client_reference_id (or
// metadata.gameshelf_user_id), LemonSqueezy's custom_data.user_id. Payment
// only ever changes the Supporter plan; Arabic packs never depend on it.
const crypto = require('node:crypto');

class BillingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Stripe's signature check (https://docs.stripe.com/webhooks#verify-manually). */
function verifyStripe(raw, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (!secret) throw new BillingError('Stripe webhooks aren\'t set up (STRIPE_WEBHOOK_SECRET).', 503);
  const parts = String(header || '').split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isInteger(t) || !signatures.length) throw new BillingError('The webhook isn\'t signed.', 401);
  if (Math.abs(now / 1000 - t) > toleranceSec) throw new BillingError('The webhook is too old or from the future.', 401);
  const expected = hmacHex(secret, `${t}.${raw}`);
  if (!signatures.some((s) => sameHex(s, expected))) throw new BillingError('The webhook\'s signature doesn\'t match.', 401);
}

/** LemonSqueezy's signature check (https://docs.lemonsqueezy.com/help/webhooks/signing-requests). */
function verifyLemonSqueezy(raw, header, secret) {
  if (!secret) throw new BillingError('LemonSqueezy webhooks aren\'t set up (LEMONSQUEEZY_WEBHOOK_SECRET).', 503);
  if (!header) throw new BillingError('The webhook isn\'t signed.', 401);
  if (!sameHex(header, hmacHex(secret, raw))) throw new BillingError('The webhook\'s signature doesn\'t match.', 401);
}

const secondsToMs = (s) => (Number(s) > 0 ? Number(s) * 1000 : null);
const isoToMs = (s) => (Number.isFinite(Date.parse(s || '')) ? Date.parse(s) : null);

function createBilling({ db, plans, env = process.env, now = () => Date.now() }) {
  const q = {
    seen: db.prepare('SELECT 1 FROM billing_events WHERE event_id = ?'),
    save: db.prepare('INSERT INTO billing_events (event_id, provider, type, user_id, received_at) VALUES (?, ?, ?, ?, ?)'),
    user: db.prepare('SELECT id FROM users WHERE id = ?'),
  };
  const userId = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 && q.user.get(id) ? id : null;
  };

  function stripeEvent(event) {
    const o = event?.data?.object || {};
    const meta = o.metadata || o.subscription_details?.metadata || {};
    const external = o.subscription || (o.object === 'subscription' ? o.id : null) || o.customer || null;
    const user = userId(o.client_reference_id) || userId(meta.gameshelf_user_id) || plans.userForExternal(external);
    switch (event.type) {
      case 'checkout.session.completed':
        if (o.payment_status && o.payment_status !== 'paid' && o.payment_status !== 'no_payment_required') return { user, action: 'ignored' };
        if (!user) return { user, action: 'no-user' };
        // A one-off payment: 31 days; a subscription's own period comes with invoice.paid.
        plans.grant(user, { days: Number(meta.days) || 31, source: 'stripe', externalId: external });
        return { user, action: 'granted' };
      case 'invoice.paid': {
        if (!user) return { user, action: 'no-user' };
        const end = secondsToMs(o.lines?.data?.[0]?.period?.end) || secondsToMs(o.period_end);
        plans.grant(user, end ? { until: end, source: 'stripe', externalId: external } : { days: 31, source: 'stripe', externalId: external });
        return { user, action: 'renewed' };
      }
      case 'customer.subscription.deleted':
        if (!user) return { user, action: 'no-user' };
        plans.setStatus(user, 'canceled');
        return { user, action: 'canceled' };
      default:
        return { user, action: 'ignored' };
    }
  }

  function lemonEvent(event) {
    const name = event?.meta?.event_name;
    const a = event?.data?.attributes || {};
    const external = event?.data?.id ? `ls:${event.data.id}` : null;
    const user = userId(event?.meta?.custom_data?.user_id) || plans.userForExternal(external);
    if (!user) return { user, action: 'no-user' };
    switch (name) {
      case 'order_created':
        if (a.status && a.status !== 'paid') return { user, action: 'ignored' };
        plans.grant(user, { days: Number(event.meta.custom_data.days) || 31, source: 'lemonsqueezy', externalId: external });
        return { user, action: 'granted' };
      case 'subscription_created':
      case 'subscription_updated':
      case 'subscription_resumed':
      case 'subscription_payment_success': {
        if (!['active', 'on_trial', 'paid'].includes(a.status) && name !== 'subscription_payment_success') return { user, action: 'ignored' };
        const end = isoToMs(a.renews_at) || isoToMs(a.ends_at);
        plans.grant(user, end ? { until: end, source: 'lemonsqueezy', externalId: external } : { days: 31, source: 'lemonsqueezy', externalId: external });
        return { user, action: 'renewed' };
      }
      case 'subscription_cancelled':
        plans.setStatus(user, 'canceled');
        return { user, action: 'canceled' };
      case 'subscription_expired':
        plans.setStatus(user, 'expired');
        return { user, action: 'expired' };
      default:
        return { user, action: 'ignored' };
    }
  }

  /** Checks and applies one webhook. `raw` is the exact body bytes as text; `headers` lower-case. */
  function handle(raw, headers) {
    const text = String(raw ?? '');
    let provider;
    if (headers['stripe-signature']) {
      verifyStripe(text, headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET, { now: now() });
      provider = 'stripe';
    } else if (headers['x-signature']) {
      verifyLemonSqueezy(text, headers['x-signature'], env.LEMONSQUEEZY_WEBHOOK_SECRET);
      provider = 'lemonsqueezy';
    } else {
      throw new BillingError('The webhook isn\'t signed.', 401);
    }
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      throw new BillingError('The webhook isn\'t JSON.');
    }
    const id = provider === 'stripe' ? String(event.id || '') : `ls:${crypto.createHash('sha256').update(text).digest('hex')}`;
    if (!id) throw new BillingError('The webhook has no event id.');
    if (q.seen.get(id)) return { ok: true, duplicate: true };
    const result = provider === 'stripe' ? stripeEvent(event) : lemonEvent(event);
    q.save.run(id, provider, String(provider === 'stripe' ? event.type : event.meta?.event_name || ''), result.user, now());
    return { ok: true, provider, ...result };
  }

  return { handle };
}

module.exports = { createBilling, verifyStripe, verifyLemonSqueezy, BillingError };
