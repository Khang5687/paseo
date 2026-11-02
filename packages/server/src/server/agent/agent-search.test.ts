import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "../messages.js";
import type { ManagedAgent } from "./agent-manager.js";
import { parseStoredAgentRecord, type StoredAgentRecord } from "./agent-storage.js";
import { searchAgents, type AgentSearchOptions, type AgentSearchSource } from "./agent-search.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

function record(
  id: string,
  hoursAgo: number,
  fields: Partial<StoredAgentRecord> = {},
): StoredAgentRecord {
  const at = new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString();
  return parseStoredAgentRecord({
    id,
    provider: "codex",
    cwd: "/repo",
    workspaceId: "wks_repo",
    createdAt: at,
    updatedAt: at,
    config: null,
    ...fields,
  });
}

function source(
  records: StoredAgentRecord[],
  live: { agent: ManagedAgent; messages?: { firstUserMessage: string | null } }[] = [],
): AgentSearchSource {
  return {
    manager: {
      listAgents: () => live.map((entry) => entry.agent),
      getSearchableMessages: (agentId) => {
        const entry = live.find((candidate) => candidate.agent.id === agentId);
        return entry?.messages
          ? { firstUserMessage: entry.messages.firstUserMessage, lastAssistantMessage: null }
          : null;
      },
    },
    storage: { list: async () => records },
    projectLive: async (agent) => ({ id: agent.id, title: "live" }) as AgentSnapshotPayload,
    projectStored: (stored) => ({ id: stored.id, title: stored.title }) as AgentSnapshotPayload,
  };
}

async function search(
  searchSource: AgentSearchSource,
  options: Partial<AgentSearchOptions> & Pick<AgentSearchOptions, "query">,
) {
  return searchAgents(searchSource, { includeArchived: true, limit: 10, now: NOW, ...options });
}

describe("searchAgents", () => {
  it("requires every query word, in any field, case-insensitively", async () => {
    const result = await search(
      source([
        record("both", 1, {
          title: "Payment service",
          firstUserMessage: "Fix the flaky WEBHOOK retry",
        }),
        record("one", 1, { title: "Payment dashboard" }),
      ]),
      { query: "payment webhook" },
    );

    expect(result.matches.map((match) => match.agent.id)).toEqual(["both"]);
    expect(result.matches[0]!.matchedFields).toEqual(["title", "firstUserMessage"]);
  });

  it("matches labels and the latest assistant message", async () => {
    const result = await search(
      source([
        record("label", 1, { labels: { ticket: "PAY-123" } }),
        record("reply", 2, { lastAssistantMessage: "Root cause: a stale idempotency key." }),
      ]),
      { query: "pay-123" },
    );
    expect(result.matches.map((match) => match.agent.id)).toEqual(["label"]);
    expect(result.matches[0]!.snippet).toEqual({ field: "labels", text: "ticket=PAY-123" });

    const reply = await search(
      source([
        record("reply", 2, { lastAssistantMessage: "Root cause: a stale idempotency key." }),
      ]),
      { query: "idempotency" },
    );
    expect(reply.matches[0]!.snippet.field).toBe("lastAssistantMessage");
  });

  it("ranks a title match above an older or newer message-only match, then by recency", async () => {
    const result = await search(
      source([
        record("message-new", 1, { firstUserMessage: "look into the deploy pipeline" }),
        record("title-old", 50, { title: "Deploy pipeline" }),
        record("title-new", 3, { title: "Deploy pipeline" }),
      ]),
      { query: "deploy pipeline" },
    );

    expect(result.matches.map((match) => match.agent.id)).toEqual([
      "title-new",
      "title-old",
      "message-new",
    ]);
  });

  it("includes archived agents by default and drops them when asked", async () => {
    const records = [
      record("active", 1, { title: "Webhook retries" }),
      record("archived", 2, { title: "Webhook retries", archivedAt: new Date(NOW).toISOString() }),
    ];

    const all = await search(source(records), { query: "webhook" });
    const activeOnly = await search(source(records), { query: "webhook", includeArchived: false });

    expect(all.matches.map((match) => match.agent.id)).toEqual(["active", "archived"]);
    expect(activeOnly.matches.map((match) => match.agent.id)).toEqual(["active"]);
  });

  it("applies cwd, workspace, provider, and recency filters before scanning", async () => {
    const records = [
      record("match", 1, { title: "Webhook", cwd: "/repo/packages/server" }),
      record("other-dir", 1, { title: "Webhook", cwd: "/elsewhere" }),
      record("other-workspace", 1, { title: "Webhook", workspaceId: "wks_other" }),
      record("other-provider", 1, { title: "Webhook", provider: "opencode" }),
      record("stale", 100, { title: "Webhook" }),
    ];

    const result = await search(source(records), {
      query: "webhook",
      cwd: "/repo",
      workspaceId: "wks_repo",
      provider: "codex",
      sinceHours: 24,
    });

    expect(result.matches.map((match) => match.agent.id)).toEqual(["match"]);
  });

  it("scans only the newest agents and reports the truncation", async () => {
    const records = [
      record("newest", 1, { title: "Unrelated" }),
      record("middle", 2, { title: "Unrelated" }),
      record("oldest", 3, { title: "Webhook" }),
    ];

    const capped = await search(source(records), { query: "webhook", scanLimit: 2 });
    const full = await search(source(records), { query: "webhook", scanLimit: 3 });

    expect(capped).toMatchObject({ matches: [], scanned: 2, truncated: true });
    expect(full.matches.map((match) => match.agent.id)).toEqual(["oldest"]);
    expect(full.truncated).toBe(false);
  });

  it("reads a loaded agent's in-memory timeline before its stored copy", async () => {
    const stored = record("live", 1, { firstUserMessage: "an older first prompt" });
    const agent = {
      id: "live",
      provider: "codex",
      cwd: "/repo",
      workspaceId: "wks_repo",
      updatedAt: new Date(NOW),
      labels: {},
      config: {},
    } as unknown as ManagedAgent;

    const result = await search(
      source([stored], [{ agent, messages: { firstUserMessage: "Migrate the billing cron" } }]),
      { query: "billing cron" },
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.agent.title).toBe("live");
    expect(result.matches[0]!.snippet).toEqual({
      field: "firstUserMessage",
      text: "Migrate the billing cron",
    });
  });

  it("cuts long fields to a snippet around the match", async () => {
    const message = `${"a".repeat(400)} deploy pipeline ${"b".repeat(400)}`;
    const result = await search(source([record("long", 1, { firstUserMessage: message })]), {
      query: "deploy pipeline",
    });

    const snippet = result.matches[0]!.snippet.text;
    expect(snippet).toContain("deploy pipeline");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(162);
  });
});
