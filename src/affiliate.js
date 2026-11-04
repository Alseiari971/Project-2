// Store affiliate links: GameShelf's own outbound "Buy" links to a store we
// have an affiliate account with get its ID added, and are marked sponsored
// (rel="noopener noreferrer sponsored" on the page). Only these https store
// hosts are ever changed, and only by adding one query parameter; every
// other link is left exactly as it was. IDs come from the environment:
//
//   AFFILIATE_GOG_ID            gog.com              (parameter AFFILIATE_GOG_PARAM, default "pp")
//   AFFILIATE_HUMBLE_ID         humblebundle.com     (AFFILIATE_HUMBLE_PARAM, default "partner")
//   AFFILIATE_FANATICAL_ID      fanatical.com        (AFFILIATE_FANATICAL_PARAM, default "ref")
//   AFFILIATE_GMG_ID            greenmangaming.com   (AFFILIATE_GMG_PARAM, default "tap_a")
//   AFFILIATE_EPIC_CREATOR_CODE store.epicgames.com  (AFFILIATE_EPIC_PARAM, default "epic_creator_id")
//
// Check each program's dashboard for its exact parameter name; set the
// *_PARAM setting if it differs.
const STORES = [
  { host: 'gog.com', id: 'AFFILIATE_GOG_ID', param: 'AFFILIATE_GOG_PARAM', fallback: 'pp' },
  { host: 'humblebundle.com', id: 'AFFILIATE_HUMBLE_ID', param: 'AFFILIATE_HUMBLE_PARAM', fallback: 'partner' },
  { host: 'fanatical.com', id: 'AFFILIATE_FANATICAL_ID', param: 'AFFILIATE_FANATICAL_PARAM', fallback: 'ref' },
  { host: 'greenmangaming.com', id: 'AFFILIATE_GMG_ID', param: 'AFFILIATE_GMG_PARAM', fallback: 'tap_a' },
  { host: 'store.epicgames.com', id: 'AFFILIATE_EPIC_CREATOR_CODE', param: 'AFFILIATE_EPIC_PARAM', fallback: 'epic_creator_id' },
];
const SAFE_VALUE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_PARAM = /^[a-z_][a-z0-9_]{0,31}$/;

const hostMatches = (hostname, host) => hostname === host || hostname.endsWith(`.${host}`);

/**
 * { url, sponsored } for an outbound link. Only https links to the stores above
 * change, and only when their ID is set (and looks like an ID).
 */
function affiliateLink(link, env = process.env) {
  let url;
  try {
    url = new URL(String(link));
  } catch {
    return { url: link, sponsored: false };
  }
  if (url.protocol !== 'https:' || url.username || url.password) return { url: link, sponsored: false };
  const store = STORES.find((s) => hostMatches(url.hostname, s.host));
  const id = store && env[store.id];
  const param = store && (env[store.param] || store.fallback);
  if (!store || !id || !SAFE_VALUE.test(id) || !SAFE_PARAM.test(param)) return { url: link, sponsored: false };
  url.searchParams.set(param, id);
  return { url: url.href, sponsored: true };
}

/** A game's buy links ({ links: [{ url, ... }] }) with affiliate IDs added where set. */
function withAffiliates(buy, env = process.env) {
  if (!buy?.links) return buy;
  return { ...buy, links: buy.links.map((l) => ({ ...l, ...affiliateLink(l.url, env) })) };
}

module.exports = { affiliateLink, withAffiliates, AFFILIATE_STORES: STORES.map((s) => s.host) };
