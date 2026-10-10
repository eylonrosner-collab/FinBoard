# FinBoard encryption (finboard enc v1)

Financial payloads are encrypted in the browser (and by `scripts/finboard-vault.mjs`) before they are written to the GitHub Gist or to `localStorage`. There is no server and no email recovery.

`tzofik_shares.json` and Tzofik share links (`#tzofik&s=…`) stay **plaintext**. Recipients do not have the passphrase. The helper refuses nothing by magic if you point it at that file — do not encrypt it.

## Who shares one data key

A random 256-bit AES-GCM **data key** encrypts the JSON. The data key is never stored raw. It is wrapped twice:

- with a key derived from the **passphrase**
- with a key derived from the **recovery key**

`finance_data.json` and `tasks.json` each carry a copy of both wrappings plus their own ciphertext. Changing the passphrase only rewraps the data key (`wrapP` / `saltP` / `ivP`). The payload `ct` stays as it is. The recovery wrapping is left untouched, so the recovery key still opens files that were sealed before the change.

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

## What is encrypted

| Location | Encrypted |
| --- | --- |
| Gist `finance_data.json` | yes |
| Gist `tasks.json` | yes |
| Gist `tzofik_shares.json` | **no** |
| `#tzofik&s=` share links | **no** |
| `localStorage['fin26']` (dashboard state) | yes, once a vault exists |
| `localStorage['fin26_snaps']` | yes, once a vault exists |
| `fin26_v2` cache, backups, and `tasks` | yes (envelope fields). `auth` token stays so the Gist can be fetched |
| Example / demo data with no Gist | no (synthetic, nothing to protect) |

Plaintext that is already on the Gist is migrated on first setup: the browser downloads `finboard-plaintext-backup-YYYY-MM-DD.json` **before** the encrypted write.

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

Change a passphrase without re-encrypting the payload (then copy the new `saltP`/`ivP`/`wrapP` onto `tasks.json` too, or run `rewrap` on each envelope):

```bash
export FINBOARD_PASSPHRASE='old'
export FINBOARD_NEW_PASSPHRASE='new'
node scripts/finboard-vault.mjs rewrap --file finance_data.json --out finance_data.json
```

Node 20+ is required (`globalThis.crypto.subtle`). The passphrase is never hard-coded. If the env vars are missing and the terminal is interactive, the script prompts without echo.
