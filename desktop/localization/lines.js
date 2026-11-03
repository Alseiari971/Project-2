// A game's English lines and their Arabic, as its last build on this PC wrote
// them (translations.csv, see the pack builder), for "Report a translation
// issue": the player finds the line instead of typing it out.
const fs = require('node:fs/promises');

/** Rows of a CSV file as the pack builder writes it (Python's csv module: quotes, "" inside them, CRLF, a BOM). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** [{ english, arabic }] from a translations.csv (lines without Arabic left out), or [] when there's none. */
async function readLines(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const [header = [], ...rows] = parseCsv(text);
  const source = header.indexOf('source');
  const arabic = header.indexOf('arabic');
  if (source < 0 || arabic < 0) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const english = row[source];
    if (!english || !row[arabic] || seen.has(english)) continue;
    seen.add(english);
    out.push({ english, arabic: row[arabic] });
  }
  return out;
}

/** The lines whose English or Arabic has `query` in it (letter case aside), up to `limit`. */
function search(lines, query, limit = 30) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return lines.slice(0, limit);
  return lines.filter((l) => l.english.toLowerCase().includes(needle) || l.arabic.includes(query.trim())).slice(0, limit);
}

module.exports = { parseCsv, readLines, search };
