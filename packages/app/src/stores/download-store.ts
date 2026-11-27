import { create } from "zustand";
import * as LegacyFileSystem from "expo-file-system/legacy";
import { saveBrowserFile } from "@/downloads/browser-download";
import { resolveDownloadTargetFile } from "@/downloads/cache-file";
import { readSavedContent } from "@/downloads/saved-content";
import { saveFile } from "@/downloads/save-file";
import { shareSavedFile } from "@/downloads/share-file";
import type { SaveOutcome, SavePreferences } from "@/downloads/types";
import type { OfflineSaveProgress, OfflineSaveResult } from "@/offline-files/saver";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

interface DownloadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

/** A transfer under this size finishes before a progress bar would help, so it gets none. */
const TRANSFER_PROGRESS_MIN_BYTES = 5 * 1024 * 1024;

export interface DownloadedBytes {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string | null;
}

function addDownloadEntry(input: { serverId: string; scopeId: string; fileName: string }): string {
  const id = generateDownloadId();
  const download: Download = { id, ...input, status: "downloading", startedAt: Date.now() };
  useDownloadStore.setState((state) => ({
    downloads: new Map(state.downloads).set(id, download),
    activeDownloadId: id,
  }));
  return id;
}

function toProgress(startedAt: number, received: number, total: number): DownloadProgress {
  const elapsed = (Date.now() - startedAt) / 1000;
  const speed = elapsed > 0 ? received / elapsed : 0;
  return {
    percent: total > 0 ? received / total : 0,
    bytesWritten: received,
    totalBytes: total,
    speed,
    eta: speed > 0 ? (total - received) / speed : 0,
  };
}

/**
 * Shows the download toast, with percent, speed and time left, while `run` copies a big file.
 * A file under a few MB never gets one. The toast goes when `run` ends; the caller reports the
 * result its own way.
 */
export async function withTransferProgress<T>(
  input: { serverId: string; scopeId: string; fileName: string },
  run: (onProgress: OfflineSaveProgress) => Promise<T>,
): Promise<T> {
  let id: string | null = null;
  const startedAt = Date.now();
  try {
    return await run((received, total) => {
      if (id === null && total >= TRANSFER_PROGRESS_MIN_BYTES) {
        id = addDownloadEntry(input);
      }
      if (id !== null) {
        useDownloadStore.getState().updateProgress(id, toProgress(startedAt, received, total));
      }
    });
  } finally {
    if (id !== null) useDownloadStore.getState().dismissDownload(id);
  }
}

export interface Download {
  id: string;
  serverId: string;
  scopeId: string;
  fileName: string;
  status: "downloading" | "complete" | "error";
  message?: string;
  /** Where a finished download went, when Paseo put it in a known folder. */
  savedTo?: string;
  /** Desktop: the saved file, so the toast can show it in the file manager. */
  revealPath?: string;
  progress?: DownloadProgress;
  startedAt: number;
}

interface DownloadState {
  downloads: Map<string, Download>;
  activeDownloadId: string | null;

  startDownload: (params: {
    serverId: string;
    scopeId: string;
    fileName: string;
    path: string;
    daemonProfile: HostProfile | undefined;
    /** Connection the host runtime is using right now; `null` while disconnected. */
    activeConnectionId: string | null;
    requestFileDownloadToken: (path: string) => Promise<{
      token: string | null;
      fileName: string | null;
      mimeType: string | null;
      size: number | null;
      error: string | null;
    }>;
    /**
     * Copies the file to this device's Saved library, over the session socket, in chunks. The
     * download is delivered from that copy, so a file of any allowed size never sits whole in memory.
     */
    saveCopy: (onProgress?: OfflineSaveProgress) => Promise<OfflineSaveResult>;
    /** Where the owner wants the file; read from settings when the download starts. */
    destination: SavePreferences;
    saveFile?: typeof saveFile;
    readSaved?: typeof readSavedContent;
    fetchFile?: typeof fetch;
  }) => Promise<void>;

  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string, outcome?: SaveOutcome) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  downloads: new Map(),
  activeDownloadId: null,

  startDownload: async ({
    serverId,
    scopeId,
    fileName,
    path,
    daemonProfile,
    activeConnectionId,
    requestFileDownloadToken,
    saveCopy,
    destination,
    saveFile: save = saveFile,
    readSaved = readSavedContent,
    fetchFile = fetch,
  }) => {
    const id = addDownloadEntry({ serverId, scopeId, fileName });

    try {
      const tokenResponse = await requestFileDownloadToken(path);
      if (tokenResponse.error || !tokenResponse.token) {
        throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
      }

      const resolvedFileName = tokenResponse.fileName ?? fileName;
      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile, activeConnectionId);
      if (!downloadTarget) {
        // Relay, SSH, socket and pipe hosts have no HTTP endpoint: copy the file over the
        // session socket that is already connected (#543), then deliver the saved copy.
        const startedAt = Date.now();
        const result = await saveCopy((received, total) =>
          get().updateProgress(id, toProgress(startedAt, received, total)),
        );
        if (result.status === "tooLarge") {
          throw new Error(
            i18n.t("composer.errors.fileTooLarge", {
              fileName: resolvedFileName,
              size: `${result.maxFileMb} MB`,
            }),
          );
        }
        if (result.status === "failed") {
          throw new Error(result.error);
        }
        get().completeDownload(
          id,
          await save({
            content: await readSaved(result.file, resolvedFileName),
            fileName: resolvedFileName,
            mimeType: tokenResponse.mimeType,
            preferences: destination,
          }),
        );
        return;
      }
      if (!downloadTarget.baseUrl) {
        throw new Error(i18n.t("downloads.hostUnavailable"));
      }
      // The file also goes to the Saved library, so it opens later with the host asleep.
      void saveCopy();

      const downloadUrl = buildDownloadUrl(downloadTarget.baseUrl, tokenResponse.token);

      if (isWeb) {
        const file = await fetchDownload(fetchFile, downloadUrl);
        get().completeDownload(
          id,
          await save({
            content: file,
            fileName: resolvedFileName,
            mimeType: tokenResponse.mimeType,
            preferences: destination,
          }),
        );
        return;
      }

      const downloadStartTime = Date.now();
      const targetFile = resolveDownloadTargetFile(resolvedFileName);
      const downloadResumable = LegacyFileSystem.createDownloadResumable(
        downloadUrl,
        targetFile.uri,
        downloadTarget.authHeader
          ? { headers: { Authorization: downloadTarget.authHeader } }
          : undefined,
        (data) => {
          const now = Date.now();
          const { totalBytesWritten, totalBytesExpectedToWrite } = data;

          if (totalBytesExpectedToWrite <= 0) {
            return;
          }

          const percent = totalBytesWritten / totalBytesExpectedToWrite;
          const elapsed = (now - downloadStartTime) / 1000;
          const speed = elapsed > 0 ? totalBytesWritten / elapsed : 0;
          const remaining = totalBytesExpectedToWrite - totalBytesWritten;
          const eta = speed > 0 ? remaining / speed : 0;

          get().updateProgress(id, {
            percent,
            bytesWritten: totalBytesWritten,
            totalBytes: totalBytesExpectedToWrite,
            speed,
            eta,
          });
        },
      );

      const result = await downloadResumable.downloadAsync();
      if (!result) {
        throw new Error(i18n.t("downloads.cancelled"));
      }

      get().completeDownload(
        id,
        await save({
          content: { uri: result.uri },
          fileName: resolvedFileName,
          mimeType: tokenResponse.mimeType,
          preferences: destination,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
      get().failDownload(id, message);
    }
  },

  updateProgress: (id, progress) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download || download.status !== "downloading") {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, progress });
      return { downloads: updated };
    });
  },

  completeDownload: (id, outcome) => {
    // Backing out of the Save dialog or folder picker is not a download to report.
    if (outcome?.kind === "cancelled") {
      get().dismissDownload(id);
      return;
    }
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, {
        ...download,
        status: "complete",
        ...(outcome?.kind === "saved"
          ? {
              savedTo: outcome.where,
              ...(outcome.revealPath ? { revealPath: outcome.revealPath } : {}),
            }
          : {}),
      });
      return { downloads: updated };
    });
  },

  failDownload: (id, message) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "error", message });
      return { downloads: updated };
    });
  },

  dismissDownload: (id) => {
    set((state) => {
      const updated = new Map(state.downloads);
      updated.delete(id);
      const newActiveId =
        state.activeDownloadId === id ? findMostRecentDownloadId(updated) : state.activeDownloadId;
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },

  dismissAllCompleted: () => {
    set((state) => {
      const updated = new Map(state.downloads);
      for (const [id, download] of updated) {
        if (download.status !== "downloading") {
          updated.delete(id);
        }
      }
      let newActiveId: string | null;
      if (!state.activeDownloadId) newActiveId = null;
      else if (updated.has(state.activeDownloadId)) newActiveId = state.activeDownloadId;
      else newActiveId = findMostRecentDownloadId(updated);
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },
}));

function findMostRecentDownloadId(downloads: Map<string, Download>): string | null {
  let mostRecent: Download | null = null;
  for (const download of downloads.values()) {
    if (!mostRecent || download.startedAt > mostRecent.startedAt) {
      mostRecent = download;
    }
  }
  return mostRecent?.id ?? null;
}

interface DownloadTarget {
  baseUrl: string | null;
  authHeader: string | null;
}

/**
 * The HTTP download route is only reachable over a direct TCP connection. Returns `null` when
 * the connection in use is anything else (relay, SSH, socket, pipe, or none yet), so the caller
 * reads the file over the session socket instead.
 */
function resolveDaemonDownloadTarget(
  daemon: HostProfile | undefined,
  activeConnectionId: string | null,
): DownloadTarget | null {
  const connection = daemon?.connections.find((conn) => conn.id === activeConnectionId);
  if (connection?.type !== "directTcp") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
  } catch {
    return { baseUrl: null, authHeader: null };
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }

  let authCredentials: { username: string; password: string } | null = null;
  if (parsed.username || parsed.password) {
    authCredentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }

  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/");

  const baseUrl = parsed.origin;
  const authHeader = authCredentials
    ? `Basic ${btoa(`${authCredentials.username}:${authCredentials.password}`)}`
    : null;

  return { baseUrl, authHeader };
}

function buildDownloadUrl(baseUrl: string, token: string): string {
  const url = new URL("/api/files/download", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Hands bytes to other apps: the share sheet on native, a browser download on web. */
export async function shareFileBytes(file: DownloadedBytes): Promise<void> {
  const uri = await saveDownloadedBytes(file);
  if (uri) await shareSavedFile(uri, file.mimeType, file.fileName);
}

/**
 * Fetches the file instead of navigating to it. The app runs on another origin than the host
 * (paseo://app on desktop), so a link to the download URL navigates the whole window, and any
 * response that is not the file (a proxy's 401 page, a 404) replaces the app.
 */
async function fetchDownload(fetchFile: typeof fetch, url: string): Promise<Blob> {
  let response: Response;
  try {
    // Send the same cookies the host's WebSocket handshake sends, so a proxy in front of the
    // host lets the download through. Refuse redirects: a proxy that redirects to a login page
    // would otherwise be saved as the file.
    response = await fetchFile(url, { credentials: "include", redirect: "error" });
  } catch {
    throw new Error(i18n.t("downloads.failed"));
  }
  if (!response.ok) {
    throw new Error(i18n.t("downloads.httpFailed", { status: response.status }));
  }
  try {
    // The body streams after the headers, so the connection can still drop here.
    return await response.blob();
  } catch {
    throw new Error(i18n.t("downloads.failed"));
  }
}

/**
 * Saves bytes read over the session. Web and Electron hand them to the browser's download
 * manager and return `null`; native writes the file and returns its URI for the share sheet.
 */
async function saveDownloadedBytes({
  bytes,
  fileName,
  mimeType,
}: DownloadedBytes): Promise<string | null> {
  if (isWeb) {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    saveBrowserFile(new Blob([buffer], { type: mimeType ?? "application/octet-stream" }), fileName);
    return null;
  }
  // Resolve and write in one tick so two downloads of the same name cannot pick the same path.
  const targetFile = resolveDownloadTargetFile(fileName);
  targetFile.write(bytes);
  return targetFile.uri;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 1) {
    return "< 1s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
