#!/usr/bin/env node
// CI guard for the static market repository.
//
// Canonical packaging/signing is done with the Rust `onlychat-market` CLI. This
// script only:
//   * verifies every checked-in `.ocp.sig` against the committed public key;
//   * signs a package that has no `.sig` yet when ONLYCHAT_MARKET_SEED is set;
//   * verifies that every index entry points at a matching package.
//
// A digest/signature mismatch is always fatal: CI never re-signs a package
// whose old signature no longer matches, because that would bless tampering.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PUBLIC_KEY_HEX =
  "9bde1fb702327e9e6fbba66401253313612f7c2437ef784397d3dd48a4e3f369";
const DEFAULT_KEY_ID = "6ca4f6d452839f91";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SIGNING_CONTEXT = Buffer.from("onlychat.ocp.v1\n", "utf8");

const publicHex = (process.env.ONLYCHAT_MARKET_PUBLIC_KEY || DEFAULT_PUBLIC_KEY_HEX)
  .trim()
  .toLowerCase();
if (!/^[0-9a-f]{64}$/.test(publicHex)) {
  throw new Error("ONLYCHAT_MARKET_PUBLIC_KEY must be 32 bytes of hex");
}
const rawPublic = Buffer.from(publicHex, "hex");
const keyId = sha256(rawPublic).subarray(0, 8).toString("hex");
if (keyId !== DEFAULT_KEY_ID && !process.env.ONLYCHAT_MARKET_PUBLIC_KEY) {
  throw new Error(`built-in key id mismatch: ${keyId}`);
}
const publicKey = createPublicKey({
  key: Buffer.concat([SPKI_ED25519_PREFIX, rawPublic]),
  format: "der",
  type: "spki",
});

let privateKey = null;
if (process.env.ONLYCHAT_MARKET_SEED) {
  const seed = Buffer.from(process.env.ONLYCHAT_MARKET_SEED.trim(), "base64");
  if (seed.length !== 32) {
    throw new Error("ONLYCHAT_MARKET_SEED must be a base64 encoded 32-byte seed");
  }
  privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const derivedRaw = derived.subarray(-32);
  if (!derivedRaw.equals(rawPublic)) {
    throw new Error(
      `ONLYCHAT_MARKET_SEED does not match the public key (derived key id ${sha256(derivedRaw)
        .subarray(0, 8)
        .toString("hex")})`,
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

async function verifyPackage(root, fileName) {
  const ocpPath = path.join(root, fileName);
  const bytes = await readFile(ocpPath);
  const digest = sha256(bytes);
  const digestHex = digest.toString("hex");
  const sigPath = `${ocpPath}.sig`;

  let signature;
  try {
    signature = JSON.parse(await readFile(sigPath, "utf8"));
  } catch (error) {
    if (!privateKey) {
      throw new Error(`${fileName}: missing or unreadable .sig (${error.message})`);
    }
    const signatureBytes = sign(null, Buffer.concat([SIGNING_CONTEXT, digest]), privateKey);
    signature = {
      alg: "ed25519",
      keyId,
      sha256: digestHex,
      signature: signatureBytes.toString("base64"),
    };
    await writeFile(sigPath, `${JSON.stringify(signature, null, 2)}\n`);
    console.log(`signed ${fileName} (${keyId})`);
    return { digestHex, signature, signedNow: true };
  }

  if ((signature.alg || "ed25519").toLowerCase() !== "ed25519") {
    throw new Error(`${fileName}: unsupported signature algorithm ${signature.alg}`);
  }
  if (signature.sha256 !== digestHex) {
    throw new Error(`${fileName}: sha256 in .sig does not match the package`);
  }
  if (signature.keyId && signature.keyId.toLowerCase() !== keyId) {
    throw new Error(`${fileName}: signed by untrusted key id ${signature.keyId}`);
  }
  const ok = verify(
    null,
    Buffer.concat([SIGNING_CONTEXT, digest]),
    publicKey,
    Buffer.from(signature.signature, "base64"),
  );
  if (!ok) {
    throw new Error(`${fileName}: signature does not verify`);
  }
  return { digestHex, signature, signedNow: false };
}

const publicDir = path.resolve("public");
const packagesDir = path.join(publicDir, "packages");
const files = (await readdir(packagesDir)).filter((name) => name.endsWith(".ocp")).sort();
if (files.length === 0) {
  throw new Error("public/packages is empty");
}

const packages = new Map();
for (const file of files) {
  const result = await verifyPackage(packagesDir, file);
  packages.set(file, result);
  console.log(`verified ${file} ${result.digestHex}`);
}

const indexPath = path.join(publicDir, "index.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));
if (index.schemaVersion !== 1) {
  throw new Error(`unsupported index schemaVersion ${index.schemaVersion}`);
}
const referenced = new Set();
for (const entry of index.plugins ?? []) {
  const fileName = path.basename(new URL(entry.downloadUrl, "https://example.invalid/").pathname);
  const packageInfo = packages.get(fileName);
  if (!packageInfo) {
    throw new Error(`${entry.id} ${entry.version}: ${fileName} is not in public/packages`);
  }
  if (packageInfo.digestHex !== entry.sha256) {
    throw new Error(`${entry.id} ${entry.version}: index sha256 does not match ${fileName}`);
  }
  if ((entry.keyId || "") !== keyId) {
    throw new Error(`${entry.id} ${entry.version}: index keyId ${entry.keyId} is not trusted`);
  }
  if ((entry.signature || "") !== packageInfo.signature.signature) {
    throw new Error(`${entry.id} ${entry.version}: index signature differs from ${fileName}.sig`);
  }
  referenced.add(fileName);
  console.log(`index ok ${entry.id} ${entry.version} -> ${fileName}`);
}
for (const file of files) {
  if (!referenced.has(file)) {
    console.warn(`warning: ${file} is not referenced by index.json`);
  }
}
console.log(`ok: ${files.length} package(s), ${index.plugins?.length ?? 0} index entr(ies)`);
