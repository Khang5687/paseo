#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// Builds the fork Android app ("Paseo Debug", sh.paseo.debug, arm64) from the current checkout
// and checks the APK. See "Build it" in CLAUDE.md.
//
//   node scripts/fork-android-apk.mjs            build, copy to ~/Downloads/paseo-fork-main.apk
//   node scripts/fork-android-apk.mjs --dry-run  say what would run; change nothing
//   --out <path>   copy the APK there instead
//
// Incremental: packages/app/android and its build directory are kept between builds.
// `expo prebuild --clean` runs only when the native config changed (app.config.js, the app's
// package.json, config plugins, local module plugins, image assets, patches/, versions of native
// dependencies, the .secrets files, the variant env), or android/ is missing. Gradle runs with its
// build cache. Exit 4: not enough free disk.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  ANDROID_MIN_FREE_GB,
  createTimer,
  freeGb,
  gitRoot,
  hashInputs,
  readStamp,
} from "./fork-build-lib.mjs";

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    out: { type: "string", default: path.join(os.homedir(), "Downloads", "paseo-fork-main.apk") },
  },
});
const dryRun = args["dry-run"];
const log = (message) => process.stderr.write(`[fork-android-apk] ${message}\n`);
const fail = (message, code = 1) => {
  log(message);
  process.exit(code);
};

const root = gitRoot();
const app = path.join(root, "packages/app");
const android = path.join(app, "android");
const timer = createTimer(log);
const PACKAGE_ID = "sh.paseo.debug";

// Without these the APK installs but never receives a push (CLAUDE.md "Running the fork").
const SECRETS = [".secrets/google-services.debug.json", ".secrets/eas.json"];
const missingSecrets = SECRETS.filter((file) => !existsSync(path.join(app, file)));
if (missingSecrets.length > 0) {
  const message = `missing ${missingSecrets.map((file) => `packages/app/${file}`).join(", ")}`;
  if (!dryRun) fail(message);
  log(`${message} (dry run continues)`);
}

// The Mac uses Homebrew's JDK and Android Studio's SDK; Linux (the build host) uses the mise
// installs .tool-versions pins, where .mise.toml points ANDROID_HOME.
function misePin(tool) {
  const pin = readFileSync(path.join(root, ".tool-versions"), "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([name]) => name === tool)?.[1];
  if (!pin) fail(`.tool-versions pins no ${tool}`);
  return pin;
}
const miseInstall = (tool) =>
  path.join(os.homedir(), ".local/share/mise/installs", tool, misePin(tool));
const linux = process.platform === "linux";
const env = {
  ...process.env,
  JAVA_HOME:
    process.env.JAVA_HOME ?? (linux ? miseInstall("java") : "/opt/homebrew/opt/openjdk@21"),
  ANDROID_HOME:
    process.env.ANDROID_HOME ??
    (linux ? miseInstall("android-sdk") : path.join(os.homedir(), "Library/Android/sdk")),
  APP_VARIANT: "development",
  NODE_ENV: "production",
};
// Gradle installs the platform, build tools and NDK the app needs into ANDROID_HOME, but only
// once their licenses are accepted there. mise's SDK starts with cmdline-tools alone.
if (linux && !existsSync(path.join(env.ANDROID_HOME, "licenses"))) {
  const sdkmanager = path.join(
    env.ANDROID_HOME,
    "cmdline-tools",
    misePin("android-sdk"),
    "bin/sdkmanager",
  );
  const message = `no accepted SDK licenses in ${env.ANDROID_HOME}; run: yes | ${sdkmanager} --sdk_root=${env.ANDROID_HOME} --licenses`;
  if (!dryRun) fail(message);
  log(`${message} (dry run continues)`);
}

const free = freeGb();
if (free < ANDROID_MIN_FREE_GB) {
  const message = `${free.toFixed(1)} GB free; the APK build needs ${ANDROID_MIN_FREE_GB} GB`;
  if (!dryRun) fail(`${message}. Free disk space and rerun.`, 4);
  log(`${message} (dry run continues)`);
}

function run(name, command, commandArgs, cwd) {
  if (dryRun) return timer.record(name, 0, "would run");
  timer.run(name, () => {
    log(`${command} ${commandArgs.join(" ")}`);
    const result = spawnSync(command, commandArgs, { cwd, env, stdio: ["ignore", 2, 2] });
    if (result.status !== 0) fail(`${name} failed (exit ${result.status})`);
  });
}

timer.run("prepare", () => {
  const prepare = ["scripts/fork-prepare.mjs", ...(dryRun ? ["--dry-run"] : [])];
  // process.env, not env: npm ci under NODE_ENV=production leaves out devDependencies.
  const result = spawnSync("node", prepare, { cwd: root, stdio: ["ignore", 2, 2] });
  if (result.status !== 0) fail(`prepare failed (exit ${result.status})`);
});

// Prebuild bakes config plugins, icons, google-services.json and the version into android/.
// Autolinking and native sources are Gradle inputs and need no prebuild.
function nativeDependencyVersions() {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const native = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.includes("node_modules/") || entry.link) continue;
    const dir = path.join(root, key);
    if (
      existsSync(path.join(dir, "android")) ||
      existsSync(path.join(dir, "app.plugin.js")) ||
      existsSync(path.join(dir, "expo-module.config.json"))
    ) {
      native.push(`${key}@${entry.version}`);
    }
  }
  return native.sort();
}
const nativeKey = timer.run("hash native config", () => {
  const modulePlugins = readdirSync(path.join(app, "modules")).flatMap((name) =>
    ["app.plugin.js", "expo-module.config.json"].map(
      (file) => `packages/app/modules/${name}/${file}`,
    ),
  );
  const secrets = SECRETS.map((file) => readStamp(path.join(app, file)));
  const variant = [
    "APP_VARIANT",
    "PASEO_FDROID_BUILD",
    "PASEO_WATCHDOG_BUILD",
    "PASEO_PROFILE_BUILD",
  ]
    .map((name) => `${name}=${env[name] ?? ""}`)
    .join(" ");
  return hashInputs(
    root,
    [
      "packages/app/app.config.js",
      "packages/app/package.json",
      "packages/app/native-release-version.js",
      "packages/app/plugins",
      "packages/app/assets/images",
      "patches",
      ...modulePlugins,
    ],
    [variant, ...secrets, ...nativeDependencyVersions()],
  );
});
const prebuildStamp = path.join(android, ".fork-prebuild-stamp");
if (readStamp(prebuildStamp) === nativeKey) {
  timer.record("expo prebuild", 0, "skipped: native config unchanged");
} else {
  run(
    "expo prebuild",
    "npx",
    ["expo", "prebuild", "--platform", "android", "--no-install", "--clean"],
    app,
  );
  if (!dryRun) writeFileSync(prebuildStamp, nativeKey);
}

// Gradle's JS bundle task ignores node_modules, so a change in a workspace package's dist would
// not rerun it. Deleting its outputs forces a fresh bundle; native outputs stay up to date.
if (!dryRun) {
  for (const dir of ["generated/assets", "generated/res/createBundleReleaseJsAndAssets"]) {
    rmSync(path.join(android, "app/build", dir), { recursive: true, force: true });
  }
}
run(
  "gradle assembleRelease",
  "./gradlew",
  [
    "assembleRelease",
    "--no-daemon",
    "--build-cache",
    "--max-workers=2",
    "-Dorg.gradle.parallel=false",
    "-PreactNativeArchitectures=arm64-v8a",
  ],
  android,
);

if (!dryRun) {
  copyFileSync(path.join(android, "app/build/outputs/apk/release/app-release.apk"), args.out);
  const buildTools = path.join(env.ANDROID_HOME, "build-tools");
  const newest = readdirSync(buildTools)
    .filter((name) => existsSync(path.join(buildTools, name, "aapt2")))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (!newest) fail(`no aapt2 under ${buildTools}`);
  const badging = execFileSync(
    path.join(buildTools, newest, "aapt2"),
    ["dump", "badging", args.out],
    {
      encoding: "utf8",
    },
  );
  const found = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(badging);
  const { getNativeReleaseVersion } = createRequire(import.meta.url)(
    path.join(app, "native-release-version.js"),
  );
  const pkgVersion = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")).version;
  const expected = getNativeReleaseVersion(pkgVersion);
  const actual = found ? `${found[1]} ${found[3]} (${found[2]})` : "unreadable badging";
  const want = `${PACKAGE_ID} ${expected.appVersion} (${expected.androidVersionCode})`;
  if (actual !== want) fail(`APK is ${actual}, expected ${want}`);
  log(`${args.out}: ${actual}`);
  const size = spawnSync("du", ["-sh", path.join(android, "app/build")], { encoding: "utf8" });
  log(`android build dir: ${size.stdout.split("\t")[0]}`);
}
process.stderr.write(`${timer.table()}\n`);
