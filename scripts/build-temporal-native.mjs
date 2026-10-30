#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SDK_VERSION = "1.25.0";
export const RUST_TOOLCHAIN = "1.94.0";
export const RUSTLS_VERSION = "0.23.46";
// SHA-256 of Cargo.lock in the official @temporalio/core-bridge 1.25.0 npm tarball.
export const UPSTREAM_CARGO_SHA256 = "a92ebd082b625ee3e76b8f91513f7a12bbbe056205a35b79bf5837a0821101a7";
export const RECEIPT_FILE = "spaceapp-native-build.json";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validatePatchedCargoLock(bytes) {
  const normalized = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"));
  const packages = [...normalized.toString("utf8").matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)];
  const versions = (name) => packages.filter(([, found]) => found === name).map(([, , version]) => version);
  for (const [name, expected] of [["rustls", RUSTLS_VERSION], ["zip", "9.0.5"], ["temporal-sdk-typescript-bridge", "0.1.0"]]) {
    const found = versions(name);
    if (found.length !== 1 || found[0] !== expected) {
      throw new Error(`Patched Cargo.lock must contain exactly ${name} ${expected}; found ${JSON.stringify(found)}`);
    }
  }
  return normalized;
}

/** Only this package's prebuild directory is removable; source and licenses stay intact. */
export async function removePrebuiltLibraries(bridgeRoot) {
  const root = await realpath(bridgeRoot);
  const releases = resolve(root, "releases");
  if (dirname(releases) !== root) throw new Error("Prebuild directory escaped the SDK package");
  const stat = await lstat(releases).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (stat?.isSymbolicLink()) throw new Error("Refusing to remove a linked SDK prebuild directory");
  await rm(releases, { recursive: true, force: true });
}

async function nativeFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("SDK prebuilds must not contain symbolic links");
    if (entry.isDirectory()) files.push(...await nativeFiles(join(directory, entry.name), name));
    else if (entry.name.endsWith(".node")) files.push(name);
  }
  return files.sort();
}

export function validateReceipt(receipt, { target, cargoBytes, binaryBytes }) {
  const expected = {
    schemaVersion: 1,
    sdkVersion: SDK_VERSION,
    rustlsVersion: RUSTLS_VERSION,
    target,
    toolchain: RUST_TOOLCHAIN,
    upstreamCargoLockSha256: UPSTREAM_CARGO_SHA256,
    cargoLockSha256: sha256(cargoBytes),
    binarySha256: sha256(binaryBytes)
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt?.[key] !== value) throw new Error(`Native build receipt mismatch: ${key}`);
  }
  const compiled = receipt.compiledRustls;
  if (compiled?.version !== RUSTLS_VERSION || !compiled.packageId?.endsWith(`#rustls@${RUSTLS_VERSION}`)
    || !/^[a-f0-9]{64}$/.test(compiled.artifactSha256 ?? "")) {
    throw new Error("Native build receipt lacks evidence of the patched Rustls compiler artifact");
  }
  return expected;
}

export function compilerArtifacts(output) {
  const messages = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (!messages.some((message) => message.reason === "build-finished" && message.success === true)) {
    throw new Error("Cargo did not report a successful completed build");
  }
  const artifacts = messages.filter((message) => message.reason === "compiler-artifact");
  const rustls = artifacts.filter((message) => message.target?.name === "rustls");
  if (!rustls.length || rustls.some((message) => !message.package_id?.endsWith(`#rustls@${RUSTLS_VERSION}`))) {
    throw new Error("Cargo must compile only the reviewed Rustls 0.23.46 implementation");
  }
  const rustlsArtifact = rustls.find((message) => message.filenames?.some((name) => name.endsWith(".rlib")));
  const bridgeArtifact = artifacts.find((message) => message.target?.name === "temporal_sdk_typescript_bridge"
    && message.target?.crate_types?.includes("cdylib"));
  if (!rustlsArtifact || !bridgeArtifact) throw new Error("Cargo did not report the Rustls library and native bridge artifacts");
  return { rustlsArtifact, bridgeArtifact };
}

async function context(root) {
  const requireWorker = createRequire(join(root, "apps", "worker", "package.json"));
  const bridgeRoot = await realpath(dirname(requireWorker.resolve("@temporalio/core-bridge/package.json")));
  const pkg = JSON.parse(await readFile(join(bridgeRoot, "package.json"), "utf8"));
  if (pkg.name !== "@temporalio/core-bridge" || pkg.version !== SDK_VERSION) {
    throw new Error(`Expected @temporalio/core-bridge ${SDK_VERSION}; found ${pkg.name} ${pkg.version}`);
  }
  const { getPrebuiltTargetName, targets } = requireWorker(join(bridgeRoot, "common.js"));
  const target = getPrebuiltTargetName();
  if (!targets.includes(target) || !/^(?:x86_64|aarch64)-(?:unknown-linux-gnu|apple-darwin|pc-windows-msvc|pc-windows-gnu)$/.test(target)) {
    throw new Error(`Unsupported native build target: ${target}`);
  }
  const cargoBytes = validatePatchedCargoLock(await readFile(join(root, "scripts", "fixtures", "temporal-core-bridge-1.25.0.Cargo.lock")));
  return {
    bridgeRoot, target, cargoBytes,
    cargoPath: join(bridgeRoot, "Cargo.lock"),
    binaryPath: join(bridgeRoot, "releases", target, "index.node"),
    receiptPath: join(bridgeRoot, RECEIPT_FILE)
  };
}

function loadFresh(bridgeRoot, binaryPath) {
  // Separate children ensure neither check can reuse an already cached addon.
  for (const [path, publicBridge] of [[binaryPath, false], [bridgeRoot, true]]) {
    execFileSync(process.execPath, ["-e", `
      const loaded = require(${JSON.stringify(path)});
      const native = ${publicBridge ? "loaded.native" : "loaded"};
      if (typeof native?.newRuntime !== "function" || typeof native?.newWorker !== "function") {
        throw new Error("Rebuilt Temporal addon did not expose the expected native API");
      }
    `], { stdio: "inherit" });
  }
}

export async function verifyNativeBridge(ctx) {
  const currentCargo = await readFile(ctx.cargoPath);
  if (!currentCargo.equals(ctx.cargoBytes)) throw new Error("Installed Cargo.lock does not match the reviewed patched fixture");
  const files = await nativeFiles(join(ctx.bridgeRoot, "releases"));
  if (files.length !== 1 || files[0] !== `${ctx.target}/index.node`) {
    throw new Error(`Unexpected or stale SDK prebuilds: ${JSON.stringify(files)}`);
  }
  const receipt = JSON.parse(await readFile(ctx.receiptPath, "utf8"));
  validateReceipt(receipt, { target: ctx.target, cargoBytes: ctx.cargoBytes, binaryBytes: await readFile(ctx.binaryPath) });
  loadFresh(ctx.bridgeRoot, ctx.binaryPath);
  return receipt;
}

function rustCommand(command, args, options = {}) {
  // `rustup run` never installs a missing toolchain. Tools must be provisioned by CI/the operator.
  return execFileSync("rustup", ["run", RUST_TOOLCHAIN, command, ...args], options);
}

/** Compiler failure leaves no old addon or receipt available as a fallback. */
export async function compileNativeBridge(ctx, targetDir, { runRust = rustCommand, load = loadFresh } = {}) {
  const cache = resolve(targetDir);
  const releasesRelative = relative(join(ctx.bridgeRoot, "releases"), cache);
  if (releasesRelative === "" || (releasesRelative !== ".." && !releasesRelative.startsWith(`..${sep}`) && !isAbsolute(releasesRelative))) {
    throw new Error("Cargo target directory must be outside the SDK prebuild directory");
  }
  const tempReceipt = `${ctx.receiptPath}.${process.pid}.tmp`;
  await rm(ctx.receiptPath, { force: true });
  await removePrebuiltLibraries(ctx.bridgeRoot);
  try {
    await writeFile(ctx.cargoPath, ctx.cargoBytes);
    const rustVersion = runRust("rustc", ["--version"], { encoding: "utf8" }).trim();
    if (!rustVersion.startsWith(`rustc ${RUST_TOOLCHAIN} `)) throw new Error(`Unexpected Rust compiler: ${rustVersion}`);
    const cargoOutput = runRust("cargo", [
      "build", "--release", "--locked", "--message-format=json-render-diagnostics", "--target", ctx.target,
      "--target-dir", cache, "--manifest-path", join(ctx.bridgeRoot, "Cargo.toml")
    ], { cwd: ctx.bridgeRoot, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const { rustlsArtifact, bridgeArtifact } = compilerArtifacts(cargoOutput);
    const library = ctx.target.includes("windows") ? "temporal_sdk_typescript_bridge.dll"
      : ctx.target.includes("darwin") ? "libtemporal_sdk_typescript_bridge.dylib"
      : "libtemporal_sdk_typescript_bridge.so";
    const builtLibrary = join(cache, ctx.target, "release", library);
    if (!bridgeArtifact.filenames.some((name) => resolve(name) === builtLibrary)) {
      throw new Error("Cargo native bridge artifact did not match the expected target library");
    }
    const rustlsLibrary = rustlsArtifact.filenames.find((name) => name.endsWith(".rlib"));
    const compiledRustls = {
      packageId: rustlsArtifact.package_id, version: RUSTLS_VERSION,
      artifactSha256: sha256(await readFile(rustlsLibrary))
    };
    await mkdir(dirname(ctx.binaryPath), { recursive: true });
    await copyFile(builtLibrary, ctx.binaryPath);
    if (!(await readFile(ctx.cargoPath)).equals(ctx.cargoBytes)) throw new Error("Cargo changed the reviewed lock during the locked build");
    load(ctx.bridgeRoot, ctx.binaryPath);
    const receipt = {
      schemaVersion: 1, sdkVersion: SDK_VERSION, rustlsVersion: RUSTLS_VERSION,
      target: ctx.target, toolchain: RUST_TOOLCHAIN,
      upstreamCargoLockSha256: UPSTREAM_CARGO_SHA256,
      cargoLockSha256: sha256(ctx.cargoBytes), binarySha256: sha256(await readFile(ctx.binaryPath)),
      compiledRustls
    };
    await writeFile(tempReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    await rename(tempReceipt, ctx.receiptPath);
    return receipt;
  } catch (error) {
    await rm(ctx.receiptPath, { force: true });
    await removePrebuiltLibraries(ctx.bridgeRoot);
    throw error;
  } finally {
    await rm(tempReceipt, { force: true });
  }
}

export async function buildTemporalNative({ verify = false, targetDir, root = repoRoot } = {}) {
  const ctx = await context(root);
  if (verify) return verifyNativeBridge(ctx);
  const installedLockSha = sha256(await readFile(ctx.cargoPath));
  if (installedLockSha !== UPSTREAM_CARGO_SHA256 && installedLockSha !== sha256(ctx.cargoBytes)) {
    throw new Error("Installed Temporal Cargo.lock is neither the official upstream lock nor the reviewed patched lock");
  }
  const receipt = await compileNativeBridge(ctx, targetDir ?? join(tmpdir(), "spaceapp-temporal-native", SDK_VERSION));
  await verifyNativeBridge(ctx);
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { verify: { type: "boolean" }, "target-dir": { type: "string" } } });
    console.log(JSON.stringify(await buildTemporalNative({ verify: values.verify, targetDir: values["target-dir"] }), null, 2));
  } catch (error) {
    console.error(`Temporal native build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
