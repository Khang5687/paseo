import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileReadMeta, FileReadSink } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata, AttachmentWriter } from "@/attachments/types";
import { addSavedFile, autoSaveOfflineFile, PINNED_FILE_MAX_MB } from "./saver";

const MB = 1024 * 1024;

const harness = vi.hoisted(() => ({
  readFileToSink: vi.fn(),
  openAttachmentWriter: vi.fn(),
  saveOfflineAttachment: vi.fn(),
  getOfflineFile: vi.fn(),
}));

vi.mock("react-native", () => ({ AppState: { currentState: "active" } }));
vi.mock("./network", () => ({ isOnUnmeteredNetwork: async () => true }));
vi.mock("@/hooks/use-settings", () => ({
  getAppSettings: async () => ({
    offlineFilesAutoSave: true,
    offlineFilesWifiOnly: false,
    offlineFilesMaxFileMb: 10,
    offlineFilesMaxTotalMb: 2048,
    offlineFilesRetentionDays: 30,
  }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({
      sessions: {
        omen: {
          client: { readFileToSink: harness.readFileToSink },
          serverInfo: { features: {} },
        },
      },
    }),
  },
}));
vi.mock("@/attachments/service", () => ({
  openAttachmentWriter: harness.openAttachmentWriter,
}));
vi.mock("./store", () => ({
  getOfflineFile: harness.getOfflineFile,
  saveOfflineAttachment: harness.saveOfflineAttachment,
  isSameOfflineVersion: () => false,
  touchOfflineFile: async () => {},
}));

const attachment: AttachmentMetadata = {
  id: "att-1",
  mimeType: "video/mp4",
  storageType: "native-file",
  storageKey: "/cache/att-1.mp4",
  byteSize: 300 * MB,
  createdAt: 1,
};

function meta(size: number): FileReadMeta {
  return {
    mime: "video/mp4",
    size,
    path: "clip.mp4",
    kind: "binary",
    modifiedAt: "2026-01-01T00:00:00Z",
  };
}

interface FakeWriter extends AttachmentWriter {
  written: number;
}

function fakeWriter(): FakeWriter {
  const writer: FakeWriter = {
    id: "att-1",
    written: 0,
    write: vi.fn(async (chunk: Uint8Array) => {
      writer.written += chunk.byteLength;
    }),
    finish: vi.fn(async () => attachment),
    abort: vi.fn(async () => {}),
  };
  return writer;
}

/** Plays a host sending `size` bytes in 1 MB chunks through the sink the saver gave the client. */
function hostSends(size: number, options: { failAfter?: number } = {}) {
  harness.readFileToSink.mockImplementation(
    async (
      _cwd: string,
      _path: string,
      sink: FileReadSink,
      read: { onProgress?: (received: number, total: number) => void },
    ) => {
      await sink.begin?.(meta(size));
      const chunk = new Uint8Array(MB);
      for (let sent = 0; sent < size; sent += MB) {
        if (options.failAfter !== undefined && sent >= options.failAfter) {
          throw new Error("Connection lost");
        }
        await sink.write(chunk);
        read.onProgress?.(sent + MB, size);
      }
      return meta(size);
    },
  );
}

describe("saving a file to the device", () => {
  let writer: FakeWriter;

  beforeEach(() => {
    vi.clearAllMocks();
    writer = fakeWriter();
    harness.openAttachmentWriter.mockResolvedValue(writer);
    harness.getOfflineFile.mockResolvedValue({ path: "kept" });
    harness.saveOfflineAttachment.mockImplementation(
      async (input: { serverId: string; path: string; pinned: boolean }) => ({
        ...input,
        attachment,
      }),
    );
  });

  it("keeps a 300 MB file saved on purpose, written as it arrives and never held whole", async () => {
    hostSends(300 * MB);

    const result = await addSavedFile({ serverId: "omen", path: "/home/k/clip.mp4" });

    expect(result.status).toBe("saved");
    expect(writer.written).toBe(300 * MB);
    expect(writer.finish).toHaveBeenCalledOnce();
    expect(harness.saveOfflineAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: true, attachment }),
    );
    // Over the "Largest file" setting (10 MB), under the 500 MB cap for files saved on purpose.
    expect(harness.readFileToSink).toHaveBeenCalledWith(
      "/",
      "/home/k/clip.mp4",
      expect.anything(),
      expect.objectContaining({ maxBytes: PINNED_FILE_MAX_MB * MB, timeout: 0 }),
    );
  });

  it("refuses a file over 500 MB before opening a file on the device", async () => {
    hostSends(501 * MB);

    const result = await addSavedFile({ serverId: "omen", path: "/home/k/clip.mp4" });

    expect(result).toEqual({ status: "tooLarge", maxFileMb: 500 });
    expect(harness.openAttachmentWriter).not.toHaveBeenCalled();
    expect(harness.saveOfflineAttachment).not.toHaveBeenCalled();
  });

  it("keeps the small cap for a file the chat only mentions", async () => {
    hostSends(11 * MB);

    void autoSaveOfflineFile({
      serverId: "omen",
      client: { readFileToSink: harness.readFileToSink } as never,
      canStat: false,
      workspaceRoot: "/home/k",
      mention: "clip.mp4",
      resolvePath: async () => "clip.mp4",
    });
    await vi.waitFor(() => expect(harness.readFileToSink).toHaveBeenCalled());

    expect(harness.readFileToSink).toHaveBeenCalledWith(
      "/home/k",
      "clip.mp4",
      expect.anything(),
      expect.objectContaining({ maxBytes: 10 * MB }),
    );
    expect(harness.openAttachmentWriter).not.toHaveBeenCalled();
  });

  it("throws away the half-written file when the transfer breaks", async () => {
    hostSends(300 * MB, { failAfter: 50 * MB });

    const result = await addSavedFile({ serverId: "omen", path: "/home/k/clip.mp4" });

    expect(result).toEqual({ status: "failed", error: "Connection lost" });
    expect(writer.written).toBe(50 * MB);
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.finish).not.toHaveBeenCalled();
    expect(harness.saveOfflineAttachment).not.toHaveBeenCalled();
  });

  it("shares one transfer, and its progress, between two askers", async () => {
    hostSends(20 * MB);
    const first: number[] = [];
    const second: number[] = [];

    const one = addSavedFile({
      serverId: "omen",
      path: "/home/k/clip.mp4",
      onProgress: (received) => first.push(received),
    });
    const two = addSavedFile({
      serverId: "omen",
      path: "/home/k/clip.mp4",
      onProgress: (received) => second.push(received),
    });
    await Promise.all([one, two]);

    expect(harness.readFileToSink).toHaveBeenCalledTimes(1);
    // The last report always arrives, however fast the chunks came.
    expect(first.at(-1)).toBe(20 * MB);
    expect(second.at(-1)).toBe(20 * MB);
  });
});
