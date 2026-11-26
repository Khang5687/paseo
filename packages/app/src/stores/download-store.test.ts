import { beforeEach, describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { i18n } from "@/i18n/i18next";
import type { SaveOutcome, SaveRequest } from "@/downloads/types";
import type { OfflineSaveProgress, OfflineSaveResult } from "@/offline-files/saver";
import type { OfflineFile } from "@/offline-files/store";
import { useDownloadStore, type Download } from "@/stores/download-store";
import type {
  DirectTcpHostConnection,
  HostProfile,
  RelayHostConnection,
} from "@/types/host-connection";

const FILE_BYTES = new TextEncoder().encode("relay download payload");
const FILE_PATH = "reports/données été.bin";
const FILE_NAME = "données été.bin";
const MIME_TYPE = "application/octet-stream";

const relayConnection: RelayHostConnection = {
  id: "relay:relay.paseo.sh:443",
  type: "relay",
  relayEndpoint: "relay.paseo.sh:443",
  daemonPublicKeyB64: "cHVibGljLWtleQ==",
};

// The #3753 shape: the relay hostname stored as a directTcp entry that nothing can reach.
const staleTcpConnection: DirectTcpHostConnection = {
  id: "direct:relay.paseo.sh:443",
  type: "directTcp",
  endpoint: "relay.paseo.sh:443",
};

const localTcpConnection: DirectTcpHostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};

function profileWith(connections: HostProfile["connections"]): HostProfile {
  return {
    serverId: "srv_remote",
    label: "Remote",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createTokenRequest(size: number | null = FILE_BYTES.byteLength) {
  const requested: string[] = [];
  return {
    requested,
    request: async (path: string) => {
      requested.push(path);
      return { token: "tok", fileName: FILE_NAME, mimeType: MIME_TYPE, size, error: null };
    },
  };
}

const SAVED_FILE: OfflineFile = {
  serverId: "srv_remote",
  path: FILE_PATH,
  size: FILE_BYTES.byteLength,
  modifiedAt: "2026-01-01T00:00:00Z",
  revision: "r1",
  kind: "binary",
  mimeType: MIME_TYPE,
  savedAt: 1,
  pinned: true,
  attachment: {
    id: "att-1",
    mimeType: MIME_TYPE,
    storageType: "web-indexeddb",
    storageKey: "att-1",
    createdAt: 1,
  },
};
const SAVED_CONTENT = { managedPath: "/managed/attachments/att-1.bin" };

function createSavedCopy(
  run: (onProgress?: OfflineSaveProgress) => Promise<OfflineSaveResult> = async () => ({
    status: "saved",
    file: SAVED_FILE,
  }),
) {
  const requests: number[] = [];
  return {
    requests,
    saveCopy: async (onProgress?: OfflineSaveProgress) => {
      requests.push(requests.length);
      return run(onProgress);
    },
    readSaved: async () => SAVED_CONTENT,
  };
}

const ASK_EVERY_TIME = { askWhere: true, folderUri: null };

function createFileSaver(outcome: SaveOutcome = { kind: "handedOff" }) {
  const savedFiles: SaveRequest[] = [];
  return {
    savedFiles,
    save: async (request: SaveRequest) => {
      savedFiles.push(request);
      return outcome;
    },
  };
}

interface StartInput {
  profile: HostProfile;
  activeConnectionId: string | null;
  token?: ReturnType<typeof createTokenRequest>;
  copy?: ReturnType<typeof createSavedCopy>;
  saver?: ReturnType<typeof createFileSaver>;
  fetchFile?: typeof fetch;
}

async function startDownload(input: StartInput): Promise<Download | undefined> {
  const token = input.token ?? createTokenRequest();
  const copy = input.copy ?? createSavedCopy();
  const saver = input.saver ?? createFileSaver();
  await useDownloadStore.getState().startDownload({
    serverId: "srv_remote",
    scopeId: "workspace-1",
    fileName: FILE_NAME,
    path: FILE_PATH,
    daemonProfile: input.profile,
    activeConnectionId: input.activeConnectionId,
    requestFileDownloadToken: token.request,
    saveCopy: copy.saveCopy,
    readSaved: copy.readSaved,
    destination: ASK_EVERY_TIME,
    saveFile: saver.save,
    fetchFile: input.fetchFile ?? (async () => new Response(FILE_BYTES)),
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
}

describe("download store transport selection", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  it("downloads over the session when the active connection is the relay", async () => {
    const token = createTokenRequest();
    const copy = createSavedCopy();
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      copy,
      saver,
    });

    expect(download).toMatchObject({ fileName: FILE_NAME, status: "complete" });
    expect(token.requested).toEqual([FILE_PATH]);
    // One transfer into Saved; the download is delivered from that copy, not read twice.
    expect(copy.requests).toHaveLength(1);
    expect(saver.savedFiles).toEqual([
      {
        content: SAVED_CONTENT,
        fileName: FILE_NAME,
        mimeType: MIME_TYPE,
        preferences: ASK_EVERY_TIME,
      },
    ]);
  });

  it("ignores a directTcp entry that is not the active connection", async () => {
    const copy = createSavedCopy();
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([staleTcpConnection, relayConnection]),
      activeConnectionId: relayConnection.id,
      copy,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(copy.requests).toHaveLength(1);
    expect(saver.savedFiles).toHaveLength(1);
  });

  it("keeps the HTTP token download when the active connection is directTcp", async () => {
    const copy = createSavedCopy();
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([localTcpConnection, relayConnection]),
      activeConnectionId: localTcpConnection.id,
      copy,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    // The HTTP route hands the fetched file to the same saver, as a Blob.
    expect(saver.savedFiles).toHaveLength(1);
    expect(saver.savedFiles[0]?.content).toBeInstanceOf(Blob);
    // The file also goes to Saved, in the background.
    expect(copy.requests).toHaveLength(1);
  });

  it("fails with the HTTP status when a proxy in front of the host rejects the download", async () => {
    const requests: Array<RequestInit | undefined> = [];
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async (_url, init) => {
        requests.push(init);
        return new Response("<h1>401 Authorization Required</h1>", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Paseo"' },
        });
      },
    });

    expect(download).toMatchObject({
      status: "error",
      message: i18n.t("downloads.httpFailed", { status: 401 }),
    });
    expect(requests).toEqual([{ credentials: "include", redirect: "error" }]);
  });

  it("fails with a readable message when the download request cannot reach the host", async () => {
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    expect(download).toMatchObject({ status: "error", message: i18n.t("downloads.failed") });
  });

  it("fails with a readable message when the connection drops while the file is downloading", async () => {
    const saver = createFileSaver();
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.error(new TypeError("network error")),
          }),
        ),
      saver,
    });

    expect(download).toMatchObject({ status: "error", message: i18n.t("downloads.failed") });
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails the download and saves nothing when the session copy fails", async () => {
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      copy: createSavedCopy(async () => ({ status: "failed", error: "Connection lost" })),
      saver,
    });

    expect(download).toMatchObject({ status: "error", message: "Connection lost" });
    expect(saver.savedFiles).toEqual([]);
  });

  it("names the limit when the file is too big to keep", async () => {
    const saver = createFileSaver();
    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      copy: createSavedCopy(async () => ({ status: "tooLarge", maxFileMb: 500 })),
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: i18n.t("composer.errors.fileTooLarge", { fileName: FILE_NAME, size: "500 MB" }),
    });
    expect(saver.savedFiles).toEqual([]);
  });

  it("shows progress while a session copy arrives", async () => {
    const seen: Array<Download["progress"]> = [];
    const copy = createSavedCopy(async (onProgress) => {
      onProgress?.(250, 1000);
      const { activeDownloadId, downloads } = useDownloadStore.getState();
      seen.push(activeDownloadId ? downloads.get(activeDownloadId)?.progress : undefined);
      return { status: "saved", file: SAVED_FILE };
    });

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      copy,
    });

    expect(seen[0]).toMatchObject({ percent: 0.25, bytesWritten: 250, totalBytes: 1000 });
    expect(download).toMatchObject({ status: "complete" });
  });

  it("reports where the file went and how to show it", async () => {
    const saver = createFileSaver({
      kind: "saved",
      where: "Downloads \u203a Paseo",
      revealPath: "/home/me/Downloads/Paseo/report.pdf",
    });

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      saver,
    });

    expect(download).toMatchObject({
      status: "complete",
      savedTo: "Downloads \u203a Paseo",
      revealPath: "/home/me/Downloads/Paseo/report.pdf",
    });
  });

  it("drops the download when the owner cancels the Save dialog", async () => {
    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      saver: createFileSaver({ kind: "cancelled" }),
    });

    expect(download).toBeUndefined();
    expect(useDownloadStore.getState().downloads.size).toBe(0);
  });
});
