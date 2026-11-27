import { z } from "zod";

// Send a file on this host to one of the user's devices. The device is told where the file is
// (host + path); the bytes travel when the device opens it, never in a push. Gate every request
// on `server_info.features.sendToDevice`.

/**
 * A device that can be sent to. `deviceId` is the client id the app says hello with.
 * `kind` is `phone`, `desktop` or `web`; it is open so a later kind does not break old apps.
 */
export const FileDeviceSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  kind: z.string(),
  // A phone is reachable by push, a desktop or web app only while it is connected.
  reachable: z.boolean(),
  lastSeenAt: z.string(),
});

/** An app tells the host what to call its device, and where a push for it goes. */
export const FileDevicesRegisterRequestSchema = z.object({
  type: z.literal("files.devices.register.request"),
  requestId: z.string(),
  name: z.string(),
  kind: z.string(),
  pushToken: z.string().optional(),
});

export const FileDevicesListRequestSchema = z.object({
  type: z.literal("files.devices.list.request"),
  requestId: z.string(),
});

export const FileSendToDeviceRequestSchema = z.object({
  type: z.literal("files.send_to_device.request"),
  requestId: z.string(),
  deviceId: z.string(),
  // Absolute on this host.
  path: z.string(),
});

export const FileDevicesRegisterResponseSchema = z.object({
  type: z.literal("files.devices.register.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const FileDevicesListResponseSchema = z.object({
  type: z.literal("files.devices.list.response"),
  payload: z.object({
    requestId: z.string(),
    devices: z.array(FileDeviceSchema),
    error: z.string().nullable(),
  }),
});

export const FileSendToDeviceResponseSchema = z.object({
  type: z.literal("files.send_to_device.response"),
  payload: z.object({
    requestId: z.string(),
    deviceName: z.string().nullable(),
    // `push` reached the device's push service; `live` reached the app over its connection.
    delivery: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

/**
 * A file was sent to this device. Sent to sources subscribed to the `files.sent` event whose
 * client id is the target. It carries what the push carries, so the app shows the same note
 * and one tap handler opens both.
 */
export const FilesSentMessageSchema = z.object({
  type: z.literal("files.sent"),
  payload: z.object({
    serverId: z.string(),
    path: z.string(),
    fileName: z.string(),
    title: z.string(),
    body: z.string(),
  }),
});
