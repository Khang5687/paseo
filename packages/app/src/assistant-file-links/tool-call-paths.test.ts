import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";
import {
  collectToolCallFilePaths,
  createToolCallPathIndex,
  matchToolCallFilePaths,
} from "./tool-call-paths";

function toolCall(detail: ToolCallDetail, id: string = detail.type): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(0),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: detail.type,
        status: "completed",
        error: null,
        detail,
      },
    },
  };
}

describe("collectToolCallFilePaths", () => {
  it("collects read, edit, write, search and cat paths as absolute normalized paths", () => {
    const items: StreamItem[] = [
      toolCall({ type: "read", filePath: "src/a.ts" }, "read"),
      toolCall({ type: "edit", filePath: "/repo/./src/../src/b.ts" }, "edit"),
      toolCall({ type: "write", filePath: "out/clip.mp4" }, "write"),
      toolCall(
        { type: "search", query: "x", filePaths: ["/tmp/found.txt", "docs/c.md"] },
        "search",
      ),
      toolCall({ type: "shell", command: "cat notes.md", cwd: "/repo/sub" }, "shell"),
    ];

    expect(collectToolCallFilePaths(items, "/repo")).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/out/clip.mp4",
      "/tmp/found.txt",
      "/repo/docs/c.md",
      "/repo/sub/notes.md",
    ]);
  });

  it("drops repeats and tool calls that name no file", () => {
    const items: StreamItem[] = [
      toolCall({ type: "read", filePath: "src/a.ts" }, "one"),
      toolCall({ type: "edit", filePath: "/repo/src/a.ts" }, "two"),
      toolCall({ type: "shell", command: "ls -la" }, "three"),
      toolCall({ type: "read", filePath: "~/secret.txt" }, "four"),
    ];

    expect(collectToolCallFilePaths(items, "/repo")).toEqual(["/repo/src/a.ts"]);
  });
});

describe("matchToolCallFilePaths", () => {
  const known = ["/repo/out/video/clip.mp4", "/tmp/clip.mp4", "/repo/src/index.ts"];

  it("matches a bare name or a path suffix by whole segments, ignoring case", () => {
    expect(matchToolCallFilePaths({ query: "CLIP.mp4", cwd: "/repo", knownPaths: known })).toEqual([
      "/repo/out/video/clip.mp4",
      "/tmp/clip.mp4",
    ]);
    expect(
      matchToolCallFilePaths({ query: "video/clip.mp4", cwd: "/repo", knownPaths: known }),
    ).toEqual(["/repo/out/video/clip.mp4"]);
    expect(matchToolCallFilePaths({ query: "lip.mp4", cwd: "/repo", knownPaths: known })).toEqual(
      [],
    );
  });

  it("lets the path that is exactly cwd/query stand alone", () => {
    const paths = ["/repo/src/a.ts", "/repo/other/src/a.ts"];

    expect(matchToolCallFilePaths({ query: "src/a.ts", cwd: "/repo", knownPaths: paths })).toEqual([
      "/repo/src/a.ts",
    ]);
  });
});

describe("createToolCallPathIndex", () => {
  it("scans each array once and merges the streaming head", () => {
    const tail = [toolCall({ type: "read", filePath: "a.ts" }, "tail")];
    const head = [toolCall({ type: "write", filePath: "b.ts" }, "head")];
    const index = createToolCallPathIndex();

    const withoutHead = index(tail, [], "/repo");
    expect(index(tail, [], "/repo")).toBe(withoutHead);
    expect(index(tail, head, "/repo")).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });
});
