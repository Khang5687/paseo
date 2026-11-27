import type { SidebarWorkspaceOrder } from "./messages.js";

/**
 * Keeps, per project and for the sort, whichever side has the newer `updatedAt`. `changed` is true
 * when `incoming` replaced anything in `current`. Hosts and devices both merge this way, so every
 * copy ends on the last change to each project and to the sort.
 */
export function mergeSidebarWorkspaceOrder(
  current: SidebarWorkspaceOrder,
  incoming: SidebarWorkspaceOrder,
): { merged: SidebarWorkspaceOrder; changed: boolean } {
  let changed = false;
  const projects = { ...current.projects };
  for (const [projectKey, entry] of Object.entries(incoming.projects)) {
    if (entry.updatedAt <= (projects[projectKey]?.updatedAt ?? 0)) continue;
    projects[projectKey] = { order: [...new Set(entry.order)], updatedAt: entry.updatedAt };
    changed = true;
  }
  let sort = current.sort;
  if (incoming.sort && incoming.sort.updatedAt > (sort?.updatedAt ?? 0)) {
    sort = { value: incoming.sort.value, updatedAt: incoming.sort.updatedAt };
    changed = true;
  }
  return { merged: sort ? { projects, sort } : { projects }, changed };
}

/** The entries of `local` that are newer than `host`'s, or null when the host holds them all. */
export function newerSidebarWorkspaceOrderEntries(
  local: SidebarWorkspaceOrder,
  host: SidebarWorkspaceOrder,
): SidebarWorkspaceOrder | null {
  const projects: SidebarWorkspaceOrder["projects"] = {};
  let hasProjects = false;
  for (const [projectKey, entry] of Object.entries(local.projects)) {
    if (entry.updatedAt <= (host.projects[projectKey]?.updatedAt ?? 0)) continue;
    projects[projectKey] = entry;
    hasProjects = true;
  }
  const sort =
    local.sort && local.sort.updatedAt > (host.sort?.updatedAt ?? 0) ? local.sort : undefined;
  if (!hasProjects && !sort) return null;
  return sort ? { projects, sort } : { projects };
}
