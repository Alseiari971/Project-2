// What happens between the capture and the overlay for one game, with no
// Electron in it (so it can be tested on its own):
//
// - read(image): a new subtitle has settled. OCR it, look the English up, and
//   show the Arabic, or hide the overlay when nothing matches. If another read
//   arrives while OCR is busy, only the newest waits; anything in between is
//   skipped.
// - clear(): the subtitle is gone. Hide at once, and drop any OCR answer still
//   on its way, since it belongs to text that's no longer there.
//
// Boxes from OCR are turned into shares of the game window, so the overlay
// can sit the Arabic right where the English was.
function createSubtitleSession({ recognize, match, show, hide, log = () => {} }) {
  let generation = 0;
  let pending = null;
  let busy = false;
  let showing = false;
  let closed = false;
  const stats = { reads: 0, matches: 0, misses: 0, errors: 0, lastOcrMs: null };

  // OCR boxes are in the OCR image's pixels; image.crop says where that image
  // sits in the window: { x, y, width, height, scale, frameWidth, frameHeight,
  // windowRect: [x, y, w, h] as shares of the frame }.
  function windowBox(lines, crop) {
    const boxes = lines.map((l) => l.box).filter((b) => b && b.w > 0 && b.h > 0);
    if (!boxes.length || !crop) return null;
    const left = Math.min(...boxes.map((b) => b.x));
    const top = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.w));
    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
    const [wx, wy, ww, wh] = crop.windowRect || [0, 0, 1, 1];
    const toWindowX = (px) => ((crop.x + px * crop.scale) / crop.frameWidth - wx) / ww;
    const toWindowY = (px) => ((crop.y + px * crop.scale) / crop.frameHeight - wy) / wh;
    const x = toWindowX(left);
    const y = toWindowY(top);
    return { x, y, w: toWindowX(right) - x, h: toWindowY(bottom) - y };
  }

  async function run() {
    busy = true;
    while (pending && !closed) {
      const job = pending;
      pending = null;
      let result;
      const started = Date.now();
      try {
        result = await recognize(job.image.bmp);
      } catch (err) {
        stats.errors++;
        log(`OCR failed: ${err.message}`);
        continue;
      }
      stats.lastOcrMs = result.ms ?? Date.now() - started;
      if (job.generation !== generation || closed) continue; // a newer read or a clear came in
      const text = result.lines.map((l) => l.text).join(' ').trim();
      const found = text ? match(text) : null;
      if (found) {
        stats.matches++;
        showing = true;
        show({ arabic: found.arabic, score: found.score, box: windowBox(result.lines, job.image.crop) });
      } else {
        stats.misses++;
        if (showing) {
          showing = false;
          hide();
        }
      }
    }
    busy = false;
  }

  return {
    read(image) {
      if (closed) return;
      stats.reads++;
      generation++;
      pending = { image, generation };
      if (!busy) run();
    },
    clear() {
      generation++;
      pending = null;
      if (showing) {
        showing = false;
        hide();
      }
    },
    close() {
      closed = true;
      pending = null;
    },
    get busy() {
      return busy;
    },
    stats,
  };
}

module.exports = { createSubtitleSession };
