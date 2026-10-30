// Shows one subtitle at a time. Normal Arabic is shaped and ordered by the
// browser itself (dir="rtl"); Arabic that a pack already shaped into
// Presentation Forms in screen order is drawn as is, so it's never reversed twice.
(() => {
  const box = document.getElementById('subtitle');
  const text = document.getElementById('text');
  const root = document.documentElement.style;
  const presentationForms = /[ﭐ-﷿ﹰ-﻿]/;
  const plainArabic = /[ء-ي]/;
  let hideTimer = null;

  // `box` is where the English was, as shares of this band; with "cover" the
  // Arabic sits right over it, otherwise along the bottom of the band (which
  // is then just above the subtitles).
  window.gsOverlay.onShow(({ arabic, box: where, placement }) => {
    clearTimeout(hideTimer);
    const forms = presentationForms.test(arabic) && !plainArabic.test(arabic);
    text.classList.toggle('forms', forms);
    text.dir = forms ? 'ltr' : 'rtl';
    text.textContent = arabic;
    // About the size of the English it replaces; readable either way.
    const lines = Math.max(1, arabic.split('\n').length);
    const size = where ? (where.h * window.innerHeight) / lines / 1.25 : window.innerHeight * 0.16;
    root.setProperty('--size', `${Math.round(Math.min(Math.max(size, 18), 64))}px`);
    root.setProperty('--center-x', where ? `${(where.x + where.w / 2) * 100}%` : '50%');
    if (where && placement === 'cover') {
      root.setProperty('--bottom', `${Math.max(0, (1 - (where.y + where.h)) * 100 - 4)}%`);
      root.setProperty('--min-width', `${where.w * 100 + 2}%`);
    } else {
      root.setProperty('--bottom', '6%');
      root.setProperty('--min-width', '0');
    }
    box.hidden = false;
    requestAnimationFrame(() => box.classList.add('on'));
  });

  window.gsOverlay.onHide(() => {
    box.classList.remove('on');
    hideTimer = setTimeout(() => { box.hidden = true; }, 90);
  });

  // 'floating' (outlined text, no box) or 'box' (on a dark box), from App settings.
  window.gsOverlay.onStyle((style) => {
    document.body.dataset.style = style === 'box' ? 'box' : 'floating';
  });
})();
