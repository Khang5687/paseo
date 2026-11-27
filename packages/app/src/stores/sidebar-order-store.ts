import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

interface SidebarOrderStoreState {
  projectOrder: string[];
  /**
   * Device clock in epoch ms when a person last reordered projects; 0 when nobody has. Hosts keep
   * the order with the newest stamp, so every device ends on the last reorder (`sidebar-sync/`).
   */
  projectOrderUpdatedAt: number;
  pinnedWorkspaceOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
  /**
   * Per project, device clock in epoch ms when a person last reordered its workspaces; absent when
   * nobody has. Hosts keep the newest order of each project (`sidebar-sync/workspace-order.ts`).
   */
  workspaceOrderUpdatedAtByProject: Record<string, number>;
  getProjectOrder: () => string[];
  /** A person's reorder: stamps the order so it wins on every host. */
  setProjectOrder: (keys: string[]) => void;
  /** Adds projects the sidebar found without making the order newer than a reorder elsewhere. */
  extendProjectOrder: (keys: string[]) => void;
  /**
   * Takes a host's order when it is newer than this device's. Keys only this device knows, such
   * as projects on an offline host, keep their places after the host's keys.
   */
  applySyncedProjectOrder: (keys: string[], updatedAt: number) => boolean;
  getPinnedWorkspaceOrder: () => string[];
  setPinnedWorkspaceOrder: (keys: string[]) => void;
  getWorkspaceOrder: (projectViewKey: string) => string[];
  /** A person's reorder: stamps the project's order so it wins on every host. */
  setWorkspaceOrder: (projectViewKey: string, keys: string[]) => void;
  /** Several projects reordered at once, as when a drag switches the sort to Manual. */
  setWorkspaceOrders: (orders: Record<string, string[]>) => void;
  /** Adds workspaces the sidebar found without making the order newer than a reorder elsewhere. */
  extendWorkspaceOrder: (projectViewKey: string, keys: string[]) => void;
  /**
   * Takes each project's order from a host when it is newer than this device's. Workspaces only
   * this device knows keep their places after the host's keys.
   */
  applySyncedWorkspaceOrders: (
    projects: Record<string, { order: string[]; updatedAt: number }>,
  ) => boolean;
}

interface SidebarOrderPersistedState {
  projectOrder?: string[];
  projectOrderUpdatedAt?: number;
  pinnedWorkspaceOrder?: string[];
  workspaceOrderByProject?: Record<string, string[]>;
  workspaceOrderUpdatedAtByProject?: Record<string, number>;
  projectOrderByServerId?: Record<string, string[]>;
  workspaceOrderByServerAndProject?: Record<string, string[]>;
}

const StringArrayRecordSchema = z.record(z.string(), z.array(z.string()));
const SidebarOrderPersistedStateSchema = z.strictObject({
  projectOrder: z.array(z.string()).optional(),
  projectOrderUpdatedAt: z.number().optional(),
  pinnedWorkspaceOrder: z.array(z.string()).optional(),
  workspaceOrderByProject: StringArrayRecordSchema.optional(),
  workspaceOrderUpdatedAtByProject: z.record(z.string(), z.number()).optional(),
  projectOrderByServerId: StringArrayRecordSchema.optional(),
  workspaceOrderByServerAndProject: StringArrayRecordSchema.optional(),
});

interface SidebarWorkspaceOrderScope {
  serverId: string;
  projectViewKey: string;
}

// Trims each key. Only for persisted state read at migration time, where a
// stray space is an artifact of an older format rather than part of the key.
function normalizeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

/**
 * Drops blank keys and duplicates but keeps each key exactly as given. View
 * keys embed a project's path, so a directory whose name ends in a space
 * produces a key that ends in a space. Trimming it stores a key that can never
 * match the one the sidebar looks up, so the caller sees its key as missing,
 * writes it again, and the effect that reconciles the order never settles.
 */
function dedupeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const key of keys) {
    if (!key.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(key);
  }

  return deduped;
}

function normalizeWorkspaceOrderByProject(
  workspaceOrderByProject: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [projectViewKey, order] of Object.entries(workspaceOrderByProject ?? {})) {
    const scope = projectViewKey;
    if (!scope.trim()) continue;
    normalized[scope] = dedupeKeys(order);
  }
  return normalized;
}

function extractWorkspaceOrderScope(scopeKey: string): SidebarWorkspaceOrderScope | null {
  const separatorIndex = scopeKey.indexOf("::");
  if (separatorIndex < 0) return null;
  const serverId = scopeKey.slice(0, separatorIndex).trim();
  const projectViewKey = scopeKey.slice(separatorIndex + 2).trim();
  if (!serverId || !projectViewKey) return null;
  return { serverId, projectViewKey };
}

function normalizeLegacyWorkspaceKey(serverId: string, rawWorkspaceKey: string): string | null {
  const workspaceKey = rawWorkspaceKey.trim();
  if (!workspaceKey) return null;
  const serverPrefix = `${serverId}:`;
  return workspaceKey.startsWith(serverPrefix) ? workspaceKey : `${serverPrefix}${workspaceKey}`;
}

export function migrateSidebarOrderState(persistedState: unknown): {
  projectOrder: string[];
  pinnedWorkspaceOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
} {
  const result = SidebarOrderPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return { projectOrder: [], pinnedWorkspaceOrder: [], workspaceOrderByProject: {} };
  }
  const state: SidebarOrderPersistedState = result.data;

  const projectOrder = dedupeKeys(state.projectOrder ?? []);
  const seenProjects = new Set(projectOrder);
  for (const keys of Object.values(state.projectOrderByServerId ?? {})) {
    for (const key of normalizeKeys(keys)) {
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      projectOrder.push(key);
    }
  }

  const workspaceOrderByProject = normalizeWorkspaceOrderByProject(state.workspaceOrderByProject);
  for (const [scopeKey, order] of Object.entries(state.workspaceOrderByServerAndProject ?? {})) {
    const scope = extractWorkspaceOrderScope(scopeKey);
    if (!scope) continue;
    const existing = workspaceOrderByProject[scope.projectViewKey] ?? [];
    const merged = [...existing];
    const seen = new Set(merged);
    for (const key of order) {
      const workspaceKey = normalizeLegacyWorkspaceKey(scope.serverId, key);
      if (!workspaceKey || seen.has(workspaceKey)) continue;
      seen.add(workspaceKey);
      merged.push(workspaceKey);
    }
    workspaceOrderByProject[scope.projectViewKey] = merged;
  }

  return {
    projectOrder,
    pinnedWorkspaceOrder: dedupeKeys(state.pinnedWorkspaceOrder ?? []),
    workspaceOrderByProject,
  };
}

export const useSidebarOrderStore = create<SidebarOrderStoreState>()(
  persist(
    (set, get) => ({
      projectOrder: [],
      projectOrderUpdatedAt: 0,
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
      workspaceOrderUpdatedAtByProject: {},
      getProjectOrder: () => get().projectOrder,
      setProjectOrder: (keys) => {
        set((state) => ({
          projectOrder: dedupeKeys(keys),
          // Never older than the order it replaces, even if this device's clock went back.
          projectOrderUpdatedAt: Math.max(Date.now(), state.projectOrderUpdatedAt + 1),
        }));
      },
      extendProjectOrder: (keys) => {
        set({ projectOrder: dedupeKeys(keys) });
      },
      applySyncedProjectOrder: (keys, updatedAt) => {
        const state = get();
        if (updatedAt <= state.projectOrderUpdatedAt) return false;
        const synced = dedupeKeys(keys);
        const known = new Set(synced);
        set({
          projectOrder: [...synced, ...state.projectOrder.filter((key) => !known.has(key))],
          projectOrderUpdatedAt: updatedAt,
        });
        return true;
      },
      getPinnedWorkspaceOrder: () => get().pinnedWorkspaceOrder,
      setPinnedWorkspaceOrder: (keys) => {
        set({ pinnedWorkspaceOrder: dedupeKeys(keys) });
      },
      getWorkspaceOrder: (projectViewKey) => {
        if (!projectViewKey.trim()) return [];
        return get().workspaceOrderByProject[projectViewKey] ?? [];
      },
      setWorkspaceOrder: (projectViewKey, keys) => {
        get().setWorkspaceOrders({ [projectViewKey]: keys });
      },
      setWorkspaceOrders: (orders) => {
        set((state) => {
          const workspaceOrderByProject = { ...state.workspaceOrderByProject };
          const workspaceOrderUpdatedAtByProject = { ...state.workspaceOrderUpdatedAtByProject };
          for (const [projectViewKey, keys] of Object.entries(orders)) {
            if (!projectViewKey.trim()) continue;
            workspaceOrderByProject[projectViewKey] = dedupeKeys(keys);
            // Never older than the order it replaces, even if this device's clock went back.
            workspaceOrderUpdatedAtByProject[projectViewKey] = Math.max(
              Date.now(),
              (state.workspaceOrderUpdatedAtByProject[projectViewKey] ?? 0) + 1,
            );
          }
          return { workspaceOrderByProject, workspaceOrderUpdatedAtByProject };
        });
      },
      extendWorkspaceOrder: (projectViewKey, keys) => {
        if (!projectViewKey.trim()) return;
        set((state) => ({
          workspaceOrderByProject: {
            ...state.workspaceOrderByProject,
            [projectViewKey]: dedupeKeys(keys),
          },
        }));
      },
      applySyncedWorkspaceOrders: (projects) => {
        const state = get();
        let workspaceOrderByProject: Record<string, string[]> | null = null;
        let workspaceOrderUpdatedAtByProject: Record<string, number> | null = null;
        for (const [projectViewKey, entry] of Object.entries(projects)) {
          if (!projectViewKey.trim()) continue;
          if (entry.updatedAt <= (state.workspaceOrderUpdatedAtByProject[projectViewKey] ?? 0)) {
            continue;
          }
          workspaceOrderByProject ??= { ...state.workspaceOrderByProject };
          workspaceOrderUpdatedAtByProject ??= { ...state.workspaceOrderUpdatedAtByProject };
          const synced = dedupeKeys(entry.order);
          const known = new Set(synced);
          const localOnly = (state.workspaceOrderByProject[projectViewKey] ?? []).filter(
            (key) => !known.has(key),
          );
          workspaceOrderByProject[projectViewKey] = [...synced, ...localOnly];
          workspaceOrderUpdatedAtByProject[projectViewKey] = entry.updatedAt;
        }
        if (!workspaceOrderByProject || !workspaceOrderUpdatedAtByProject) return false;
        set({ workspaceOrderByProject, workspaceOrderUpdatedAtByProject });
        return true;
      },
    }),
    {
      name: "sidebar-project-workspace-order",
      storage: createValidatedPersistStorage(AsyncStorage, SidebarOrderPersistedStateSchema),
      partialize: (state) => ({
        projectOrder: state.projectOrder,
        projectOrderUpdatedAt: state.projectOrderUpdatedAt,
        pinnedWorkspaceOrder: state.pinnedWorkspaceOrder,
        workspaceOrderByProject: state.workspaceOrderByProject,
        workspaceOrderUpdatedAtByProject: state.workspaceOrderUpdatedAtByProject,
      }),
      version: 3,
      migrate: migrateSidebarOrderState,
    },
  ),
);
