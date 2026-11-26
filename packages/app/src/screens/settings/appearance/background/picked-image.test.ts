/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import { MAX_SKIN_BYTES } from "@/skins/image-limits";
import { resolvePickedSkinOriginal } from "./picked-image";

const PICKED_PATH = "/Users/test/Pictures/harbor.png";
const MANAGED_DIR = "/Users/test/.paseo/desktop-attachments";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface DesktopFiles {
  byteSize: number;
  commands: { command: string; args: Record<string, unknown> | undefined }[];
}

// The Electron main process only reads files it copied into managed storage
// (`packages/desktop/src/features/attachments.ts`); this fake keeps that rule.
function installDesktopHost(byteSize: number): DesktopFiles {
  const files: DesktopFiles = { byteSize, commands: [] };
  const managed = new Map<string, string>();
  const host: DesktopHostBridge = {
    invoke: async (command, args) => {
      files.commands.push({ command, args });
      switch (command) {
        case "copy_attachment_file": {
          if (args?.sourcePath !== PICKED_PATH) throw new Error("ENOENT");
          const path = `${MANAGED_DIR}/${String(args.attachmentId)}${String(args.extension)}`;
          managed.set(path, PNG_BASE64);
          return { path, byteSize: files.byteSize };
        }
        case "read_file_base64": {
          const base64 = managed.get(String(args?.path));
          if (base64 === undefined) {
            throw new Error("Attachment path must stay within desktop-managed storage.");
          }
          return base64;
        }
        case "delete_attachment_file":
          managed.delete(String(args?.path));
          return true;
        default:
          throw new Error(`Unexpected desktop command ${command}`);
      }
    },
  };
  window.paseoDesktop = host;
  return files;
}

function commandsNamed(files: DesktopFiles, name: string) {
  return files.commands.filter((entry) => entry.command === name);
}

describe("resolvePickedSkinOriginal on the desktop app", () => {
  const fetchSpy = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
    delete window.paseoDesktop;
  });

  it("reads a path from the desktop open dialog through the desktop bridge", async () => {
    const files = installDesktopHost(68);

    const { original } = await resolvePickedSkinOriginal({
      source: { kind: "file_uri", uri: PICKED_PATH },
      mimeType: "image/png",
      fileName: "harbor.png",
    });

    expect(original).toEqual({ kind: "base64", base64: PNG_BASE64, mimeType: "image/png" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [copy] = commandsNamed(files, "copy_attachment_file");
    const [deletion] = commandsNamed(files, "delete_attachment_file");
    expect(deletion?.args?.path).toMatch(new RegExp(`^${MANAGED_DIR}/`));
    expect(copy?.args?.sourcePath).toBe(PICKED_PATH);
  });

  it("rejects an image over the skin size limit without reading it into the renderer", async () => {
    const files = installDesktopHost(MAX_SKIN_BYTES + 1);

    await expect(
      resolvePickedSkinOriginal({
        source: { kind: "file_uri", uri: PICKED_PATH },
        mimeType: "image/png",
        fileName: "harbor.png",
      }),
    ).rejects.toThrow("Image is larger than 16 MiB");

    expect(commandsNamed(files, "read_file_base64")).toEqual([]);
    expect(commandsNamed(files, "delete_attachment_file")).toHaveLength(1);
  });
});
