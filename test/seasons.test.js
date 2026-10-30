const { test } = require('node:test');
const assert = require('node:assert/strict');
const { seasonPlan, SEASON_IDS } = require('../src/seasons');
const { microtrailer } = require('../src/steam-store');

test('every season has sections, and unknown seasons fall back to the default', () => {
  for (const id of SEASON_IDS) assert.ok(seasonPlan(id).sections.length > 0, id);
  assert.equal(seasonPlan('nope').id, 'default');
});

test('winter looks back on this year, or on last year in early January', () => {
  const december = seasonPlan('winter', new Date(2026, 11, 20));
  assert.equal(december.sections[0].title, 'The best of 2026');
  assert.equal(december.spotlight.year, 2026);
  const january = seasonPlan('winter', new Date(2027, 0, 3));
  assert.equal(january.sections[0].title, 'The best of 2026');
  assert.equal(january.sections[0].query.year, 2026);
});

test('the microtrailer sits next to the trailer stream on Steam', () => {
  const base = 'https://video.akamai.steamstatic.com/store_trailers/1245620/468143/7a6be/1750650501';
  assert.equal(microtrailer([
    { id: 1, hls_h264: 'https://video.akamai.steamstatic.com/store_trailers/1/2/3/4/hls_264_master.m3u8?t=1' },
    { id: 2, highlight: true, hls_h264: `${base}/hls_264_master.m3u8?t=1716311566`, dash_h264: `${base}/dash_h264.mpd` },
  ]), `${base}/microtrailer.webm`);
  assert.equal(microtrailer([{ dash_av1: 'https://evil.example.com/a/dash_av1.mpd' }]), null);
  assert.equal(microtrailer(undefined), null);
});
