import type { Note } from "@/notes/model";
import { buildHostRootRoute } from "@/utils/host-routes";
import type { NotificationOpenSource, NotificationTap } from "./source";

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";

/** Where a tap opens when it names no note, or when its note cannot be opened. */
export type NotificationPlaceTarget =
  | { kind: "agent"; serverId: string; agentId: string }
  | { kind: "terminal"; serverId: string; workspaceId: string; terminalId: string }
  | { kind: "host"; serverId: string };

export type NotificationOpenTarget =
  | NotificationPlaceTarget
  | { kind: "note"; serverId: string; noteId: string; fallback: NotificationPlaceTarget };

function readId(data: object, key: string): string {
  const value: unknown = Reflect.get(data, key);
  return typeof value === "string" ? value.trim() : "";
}

function parsePlaceTarget(data: object, serverId: string): NotificationPlaceTarget {
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
  const fallback = parsePlaceTarget(data, serverId);
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
  whenReadyToNavigate: () => Promise<void>;
}

export function createNotificationOpenRouter(deps: NotificationOpenRouterDeps) {
  const handledIds = new Set<string>();
  let launchTaken = false;
  function openPlace(target: NotificationPlaceTarget) {
    if (target.kind === "agent") {
      deps.openAgent({ serverId: target.serverId, agentId: target.agentId });
    } else if (target.kind === "terminal") {
      deps.openTerminal(target);
    } else {
      deps.openRoute(buildHostRootRoute(target.serverId));
    }
  }
  async function openNoteTarget(target: Extract<NotificationOpenTarget, { kind: "note" }>) {
    const note = await deps
      .resolveNote({ serverId: target.serverId, noteId: target.noteId })
      .catch(() => null);
    if (note && deps.openNote(target.serverId, note)) return;
    openPlace(target.fallback);
  }
  async function receive(tap: NotificationTap) {
    if (handledIds.has(tap.id)) return;
    handledIds.add(tap.id);
    await deps.whenReadyToNavigate();
    const target = parseNotificationOpenTarget(tap.data);
    if (target?.kind === "note") {
      await openNoteTarget(target);
    } else if (target) {
      openPlace(target);
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
