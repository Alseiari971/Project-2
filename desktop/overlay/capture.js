// Watches the game's subtitle area: takes frames from the screen capture a
// few times a second, reads the brightness of just that area straight from
// the frame, and lets the change detector say when to read it (see
// ../localization/change-detector.js). Only then is a picture sent for OCR.
(() => {
  const { createDetector, ocrImage, grayBmp, frameLuma, rgbaLuma, cropRect } = window.GameShelfFrames;
  let run = 0;
  let current = null;

  async function canvasLuma(frame, rect) {
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return rgbaLuma(context.getImageData(0, 0, rect.width, rect.height).data, rect.width, rect.height);
  }

  async function watch(config, mine) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: config.sourceId, maxFrameRate: 30 } },
    });
    const [track] = stream.getVideoTracks();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const detector = createDetector({ textLuma: config.textLuma, darkText: config.darkText });
    const stats = { frames: 0, ticks: 0, reads: 0, copyMs: 0, detectMs: 0 };
    let last = 0;
    let reported = performance.now();
    current = { config, track };
    try {
      while (mine === run) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        stats.frames++;
        const now = performance.now();
        if (now - last < config.tickMs) {
          frame.close();
          continue;
        }
        last = now;
        try {
          const visible = frame.visibleRect;
          const area = cropRect(visible.width, visible.height, config.region, current.config.windowRect || undefined);
          if (area.width < 16 || area.height < 8) continue;
          const rect = { x: visible.x + area.x, y: visible.y + area.y, width: area.width, height: area.height };
          const copyStarted = performance.now();
          const luma = (await frameLuma(frame, rect)) || (await canvasLuma(frame, rect));
          stats.copyMs += performance.now() - copyStarted;
          const detectStarted = performance.now();
          const { action } = detector.push(luma, area.width, area.height);
          stats.detectMs += performance.now() - detectStarted;
          stats.ticks++;
          if (action === 'read') {
            stats.reads++;
            const image = ocrImage(luma, area.width, area.height, config);
            window.gsCapture.read({
              bmp: grayBmp(image.pixels, image.width, image.height),
              crop: { ...area, scale: image.scale, frameWidth: visible.width, frameHeight: visible.height, windowRect: current.config.windowRect || null },
            });
          } else if (action === 'clear') {
            window.gsCapture.clear();
          }
        } finally {
          frame.close();
        }
        if (now - reported > 2000) {
          window.gsCapture.status({
            fps: Math.round((stats.ticks * 1000) / (now - reported)),
            copyMs: stats.ticks ? +(stats.copyMs / stats.ticks).toFixed(2) : null,
            detectMs: stats.ticks ? +(stats.detectMs / stats.ticks).toFixed(3) : null,
            reads: stats.reads,
          });
          Object.assign(stats, { frames: 0, ticks: 0, copyMs: 0, detectMs: 0 });
          reported = now;
        }
      }
    } finally {
      track.stop();
    }
  }

  window.gsCapture.onStart((config) => {
    const mine = ++run;
    watch(config, mine).catch((err) => window.gsCapture.status({ error: err.message }));
  });
  window.gsCapture.onStop(() => {
    run++;
    current?.track.stop();
    current = null;
  });
  // The game window moved within a captured screen.
  window.gsCapture.onWindow((windowRect) => {
    if (current) current.config = { ...current.config, windowRect };
  });
})();
