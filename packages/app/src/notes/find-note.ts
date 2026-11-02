import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { Note } from "./model";
import { useNotesStore } from "./store";

// A notification tap may launch the app cold; give the host this long to connect.
const HOST_CONNECT_TIMEOUT_MS = 10_000;

function onlineClient(serverId: string): DaemonClient | null {
  const snapshot = getHostRuntimeStore().getSnapshot(serverId);
  return snapshot?.connectionStatus === "online" ? (snapshot.client ?? null) : null;
}

function waitForOnlineClient(serverId: string): Promise<DaemonClient | null> {
  const ready = onlineClient(serverId);
  if (ready) return Promise.resolve(ready);
  let resolveClient: (client: DaemonClient | null) => void = () => {};
  const result = new Promise<DaemonClient | null>((resolve) => {
    resolveClient = resolve;
  });
  let unsubscribe = () => {};
  const timer = setTimeout(() => {
    unsubscribe();
    resolveClient(null);
  }, HOST_CONNECT_TIMEOUT_MS);
  unsubscribe = getHostRuntimeStore().subscribe(serverId, () => {
    const client = onlineClient(serverId);
    if (!client) return;
    clearTimeout(timer);
    unsubscribe();
    resolveClient(client);
  });
  return result;
}

/**
 * The note a notification names: from the live notes snapshot when a screen already holds it,
 * otherwise fetched once from its host. Null when the note is gone or the host stays unreachable.
 */
export async function findNote(serverId: string, noteId: string): Promise<Note | null> {
  const cached = useNotesStore.getState().hosts[serverId]?.notes.find((note) => note.id === noteId);
  if (cached) return cached;
  const client = await waitForOnlineClient(serverId);
  if (!client) return null;
  const notes = await client.listNotes();
  return notes.find((note) => note.id === noteId) ?? null;
}
