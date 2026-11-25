#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// Brings a checkout's node_modules and built workspace packages up to date, skipping each part
// whose inputs match its last successful run. The fork build scripts call this in place of
// `npm ci && npm run build:server && npm run build:plugin`.
//
//   node scripts/fork-prepare.mjs            install and build what changed (in the cwd's checkout)
//   node scripts/fork-prepare.mjs --dry-run  say what would run; change nothing
//
// install   npm ci, when package-lock.json, patches/, the postinstall script, Node or npm differ
//           from the last install. Stamp: node_modules/.fork-install-stamp (npm ci deletes it).
// packages  build:server:clean (highlight, protocol, client, relay, plugin, server, cli) plus
//           expo-two-way-audio, which covers build:server, build:plugin and build:app-deps. Runs
//           when the install, the root build config or any package source (tracked or untracked,
//           not ignored) differs from the last build, or an output directory is missing.
//           Stamp: node_modules/.fork-packages-stamp.
//
// A per-checkout lock makes a second caller wait instead of reinstalling under the first.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { acquireLock, createTimer, gitRoot, hashInputs, readStamp } from "./fork-build-lib.mjs";

const { values: args } = parseArgs({
  options: { "dry-run": { type: "boolean", default: false } },
});

const log = (message) => process.stderr.write(`[fork-prepare] ${message}\n`);
const root = gitRoot();
const timer = createTimer(log);

const PACKAGES = {
  highlight: "dist",
  protocol: "dist",
  client: "dist",
  relay: "dist",
  plugin: "dist",
  server: "dist",
  cli: "dist",
  "expo-two-way-audio": "build",
};
const ROOT_BUILD_INPUTS = [
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "scripts/clean-package-dist.mjs",
];

function run(command, commandArgs) {
  log(`${command} ${commandArgs.join(" ")}`);
  // Build output goes to stderr so callers' stdout stays theirs.
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: ["ignore", 2, 2] });
  if (result.status !== 0) {
    log(`${command} ${commandArgs.join(" ")} failed (exit ${result.status})`);
    process.exit(1);
  }
}

const installStamp = path.join(root, "node_modules", ".fork-install-stamp");
const packagesStamp = path.join(root, "node_modules", ".fork-packages-stamp");

const release = args["dry-run"]
  ? () => {}
  : acquireLock(
      path.join(
        path.resolve(
          root,
          spawnSync("git", ["rev-parse", "--git-dir"], {
            cwd: root,
            encoding: "utf8",
          }).stdout.trim(),
        ),
        "fork-prepare.lock",
      ),
      log,
    );

const npmVersion = spawnSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).stdout.trim();
const installKey = timer.run("hash install inputs", () =>
  hashInputs(
    root,
    ["package-lock.json", "patches", "scripts/postinstall-patches.mjs"],
    [`node ${process.version} ${process.platform}-${process.arch}`, `npm ${npmVersion}`],
  ),
);
const installFresh = readStamp(installStamp) === installKey;
if (installFresh) {
  timer.record("npm ci", 0, "skipped: lockfile and Node unchanged");
} else if (args["dry-run"]) {
  timer.record("npm ci", 0, "would run");
} else {
  timer.run("npm ci", () => run("npm", ["ci", "--no-audit", "--no-fund"]));
  writeFileSync(installStamp, installKey);
}

const packagesKey = timer.run("hash package sources", () =>
  hashInputs(
    root,
    [...ROOT_BUILD_INPUTS, ...Object.keys(PACKAGES).map((name) => `packages/${name}`)],
    [installKey],
  ),
);
const missingOutputs = Object.entries(PACKAGES)
  .map(([name, out]) => `packages/${name}/${out}`)
  .filter((dir) => !existsSync(path.join(root, dir)));
const packagesFresh = readStamp(packagesStamp) === packagesKey && missingOutputs.length === 0;
if (packagesFresh) {
  timer.record("build packages", 0, "skipped: sources unchanged");
} else if (args["dry-run"]) {
  timer.record(
    "build packages",
    0,
    `would run${missingOutputs.length > 0 ? ` (missing ${missingOutputs.join(", ")})` : ""}`,
  );
} else {
  timer.run("build packages", () => {
    run("npm", ["run", "build:server:clean"]);
    run("npm", ["run", "build", "--workspace=@getpaseo/expo-two-way-audio"]);
  });
  writeFileSync(packagesStamp, packagesKey);
}

release();
process.stderr.write(`${timer.table()}\n`);
