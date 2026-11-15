import type pino from "pino";
import type { FileCopySettings } from "@getpaseo/protocol/file-copies/schemas";
import type { DaemonConfigStore, FileCopiesConfigPatch } from "../daemon-config-store.js";
import type { PersistedFileCopiesConfig } from "../persisted-config.js";
import { DEFAULT_FILE_COPY_LIMITS, FileCopyStore, type FileCopyLimits } from "./store.js";

export type FileCopiesConfigSource = Pick<DaemonConfigStore, "readFileCopies" | "updateFileCopies">;

export interface FileCopiesOptions {
  paseoHome: string;
  logger: pino.Logger;
  config: FileCopiesConfigSource;
}

/**
 * Settings and storage for file copies. `files.copies` in config.json is read on every use, so
 * a hand edit applies at the next turn or request; the RPC writes it through the config store.
 */
export class FileCopies {
  private readonly options: FileCopiesOptions;
  private started: FileCopyStore | null = null;

  constructor(options: FileCopiesOptions) {
    this.options = options;
  }

  get store(): FileCopyStore {
    if (!this.started) throw new Error("File copies have not started");
    return this.started;
  }

  /** Builds the store with the configured limits, so its first prune never uses the defaults. */
  async start(): Promise<void> {
    const store = new FileCopyStore({
      paseoHome: this.options.paseoHome,
      logger: this.options.logger,
      limits: toLimits(toSettings(await this.options.config.readFileCopies())),
    });
    await store.start();
    this.started = store;
  }

  async stop(): Promise<void> {
    await this.started?.stop();
  }

  async readSettings(): Promise<FileCopySettings> {
    return this.apply(await this.options.config.readFileCopies());
  }

  async updateSettings(patch: FileCopiesConfigPatch): Promise<FileCopySettings> {
    return this.apply(await this.options.config.updateFileCopies(patch));
  }

  private async apply(config: PersistedFileCopiesConfig): Promise<FileCopySettings> {
    const settings = toSettings(config);
    const limits = toLimits(settings);
    const current = this.store.getLimits();
    if (
      current.keepDays !== limits.keepDays ||
      current.maxTotalBytes !== limits.maxTotalBytes ||
      current.maxFileBytes !== limits.maxFileBytes
    ) {
      await this.store.setLimits(limits);
    }
    return settings;
  }
}

function toSettings(config: PersistedFileCopiesConfig): FileCopySettings {
  return {
    targetServerId: config.targetServerId ?? null,
    keepDays: config.keepDays ?? DEFAULT_FILE_COPY_LIMITS.keepDays,
    maxTotalBytes: config.maxTotalBytes ?? DEFAULT_FILE_COPY_LIMITS.maxTotalBytes,
    maxFileBytes: config.maxFileBytes ?? DEFAULT_FILE_COPY_LIMITS.maxFileBytes,
  };
}

function toLimits({ keepDays, maxTotalBytes, maxFileBytes }: FileCopySettings): FileCopyLimits {
  return { keepDays, maxTotalBytes, maxFileBytes };
}
