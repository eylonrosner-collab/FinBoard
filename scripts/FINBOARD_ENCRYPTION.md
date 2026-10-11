# FinBoard encryption (finboard enc v1)

Financial payloads are encrypted in the browser (and by `scripts/finboard-vault.mjs`) before they are written to the GitHub Gist or to `localStorage`. There is no server and no email recovery.

`tzofik_shares.json` and Tzofik share links (`#tzofik&s=…`) stay **plaintext**. Recipients do not have the passphrase. The helper refuses nothing by magic if you point it at that file — do not encrypt it.

## Who shares one data key

A random 256-bit AES-GCM **data key** encrypts the JSON. The data key is never stored raw. It is wrapped twice:

- with a key derived from the **passphrase**
- with a key derived from the **recovery key**

`finance_data.json`, `tasks.json`, `snaps.json`, and `settings.json` each carry a copy of both wrappings plus their own ciphertext. Changing the passphrase only rewraps the data key (`wrapP` / `saltP` / `ivP`). The payload `ct` stays as it is. The recovery wrapping is left untouched, so the recovery key still opens files that were sealed before the change. Run `rewrap` on every envelope (`finance_data.json`, `tasks.json`, `snaps.json`, `settings.json`), or copy the new `saltP` / `ivP` / `wrapP` onto each of them.

The GitHub token is **not** inside these files. The user types it once; it stays in `localStorage` (`fin26_token`, or `fin26_v2.auth`) so the page can fetch the Gist. It is not embedded in a QR or `#access=` link anymore.

## File format

UTF-8 JSON:

| Field | Meaning |
| --- | --- |
| `finboard` | `1` |
| `alg` | `"A256GCM"` (AES-256-GCM) |
| `kdf` | `"PBKDF2-SHA256"` |
| `iter` | PBKDF2 iterations (600000) |
| `saltP`, `ivP`, `wrapP` | passphrase wrap of the raw 32-byte data key |
| `saltR`, `ivR`, `wrapR` | recovery-key wrap of the same data key |
| `iv`, `ct` | AES-GCM nonce and ciphertext of the UTF-8 JSON payload |

Binary fields are standard base64. AES-GCM IVs are 12 bytes. Salts are 16 bytes. The GCM tag is appended to the ciphertext by WebCrypto (decoded length is plaintext + 16).

A local copy of the wraps only (no payload) is kept in `localStorage['fin26_vault']` so a new tab knows that a passphrase is required. The data key itself is held only in memory for the tab session.

### Recovery key

32 random bytes, shown once, as:

```text
fbk1-ab12-cd34-…   (fbk1- plus 64 hex digits in groups of 4)
```

Either the passphrase or this key unwraps the data key. There is no other recovery path.

### Biometric unlock (this device only)

After a passphrase unlock, v2 can register a **platform passkey** (Touch ID / Face ID) with the WebAuthn PRF extension. The passkey is not a copy of the passphrase. Registration asks the authenticator for 32 PRF bytes from a random salt that stays on this device. Those bytes are the HKDF-SHA256 input (`salt` `finboard-bio-hkdf-v1`, `info` `finboard-data-key-wrap`) for an AES-GCM key that wraps the raw data key.

`localStorage['fin26_bio']` stores only:

| Field | Meaning |
| --- | --- |
| `credId` | platform credential id |
| `salt` | the PRF salt for this device |
| `iv`, `ct` | AES-GCM wrap of the data key |
| `fp` | fingerprint of the passphrase and recovery wraps |

The passphrase is never written. Demo mode (`?demo=1` and `/v2/demo/`) cannot read or write this key. If the wraps change — passphrase change or a new data key — the record is deleted and v2 asks to turn biometric unlock on again. Passphrase and recovery key still open the book. Browsers without PRF (older than iOS 18 / current Safari or Chrome) do not get a weaker fallback.

## What is encrypted

| Location | Encrypted |
| --- | --- |
| Gist `finance_data.json` | yes |
| Gist `tasks.json` | yes |
| Gist `snaps.json` | yes |
| Gist `settings.json` | yes |
| Gist `tzofik_shares.json` | **no** |
| `#tzofik&s=` share links | **no** |
| `localStorage['fin26']` (dashboard state) | yes, once a vault exists |
| `localStorage['fin26_snaps']` | yes, once a vault exists |
| `fin26_v2` cache, backups, and `tasks` | yes (envelope fields). `auth` token stays so the Gist can be fetched |
| Example / demo data with no Gist | no (synthetic, nothing to protect) |

Plaintext that is already on the Gist is migrated on first setup: the browser downloads `finboard-plaintext-backup-YYYY-MM-DD.json` **before** the encrypted write.

### `snaps.json` (plaintext inside the envelope)

Daily total-financial-assets points used by period returns (`תשואה לפי תקופה`) and the net-worth chart. Separate from `finance_data.json` because the original site rewrites that file wholesale and would drop unknown keys.

```json
{ "v": 1, "snaps": [ { "d": "2024-01-31", "v": 1234567 } ] }
```

`d` is `YYYY-MM-DD`. `v` is the rounded financial total. On load, devices union by date: a date that exists only on one side is kept; the same date keeps the value already in the Gist. The first merge on a device also stores the previous local points in `fin26_v2.syncBackup` (sealed once a vault is open). Points that were only filled from the baked-in history seed stay on the device (`seed: 1` in `fin26_snaps`) and are not uploaded, so a fresh browser does not overwrite a richer history that has not been uploaded yet.

Demo and example mode never write `fin26_snaps` or any other real key. `?demo=1` and `/v2/demo/` replace `localStorage` / `sessionStorage` methods (Safari keeps `setItem` as an own property, so a prototype patch is not enough) and refuse GitHub requests. `assets/finboard-demo-guard.js` is also loaded by the original site. On every page it strips a `fin26_snaps` array before `setItem`: exact date+value pairs from the fictional monthly series, and any point equal to the demo total 3,494,650. The same filter runs again before a union. Matching points are removed from `fin26_snaps` and from `syncBackup`.

A device may upload non-demo local history once, on the first successful Gist sync. `fin26_v2.snapGate` is set only after that upload, or when there was nothing new to send. After the gate, the only local points eligible to upload are ones recorded while the real book was open (`real: 1` from v2 or from the original site). A later demo leak cannot be bulk-unioned. Dates the user deleted in Settings (`deletedSnaps`) stay out of the union, and the cleaned file is written back when it differs from the Gist.

The original site (`index.html`) still writes `localStorage['fin26_snaps']` only. It drops demo points on read and on write, and marks the snapshot it records while unlocked with `real: 1`, so the next v2 open can union that real point.

### `settings.json` (plaintext inside the envelope)

Calculation inputs that change the forecast, tax line, allocation drift, and chart window. Same vault envelope as the other files.

```json
{
  "v": 1,
  "fc": { "date": "2031-01-01", "ret": 5, "monthly": 1000, "infl": 2.5 },
  "assume": { "equity": { "ret": 7, "vol": 16 } },
  "targets": { "equity": 40 },
  "taxRules": { "broker": { "rate": 25, "basis": "real" } },
  "taxExit": { "gemel": "annuity" },
  "loanCpi": 2,
  "monthlyExpenses": 18000,
  "emMonths": 6,
  "concPct": 20,
  "driftPct": 5,
  "feeHigh": 0.6,
  "ovRange": 0,
  "alScope": "fin",
  "pgScope": "fin",
  "rbNewMoney": false
}
```

Keys absent from the file stay at the site's built-in default. `settings.json` is never written automatically: the first device to sync must not replace another device's forecast, tax, or allocation settings. If this browser has stored calculation keys that differ from the Gist, v2 keeps the device copy on screen and Settings lists the difference. The button «העלה את הגדרות החישוב של המכשיר הזה ל-Gist» is the only publish path. A browser with no stored calculation keys shows the Gist copy in memory and does not write it back until that button is used.

Not in this file (they stay in `localStorage` on that browser only): `theme`, blur/`privacy`, `hideDoneTasks`, the open tab (URL hash), Gist id/token, backups, and the Gemini key.

`public-allocation.json` and the data.gov.il look-through are not in the Gist. They are the same file for every device; a live refresh can change class weights until the next fetch, which is why a saved forecast return lives in `settings.json` (`fc.ret` / `assume`) rather than being recomputed from the fund file.

## Assistant script

The out-of-band updater should stop reading `finance_data.json` as plain JSON. Round-trip:

```bash
export FINBOARD_PASSPHRASE='…'          # or FINBOARD_RECOVERY_KEY='fbk1-…'
node scripts/finboard-vault.mjs decrypt --file finance_data.json --out /tmp/finance_data.plain.json
# edit /tmp/finance_data.plain.json
node scripts/finboard-vault.mjs encrypt \
  --file /tmp/finance_data.plain.json \
  --envelope finance_data.json \
  --out finance_data.json
# PATCH the Gist file finance_data.json with the new envelope.
# Pass --envelope so the same data key (and recovery key) is kept.
```

The same decrypt / encrypt / rewrap commands apply to `tasks.json`, `snaps.json`, and `settings.json`. Pass `--envelope` pointing at any file already sealed with this vault (for example the current `finance_data.json`) so the new file keeps the same data key.

Change a passphrase without re-encrypting the payload, then rewrap every envelope (or copy the new `saltP`/`ivP`/`wrapP` onto each of them):

```bash
export FINBOARD_PASSPHRASE='old'
export FINBOARD_NEW_PASSPHRASE='new'
node scripts/finboard-vault.mjs rewrap --file finance_data.json --out finance_data.json
node scripts/finboard-vault.mjs rewrap --file tasks.json --out tasks.json
node scripts/finboard-vault.mjs rewrap --file snaps.json --out snaps.json
node scripts/finboard-vault.mjs rewrap --file settings.json --out settings.json
```

Node 20+ is required (`globalThis.crypto.subtle`). The passphrase is never hard-coded. If the env vars are missing and the terminal is interactive, the script prompts without echo.
