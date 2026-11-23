'use strict';

/* Node harness for core.js — no DOM needed.
   usage: node test/core.test.js <backup.zip> <raw-profile> */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const N = require('../core.js');

const zipPath = process.argv[2];
const rawPath = process.argv[3];
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2js-'));
let passed = 0;

function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

function fileOf(p) {
  return new File([fs.readFileSync(p)], path.basename(p));
}

async function main() {
  assert.ok(zipPath && rawPath, 'usage: node test/core.test.js <backup.zip> <raw-profile>');
  const original = fileOf(zipPath);
  const zip = await N.openZip(original);
  assert.ok(zip.entries.length > 0);
  ok(`read ${zip.entries.length} zip entries`);

  const candidates = N.profileEntries(zip);
  assert.equal(candidates.length, 1);
  const entry = candidates[0];
  ok(`found profile ${entry.name}`);

  const bytes = await N.entryBytes(zip, entry);
  const save = new N.CareerSave(bytes);
  assert.equal(save.size, N.PROFILE_SIZE);
  const c0 = save.checksums();
  assert.ok(c0.a && c0.b && c0.h, `source CRCs valid: ${JSON.stringify(c0)}`);
  ok(`source profile parses · money ${N.moneyText(save.money)} · name ${save.name} · stage ${save.stage}`);

  // money edit keeps block A untouched and only moves money + two CRCs
  const before = bytes.slice();
  save.setMoney(1234567);
  save.fixChecksums();
  const c1 = save.checksums();
  assert.ok(c1.a && c1.b && c1.h);
  assert.equal(save.money, 1234567);
  const ranges = N.changedRanges(before, save.bytes);
  assert.deepEqual(ranges, [[0x14, 0x1c], [0xa16a, 0xa16e]]);
  ok('money edit touches 0x14..0x1C and 0x0A16A..0x0A16E only');

  // name + stage
  save.setName('MALEEK');
  save.setStage(4);
  save.fixChecksums();
  assert.equal(save.name, 'MALEEK');
  assert.equal(save.stage, 4);
  assert.ok(Object.values(save.checksums()).every(Boolean));
  ok('rename and stage edit still pass the checksums');

  // rebuild the archive
  const blob = N.buildZip(zip, entry.name, save.bytes);
  const out = path.join(outDir, 'edited.zip');
  fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  ok(`rebuilt archive (${blob.size} bytes) -> ${out}`);

  // every other entry must survive byte for byte
  const redo = await N.openZip(fileOf(out));
  assert.equal(redo.entries.length, zip.entries.length);
  let compared = 0;
  for (const e of zip.entries) {
    if (e.name === entry.name) continue;
    const twin = redo.entries.find((x) => x.name === e.name);
    assert.ok(twin, `entry missing after rebuild: ${e.name}`);
    const a = await N.entryBytes(zip, e);
    const b = await N.entryBytes(redo, twin);
    assert.deepEqual(Buffer.from(b), Buffer.from(a), `entry changed: ${e.name}`);
    compared += 1;
  }
  ok(`${compared} untouched entries identical`);

  const editedEntry = redo.entries.find((e) => e.name === entry.name);
  const edited = new N.CareerSave(await N.entryBytes(redo, editedEntry));
  assert.equal(edited.money, 1234567);
  assert.equal(edited.name, 'MALEEK');
  assert.equal(edited.stage, 4);
  assert.ok(Object.values(edited.checksums()).every(Boolean));
  ok('profile inside the rebuilt archive reads back correctly');

  // garage fingerprint must not move (money lives outside the hashed range)
  const folder = entry.name.slice(0, entry.name.lastIndexOf('/'));
  const garageEntry = redo.entries.find((e) => e.name === `${folder}/GARAGE.DAT`);
  if (garageEntry) {
    const garage = N.readGarage(await N.entryBytes(redo, garageEntry));
    assert.equal(N.fnv1a64(edited.bytes, 36, 39266), garage.fingerprint);
    ok('garage fingerprint still matches the edited profile');

    assert.equal(garage.slots.length, garage.count);
    assert.equal(garage.slots[0].index, N.GARAGE_FIRST_SLOT);
    assert.equal(garage.slots.at(-1).index, N.GARAGE_FIRST_SLOT + garage.count - 1);
    const owned = garage.slots.filter((s) => s.used);
    assert.ok(owned.every((s) => s.carType !== 0));
    ok(`garage parses as ${garage.count} slots (6-${garage.slots.at(-1).index}), ${owned.length} in use`);

    // a money edit must not disturb the car records of the garage file
    assert.deepEqual(
      Buffer.from(await N.entryBytes(redo, garageEntry)),
      Buffer.from(await N.entryBytes(zip, garageEntry)),
      'GARAGE.DAT changed during a money edit',
    );
    ok('GARAGE.DAT is byte-identical after the edit');
  }

  // bare profile path
  const rawBytes = new Uint8Array(fs.readFileSync(rawPath));
  const rawSave = new N.CareerSave(rawBytes);
  assert.ok(rawSave.checksums().a);
  rawSave.setMoney(777777);
  rawSave.fixChecksums();
  const rawOut = path.join(outDir, 'edited-profile');
  fs.writeFileSync(rawOut, Buffer.from(rawSave.bytes));
  assert.ok(new N.CareerSave(new Uint8Array(fs.readFileSync(rawOut))).checksums().b);
  ok(`bare profile edit -> ${rawOut}`);

  console.log(`\n${passed} checks passed`);
  console.log(`artifacts: ${outDir}`);
}

main().catch((err) => {
  console.error(`\nFAIL ${err.stack || err}`);
  process.exit(1);
});
