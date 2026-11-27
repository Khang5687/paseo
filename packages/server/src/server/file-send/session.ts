import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { FileDeviceRegistry } from "./device-registry.js";
import { FileSendError, type FileSendService } from "./service.js";

/** What a session needs to take part in sending: the service, and the registry it keeps current. */
export interface FileSendBundle {
  service: FileSendService;
  registry: FileDeviceRegistry;
}

export interface FileSendSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  /** The client id this connection said hello with: the device's id. */
  clientId(): string;
}

type FileSendRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "files.devices.register.request"
      | "files.devices.list.request"
      | "files.send_to_device.request";
  }
>;

/** The `files.devices.*` and `files.send_to_device.*` requests of one client session. */
export class FileSendSession {
  constructor(
    private readonly host: FileSendSessionHost,
    private readonly service: FileSendService,
    private readonly registry: FileDeviceRegistry,
    private readonly logger: pino.Logger,
  ) {}

  dispatch(msg: SessionInboundMessage, source?: object): Promise<void> | undefined {
    switch (msg.type) {
      case "files.devices.register.request":
      case "files.devices.list.request":
      case "files.send_to_device.request":
        return this.handle(msg, source);
      default:
        return undefined;
    }
  }

  private async handle(request: FileSendRequest, source?: object): Promise<void> {
    const { requestId } = request;
    try {
      switch (request.type) {
        case "files.devices.register.request":
          this.registry.register({
            deviceId: this.host.clientId(),
            name: request.name,
            kind: request.kind,
            pushToken: request.pushToken,
          });
          this.host.emit(
            { type: "files.devices.register.response", payload: { requestId, error: null } },
            source,
          );
          return;
        case "files.devices.list.request":
          this.host.emit(
            {
              type: "files.devices.list.response",
              payload: { requestId, devices: this.service.listDevices(), error: null },
            },
            source,
          );
          return;
        case "files.send_to_device.request": {
          const result = await this.service.send({
            deviceId: request.deviceId,
            path: request.path,
          });
          this.host.emit(
            {
              type: "files.send_to_device.response",
              payload: {
                requestId,
                deviceName: result.deviceName,
                delivery: result.delivery,
                error: null,
              },
            },
            source,
          );
          return;
        }
      }
    } catch (error) {
      if (!(error instanceof FileSendError)) {
        this.logger.warn({ err: error, requestType: request.type }, "File send request failed");
      }
      this.host.emit(failure(request, getErrorMessage(error)), source);
    }
  }
}

function failure(request: FileSendRequest, error: string): SessionOutboundMessage {
  const { requestId } = request;
  switch (request.type) {
    case "files.devices.register.request":
      return { type: "files.devices.register.response", payload: { requestId, error } };
    case "files.devices.list.request":
      return { type: "files.devices.list.response", payload: { requestId, devices: [], error } };
    case "files.send_to_device.request":
      return {
        type: "files.send_to_device.response",
        payload: { requestId, deviceName: null, delivery: null, error },
      };
  }
}
