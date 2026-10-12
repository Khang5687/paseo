/**
 * Real isolated OMP account-routing host for browser e2e.
 *
 * Imported by a spec this file only spawns itself (`--serve`); the child runs the daemon's own
 * `createTestPaseoDaemon` with its scripted OMP JSONL peer and synthetic accounts. No credential,
 * network or provider is involved, and the page talks to it through the real client. Native-side
 * events (serving, quota pause, recovery) are driven by writing JSON lines to the child's stdin.
 */
import { createInterface } from "node:readline";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { wsRoutePatternForPort } from "./daemon-port";
import { killProcessTree, spawnTsx } from "./spawn-node";

const SELF = __filename;

export type RoutingFixtureOp =
  | { op: "serve" }
  | { op: "pause" }
  | { op: "recover" }
  | { op: "mutate"; command: Record<string, unknown> }
  | { op: "archive-agent" }
  | { op: "open-agent" }
  | { op: "revision" };

export interface RoutingFixtureHost {
  serverId: string;
  port: number;
  /** Runs one op in the child and resolves with its result once the daemon has applied it. */
  run(op: RoutingFixtureOp): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startRoutingFixtureHost(
  options: { corsOrigin?: string; agent?: boolean; scenario?: "exhausted" } = {},
): Promise<RoutingFixtureHost> {
  const metroPort = process.env.E2E_METRO_PORT;
  const child: ChildProcess = spawnTsx(SELF, ["--serve"], {
    cwd: path.resolve(path.dirname(SELF), "../../../../server"),
    env: {
      ...process.env,
      ROUTING_FIXTURE_CORS:
        options.corsOrigin ?? (metroPort ? `http://localhost:${metroPort}` : ""),
      ROUTING_FIXTURE_AGENT: options.agent === false ? "0" : "1",
      ROUTING_FIXTURE_SCENARIO: options.scenario ?? "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).split("\n").slice(-40).join("\n");
  });
  const waiting = new Map<string, (result: Record<string, unknown>) => void>();
  let ready: (value: { port: number; serverId: string }) => void = () => undefined;
  const readyPromise = new Promise<{ port: number; serverId: string }>((resolve, reject) => {
    ready = resolve;
    child.once("exit", () => reject(new Error(`Routing fixture exited early\n${stderr}`)));
    setTimeout(() => reject(new Error(`Routing fixture did not start\n${stderr}`)), 60_000);
  });
  createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.ready)
        ready({ port: message.port as number, serverId: message.serverId as string });
      else if (typeof message.ack === "string") waiting.get(message.ack)?.(message);
    } catch {
      // Not protocol output.
    }
  });
  const started = await readyPromise;
  let counter = 0;
  return {
    ...started,
    run: (op) =>
      new Promise((resolve) => {
        const id = String(++counter);
        waiting.set(id, resolve);
        child.stdin?.write(`${JSON.stringify({ ...op, id })}\n`);
      }),
    close: () => killProcessTree(child),
  };
}

// --- page helpers ----------------------------------------------------------------------------

export function routingSection(page: Page): Locator {
  return page.getByTestId("host-account-routing-card");
}

export function routingRow(page: Page, label: string): Locator {
  return page.locator('[data-testid^="omp-routing-row-"]').filter({ hasText: label });
}

export async function expectRoutingLoaded(page: Page): Promise<void> {
  // Loaded lazily: the fixture child shares this file and must not load Playwright's expect.
  const { expect } = await import("@playwright/test");
  await expect(page.getByTestId("omp-routing-controls")).toBeVisible({ timeout: 30_000 });
}

/**
 * Sits between the page and the host's WebSocket. While held it drops routing push frames, so the
 * page keeps a revision the host has moved past and its next mutation loses. With `readOnly` it
 * strips `daemon.manage` from the session's advertised permissions, the data the UI reads to
 * decide editability; the host still authorizes every request. Install before the app loads.
 */
export async function installRoutingGate(
  page: Page,
  port: number,
  options: { readOnly?: boolean } = {},
) {
  let held = false;
  await page.routeWebSocket(wsRoutePatternForPort(String(port)), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      // Text frames arrive as strings; match either form so a binary frame cannot slip past.
      const text = typeof message === "string" ? message : message.toString("utf8");
      if (held && text.includes("account.routing.state.update")) return;
      if (options.readOnly && text.includes("server_info")) {
        ws.send(text.replaceAll("daemon.manage", "daemon.read"));
        return;
      }
      ws.send(message);
    });
    ws.onClose((code, reason) => void server.close({ code, reason }));
    server.onClose((code, reason) => void ws.close({ code, reason }));
  });
  return {
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
    },
  };
}

// --- fixture daemon (child process) ----------------------------------------------------------

async function serve(): Promise<void> {
  const root = path.resolve(path.dirname(SELF), "../../../../server/src/server");
  const { createTestPaseoDaemon } = await import(`${root}/test-utils/paseo-daemon.js`);
  const { DaemonClient } = await import(`${root}/test-utils/daemon-client.js`);
  const fake = await import(`${root}/agent/providers/omp/test-utils/fake-omp.js`);
  const { ROUTING_MODEL, routingAccount, routingCatalog } = fake;

  const HOUR = 3_600_000;
  const hour = (n: number) => Date.now() + n * HOUR;
  let revision = 1;
  const window = (id: string, label: string, used: number, scope: unknown) => ({
    id,
    label,
    scope,
    usedFraction: used,
    resetAt: hour(id === "5h" ? 2 : 90),
    observedAt: Date.now(),
    validUntil: hour(1),
    source: "usage-full",
  });
  const shared = { kind: "shared" };
  const fresh = (row: number, patch: Record<string, unknown>, display: Record<string, unknown>) => {
    const account = routingAccount(row, patch);
    return {
      ...account,
      display: { ...account.display, ...display },
      billing: { ...account.billing, observedAt: Date.now(), validUntil: hour(1) },
    };
  };
  const accounts = (blocked: boolean) => {
    if (process.env.ROUTING_FIXTURE_SCENARIO === "exhausted") {
      // One personal account whose weekly limit is used up: the owner's real screen.
      return [
        fresh(
          1,
          {
            windows: [
              window("5h", "Claude 5 Hour", 0, shared),
              window("7d", "Claude 7 Day", 1, shared),
              window("7d", "Claude 7 Day (Fable)", 1, { kind: "model", modelId: "fable" }),
            ],
            quotaBlocks: [
              {
                limitId: "7d",
                scope: shared,
                resetAt: hour(90),
                observedAt: Date.now(),
                source: "native-usage",
                confirmed: true,
              },
            ],
          },
          {
            email: "solo@example.test",
            organizationName: "solo@example.test's Organization",
            accountId: "acct-1",
            organizationId: "org-a",
          },
        ),
      ];
    }
    const block = blocked
      ? [
          {
            limitId: "5h",
            scope: shared,
            resetAt: hour(2),
            observedAt: Date.now(),
            source: "native-usage",
            confirmed: true,
          },
        ]
      : [];
    return [
      fresh(
        1,
        {
          windows: [
            window("5h", "5h", 0.4, shared),
            window("7d", "7d", 0.85, shared),
            window("7d", "Claude 7 Day (Sonnet)", 0.2, {
              kind: "model",
              modelId: "claude-sonnet-4-5",
            }),
          ],
          quotaBlocks: block,
        },
        {
          email: "ada@example.test",
          organizationName: "Atlas Labs",
          accountId: "acct-1",
          organizationId: "org-a",
        },
      ),
      // Same email as account 3: the host switches both to identity labels.
      fresh(
        2,
        {
          windows: [window("5h", "5h", 1, shared), window("7d", "7d", 0.5, shared)],
          quotaBlocks: block,
        },
        {
          email: "shared@example.test",
          organizationName: "North Co",
          accountId: "acct-2",
          organizationId: "org-n",
        },
      ),
      fresh(
        3,
        {
          windows: [window("5h", "5h", 0.1, shared)],
          billing: {
            state: "enabled",
            observedAt: Date.now(),
            validUntil: hour(1),
            source: "claude-usage-spend",
            sourceRevision: null,
            reason: null,
          },
          quotaBlocks: block,
        },
        {
          email: "shared@example.test",
          organizationName: "South Co",
          accountId: "acct-3",
          organizationId: "org-s",
        },
      ),
    ];
  };
  const catalog = (runtimeInstanceId: string, blocked: boolean) => {
    revision += 1;
    return routingCatalog(runtimeInstanceId, accounts(blocked), {
      catalogRevision: revision,
      observedAt: Date.now(),
      authoritativeObservedAt: Date.now(),
    });
  };

  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    listenPort: Number(process.env.ROUTING_FIXTURE_PORT ?? 0),
    corsAllowedOrigins: process.env.ROUTING_FIXTURE_CORS ? [process.env.ROUTING_FIXTURE_CORS] : [],
    ompRouting: { catalogs: (id: string) => [catalog(id, false)] },
  });
  if (daemon.port === 6767 || daemon.port === 6768)
    throw new Error("Refusing a reserved daemon port");
  const fixture = daemon.routingFixture!;
  let runtimeInstanceId = "";
  let agentId = "";
  const openAgent = async () => {
    const opened = await fixture.openAgent(daemon.staticDir);
    runtimeInstanceId = opened.runtimeInstanceId;
    agentId = opened.agentId;
  };
  if (process.env.ROUTING_FIXTURE_AGENT !== "0") await openAgent();

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
    capabilities: { owned_subscriptions: true },
  });
  await client.connect();
  const serverId = client.getLastServerInfoMessage()?.serverId;

  let ops = 0;
  let waitId = "";
  const admit = async (blocked: boolean, previousWaitId?: string) => {
    const operationId = `op-${++ops}`;
    return fixture.requestAdmission({
      runtimeInstanceId,
      operationId,
      sessionId: "native-1",
      modelId: ROUTING_MODEL,
      catalog: catalog(runtimeInstanceId, blocked),
      ...(previousWaitId ? { previousWaitId } : {}),
    });
  };
  const handlers: Record<
    string,
    (line: Record<string, unknown>) => Promise<Record<string, unknown>>
  > = {
    "open-agent": async () => {
      await openAgent();
      return {};
    },
    "archive-agent": async () => {
      await client.archiveAgent(agentId);
      return {};
    },
    serve: async () => {
      const decision = await admit(false);
      if (decision.kind === "admit") {
        fixture.started({
          runtimeInstanceId,
          admission: decision,
          operationId: `op-${ops}`,
          sessionId: "native-1",
          modelId: ROUTING_MODEL,
        });
      }
      return { decision };
    },
    pause: async () => {
      const decision = await admit(true);
      if (decision.kind === "wait") waitId = decision.waitId;
      return { decision };
    },
    recover: async () => ({ decision: await admit(false, waitId || undefined) }),
    revision: async () => ({
      policyRevision: (await client.getOmpAccountRoutingState()).state.policy.policyRevision,
    }),
    mutate: async (line) => {
      const read = (await client.getOmpAccountRoutingState()).state;
      const result = await client.mutateOmpAccountRouting({
        expectedPolicyRevision: read.policy.policyRevision,
        command: line.command as never,
      });
      return { error: result.error };
    },
  };

  console.log(JSON.stringify({ ready: true, port: daemon.port, serverId }));
  const queue = createInterface({ input: process.stdin });
  for await (const raw of queue) {
    const line = JSON.parse(raw) as Record<string, unknown>;
    const result = await handlers[line.op as string](line).catch((error: unknown) => ({
      failed: String(error),
    }));
    console.log(JSON.stringify({ ack: line.id, ...result }));
  }
  await client.close();
  await daemon.close();
}

if (process.argv.includes("--serve")) {
  serve().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
