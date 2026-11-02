import { describe, expect, it } from "vitest";
import { createWorkspaceRowNester, inheritParentPins, splitThreadHeads } from "./workspace-nesting";

function rows(...keys: string[]) {
  return keys.map((workspaceKey) => ({ workspaceKey }));
}

/** Every thread is unfolded unless `expanded` names the ones that are. */
function nest(input: { keys: string[]; parents: Record<string, string>; expanded?: string[] }) {
  const nester = createWorkspaceRowNester(
    new Map(Object.entries(input.parents)),
    new Set(input.expanded ?? input.keys),
  );
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

  it("folds a thread's child rows until the thread is unfolded, and counts them either way", () => {
    const parents = { child: "parent", grandchild: "child" };
    const keys = ["parent", "child", "grandchild", "other"];
    const nester = createWorkspaceRowNester(new Map(Object.entries(parents)));

    expect(nester.nest(rows(...keys)).map((row) => row.workspaceKey)).toEqual(["parent", "other"]);
    expect([...nester.childCountByWorkspaceKey]).toEqual([
      ["parent", 1],
      ["child", 1],
    ]);
    expect(nester.depthByWorkspaceKey.size).toBe(0);
  });

  it("keeps a grandchild folded under a folded parent even when its own thread is unfolded", () => {
    expect(
      nest({
        keys: ["parent", "child", "grandchild"],
        parents: { child: "parent", grandchild: "child" },
        expanded: ["child"],
      }),
    ).toEqual([["parent", 0]]);
    expect(
      nest({
        keys: ["parent", "child", "grandchild"],
        parents: { child: "parent", grandchild: "child" },
        expanded: ["parent"],
      }),
    ).toEqual([
      ["parent", 0],
      ["child", 1],
    ]);
  });
});

describe("splitThreadHeads", () => {
  it("groups only thread heads and hands every descendant to its head's group", () => {
    const split = splitThreadHeads(
      rows("grandchild", "other", "child", "parent", "orphan"),
      new Map([
        ["child", "parent"],
        ["grandchild", "child"],
        ["orphan", "missing"],
      ]),
    );

    expect(split.heads.map((row) => row.workspaceKey)).toEqual(["other", "parent", "orphan"]);
    expect(split.childrenOf(rows("parent")).map((row) => row.workspaceKey)).toEqual([
      "grandchild",
      "child",
    ]);
    expect(split.childrenOf(rows("other", "orphan"))).toEqual([]);
  });

  it("keeps every row of a parent cycle as a head so each row is grouped once", () => {
    const split = splitThreadHeads(
      rows("one", "two"),
      new Map([
        ["one", "two"],
        ["two", "one"],
      ]),
    );

    expect(split.heads.map((row) => row.workspaceKey)).toEqual(["one", "two"]);
    expect(split.childrenOf(split.heads)).toEqual([]);
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
