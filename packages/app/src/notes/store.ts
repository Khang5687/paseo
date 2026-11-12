import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type {
  CreateNoteOptions,
  DaemonClient,
  EditNoteOptions,
} from "@getpaseo/client/internal/daemon-client";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import {
  applyNoteChange,
  mergeHostNotes,
  notesForAgent,
  notesForTerminal,
  type HostNote,
  type Note,
} from "./model";

export interface NotesHostSnapshot {
  serverId: string;
  /** `unsupported`: the host predates notes; hide notes UI for it. */
  status: "loading" | "online" | "offline" | "unsupported";
  notes: Note[];
  error: string | null;
}

interface NotesState {
  hosts: Record<string, NotesHostSnapshot>;
  setHost: (host: NotesHostSnapshot) => void;
  updateNotes: (serverId: string, update: (notes: Note[]) => Note[]) => void;
}

export const useNotesStore = create<NotesState>((set) => ({
  hosts: {},
  setHost: (host) => set((state) => ({ hosts: { ...state.hosts, [host.serverId]: host } })),
  updateNotes: (serverId, update) =>
    set((state) => {
      const host = state.hosts[serverId];
      if (!host) return state;
      return { hosts: { ...state.hosts, [serverId]: { ...host, notes: update(host.notes) } } };
    }),
}));

interface HostConnection {
  client: DaemonClient;
  release: () => void;
}

function hostSupportsNotes(serverId: string): boolean {
  return useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.notes === true;
}

/**
 * Keeps one `notes.list` subscription per host while any screen shows that host's notes.
 * Nothing is fetched for a host nobody is looking at; the daemon pushes changes, so there is no
 * polling. The last snapshot stays in the store after release so a revisit renders immediately.
 */
class NotesController {
  private readonly demand = new Map<string, number>();
  private readonly connections = new Map<string, HostConnection>();

  acquire(serverId: string): () => void {
    this.demand.set(serverId, (this.demand.get(serverId) ?? 0) + 1);
    this.sync(serverId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.demand.get(serverId) ?? 1) - 1;
      if (count <= 0) this.demand.delete(serverId);
      else this.demand.set(serverId, count);
      this.sync(serverId);
    };
  }

  /** Re-evaluate after demand, connection, client, or feature changes. */
  sync(serverId: string): void {
    const wanted = (this.demand.get(serverId) ?? 0) > 0;
    const snapshot = getHostRuntimeStore().getSnapshot(serverId);
    const client = snapshot?.client ?? null;
    const online = snapshot?.connectionStatus === "online" && client !== null;
    const existing = this.connections.get(serverId);

    if (!wanted || !online) {
      if (existing) this.disconnect(serverId);
      if (wanted && !online) this.publishStatus(serverId, "offline", null);
      return;
    }
    if (!hostSupportsNotes(serverId)) {
      if (existing) this.disconnect(serverId);
      this.publishStatus(serverId, "unsupported", null);
      return;
    }
    if (existing?.client === client) return;
    if (existing) this.disconnect(serverId);
    this.connect(serverId, client);
  }

  async create(serverId: string, input: CreateNoteOptions): Promise<Note> {
    const note = await this.requireClient(serverId).createNote(input);
    this.apply(serverId, note);
    return note;
  }

  async edit(serverId: string, input: EditNoteOptions): Promise<Note> {
    const note = await this.requireClient(serverId).editNote(input);
    this.apply(serverId, note);
    return note;
  }

  async delete(serverId: string, noteId: string): Promise<void> {
    await this.requireClient(serverId).deleteNote(noteId);
    useNotesStore
      .getState()
      .updateNotes(serverId, (notes) => applyNoteChange(notes, { kind: "remove", noteId }));
  }

  private connect(serverId: string, client: DaemonClient): void {
    const current = useNotesStore.getState().hosts[serverId];
    if (!current || current.status !== "online") this.publishStatus(serverId, "loading", null);
    const subscription = client.observeNotes();
    this.connections.set(serverId, {
      client,
      release: () => {
        void subscription.release().catch(() => undefined);
      },
    });
    const isCurrent = () => this.connections.get(serverId)?.client === client;
    subscription.subscribe({
      snapshot: (payload) => {
        if (!isCurrent()) return;
        useNotesStore.getState().setHost({
          serverId,
          status: "online",
          notes: payload.notes,
          error: null,
        });
      },
      update: (message) => {
        if (!isCurrent() || message.type !== "notes.changed") return;
        const change = message.payload;
        useNotesStore
          .getState()
          .updateNotes(serverId, (notes) =>
            applyNoteChange(
              notes,
              change.kind === "upsert"
                ? { kind: "upsert", note: change.note }
                : { kind: "remove", noteId: change.noteId },
            ),
          );
      },
      error: (error) => {
        if (!isCurrent()) return;
        this.publishStatus(serverId, "online", toErrorMessage(error));
      },
    });
  }

  private disconnect(serverId: string): void {
    this.connections.get(serverId)?.release();
    this.connections.delete(serverId);
  }

  private apply(serverId: string, note: Note): void {
    useNotesStore
      .getState()
      .updateNotes(serverId, (notes) => applyNoteChange(notes, { kind: "upsert", note }));
  }

  private requireClient(serverId: string): DaemonClient {
    const snapshot = getHostRuntimeStore().getSnapshot(serverId);
    if (!snapshot?.client || snapshot.connectionStatus !== "online") {
      throw new Error("Host is offline");
    }
    if (!hostSupportsNotes(serverId)) throw new Error("Update this host to use notes");
    return snapshot.client;
  }

  private publishStatus(
    serverId: string,
    status: NotesHostSnapshot["status"],
    error: string | null,
  ): void {
    const current = useNotesStore.getState().hosts[serverId];
    if (current?.status === status && current.error === error) return;
    useNotesStore.getState().setHost({ serverId, status, notes: current?.notes ?? [], error });
  }
}

export const notesController = new NotesController();

export function createNote(serverId: string, input: CreateNoteOptions): Promise<Note> {
  return notesController.create(serverId, input);
}

export function editNote(serverId: string, input: EditNoteOptions): Promise<Note> {
  return notesController.edit(serverId, input);
}

export function deleteNote(serverId: string, noteId: string): Promise<void> {
  return notesController.delete(serverId, noteId);
}

/** Subscribe to the notes of these hosts while the calling component is mounted. */
export function useNotesDemand(serverIds: readonly string[]): void {
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const features = useHostFeatureMap(serverIds, "notes");
  const key = serverIds.join("|");
  const stateKey = serverIds
    .map((serverId) => `${statuses.get(serverId)}:${features.get(serverId) ? 1 : 0}`)
    .join("|");

  useEffect(() => {
    if (!key) return;
    const releases = key.split("|").map((serverId) => notesController.acquire(serverId));
    return () => {
      for (const release of releases) release();
    };
  }, [key]);

  useEffect(() => {
    if (!key) return;
    for (const serverId of key.split("|")) notesController.sync(serverId);
  }, [key, stateKey]);
}

const EMPTY_NOTES: Note[] = [];

/** True when the host advertises notes. Gate every notes entry point on this. */
export function useHostSupportsNotes(serverId: string | null | undefined): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.notes === true,
  );
}

export function useHostNotes(serverId: string): Note[] {
  const serverIds = useMemo(() => (serverId ? [serverId] : []), [serverId]);
  useNotesDemand(serverIds);
  return useNotesStore((state) => state.hosts[serverId]?.notes ?? EMPTY_NOTES);
}

/** Notes made on this agent's chat, for highlights. */
export function useAgentNotes(serverId: string, agentId: string): Note[] {
  const notes = useHostNotes(serverId);
  return useMemo(() => notesForAgent(notes, agentId), [notes, agentId]);
}

/** Notes made on this terminal, for highlights. */
export function useTerminalNotes(serverId: string, terminalId: string): Note[] {
  const notes = useHostNotes(serverId);
  return useMemo(() => notesForTerminal(notes, terminalId), [notes, terminalId]);
}

export interface NotesHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface AllNotesResult {
  /** Every host's notes in one list, blockers on top. */
  notes: HostNote[];
  /** Hosts that are online and support notes but failed to load. */
  hostErrors: NotesHostError[];
  /** Hosts that are online but predate notes. */
  unsupportedHosts: { serverId: string; serverName: string }[];
  /** True until every online, supported host returned its first list. */
  loading: boolean;
}

/** The cross-host Notes screen's data: subscribes to every host while mounted. */
export function useAllNotes(): AllNotesResult {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  useNotesDemand(serverIds);
  const snapshots = useNotesStore((state) => state.hosts);
  return useMemo(() => {
    const loaded: { serverId: string; serverName: string; notes: Note[] }[] = [];
    const hostErrors: NotesHostError[] = [];
    const unsupportedHosts: { serverId: string; serverName: string }[] = [];
    let loading = false;
    for (const host of hosts) {
      const snapshot = snapshots[host.serverId];
      if (!snapshot) {
        loading = true;
        continue;
      }
      if (snapshot.status === "unsupported") {
        unsupportedHosts.push({ serverId: host.serverId, serverName: host.label });
        continue;
      }
      if (snapshot.status === "loading") loading = true;
      if (snapshot.error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.label,
          message: snapshot.error,
        });
      }
      // Offline hosts keep showing the notes from their last list.
      loaded.push({ serverId: host.serverId, serverName: host.label, notes: snapshot.notes });
    }
    return { notes: mergeHostNotes(loaded), hostErrors, unsupportedHosts, loading };
  }, [hosts, snapshots]);
}
