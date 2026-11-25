#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// Packages the fork's macOS desktop app (arm64) on Linux, ad-hoc signs it, and writes it as a
// tarball the Mac installs with `scripts/fork-update.sh --install`. See "Build it" in CLAUDE.md.
// Run it through `scripts/fork-update.sh --build-only` on Linux, which first runs the shared
// steps (fork-prepare, expo export, desktop build:main) this script packages.
//
//   PASEO_FORK_MAC_APP_OUT=<dir>  where the tarball goes (fork-build.mjs passes its log dir);
//                                 default ~/.paseo-fork-build/<time>/
//
// Writes <dir>/Paseo-mac-arm64.tgz and then <dir>/Paseo-mac-arm64.json ({ sha, dirty, version,
// sha256, ... }). The JSON is written last, so a JSON next to a tarball means the tarball is
// complete. Only the three newest tarballs under ~/.paseo-fork-build are kept.
//
// Why each step (trial 2026-11-13: Apple codesign --verify --deep --strict and the packaged
// smoke passed on the Mac):
// - The app ships three native packages npm only installs for the host platform. Their
//   darwin-arm64 copies are fetched from the lockfile's URL, checked against its integrity, and
//   put beside the Linux ones so electron-builder packs them. node-pty ships darwin prebuilds.
// - esbuild's postinstall copied the Linux binary into esbuild/bin; the Mac one goes back.
// - The Linux copies ride along into app.asar.unpacked (~90 MB) and are pruned. Any ELF or PE
//   file left in the bundle fails the build: it would be a native the Mac cannot load.
// - electron-builder cannot sign on Linux; rcodesign signs ad-hoc, which is what the Mac build
//   does too (hardened runtime off, see fork-update.sh). `rcodesign verify` refuses bundles, so
//   the Mac checks the signature with codesign before installing.
// - tar, never zip: zip on Linux breaks the frameworks' Versions/Current symlinks.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTimer, gitRoot } from "./fork-build-lib.mjs";

const log = (message) => process.stderr.write(`[fork-mac-app] ${message}\n`);
const fail = (message) => {
  log(message);
  process.exit(1);
};

if (process.platform !== "linux" || process.arch !== "x64") {
  fail("runs on Linux x64 only; on the Mac, build with scripts/fork-update.sh --build-only");
}

const root = gitRoot();
const desktop = path.join(root, "packages/desktop");
const timer = createTimer(log);
const cache = path.join(os.homedir(), ".cache", "paseo-fork-mac-app");
const buildRoot = path.join(os.homedir(), ".paseo-fork-build");
const stamp = new Date()
  .toISOString()
  .replace(/\.\d+Z$/, "Z")
  .replaceAll(":", "");
const outDir = process.env.PASEO_FORK_MAC_APP_OUT || path.join(buildRoot, stamp);
const TARBALL = "Paseo-mac-arm64.tgz";
const META = "Paseo-mac-arm64.json";
const KEEP_TARBALLS = 3;

// Lockfile keys of the darwin-arm64 natives the app ships. A new native dependency shows up as
// an ELF file in the bundle check below; add its darwin-arm64 lockfile key here.
const DARWIN_PACKAGES = [
  "node_modules/@msgpackr-extract/msgpackr-extract-darwin-arm64",
  "node_modules/sherpa-onnx-darwin-arm64",
  "packages/server/node_modules/@esbuild/darwin-arm64",
];

const RCODESIGN = {
  url: "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz",
  sha256: "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002",
  dir: "apple-codesign-0.29.0-x86_64-unknown-linux-musl",
};

function run(name, command, commandArgs, options = {}) {
  timer.run(name, () => {
    log(`${command} ${commandArgs.join(" ")}`);
    const result = spawnSync(command, commandArgs, { stdio: ["ignore", 2, 2], ...options });
    if (result.status !== 0) fail(`${name} failed (exit ${result.status})`);
  });
}

function git(gitArgs) {
  return spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" }).stdout.trim();
}

function fileDigest(file, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding);
}

async function download(url, file) {
  log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) fail(`download failed (${response.status}): ${url}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
  renameSync(tmp, file);
}

/** Downloads `url` into the cache once; `check(file)` must hold every time it is used. */
async function cached(url, name, check, what) {
  mkdirSync(cache, { recursive: true });
  const file = path.join(cache, name);
  if (!existsSync(file) || !check(file)) {
    await download(url, file);
    if (!check(file)) {
      rmSync(file, { force: true });
      fail(`${what} does not match its expected hash; deleted it`);
    }
  }
  return file;
}

// 1. darwin-arm64 natives into node_modules, at the lockfile's versions.
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const darwinNames = [];
for (const key of DARWIN_PACKAGES) {
  const entry = lock.packages?.[key];
  if (!entry?.resolved || !entry.integrity?.startsWith("sha512-")) {
    fail(`package-lock.json has no sha512 entry for ${key}; update DARWIN_PACKAGES`);
  }
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  darwinNames.push(name);
  const want = entry.integrity.slice("sha512-".length);
  const tarball = await cached(
    entry.resolved,
    `${name.replace("/", "+")}-${entry.version}.tgz`,
    (file) => fileDigest(file, "sha512", "base64") === want,
    `${name}@${entry.version}`,
  );
  const target = path.join(root, key);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  run(`unpack ${name}@${entry.version}`, "tar", [
    "xzf",
    tarball,
    "-C",
    target,
    "--strip-components=1",
  ]);
}

// 2. electron-builder, signing off (it cannot sign on Linux).
const release = path.join(desktop, "release", "mac-arm64");
rmSync(release, { recursive: true, force: true });
run(
  "electron-builder",
  "npx",
  [
    "electron-builder",
    "--config",
    "electron-builder.yml",
    "--mac",
    "--dir",
    "--arm64",
    "-c.mac.identity=null",
    "-c.mac.hardenedRuntime=false",
    "-c.mac.notarize=false",
  ],
  {
    cwd: desktop,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", PASEO_DESKTOP_SMOKE: "" },
  },
);
const app = path.join(release, "Paseo.app");
const unpacked = path.join(app, "Contents/Resources/app.asar.unpacked");

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (visit(full, entry) === false) continue;
    if (entry.isDirectory()) walk(full, visit);
  }
}

// 3. Fix esbuild, prune the Linux copies, and refuse any non-Mac native left.
timer.run("fix up natives", () => {
  const found = new Set();
  const platformDir = /^(?:linux|win32|darwin|freebsd|openbsd|netbsd|sunos|aix|android)-[a-z0-9]+$/;
  const pruned = [];
  walk(unpacked, (full, entry) => {
    if (!entry.isDirectory()) return;
    const rel = path.relative(unpacked, full);
    for (const name of darwinNames) {
      // name is e.g. "@esbuild/darwin-arm64" or "sherpa-onnx-darwin-arm64".
      const prefix = name.slice(0, -"darwin-arm64".length);
      if (rel === `node_modules/${name}` || rel.endsWith(`/node_modules/${name}`)) {
        found.add(name);
        return;
      }
      const at = rel.lastIndexOf("node_modules/");
      if (at < 0) continue;
      const base = rel.slice(at + "node_modules/".length);
      if (base.startsWith(prefix) && platformDir.test(base.slice(prefix.length))) {
        rmSync(full, { recursive: true, force: true });
        pruned.push(rel);
        return false;
      }
    }
  });
  const missing = darwinNames.filter((name) => !found.has(name));
  if (missing.length > 0) fail(`electron-builder did not pack ${missing.join(", ")}`);
  log(`pruned ${pruned.length} non-Mac native package(s): ${pruned.join(", ")}`);

  walk(unpacked, (full, entry) => {
    if (!entry.isDirectory() || entry.name !== "esbuild") return;
    const parent = path.dirname(full);
    const mac = path.join(parent, "@esbuild/darwin-arm64");
    if (!existsSync(path.join(full, "bin/esbuild"))) return;
    if (!existsSync(mac))
      fail(`${path.relative(unpacked, full)} has no @esbuild/darwin-arm64 beside it`);
    const version = (dir) =>
      JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
    if (version(full) !== version(mac)) {
      fail(`esbuild ${version(full)} but @esbuild/darwin-arm64 ${version(mac)} in the app`);
    }
    copyFileSync(path.join(mac, "bin/esbuild"), path.join(full, "bin/esbuild"));
  });

  const foreign = [];
  const head = Buffer.alloc(4);
  walk(app, (full, entry) => {
    if (!entry.isFile()) return;
    const fd = openSync(full, "r");
    try {
      const bytes = readSync(fd, head, 0, 4, 0);
      if (bytes === 4 && head.readUInt32BE(0) === 0x7f454c46) foreign.push(`${full} (ELF)`);
      else if (bytes >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
        // MZ alone is common in data; a PE file has "PE\0\0" at the offset stored at 0x3c.
        const offset = Buffer.alloc(4);
        if (readSync(fd, offset, 0, 4, 0x3c) === 4) {
          const pe = Buffer.alloc(4);
          if (
            readSync(fd, pe, 0, 4, offset.readUInt32LE(0)) === 4 &&
            pe.readUInt32BE(0) === 0x50450000
          ) {
            foreign.push(`${full} (PE)`);
          }
        }
      }
    } finally {
      closeSync(fd);
    }
  });
  if (foreign.length > 0) {
    fail(
      `non-Mac binaries left in the app (add their darwin-arm64 package to DARWIN_PACKAGES):\n  ${foreign.join("\n  ")}`,
    );
  }
});

// 4. Ad-hoc sign.
const rcodesignTarball = await cached(
  RCODESIGN.url,
  path.basename(decodeURIComponent(RCODESIGN.url)),
  (file) => fileDigest(file, "sha256", "hex") === RCODESIGN.sha256,
  "rcodesign",
);
const rcodesign = path.join(cache, RCODESIGN.dir, "rcodesign");
if (!existsSync(rcodesign)) run("unpack rcodesign", "tar", ["xzf", rcodesignTarball, "-C", cache]);
run("rcodesign sign", rcodesign, ["sign", app]);

// 5. Tarball, then the JSON that marks it complete.
mkdirSync(outDir, { recursive: true });
const tarball = path.join(outDir, TARBALL);
const partial = path.join(outDir, `.${TARBALL}.partial`);
run("tar", "tar", ["czf", partial, "-C", release, "Paseo.app"]);
renameSync(partial, tarball);
const sha256 = await new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(tarball)
    .on("data", (chunk) => hash.update(chunk))
    .on("end", () => resolve(hash.digest("hex")))
    .on("error", reject);
});
const meta = {
  sha: git(["rev-parse", "HEAD"]),
  branch: git(["branch", "--show-current"]),
  dirty: git(["status", "--porcelain"]) !== "",
  version: JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8")).version,
  builtAt: new Date().toISOString(),
  tarball: TARBALL,
  bytes: statSync(tarball).size,
  sha256,
};
writeFileSync(path.join(outDir, META), `${JSON.stringify(meta, null, 2)}\n`);
log(`${tarball}: ${(meta.bytes / 1024 ** 2).toFixed(0)} MB, sha256 ${sha256}`);
log(`main ${meta.sha.slice(0, 9)}${meta.dirty ? " with uncommitted changes" : ""}`);

// 6. Keep the newest tarballs only; the build logs beside them stay.
if (existsSync(buildRoot)) {
  const builds = readdirSync(buildRoot)
    .filter((name) => existsSync(path.join(buildRoot, name, TARBALL)))
    .sort()
    .toReversed();
  for (const name of builds.slice(KEEP_TARBALLS)) {
    rmSync(path.join(buildRoot, name, META), { force: true });
    rmSync(path.join(buildRoot, name, TARBALL), { force: true });
  }
}
process.stderr.write(`${timer.table()}\n`);
