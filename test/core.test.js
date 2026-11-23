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
  assert.ok(ranges.length > 0);
  for (const [start, end] of ranges) {
    const inCrc = start >= 0x14 && end <= 0x1c;
    const inMoney = start >= 0xa16a && end <= 0xa16e;
    assert.ok(inCrc || inMoney, `unexpected change at 0x${start.toString(16)}..0x${end.toString(16)}`);
  }
  ok(`money edit touches only the CRCs and 0x0A16A..0x0A16E (${ranges.length} range(s))`);

  // car names come from the game's own asset names
  assert.equal(N.bStringHash('240SX'), 0x0150fb80);
  assert.equal(N.carName(0x0150fb80), '240SX');
  assert.equal(N.carName(0xdeadbeef), null);
  const usedCareer = save.slots().filter((s) => s.used);
  const named = usedCareer.filter((s) => N.carName(s.carType));
  ok(`car names resolve for ${named.length}/${usedCareer.length} career slots`);

  // stage completion + per-car extras
  const stages = save.stages();
  assert.equal(stages.length, 6);
  const detail = save.slotDetail(1);
  assert.ok(detail && Number.isInteger(detail.value) && detail.parts <= 170 && detail.dyno <= 5);
  ok(`stages ${stages.filter(Boolean).length}/6 complete · slot 1 value $${detail.value.toLocaleString('en-US')}, `
    + `${detail.parts} parts, ${detail.items} items`);

  // tuning lives in the car record: writing it must move the garage fingerprint
  const scratch = new N.CareerSave(bytes.slice());
  const tune0 = scratch.slotTune(1);
  assert.equal(tune0.setups.length, N.SETUP_COUNT);
  assert.equal(tune0.block.length, N.SETUP_COUNT * N.SETUP_SIZE);
  const blockBefore = tune0.block.slice();
  scratch.fillCurves(1, N.MAX_TUNE_BYTE);
  scratch.setUniques(1, true);
  scratch.fixChecksums();
  const tuned = scratch.slotTune(1);
  assert.ok(tuned.setups.every((s) => s.ecu.every((v) => v === N.MAX_TUNE_BYTE)
    && s.turbo.every((v) => v === N.MAX_TUNE_BYTE)));
  assert.equal(tuned.uniques.filter(Boolean).length, 9);
  // only the 18 curve bytes of each 41-byte setup may move
  for (let s = 0; s < N.SETUP_COUNT; s++) {
    const from = s * N.SETUP_SIZE;
    for (let j = 0; j < N.SETUP_SIZE; j++) {
      const isCurve = j >= 0x17 && j < 0x29;
      if (!isCurve) {
        assert.equal(tuned.block[from + j], blockBefore[from + j], `setup ${s} byte +0x${j.toString(16)} changed`);
      }
    }
  }
  assert.ok(Object.values(scratch.checksums()).every(Boolean));
  ok('dyno max writes only ECU/turbo points, setup scalars untouched');

  // the ramp keeps the low end neutral and ends at the max
  const ramp = new N.CareerSave(bytes.slice());
  ramp.fillCurveRamp(1);
  const rampTune = ramp.slotTune(1);
  for (const setup of rampTune.setups) {
    assert.equal(setup.ecu[0], N.NEUTRAL_BYTE);
    assert.equal(setup.ecu.at(-1), N.MAX_TUNE_BYTE);
    assert.equal(setup.turbo[0], N.NEUTRAL_BYTE);
    assert.equal(setup.turbo.at(-1), N.MAX_TUNE_BYTE);
    assert.deepEqual(setup.ecu, setup.turbo);
    assert.deepEqual(setup.ecu, [...setup.ecu].sort((a, b) => a - b));
  }
  ok('dyno ramp rises 100 -> 200, highest rpm maxed');

  // name + stage
  save.setName('MALEEK');
  save.setStage(4);
  save.fixChecksums();
  assert.equal(save.name, 'MALEEK');
  assert.equal(save.stage, 4);
  assert.ok(Object.values(save.checksums()).every(Boolean));
  ok('rename and stage edit still pass the checksums');

  // rebuild the archive
  const blob = N.buildZip(zip, new Map([[entry.name, save.bytes]]));
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

    // a car edit does move the fingerprint, so the re-link has to work
    const fpTuned = N.garageFingerprint(scratch.bytes);
    assert.notEqual(fpTuned, garage.fingerprint, 'car edit should change the fingerprint');
    const relinked = N.writeGarageFingerprint(await N.entryBytes(zip, garageEntry), fpTuned);
    const gv = new DataView(relinked.buffer, relinked.byteOffset, relinked.byteLength);
    assert.equal(gv.getUint32(8, true), Number(fpTuned & 0xffffffffn));
    assert.equal(gv.getUint32(12, true), Number((fpTuned >> 32n) & 0xffffffffn));
    ok('garage fingerprint re-link rewrites both halves');

    // garage slots 6-25 tune through the same helpers, at their own base
    const gBytes = await N.entryBytes(zip, garageEntry);
    const gBase = N.garageBase(N.GARAGE_FIRST_SLOT);
    const gTune = N.readTuneAt(gBytes, gBase);
    assert.equal(gTune.setups.length, N.SETUP_COUNT);
    const gCopy = gBytes.slice();
    N.fillCurvesAt(gCopy, gBase, N.MAX_TUNE_BYTE);
    N.setUniquesAt(gCopy, gBase, true);
    const gAfter = N.readTuneAt(gCopy, gBase);
    assert.ok(gAfter.setups.every((s) => s.ecu.every((v) => v === N.MAX_TUNE_BYTE)));
    assert.equal(gAfter.uniques.filter(Boolean).length, 9);
    let outside = 0;
    const recStart = N.GARAGE_RECORD ? 32 + (N.GARAGE_FIRST_SLOT - N.GARAGE_FIRST_SLOT) * 2034 : 32;
    for (let i = 0; i < gCopy.length; i++) {
      if (gCopy[i] === gBytes[i]) continue;
      const rel = i - gBase;
      const inCurve = rel >= 0x354 && rel < 0x354 + 5 * 41;
      const inUniques = rel >= 0x2e8 && rel < 0x2e8 + 36;
      if (!inCurve && !inUniques) outside += 1;
    }
    assert.equal(outside, 0, 'garage tuning touched bytes outside the curves/uniques');
    ok(`garage slot ${N.GARAGE_FIRST_SLOT} tunes through the shared helpers`);

    // cross-file swap: GARAGE.DAT header pointers follow the car
    const gb = gBytes.slice();
    const mixed = new N.CareerSave(bytes.slice());
    const garageHandle = N.slotHandle(gb, N.garageBase(6));
    const careerHandle = N.slotHandle(mixed.bytes, N.careerBase(1));
    N.swapRecords({ bytes: mixed.bytes, base: N.careerBase(1) }, { bytes: gb, base: N.garageBase(6) });
    const movedPointers = N.retargetGarageHandles(gb, careerHandle, garageHandle);
    assert.ok(movedPointers >= 1, 'no header pointer followed the swap');
    const hv = new DataView(gb.buffer, gb.byteOffset, gb.byteLength);
    for (const off of [16, 20, 24]) {
      const value = hv.getUint32(off, true);
      assert.ok(value === 0 || value === careerHandle || value === garageHandle, 'header points at a foreign slot');
    }
    ok(`career <-> garage swap retargeted ${movedPointers} header pointer(s)`);
  }

  // a rename has to carry the zip entries with it, or the site keeps the old profile
  const renameZip = await N.openZip(fileOf(zipPath));
  const oldEntry = N.profileEntries(renameZip)[0];
  const oldFolder = oldEntry.name.slice(0, oldEntry.name.lastIndexOf('/'));
  const parent = oldFolder.slice(0, Math.max(0, oldFolder.lastIndexOf('/')));
  const newProfile = `${parent}/TESTER/TESTER`;
  const renamedSave = new N.CareerSave((await N.entryBytes(renameZip, oldEntry)).slice());
  renamedSave.setName('TESTER');
  renamedSave.fixChecksums();
  const renames = new Map([[oldEntry.name, newProfile]]);
  const oldGarage = renameZip.entries.find((e) => e.name === `${oldFolder}/GARAGE.DAT`);
  if (oldGarage) renames.set(oldGarage.name, `${parent}/TESTER/GARAGE.DAT`);
  const renamedBlob = N.buildZip(renameZip, new Map([[oldEntry.name, renamedSave.bytes]]), renames);
  const renamedPath = path.join(outDir, 'renamed.zip');
  fs.writeFileSync(renamedPath, Buffer.from(await renamedBlob.arrayBuffer()));
  const reopened = await N.openZip(fileOf(renamedPath));
  assert.ok(reopened.entries.some((e) => e.name === newProfile), 'profile entry not renamed');
  if (oldGarage) {
    assert.ok(reopened.entries.some((e) => e.name === `${parent}/TESTER/GARAGE.DAT`), 'garage entry not renamed');
  }
  const nameBack = new N.CareerSave(await N.entryBytes(reopened, reopened.entries.find((e) => e.name === newProfile)));
  assert.equal(nameBack.name, 'TESTER');
  assert.ok(Object.values(nameBack.checksums()).every(Boolean));
  ok(`rename moves the entries to ${newProfile} and keeps the save valid`);

  // the name is stored in three places in the save, and again in companion files
  const spans = new N.CareerSave(bytes.slice());
  spans.setName('RUSDI');
  for (const off of [0xd250, 0xd264]) {
    assert.equal(Buffer.from(spans.bytes.subarray(off, off + 5)).toString('latin1'), 'RUSDI');
    assert.equal(spans.bytes[off + 19], 0, 'aux span not zero-padded');
  }
  const text = N.replaceNameInText(Buffer.from('roam_name = MALEEK\n'), 'MALEEK', 'RUSDI');
  assert.equal(Buffer.from(text).toString('latin1'), 'roam_name = RUSDI\n');
  const bin = N.replaceNameInBinary(Buffer.from('2857.MALEEK\u0000\u0000', 'latin1'), 'MALEEK', 'RUSDI');
  assert.equal(Buffer.from(bin).toString('latin1'), '2857.RUSDI\u0000\u0000\u0000');
  ok('name lands in the aux spans and companion text/binary files');

  const roam = N.clearRoamOverrides(Buffer.from('sound = on\nroam_block = R9-Vosquue\nroam_friends = dproject\nhorn = klaxon\n', 'latin1'));
  assert.deepEqual(roam.removed, ['roam_block', 'roam_friends']);
  assert.equal(Buffer.from(roam.bytes).toString('latin1'), 'sound = on\nhorn = klaxon\n');
  ok('roam overrides are dropped from settings.ini');

  // rearranging: payloads swap, each slot keeps its own CAREER_SLOT handle
  const box = new N.CareerSave(bytes.slice());
  const s1 = box.slots()[0];
  const s2 = box.slots()[1];
  const h1 = N.slotHandle(box.bytes, N.careerBase(1));
  const h1b = N.slotHandle(box.bytes, N.careerBase(2));
  N.swapRecords({ bytes: box.bytes, base: N.careerBase(1) }, { bytes: box.bytes, base: N.careerBase(2) });
  box.fixChecksums();
  assert.equal(box.slots()[0].carType, s2.carType);
  assert.equal(box.slots()[1].carType, s1.carType);
  assert.equal(N.slotHandle(box.bytes, N.careerBase(1)), h1);
  assert.equal(N.slotHandle(box.bytes, N.careerBase(2)), h1b);
  assert.ok(Object.values(box.checksums()).every(Boolean));
  ok('slots 1 and 2 swap cars and keep their handles');

  // max parts: top member of every family, all 56 purchase bits, nothing else
  const perfBox = new N.CareerSave(bytes.slice());
  const perfBase = N.careerBase(1);
  const flagsBefore = perfBox.bytes.slice(perfBase + 0x310, perfBase + 0x310 + 68);
  const buyBefore = perfBox.bytes.slice(perfBase + 0x586, perfBase + 0x586 + 9);
  const families = N.maxPerformanceAt(perfBox.bytes, perfBase);
  perfBox.fixChecksums();
  const flagsAfter = perfBox.bytes.slice(perfBase + 0x310, perfBase + 0x310 + 68);
  const buyAfter = perfBox.bytes.slice(perfBase + 0x586, perfBase + 0x586 + 9);
  assert.equal(families, N.PERF_PLAN.length);
  // no family may end with two members set
  for (const [on, offs] of N.PERF_PLAN) {
    assert.equal(flagsAfter[on], 1, `family ${on} not installed`);
    for (const off of offs) assert.equal(flagsAfter[off], 0, `conflicting ${off} left set`);
  }
  // aero 56-67 untouched
  for (let i = 56; i < 68; i++) assert.equal(flagsAfter[i], flagsBefore[i], `aero byte ${i} changed`);
  // purchase bits 0..55 all on, ninth byte untouched
  for (let i = 0; i < 56; i++) assert.ok(buyAfter[i >> 3] & (1 << (i & 7)), `purchase bit ${i} missing`);
  assert.equal(buyAfter[8], buyBefore[8], 'ninth purchase byte changed');
  assert.ok(Object.values(perfBox.checksums()).every(Boolean));
  ok(`max parts installs ${families} families and all 56 purchase bits`);

  // bare profile path
  const rawBytes = new Uint8Array(fs.readFileSync(rawPath));  const rawSave = new N.CareerSave(rawBytes);
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
