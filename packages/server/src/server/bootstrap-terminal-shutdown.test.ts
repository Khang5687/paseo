import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";

import { createPaseoDaemon, type PaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { BuiltinPluginLoader } from "./plugins/builtin/index.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

let tempRoot: string | null = null;
let staticDir: string | null = null;
const daemons: PaseoDaemon[] = [];

afterEach(async () => {
  // Leftover terminals belong to the test: close them with the last daemon.
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop().catch(() => undefined)));
  await Promise.all([
    tempRoot ? rm(tempRoot, { recursive: true, force: true }) : Promise.resolve(),
    staticDir ? rm(staticDir, { recursive: true, force: true }) : Promise.resolve(),
  ]);
  tempRoot = null;
  staticDir = null;
});

async function startDaemon(paseoHome: string): Promise<PaseoDaemon> {
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir: staticDir!,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
    } as PaseoDaemonConfig,
    pino({ level: "silent" }),
    { builtinPlugins: new BuiltinPluginLoader(undefined, []) },
  );
  daemons.push(daemon);
  return daemon;
}

test("a keep-terminals stop waits for pending terminal requests, so a late owner move survives", async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-terminal-shutdown-"));
  staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
  const paseoHome = path.join(tempRoot, ".paseo");

  const first = await startDaemon(paseoHome);
  const terminal = await first.terminalManager.createTerminal({
    workspaceId: "ws-owner",
    cwd: tempRoot,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000);"],
  });
  expect(terminal.getOwnerAgentId()).toBeNull();

  // The move RPC is fire-and-forget. Send it in the same tick the daemon detaches, the last
  // instant a client can still reach the daemon. Whether the worker drops the request when its
  // socket closes first depends on timing, so the stop path is also checked for the wait itself.
  const detach = first.terminalManager.detach.bind(first.terminalManager);
  const detachOptions: unknown[] = [];
  first.terminalManager.detach = (options) => {
    detachOptions.push(options);
    expect(first.terminalManager.setTerminalOwner(terminal.id, "agent-b")).toBe(true);
    return detach(options);
  };
  await first.stop({ keepTerminals: true });
  daemons.splice(daemons.indexOf(first), 1);
  expect(detachOptions).toEqual([{ afterPendingRequests: true }]);

  const second = await startDaemon(paseoHome);
  expect(second.terminalManager.getTerminal(terminal.id)?.getOwnerAgentId()).toBe("agent-b");
}, 60000);
