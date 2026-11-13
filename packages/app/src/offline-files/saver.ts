import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { getAppSettings } from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { isOnUnmeteredNetwork } from "./network";
import { getOfflineFile, isSameOfflineVersion, saveOfflineFile, touchOfflineFile } from "./store";

const MB = 1024 * 1024;
// A chat re-renders often; one check per file per window keeps that from refetching.
const RECHECK_MS = 10 * 60 * 1000;

export type OfflineSaveResult =
  | { status: "saved" | "fresh" }
  | { status: "tooLarge"; maxFileMb: number }
  | { status: "failed"; error: string };

export interface OfflineSaveRequest {
  serverId: string;
  client: DaemonClient;
  /** Whether the daemon can stat a file without reading it. */
  canStat: boolean;
  workspaceRoot: string;
  /** The path as the chat names it: absolute, or relative to the workspace. */
  path: string;
}

export interface OfflineAutoSaveRequest extends Omit<OfflineSaveRequest, "path"> {
  /** The mention as the chat writes it; repeats within the recheck window are dropped. */
  mention: string;
  /** Finds the file, asking the host for bare names; null when it has none. */
  resolvePath: () => Promise<string | null>;
}

const inFlight = new Map<string, Promise<OfflineSaveResult>>();
const checkedAt = new Map<string, number>();
let autoTail: Promise<unknown> = Promise.resolve();

/**
 * Saves a file the chat mentions, when automatic saving is on, the app is in the foreground and
 * the device is on Wi-Fi. Automatic saves run one at a time.
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
      !(await isOnUnmeteredNetwork())
    ) {
      checkedAt.delete(mentionKey);
      return;
    }
    const path = await request.resolvePath().catch(() => null);
    if (!path) return;
    const save = { ...request, path };
    await run(fileKey(save), save);
  })();
  autoTail = next.catch(() => undefined);
  return next;
}

/** Saves a file the user asked for, on any network. */
export function saveOfflineFileNow(request: OfflineSaveRequest): Promise<OfflineSaveResult> {
  return run(fileKey(request), request);
}

function run(key: string, request: OfflineSaveRequest): Promise<OfflineSaveResult> {
  const pending = inFlight.get(key) ?? download(request).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

async function download(request: OfflineSaveRequest): Promise<OfflineSaveResult> {
  const { serverId, client, workspaceRoot, path } = request;
  const target = resolveFilePreviewReadTarget({ path, workspaceRoot });
  if (!target) return { status: "failed", error: i18n.t("panels.file.notFound") };
  const absolutePath = buildAbsoluteExplorerPath({ workspaceRoot, entryPath: path });
  const settings = await getAppSettings();
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
        await touchOfflineFile(serverId, absolutePath);
        return { status: "fresh" };
      }
    }
    const maxBytes = settings.offlineFilesMaxFileMb * MB;
    const file = await client.readFile(target.cwd, target.path, undefined, maxBytes);
    if (file.bytes.byteLength > maxBytes) {
      return { status: "tooLarge", maxFileMb: settings.offlineFilesMaxFileMb };
    }
    await saveOfflineFile({
      serverId,
      path: absolutePath,
      version: { ...file, mimeType: file.mime },
      bytes: file.bytes,
      limits: settings,
    });
    return { status: "saved" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/too large/i.test(message)) {
      return { status: "tooLarge", maxFileMb: settings.offlineFilesMaxFileMb };
    }
    return { status: "failed", error: message };
  }
}

function fileKey(request: OfflineSaveRequest): string {
  return `${request.serverId}\n${buildAbsoluteExplorerPath({
    workspaceRoot: request.workspaceRoot,
    entryPath: request.path,
  })}`;
}
