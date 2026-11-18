import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { FILE_EXPLORER_STREAM_CHUNK_BYTES } from "../file-explorer/service.js";
import type { FileCopies } from "./service.js";
import { copyUploadDir, FILE_COPY_UPLOAD_NAME } from "./uploads.js";

export interface FileCopiesSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  emitBinary(frame: Uint8Array, source?: object): Promise<void>;
  hasBinaryChannel(): boolean;
  /** The daemon on the far end of a routed connected-host link, or null for a direct client. */
  producerServerId(): string | null;
}

type FileCopiesRequest = Extract<SessionInboundMessage, { type: `files.copies.${string}` }>;

/** The `files.copies.*` requests of one client session. */
export class FileCopiesSession {
  constructor(
    private readonly host: FileCopiesSessionHost,
    private readonly fileCopies: FileCopies,
    private readonly paseoHome: string,
    private readonly logger: pino.Logger,
  ) {}

  dispatch(msg: SessionInboundMessage, source?: object): Promise<void> | undefined {
    if (!msg.type.startsWith("files.copies.")) return undefined;
    return this.handle(msg as FileCopiesRequest, source);
  }

  private async handle(request: FileCopiesRequest, source?: object): Promise<void> {
    try {
      this.host.emit(await this.respond(request, source), source);
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger.warn({ err: error, requestType: request.type }, "File copy request failed");
      this.host.emit(failure(request, message), source);
    }
  }

  private async respond(
    request: FileCopiesRequest,
    source?: object,
  ): Promise<SessionOutboundMessage> {
    const { requestId } = request;
    const store = this.fileCopies.store;
    switch (request.type) {
      case "files.copies.record_mentions.request": {
        const needed = await store.recordMentions(
          this.requireProducer(),
          request.sourceHome,
          request.files,
        );
        return {
          type: "files.copies.record_mentions.response",
          payload: { requestId, needed, error: null },
        };
      }
      case "files.copies.put.request": {
        const sourceServerId = this.requireProducer();
        const uploadDir = copyUploadDir(this.paseoHome, request.uploadId);
        // Only a copy upload may be taken; another feature's upload is left alone.
        const names = await fs.readdir(uploadDir).catch(() => null);
        if (names?.length !== 1 || names[0] !== FILE_COPY_UPLOAD_NAME) {
          throw new Error("Unknown upload");
        }
        try {
          const entry = await store.put({
            sourceServerId,
            sourceHome: request.sourceHome,
            path: request.path,
            size: request.size,
            mimeType: request.mimeType,
            modifiedAt: request.modifiedAt,
            revision: request.revision,
            file: path.join(uploadDir, FILE_COPY_UPLOAD_NAME),
          });
          return { type: "files.copies.put.response", payload: { requestId, entry, error: null } };
        } finally {
          await fs.rm(uploadDir, { recursive: true, force: true });
        }
      }
      case "files.copies.read.request": {
        const found = store.resolve(request.sourceServerId, request.path);
        if (!found) throw new Error(`No copy of ${request.path} is kept on this host`);
        if (!this.host.hasBinaryChannel()) {
          throw new Error("This connection cannot receive file bytes");
        }
        await this.streamCopy(requestId, found.entry, found.blobPath, source);
        return {
          type: "files.copies.read.response",
          payload: { requestId, entry: found.entry, error: null },
        };
      }
      case "files.copies.list.request":
        return {
          type: "files.copies.list.response",
          payload: {
            requestId,
            entries: store.list({
              sourceServerId: request.sourceServerId,
              query: request.query,
              limit: request.limit,
            }),
            usage: store.usage(),
            error: null,
          },
        };
      case "files.copies.remove.request": {
        const removed = await store.remove(request.sourceServerId, request.path);
        return {
          type: "files.copies.remove.response",
          payload: { requestId, removed, error: null },
        };
      }
      case "files.copies.get_settings.request":
        return {
          type: "files.copies.get_settings.response",
          payload: {
            requestId,
            settings: await this.fileCopies.readSettings(),
            usage: store.usage(),
            error: null,
          },
        };
      case "files.copies.update_settings.request": {
        const { type: _type, requestId: _requestId, ...patch } = request;
        return {
          type: "files.copies.update_settings.response",
          payload: {
            requestId,
            settings: await this.fileCopies.updateSettings(patch),
            usage: store.usage(),
            error: null,
          },
        };
      }
    }
  }

  private requireProducer(): string {
    const producer = this.host.producerServerId();
    if (!producer) throw new Error("Only a connected host can store file copies");
    return producer;
  }

  private async streamCopy(
    requestId: string,
    entry: { size: number; mimeType: string; modifiedAt: string; revision: string },
    blobPath: string,
    source?: object,
  ): Promise<void> {
    const handle = await fs.open(blobPath, "r");
    try {
      const encoding =
        entry.mimeType.startsWith("text/") || entry.mimeType === "application/json"
          ? "utf-8"
          : "binary";
      await this.host.emitBinary(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileBegin,
          requestId,
          metadata: {
            mime: entry.mimeType,
            size: entry.size,
            encoding,
            modifiedAt: entry.modifiedAt,
            revision: entry.revision,
          },
        }),
        source,
      );
      let position = 0;
      while (position < entry.size) {
        const chunk = Buffer.allocUnsafe(
          Math.min(FILE_EXPLORER_STREAM_CHUNK_BYTES, entry.size - position),
        );
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
        if (bytesRead === 0) throw new Error("File copy is shorter than recorded");
        position += bytesRead;
        await this.host.emitBinary(
          encodeFileTransferFrame({
            opcode: FileTransferOpcode.FileChunk,
            requestId,
            payload: chunk.subarray(0, bytesRead),
          }),
          source,
        );
      }
      await this.host.emitBinary(
        encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
        source,
      );
    } finally {
      await handle.close();
    }
  }
}

function failure(request: FileCopiesRequest, error: string): SessionOutboundMessage {
  const requestId = request.requestId;
  switch (request.type) {
    case "files.copies.record_mentions.request":
      return {
        type: "files.copies.record_mentions.response",
        payload: { requestId, needed: [], error },
      };
    case "files.copies.put.request":
      return { type: "files.copies.put.response", payload: { requestId, entry: null, error } };
    case "files.copies.read.request":
      return { type: "files.copies.read.response", payload: { requestId, entry: null, error } };
    case "files.copies.list.request":
      return {
        type: "files.copies.list.response",
        payload: { requestId, entries: [], usage: null, error },
      };
    case "files.copies.remove.request":
      return {
        type: "files.copies.remove.response",
        payload: { requestId, removed: false, error },
      };
    case "files.copies.get_settings.request":
      return {
        type: "files.copies.get_settings.response",
        payload: { requestId, settings: null, usage: null, error },
      };
    case "files.copies.update_settings.request":
      return {
        type: "files.copies.update_settings.response",
        payload: { requestId, settings: null, usage: null, error },
      };
  }
}
