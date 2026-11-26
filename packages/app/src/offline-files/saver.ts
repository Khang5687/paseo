import { AppState } from "react-native";
import type { DaemonClient, FileReadSink } from "@getpaseo/client/internal/daemon-client";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { openAttachmentWriter } from "@/attachments/service";
import type { AttachmentWriter } from "@/attachments/types";
import { getFileNameFromPath } from "@/attachments/utils";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { getAppSettings } from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { useSessionStore } from "@/stores/session-store";
import { isOnUnmeteredNetwork } from "./network";
import {
  getOfflineFile,
  isSameOfflineVersion,
  saveOfflineAttachment,
  touchOfflineFile,
  type OfflineFile,
} from "./store";

/**
 * The largest file a saved-on-purpose copy (Save offline, Download, Send to) may be. A file that
 * is only opened keeps the smaller "Largest file" setting instead.
 */
export const PINNED_FILE_MAX_MB = 500;

// A chat re-renders often; one check per file per window keeps that from refetching.
const RECHECK_MS = 10 * 60 * 1000;
// Progress reaches the UI at most this often.
const PROGRESS_INTERVAL_MS = 150;
const MB = 1024 * 1024;

export type OfflineSaveResult =
  | { status: "saved" | "fresh"; file: OfflineFile }
  | { status: "tooLarge"; maxFileMb: number }
  | { status: "failed"; error: string };

/** Bytes received so far, and the file's size. */
export type OfflineSaveProgress = (received: number, total: number) => void;

export interface OfflineSaveRequest {
  serverId: string;
  client: DaemonClient;
  /** Whether the daemon can stat a file without reading it. */
  canStat: boolean;
  workspaceRoot: string;
  /** The path as the chat names it: absolute, or relative to the workspace. */
  path: string;
  /** Saved on purpose: age never removes the copy. */
  pinned: boolean;
  onProgress?: OfflineSaveProgress;
}

export interface OfflineAutoSaveRequest extends Omit<
  OfflineSaveRequest,
  "path" | "pinned" | "onProgress"
> {
  /** The mention as the chat writes it; repeats within the recheck window are dropped. */
  mention: string;
  /** Finds the file, asking the host for bare names; null when it has none. */
  resolvePath: () => Promise<string | null>;
}

interface InFlightSave {
  promise: Promise<OfflineSaveResult>;
  /** Everyone waiting on this transfer, so a second ask shares it and its progress. */
  listeners: Set<OfflineSaveProgress>;
}

const inFlight = new Map<string, InFlightSave>();
const checkedAt = new Map<string, number>();
let autoTail: Promise<unknown> = Promise.resolve();

/**
 * Saves a file the chat mentions, when automatic saving is on, the app is in the foreground and
 * the network is allowed (Wi-Fi only, unless the user turned that off). Automatic saves run one
 * at a time.
 */
export function autoSaveOfflineFile(request: OfflineAutoSaveRequest): Promise<void> {
  const mentionKey = `${request.serverId}\n${request.workspaceRoot}\n${request.mention}`;
  const last = checkedAt.get(mentionKey);
  if (last && Date.now() - last < RECHECK_MS) return Promise.resolve();
  checkedAt.set(mentionKey, Date.now());
  const next = (async () => {
    await autoTail;
    const settings = await getAppSettings();
    if (
      AppState.currentState !== "active" ||
      !settings.offlineFilesAutoSave ||
      (settings.offlineFilesWifiOnly && !(await isOnUnmeteredNetwork()))
    ) {
      checkedAt.delete(mentionKey);
      return;
    }
    const path = await request.resolvePath().catch(() => null);
    if (!path) return;
    const save = { ...request, path, pinned: false };
    await run(fileKey(save), save);
  })();
  autoTail = next.catch(() => undefined);
  return next;
}

/**
 * Adds a file to this device's Saved library, on any network: what Save offline, Download and
 * Send to call. The copy is pinned, so age never removes it, and may be up to
 * `PINNED_FILE_MAX_MB`. The file is written to the device as it arrives, never held whole in
 * memory. Without a connection to the host it fails with the host-disconnected message.
 */
export function addSavedFile(input: {
  serverId: string;
  /** Absolute, or relative to `workspaceRoot`. */
  path: string;
  workspaceRoot?: string;
  onProgress?: OfflineSaveProgress;
}): Promise<OfflineSaveResult> {
  const session = useSessionStore.getState().sessions[input.serverId];
  if (!session?.client) {
    return Promise.resolve({
      status: "failed",
      error: i18n.t("workspace.terminal.hostDisconnected"),
    });
  }
  const request: OfflineSaveRequest = {
    serverId: input.serverId,
    client: session.client,
    canStat: session.serverInfo?.features?.workspaceFileEditing === true,
    workspaceRoot: input.workspaceRoot ?? "",
    path: input.path,
    pinned: true,
    onProgress: input.onProgress,
  };
  return run(fileKey(request), request);
}

function run(key: string, request: OfflineSaveRequest): Promise<OfflineSaveResult> {
  const running = inFlight.get(key);
  if (running) {
    if (request.onProgress) running.listeners.add(request.onProgress);
    return running.promise;
  }
  const listeners = new Set<OfflineSaveProgress>();
  if (request.onProgress) listeners.add(request.onProgress);
  const promise = download({
    ...request,
    onProgress: throttleProgress((received, total) => {
      for (const listener of listeners) listener(received, total);
    }),
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, { promise, listeners });
  return promise;
}

function throttleProgress(report: OfflineSaveProgress): OfflineSaveProgress {
  let last = 0;
  return (received, total) => {
    const now = Date.now();
    if (received < total && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    report(received, total);
  };
}

async function download(request: OfflineSaveRequest): Promise<OfflineSaveResult> {
  const { serverId, client, workspaceRoot, path } = request;
  const target = resolveFilePreviewReadTarget({ path, workspaceRoot });
  if (!target) return { status: "failed", error: i18n.t("panels.file.notFound") };
  const absolutePath = buildAbsoluteExplorerPath({ workspaceRoot, entryPath: path });
  const settings = await getAppSettings();
  const maxFileMb = request.pinned ? PINNED_FILE_MAX_MB : settings.offlineFilesMaxFileMb;
  let writer: AttachmentWriter | null = null;
  let release = () => {};
  let committed = false;
  try {
    const existing = await getOfflineFile(serverId, absolutePath);
    if (existing && request.canStat) {
      const subscription = await client.subscribeFile(target, () => {});
      void subscription.unsubscribe();
      const remote = subscription.initial;
      // A file the host lost keeps its saved copy until retention removes it.
      if (remote.status !== "ready")
        return { status: "failed", error: i18n.t("panels.file.notFound") };
      if (isSameOfflineVersion(existing, remote)) {
        await touchOfflineFile(serverId, absolutePath, { pin: request.pinned });
        const file = await getOfflineFile(serverId, absolutePath);
        if (file) return { status: "fresh", file };
      }
    }
    // The writer opens once the host says what the file is; each chunk then goes straight to it.
    const fileName = getFileNameFromPath(absolutePath);
    const sink: FileReadSink = {
      async begin(meta) {
        if (meta.size > maxFileMb * MB) throw new Error("File is too large to save");
        writer = await openAttachmentWriter({ mimeType: meta.mime, fileName });
        // The collector must not drop the partial file while it arrives.
        release = retainAttachmentForGarbageCollection(writer.id);
      },
      async write(chunk) {
        await writer?.write(chunk);
      },
    };
    // No request timeout: a big file over a slow link takes minutes, and a dead connection
    // still rejects on disconnect.
    const meta = await client.readFileToSink(target.cwd, target.path, sink, {
      maxBytes: maxFileMb * MB,
      timeout: 0,
      onProgress: request.onProgress,
    });
    const attachment = await (writer as AttachmentWriter | null)?.finish();
    if (!attachment) return { status: "failed", error: i18n.t("downloads.failed") };
    const file = await saveOfflineAttachment({
      serverId,
      path: absolutePath,
      version: { ...meta, mimeType: meta.mime },
      attachment,
      limits: settings,
      pinned: request.pinned,
    });
    committed = true;
    // The new copy is the first the cap evicts when it alone does not fit in the total.
    if (!(await getOfflineFile(serverId, absolutePath))) {
      return { status: "tooLarge", maxFileMb: settings.offlineFilesMaxTotalMb };
    }
    return { status: "saved", file };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/too large/i.test(message)) {
      return { status: "tooLarge", maxFileMb };
    }
    return { status: "failed", error: message };
  } finally {
    if (!committed) await (writer as AttachmentWriter | null)?.abort().catch(() => undefined);
    release();
  }
}

function fileKey(request: OfflineSaveRequest): string {
  return `${request.serverId}\n${request.pinned}\n${buildAbsoluteExplorerPath({
    workspaceRoot: request.workspaceRoot,
    entryPath: request.path,
  })}`;
}
