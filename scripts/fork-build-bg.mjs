#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// "Build it" without an agent babysitting it. Starts scripts/fork-build.mjs detached and returns
// at once; when the build ends, one message with the result goes to the agent that asked. See
// "Build it" in CLAUDE.md.
//
//   node scripts/fork-build-bg.mjs --notify <agent-id> --pr 81 --pr 83
//
// Every other argument (--pr, --no-e2e, --no-android, --dry-run) goes to fork-build.mjs. The build
// runs as a transient systemd user service (paseo-fork-build-<time>), so it survives the asking
// agent, its turn, and the daemon restarting it. A second build is refused while one runs. Logs,
// the result file and the message go to ~/.paseo-fork-build/bg-<time>/. The woken agent gets the
// summary on green, and on a conflict or a failed check a message that names the PRs and the
// next step (buildMessage in fork-build-lib.mjs).
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMessage, checkoutProblem, gitRoot, paseoCli } from "./fork-build-lib.mjs";

const argv = process.argv.slice(2);
const takeFlag = (name) => {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const [, value] = argv.splice(index, 2);
  return value;
};

const workerDir = takeFlag("--worker");
const notifyId = takeFlag("--notify");
if (!notifyId) {
  process.stderr.write(
    "usage: node scripts/fork-build-bg.mjs --notify <agent-id> [--pr N]... [--no-e2e] [--no-android] [--dry-run]\n",
  );
  process.exit(2);
}
const buildArgs = argv;
const prs = buildArgs.flatMap((arg, i) => (buildArgs[i - 1] === "--pr" ? [arg] : []));

if (workerDir) process.exit(await runWorker());
launch();

function launch() {
  const root = gitRoot();
  // Refuse here, before detaching, so the asking agent sees the reason at once instead of in a
  // message later. A dry run is read-only and may start anywhere.
  const problem = buildArgs.includes("--dry-run") ? null : checkoutProblem(root);
  if (problem) {
    process.stderr.write(`Not starting the build: ${problem}\n`);
    process.exit(1);
  }
  const running = spawnSync(
    "systemctl",
    ["--user", "list-units", "paseo-fork-build-*", "--state=active,activating", "--no-legend"],
    { encoding: "utf8" },
  ).stdout.trim();
  if (running) {
    process.stderr.write(`A fork build is already running:\n${running}\n`);
    process.exit(3);
  }
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(":", "");
  const dir = path.join(os.homedir(), ".paseo-fork-build", `bg-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const unit = `paseo-fork-build-${stamp}`;
  // The unit's environment is clean (no SSH_* variables, which would attach test terminals to the
  // owner's tmux); a login shell brings mise's PATH. Only the daemon target and the e2e worker
  // override (fork-check's E2E_WORKERS) are passed through.
  const forwarded = ["PASEO_HOME", "PASEO_HOST", "PASEO_LISTEN", "E2E_WORKERS"]
    .filter((name) => process.env[name])
    .map((name) => `--setenv=${name}=${process.env[name]}`);
  const started = spawnSync(
    "systemd-run",
    [
      "--user",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      `--working-directory=${root}`,
      "--setenv=SHELL=/bin/bash",
      ...forwarded,
      "--",
      "/bin/bash",
      "-lc",
      'exec "$@"',
      "bash",
      "mise",
      "exec",
      "--",
      "node",
      path.join(root, "scripts/fork-build-bg.mjs"),
      "--worker",
      dir,
      "--notify",
      notifyId,
      ...buildArgs,
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    process.stderr.write(`systemd-run failed: ${started.stderr}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Fork build started as ${unit}.\n` +
      `One message goes to agent ${notifyId} when it ends. Do not wait on it; end your turn.\n` +
      `Progress: tail -f ${dir}/stderr.log   Stop: systemctl --user stop ${unit}\n`,
  );
}

async function runWorker() {
  const resultPath = path.join(workerDir, "result.json");
  const stdoutPath = path.join(workerDir, "stdout.log");
  const stdout = openSync(stdoutPath, "w");
  const stderr = openSync(path.join(workerDir, "stderr.log"), "w");
  const root = gitRoot();
  const exitCode = await new Promise((resolve) => {
    const child = spawn("node", [path.join(root, "scripts/fork-build.mjs"), ...buildArgs], {
      cwd: root,
      env: { ...process.env, PASEO_FORK_BUILD_RESULT: resultPath },
      stdio: ["ignore", stdout, stderr],
    });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
  closeSync(stdout);
  closeSync(stderr);

  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
  const summaryPath = result?.summaryPath;
  const summary =
    summaryPath && existsSync(summaryPath)
      ? readFileSync(summaryPath, "utf8")
      : readFileSync(stdoutPath, "utf8") || "(fork-build wrote no summary)";
  const messagePath = path.join(workerDir, "message.md");
  writeFileSync(
    messagePath,
    buildMessage({ result, exitCode, summary, notifyId, prs, logDir: workerDir }),
  );
  const sent = spawnSync(
    paseoCli(),
    ["send", notifyId, "--prompt-file", messagePath, "--no-wait"],
    { encoding: "utf8" },
  );
  const log = `[fork-build-bg] send to ${notifyId}: exit ${sent.status}\n${sent.stdout}${sent.stderr}`;
  writeFileSync(path.join(workerDir, "send.log"), log);
  process.stderr.write(log);
  return sent.status === 0 ? 0 : 1;
}
