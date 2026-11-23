# nfsu2save — browser editor

Terminal-styled single page for NFSU2 career saves. Type a file in, get it back
with new money. No framework, no build step, no dependencies, no upload: three
files plus a test harness.

```
index.html   window + editor markup
styles.css   Catppuccin Mocha, same windowized terminal as elmaleek.me
core.js      format code — career profile, N2GA garage, zip read/rebuild (DOM-free)
app.js       terminal log + wiring
test/        node harness for core.js
```

## Use

Open `index.html` (double-click is enough) and drop either:

- the **career profile** — the file with no extension, 54,966 bytes,
  `NFS Underground 2/<name>/<name>` inside the game's save folder;
- the **whole backup `.zip`** from Saves → Download backup on nfsu2mod.xyz /
  nfsu2.xyz.

It prints the container, checksums, driver, stage, money, garage slots and —
for a backup — whether `GARAGE.DAT` still pairs with the profile. Then:

| field | offset | notes |
| --- | --- | --- |
| money | `0x0A16A` | int32, 0..2,147,483,647 |
| driver | `0x0D225` | Latin-1, up to 31 bytes |
| stage | `0x0A175` | 0 intro, 1-5 career, 6 post-career |

Every edit recomputes the container's three CRCs with the game's own algorithm
(MSB-first CRC-32, poly `0x04C11DB7`, first four bytes of the range as the seed —
see `core.js`). `GARAGE.DAT` is never touched: its FNV-1a fingerprint covers
career bytes `[36, 39266)` and the money sits past that, so the pairing survives.

## Cars

The save holds 5 career slots at `0x5868`, `0x7F2` bytes each. `GARAGE.DAT` holds
one 2,034-byte record per further slot: **5 records on plain nfsu2-web (slots
6-10), 20 on the nfsu2mod fork (slots 6-25)** — so this version gives a career
25 cars in total. Each garage record keeps its slot handle at `+4` even when
empty and its payload starts 8 bytes in, so the same offsets apply as in a
career slot (`+0x14` car type, `+0x2BC` model key, `+0x27C` used flag).

The report lists them all, with the empty tail collapsed into one clickable row.
Each row shows the car's own asset name next to the raw hash: a car type is
`bStringHash` of the name (`h = 0xFFFFFFFF`, then `h = h*33 + byte` per upper-case
character), and the table holds the 97 `CARS\<name>` entries this build loads —
stock cars plus the mod's add-ons. A hash outside that set shows as `unknown`
rather than a guess.

Click a car for its read-only detail line: what was spent on it (`+0x6BE`), how
many of the 170 visual-part hashes are set, how many of the 68 installed-item
bytes, how many of the 9 outrun uniques, how many of the 5 dyno setups, and its
`CAREER_SLOT_n` handle. None of that is written, ever — only money, driver and
stage are editable so far.

**Rearranging.** Each car row has an `arrange` line: pick any other slot and
`swap`. The two 2,034-byte records trade their 2,026-byte payloads while each
record keeps its own first eight bytes — the `CAREER_SLOT_n` handle — so slot
numbering survives the move. Swaps work across the two files: a career slot can
trade places with a garage slot, in which case both files are written and the
career fingerprint re-links on download. When a swap moves the car that
`GARAGE.DAT`'s header points at (the career / quick-race / stand-in handles at
`+0x10`, `+0x14`, `+0x18`), those pointers follow the car so the same car stays
active.

The `progress` row counts stage completion: each stage record at `0x9962` holds
`1` at `+0xFC` once that stage is done. Verified against a fresh stage-0 save
(all zero) and a stage-6 save (all one), so it reports 0/6 through 6/6.

**Roam overrides.** `settings.ini` keys `roam_block`, `roam_max_cars`,
`roam_collide` and `roam_friends` (read by the site as `NFSU2_ROAM_*`) can carry
another session's block, car count or friend name into your profile. The
`clear roam overrides` checkbox — on by default, remembered in this browser —
drops those four lines on download and leaves every other key byte-identical.

## Tuning (dyno + uniques)

Each car carries five 41-byte dyno setups at `+0x354` — Circuit, Drag, Drift,
Street X, URL. A setup holds a 9-point ECU curve at `+0x17` and a 9-point turbo
curve at `+0x20`. `100` (0x64) is neutral; `200` (0xC8) is the highest value the
game still uses. The buttons only ever touch those 18 curve bytes per setup —
the other 23 bytes are separate scalars and stay byte-identical (a regression
test asserts exactly that on a save whose scalars are not neutral).

- `[max]` — all 9 ECU and 9 turbo points = 200, written from the highest-RPM
  point backwards so the top of the curve is maxed first.
- `[ramp]` — neutral at the lowest RPM rising to 200 at the highest:
  `100 113 125 138 150 163 175 188 200`.
- `[stock]` — the same points back to 100.

The nine outrun-unique dwords at `+0x2E8` are the "gold" upgrades; `[all]` writes
1 to each, `[none]` clears them.

`[save as preset]` stores a car's whole 205-byte tuning block plus its nine
uniques in this browser (`localStorage`), and every other car gets an
`apply preset` list — that is how you move a tuned/glitched setup from one car
(or from another save) onto yours. Presets never leave the machine.

**Car writes and the garage fingerprint.** GARAGE.DAT fingerprints career bytes
`[36, 39266)`, which covers all five career car records — so any tuning write
invalidates the pairing. The app notices and rewrites the fingerprint inside
`GARAGE.DAT` on download, reporting `re-links on download` until it does. The
`cars untouched` line only appears for money/driver/stage edits; a car edit says
`car record written` instead.

**Renaming.** The name is stored in five places, and a rename now moves all of
them:

| where | what |
| --- | --- |
| `0xD225` | 32-byte driver field |
| `0xD250`, `0xD264` | two 20-byte copies in the auxiliary object |
| `settings.ini` | `roam_name = …` (the free-roam name) |
| `autosave-profiles.txt` | the list of profiles the page has set to autosave |
| `gamefile.bin` | three zero-padded fields, rewritten in place so no offset moves |

nfsu2-web also lists profiles by folder, so the zip entries move with it:
`NFS Underground 2/<old>/<old>` and its `GARAGE.DAT`, plus the mod's own
`BayviewForever/endless-career/<name>/` and `carlot/<name>.txt`. Text entries are
patched as whole words, `gamefile.bin` only where the field is NUL-terminated, and
the download refuses a name another profile in the archive already owns. Names may
not contain `\ / : * ? " < > |` or control characters.

**Garage slots 6–25** tune the same way — click a garage car and the same
`tune`/`gold` rows appear. Those records live in `GARAGE.DAT` itself, at
`32 + n*2034` with the payload 8 bytes in, so the writes need no fingerprint
work: the career save is left byte-identical and the rebuilt archive simply
carries the edited `GARAGE.DAT` (logged as `GARAGE.DAT written`, then
`N B differ in GARAGE.DAT`).


Editing money touches neither the car records (`0x5868-0x8022`) nor the
fingerprinted range, and the log says so on every edit: `cars untouched ·
garage still paired`. If a future field ever did reach the cars, that line turns
red.

Downloading a backup returns the same archive with only those bytes changed —
the other 136 entries are sliced straight out of the original file, so a 448 MB
backup rebuilds in about a second without ever landing in memory. Then
Saves → **Restore** in the browser, pick the download, and choose *Keep this
browser's*.

## Tests

```sh
node test/core.test.js path/to/backup.zip path/to/profile
```

Checks the CRCs against a real save, that a money edit changes exactly
`0x14..0x1C` and `0x0A16A..0x0A16E`, that every other zip entry survives byte
for byte, and that the garage fingerprint still matches afterwards.

## Zip notes

Reads central-directory offsets and inflates only what it needs with
`DecompressionStream('deflate-raw')`; writes plain stored entries with the
original timestamps. zip64 archives are rejected on purpose (the site never
makes them). No zip libraries.
