'use strict';

/* =========================================================
   nfsu2save UI — terminal front end over core.js
   ========================================================= */

const N = window.NFSU2;

/* Ranges that must never move when a scalar field is edited. */
const CAR_RECORDS = [0x5868, 0x8022]; // five career car records, 0x7F2 apart
const FINGERPRINT_RANGE = [36, 39266]; // what GARAGE.DAT fingerprints

function sameRegion(a, b, [start, end]) {
  if (a.length !== b.length || b.length < end) return false;
  for (let i = start; i < end; i++) if (a[i] !== b[i]) return false;
  return true;
}

const state = {
  file: null,
  kind: null,      // 'profile' | 'zip'
  zip: null,
  entry: null,
  garage: null,
  garageBytes: null,     // raw GARAGE.DAT, needed to re-link the fingerprint
  garageOriginal: null,  // its bytes at load, to spot garage edits
  garageEntry: null,
  original: null,  // untouched profile bytes
  save: null,      // working copy
  showEmpty: false, // reveal empty car slots in the report
  detailSlot: null, // slot number whose per-car detail is open
  tunes: {},        // named tuning presets kept in this browser
};

const TUNES_KEY = 'nfsu2save.tunes';

try {
  state.tunes = JSON.parse(localStorage.getItem(TUNES_KEY) || '{}') || {};
} catch {
  state.tunes = {};
}

const el = {
  log: document.getElementById('log'),
  drop: document.getElementById('drop'),
  file: document.getElementById('file'),
  editor: document.getElementById('editor'),
  money: document.getElementById('money'),
  name: document.getElementById('name'),
  stage: document.getElementById('stage'),
  pending: document.getElementById('pending'),
  download: document.getElementById('download'),
  revert: document.getElementById('revert'),
  reset: document.getElementById('reset'),
  statusFile: document.getElementById('status-file'),
  statusCrc: document.getElementById('status-crc'),
  applyMoney: document.getElementById('apply-money'),
  applyName: document.getElementById('apply-name'),
  applyStage: document.getElementById('apply-stage'),
  presets: document.getElementById('presets'),
  dropText: document.getElementById('drop-text'),
  dropHint: document.getElementById('drop-hint'),
  navHelp: document.getElementById('nav-help'),
  report: document.getElementById('report'),
  reportTitle: document.getElementById('report-title'),
  reportMeta: document.getElementById('report-meta'),
  kvBody: document.getElementById('kv-body'),
  carsHead: document.getElementById('cars-head'),
  carsBody: document.getElementById('cars-body'),
  clearRoam: document.getElementById('clear-roam'),
};

/* ---------- logging ---------- */
function say(text = '', cls = '') {
  const line = document.createElement('p');
  line.className = `log__line ${cls}`.trim();
  line.textContent = text;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
  return line;
}

/* ---------- loading ---------- */
async function loadFile(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    const isSave = head.length === 4 && N.MAGIC.every((b, i) => head[i] === b);
    if (isZip) await loadZip(file);
    else if (isSave) await loadProfile(file);
    else throw new N.SaveError('not a career save or a zip archive');
  } catch (err) {
    say(`error: ${err.message}`, 'err');
  }
}

async function loadProfile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const save = new N.CareerSave(bytes);
  resetState();
  state.file = file;
  state.kind = 'profile';
  state.original = bytes.slice();
  state.save = save;
  say(`$ load ${file.name}`, 'cmd');
  renderReport();
  showEditor(true);
  say('');
  say('this is a bare profile: keep it as NFS Underground 2/<name>/<name>', 'dim');
}

async function loadZip(file) {
  const zip = await N.openZip(file);
  const candidates = N.profileEntries(zip);
  if (!candidates.length) throw new N.SaveError('no profile found (expected NFS Underground 2/<name>/<name>)');

  const pick = candidates.length === 1 ? candidates[0] : await chooseCandidate(candidates);
  if (!pick) { say('cancelled', 'dim'); return; }

  const bytes = await N.entryBytes(zip, pick);
  const save = new N.CareerSave(bytes);

  const folder = pick.name.slice(0, pick.name.lastIndexOf('/'));
  const garageEntry = zip.entries.find((e) => e.name === `${folder}/GARAGE.DAT`);
  let garage = null;
  let garageBytes = null;
  if (garageEntry) {
    try {
      garageBytes = await N.entryBytes(zip, garageEntry);
      garage = N.readGarage(garageBytes);
      if (garage) garage.paired = garage.fingerprint === N.garageFingerprint(bytes);
    } catch (err) {
      garage = { error: err.message };
      garageBytes = null;
    }
  }

  resetState();
  state.file = file;
  state.kind = 'zip';
  state.zip = zip;
  state.entry = pick;
  state.garage = garage;
  state.garageBytes = garageBytes;
  state.garageOriginal = garageBytes ? garageBytes.slice() : null;
  state.garageEntry = garageEntry ? garageEntry.name : null;
  state.original = bytes.slice();
  state.save = save;

  say(`$ load ${file.name}`, 'cmd');
  say(`  ${zip.entries.length} entries · profile ${pick.name}`, 'dim');
  renderReport();
  showEditor(true);
  const rename = pendingRename();
  if (rename) {
    say(`  driver "${save.name}" but the folder is "${pick.name.split('/').slice(-1)[0]}"`, 'out');
    say(`  download renames it to ${rename.profile}`, 'out');
  }
  say('');
  say('download returns the same archive with only those bytes changed', 'dim');
  say("restore: Saves → Restore → pick the download → Keep this browser's", 'dim');
}

function chooseCandidate(candidates) {
  return new Promise((resolve) => {
    say('several profiles in this backup — pick one', 'out');
    const select = document.createElement('select');
    select.className = 'pick';
    for (const e of candidates) {
      const opt = document.createElement('option');
      opt.value = e.name;
      opt.textContent = e.name;
      select.appendChild(opt);
    }
    const go = document.createElement('button');
    go.className = 'btn btn--primary pick__go';
    go.textContent = 'open';

    const row = document.createElement('p');
    row.className = 'log__line';
    row.append(select, go);
    el.log.appendChild(row);
    el.log.scrollTop = el.log.scrollHeight;

    go.addEventListener('click', () => {
      const chosen = candidates.find((e) => e.name === select.value) || null;
      row.remove();
      resolve(chosen);
    });
  });
}

/* ---------- report table ---------- */
function kvRow(label, value, cls = '') {
  const tr = document.createElement('tr');
  const k = document.createElement('td');
  k.className = 'k';
  k.textContent = label;
  const v = document.createElement('td');
  v.className = `v ${cls}`.trim();
  if (value instanceof Node) v.appendChild(value);
  else v.textContent = value;
  tr.append(k, v);
  return tr;
}

function crcCell(c) {
  const frag = document.createDocumentFragment();
  [['A', c.a], ['B', c.b], ['header', c.h]].forEach(([name, ok], i) => {
    if (i) frag.append(' · ');
    const s = document.createElement('span');
    s.className = ok ? 'ok' : 'err';
    s.textContent = `${name} ${ok ? 'ok' : 'BAD'}`;
    frag.append(s);
  });
  return frag;
}

/* The profile lives at <parent>/<driver>/<driver>, so renaming the driver has to
   move the zip entries too - otherwise the site keeps listing the old profile. */
function pendingRename() {
  if (state.kind !== 'zip' || !state.entry || !state.save) return null;
  const path = state.entry.name;
  const last = path.lastIndexOf('/');
  const folder = path.slice(0, last);
  const current = path.slice(last + 1);
  const name = state.save.name;
  if (!name || name === current) return null;
  const parent = folder.slice(0, Math.max(0, folder.lastIndexOf('/')));
  const base = parent ? `${parent}/` : '';
  return {
    name,
    profile: `${base}${name}/${name}`,
    garage: state.garageEntry ? `${base}${name}/GARAGE.DAT` : null,
  };
}

/* Every entry that carries the profile name as a path segment (or a
   "<name>.txt" basename) has to move too: the game's profile folder, plus the
   mod's endless-career folder and carlot file, which are keyed by the same name. */
function renamePath(path, from, to) {
  return path.split('/').map((segment) => {
    if (segment === from) return to;
    if (segment.startsWith(`${from}.`)) return `${to}${segment.slice(from.length)}`;
    return segment;
  }).join('/');
}

function carState(slot) {
  if (!slot.used) return 'empty';
  if (slot.locked) return 'locked';
  if (!slot.bought) return 'not bought';
  return 'owned';
}

/* Slots 1-5 live in the career save, 6-25 in GARAGE.DAT. The record shape is the
   same, so the readers are shared and only the base differs. */
function isGarageSlot(index) {
  return index >= N.GARAGE_FIRST_SLOT;
}

function carTune(index) {
  if (isGarageSlot(index)) {
    return state.garageBytes ? N.readTuneAt(state.garageBytes, N.garageBase(index)) : null;
  }
  return state.save ? state.save.slotTune(index) : null;
}

function carDetail(index) {
  if (isGarageSlot(index)) {
    return state.garageBytes ? N.readDetailAt(state.garageBytes, N.garageBase(index)) : null;
  }
  return state.save ? state.save.slotDetail(index) : null;
}

/* Every slot in the file: the five career records plus whatever GARAGE.DAT holds. */
function allSlots() {
  const career = state.save ? state.save.slots() : [];
  const garage = state.garage && state.garage.slots ? state.garage.slots : [];
  return career.concat(garage);
}

/** Live byte buffer + payload base for a slot, whichever file it lives in. */
function carTarget(index) {
  if (isGarageSlot(index)) {
    if (!state.garageBytes) return null;
    return { index, bytes: state.garageBytes, base: N.garageBase(index), garage: true };
  }
  if (!state.save) return null;
  return { index, bytes: state.save.bytes, base: N.careerBase(index), garage: false };
}

/* GARAGE.DAT is parsed at load; re-read it after a write so the table shows the
   new car order. */
function refreshGarage() {
  if (!state.garageBytes || !state.garage) return;
  const parsed = N.readGarage(state.garageBytes);
  if (!parsed) return;
  parsed.fingerprint = state.garage.fingerprint;
  state.garage = parsed;
}

function carRow(slot) {
  const status = carState(slot);
  const label = slot.used ? N.carLabel(slot.carType) : null;
  const tr = document.createElement('tr');
  if (slot.used) {
    tr.className = 'carrow';
    tr.dataset.slot = String(slot.index);
    tr.title = `${N.carName(slot.carType) || 'unknown car'} · ${N.hex(slot.carType, 8)} · key ${N.hex(slot.carKey, 8)}`;
  }
  const cells = [
    ['k', String(slot.index), ''],
    ['v', slot.used ? (label || 'unknown') : '—', slot.used ? (label ? 'v--car' : 'v--warn') : 'v--idle'],
    ['v', slot.used ? N.hex(slot.carType, 8) : '—', 'v--idle'],
    ['v', slot.used ? N.hex(slot.carKey, 8) : '—', 'v--idle'],
    ['v', status, status === 'empty' ? 'v--idle' : status === 'owned' ? '' : 'v--warn'],
  ];
  for (const [cls, text, extra] of cells) {
    const td = document.createElement('td');
    td.className = `${cls} ${extra}`.trim();
    td.textContent = text;
    tr.appendChild(td);
  }
  return tr;
}

function detailRow(slot) {
  const detail = carDetail(slot.index);
  if (!detail) return null;
  const tr = document.createElement('tr');
  tr.className = 'cardetail';
  const td = document.createElement('td');
  td.colSpan = 5;
  const items = [
    ['value', N.moneyText(detail.value)],
    ['parts', `${detail.parts}/170`],
    ['items', `${detail.items}/68`],
    ['uniques', `${detail.uniques}/9`],
    ['dyno', `${detail.dyno}/5`],
    ['handle', N.hex(detail.handle, 8)],
  ];
  items.forEach(([key, value], i) => {
    if (i) td.append(' · ');
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = ` ${value}`;
    td.append(k, v);
  });
  tr.appendChild(td);
  return tr;
}

/* Rearrange: swap this car with any other slot, career or garage. */
function arrangeRow(slot) {
  const others = allSlots().filter((s) => s.index !== slot.index);
  if (!others.length) return null;

  const tr = document.createElement('tr');
  tr.className = 'cardetail';
  tr.dataset.slot = String(slot.index);
  const td = document.createElement('td');
  td.colSpan = 5;

  const line = document.createElement('div');
  line.className = 'cardetail__line';

  const label = document.createElement('span');
  label.className = 'k';
  label.textContent = 'arrange';

  const select = document.createElement('select');
  select.className = 'pick';
  select.dataset.swapFrom = String(slot.index);
  for (const other of others) {
    const option = document.createElement('option');
    option.value = String(other.index);
    option.textContent = `${other.index} · ${other.used ? (N.carLabel(other.carType) || 'unknown') : 'empty'}`;
    select.appendChild(option);
  }

  const button = document.createElement('button');
  button.className = 'btn btn--primary';
  button.dataset.act = 'swap';
  button.textContent = 'swap';

  const note = document.createElement('span');
  note.className = 'k';
  note.textContent = 'car moves, the slot keeps its handle';

  line.append(label, select, button, note);
  td.appendChild(line);
  tr.appendChild(td);
  return tr;
}

function groupRow(label) {
  const tr = document.createElement('tr');
  tr.className = 'rowgroup';
  const td = document.createElement('td');
  td.colSpan = 5;
  td.textContent = label;
  tr.appendChild(td);
  return tr;
}

/* Dyno curves (5 setups x 9-point ECU/turbo), the 9 unique upgrades, and the
   buttons that write them. Everything here is a car-record edit. */
function tuneRow(slot) {
  const tune = carTune(slot.index);
  if (!tune) return null;

  const ecu = tune.setups.flatMap((s) => s.ecu);
  const turbo = tune.setups.flatMap((s) => s.turbo);
  const uniques = tune.uniques.filter(Boolean).length;
  const tuned = ecu.some((v) => v !== N.NEUTRAL_BYTE) || turbo.some((v) => v !== N.NEUTRAL_BYTE);

  const tr = document.createElement('tr');
  tr.className = 'cardetail';
  tr.dataset.slot = String(slot.index);
  const td = document.createElement('td');
  td.colSpan = 5;

  const line = (...nodes) => {
    const div = document.createElement('div');
    div.className = 'cardetail__line';
    div.append(...nodes);
    return div;
  };
  const label = (text) => {
    const s = document.createElement('span');
    s.className = 'k';
    s.textContent = text;
    return s;
  };
  const value = (text, cls = 'v') => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  const button = (act, text, title) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.dataset.act = act;
    b.dataset.slot = String(slot.index);
    b.textContent = text;
    if (title) b.title = title;
    return b;
  };

  td.append(line(
    label('dyno'),
    value(`ecu ${Math.min(...ecu)}-${Math.max(...ecu)} · turbo ${Math.min(...turbo)}-${Math.max(...turbo)}`
      + (tuned ? '' : ' · stock')),
    ' ',
    button('tune-max', 'max', 'all 9 ECU + 9 turbo points of the 5 setups = 200, highest rpm first; scalars untouched'),
    button('tune-ramp', 'ramp', 'ECU/turbo rise from 100 at the lowest rpm to 200 at the highest'),
    button('tune-stock', 'stock', 'all 9 ECU + 9 turbo points back to 100 (neutral)'),
    button('tune-save', 'save as preset'),
  ));

  const select = document.createElement('select');
  select.className = 'pick';
  select.dataset.act = 'tune-apply';
  select.dataset.slot = String(slot.index);
  const names = Object.keys(state.tunes);
  const none = document.createElement('option');
  none.value = '';
  none.textContent = names.length ? 'apply preset…' : 'no presets yet';
  select.appendChild(none);
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.disabled = names.length === 0;

  td.append(line(
    label('gold'),
    value(`uniques ${uniques}/9`),
    ' ',
    button('uniques-on', 'all'),
    button('uniques-off', 'none'),
    select,
  ));

  tr.appendChild(td);
  return tr;
}

function toggleRow(label, expandable) {
  const tr = document.createElement('tr');
  tr.className = 'rowtoggle';
  if (expandable) tr.dataset.toggleEmpty = '1';
  const td = document.createElement('td');
  td.colSpan = 5;
  td.textContent = label;
  tr.appendChild(td);
  return tr;
}

/* "9-25" / "9, 11-13" — keeps the empty tail on one line. */
function rangeLabel(nums) {
  if (!nums.length) return '';
  const parts = [];
  let start = nums[0];
  let prev = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === prev + 1) {
      prev = nums[i];
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = nums[i];
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(', ');
}

function renderReport() {
  const save = state.save;
  if (!save) {
    el.report.hidden = true;
    return;
  }
  el.report.hidden = false;

  const isZip = state.kind === 'zip';
  const rename = pendingRename();
  el.reportTitle.textContent = isZip ? (rename ? rename.profile : state.entry.name) : state.file.name;
  el.reportMeta.textContent = isZip
    ? `backup · ${state.zip.entries.length} entries${rename ? ' · renames on download' : ''}`
    : 'bare profile';

  const c = save.checksums();
  const ok = c.a && c.b && c.h;
  const career = save.slots();
  const garage = state.garage;
  const garageSlots = garage && garage.slots ? garage.slots : [];
  const all = career.concat(garageSlots);
  const careerUsed = career.filter((s) => s.used).length;
  const garageUsed = garageSlots.filter((s) => s.used).length;
  const used = careerUsed + garageUsed;

  const rows = [
    kvRow('file', `career save · ${save.size.toLocaleString('en-US')} B · compat ${N.hex(save.compat, 3)}`),
    kvRow('blocks', `A ${save.lenA} · B ${save.lenB}`),
    kvRow('checksums', crcCell(c), ok ? 'v--ok' : 'v--warn'),
    kvRow('driver', save.name || '(empty)'),
    kvRow('stage', `${save.stage} · ${N.STAGE_NAMES[save.stage] || 'unknown'}`),
    kvRow('progress', `${save.stages().filter(Boolean).length} / ${save.stages().length} stages complete`),
    kvRow('money', N.moneyText(save.money), 'v--money'),
    kvRow('events', `${save.events} active entries`),
    kvRow('cars', garageSlots.length
      ? `${used} / ${all.length} in use · ${careerUsed} career · ${garageUsed} garage`
      : `${careerUsed} / ${career.length} in use`),
  ];

  if (garage && garage.version) {
    const shape = `${garage.count} × ${garage.recordLength} B`;
    const paired = garage.fingerprint === N.garageFingerprint(save.bytes);
    const pairing = paired ? 'paired' : (state.garageBytes ? 're-links on download' : 'stale fingerprint');
    rows.push(kvRow('garage', `v${garage.version} · ${shape} · ${pairing}`, paired ? '' : 'v--warn'));
  } else if (garage && garage.error) {
    rows.push(kvRow('garage', `unusable: ${garage.error}`, 'v--warn'));
  } else {
    rows.push(kvRow('garage', 'no GARAGE.DAT in this save', 'v--idle'));
  }

  el.kvBody.replaceChildren(...rows);

  el.carsHead.textContent = garageSlots.length
    ? `cars · ${used} of ${all.length} in use · click a car`
    : 'cars';

  const body = [];

  const addGroup = (label, list) => {
    body.push(groupRow(label));
    const empty = list.filter((s) => !s.used);
    for (const slot of list) {
      if (!slot.used) continue;
      body.push(carRow(slot));
      if (state.detailSlot === slot.index) {
        const detail = detailRow(slot);
        if (detail) body.push(detail);
        const tune = tuneRow(slot);
        if (tune) body.push(tune);
        const arrange = arrangeRow(slot);
        if (arrange) body.push(arrange);
      }
    }
    if (!empty.length) return;
    if (state.showEmpty) {
      for (const slot of empty) body.push(carRow(slot));
      body.push(toggleRow(`[−] hide ${empty.length} empty slot${empty.length === 1 ? '' : 's'}`, true));
    } else {
      body.push(toggleRow(
        `[+] ${empty.length} empty · slot${empty.length === 1 ? '' : 's'} ${rangeLabel(empty.map((s) => s.index))}`,
        true,
      ));
    }
  };

  addGroup(`career save · slots 1-${career.length}`, career);
  if (garageSlots.length) {
    addGroup(
      `garage file · slots ${N.GARAGE_FIRST_SLOT}-${N.GARAGE_FIRST_SLOT + garageSlots.length - 1}`,
      garageSlots,
    );
  }
  el.carsBody.replaceChildren(...body);
}

/* ---------- editor ---------- */
function showEditor(on) {
  el.editor.hidden = !on;
  el.drop.classList.toggle('is-compact', on);
  el.dropText.textContent = on
    ? 'drop another profile or backup .zip'
    : 'drop a career profile or a backup .zip here';
  el.dropHint.hidden = on;
  if (!on) return;
  const save = state.save;
  el.money.value = String(save.money);
  el.name.value = save.name;
  el.stage.value = String(save.stage);
  for (const input of [el.money, el.name, el.stage]) input.classList.remove('is-dirty');
  updateStatus();
}

function updateStatus() {
  const save = state.save;
  if (!save) {
    el.statusFile.textContent = 'no file';
    el.statusCrc.textContent = 'crc ·';
    el.statusCrc.className = 'footer__item';
    el.pending.textContent = '';
    return;
  }
  const label = state.kind === 'zip' ? state.entry.name : state.file.name;
  const c = save.checksums();
  const ok = c.a && c.b && c.h;
  el.statusFile.textContent = label;
  el.statusCrc.textContent = `crc ${ok ? 'ok' : 'BAD'}`;
  el.statusCrc.className = `footer__item ${ok ? 'footer__ok' : ''}`.trim();

  const ranges = N.changedRanges(state.original, save.bytes);
  const total = ranges.reduce((n, [s, e]) => n + (e - s), 0);
  const garageChanged = state.garageBytes && state.garageOriginal
    ? N.changedRanges(state.garageOriginal, state.garageBytes).reduce((n, [s, e]) => n + (e - s), 0)
    : 0;
  const bits = [];
  if (total) bits.push(`${total} B in the save · ${ranges.map(([s, e]) => `${N.hex(s, 5)}+${e - s}`).join(' ')}`);
  if (garageChanged) bits.push(`${garageChanged} B in GARAGE.DAT`);
  el.pending.textContent = bits.length ? bits.join(' · ') : 'no changes yet';
}

function resetState() {
  state.file = null;
  state.kind = null;
  state.zip = null;
  state.entry = null;
  state.garage = null;
  state.garageBytes = null;
  state.garageOriginal = null;
  state.garageEntry = null;
  state.original = null;
  state.save = null;
  state.showEmpty = false;
  state.detailSlot = null;
}

function commit(label, apply, opts = {}) {
  const save = state.save;
  if (!save) return false;
  try {
    apply(save);
    save.fixChecksums();
    const c = save.checksums();
    if (!(c.a && c.b && c.h)) throw new N.SaveError('checksums failed to settle');
    const ranges = N.changedRanges(state.original, save.bytes);
    const total = ranges.reduce((n, [s, e]) => n + (e - s), 0);

    const carsIntact = sameRegion(state.original, save.bytes, CAR_RECORDS);
    const fpIntact = state.garage && state.garage.fingerprint !== undefined
      ? N.garageFingerprint(save.bytes) === state.garage.fingerprint
      : null;

    say(`$ ${label}`, 'cmd');
    say(`  ok · ${N.crcText(c)}`, 'ok');
    if (opts.car) {
      const relink = state.garageBytes ? ' · garage fingerprint re-links on download' : '';
      say(`  car record written${relink}`, 'dim');
    } else if (carsIntact) {
      say(
        `  cars untouched · 0x5868..0x8022`
        + (fpIntact === null ? '' : ` · garage ${fpIntact ? 'still paired' : 'FINGERPRINT CHANGED'}`),
        'dim',
      );
    } else {
      say('  CARS CHANGED unexpectedly - do not download this file', 'err');
    }
    if (total) say(`  ${total} B differ from the file you loaded`, 'dim');
    renderReport();
    updateStatus();
    return true;
  } catch (err) {
    say(`error: ${err.message}`, 'err');
    return false;
  }
}

/* ---------- rearrange ---------- */
function commitSwap(label, mutate) {
  const save = state.save;
  if (!save) return false;
  try {
    const saveBefore = save.bytes.slice();
    const garageBefore = state.garageBytes ? state.garageBytes.slice() : null;
    mutate();
    const saveChanged = N.changedRanges(saveBefore, save.bytes).length > 0;
    if (saveChanged) save.fixChecksums();
    const checks = save.checksums();
    if (!(checks.a && checks.b && checks.h)) throw new N.SaveError('checksums failed to settle');
    const garageChanged = garageBefore ? N.changedRanges(garageBefore, state.garageBytes).length > 0 : false;
    if (garageChanged) refreshGarage();
    say(`$ ${label}`, 'cmd');
    say(`  ok · ${N.crcText(checks)}`, 'ok');
    const parts = [];
    if (saveChanged) parts.push('career save written');
    if (garageChanged) parts.push('GARAGE.DAT written');
    say(`  ${parts.join(' · ')}${saveChanged && state.garageBytes ? ' · fingerprint re-links on download' : ''}`, 'dim');
    renderReport();
    updateStatus();
    return true;
  } catch (err) {
    say(`error: ${err.message}`, 'err');
    return false;
  }
}

function swapCars(from, to) {
  if (!from || !to || from === to) return;
  const a = carTarget(from);
  const b = carTarget(to);
  if (!a || !b) {
    say('error: that slot is not in this save', 'err');
    return;
  }
  const handles = [N.slotHandle(a.bytes, a.base), N.slotHandle(b.bytes, b.base)];
  state.detailSlot = to;
  commitSwap(`swap slot ${from} <-> ${to}`, () => {
    N.swapRecords(a, b);
    if (state.garageBytes && (a.garage || b.garage)) {
      const moved = N.retargetGarageHandles(state.garageBytes, handles[0], handles[1]);
      if (moved) say(`  GARAGE.DAT header pointer${moved === 1 ? '' : 's'} follow the car (${moved})`, 'dim');
    }
  });
}

/* ---------- tuning actions ---------- */
function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/* Garage records live in GARAGE.DAT, which has no checksums of its own. The
   career fingerprint hashes only the career save, so a garage write needs no
   re-link - it just has to travel in the rebuilt archive. */
function commitGarage(label, mutate) {
  if (!state.garageBytes || !state.garageEntry) {
    say('error: this save has no GARAGE.DAT', 'err');
    return false;
  }
  try {
    const bytes = state.garageBytes.slice();
    mutate(bytes);
    state.garageBytes = bytes;
    say(`$ ${label}`, 'cmd');
    say('  ok · GARAGE.DAT written (that file carries no checksums)', 'ok');
    if (state.garageOriginal) {
      const changed = N.changedRanges(state.garageOriginal, bytes).reduce((n, [s, e]) => n + (e - s), 0);
      if (changed) say(`  ${changed} B differ in GARAGE.DAT`, 'dim');
    }
    renderReport();
    updateStatus();
    return true;
  } catch (err) {
    say(`error: ${err.message}`, 'err');
    return false;
  }
}

function handleTuneAct(act, slotIndex) {
  if (!state.save || !slotIndex) return;
  if (act === 'tune-save') {
    saveTunePreset(slotIndex);
    return;
  }
  const garage = isGarageSlot(slotIndex);
  const base = garage ? N.garageBase(slotIndex) : 0;

  if (act === 'tune-max') {
    const label = `dyno max (ecu + turbo) · slot ${slotIndex}`;
    if (garage) commitGarage(label, (b) => N.fillCurvesAt(b, base, N.MAX_TUNE_BYTE));
    else commit(label, (s) => s.fillCurves(slotIndex, N.MAX_TUNE_BYTE), { car: true });
  } else if (act === 'tune-ramp') {
    const label = `dyno ramp (neutral -> max at high rpm) · slot ${slotIndex}`;
    if (garage) commitGarage(label, (b) => N.fillRampAt(b, base));
    else commit(label, (s) => s.fillCurveRamp(slotIndex), { car: true });
  } else if (act === 'tune-stock') {
    const label = `dyno neutral (ecu + turbo) · slot ${slotIndex}`;
    if (garage) commitGarage(label, (b) => N.fillCurvesAt(b, base, N.NEUTRAL_BYTE));
    else commit(label, (s) => s.fillCurves(slotIndex, N.NEUTRAL_BYTE), { car: true });
  } else if (act === 'uniques-on') {
    const label = `uniques all · slot ${slotIndex}`;
    if (garage) commitGarage(label, (b) => N.setUniquesAt(b, base, true));
    else commit(label, (s) => s.setUniques(slotIndex, true), { car: true });
  } else if (act === 'uniques-off') {
    const label = `uniques none · slot ${slotIndex}`;
    if (garage) commitGarage(label, (b) => N.setUniquesAt(b, base, false));
    else commit(label, (s) => s.setUniques(slotIndex, false), { car: true });
  }
}

function saveTunePreset(slotIndex) {
  const tune = carTune(slotIndex);
  if (!tune) return;
  const slots = [
    ...(state.save ? state.save.slots() : []),
    ...(state.garage && state.garage.slots ? state.garage.slots : []),
  ];
  const slot = slots.find((s) => s.index === slotIndex);
  if (!slot) return;
  const name = `${N.carLabel(slot.carType) || 'car'} · slot ${slotIndex}`;
  state.tunes[name] = {
    tune: bytesToHex(tune.block),
    uniques: tune.uniques.slice(),
  };
  try {
    localStorage.setItem(TUNES_KEY, JSON.stringify(state.tunes));
  } catch (err) {
    say(`error: could not store the preset (${err.message})`, 'err');
    return;
  }
  say(`$ save tune "${name}"`, 'cmd');
  say('  kept in this browser · pick it from any car\'s apply preset list', 'dim');
  renderReport();
}

function applyTunePreset(name, slotIndex) {
  const preset = state.tunes[name];
  if (!preset) return;
  const block = hexToBytes(preset.tune);
  if (block.length !== N.SETUP_COUNT * N.SETUP_SIZE) {
    say(`error: preset "${name}" is damaged`, 'err');
    return;
  }
  const label = `apply tune "${name}" · slot ${slotIndex}`;
  if (isGarageSlot(slotIndex)) {
    const base = N.garageBase(slotIndex);
    commitGarage(label, (b) => {
      N.writeTuneAt(b, base, block);
      N.writeUniquesAt(b, base, preset.uniques);
    });
  } else {
    commit(label, (s) => {
      s.writeTune(slotIndex, block);
      s.writeUniques(slotIndex, preset.uniques);
    }, { car: true });
  }
}

/* ---------- download ---------- */
async function download() {
  const save = state.save;
  if (!save) return;
  try {
    if (state.kind === 'zip') {
      const replacements = new Map([[state.entry.name, save.bytes]]);
      let relinked = false;
      let garageDirty = false;
      let garageBytes = state.garageBytes;
      if (garageBytes && state.garageOriginal) {
        garageDirty = N.changedRanges(state.garageOriginal, garageBytes).length > 0;
      }
      if (garageBytes && state.garageEntry && state.garage && state.garage.fingerprint !== undefined) {
        const fingerprint = N.garageFingerprint(save.bytes);
        if (fingerprint !== state.garage.fingerprint) {
          garageBytes = N.writeGarageFingerprint(garageBytes, fingerprint);
          state.garage.fingerprint = fingerprint;
          garageDirty = true;
          relinked = true;
        }
      }
      if (garageDirty && state.garageEntry) {
        state.garageBytes = garageBytes;
        replacements.set(state.garageEntry, garageBytes);
      }
      const rename = pendingRename();
      if (rename && state.zip.entries.some((e) => e.name === rename.profile && e.name !== state.entry.name)) {
        say(`error: this backup already has a profile named "${rename.name}"`, 'err');
        return;
      }
      let renames = null;
      let companion = 0;
      if (rename) {
        const oldName = state.entry.name.split('/').slice(-1)[0];
        renames = new Map([[state.entry.name, rename.profile]]);
        if (state.garageEntry && rename.garage) renames.set(state.garageEntry, rename.garage);
        for (const e of state.zip.entries) {
          if (renames.has(e.name)) continue;
          const next = renamePath(e.name, oldName, rename.name);
          if (next !== e.name) renames.set(e.name, next);
        }

        /* The old name is also stored inside companion files: settings.ini's
           roam_name, autosave-profiles.txt, the mod's own text files, and
           zero-padded fields in gamefile.bin. Patch those contents too. */
        for (const e of state.zip.entries) {
          const isText = /\.(?:txt|ini|json)$/i.test(e.name);
          const isBin = /(?:^|\/)gamefile\.bin$/i.test(e.name);
          if (!isText && !isBin) continue;
          const bytes = replacements.get(e.name) || await N.entryBytes(state.zip, e);
          const next = isText
            ? N.replaceNameInText(bytes, oldName, rename.name)
            : N.replaceNameInBinary(bytes, oldName, rename.name);
          if (next) {
            replacements.set(e.name, next);
            companion += 1;
          }
        }
      }
      if (el.clearRoam.checked) {
        const settingsEntry = state.zip.entries.find((e) => /(^|\/)settings\.ini$/i.test(e.name));
        if (settingsEntry) {
          const bytes = replacements.get(settingsEntry.name) || await N.entryBytes(state.zip, settingsEntry);
          const cleared = N.clearRoamOverrides(bytes);
          if (cleared) {
            replacements.set(settingsEntry.name, cleared.bytes);
            say(`  cleared ${cleared.removed.join(', ')} from settings.ini`, 'ok');
          }
        }
      }
      const blob = N.buildZip(state.zip, replacements, renames);
      const name = state.file.name.replace(/\.zip$/i, '') + '-edited.zip';
      saveAs(blob, name);
      say(`$ download ${name}`, 'cmd');
      say('  every other entry is copied through untouched', 'dim');
      if (relinked) say('  GARAGE.DAT fingerprint re-linked to the edited profile', 'ok');
      if (garageDirty && !relinked) say('  GARAGE.DAT carried through with its tuning edits', 'ok');
      if (rename) {
        say(`  renamed ${renames.size} entr${renames.size === 1 ? 'y' : 'ies'} -> ${rename.profile}`, 'ok');
        if (companion) say(`  replaced the old name inside ${companion} companion file(s)`, 'ok');
        for (const e of state.zip.entries) {
          const next = renames.get(e.name);
          if (next) e.name = next;
        }
        if (state.garageEntry && rename.garage) state.garageEntry = rename.garage;
        renderReport();
      }
    } else {
      const name = state.file.name + '-edited';
      saveAs(new Blob([save.bytes], { type: 'application/octet-stream' }), name);
      say(`$ download ${name}`, 'cmd');
    }
    say(`  ${N.moneyText(save.money)} · ${N.crcText(save.checksums())}`, 'ok');
    updateStatus();
  } catch (err) {
    say(`error: ${err.message}`, 'err');
  }
}

function saveAs(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- wiring ---------- */
el.drop.addEventListener('click', () => el.file.click());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); }
});
el.file.addEventListener('change', () => {
  if (el.file.files && el.file.files[0]) loadFile(el.file.files[0]);
  el.file.value = '';
});

document.addEventListener('dragenter', (e) => { e.preventDefault(); el.drop.classList.add('is-over'); });
document.addEventListener('dragover', (e) => { e.preventDefault(); el.drop.classList.add('is-over'); });
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return;
  el.drop.classList.remove('is-over');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('is-over');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

el.applyMoney.addEventListener('click', () => {
  try {
    const value = N.parseMoneyInput(el.money.value);
    const done = commit(`set money ${N.moneyText(value)}`, (save) => save.setMoney(value));
    if (done) {
      el.money.value = String(state.save.money);
      el.money.classList.remove('is-dirty');
    }
  } catch (err) {
    say(`error: ${err.message}`, 'err');
  }
});
el.money.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.applyMoney.click(); });
el.money.addEventListener('input', () => el.money.classList.add('is-dirty'));

el.presets.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-money]');
  if (!btn || !state.save) return;
  el.money.value = btn.dataset.money;
  el.applyMoney.click();
});

el.applyName.addEventListener('click', () => {
  const value = el.name.value;
  try {
    const done = commit(`rename ${value}`, (save) => save.setName(value));
    if (done) {
      el.name.value = state.save.name;
      el.name.classList.remove('is-dirty');
      const rename = pendingRename();
      if (rename) say(`  profile folder becomes ${rename.profile} on download`, 'dim');
    }
  } catch (err) {
    say(`error: ${err.message}`, 'err');
  }
});
el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.applyName.click(); });
el.name.addEventListener('input', () => el.name.classList.add('is-dirty'));

el.applyStage.addEventListener('click', () => {
  const value = Number(el.stage.value);
  try {
    const done = commit(`set stage ${value}`, (save) => save.setStage(value));
    if (done) {
      el.stage.value = String(state.save.stage);
      el.stage.classList.remove('is-dirty');
    }
  } catch (err) {
    say(`error: ${err.message}`, 'err');
  }
});
el.stage.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.applyStage.click(); });
el.stage.addEventListener('input', () => el.stage.classList.add('is-dirty'));

el.download.addEventListener('click', download);

el.carsBody.addEventListener('click', (e) => {
  if (e.target.closest('button[data-act="swap"]')) {
    const row = e.target.closest('tr');
    const select = row.querySelector('select[data-swap-from]');
    if (select) swapCars(Number(select.dataset.swapFrom), Number(select.value));
    return;
  }
  const act = e.target.closest('button[data-act]');
  if (act) {
    handleTuneAct(act.dataset.act, Number(act.dataset.slot));
    return;
  }
  const car = e.target.closest('tr.carrow');
  if (car) {
    const index = Number(car.dataset.slot);
    state.detailSlot = state.detailSlot === index ? null : index;
    renderReport();
    return;
  }
  if (e.target.closest('tr[data-toggle-empty]')) {
    state.showEmpty = !state.showEmpty;
    renderReport();
  }
});

el.carsBody.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-act="tune-apply"]');
  if (!sel || !sel.value) return;
  applyTunePreset(sel.value, Number(sel.dataset.slot));
});

el.revert.addEventListener('click', () => {
  if (!state.original) return;
  state.save = new N.CareerSave(state.original.slice());
  say('$ revert', 'cmd');
  say('  back to the bytes you loaded', 'dim');
  showEditor(true);
  renderReport();
});

el.reset.addEventListener('click', () => {
  resetState();
  showEditor(false);
  renderReport();
  say('$ unload', 'cmd');
  say('  drop another save whenever', 'dim');
  updateStatus();
});

el.navHelp.addEventListener('click', (e) => {
  e.preventDefault();
  say('');
  say('help', 'hl');
  say('  drop the profile file (no extension, 54,966 B) or the whole backup .zip', 'dim');
  say('  money    int32 at 0x0A16A, 0..2,147,483,647; the three CRCs are recomputed', 'dim');
  say('  driver   Latin-1, up to 31 bytes, at 0x0D225', 'dim');
  say('  stage    0 intro · 1-5 career · 6 post-career, at 0x0A175', 'dim');
  say('  garage   GARAGE.DAT is never rewritten; the money sits outside its fingerprint', 'dim');
  say("  restore  Saves → Restore on nfsu2mod.xyz, then keep this browser's saves", 'dim');
});

/* ---------- boot ---------- */
el.clearRoam.checked = localStorage.getItem('nfsu2save.clearRoam') !== 'off';
el.clearRoam.addEventListener('change', () => {
  localStorage.setItem('nfsu2save.clearRoam', el.clearRoam.checked ? 'on' : 'off');
});
say('$ nfsu2save', 'cmd');
say('  this tab only · nothing uploaded · every edit re-checksums the container', 'dim');
updateStatus();
