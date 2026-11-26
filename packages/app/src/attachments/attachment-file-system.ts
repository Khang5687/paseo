import { File, FileMode } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";

export type AttachmentFileInfo =
  | { exists: true; isDirectory: boolean; size: number | null }
  | { exists: false };

export interface AttachmentFileAppender {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface AttachmentFileSystem {
  readonly cacheDirectory: string | null;
  getInfo(uri: string): Promise<AttachmentFileInfo>;
  makeDirectory(uri: string, options: { intermediates: boolean }): Promise<void>;
  writeBytes(uri: string, bytes: Uint8Array): Promise<void>;
  /** Starts an empty file and returns a handle that appends to it, so a big file is never whole in memory. */
  openAppender(uri: string): Promise<AttachmentFileAppender>;
  copy(input: { from: string; to: string }): Promise<void>;
  readAsBase64(uri: string): Promise<string>;
  delete(uri: string, options: { idempotent: boolean }): Promise<void>;
  listDirectory(uri: string): Promise<string[]>;
}

export function createExpoAttachmentFileSystem(): AttachmentFileSystem {
  return {
    cacheDirectory: FileSystem.cacheDirectory,
    async getInfo(uri) {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) {
        return { exists: false };
      }
      const size =
        typeof (info as { size?: number }).size === "number"
          ? (info as { size: number }).size
          : null;
      return { exists: true, isDirectory: info.isDirectory ?? false, size };
    },
    async makeDirectory(uri, options) {
      await FileSystem.makeDirectoryAsync(uri, options);
    },
    async writeBytes(uri, bytes) {
      new File(uri).write(bytes);
    },
    async openAppender(uri) {
      const file = new File(uri);
      file.create({ overwrite: true });
      const handle = file.open(FileMode.Append);
      return {
        async write(bytes) {
          handle.writeBytes(bytes);
        },
        async close() {
          handle.close();
        },
      };
    },
    async copy(input) {
      await FileSystem.copyAsync(input);
    },
    async readAsBase64(uri) {
      return await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    },
    async delete(uri, options) {
      await FileSystem.deleteAsync(uri, options);
    },
    async listDirectory(uri) {
      return await FileSystem.readDirectoryAsync(uri);
    },
  };
}
