// E2E fixture daemon for question cards and the Style feature. The stock mock provider asks
// only multi-question forms and advertises no features; this one asks a single formatted
// question (the one-tap card) and offers an output_style select, and reports over IPC what
// the daemon hands the provider: question responses and the feature values a session starts with.
import { randomUUID } from "node:crypto";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import {
  MockLoadTestAgentClient,
  MockLoadTestAgentSession,
} from "../agent/providers/mock-load-test-agent.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";

export const ONE_TAP_QUESTION = {
  question: "Ship **the hotfix** to `main` now?",
  header: "ship",
  options: [{ label: "Yes, ship it, today" }, { label: "No" }],
  multiSelect: false,
};

export const OUTPUT_STYLE_FEATURE: AgentFeature = {
  type: "select",
  id: "output_style",
  label: "Style",
  value: "default",
  options: [
    { id: "default", label: "Default" },
    { id: "explanatory", label: "Explanatory" },
    { id: "learning", label: "Learning" },
  ],
};

class ForkUiSession extends MockLoadTestAgentSession {
  override subscribe(callback: Parameters<MockLoadTestAgentSession["subscribe"]>[0]) {
    return super.subscribe((event) => {
      // The request object is the one the session keeps pending, so the rewrite holds for
      // the event and for every later getPendingPermissions read.
      if (event.type === "permission_requested" && event.request.kind === "question") {
        event.request.input = { questions: [ONE_TAP_QUESTION] };
      }
      callback(event);
    });
  }

  override async respondToPermission(
    requestId: string,
    response: Parameters<MockLoadTestAgentSession["respondToPermission"]>[1],
  ) {
    process.send?.({ type: "question-response", requestId, response, sessionId: this.id });
    return super.respondToPermission(requestId, response);
  }
}

class ForkUiClient extends MockLoadTestAgentClient {
  override async createSession(config: Parameters<MockLoadTestAgentClient["createSession"]>[0]) {
    process.send?.({ type: "session-created", featureValues: config.featureValues ?? {} });
    return new ForkUiSession({ config, sessionId: randomUUID() });
  }

  async listFeatures(): Promise<AgentFeature[]> {
    return [OUTPUT_STYLE_FEATURE];
  }
}

async function main(): Promise<void> {
  const daemon = await createTestPaseoDaemon({
    agentClients: { mock: new ForkUiClient() },
    isDev: true,
    mcpEnabled: false,
    corsAllowedOrigins: [`http://localhost:${process.env.E2E_METRO_PORT}`],
  });
  const shutdown = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("disconnect", () => void shutdown());
  process.send?.({ type: "ready", port: daemon.port, serverId: daemon.daemon.getServerId() });
}

void main().catch((error: unknown) => {
  process.send?.({ type: "error", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
