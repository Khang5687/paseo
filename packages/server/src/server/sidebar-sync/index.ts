import { promises as fs } from "node:fs";
import { z } from "zod";
import {
  SidebarProjectOrderSchema,
  SidebarWorkspaceOrderSchema,
  type SidebarProjectOrder,
  type SidebarWorkspaceOrder,
} from "@getpaseo/protocol/messages";
import { mergeSidebarWorkspaceOrder } from "@getpaseo/protocol/sidebar-workspace-order";
import { writeJsonFileAtomic } from "../atomic-file.js";

// Sidebar state that every device connected to this host shares: the project order and the
// workspace order (each project's manual order plus the sort). Unknown keys survive a write, so a
// downgraded daemon keeps what a newer one stored.
const SidebarSyncFileSchema = z
  .object({
    projectOrder: SidebarProjectOrderSchema.optional(),
    workspaceOrder: SidebarWorkspaceOrderSchema.optional(),
  })
  .passthrough();
type SidebarSyncFile = z.infer<typeof SidebarSyncFileSchema>;

const EMPTY_PROJECT_ORDER: SidebarProjectOrder = { order: [], updatedAt: 0 };
const EMPTY_WORKSPACE_ORDER: SidebarWorkspaceOrder = { projects: {} };

export interface SidebarProjectOrderSetResult {
  accepted: boolean;
  projectOrder: SidebarProjectOrder;
}

export class SidebarSyncStore {
  private state: SidebarSyncFile | null = null;
  private loading: Promise<SidebarSyncFile> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(projectOrder: SidebarProjectOrder) => void>();
  private readonly workspaceOrderListeners = new Set<
    (workspaceOrder: SidebarWorkspaceOrder) => void
  >();

  constructor(
    private readonly filePath: string,
    private readonly writeFile: (
      filePath: string,
      value: unknown,
    ) => Promise<void> = writeJsonFileAtomic,
  ) {}

  async getProjectOrder(): Promise<SidebarProjectOrder> {
    return (await this.load()).projectOrder ?? EMPTY_PROJECT_ORDER;
  }

  /** Keeps the newer order. An older or equal `updatedAt` leaves the stored one and says so. */
  async setProjectOrder(next: SidebarProjectOrder): Promise<SidebarProjectOrderSetResult> {
    await this.load();
    // Read the state after the await: another set may have landed while this one waited.
    const state = this.state ?? {};
    const current = state.projectOrder ?? EMPTY_PROJECT_ORDER;
    if (next.updatedAt <= current.updatedAt) return { accepted: false, projectOrder: current };
    const projectOrder = { order: [...new Set(next.order)], updatedAt: next.updatedAt };
    await this.save({ ...state, projectOrder });
    for (const listener of this.listeners) listener(projectOrder);
    return { accepted: true, projectOrder };
  }

  async getWorkspaceOrder(): Promise<SidebarWorkspaceOrder> {
    return (await this.load()).workspaceOrder ?? EMPTY_WORKSPACE_ORDER;
  }

  /** Merges `next` entry by entry, newest wins, and returns what the host holds afterwards. */
  async mergeWorkspaceOrder(next: SidebarWorkspaceOrder): Promise<SidebarWorkspaceOrder> {
    await this.load();
    const state = this.state ?? {};
    const { merged, changed } = mergeSidebarWorkspaceOrder(
      state.workspaceOrder ?? EMPTY_WORKSPACE_ORDER,
      next,
    );
    if (!changed) return merged;
    await this.save({ ...state, workspaceOrder: merged });
    for (const listener of this.workspaceOrderListeners) listener(merged);
    return merged;
  }

  subscribeWorkspaceOrder(listener: (workspaceOrder: SidebarWorkspaceOrder) => void): () => void {
    this.workspaceOrderListeners.add(listener);
    return () => {
      this.workspaceOrderListeners.delete(listener);
    };
  }

  private async save(updated: SidebarSyncFile): Promise<void> {
    this.state = updated;
    const write = this.writes.then(() => this.writeFile(this.filePath, updated));
    this.writes = write.catch(() => undefined);
    await write;
  }

  subscribe(listener: (projectOrder: SidebarProjectOrder) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private load(): Promise<SidebarSyncFile> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= this.read().then(
      (state) => {
        this.state ??= state;
        return this.state;
      },
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  private async read(): Promise<SidebarSyncFile> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      const parsed = SidebarSyncFileSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : {};
    } catch {
      // A torn or hand-edited file: start over rather than refuse every sidebar request.
      return {};
    }
  }
}
