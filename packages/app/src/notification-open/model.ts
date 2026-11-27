import type { Note } from "@/notes/model";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginNotificationOpenTarget } from "@getpaseo/protocol/messages";
import { buildHostRootRoute } from "@/utils/host-routes";
import type { NotificationOpenSource, NotificationTap } from "./source";

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";

/** Where a tap opens when it names no note, or when its note cannot be opened. */
export type NotificationPlaceTarget =
  | { kind: "agent"; serverId: string; agentId: string }
  | { kind: "terminal"; serverId: string; workspaceId: string; terminalId: string }
  | {
      kind: "plugin";
      serverId: string;
      pluginId: string;
      notificationId: string;
      open?: PluginNotificationOpenTarget;
      data?: Record<string, JsonValue>;
    }
  | { kind: "host"; serverId: string };

export type NotificationOpenTarget =
  | NotificationPlaceTarget
  | { kind: "note"; serverId: string; noteId: string; fallback: NotificationPlaceTarget }
  /** A file another device sent to this one: opens from Saved once it is kept there. */
  | { kind: "file"; serverId: string; path: string };

function readId(data: object, key: string): string {
  const value: unknown = Reflect.get(data, key);
  return typeof value === "string" ? value.trim() : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePluginOpenTarget(raw: unknown): PluginNotificationOpenTarget | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const type = readId(raw, "type");
  if (type === "agent") {
    const agentId = readId(raw, "agentId");
    return agentId ? { type: "agent", agentId } : undefined;
  }
  if (type === "workspace") {
    const workspaceId = readId(raw, "workspaceId");
    return workspaceId ? { type: "workspace", workspaceId } : undefined;
  }
  if (type === "screen") {
    const screenId = readId(raw, "screenId");
    if (!screenId) return undefined;
    const rawParams = Reflect.get(raw, "params");
    if (rawParams === undefined) {
      return { type: "screen", screenId };
    }
    if (!isPlainRecord(rawParams)) return undefined;
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawParams)) {
      if (!key.trim() || typeof value !== "string") return undefined;
      params[key] = value;
    }
    return { type: "screen", screenId, params };
  }
  return undefined;
}

function parsePlaceTarget(data: object, serverId: string): NotificationPlaceTarget | null {
  if (readId(data, "kind") === "plugin") {
    const pluginId = readId(data, "pluginId");
    const notificationId = readId(data, "notificationId");
    if (!pluginId || !notificationId) return null;
    const open = parsePluginOpenTarget(Reflect.get(data, "open"));
    const rawData = Reflect.get(data, "data");
    const payloadData = isPlainRecord(rawData) ? (rawData as Record<string, JsonValue>) : undefined;
    return {
      kind: "plugin",
      serverId,
      pluginId,
      notificationId,
      ...(open ? { open } : {}),
      ...(payloadData ? { data: payloadData } : {}),
    };
  }
  const workspaceId = readId(data, "workspaceId");
  const terminalId = readId(data, "terminalId");
  if (workspaceId && terminalId) return { kind: "terminal", serverId, workspaceId, terminalId };
  const agentId = readId(data, "agentId");
  if (agentId) return { kind: "agent", serverId, agentId };
  return { kind: "host", serverId };
}

export function parseNotificationOpenTarget(data: unknown): NotificationOpenTarget | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const serverId = readId(data, "serverId");
  if (!serverId) return null;
  const sentFilePath = readId(data, "sentFilePath");
  if (sentFilePath) return { kind: "file", serverId, path: sentFilePath };
  const fallback = parsePlaceTarget(data, serverId);
  if (!fallback) return null;
  const noteId = readId(data, "noteId");
  if (noteId) return { kind: "note", serverId, noteId, fallback };
  return fallback;
}

interface NotificationOpenRouterDeps {
  source: NotificationOpenSource;
  openAgent: (target: { serverId: string; agentId: string }) => void;
  openRoute: (route: string) => void;
  openTerminal: (target: Extract<NotificationOpenTarget, { kind: "terminal" }>) => void;
  /** Find the note a tap names; null when it is gone or its host cannot be reached. */
  resolveNote: (target: { serverId: string; noteId: string }) => Promise<Note | null>;
  /** Open the note's highlighted spot; false when it cannot be opened. */
  openNote: (serverId: string, note: Note) => boolean;
  /** Keep a sent file in Saved and open it; the caller reports any failure to the user. */
  openSentFile: (target: { serverId: string; path: string }) => Promise<void>;
  openPlugin?: (
    target: Extract<NotificationOpenTarget, { kind: "plugin" }>,
  ) => void | Promise<void>;
  whenReadyToNavigate: () => Promise<void>;
}

export function createNotificationOpenRouter(deps: NotificationOpenRouterDeps) {
  const handledIds = new Set<string>();
  let launchTaken = false;
  function openPlace(target: NotificationPlaceTarget): void | Promise<void> {
    if (target.kind === "agent") {
      deps.openAgent({ serverId: target.serverId, agentId: target.agentId });
    } else if (target.kind === "terminal") {
      deps.openTerminal(target);
    } else if (target.kind === "plugin" && deps.openPlugin) {
      return deps.openPlugin(target);
    } else {
      deps.openRoute(buildHostRootRoute(target.serverId));
    }
  }
  async function openNoteTarget(target: Extract<NotificationOpenTarget, { kind: "note" }>) {
    const note = await deps
      .resolveNote({ serverId: target.serverId, noteId: target.noteId })
      .catch(() => null);
    if (note && deps.openNote(target.serverId, note)) return;
    await openPlace(target.fallback);
  }
  async function receive(tap: NotificationTap) {
    if (handledIds.has(tap.id)) return;
    handledIds.add(tap.id);
    await deps.whenReadyToNavigate();
    const target = parseNotificationOpenTarget(tap.data);
    if (target?.kind === "note") {
      await openNoteTarget(target);
    } else if (target?.kind === "file") {
      await deps.openSentFile({ serverId: target.serverId, path: target.path }).catch(() => {});
    } else if (target) {
      const opened = openPlace(target);
      if (opened) await opened;
    }
    deps.source.acknowledge(tap);
  }
  return {
    start() {
      const unsubscribe = deps.source.subscribe((tap) => {
        void receive(tap);
      });
      if (!launchTaken) {
        launchTaken = true;
        void deps.source.takeLaunchTap().then((tap) => {
          return tap ? receive(tap) : undefined;
        });
      }
      return unsubscribe;
    },
  };
}
