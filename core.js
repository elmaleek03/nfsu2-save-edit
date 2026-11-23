'use strict';

/* =========================================================
   nfsu2save core — no DOM, testable in node
   Career profiles, N2GA garages, and nfsu2-web backup zips.
   ========================================================= */

const NFSU2 = (() => {
  /* ---------- container checksum ----------
     Not a streaming CRC: the first four bytes of the range seed a big-endian
     register, inverted on entry and exit.  Same table the game uses.        */
  const POLY = 0x04c11db7;
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ POLY : c << 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function nfsu2Crc(d, start = 0, end = d.length) {
    if (end - start < 4) return 0;
    const first = ((d[start] << 24) | (d[start + 1] << 16) | (d[start + 2] << 8) | d[start + 3]) >>> 0;
    let r = ~first >>> 0;
    for (let i = start + 4; i < end; i++) r = (((r << 8) | d[i]) ^ TABLE[r >>> 24]) >>> 0;
    return ~r >>> 0;
  }

  /* ---------- career profile ---------- */
  const MAGIC = [0x32, 0x30, 0x43, 0x4d]; // the game's four-byte save tag
  const PROFILE_SIZE = 54966;
  const MAX_MONEY = 0x7fffffff;
  const OFF_LEN_A = 0x08;
  const OFF_LEN_B = 0x0c;
  const OFF_CRC_A = 0x10;
  const OFF_CRC_B = 0x14;
  const OFF_CRC_H = 0x18;
  const OFF_MONEY = 0xa16a;
  const OFF_STAGE = 0xa175;
  const OFF_EVENTS = 0xa179;
  const OFF_NAME = 0xd225;
  const NAME_FIELD = 32;
  const NAME_MAX = 31;
  const SLOT_BASE = 0x5870;
  const SLOT_STRIDE = 0x7f2;
  const SLOT_COUNT = 5;
  const STAGE_BASE = 0x9962;
  const STAGE_STRIDE = 0x101;
  const TUNING_OFF = 0x354;
  const SETUP_SIZE = 41;
  const SETUP_COUNT = 5;
  const ECU_OFF = 0x17;
  const TURBO_OFF = 0x20;
  const CURVE_POINTS = 9;
  const NEUTRAL_BYTE = 100;
  const MAX_TUNE_BYTE = 200;
  const SETUP_NAMES = ['Circuit', 'Drag', 'Drift', 'Street X', 'URL'];

  /* A car record is the same 2,034-byte shape in both files: the career save
     holds five at 0x5870, GARAGE.DAT holds one per slot from 32 + n*2034, eight
     bytes into each record. Everything below works from a payload base, so the
     dyno and unique code is shared. */
  const careerBase = (index) => SLOT_BASE + (index - 1) * SLOT_STRIDE;
  const garageBase = (index) => GARAGE_HEADER + (index - GARAGE_FIRST_SLOT) * GARAGE_RECORD + SLOT_PAYLOAD;

  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function readTuneAt(bytes, base) {
    if (base + SLOT_STRIDE > bytes.length) return null;
    const setups = [];
    for (let s = 0; s < SETUP_COUNT; s++) {
      const off = base + TUNING_OFF + s * SETUP_SIZE;
      setups.push({
        name: SETUP_NAMES[s],
        ecu: Array.from(bytes.subarray(off + ECU_OFF, off + ECU_OFF + CURVE_POINTS)),
        turbo: Array.from(bytes.subarray(off + TURBO_OFF, off + TURBO_OFF + CURVE_POINTS)),
      });
    }
    const v = viewOf(bytes);
    const uniques = [];
    for (let i = 0; i < 9; i++) uniques.push(v.getUint32(base + 0x2e8 + i * 4, true));
    return {
      setups,
      uniques,
      block: bytes.slice(base + TUNING_OFF, base + TUNING_OFF + SETUP_COUNT * SETUP_SIZE),
    };
  }

  function writeTuneAt(bytes, base, block) {
    if (block.length !== SETUP_COUNT * SETUP_SIZE) throw new SaveError('tuning block must be 205 bytes');
    if (base + SLOT_STRIDE > bytes.length) throw new SaveError('car record is outside this file');
    bytes.set(block, base + TUNING_OFF);
  }

  /* Only the 18 curve bytes of each setup move; the other 23 are scalars. */
  function fillCurvesAt(bytes, base, value) {
    if (base + SLOT_STRIDE > bytes.length) throw new SaveError('car record is outside this file');
    for (let s = 0; s < SETUP_COUNT; s++) {
      const off = base + TUNING_OFF + s * SETUP_SIZE;
      for (let i = CURVE_POINTS - 1; i >= 0; i--) {
        bytes[off + ECU_OFF + i] = value;
        bytes[off + TURBO_OFF + i] = value;
      }
    }
  }

  function fillRampAt(bytes, base) {
    if (base + SLOT_STRIDE > bytes.length) throw new SaveError('car record is outside this file');
    const step = (MAX_TUNE_BYTE - NEUTRAL_BYTE) / (CURVE_POINTS - 1);
    for (let s = 0; s < SETUP_COUNT; s++) {
      const off = base + TUNING_OFF + s * SETUP_SIZE;
      for (let i = 0; i < CURVE_POINTS; i++) {
        const v = Math.round(NEUTRAL_BYTE + step * i);
        bytes[off + ECU_OFF + i] = v;
        bytes[off + TURBO_OFF + i] = v;
      }
    }
  }

  function setUniquesAt(bytes, base, on) {
    if (base + SLOT_STRIDE > bytes.length) throw new SaveError('car record is outside this file');
    const v = viewOf(bytes);
    for (let i = 0; i < 9; i++) v.setUint32(base + 0x2e8 + i * 4, on ? 1 : 0, true);
  }

  function writeUniquesAt(bytes, base, values) {
    if (base + SLOT_STRIDE > bytes.length) throw new SaveError('car record is outside this file');
    const v = viewOf(bytes);
    for (let i = 0; i < 9; i++) v.setUint32(base + 0x2e8 + i * 4, values[i] >>> 0, true);
  }

  function readDetailAt(bytes, base) {
    if (base + SLOT_STRIDE > bytes.length) return null;
    const v = viewOf(bytes);
    let parts = 0;
    for (let i = 0; i < 170; i++) if (v.getUint32(base + 0x18 + i * 4, true) !== 0) parts += 1;
    let items = 0;
    for (let i = 0; i < 68; i++) if (bytes[base + 0x310 + i] !== 0) items += 1;
    let uniques = 0;
    for (let i = 0; i < 9; i++) if (v.getUint32(base + 0x2e8 + i * 4, true) !== 0) uniques += 1;
    let dyno = 0;
    for (let i = 0; i < 5; i++) {
      const start = base + 0x354 + i * 41;
      for (let j = 0; j < 41; j++) {
        if (bytes[start + j] !== 0) {
          dyno += 1;
          break;
        }
      }
    }
    return {
      value: v.getUint32(base + 0x6be, true),
      parts,
      items,
      uniques,
      dyno,
      handle: v.getUint32(base - 4, true),
    };
  }
  const STAGE_NAMES = [
    'intro / arrival',
    'city core',
    'beacon hill',
    'jackson heights',
    'coal harbor west',
    'coal harbor east',
    'post-career (all barriers open)',
  ];

  class SaveError extends Error {}

  class CareerSave {
    constructor(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new SaveError('not a byte buffer');
      if (bytes.length < 0x1c) throw new SaveError('file is smaller than the save header');
      if (!MAGIC.every((b, i) => bytes[i] === b)) throw new SaveError('not a career save (unexpected tag)');
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const stored = this.view.getUint32(0x04, true);
      if (stored !== bytes.length) throw new SaveError(`header says ${stored} bytes, file is ${bytes.length}`);
      this.lenA = this.view.getUint32(OFF_LEN_A, true);
      this.lenB = this.view.getUint32(OFF_LEN_B, true);
      this.blockA = [0x1c, 0x1c + this.lenA];
      this.blockB = [this.blockA[1], this.blockA[1] + this.lenB];
      if (this.blockB[1] !== bytes.length) throw new SaveError('block lengths do not add up to the file size');
    }

    get size() { return this.bytes.length; }
    get compat() { return this.view.getUint32(0x1c, true); }
    get money() { return this.view.getInt32(OFF_MONEY, true); }
    get stage() { return this.view.getUint32(OFF_STAGE, true); }
    get events() { return this.view.getUint32(OFF_EVENTS, true); }

    checksums() {
      return {
        a: nfsu2Crc(this.bytes, this.blockA[0], this.blockA[1]) === this.view.getUint32(OFF_CRC_A, true),
        b: nfsu2Crc(this.bytes, this.blockB[0], this.blockB[1]) === this.view.getUint32(OFF_CRC_B, true),
        h: nfsu2Crc(this.bytes, 0, OFF_CRC_H) === this.view.getUint32(OFF_CRC_H, true),
      };
    }

    fixChecksums() {
      this.view.setUint32(OFF_CRC_A, nfsu2Crc(this.bytes, this.blockA[0], this.blockA[1]), true);
      this.view.setUint32(OFF_CRC_B, nfsu2Crc(this.bytes, this.blockB[0], this.blockB[1]), true);
      this.view.setUint32(OFF_CRC_H, nfsu2Crc(this.bytes, 0, OFF_CRC_H), true);
    }

    setMoney(value) {
      if (!Number.isInteger(value) || value < 0 || value > MAX_MONEY) {
        throw new SaveError(`money must be a whole number from 0 to ${MAX_MONEY}`);
      }
      this.view.setInt32(OFF_MONEY, value, true);
    }

    setStage(value) {
      if (!Number.isInteger(value) || value < 0 || value > 6) throw new SaveError('stage must be 0..6');
      this.view.setUint32(OFF_STAGE, value, true);
    }

    get name() {
      const raw = this.bytes.subarray(OFF_NAME, OFF_NAME + NAME_FIELD);
      const end = raw.indexOf(0);
      const slice = end < 0 ? raw : raw.subarray(0, end);
      let out = '';
      for (const b of slice) out += String.fromCharCode(b);
      return out;
    }

    setName(text) {
      if (typeof text !== 'string' || text.length === 0) throw new SaveError('name cannot be empty');
      if (/[\\/:*?"<>|\x00-\x1f]/.test(text)) {
        throw new SaveError('name cannot contain \\ / : * ? " < > | or control characters');
      }
      const codes = [...text].map((ch) => ch.codePointAt(0));
      if (codes.some((c) => c > 0xff)) throw new SaveError('name may only use Latin-1 characters');
      if (codes.length > NAME_MAX) throw new SaveError(`name is limited to ${NAME_MAX} characters`);
      /* The save keeps the name in the 32-byte driver field and again in two
         20-byte spans of the auxiliary object at 0xD250 and 0xD264. All three
         are zero-padded, and the game reads the spans in places (profile lists,
         messages), so they have to move together. */
      for (const [offset, width] of [[OFF_NAME, NAME_FIELD], [0xd250, 20], [0xd264, 20]]) {
        for (let i = 0; i < width; i++) this.bytes[offset + i] = i < codes.length ? codes[i] : 0;
      }
    }

    slots() {
      const out = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        const base = SLOT_BASE + i * SLOT_STRIDE;
        if (base + SLOT_STRIDE > this.size) break;
        out.push({
          index: i + 1,
          used: this.view.getUint16(base + 0x27c, true) !== 0,
          carType: this.view.getUint32(base + 0x14, true),
          carKey: this.view.getUint32(base + 0x2bc, true),
          locked: this.bytes[base + 0x428] !== 0,
          bought: this.bytes[base + 0x429] !== 0,
        });
      }
      return out;
    }

    /* Per-slot numbers that are read-only for now: what was spent on the car,
       how much of it is non-default, and its CAREER_SLOT handle. */
    slotDetail(index) {
      return readDetailAt(this.bytes, careerBase(index));
    }

    /* Stage completion: eight 0x101-byte records at 0x9962, stage i's record
       holding 1 at +0xFC once the stage is done. Only 0-5 are used; verified
       against a stage-0 save (all zero) and a stage-6 save (all one). */
    stages() {
      const out = [];
      for (let i = 0; i < 6; i++) {
        const base = STAGE_BASE + i * STAGE_STRIDE;
        if (base + STAGE_STRIDE > this.size) break;
        out.push(this.bytes[base + 0xfc] === 1);
      }
      return out;
    }

    /* Dyno and uniques, shared with the garage records through the base helpers. */
    slotTune(index) {
      return readTuneAt(this.bytes, careerBase(index));
    }

    writeTune(index, block) {
      writeTuneAt(this.bytes, careerBase(index), block);
    }

    fillCurves(index, value) {
      fillCurvesAt(this.bytes, careerBase(index), value);
    }

    fillCurveRamp(index) {
      fillRampAt(this.bytes, careerBase(index));
    }

    setUniques(index, on) {
      setUniquesAt(this.bytes, careerBase(index), on);
    }

    writeUniques(index, values) {
      writeUniquesAt(this.bytes, careerBase(index), values);
    }
  }

  /* ---------- car names ----------
     A car type is bStringHash(car asset name): h = 0xFFFFFFFF, then h = h*33 +
     byte per character, uppercase. The names below are the CARS\<name> folders
     the game loads (stock cars plus this build's add-ons), harvested from the
     game data, so a lookup either resolves exactly or not at all. */
  const CAR_NAMES = [
    '200SXS14A', '240SX', '3000GT', '300ZX', '350Z', '4DR_SEDAN', '4DR_SEDAN02', '959', '996', 'A3',
    'ACCORD', 'AMBULANCE', 'BB6', 'BMW850', 'BOXSTER986', 'BUS', 'CELICA', 'CELICAT205', 'CHARGER',
    'CIVIC', 'CIVICEG', 'CIVICEK9', 'COBRA', 'COROLLA', 'CORSA', 'CORVETTEC5', 'COUPE', 'CRXDS',
    'CRXSIR', 'E36', 'ECLIPSE', 'ECLIPSE03', 'ELISE', 'ESCALADE', 'ESCORT', 'EVO9IX', 'FAIRZ',
    'FIRETRUCK', 'FOCUS', 'FTOGPR', 'G35', 'G55', 'GOLF', 'GS300', 'GT86ZN', 'GTI3', 'GTO',
    'HATCHBACK', 'HATCHBACK02', 'HUMMER', 'IF', 'IMPALA', 'IMPREZA', 'IMPREZAWRX', 'INFIFX45',
    'INTEGRA', 'IS300', 'LANCER', 'LANCEREVO4', 'LANCEREVO8', 'LEONCP', 'LFA', 'LOCK', 'M3GTR',
    'MERC560SE', 'MIATA', 'MINIVAN', 'MR2AW1', 'MRS', 'MUSTANGGT', 'NAVIGATOR', 'NEONC', 'NSX',
    'NSX91', 'PANELVAN', 'PARCELVAN', 'PEUGOT', 'PEUGOT106', 'PICKUP', 'R33', 'RSX', 'RX7', 'RX8',
    'S2000', 'SAVANNA', 'SC300Z30', 'SENTRA', 'SILVIA', 'SKYLINE', 'SUPRA', 'SUPRAGA70', 'SUV',
    'TAXI', 'TAXI02', 'TIBURON', 'TT', 'VIPER',
  ];

  /* Only the codes that read badly keep a short label; everything else shows
     the asset name the game itself uses. */
  const CAR_LABELS = {
    MERC560SE: '560 SEC',
    MR2AW1: 'MR2 AW11',
    E36: 'M3 E36',
    BB6: 'Prelude BB6',
    CELICAT205: 'Celica GT-Four',
    EVO9IX: 'Lancer Evo IX',
    LANCEREVO4: 'Lancer Evo IV',
    LANCEREVO8: 'Lancer Evo VIII',
    SUPRAGA70: 'Supra GA70',
    '200SXS14A': '200SX S14a',
    BOXSTER986: 'Boxster 986',
    CORVETTEC5: 'Corvette C5',
    IMPREZAWRX: 'Impreza WRX',
    MUSTANGGT: 'Mustang GT',
    CIVICEG: 'Civic EG6',
    CIVICEK9: 'Civic EK9',
    GTI3: 'Golf GTI Mk3',
    CRXDS: 'CRX del Sol',
    FTOGPR: 'FTO GP',
    INFIFX45: 'FX45',
    ECLIPSE03: 'Eclipse 03',
    NSX91: 'NSX NA1',
    PICKUP: 'pickup',
    '4DR_SEDAN': 'sedan',
    '4DR_SEDAN02': 'sedan 02',
  };

  function bStringHash(text) {
    let h = 0xffffffff;
    for (const ch of text) h = (Math.imul(h, 33) + ch.charCodeAt(0)) >>> 0;
    return h;
  }

  const CAR_BY_HASH = new Map(CAR_NAMES.map((name) => [bStringHash(name), name]));

  /** Asset name for a car type, or null when this build has no such car. */
  function carName(type) {
    return CAR_BY_HASH.get(type >>> 0) || null;
  }

  /** Short label for the table: the label if any, else the asset name. */
  function carLabel(type) {
    const name = carName(type);
    if (!name) return null;
    return CAR_LABELS[name] || name;
  }

  /* ---------- GARAGE.DAT ----------
     The file is a 32-byte header followed by one 2,034-byte record per garage
     slot. nfsu2-web writes 5 records (slots 6-10); the nfsu2mod fork writes 20
     (slots 6-25). Every record keeps its slot handle at +4 even when empty, and
     the career-slot payload starts 8 bytes into the record. */
  const GARAGE_HEADER = 32;
  const GARAGE_RECORD = 2034;
  const GARAGE_FIRST_SLOT = 6;
  const SLOT_PAYLOAD = 8;

  function fnv1a64(bytes, start, end) {
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let i = start; i < end; i++) h = ((h ^ BigInt(bytes[i])) * prime) & mask;
    return h;
  }

  /* ---------- roam overrides in settings.ini ----------
     The site reads keys like roam_block as NFSU2_ROAM_BLOCK. Values copied from
     another session (a block, a car count, a friend name) can follow you into a
     profile, so the editor can drop those lines and let the defaults apply. */
  const ROAM_KEYS = ['roam_block', 'roam_max_cars', 'roam_collide', 'roam_friends'];

  /** Removes the roam override lines; returns { bytes, removed } or null. */
  function clearRoamOverrides(bytes) {
    const text = latin1Text(bytes);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const kept = [];
    const removed = [];
    for (const line of text.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      const key = eq < 0 ? '' : line.slice(0, eq).trim().toLowerCase().replace(/^nfsu2_/, '');
      if (eq >= 0 && ROAM_KEYS.includes(key)) {
        removed.push(key);
      } else {
        kept.push(line);
      }
    }
    if (!removed.length) return null;
    return { bytes: latin1Bytes(kept.join(eol)), removed };
  }

  /** Fingerprint a career save the way nfsu2-web pairs it with GARAGE.DAT. */
  function garageFingerprint(careerBytes) {
    return fnv1a64(careerBytes, 36, 39266);
  }

  /* ---------- name references outside the save ----------
     The site and the mods also keep the profile name in text files (settings.ini
     roam_name, autosave-profiles.txt, the endless-career comments) and in
     zero-padded fields of gamefile.bin. These helpers rewrite them in place so a
     rename does not leave the old name behind. */
  function latin1Bytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function latin1Text(bytes) {
    let out = '';
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }

  /** Replaces whole-word occurrences in a latin-1 text blob; null when unchanged. */
  function replaceNameInText(bytes, from, to) {
    if (!from || from === to) return null;
    const text = latin1Text(bytes);
    let changed = false;
    const out = text.split(/([^A-Za-z0-9_]+)/).map((token) => {
      if (token === from) {
        changed = true;
        return to;
      }
      return token;
    }).join('');
    return changed ? latin1Bytes(out) : null;
  }

  /** Replaces occurrences inside zero-padded binary fields, keeping offsets.
      Returns new bytes, or null when nothing matched or a field is too narrow. */
  function replaceNameInBinary(bytes, from, to) {    if (!from || from === to) return null;
    const src = latin1Bytes(from);
    const dst = latin1Bytes(to);
    if (dst.length > src.length) return null;
    const out = bytes.slice();
    let hits = 0;
    for (let i = out.length - src.length; i >= 0; i--) {
      let match = true;
      for (let j = 0; j < src.length; j++) {
        if (out[i + j] !== src[j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const after = i + src.length;
      if (after < out.length && out[after] !== 0) continue;
      out.fill(0, i, after);
      out.set(dst, i);
      hits += 1;
      i -= src.length - 1;
    }
    return hits ? out : null;
  }

  /** Returns a copy of GARAGE.DAT with its pairing fingerprint rewritten. */
  function writeGarageFingerprint(garageBytes, fingerprint) {
    const out = garageBytes.slice();
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    v.setUint32(8, Number(fingerprint & 0xffffffffn), true);
    v.setUint32(12, Number((fingerprint >> 32n) & 0xffffffffn), true);
    return out;
  }

  function readGarage(bytes) {    if (bytes.length < GARAGE_HEADER + GARAGE_RECORD) return null;
    if (bytes[0] !== 0x4e || bytes[1] !== 0x32 || bytes[2] !== 0x47 || bytes[3] !== 0x41) return null;
    const body = bytes.length - GARAGE_HEADER;
    if (body % GARAGE_RECORD !== 0) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const low = BigInt(v.getUint32(8, true));
    const high = BigInt(v.getUint32(12, true));
    const count = body / GARAGE_RECORD;
    const slots = [];
    for (let i = 0; i < count; i++) {
      const p = GARAGE_HEADER + i * GARAGE_RECORD + SLOT_PAYLOAD;
      slots.push({
        index: GARAGE_FIRST_SLOT + i,
        used: v.getUint16(p + 0x27c, true) !== 0,
        carType: v.getUint32(p + 0x14, true),
        carKey: v.getUint32(p + 0x2bc, true),
        locked: bytes[p + 0x428] !== 0,
        bought: bytes[p + 0x429] !== 0,
      });
    }
    return {
      version: v.getUint32(4, true),
      fingerprint: (high << 32n) | low,
      recordLength: GARAGE_RECORD,
      count,
      slots,
    };
  }

  /* ---------- zip ---------- */
  const ZIP_LOCAL = 0x04034b50;
  const ZIP_CEN = 0x02014b50;
  const ZIP_EOCD = 0x06054b50;

  const ZIP_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function zipCrc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = ZIP_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function openZip(file) {
    const tailSize = Math.min(file.size, 0x10000 + 22);
    const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new SaveError('no zip end-of-central-directory record');

    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOffset = tail.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new SaveError('zip64 archives are not supported');
    }

    const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
    const cd = new DataView(cdBuf);
    const dec = new TextDecoder('utf-8');
    const entries = [];
    let p = 0;

    for (let i = 0; i < count; i++) {
      if (cd.getUint32(p, true) !== ZIP_CEN) throw new SaveError('corrupt zip central directory');
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      entries.push({
        name: dec.decode(new Uint8Array(cdBuf, p + 46, nameLen)),
        method: cd.getUint16(p + 10, true),
        time: cd.getUint16(p + 12, true),
        date: cd.getUint16(p + 14, true),
        crc: cd.getUint32(p + 16, true),
        csize: cd.getUint32(p + 20, true),
        usize: cd.getUint32(p + 24, true),
        local: cd.getUint32(p + 42, true),
        dataOffset: 0,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }

    for (const e of entries) {
      const lh = new DataView(await file.slice(e.local, e.local + 30).arrayBuffer());
      if (lh.getUint32(0, true) !== ZIP_LOCAL) throw new SaveError(`bad local header for ${e.name}`);
      e.dataOffset = e.local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    }

    return { file, entries };
  }

  function profileEntries(zip) {
    return zip.entries.filter((e) => {
      const segs = e.name.split('/');
      return !e.name.endsWith('/')
        && segs.length >= 2
        && segs[segs.length - 1] === segs[segs.length - 2]
        && e.usize === PROFILE_SIZE;
    });
  }

  async function entryBytes(zip, entry) {
    const blob = zip.file.slice(entry.dataOffset, entry.dataOffset + entry.csize);
    if (entry.method === 0) return new Uint8Array(await blob.arrayBuffer());
    if (entry.method !== 8) throw new SaveError(`unsupported compression in ${entry.name}`);
    if (typeof DecompressionStream !== 'function') throw new SaveError('this browser cannot inflate zip entries');
    const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* Rebuild the archive with one or more entries replaced.
     `replacements` is a Map of entry name -> Uint8Array, `renames` an optional
     Map of entry name -> new entry name (used for a profile rename). Untouched
     entries are sliced straight out of the original file, so a 400 MB backup
     never lands in RAM. */
  function buildZip(zip, replacements, renames) {
    const map = replacements instanceof Map ? replacements : new Map([[replacements, arguments[2]]]);
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of zip.entries) {
      const entryName = (renames && renames.get(e.name)) || e.name;
      const nameBytes = enc.encode(entryName);
      let method = e.method;
      let crc = e.crc;
      let csize = e.csize;
      let usize = e.usize;
      let payload;

      if (map.has(e.name)) {
        const bytes = map.get(e.name);
        method = 0;
        crc = zipCrc32(bytes);
        csize = usize = bytes.length;
        payload = new Blob([bytes]);
      } else {
        payload = zip.file.slice(e.dataOffset, e.dataOffset + e.csize);
      }

      const flags = 0x0800;
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, ZIP_LOCAL, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, flags, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, e.time, true);
      lv.setUint16(12, e.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, csize, true);
      lv.setUint32(22, usize, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      parts.push(local, payload);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, ZIP_CEN, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, flags, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, e.time, true);
      cv.setUint16(14, e.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, csize, true);
      cv.setUint32(24, usize, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += 30 + nameBytes.length + csize;
    }

    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, ZIP_EOCD, true);
    ev.setUint16(8, zip.entries.length, true);
    ev.setUint16(10, zip.entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
  }

  /* ---------- text helpers ---------- */
  const fmt = new Intl.NumberFormat('en-US');
  const moneyText = (v) => (v < 0 ? String(v) : `$${fmt.format(v)}`);

  function parseMoneyInput(text) {
    const raw = String(text).trim().toLowerCase().replace(/[$,\s_]/g, '');
    if (raw === 'max' || raw === 'full') return MAX_MONEY;
    if (!/^\d+$/.test(raw)) throw new SaveError('money must be digits, 1_000_000, $1,000,000 or max');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > MAX_MONEY) throw new SaveError(`money must be 0..${MAX_MONEY}`);
    return value;
  }

  function changedRanges(a, b) {
    if (a.length !== b.length) return [[0, Math.max(a.length, b.length)]];
    const out = [];
    let start = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        out.push([start, i]);
        start = -1;
      }
    }
    if (start >= 0) out.push([start, a.length]);
    return out;
  }

  const hex = (n, width) => '0x' + n.toString(16).toUpperCase().padStart(width, '0');
  const crcText = (c) => `A ${c.a ? 'ok' : 'BAD'} · B ${c.b ? 'ok' : 'BAD'} · header ${c.h ? 'ok' : 'BAD'}`;

  return {
    SaveError, CareerSave,
    nfsu2Crc, zipCrc32, fnv1a64, readGarage,
    openZip, entryBytes, buildZip, profileEntries,
    garageFingerprint, writeGarageFingerprint,
    replaceNameInText, replaceNameInBinary,
    clearRoamOverrides, ROAM_KEYS,
    moneyText, parseMoneyInput, changedRanges, hex, crcText,
    bStringHash, carName, carLabel, CAR_NAMES,
    MAGIC, PROFILE_SIZE, MAX_MONEY, NAME_MAX, STAGE_NAMES,
    GARAGE_FIRST_SLOT, GARAGE_RECORD,
    SETUP_NAMES, SETUP_SIZE, SETUP_COUNT, NEUTRAL_BYTE, MAX_TUNE_BYTE,
    careerBase, garageBase, readTuneAt, writeTuneAt, fillCurvesAt, fillRampAt,
    setUniquesAt, writeUniquesAt, readDetailAt,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NFSU2;
if (typeof window !== 'undefined') window.NFSU2 = NFSU2;
