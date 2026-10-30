// The main color of a picture, for tinting the page around it (like a TV
// app's home screen takes on the colors of the show in focus). Steam's and
// IGDB's image servers allow this; anything else simply gives no color.

const cache = new Map();
const SIZE = 24;

/** Resolves to [r, g, b], or null when the picture can't be read. */
export function artColor(url) {
  if (!url) return Promise.resolve(null);
  if (!cache.has(url)) cache.set(url, read(url));
  return cache.get(url);
}

function read(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        resolve(vivid(ctx.getImageData(0, 0, SIZE, SIZE).data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// An average that favors colorful, mid-bright pixels, so a mostly dark
// picture with an orange sky gives orange rather than brown-grey.
function vivid(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [pr, pg, pb] = [data[i], data[i + 1], data[i + 2]];
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const saturation = max ? (max - min) / max : 0;
    const light = max / 255;
    const w = 0.05 + saturation * saturation * (light > 0.15 && light < 0.95 ? 1 : 0.2);
    r += pr * w;
    g += pg * w;
    b += pb * w;
    weight += w;
  }
  if (!weight) return null;
  // Bring it to a steady brightness so every game tints the page about as much.
  const color = [r / weight, g / weight, b / weight];
  const peak = Math.max(...color) || 1;
  return color.map((c) => Math.round(Math.min(255, (c / peak) * 200)));
}
