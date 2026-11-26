#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// The nightly upstream catch-up. A user systemd timer on the build host (paseo-fork-sync.timer,
// 03:00 Asia/Bangkok) runs this; see "Syncing with upstream" in CLAUDE.md.
//
//   node scripts/fork-sync-nightly.mjs               run fork-sync --apply-if-green once
//   node scripts/fork-sync-nightly.mjs --dry-run     rehearse: fork-sync --no-check (merge and report,
//                                                    never pushes), and print the agent it would start
//   node scripts/fork-sync-nightly.mjs install       write the timer and service units and enable the timer
//   node scripts/fork-sync-nightly.mjs uninstall     disable and remove them
//   --checkout <path>   (install) the main checkout the timer runs in (default: this repo's main checkout)
//   --assume-exit <n>   skip fork-sync and act as if it exited n (tests the agent step; pair with --dry-run)
//
// What happens after fork-sync, by its exit code: 0 (level with upstream, or merged and pushed
// green) nothing more; 3 (another fork-sync runs) skip; 1 (checks failed) or 2 (conflicts) start
// ONE omp Sonnet 5.5 agent labelled topic=paseo-upstream-sync that resolves it, unless one is
// already running. The agent is a plain `paseo run`, so it outlives this process.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { paseoCli, syncAgentPrompt, syncOutcome } from "./fork-build-lib.mjs";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    "assume-exit": { type: "string" },
    checkout: { type: "string" },
  },
});
const command = positionals[0] ?? "run";
const log = (message) => process.stdout.write(`[fork-sync-nightly] ${message}\n`);

const here = path.resolve(import.meta.dirname, "..");
const commonDir = path.resolve(
  here,
  spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: here,
    encoding: "utf8",
  }).stdout.trim(),
);
const mainCheckout = path.dirname(commonDir);
const syncWorktree = path.join(path.dirname(mainCheckout), "paseo-sync");
const reportPath = path.join(os.homedir(), ".paseo-fork-sync", "last-report.md");

const unitDir = path.join(os.homedir(), ".config/systemd/user");
const SERVICE = "paseo-fork-sync.service";
const TIMER = "paseo-fork-sync.timer";
const systemctl = (...a) => spawnSync("systemctl", ["--user", ...a], { encoding: "utf8" });

if (command === "install") install();
else if (command === "uninstall") uninstall();
else if (command === "run") process.exit(run());
else {
  process.stderr.write(`unknown command ${command}; use run, install or uninstall\n`);
  process.exit(2);
}

function run() {
  // Test terminals run the owner's rc files, and a .bashrc that attaches to tmux over SSH would
  // type the tests' input into the live session; fork scripts also expect a bash SHELL.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].includes(key),
    ),
  );
  env.SHELL = "/bin/bash";
  const assumed = args["assume-exit"];
  let code;
  if (assumed === undefined) {
    const syncArgs = args["dry-run"] ? ["--no-check"] : ["--apply-if-green"];
    log(`node scripts/fork-sync.mjs ${syncArgs.join(" ")} in ${mainCheckout}`);
    const sync = spawnSync("node", ["scripts/fork-sync.mjs", ...syncArgs], {
      cwd: mainCheckout,
      env,
      stdio: "inherit",
    });
    code = sync.status ?? 1;
  } else {
    code = Number(assumed);
  }
  const outcome = syncOutcome(code);
  log(`fork-sync exit ${code}: ${outcome.note}`);
  if (outcome.kind === "done" || outcome.kind === "skip") return 0;
  if (outcome.kind === "crash") return code;

  const prompt = syncAgentPrompt({
    code,
    why: outcome.note,
    reportPath,
    checkout: mainCheckout,
    worktree: syncWorktree,
  });
  const cli = paseoCli();
  const title = `Upstream sync ${new Date().toISOString().slice(0, 10)}`;
  const runArgs = [
    "run",
    "--no-wait",
    "--provider",
    "omp/anthropic/claude-sonnet-5-5",
    "--thinking",
    "medium",
    "--title",
    title,
    "--label",
    "topic=paseo-upstream-sync",
    "--label",
    "role=helper",
    "--label",
    "started-by=fork-sync-timer",
    "--cwd",
    syncWorktree,
    prompt,
  ];
  if (args["dry-run"]) {
    log(`dry run: would start an agent: ${cli} ${JSON.stringify(runArgs.slice(0, -1))}\n${prompt}`);
    return 0;
  }
  if (resolverRunning(cli, env)) {
    log("an upstream-sync agent is already running; not starting another");
    return 0;
  }
  const started = spawnSync(cli, runArgs, { env, encoding: "utf8" });
  log(`paseo run exit ${started.status}\n${started.stdout}${started.stderr}`);
  return started.status === 0 ? 0 : 1;
}

function resolverRunning(cli, env) {
  const listed = spawnSync(cli, ["ls", "-g", "--label", "topic=paseo-upstream-sync", "--json"], {
    env,
    encoding: "utf8",
  });
  if (listed.status !== 0) throw new Error(`paseo ls failed: ${listed.stderr}`);
  return JSON.parse(listed.stdout).some((agent) => agent.status === "running");
}

function install() {
  const checkout = path.resolve(args.checkout ?? mainCheckout);
  mkdirSync(unitDir, { recursive: true });
  // A login shell brings mise's PATH (the clean unit environment has none); mise exec picks the
  // repo's pinned Node. The sync takes up to about 30 minutes with the e2e run.
  writeFileSync(
    path.join(unitDir, SERVICE),
    `# Written by scripts/fork-sync-nightly.mjs ("uninstall" removes it).
[Unit]
Description=Paseo fork: catch fork main up to upstream/main

[Service]
Type=oneshot
TimeoutStartSec=3h
Environment=SHELL=/bin/bash
WorkingDirectory=${checkout}
ExecStart=/bin/bash -lc 'exec mise exec -- node scripts/fork-sync-nightly.mjs'
StandardOutput=append:%h/.paseo-fork-sync/nightly.log
StandardError=append:%h/.paseo-fork-sync/nightly.log
`,
  );
  writeFileSync(
    path.join(unitDir, TIMER),
    `# Written by scripts/fork-sync-nightly.mjs ("uninstall" removes it).
[Unit]
Description=Paseo fork: nightly upstream catch-up at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00 Asia/Bangkok

[Install]
WantedBy=timers.target
`,
  );
  mkdirSync(path.join(os.homedir(), ".paseo-fork-sync"), { recursive: true });
  systemctl("daemon-reload");
  const enabled = systemctl("enable", "--now", TIMER);
  if (enabled.status !== 0) throw new Error(`enable failed: ${enabled.stderr}`);
  log(
    `installed for ${checkout}; next run: ${systemctl("show", "-p", "NextElapseUSecRealtime", "--value", TIMER).stdout.trim()}`,
  );
}

function uninstall() {
  systemctl("disable", "--now", TIMER);
  rmSync(path.join(unitDir, SERVICE), { force: true });
  rmSync(path.join(unitDir, TIMER), { force: true });
  systemctl("daemon-reload");
  log("removed");
}
