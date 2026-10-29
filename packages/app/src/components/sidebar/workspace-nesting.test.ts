import { describe, expect, it } from "vitest";
import { createWorkspaceRowNester, inheritParentPins } from "./workspace-nesting";

function rows(...keys: string[]) {
  return keys.map((workspaceKey) => ({ workspaceKey }));
}

function nest(input: { keys: string[]; parents: Record<string, string> }) {
  const nester = createWorkspaceRowNester(new Map(Object.entries(input.parents)));
  const nested = nester.nest(rows(...input.keys));
  return nested.map((row) => [
    row.workspaceKey,
    nester.depthByWorkspaceKey.get(row.workspaceKey) ?? 0,
  ]);
}

describe("createWorkspaceRowNester", () => {
  it("places a child row directly under its parent row", () => {
    expect(nest({ keys: ["child", "other", "parent"], parents: { child: "parent" } })).toEqual([
      ["other", 0],
      ["parent", 0],
      ["child", 1],
    ]);
  });

  it("indents a chain of two levels", () => {
    expect(
      nest({
        keys: ["grandchild", "child", "parent", "other"],
        parents: { child: "parent", grandchild: "child" },
      }),
    ).toEqual([
      ["parent", 0],
      ["child", 1],
      ["grandchild", 2],
      ["other", 0],
    ]);
  });

  it("keeps a child at the top level when its parent is not in the list", () => {
    const input = rows("child", "other");
    const nester = createWorkspaceRowNester(new Map([["child", "parent"]]));

    expect(nester.nest(input)).toBe(input);
    expect(nester.depthByWorkspaceKey.size).toBe(0);
  });

  it("places every row of a parent cycle exactly once", () => {
    expect(nest({ keys: ["other", "one", "two"], parents: { one: "two", two: "one" } })).toEqual([
      ["other", 0],
      ["one", 0],
      ["two", 1],
    ]);
  });
});

describe("inheritParentPins", () => {
  const parentKeyByWorkspaceKey = new Map([
    ["child", "parent"],
    ["grandchild", "child"],
  ]);
  const visibleWorkspaceKeys = new Set(["parent", "child", "grandchild"]);

  it("pins the descendants of a pinned parent", () => {
    expect(
      inheritParentPins({
        pinnedWorkspaceKeys: ["parent"],
        visibleWorkspaceKeys,
        parentKeyByWorkspaceKey,
      }),
    ).toEqual(["parent", "child", "grandchild"]);
  });

  it("does not pin the parent of a pinned child", () => {
    expect(
      inheritParentPins({
        pinnedWorkspaceKeys: ["child"],
        visibleWorkspaceKeys,
        parentKeyByWorkspaceKey,
      }),
    ).toEqual(["child", "grandchild"]);
  });

  it("stops at a parent the sidebar does not show", () => {
    expect(
      inheritParentPins({
        pinnedWorkspaceKeys: ["parent"],
        visibleWorkspaceKeys: new Set(["parent", "grandchild"]),
        parentKeyByWorkspaceKey,
      }),
    ).toEqual(["parent"]);
  });

  it("terminates on a parent cycle", () => {
    expect(
      inheritParentPins({
        pinnedWorkspaceKeys: ["pinned"],
        visibleWorkspaceKeys: new Set(["one", "two", "pinned"]),
        parentKeyByWorkspaceKey: new Map([
          ["one", "two"],
          ["two", "one"],
        ]),
      }),
    ).toEqual(["pinned"]);
  });
});
