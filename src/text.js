// Normalizes a game title for comparison: "DOOM® Eternal" and "Doom Eternal" match.
const normalizeTitle = (name) =>
  String(name).toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

module.exports = { normalizeTitle };
