import { describe, expect, it } from "vitest";
import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { sortProjectsByUrgency, sortWorkspacesByUrgency } from "./urgent-sort";

function placement(key: string): SidebarWorkspacePlacement {
  return {
    workspaceKey: key,
    serverId: "srv",
    workspaceId: key,
    projectViewKey: "proj",
    projectName: "proj",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: key,
  } as SidebarWorkspacePlacement;
}

function statuses(
  entries: Record<string, [SidebarStateBucket, number | null]>,
): Map<string, { statusBucket: SidebarStateBucket; statusEnteredAt: Date | null }> {
  return new Map(
    Object.entries(entries).map(([key, [bucket, at]]) => [
      key,
      { statusBucket: bucket, statusEnteredAt: at === null ? null : new Date(at) },
    ]),
  );
}

const keys = (rows: readonly SidebarWorkspacePlacement[]) => rows.map((row) => row.workspaceKey);

describe("sortWorkspacesByUrgency", () => {
  it("puts waiting, then failed, then unread, then working, then idle", () => {
    const rows = ["idle", "working", "unread", "failed", "waiting"].map(placement);
    const sorted = sortWorkspacesByUrgency(
      rows,
      statuses({
        idle: ["done", 5],
        working: ["running", 5],
        unread: ["attention", 5],
        failed: ["failed", 5],
        waiting: ["needs_input", 5],
      }),
    );
    expect(keys(sorted)).toEqual(["waiting", "failed", "unread", "working", "idle"]);
  });

  it("puts the newest status change first inside one status", () => {
    const rows = ["older", "newer"].map(placement);
    const sorted = sortWorkspacesByUrgency(
      rows,
      statuses({ older: ["needs_input", 100], newer: ["needs_input", 200] }),
    );
    expect(keys(sorted)).toEqual(["newer", "older"]);
  });

  it("keeps the incoming order for rows with no change time", () => {
    const rows = ["first", "second", "timed"].map(placement);
    const sorted = sortWorkspacesByUrgency(
      rows,
      statuses({ first: ["done", null], second: ["done", null], timed: ["done", 1] }),
    );
    expect(keys(sorted)).toEqual(["timed", "first", "second"]);
  });

  it("returns the same array when nothing moves", () => {
    const rows = ["a", "b"].map(placement);
    expect(sortWorkspacesByUrgency(rows, statuses({ a: ["needs_input", 2], b: ["done", 1] }))).toBe(
      rows,
    );
  });
});

describe("sortProjectsByUrgency", () => {
  it("keeps project identity when its rows are already in order", () => {
    const project = {
      viewKey: "proj",
      projectName: "proj",
      projectKind: "git" as const,
      iconWorkingDir: "/tmp",
      hosts: [],
      workspaces: ["a", "b"].map(placement),
    };
    const projects = [project];
    expect(sortProjectsByUrgency(projects, statuses({ a: ["running", 1], b: ["done", 1] }))).toBe(
      projects,
    );
    expect(
      keys(
        sortProjectsByUrgency(projects, statuses({ a: ["done", 1], b: ["needs_input", 1] }))[0]
          .workspaces,
      ),
    ).toEqual(["b", "a"]);
  });
});
