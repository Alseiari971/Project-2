// Decides, a few times a second, whether the subtitle area needs reading, so
// OCR only runs when a new subtitle has settled on screen:
//
// - Each tick gets the brightness (luma) of the subtitle area. Subtitles are
//   drawn as bright text (or dark, for games that use dark text), so the
//   pixels past a brightness line form a "text mask". Moving scenery behind
//   the text barely changes that mask; a new line of dialogue changes it a lot.
// - A sparse grid of samples (24,000 at most) keeps each tick well under a
//   millisecond.
// - "read": the mask changed and has now held still for one tick (so a
//   subtitle typing itself out or fading in isn't read halfway), and it isn't
//   the mask that was read last.
// - "clear": the text pixels are gone, so the Arabic is hidden straight away,
//   without OCR.
//
// Also here: turning the area into the black-on-white picture OCR reads best,
// as an uncompressed BMP. This file runs in the capture window (as a plain
// script) and in Node (for the tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameShelfFrames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULTS = {
    textLuma: 170,      // brighter than this is text (darker, with darkText)
    darkText: false,
    minText: 0.002,     // less text than this share of the area: no subtitle
    maxText: 0.5,       // more: a bright scene or a flash, not a subtitle
    changeRatio: 0.12,  // masks differing by more than this are different text
    stableTicks: 1,     // ticks the mask must hold still before it's read
    maxSamples: 24000,
  };

  function createDetector(options = {}) {
    const o = { ...DEFAULTS, ...options };
    let previous = null;
    let lastRead = null;
    let stable = 0;
    let showing = false;

    function mask(luma, width, height) {
      const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / o.maxSamples)));
      const columns = Math.ceil(width / step);
      const rows = Math.ceil(height / step);
      const bits = new Uint8Array(columns * rows);
      let count = 0;
      let k = 0;
      for (let y = 0; y < height; y += step) {
        const row = y * width;
        for (let x = 0; x < width; x += step) {
          const v = luma[row + x];
          const on = o.darkText ? v <= o.textLuma : v >= o.textLuma;
          if (on) {
            bits[k] = 1;
            count++;
          }
          k++;
        }
      }
      return { bits, count, width, height };
    }

    // The share of text pixels that differ between two masks.
    function difference(a, b) {
      if (!a || !b || a.width !== b.width || a.height !== b.height) return 1;
      let differing = 0;
      for (let i = 0; i < a.bits.length; i++) differing += a.bits[i] ^ b.bits[i];
      return differing / Math.max(1, a.count, b.count);
    }

    return {
      /** Feeds one tick. Returns { action: 'none' | 'read' | 'clear', text, change }. */
      push(luma, width, height) {
        const current = mask(luma, width, height);
        const text = current.count / current.bits.length;
        if (text < o.minText || text > o.maxText) {
          previous = current;
          lastRead = null;
          stable = 0;
          const action = showing ? 'clear' : 'none';
          showing = false;
          return { action, text, change: 0 };
        }
        const change = difference(current, previous);
        stable = change <= o.changeRatio ? stable + 1 : 0;
        previous = current;
        if (stable >= o.stableTicks && difference(current, lastRead) > o.changeRatio) {
          lastRead = current;
          showing = true;
          return { action: 'read', text, change };
        }
        return { action: 'none', text, change };
      },
      reset() {
        previous = null;
        lastRead = null;
        stable = 0;
        showing = false;
      },
    };
  }

  /**
   * The picture OCR gets: text black on white (bright text is darkened with a
   * short ramp so letter edges stay smooth), halved when wider than 2560 pixels.
   * Returns { pixels, width, height, scale }.
   */
  function ocrImage(luma, width, height, { textLuma = DEFAULTS.textLuma, darkText = false } = {}) {
    const scale = width > 2560 ? 2 : 1;
    const w = Math.floor(width / scale);
    const h = Math.floor(height / scale);
    const pixels = new Uint8Array(w * h);
    const ramp = 48;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = luma[y * scale * width + x * scale];
        if (darkText) {
          pixels[y * w + x] = v;
          continue;
        }
        if (v >= textLuma) v = 0;
        else if (v >= textLuma - ramp) v = Math.round(255 * ((textLuma - v) / ramp));
        else v = 255;
        pixels[y * w + x] = v;
      }
    }
    return { pixels, width: w, height: h, scale };
  }

  /** An 8-bit greyscale BMP (top-down rows), which Windows decodes without any library. */
  function grayBmp(pixels, width, height) {
    const rowSize = (width + 3) & ~3;
    const offset = 14 + 40 + 1024;
    const size = offset + rowSize * height;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out[0] = 0x42; // B
    out[1] = 0x4d; // M
    view.setUint32(2, size, true);
    view.setUint32(10, offset, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, -height, true); // negative: rows run top to bottom
    view.setUint16(26, 1, true);
    view.setUint16(28, 8, true);
    view.setUint32(34, rowSize * height, true);
    view.setInt32(38, 2835, true);
    view.setInt32(42, 2835, true);
    view.setUint32(46, 256, true);
    view.setUint32(50, 256, true);
    for (let i = 0; i < 256; i++) {
      out[54 + i * 4] = i;
      out[55 + i * 4] = i;
      out[56 + i * 4] = i;
    }
    for (let y = 0; y < height; y++) out.set(pixels.subarray(y * width, (y + 1) * width), offset + y * rowSize);
    return out;
  }

  /**
   * Luma for a VideoFrame's area, read straight from the frame's own pixels:
   * the Y plane of YUV frames, or a weighted sum of RGB. Returns null for
   * formats it can't read (the caller then draws the frame to a canvas).
   */
  async function frameLuma(frame, rect) {
    const format = frame.format;
    const yuv = ['I420', 'I420A', 'I422', 'I444', 'NV12'].includes(format);
    const rgb = ['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(format);
    if (!yuv && !rgb) return null;
    const { width, height } = rect;
    if (yuv) {
      const buffer = new Uint8Array(frame.allocationSize({ rect }));
      const layout = await frame.copyTo(buffer, { rect });
      const { offset, stride } = layout[0];
      const luma = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) luma.set(buffer.subarray(offset + y * stride, offset + y * stride + width), y * width);
      return luma;
    }
    const buffer = new Uint8Array(frame.allocationSize({ rect }));
    const [{ offset, stride }] = await frame.copyTo(buffer, { rect });
    const red = format.startsWith('BGR') ? 2 : 0;
    const blue = 2 - red;
    const luma = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      let p = offset + y * stride;
      for (let x = 0; x < width; x++, p += 4) luma[y * width + x] = (buffer[p + red] * 77 + buffer[p + 1] * 150 + buffer[p + blue] * 29) >> 8;
    }
    return luma;
  }

  /** Luma from canvas RGBA data (the fallback path). */
  function rgbaLuma(data, width, height) {
    const luma = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) luma[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    return luma;
  }

  /**
   * The subtitle area in frame pixels. `region` is [x, y, width, height] as
   * shares of the game window; `windowRect` is where the window sits in the
   * frame (shares too), for when a whole screen is captured. Even numbers,
   * since YUV frames can only be cropped on even pixels.
   */
  function cropRect(frameWidth, frameHeight, region, windowRect = [0, 0, 1, 1]) {
    const [wx, wy, ww, wh] = windowRect;
    const [rx, ry, rw, rh] = region;
    const even = (n) => Math.max(0, Math.floor(n / 2) * 2);
    const x = even((wx + rx * ww) * frameWidth);
    const y = even((wy + ry * wh) * frameHeight);
    const width = Math.min(even(rw * ww * frameWidth), even(frameWidth - x));
    const height = Math.min(even(rh * wh * frameHeight), even(frameHeight - y));
    return { x, y, width, height };
  }

  return { DEFAULTS, createDetector, ocrImage, grayBmp, frameLuma, rgbaLuma, cropRect };
});
