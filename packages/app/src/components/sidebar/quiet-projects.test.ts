import { describe, expect, it } from "vitest";
import type { ProjectActivity } from "@/hooks/sidebar-workspaces-view-model";
import {
  QUIET_AFTER_MS,
  isProjectQuiet,
  resolveQuietProjectKeys,
  splitQuietProjects,
} from "./quiet-projects";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function activity(daysAgo: number | null, needsInput = false): ProjectActivity {
  return { lastActivityMs: daysAgo === null ? null : NOW - daysAgo * DAY, needsInput };
}

function resolve(activities: Record<string, ProjectActivity>, keep: string[] = []): string[] {
  return resolveQuietProjectKeys({
    projects: Object.keys(activities).map((viewKey) => ({ viewKey })),
    activityOf: (project) => activities[project.viewKey],
    keep: new Set(keep),
    now: NOW,
  });
}

describe("quiet projects", () => {
  it("folds a project once it has been quiet for three days", () => {
    expect(
      isProjectQuiet({ lastActivityMs: NOW - QUIET_AFTER_MS + 1, needsInput: false }, NOW),
    ).toBe(false);
    expect(isProjectQuiet({ lastActivityMs: NOW - QUIET_AFTER_MS, needsInput: false }, NOW)).toBe(
      true,
    );
  });

  it("brings a project back when new activity lands", () => {
    expect(resolve({ a: activity(5), b: activity(0) })).toEqual(["a"]);
    expect(resolve({ a: activity(0), b: activity(0) })).toEqual([]);
  });

  it("never folds a project with a chat that needs you", () => {
    expect(resolve({ a: activity(10, true), b: activity(10), c: activity(0) })).toEqual(["b"]);
  });

  it("keeps a project with no known activity, and the projects it is told to keep", () => {
    expect(
      resolve({ a: activity(null), b: activity(9), c: activity(9), d: activity(0) }, ["b"]),
    ).toEqual(["c"]);
  });

  it("folds nothing when every project would fold", () => {
    expect(resolve({ a: activity(4), b: activity(7) })).toEqual([]);
  });

  it("folds a snoozed project even when it needs you or is kept, and still folds by age", () => {
    const projects = ["a", "b", "c", "d"].map((viewKey) => ({ viewKey }));
    const activities: Record<string, ProjectActivity> = {
      a: activity(0, true),
      b: activity(9),
      c: activity(0),
      d: activity(0),
    };
    expect(
      resolveQuietProjectKeys({
        projects,
        activityOf: (project) => activities[project.viewKey],
        keep: new Set(["a"]),
        now: NOW,
        snoozed: new Set(["a", "d"]),
      }),
    ).toEqual(["a", "b", "d"]);
  });

  it("applies the all-would-fold rule to awake projects only", () => {
    expect(
      resolveQuietProjectKeys({
        projects: [{ viewKey: "a" }, { viewKey: "b" }],
        activityOf: () => activity(9),
        keep: new Set(),
        now: NOW,
        snoozed: new Set(["a"]),
      }),
    ).toEqual(["a"]);
  });

  it("splits projects in order", () => {
    const projects = [{ viewKey: "a" }, { viewKey: "b" }, { viewKey: "c" }];
    expect(splitQuietProjects(projects, new Set(["b"]))).toEqual({
      active: [{ viewKey: "a" }, { viewKey: "c" }],
      quiet: [{ viewKey: "b" }],
    });
  });
});
