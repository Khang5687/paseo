import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { ToolHosts } from "../agent/host-operations/index.js";
import { readExplorerFileBytes } from "../file-explorer/service.js";
import {
  searchDirectoryEntries,
  WORKSPACE_SEARCH_HIDDEN_DIRECTORIES,
} from "../../utils/directory-suggestions.js";
import { collectFileMentions } from "./mentions/index.js";
import type { FileCopies } from "./service.js";
import { FILE_COPY_UPLOAD_NAME } from "./uploads.js";

export interface FileCopySenderOptions {
  agentManager: Pick<AgentManager, "subscribe" | "getAgent" | "getLastAssistantMessage">;
  hosts: Pick<ToolHosts, "use">;
  fileCopies: Pick<FileCopies, "readSettings">;
  logger: pino.Logger;
  homeDir?: string;
}

interface MentionedFile {
  path: string;
  revision: string;
}

/**
 * Pushes copies of the files an agent's final reply names to `files.copies.targetServerId`
 * over the connected-host link, one turn at a time. The target keeps them for clients while
 * this host sleeps. Failures are logged; the next mention of a file tries again.
 */
export class FileCopySender {
  private readonly options: FileCopySenderOptions;
  private readonly logger: pino.Logger;
  private readonly homeDir: string;
  // Agents that produced assistant text since their turn started.
  private readonly repliedThisTurn = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: FileCopySenderOptions) {
    this.options = options;
    this.logger = options.logger.child({ module: "file-copy-sender" });
    this.homeDir = options.homeDir ?? homedir();
  }

  attach(): () => void {
    return this.options.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") return;
        const { agentId } = event;
        switch (event.event.type) {
          case "turn_started":
          case "turn_failed":
          case "turn_canceled":
            this.repliedThisTurn.delete(agentId);
            return;
          case "timeline":
            if (event.event.item.type === "assistant_message") this.repliedThisTurn.add(agentId);
            return;
          case "turn_completed":
            // A turn that ended without text would otherwise re-send the previous turn's reply.
            if (this.repliedThisTurn.delete(agentId)) this.enqueue(agentId);
            return;
          default:
            return;
        }
      },
      { replayState: false },
    );
  }

  /** Resolves once every turn queued so far has been pushed or has failed. */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(agentId: string): void {
    this.queue = this.queue
      .then(() => this.pushTurn(agentId))
      .catch((err: unknown) => {
        this.logger.warn({ err, agentId }, "Failed to push file copies");
      });
  }

  private async pushTurn(agentId: string): Promise<void> {
    const settings = await this.options.fileCopies.readSettings();
    const targetServerId = settings.targetServerId;
    if (!targetServerId) return;
    const agent = this.options.agentManager.getAgent(agentId);
    const text = agent ? await this.options.agentManager.getLastAssistantMessage(agentId) : null;
    if (!agent || !text) return;

    const files = await this.findMentionedFiles(text, agent.cwd, settings.maxFileBytes);
    if (files.length === 0) return;

    await this.options.hosts.use(targetServerId, async (client) => {
      if (client.getLastServerInfoMessage()?.features?.fileCopies !== true) {
        throw new Error(`Host ${targetServerId} does not keep file copies; update it`);
      }
      const needed = new Set(
        await client.recordFileCopyMentions({ sourceHome: this.homeDir, files }),
      );
      for (const file of files) {
        if (!needed.has(file.path)) continue;
        try {
          const bytes = await readExplorerFileBytes({
            root: path.dirname(file.path),
            relativePath: path.basename(file.path),
          });
          if (bytes.size > settings.maxFileBytes) continue;
          const upload = await client.uploadFile({
            fileName: FILE_COPY_UPLOAD_NAME,
            mimeType: bytes.mimeType,
            bytes: bytes.bytes,
            modifiedAt: bytes.modifiedAt,
          });
          if (!upload.file) throw new Error(upload.error ?? "Upload failed");
          await client.putFileCopy({
            uploadId: upload.file.id,
            sourceHome: this.homeDir,
            path: file.path,
            size: bytes.size,
            mimeType: bytes.mimeType,
            modifiedAt: bytes.modifiedAt,
            revision: bytes.revision,
          });
        } catch (err) {
          this.logger.warn({ err, agentId, path: file.path }, "Failed to push a file copy");
        }
      }
    });
  }

  /** Existing regular files the reply names, at or under the per-file limit, minus secrets. */
  async findMentionedFiles(
    text: string,
    cwd: string,
    maxFileBytes: number,
  ): Promise<MentionedFile[]> {
    const files = new Map<string, MentionedFile>();
    for (const mention of collectFileMentions(text, { workspaceRoot: cwd })) {
      const candidate =
        mention.kind === "path"
          ? this.absolutePath(mention.path, cwd)
          : await this.lookUp(mention.ambiguousQuery, cwd);
      if (!candidate || files.has(candidate)) continue;
      if (isSecretPath(candidate, this.homeDir)) {
        this.logger.debug({ path: candidate }, "Not copying a secret file");
        continue;
      }
      // A link elsewhere can point into ~/.ssh; check where it really leads too.
      const target = await fs.realpath(candidate).catch(() => null);
      if (!target) continue;
      if (target !== candidate && isSecretPath(target, this.homeDir)) {
        this.logger.debug({ path: candidate, target }, "Not copying a link to a secret file");
        continue;
      }
      const stats = await fs.stat(target, { bigint: true }).catch(() => null);
      if (!stats?.isFile() || stats.size > BigInt(maxFileBytes)) continue;
      // Same revision format as the file explorer's, so a later read can compare them.
      files.set(candidate, {
        path: candidate,
        revision: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`,
      });
    }
    return [...files.values()];
  }

  private absolutePath(mentioned: string, cwd: string): string | null {
    if (mentioned === "~" || mentioned.startsWith("~/")) {
      return path.join(this.homeDir, mentioned.slice(1));
    }
    return path.isAbsolute(mentioned) ? mentioned : path.resolve(cwd, mentioned);
  }

  /** A bare name or relative inline-code path, found the way a tap in the app finds it. */
  private async lookUp(query: string, cwd: string): Promise<string | null> {
    const [match] = await searchDirectoryEntries({
      root: cwd,
      query: query.replace(/\/+$/, ""),
      pathFormat: "relative",
      pathQueryPolicy: "slashes",
      blankQueryBehavior: "none",
      rootAliases: [],
      traversableHiddenDirectoryNames: WORKSPACE_SEARCH_HIDDEN_DIRECTORIES,
      respectGitIgnore: true,
      excludedDiscoveryPaths: [],
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
      limit: 1,
    }).catch(() => []);
    return match ? path.join(cwd, match.path) : null;
  }
}

// Owner decision Q62: never copy these, even to the owner's own host.
const SECRET_NAME = /^(\.env.*|.*\.pem|.*\.key|id_.*)$/i;
const SECRET_HOME_DIRS = [".ssh", ".paseo"];

/** Keys, env files and anything under `~/.ssh` or `~/.paseo` on this host. */
export function isSecretPath(absolutePath: string, homeDir: string): boolean {
  if (SECRET_NAME.test(path.basename(absolutePath))) return true;
  return SECRET_HOME_DIRS.some((dir) => {
    const relative = path.relative(path.join(homeDir, dir), absolutePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
