interface NestableWorkspaceRow {
  workspaceKey: string;
}

export interface WorkspaceRowNester {
  /**
   * Reorders one rendered list so each subagent workspace follows its parent row, children in
   * their original relative order. A child whose parent is not in this list stays a top-level row
   * where it already was.
   */
  nest<T extends NestableWorkspaceRow>(rows: T[]): T[];
  /** Indent level of every nested row placed so far; top-level rows are absent. */
  depthByWorkspaceKey: ReadonlyMap<string, number>;
}

export function createWorkspaceRowNester(
  parentKeyByWorkspaceKey: ReadonlyMap<string, string>,
): WorkspaceRowNester {
  const depthByWorkspaceKey = new Map<string, number>();

  function nest<T extends NestableWorkspaceRow>(rows: T[]): T[] {
    if (parentKeyByWorkspaceKey.size === 0) {
      return rows;
    }
    const rowKeys = new Set(rows.map((row) => row.workspaceKey));
    const childrenByParentKey = new Map<string, T[]>();
    const roots: T[] = [];
    for (const row of rows) {
      const parentKey = parentKeyByWorkspaceKey.get(row.workspaceKey);
      if (parentKey === undefined || !rowKeys.has(parentKey)) {
        roots.push(row);
        continue;
      }
      const siblings = childrenByParentKey.get(parentKey);
      if (siblings) {
        siblings.push(row);
      } else {
        childrenByParentKey.set(parentKey, [row]);
      }
    }
    if (roots.length === rows.length) {
      return rows;
    }

    const nested: T[] = [];
    const placedKeys = new Set<string>();
    function place(row: T, depth: number): void {
      if (placedKeys.has(row.workspaceKey)) {
        return;
      }
      placedKeys.add(row.workspaceKey);
      nested.push(row);
      if (depth > 0) {
        depthByWorkspaceKey.set(row.workspaceKey, depth);
      }
      for (const child of childrenByParentKey.get(row.workspaceKey) ?? []) {
        place(child, depth + 1);
      }
    }
    for (const root of roots) {
      place(root, 0);
    }
    // Rows on a parent cycle have no root to hang from. The first of them in list order becomes
    // the top-level row so every row is still placed exactly once.
    for (const row of rows) {
      place(row, 0);
    }
    return nested;
  }

  return { nest, depthByWorkspaceKey };
}

/**
 * Pinned keys plus every visible workspace whose parent row is pinned, directly or through its own
 * parent. A child row goes where its parent row goes, so pinning an orchestrator brings its
 * subagent workspaces into the Pinned section with it. A child pinned on its own is already in the
 * input and stays pinned when its parent is not.
 */
export function inheritParentPins(input: {
  pinnedWorkspaceKeys: string[];
  visibleWorkspaceKeys: ReadonlySet<string>;
  parentKeyByWorkspaceKey: ReadonlyMap<string, string>;
}): string[] {
  const { visibleWorkspaceKeys, parentKeyByWorkspaceKey } = input;
  if (input.pinnedWorkspaceKeys.length === 0 || parentKeyByWorkspaceKey.size === 0) {
    return input.pinnedWorkspaceKeys;
  }
  const pinnedKeys = new Set(input.pinnedWorkspaceKeys);
  const inherited: string[] = [];
  for (const workspaceKey of parentKeyByWorkspaceKey.keys()) {
    if (pinnedKeys.has(workspaceKey) || !visibleWorkspaceKeys.has(workspaceKey)) {
      continue;
    }
    const visitedKeys = new Set([workspaceKey]);
    let parentKey = parentKeyByWorkspaceKey.get(workspaceKey);
    while (
      parentKey !== undefined &&
      visibleWorkspaceKeys.has(parentKey) &&
      !visitedKeys.has(parentKey)
    ) {
      if (pinnedKeys.has(parentKey)) {
        inherited.push(workspaceKey);
        break;
      }
      visitedKeys.add(parentKey);
      parentKey = parentKeyByWorkspaceKey.get(parentKey);
    }
  }
  return inherited.length === 0
    ? input.pinnedWorkspaceKeys
    : [...input.pinnedWorkspaceKeys, ...inherited];
}
