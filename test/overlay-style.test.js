// The overlay's look: floating outlined text by default, or a dark box. The
// choice is saved for every game, and the overlay page switches when told.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { createArabicService } = require('../desktop/localization/service');

const OVERLAY = path.join(__dirname, '..', 'desktop', 'overlay');
const { publicKey } = crypto.generateKeyPairSync('ed25519');

const service = (dataDir) => createArabicService({ dataDir, publicKey, localization: {}, packs: {} });

test('the style is floating text until the player picks the box, and the choice is kept', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-style-'));
  assert.equal(await service(dataDir).overlayStyle(), 'floating');
  assert.equal(await service(dataDir).setOverlayStyle('box'), 'box');
  assert.equal(await service(dataDir).overlayStyle(), 'box', 'read back by a new service, as after a restart');
  await assert.rejects(service(dataDir).setOverlayStyle('neon'), /Unknown overlay style/);
  assert.equal(await service(dataDir).overlayStyle(), 'box');
  // A damaged or unknown saved value falls back to the default.
  fs.writeFileSync(path.join(dataDir, 'localization', 'overlay.json'), '{"style":"neon"}');
  assert.equal(await service(dataDir).overlayStyle(), 'floating');
  fs.writeFileSync(path.join(dataDir, 'localization', 'overlay.json'), 'not json');
  assert.equal(await service(dataDir).overlayStyle(), 'floating');
});

// overlay.js with stand-ins for the page and the preload bridge.
function runOverlayPage() {
  const handlers = {};
  const element = () => ({
    hidden: true,
    dir: '',
    textContent: '',
    classList: {
      names: new Set(),
      add(name) { this.names.add(name); },
      remove(name) { this.names.delete(name); },
      toggle(name, on) { if (on) this.names.add(name); else this.names.delete(name); },
    },
  });
  const nodes = { subtitle: element(), text: element() };
  const props = {};
  const document = {
    getElementById: (id) => nodes[id],
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } },
    body: { dataset: { style: 'floating' } },
  };
  const window = {
    innerHeight: 200,
    gsOverlay: { onShow: (fn) => { handlers.show = fn; }, onHide: (fn) => { handlers.hide = fn; }, onStyle: (fn) => { handlers.style = fn; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(OVERLAY, 'overlay.js'), 'utf8'), {
    window, document, requestAnimationFrame: (fn) => fn(), setTimeout, clearTimeout,
  });
  return { handlers, document, nodes, props };
}

test('the overlay page switches between the two looks when told', () => {
  const { handlers, document, nodes } = runOverlayPage();
  assert.equal(document.body.dataset.style, 'floating');
  handlers.style('box');
  assert.equal(document.body.dataset.style, 'box');
  handlers.style('floating');
  assert.equal(document.body.dataset.style, 'floating');
  handlers.style('something else');
  assert.equal(document.body.dataset.style, 'floating', 'anything unknown is the default');

  // The subtitle itself shows the same either way.
  handlers.show({ arabic: 'يجب أن نصل إلى القلعة', box: null, placement: 'above' });
  assert.equal(nodes.subtitle.hidden, false);
  assert.equal(nodes.text.textContent, 'يجب أن نصل إلى القلعة');
  assert.equal(nodes.text.dir, 'rtl');
});

test('floating text has no box: a heavy outline drawn under the letters, and a shadow', () => {
  const html = fs.readFileSync(path.join(OVERLAY, 'overlay.html'), 'utf8');
  assert.match(html, /<body data-style="floating">/);
  const css = fs.readFileSync(path.join(OVERLAY, 'overlay.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => {
    const found = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"=]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(found, `no rule for ${selector}`);
    return Object.fromEntries(found[1].split(';').map((d) => d.split(':').map((x) => x.trim())).filter(([k]) => k).map(([k, ...v]) => [k, v.join(':')]));
  };
  const subtitle = rule('.subtitle');
  assert.equal(subtitle.background, 'transparent');
  assert.equal(subtitle['box-shadow'], undefined);
  const text = rule('.subtitle p');
  assert.equal(text['-webkit-text-stroke'], '3px rgba(0, 0, 0, 0.95)');
  assert.equal(text['paint-order'], 'stroke fill');
  assert.equal(text['text-shadow'], '0 2px 6px rgba(0, 0, 0, 0.95)');

  // The box look puts the box back and drops the outline.
  const box = rule('body[data-style="box"] .subtitle');
  assert.match(box.background, /^rgba\(8, 8, 10, 0\.86\)$/);
  assert.equal(rule('body[data-style="box"] .subtitle p')['-webkit-text-stroke'], '0');
});
