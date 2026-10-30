// The moving decoration behind the home page's spotlight: embers for Fright
// Night, snow for winter, stars for Ramadan, lanterns for Lunar New Year,
// sparkles for Eid and drifting light for summer. It's drawn on a canvas,
// stops while the page is hidden or scrolled away, and holds still for people
// who turn on "reduce motion".

const rand = (min, max) => min + Math.random() * (max - min);

// Each effect: how many particles per million pixels, how to make one, and how to move and draw it.
const EFFECTS = {
  embers: {
    density: 60,
    make: (w, h, fresh) => ({ x: rand(0, w), y: fresh ? h + rand(0, 40) : rand(0, h), r: rand(0.8, 2.4), vy: rand(-0.6, -0.2), vx: rand(-0.15, 0.15), life: rand(0, Math.PI * 2) }),
    step: (p) => { p.y += p.vy; p.x += p.vx + Math.sin(p.life) * 0.25; p.life += 0.03; },
    gone: (p) => p.y < -10,
    draw: (ctx, p) => {
      ctx.fillStyle = `rgba(255, ${120 + Math.round(Math.sin(p.life) * 40)}, 40, ${0.45 + Math.sin(p.life * 1.7) * 0.3})`;
      ctx.shadowColor = 'rgba(255, 110, 20, 0.9)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  snow: {
    density: 110,
    make: (w, h, fresh) => ({ x: rand(0, w), y: fresh ? rand(-30, -5) : rand(0, h), r: rand(0.8, 2.8), vy: rand(0.25, 0.9), sway: rand(0, Math.PI * 2) }),
    step: (p) => { p.y += p.vy; p.sway += 0.012; p.x += Math.sin(p.sway) * 0.35; },
    gone: (p, w, h) => p.y > h + 10,
    draw: (ctx, p) => {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.35 + p.r / 5})`;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  stars: {
    density: 90,
    make: (w, h) => ({ x: rand(0, w), y: rand(0, h * 0.75), r: rand(0.5, 1.6), t: rand(0, Math.PI * 2), speed: rand(0.01, 0.04) }),
    step: (p) => { p.t += p.speed; },
    gone: () => false,
    draw: (ctx, p) => {
      ctx.fillStyle = `rgba(255, 236, 190, ${0.25 + (Math.sin(p.t) + 1) * 0.35})`;
      ctx.shadowColor = 'rgba(255, 220, 150, 0.8)';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  lanterns: {
    density: 14,
    make: (w, h, fresh) => ({ x: rand(0, w), y: fresh ? h + rand(20, 80) : rand(0, h), s: rand(7, 15), vy: rand(-0.45, -0.15), sway: rand(0, Math.PI * 2) }),
    step: (p) => { p.y += p.vy; p.sway += 0.01; p.x += Math.sin(p.sway) * 0.2; },
    gone: (p) => p.y < -40,
    draw: (ctx, p) => {
      ctx.shadowColor = 'rgba(255, 90, 40, 0.9)';
      ctx.shadowBlur = 18;
      ctx.fillStyle = 'rgba(232, 52, 38, 0.85)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.s * 0.8, p.s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 201, 74, 0.9)';
      ctx.fillRect(p.x - p.s * 0.45, p.y - p.s - 2, p.s * 0.9, 3);
      ctx.fillRect(p.x - p.s * 0.45, p.y + p.s - 1, p.s * 0.9, 3);
    },
  },
  sparkles: {
    density: 40,
    make: (w, h) => ({ x: rand(0, w), y: rand(0, h), s: rand(2, 5), t: rand(0, Math.PI * 2), speed: rand(0.02, 0.05), vy: rand(-0.15, -0.05) }),
    step: (p) => { p.t += p.speed; p.y += p.vy; },
    gone: (p) => p.y < -10,
    draw: (ctx, p) => {
      const a = Math.max(0, Math.sin(p.t));
      const s = p.s * (0.5 + a * 0.5);
      ctx.fillStyle = `rgba(255, 214, 120, ${a * 0.9})`;
      ctx.shadowColor = 'rgba(255, 210, 110, 0.9)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - s * 2);
      ctx.quadraticCurveTo(p.x, p.y, p.x + s * 2, p.y);
      ctx.quadraticCurveTo(p.x, p.y, p.x, p.y + s * 2);
      ctx.quadraticCurveTo(p.x, p.y, p.x - s * 2, p.y);
      ctx.quadraticCurveTo(p.x, p.y, p.x, p.y - s * 2);
      ctx.fill();
    },
  },
  motes: {
    density: 35,
    make: (w, h, fresh) => ({ x: fresh ? -10 : rand(0, w), y: rand(0, h), r: rand(1.5, 4), vx: rand(0.1, 0.35), t: rand(0, Math.PI * 2) }),
    step: (p) => { p.x += p.vx; p.t += 0.02; p.y += Math.sin(p.t) * 0.15; },
    gone: (p, w) => p.x > w + 10,
    draw: (ctx, p) => {
      ctx.fillStyle = `rgba(255, 196, 92, ${0.15 + (Math.sin(p.t) + 1) * 0.15})`;
      ctx.shadowColor = 'rgba(255, 170, 60, 0.8)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    },
  },
};

const MAX_PARTICLES = 140;

/** Starts the effect on `canvas`; returns a function that stops it. */
export function startSeasonFx(canvas, name) {
  const effect = EFFECTS[name];
  if (!effect || !canvas.getContext) return () => {};
  const ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0;
  let h = 0;
  let particles = [];
  let frame = 0;
  let visible = true;
  let stopped = false;

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.min(MAX_PARTICLES, Math.round((w * h) / 1e6 * effect.density));
    particles = Array.from({ length: count }, () => effect.make(w, h, false));
  };

  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) effect.draw(ctx, p);
  };

  const tick = () => {
    frame = 0;
    if (stopped || !visible || document.hidden) return;
    particles = particles.map((p) => {
      effect.step(p);
      return effect.gone(p, w, h) ? effect.make(w, h, true) : p;
    });
    draw();
    frame = requestAnimationFrame(tick);
  };
  const run = () => {
    if (!still && !frame && visible && !document.hidden && !stopped) frame = requestAnimationFrame(tick);
  };

  const sizer = new ResizeObserver(() => {
    resize();
    draw();
  });
  sizer.observe(canvas);
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    run();
  });
  watcher.observe(canvas);
  document.addEventListener('visibilitychange', run);

  resize();
  draw();
  run();

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    sizer.disconnect();
    watcher.disconnect();
    document.removeEventListener('visibilitychange', run);
  };
}
