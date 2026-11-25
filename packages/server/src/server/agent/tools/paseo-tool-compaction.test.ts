import { describe, expect, it } from "vitest";

import { TOOL_COMPACTORS, omitEmpty, selectWorkspaceSummaries } from "./paseo-tool-compaction.js";

function compact(tool: string, structured: Record<string, unknown>, input: unknown = {}) {
  const compactor = TOOL_COMPACTORS[tool];
  if (!compactor) throw new Error(`no compactor for ${tool}`);
  return compactor(structured, input);
}

describe("omitEmpty", () => {
  it("drops null, undefined, empty and false values but keeps zero", () => {
    expect(
      omitEmpty({ a: null, b: undefined, c: "", d: [], e: {}, f: false, g: 0, h: "x", i: true }),
    ).toEqual({ g: 0, h: "x", i: true });
  });
});

describe("selectWorkspaceSummaries", () => {
  const summaries = Array.from({ length: 25 }, (_, index) => ({
    workspaceId: `ws-${index}`,
    projectId: index < 5 ? "project-a" : "project-b",
    cwd: `/work/repo-${index}`,
    title: index === 3 ? "Needle" : null,
    isolation: "local",
  }));

  it("keeps caller order and reports how many matches were cut", () => {
    const page = selectWorkspaceSummaries(summaries, {});
    expect(page.items.map((item) => item.workspaceId)).toEqual(
      summaries.slice(0, 20).map((item) => item.workspaceId),
    );
    expect(page.more).toBe(5);
  });

  it("filters by query over title and cwd, projectId and cwd, before limiting", () => {
    expect(selectWorkspaceSummaries(summaries, { query: "needle" }).items).toHaveLength(1);
    expect(selectWorkspaceSummaries(summaries, { query: "REPO-2" })).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ workspaceId: "ws-24" })]),
      more: 0,
    });
    expect(selectWorkspaceSummaries(summaries, { projectId: "project-a", limit: 2 })).toMatchObject(
      { more: 3 },
    );
    expect(selectWorkspaceSummaries(summaries, { cwd: "/work/repo-7" }).items).toEqual([
      expect.objectContaining({ workspaceId: "ws-7" }),
    ]);
  });
});

describe("tool compactors", () => {
  it("keeps unrelated top-level keys such as serverId and truncation notes", () => {
    const result = compact("list_workspaces", {
      serverId: "remote",
      more: 3,
      note: "3 more not shown",
      workspaces: [
        { workspaceId: "w", projectId: "p", cwd: "/c", isolation: "local", title: null },
      ],
    });
    expect(result).toEqual({
      serverId: "remote",
      more: 3,
      note: "3 more not shown",
      workspaces: [{ workspaceId: "w", cwd: "/c", projectId: "p" }],
    });
  });

  it("lists models as id and distinct label, but returns a requested model untouched", () => {
    const models = [
      {
        provider: "codex",
        id: "gpt-5.4",
        label: "GPT 5.4",
        isDefault: true,
        thinkingOptions: [{ id: "high", label: "High" }],
      },
      { provider: "codex", id: "same", label: "same", metadata: { big: true } },
    ];
    expect(compact("list_models", { provider: "codex", models })).toEqual({
      provider: "codex",
      models: [{ id: "gpt-5.4", label: "GPT 5.4", isDefault: true }, { id: "same" }],
    });
    expect(compact("list_models", { provider: "codex", models }, { model: "gpt-5.4" })).toEqual({
      provider: "codex",
      models,
    });
  });

  it("hoists a shared terminal cwd only when scoped to one directory", () => {
    const terminals = [
      { id: "t1", name: "dev", cwd: "/repo" },
      { id: "t2", name: "", cwd: "/repo" },
    ];
    expect(compact("list_terminals", { terminals })).toEqual({
      cwd: "/repo",
      terminals: [{ id: "t1", name: "dev" }, { id: "t2" }],
    });
    expect(compact("list_terminals", { terminals }, { all: true })).toEqual({
      terminals: [
        { id: "t1", name: "dev", cwd: "/repo" },
        { id: "t2", cwd: "/repo" },
      ],
    });
  });

  it("previews long schedule prompts and drops null schedule fields", () => {
    const result = compact("list_schedules", {
      schedules: [
        {
          id: "s1",
          name: null,
          status: "active",
          prompt: "x".repeat(300),
          cadence: { type: "every", everyMs: 60000 },
          target: { type: "new-agent", config: { provider: "codex", cwd: "/repo", title: "t" } },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          nextRunAt: "2026-01-02T00:00:00.000Z",
          lastRunAt: null,
          pausedAt: null,
          expiresAt: null,
          maxRuns: null,
        },
      ],
    });
    expect(result).toEqual({
      schedules: [
        {
          id: "s1",
          status: "active",
          cadence: { type: "every", everyMs: 60000 },
          promptPreview: `${"x".repeat(100)}…`,
          provider: "codex",
          cwd: "/repo",
          nextRunAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
  });
});
