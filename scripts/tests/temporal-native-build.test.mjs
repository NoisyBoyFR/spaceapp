import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compileNativeBridge, compilerArtifacts, RECEIPT_FILE, removePrebuiltLibraries, RUST_TOOLCHAIN,
  RUSTLS_VERSION, SDK_VERSION, sha256, UPSTREAM_CARGO_SHA256,
  validatePatchedCargoLock, validateReceipt
} from "../build-temporal-native.mjs";

const lock = Buffer.from(`[[package]]\nname = "temporal-sdk-typescript-bridge"\nversion = "0.1.0"\n\n[[package]]\nname = "rustls"\nversion = "0.23.46"\n\n[[package]]\nname = "zip"\nversion = "9.0.5"\n`);

test("the reviewed lock rejects vulnerable or duplicate TLS implementations", () => {
  assert.deepEqual(validatePatchedCargoLock(lock), lock);
  assert.throws(() => validatePatchedCargoLock(Buffer.from(lock.toString().replace("0.23.46", "0.23.36"))), /rustls 0\.23\.46/);
  assert.throws(() => validatePatchedCargoLock(Buffer.concat([lock, Buffer.from('\n[[package]]\nname = "rustls"\nversion = "0.23.36"\n')])), /exactly rustls/);
});

test("receipt verification rejects missing provenance and tampered binaries or locks", () => {
  const bytes = Buffer.from("unit-test binary hash input, not a native addon");
  const target = "x86_64-unknown-linux-gnu";
  const expected = { target, cargoBytes: lock, binaryBytes: bytes };
  const receipt = {
    schemaVersion: 1, sdkVersion: SDK_VERSION, rustlsVersion: RUSTLS_VERSION,
    target, toolchain: RUST_TOOLCHAIN, upstreamCargoLockSha256: UPSTREAM_CARGO_SHA256,
    cargoLockSha256: sha256(lock), binarySha256: sha256(bytes),
    compiledRustls: { packageId: `registry+https://github.com/rust-lang/crates.io-index#rustls@${RUSTLS_VERSION}`,
      version: RUSTLS_VERSION, artifactSha256: sha256(Buffer.from("unit-test compiler artifact hash input")) }
  };
  assert.doesNotThrow(() => validateReceipt(receipt, expected));
  assert.throws(() => validateReceipt(undefined, expected), /receipt mismatch/);
  assert.throws(() => validateReceipt(receipt, { ...expected, binaryBytes: Buffer.from("replaced addon") }), /binarySha256/);
  assert.throws(() => validateReceipt(receipt, { ...expected, cargoBytes: Buffer.from("changed lock") }), /cargoLockSha256/);
  assert.throws(() => validateReceipt({ ...receipt, compiledRustls: undefined }, expected), /compiler artifact/);
});

test("compiler evidence rejects a successful build that still used vulnerable Rustls", () => {
  const messages = [
    { reason: "compiler-artifact", package_id: "registry+https://github.com/rust-lang/crates.io-index#rustls@0.23.46",
      target: { name: "rustls" }, filenames: ["/cache/librustls.rlib"] },
    { reason: "compiler-artifact", target: { name: "temporal_sdk_typescript_bridge", crate_types: ["cdylib"] },
      filenames: ["/cache/libtemporal_sdk_typescript_bridge.so"] },
    { reason: "build-finished", success: true }
  ].map((message) => JSON.stringify(message)).join("\n");
  assert.equal(compilerArtifacts(messages).rustlsArtifact.target.name, "rustls");
  assert.throws(() => compilerArtifacts(messages.replace("rustls@0.23.46", "rustls@0.23.36")), /only the reviewed Rustls/);
  assert.throws(() => compilerArtifacts(messages.replace('"success":true', '"success":false')), /successful completed build/);
});

test("failed compilation removes every stale prebuild and receipt while preserving source and licenses", async () => {
  const bridgeRoot = await mkdtemp(join(tmpdir(), "spaceapp-native-failure-"));
  for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-pc-windows-msvc"]) {
    await mkdir(join(bridgeRoot, "releases", target), { recursive: true });
    await writeFile(join(bridgeRoot, "releases", target, "index.node"), "old vulnerable prebuild");
  }
  await writeFile(join(bridgeRoot, "LICENSE"), "keep license");
  await writeFile(join(bridgeRoot, "source.rs"), "keep source");
  await writeFile(join(bridgeRoot, RECEIPT_FILE), "stale receipt");
  const target = "x86_64-unknown-linux-gnu";
  const ctx = {
    bridgeRoot, target, cargoBytes: lock, cargoPath: join(bridgeRoot, "Cargo.lock"),
    binaryPath: join(bridgeRoot, "releases", target, "index.node"), receiptPath: join(bridgeRoot, RECEIPT_FILE)
  };
  await assert.rejects(() => compileNativeBridge(ctx, join(bridgeRoot, "target"), {
    runRust: (command) => { if (command === "rustc") return `rustc ${RUST_TOOLCHAIN} (test compiler version)`; throw new Error("compiler failed"); },
    load: () => assert.fail("failed builds must never load a stale addon")
  }), /compiler failed/);
  await assert.rejects(() => stat(join(bridgeRoot, "releases")), { code: "ENOENT" });
  await assert.rejects(() => stat(ctx.receiptPath), { code: "ENOENT" });
  assert.equal(await readFile(join(bridgeRoot, "LICENSE"), "utf8"), "keep license");
  assert.equal(await readFile(join(bridgeRoot, "source.rs"), "utf8"), "keep source");
});

test("prebuild cleanup refuses a linked directory outside the package", async () => {
  const bridgeRoot = await mkdtemp(join(tmpdir(), "spaceapp-native-package-"));
  const other = await mkdtemp(join(tmpdir(), "spaceapp-native-outside-"));
  await writeFile(join(other, "keep.txt"), "untouched");
  await symlink(other, join(bridgeRoot, "releases"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => removePrebuiltLibraries(bridgeRoot), /linked/);
  assert.equal(await readFile(join(other, "keep.txt"), "utf8"), "untouched");
});
