import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { RunPlace } from "./target";

export interface RunWorkspaceRequest {
  source: { kind: "directory"; path: string };
  background: true;
}

export interface RunWorkspaceResult {
  workspace: WorkspaceDescriptorPayload | null;
  error?: string | null;
}

/** The part of the session client that opens a workspace; `DaemonClient` satisfies it. */
export interface RunWorkspaceClient {
  createWorkspace(input: RunWorkspaceRequest): Promise<RunWorkspaceResult>;
}

/** The host refused or failed to open the run's workspace. The run never moves elsewhere. */
export class RunWorkspaceError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RunWorkspaceError";
  }
}

/** Taps racing for one folder on one host share a single workspace. */
const opening = new Map<string, Promise<string>>();

/**
 * The workspace a run's terminal joins. A terminal must belong to a workspace, so a `host=` run
 * in a folder no open workspace holds first opens a hidden (background) one there: it gets no
 * sidebar row, and the app reuses it for later runs once `onCreated` has stored it.
 */
export function resolveRunWorkspace(input: {
  client: RunWorkspaceClient;
  place: RunPlace;
  onCreated: (workspace: WorkspaceDescriptorPayload) => void;
}): Promise<string> {
  const { client, place, onCreated } = input;
  if (place.workspaceId !== null) return Promise.resolve(place.workspaceId);
  const key = `${place.serverId}\u0000${place.cwd}`;
  const pending = opening.get(key);
  if (pending) return pending;
  const created = openHiddenWorkspace(client, place.cwd, onCreated).finally(() =>
    opening.delete(key),
  );
  opening.set(key, created);
  return created;
}

async function openHiddenWorkspace(
  client: RunWorkspaceClient,
  folder: string,
  onCreated: (workspace: WorkspaceDescriptorPayload) => void,
): Promise<string> {
  let workspace: WorkspaceDescriptorPayload | null;
  let error: string | null | undefined;
  try {
    ({ workspace, error } = await client.createWorkspace({
      source: { kind: "directory", path: folder },
      background: true,
    }));
  } catch (thrown) {
    throw new RunWorkspaceError(thrown instanceof Error ? thrown.message : String(thrown));
  }
  if (!workspace) throw new RunWorkspaceError(error ?? "Workspace was not created");
  onCreated(workspace);
  return workspace.id;
}
