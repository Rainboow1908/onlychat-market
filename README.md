# onlychat-market

Official static plugin market for OnlyChat Next.

* Index: <https://onlychat-market.pages.dev/index.json>
* Packages: <https://onlychat-market.pages.dev/packages/>
* Publisher key id: `6ca4f6d452839f91`
* Publisher public key (base64): `m94ftwIyfp5vu6ZkASUzE2EvfCQ373hDl9PdSKTj82k=`
* Publisher public key (hex): `9bde1fb702327e9e6fbba66401253313612f7c2437ef784397d3dd48a4e3f369`

The daemon trusts this key by default. `ONLYCHAT_MARKET_KEYS` and
`ONLYCHAT_MARKET_INDEX` can override the trust store/index for local testing.

## Layout

```text
public/
  index.json                     signed release index (schemaVersion 1)
  packages/
    <id>-<version>.ocp           deterministic ZIP package
    <id>-<version>.ocp.sig       detached Ed25519 signature (JSON)
.github/
  workflows/deploy.yml           GitHub Actions -> Cloudflare Pages
  scripts/verify-signatures.mjs  CI verification / emergency re-signing
```

`index.json` is not itself signed. Every package is authenticated by the
Ed25519 signature over the SHA-256 of the complete `.ocp` file. The daemon
checks the index, then the signature, then the package contents (layout,
manifest, permissions) before installing.

## Publishing a release

All package work uses the Rust CLI from the OnlyChat Next workspace; the CI
script only verifies signatures and can sign a package that has no `.sig`
yet.

```powershell
# 1. Build the CLI
cargo build -p onlychat-plugin-market --bin onlychat-market

# 2. Pack + sign into public/packages
onlychat-market pack ..\..\Onlychat\plugins\hello `
  --key ..\..\Onlychat\.tmp\onlychat-market-secrets\official-seed.txt `
  --out public\packages\hello-0.1.0.ocp

# 3. Regenerate the index (verifies every package with the official key)
onlychat-market index public\packages `
  --base-url https://onlychat-market.pages.dev/packages `
  --out public\index.json `
  --key m94ftwIyfp5vu6ZkASUzE2EvfCQ373hDl9PdSKTj82k= `
  --name "OnlyChat Official Market" `
  --publisher onlychat

# 4. Verify one package independently
onlychat-market verify public\packages\hello-0.1.0.ocp `
  --key m94ftwIyfp5vu6ZkASUzE2EvfCQ373hDl9PdSKTj82k=

# 5. Deploy
npx wrangler pages deploy public --project-name onlychat-market

# 6. Commit + push
git add public
git commit -m "release: hello 0.1.0"
git push origin main
```

Pack the directory that contains only `plugin.toml` and the wasm entry (plus
optional `ui/` and `assets/`). Do not pack a source tree: `Cargo.toml`,
`src/`, `examples/` and other files are rejected by the layout whitelist.

## Index format

```json
{
  "schemaVersion": 1,
  "name": "OnlyChat Official Market",
  "updatedAt": "2026-11-06T20:14:23Z",
  "plugins": [
    {
      "id": "hello",
      "version": "0.1.0",
      "api": 1,
      "minAppVersion": null,
      "downloadUrl": "https://onlychat-market.pages.dev/packages/hello-0.1.0.ocp",
      "sha256": "<hex sha256 of the complete .ocp>",
      "signature": "<base64 ed25519 signature>",
      "keyId": "6ca4f6d452839f91",
      "publisher": "onlychat",
      "permissions": [],
      "displayName": "Hello",
      "description": "...",
      "homepage": null,
      "iconUrl": null
    }
  ]
}
```

The index may list multiple versions of one id; the daemon picks the newest
compatible one for install and treats older ones as downgrades (explicit
consent required). `minAppVersion` is enforced before a package is downloaded.

## Key management

* The private seed lives at
  `Onlychat/.tmp/onlychat-market-secrets/official-seed.txt` on the publisher
  machine and is **never committed**. `.gitignore` excludes `*.seed`,
  `secrets/` and the `.wrangler` cache.
* GitHub Actions reads the seed only from the `ONLYCHAT_MARKET_SEED` secret.
  The workflow never echoes it.
* `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are the only other
  secrets required for deployment.
* Rotating the key means publishing a new public key in a daemon release and
  re-signing every package with the new key. Old signatures stay valid only
  while the old key remains trusted.

### CI verification

`.github/scripts/verify-signatures.mjs` runs before deployment:

1. every `.ocp` must have a `.sig` whose `sha256` matches the file;
2. every signature must verify against the committed public key;
3. if `ONLYCHAT_MARKET_SEED` is present, packages without a `.sig` are signed
   with the matching key; a mismatch is always a hard failure (CI never
   re-blesses a tampered package);
4. every index entry's `sha256`, `keyId` and `downloadUrl` are checked against
   the files in `public/packages`.

Set the repository variable `ONLYCHAT_MARKET_PUBLIC_KEY` if the key ever
changes; otherwise the default below is used.

## Consumer trust

The daemon embeds the official key and index. A release is accepted only when:

* the index entry's `sha256` matches the downloaded file;
* the detached Ed25519 signature verifies with a trusted key id;
* the archive layout is safe (no traversal, symlinks, duplicates or oversized
  entries);
* `plugin.toml` parses, matches the index id/version and the indexed permission
  set;
* the user accepted every new permission (or a downgrade) in the preview.

Market installs start **disabled**; the user enables the plugin after reviewing
its permissions. Uninstalling a market/local plugin moves it to
`<plugins>/.backups/<id>/` so data is kept; purging data requires a second
confirmation. Built-in plugins can only be disabled, never uninstalled.
