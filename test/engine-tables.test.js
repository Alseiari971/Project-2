// Games whose text is in their engine's own message tables, which the pack
// builder reads and writes natively (FromSoftware .fmg/.msgbnd.dcx, Rockstar
// .gxt2 from a mod loader's folder, Capcom MT Framework .arc/.gmd): they get the
// loose-file tier (each file replaced, the original kept and put back), even
// when the engine's archives otherwise need a recipe. Anti-cheat still wins.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { preflight } = require('../desktop/localization/index');
const { readPack, writePack } = require('../desktop/localization/pack');
const crypto = require('node:crypto');

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-tables-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return root;
}

test('FromSoftware, RAGE mod-loader and MT Framework games get the loose-file tier', async () => {
  const fromsoft = await preflight(await tree({ 'sekiro.exe': 'MZ', 'msg/engus/item.msgbnd.dcx': 'DCX\0', 'msg/jpnjp/item.msgbnd.dcx': 'DCX\0' }));
  assert.equal(fromsoft.tier, 'loose-files');
  assert.equal(fromsoft.engine.custom.family.id, 'fromsoftware');
  assert.ok(fromsoft.engine.custom.looseText.includes('msg/engus/item.msgbnd.dcx'));

  const mt = await preflight(await tree({ 'RE5DX9.EXE': 'MZ', 'nativePC/arc/message/msg_eng.arc': 'ARC\0' }));
  assert.deepEqual([mt.tier, mt.engine.custom.family.id], ['loose-files', 'mt-framework']);

  // RAGE's .rpf archives need a recipe; its unpacked .gxt2 tables don't.
  const rage = await preflight(await tree({ 'RDR2.exe': 'MZ', 'x64/data.rpf': 'RPF7', 'lml/arabic/lang/american.gxt2': '2TXG' }));
  assert.deepEqual([rage.tier, rage.engine.custom.family.id], ['loose-files', 'rage']);
  const packed = await preflight(await tree({ 'RDR2.exe': 'MZ', 'x64/data.rpf': 'RPF7' }));
  assert.notEqual(packed.tier, 'loose-files');

  // Elden Ring and Armored Core VI ship Easy Anti-Cheat: their files are never changed.
  const guarded = await preflight(await tree({ 'eldenring.exe': 'MZ', 'msg/engus/item.msgbnd.dcx': 'DCX\0', 'EasyAntiCheat/EasyAntiCheat_EOS_Setup.exe': 'MZ' }));
  assert.equal(guarded.tier, 'overlay');
});

test('loose-file packs may hold these tables (data), never code', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const make = async (target) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-pack-'));
    await fs.mkdir(path.dirname(path.join(dir, 'payload', target)), { recursive: true });
    await fs.writeFile(path.join(dir, 'payload', target), 'x');
    await writePack(dir, { id: 'p', version: '1.0.0', engine: 'loose', files: [{ source: `payload/${target}`, target }], privateKey: keys.privateKey });
    return readPack(dir, { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) });
  };
  for (const target of ['msg/engus/item.msgbnd.dcx', 'lml/lang/american.gxt2', 'nativePC/arc/message/msg_eng.arc', 'common/text/npc.gmd', 'msg/engus/talk.fmg']) {
    await make(target);
  }
  await assert.rejects(make('msg/engus/hook.dll'), /isn't allowed/);
});
