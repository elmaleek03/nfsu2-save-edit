'use strict';

/* =========================================================
   nfsu2save UI — terminal front end over core.js
   ========================================================= */

const N = window.NFSU2;

const state = {
  file: null,
  kind: null,      // 'profile' | 'zip'
  zip: null,
  entry: null,
  garage: null,
  original: null,  // untouched profile bytes
  save: null,      // working copy
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
  const slots = save.slots();
  const used = slots.filter((s) => s.used).length;

  const rows = [
    kvRow('file', `career save · ${save.size.toLocaleString('en-US')} B · compat ${N.hex(save.compat, 3)}`),
    kvRow('blocks', `A ${save.lenA} · B ${save.lenB}`),
    kvRow('checksums', crcCell(c), ok ? 'v--ok' : 'v--warn'),
    kvRow('driver', save.name || '(empty)'),
    kvRow('stage', `${save.stage} · ${N.STAGE_NAMES[save.stage] || 'unknown'}`),
    kvRow('money', N.moneyText(save.money), 'v--money'),
    kvRow('events', `${save.events} active entries`),
    kvRow('cars', `${used} / ${slots.length} slots in use`),
  ];

  const garage = state.garage;
  if (garage && garage.version) {
    const recs = garage.records ? ` · ${garage.records} B/record` : '';
    rows.push(kvRow('garage', `v${garage.version}${recs} · ${garage.paired ? 'paired' : 'stale fingerprint'}`,
      garage.paired ? '' : 'v--warn'));
  } else if (garage && garage.error) {
    rows.push(kvRow('garage', `unusable: ${garage.error}`, 'v--warn'));
  } else {
    rows.push(kvRow('garage', 'no GARAGE.DAT in this save', 'v--idle'));
  }

  el.kvBody.replaceChildren(...rows);

  el.carsBody.replaceChildren(...slots.map((slot) => {
    const state_ = carState(slot);
    const tr = document.createElement('tr');
    const cells = [
      ['k', String(slot.index), ''],
      ['v', slot.used ? N.hex(slot.carType, 8) : '—', slot.used ? 'v--hashed' : 'v--idle'],
      ['v', slot.used ? N.hex(slot.carKey, 8) : '—', slot.used ? '' : 'v--idle'],
      ['v', state_, state_ === 'empty' ? 'v--idle' : state_ === 'owned' ? '' : 'v--warn'],
    ];
    for (const [cls, text, extra] of cells) {
      const td = document.createElement('td');
      td.className = `${cls} ${extra}`.trim();
      td.textContent = text;
      tr.appendChild(td);
    }
    return tr;
  }));
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
    say(`$ ${label}`, 'cmd');
    say(`  ok · ${N.crcText(c)}`, 'ok');
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
