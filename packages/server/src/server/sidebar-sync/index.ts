import { promises as fs } from "node:fs";
import { z } from "zod";
import { SidebarProjectOrderSchema, type SidebarProjectOrder } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

// Sidebar state that every device connected to this host shares. Only the project order lives
// here today; later shared sidebar state adds a key beside it. Unknown keys survive a write, so a
// downgraded daemon keeps what a newer one stored.
const SidebarSyncFileSchema = z
  .object({ projectOrder: SidebarProjectOrderSchema.optional() })
  .passthrough();
type SidebarSyncFile = z.infer<typeof SidebarSyncFileSchema>;

const EMPTY_PROJECT_ORDER: SidebarProjectOrder = { order: [], updatedAt: 0 };

export interface SidebarProjectOrderSetResult {
  accepted: boolean;
  projectOrder: SidebarProjectOrder;
}

export class SidebarSyncStore {
  private state: SidebarSyncFile | null = null;
  private loading: Promise<SidebarSyncFile> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(projectOrder: SidebarProjectOrder) => void>();

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
    const updated = { ...state, projectOrder };
    this.state = updated;
    const write = this.writes.then(() => this.writeFile(this.filePath, updated));
    this.writes = write.catch(() => undefined);
    await write;
    for (const listener of this.listeners) listener(projectOrder);
    return { accepted: true, projectOrder };
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
