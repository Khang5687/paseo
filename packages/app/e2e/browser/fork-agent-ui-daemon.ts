import { fork } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import { killProcessTree } from "../support/helpers/spawn-node";

// Drives packages/server/src/server/test-utils/fork-agent-ui-daemon.ts: a daemon whose mock
// provider asks one formatted question and offers an output_style select feature.

const daemonMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), port: z.number(), serverId: z.string() }),
  z.object({
    type: z.literal("question-response"),
    requestId: z.string(),
    response: z.unknown(),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal("session-created"),
    featureValues: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export interface ForkAgentUiDaemon {
  port: number;
  serverId: string;
  questionResponses: unknown[];
  createdFeatureValues: Record<string, unknown>[];
  output: string[];
  /** Saves the daemon as the browser's only extra host; call before navigating to its routes. */
  registerHost(page: Page): Promise<void>;
  stop(): Promise<void>;
}

export async function startForkAgentUiDaemon(): Promise<ForkAgentUiDaemon> {
  const serverDir = path.resolve(__dirname, "../../../server");
  const child = fork(path.join(serverDir, "src/server/test-utils/fork-agent-ui-daemon.ts"), {
    cwd: serverDir,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const output: string[] = [];
  child.stdout?.on("data", (data: Buffer) => output.push(data.toString()));
  child.stderr?.on("data", (data: Buffer) => output.push(data.toString()));
  const ready = Promise.withResolvers<{ port: number; serverId: string }>();
  const questionResponses: unknown[] = [];
  const createdFeatureValues: Record<string, unknown>[] = [];
  child.on("message", (message: unknown) => {
    const parsed = daemonMessage.parse(message);
    if (parsed.type === "ready") ready.resolve(parsed);
    if (parsed.type === "question-response") questionResponses.push(parsed.response);
    if (parsed.type === "session-created") createdFeatureValues.push(parsed.featureValues);
    if (parsed.type === "error") ready.reject(new Error(parsed.error));
  });
  child.once("exit", (code) => ready.reject(new Error(`Fork UI daemon exited with ${code}`)));
  const timeout = setTimeout(
    () => ready.reject(new Error("Fork UI daemon startup timed out")),
    30_000,
  );
  try {
    const { port, serverId } = await ready.promise;
    return {
      port,
      serverId,
      questionResponses,
      createdFeatureValues,
      output,
      async registerHost(page) {
        await page.goto("/", { waitUntil: "commit" });
        const host = buildSeededHost({
          serverId,
          endpoint: `127.0.0.1:${port}`,
          label: "Fork UI host",
          nowIso: new Date().toISOString(),
        });
        await page.evaluate((extraHost) => {
          localStorage.setItem("@paseo:e2e-extra-hosts", JSON.stringify([extraHost]));
        }, host);
      },
      stop: () => killProcessTree(child),
    };
  } catch (error) {
    await killProcessTree(child);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
