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
