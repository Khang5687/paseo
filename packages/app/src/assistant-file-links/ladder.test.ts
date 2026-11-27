import { describe, expect, it, vi } from "vitest";
import {
  resolveFileLinkCandidates,
  resolveFileLinkSearchRoots,
  type FileLinkLadderInput,
} from "./ladder";
import type { DirectorySuggestionEntry, GetDirectorySuggestions } from "./resolver";

type LookupCall = Parameters<GetDirectorySuggestions>[0];

/** A daemon with one file listing per root; Git-ignored files only appear on the ignored pass. */
function fakeDaemon(
  roots: Record<string, { visible?: string[]; ignored?: string[] }>,
): GetDirectorySuggestions & { calls: LookupCall[] } {
  const calls: LookupCall[] = [];
  const lookup = vi.fn(async (input: LookupCall) => {
    calls.push(input);
    const files = roots[input.cwd];
    const paths = [
      ...(files?.visible ?? []),
      ...(input.includeIgnored ? (files?.ignored ?? []) : []),
    ];
    const entries: DirectorySuggestionEntry[] = paths
      .filter((path) => path === input.query || path.endsWith(`/${input.query}`))
      .map((path) => ({ path, kind: "file" }));
    return { entries, error: null };
  });
  return Object.assign(lookup, { calls });
}

function ladderInput(
  overrides: Partial<FileLinkLadderInput> & { getDirectorySuggestions: GetDirectorySuggestions },
): FileLinkLadderInput {
  return {
    query: "clip.mp4",
    target: { raw: "clip.mp4", path: "/repo/clip.mp4" },
    cwd: "/repo",
    extraRoots: [],
    knownPaths: [],
    searchIgnored: true,
    ...overrides,
  };
}

const paths = (targets: { path: string }[]) => targets.map((target) => target.path);

describe("resolveFileLinkCandidates", () => {
  it("answers from the agent's tool-call paths without asking the daemon", async () => {
    const daemon = fakeDaemon({ "/repo": { visible: ["docs/clip.mp4"] } });

    const found = await resolveFileLinkCandidates(
      ladderInput({ getDirectorySuggestions: daemon, knownPaths: ["/repo/out/clip.mp4"] }),
    );

    expect(paths(found)).toEqual(["/repo/out/clip.mp4"]);
    expect(daemon.calls).toEqual([]);
  });

  it("keeps the link's line range on every candidate", async () => {
    const daemon = fakeDaemon({});

    const found = await resolveFileLinkCandidates(
      ladderInput({
        getDirectorySuggestions: daemon,
        target: { raw: "clip.mp4:3", path: "/repo/clip.mp4", lineStart: 3 },
        knownPaths: ["/tmp/clip.mp4"],
      }),
    );

    expect(found).toEqual([{ raw: "clip.mp4:3", path: "/tmp/clip.mp4", lineStart: 3 }]);
  });

  it("finds a Git-ignored file on the second pass of the cwd, before any other root", async () => {
    const daemon = fakeDaemon({
      "/repo": { ignored: ["out/clip.mp4"] },
      "/workspace": { visible: ["clip.mp4"] },
    });

    const found = await resolveFileLinkCandidates(
      ladderInput({ getDirectorySuggestions: daemon, extraRoots: ["/workspace"] }),
    );

    expect(paths(found)).toEqual(["/repo/out/clip.mp4"]);
    expect(daemon.calls.map((call) => [call.cwd, call.includeIgnored ?? false])).toEqual([
      ["/repo", false],
      ["/repo", true],
    ]);
  });

  it("skips the ignored pass when the host cannot search ignored files", async () => {
    const daemon = fakeDaemon({ "/repo": { ignored: ["out/clip.mp4"] } });

    const found = await resolveFileLinkCandidates(
      ladderInput({ getDirectorySuggestions: daemon, searchIgnored: false }),
    );

    expect(found).toEqual([]);
    expect(daemon.calls).toHaveLength(1);
  });

  it("searches the workspace root and then the project root when the cwd misses", async () => {
    const daemon = fakeDaemon({
      "/repo/pkg": {},
      "/repo": { visible: ["notes/clip.mp4"] },
      "/projects/main": { visible: ["clip.mp4"] },
    });

    const found = await resolveFileLinkCandidates(
      ladderInput({
        getDirectorySuggestions: daemon,
        cwd: "/repo/pkg",
        searchIgnored: false,
        extraRoots: ["/repo", "/projects/main"],
      }),
    );

    expect(paths(found)).toEqual(["/repo/notes/clip.mp4"]);
    expect(daemon.calls.map((call) => call.cwd)).toEqual(["/repo/pkg", "/repo"]);
  });

  it("returns every match at the step that has one, never the first alone", async () => {
    const daemon = fakeDaemon({ "/repo": { visible: ["a/clip.mp4", "b/clip.mp4"] } });

    const found = await resolveFileLinkCandidates(ladderInput({ getDirectorySuggestions: daemon }));

    expect(paths(found)).toEqual(["/repo/a/clip.mp4", "/repo/b/clip.mp4"]);
  });

  it("treats a path that names the file exactly as the only match", async () => {
    const daemon = fakeDaemon({ "/repo": { visible: ["clip.mp4", "a/clip.mp4"] } });

    const found = await resolveFileLinkCandidates(ladderInput({ getDirectorySuggestions: daemon }));

    expect(paths(found)).toEqual(["/repo/clip.mp4"]);
  });

  it("misses when no step has the file", async () => {
    const daemon = fakeDaemon({});

    const found = await resolveFileLinkCandidates(
      ladderInput({ getDirectorySuggestions: daemon, extraRoots: ["/workspace"] }),
    );

    expect(found).toEqual([]);
  });

  it("goes on to the next root when a lookup fails", async () => {
    const daemon: GetDirectorySuggestions = async (input) => {
      if (input.cwd === "/repo") throw new Error("daemon unavailable");
      return { entries: [{ path: "clip.mp4", kind: "file" }], error: null };
    };

    const found = await resolveFileLinkCandidates(
      ladderInput({
        getDirectorySuggestions: daemon,
        searchIgnored: false,
        extraRoots: ["/workspace"],
      }),
    );

    expect(paths(found)).toEqual(["/workspace/clip.mp4"]);
  });
});

describe("resolveFileLinkSearchRoots", () => {
  it("lists the workspace folder then the project root, without the cwd or repeats", () => {
    expect(
      resolveFileLinkSearchRoots({
        workspaceRoot: "/repo/pkg/",
        workspaceFolder: "/repo",
        projectFolder: "/repo/",
      }),
    ).toEqual(["/repo"]);
    expect(
      resolveFileLinkSearchRoots({
        workspaceRoot: "/wt/feature",
        workspaceFolder: "/wt/feature",
        projectFolder: "/main",
      }),
    ).toEqual(["/main"]);
  });
});
