import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackgroundWorkInput } from "../../background-work/index.js";
import { OmpBackgroundJobs } from "./background-jobs.js";

// Frames as OMP 19 sends them over RPC for `bash` with `async: true` (trimmed to what is read).
const COMMAND = "for i in 1 2 3; do echo line$i; sleep 1; done";
const running = (text: string) => ({
  content: [{ type: "text", text }],
  details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
});
const finished = (state: string) => ({
  content: [{ type: "text", text: "line1\nline2\nline3\n\n\nWall time: 3.01 seconds" }],
  details: { async: { state, jobId: "bg_1", type: "bash" } },
});
const waitReport = (status: string) => ({
  content: [{ type: "text", text: "" }],
  details: { op: "wait", jobs: [{ id: "bg_1", type: "bash", status, label: COMMAND }] },
});

describe("OmpBackgroundJobs", () => {
  let published: Array<AgentBackgroundWorkInput[] | null>;
  let commands: string[];
  let jobs: OmpBackgroundJobs;

  beforeEach(() => {
    vi.useFakeTimers();
    published = [];
    commands = [];
    jobs = new OmpBackgroundJobs({
      publish: (items) => published.push(items),
      sendCommand: async (message) => {
        commands.push(message);
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function startJob(intent?: string) {
    jobs.toolStarted("call-1", "bash", { command: COMMAND, async: true }, intent);
    jobs.toolEnded("call-1", "bash", running(""));
  }

  it("lists a backgrounded call with its reason, command and latest output", () => {
    startJob("Build the fork");
    expect(published.at(-1)).toEqual([
      { id: "bg_1", kind: "shell", description: "Build the fork", command: COMMAND, canStop: true },
    ]);

    jobs.toolUpdated("call-1", "bash", running("line1\n"));
    jobs.toolUpdated("call-1", "bash", running("line1\nline2\n"));
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(published.at(-1)?.[0]?.outputTail).toEqual(["line1", "line2"]);
  });

  it("drops the job when its last frame reports it finished", () => {
    startJob();
    jobs.toolUpdated("call-1", "bash", finished("completed"));
    expect(published.at(-1)).toBeNull();
  });

  it("does not list calls that finished in the foreground or subagent jobs", () => {
    jobs.toolStarted("call-1", "bash", { command: "ls" }, undefined);
    jobs.toolEnded("call-1", "bash", { content: [{ type: "text", text: "a" }], details: {} });
    jobs.toolStarted("call-2", "task", { tasks: [] }, undefined);
    jobs.toolEnded("call-2", "task", {
      content: [],
      details: { async: { state: "running", jobId: "bg_2", type: "task" } },
    });
    expect(published).toEqual([]);
  });

  it("marks the jobs a wait blocks on, and clears the mark when the wait returns", () => {
    startJob();
    jobs.toolStarted("call-w", "wait", {}, undefined);
    expect(published.at(-1)?.[0]?.waitedOn).toBe(true);

    jobs.toolUpdated("call-w", "wait", waitReport("running"));
    expect(published.at(-1)?.[0]?.waitedOn).toBe(true);

    jobs.toolUpdated("call-1", "bash", finished("completed"));
    jobs.toolEnded("call-w", "wait", waitReport("completed"));
    expect(published.at(-1)).toBeNull();
  });

  it("names a waited job it never saw start, from the wait report", () => {
    jobs.toolStarted("call-w", "wait", {}, undefined);
    jobs.toolUpdated("call-w", "wait", waitReport("running"));
    expect(published.at(-1)).toEqual([
      {
        id: "bg_1",
        kind: "shell",
        description: null,
        command: COMMAND,
        canStop: true,
        waitedOn: true,
      },
    ]);
  });

  it("stops a job through OMP's jobs command and keeps the reply out of the chat", async () => {
    startJob();
    await jobs.stop("bg_1");
    expect(commands).toEqual(["/jobs kill bg_1"]);
    expect(jobs.consumeCommandOutput("Cancelled background job bg_1.")).toBe(true);
    expect(jobs.consumeCommandOutput("Cancelled background job bg_1.")).toBe(false);

    jobs.toolUpdated("call-1", "bash", finished("cancelled"));
    expect(published.at(-1)).toBeNull();
    await expect(jobs.stop("bg_1")).rejects.toThrow("no longer running");
  });
});
