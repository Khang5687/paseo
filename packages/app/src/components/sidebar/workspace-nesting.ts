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
  /** How many direct child rows each placed parent has, shown or folded; childless rows absent. */
  childCountByWorkspaceKey: ReadonlyMap<string, number>;
}

/**
 * `expandedWorkspaceKeys` are the threads the user unfolded. A parent that is not in it keeps its
 * child rows folded away, so every thread starts collapsed.
 */
export function createWorkspaceRowNester(
  parentKeyByWorkspaceKey: ReadonlyMap<string, string>,
  expandedWorkspaceKeys: ReadonlySet<string> = new Set(),
): WorkspaceRowNester {
  const depthByWorkspaceKey = new Map<string, number>();
  const childCountByWorkspaceKey = new Map<string, number>();

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
    function place(row: T, depth: number, folded = false): void {
      if (placedKeys.has(row.workspaceKey)) {
        return;
      }
      placedKeys.add(row.workspaceKey);
      if (!folded) {
        nested.push(row);
        if (depth > 0) {
          depthByWorkspaceKey.set(row.workspaceKey, depth);
        }
      }
      const children = childrenByParentKey.get(row.workspaceKey) ?? [];
      if (children.length > 0) {
        childCountByWorkspaceKey.set(row.workspaceKey, children.length);
      }
      const foldChildren = folded || !expandedWorkspaceKeys.has(row.workspaceKey);
      for (const child of children) {
        place(child, depth + 1, foldChildren);
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

  return { nest, depthByWorkspaceKey, childCountByWorkspaceKey };
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

/**
 * Splits rows into the ones that head a thread and the ones that belong under another row in the
 * same list. A status grouping groups only the heads; the rest follow their parent into its group
 * instead of being sorted by their own status. Rows on a parent cycle have no head above them, so
 * they stay heads and every row is still grouped once.
 */
export function splitThreadHeads<T extends NestableWorkspaceRow>(
  rows: T[],
  parentKeyByWorkspaceKey: ReadonlyMap<string, string>,
): { heads: T[]; childrenOf: (heads: T[]) => T[] } {
  if (parentKeyByWorkspaceKey.size === 0) {
    return { heads: rows, childrenOf: () => [] };
  }
  const rowKeys = new Set(rows.map((row) => row.workspaceKey));
  const headKeyByRowKey = new Map<string, string>();
  for (const row of rows) {
    const visitedKeys = new Set([row.workspaceKey]);
    let headKey = row.workspaceKey;
    let parentKey = parentKeyByWorkspaceKey.get(headKey);
    while (parentKey !== undefined && rowKeys.has(parentKey) && !visitedKeys.has(parentKey)) {
      visitedKeys.add(parentKey);
      headKey = parentKey;
      parentKey = parentKeyByWorkspaceKey.get(headKey);
    }
    const onCycle = parentKey !== undefined && visitedKeys.has(parentKey);
    headKeyByRowKey.set(row.workspaceKey, onCycle ? row.workspaceKey : headKey);
  }
  const heads = rows.filter((row) => headKeyByRowKey.get(row.workspaceKey) === row.workspaceKey);
  return {
    heads,
    childrenOf: (groupHeads) => {
      const groupHeadKeys = new Set(groupHeads.map((row) => row.workspaceKey));
      return rows.filter((row) => {
        const headKey = headKeyByRowKey.get(row.workspaceKey);
        return headKey !== row.workspaceKey && headKey !== undefined && groupHeadKeys.has(headKey);
      });
    },
  };
}
