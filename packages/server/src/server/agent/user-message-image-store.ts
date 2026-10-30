import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { UserMessageImageRef } from "@getpaseo/protocol/agent-types";

const IMAGE_ID_PATTERN = /^[0-9a-f]{64}$/;

interface UserMessageImageStoreOptions {
  paseoHome: string;
  logger: Logger;
}

/**
 * Images submitted with user messages, kept under PASEO_HOME so every client can
 * fetch them by reference instead of carrying bytes on every timeline page.
 * Images are content-addressed per agent and live until the agent is deleted.
 */
export class UserMessageImageStore {
  private readonly root: string;
  private readonly logger: Logger;
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(options: UserMessageImageStoreOptions) {
    this.root = join(options.paseoHome, "user-message-images");
    this.logger = options.logger.child({ module: "user-message-image-store" });
  }

  /** Returns references immediately; bytes are written in the background and reads wait for them. */
  record(
    agentId: string,
    images: ReadonlyArray<{ data: string; mimeType: string }>,
  ): UserMessageImageRef[] {
    const directory = this.agentDirectory(agentId);
    if (!directory) return [];
    const refs = new Map<string, UserMessageImageRef>();
    for (const image of images) {
      const bytes = Buffer.from(image.data, "base64");
      const id = createHash("sha256").update(bytes).digest("hex");
      if (refs.has(id)) continue;
      refs.set(id, { id, mimeType: image.mimeType, size: bytes.byteLength });
      this.write(agentId, directory, id, bytes);
    }
    return [...refs.values()];
  }

  async read(agentId: string, imageId: string): Promise<Buffer | null> {
    const directory = this.agentDirectory(agentId);
    if (!directory || !IMAGE_ID_PATTERN.test(imageId)) return null;
    await this.pendingWrites.get(writeKey(agentId, imageId));
    try {
      return await readFile(join(directory, imageId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    const directory = this.agentDirectory(agentId);
    if (!directory) return;
    const prefix = writeKey(agentId, "");
    await Promise.all(
      [...this.pendingWrites].flatMap(([key, write]) => (key.startsWith(prefix) ? [write] : [])),
    );
    await rm(directory, { recursive: true, force: true });
  }

  private write(agentId: string, directory: string, imageId: string, bytes: Buffer): void {
    const key = writeKey(agentId, imageId);
    if (this.pendingWrites.has(key)) return;
    const target = join(directory, imageId);
    const write = (async () => {
      await mkdir(directory, { recursive: true });
      // Rename into place so a crash never leaves a partial file under the content hash.
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    })()
      .catch((error: unknown) => {
        this.logger.warn({ err: error, agentId, imageId }, "Failed to store user message image");
      })
      .finally(() => {
        if (this.pendingWrites.get(key) === write) this.pendingWrites.delete(key);
      });
    this.pendingWrites.set(key, write);
  }

  // Reads name the agent from client input; keep every path inside the store root.
  private agentDirectory(agentId: string): string | null {
    if (!agentId || agentId === "." || agentId === "..") return null;
    if (/[\\/]/.test(agentId) || agentId.includes("\0")) return null;
    return join(this.root, agentId);
  }
}

function writeKey(agentId: string, imageId: string): string {
  return `${agentId}/${imageId}`;
}
