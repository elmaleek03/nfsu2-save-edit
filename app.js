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
  original: null,  // untouched profile bytes
  save: null,      // working copy
  showEmpty: false, // reveal empty car slots in the report
  detailSlot: null, // slot number whose per-car detail is open
};

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
  if (garageEntry) {
    try {
      garage = N.readGarage(await N.entryBytes(zip, garageEntry));
      if (garage) garage.paired = garage.fingerprint === N.fnv1a64(bytes, 36, 39266);
    } catch (err) {
      garage = { error: err.message };
    }
  }

  resetState();
  state.file = file;
  state.kind = 'zip';
  state.zip = zip;
  state.entry = pick;
  state.garage = garage;
  state.original = bytes.slice();
  state.save = save;

  say(`$ load ${file.name}`, 'cmd');
  say(`  ${zip.entries.length} entries · profile ${pick.name}`, 'dim');
  renderReport();
  showEditor(true);
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

function carState(slot) {
  if (!slot.used) return 'empty';
  if (slot.locked) return 'locked';
  if (!slot.bought) return 'not bought';
  return 'owned';
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
  const detail = state.save ? state.save.slotDetail(slot.index) : null;
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

function groupRow(label) {
  const tr = document.createElement('tr');
  tr.className = 'rowgroup';
  const td = document.createElement('td');
  td.colSpan = 5;
  td.textContent = label;
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
  el.reportTitle.textContent = isZip ? state.entry.name : state.file.name;
  el.reportMeta.textContent = isZip
    ? `backup · ${state.zip.entries.length} entries`
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
    rows.push(kvRow('garage', `v${garage.version} · ${shape} · ${garage.paired ? 'paired' : 'stale fingerprint'}`,
      garage.paired ? '' : 'v--warn'));
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
  el.pending.textContent = total
    ? `${total} B changed · ${ranges.map(([s, e]) => `${N.hex(s, 5)}+${e - s}`).join(' ')}`
    : 'no changes yet';
}

function resetState() {
  state.file = null;
  state.kind = null;
  state.zip = null;
  state.entry = null;
  state.garage = null;
  state.original = null;
  state.save = null;
  state.showEmpty = false;
  state.detailSlot = null;
}

function commit(label, apply) {
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
      ? N.fnv1a64(save.bytes, FINGERPRINT_RANGE[0], FINGERPRINT_RANGE[1]) === state.garage.fingerprint
      : null;

    say(`$ ${label}`, 'cmd');
    say(`  ok · ${N.crcText(c)}`, 'ok');
    say(
      `  ${carsIntact ? 'cars untouched' : 'CARS CHANGED'} · 0x5868..0x8022`
      + (fpIntact === null ? '' : ` · garage ${fpIntact ? 'still paired' : 'FINGERPRINT BROKEN'}`),
      carsIntact && fpIntact !== false ? 'dim' : 'err',
    );
    if (total) say(`  ${total} B differ from the file you loaded`, 'dim');
    renderReport();
    updateStatus();
    return true;
  } catch (err) {
    say(`error: ${err.message}`, 'err');
    return false;
  }
}

/* ---------- download ---------- */
function download() {
  const save = state.save;
  if (!save) return;
  try {
    if (state.kind === 'zip') {
      const blob = N.buildZip(state.zip, state.entry.name, save.bytes);
      const name = state.file.name.replace(/\.zip$/i, '') + '-edited.zip';
      saveAs(blob, name);
      say(`$ download ${name}`, 'cmd');
      say('  every other entry is copied through untouched', 'dim');
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
say('$ nfsu2save', 'cmd');
say('  this tab only · nothing uploaded · every edit re-checksums the container', 'dim');
updateStatus();
