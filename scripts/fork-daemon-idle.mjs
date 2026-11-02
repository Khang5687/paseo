#!/usr/bin/env node
// Fork-only (Khang5687/paseo); never upstreamed.
// Answers "can the daemon be swapped now without interrupting work?" for scripts/fork-daemon.sh
// (Mac) and scripts/fork-remote-daemon.sh (SSH hosts). See "Running the fork" in CLAUDE.md.
//
//   node fork-daemon-idle.mjs --modules <dir> [--home <PASEO_HOME>]
//
// <dir> holds node_modules/@getpaseo/{client,server} with built dist/ (a repo checkout, or
// Paseo.app/Contents/Resources/app.asar run under the app's Helper with ELECTRON_RUN_AS_NODE=1).
// Prints one line per thing still working. Exit 0 idle, 1 busy, 2 could not ask the daemon.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * What keeps the daemon busy. Empty means a restart interrupts nothing: agents waiting for a
 * person (finished, attention, error) are idle, and so is a paused queue. A queue that is not
 * paused drains into an idle agent on its own, so it counts as work about to start.
 */
export function busyReasons({ agents, workspaces, schedules }) {
  const reasons = [];
  for (const agent of agents) {
    const name = agent.title?.trim() || agent.id.slice(0, 8);
    if (agent.status === "running" || agent.status === "initializing") {
      reasons.push(`agent ${name} is ${agent.status}`);
    }
    const permissions = agent.pendingPermissions?.length ?? 0;
    if (permissions > 0) {
      reasons.push(`agent ${name} waits on ${permissions} permission request(s)`);
    }
    const queued = agent.queuedMessages?.length ?? 0;
    if (queued > 0 && !agent.queuePaused && agent.status === "idle" && permissions === 0) {
      reasons.push(`agent ${name} has ${queued} queued message(s) about to send`);
    }
  }
  for (const workspace of workspaces) {
    const subagents = workspace.runningSubagentCount ?? 0;
    if (subagents > 0) {
      reasons.push(`workspace ${workspace.name ?? workspace.id} has ${subagents} running subagent(s)`);
    }
  }
  for (const schedule of schedules) {
    if (schedule.runs?.some((run) => run.status === "running")) {
      reasons.push(`schedule ${schedule.name ?? schedule.id} has a run in progress`);
    }
  }
  return reasons;
}

async function fetchPages(fetchPage) {
  const entries = [];
  let cursor;
  do {
    const payload = await fetchPage({ limit: 200, ...(cursor ? { cursor } : {}) });
    entries.push(...payload.entries);
    cursor = payload.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}

async function loadState({ modules, home }) {
  const requireFrom = createRequire(path.join(modules, "package.json"));
  const load = (specifier) => import(pathToFileURL(requireFrom.resolve(specifier)).href);
  const { createHostClient } = await load("@getpaseo/client/node");
  const control = await load("@getpaseo/server/daemon-control");
  const paseoHome = home ?? control.resolvePaseoHome(process.env);
  const { listen } = await control.waitForDaemonReady(paseoHome, { timeoutMs: 10_000 });
  let clientId = "cid_fork_daemon_swap";
  try {
    clientId = readFileSync(path.join(paseoHome, "cli-client-id"), "utf8").trim() || clientId;
  } catch {}
  const password = process.env.PASEO_PASSWORD || undefined;
  const client = createHostClient(listen, {
    clientId,
    clientType: "cli",
    ...(password
      ? { password }
      : { localCredential: () => control.readLocalCredentialForTarget(paseoHome, listen) ?? undefined }),
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    const filter = { includeBackground: true };
    const agentEntries = await fetchPages((page) =>
      client.fetchAgents({ filter, sort: [{ key: "created_at", direction: "desc" }], page }),
    );
    const workspaces = await fetchPages((page) => client.fetchWorkspaces({ filter, page }));
    const schedules = [];
    for (const summary of (await client.scheduleList()).schedules) {
      const { schedule } = await client.scheduleInspect({ id: summary.id });
      if (schedule) schedules.push(schedule);
    }
    return { agents: agentEntries.map((entry) => entry.agent), workspaces, schedules };
  } finally {
    await client.close();
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--modules" && value) options.modules = path.resolve(value);
    else if (flag === "--home" && value) options.home = path.resolve(value);
    else throw new Error(`usage: fork-daemon-idle.mjs --modules <dir> [--home <dir>]`);
  }
  if (!options.modules) throw new Error("--modules is required");
  return options;
}

async function main() {
  let state;
  try {
    state = await loadState(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.log(`cannot check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const reasons = busyReasons(state);
  for (const reason of reasons) console.log(reason);
  process.exit(reasons.length === 0 ? 0 : 1);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(invokedPath).href) await main();
