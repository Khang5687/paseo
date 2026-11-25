import type { OfflineSaveResult } from "@/offline-files/saver";

export type OpenSentFileOutcome =
  | { status: "opened" }
  | { status: "hostOffline" }
  | { status: "tooLarge"; maxFileMb: number }
  | { status: "failed"; error: string };

export interface OpenSentFileDeps {
  /** Resolves true once the host connection is up, false if it is not up in time. */
  waitForHost: (serverId: string) => Promise<boolean>;
  /** Adds the file to Saved, pinned. */
  save: (input: { serverId: string; path: string }) => Promise<OfflineSaveResult>;
  openSaved: (input: { serverId: string; path: string }) => void;
}

/**
 * What a tap on "<file> is ready" does: keep the file in Saved, then open it from the saved copy.
 * The note can arrive before the app has reconnected to the host, so it waits for the host first.
 */
export async function openSentFile(
  input: { serverId: string; path: string },
  deps: OpenSentFileDeps,
): Promise<OpenSentFileOutcome> {
  if (!(await deps.waitForHost(input.serverId))) return { status: "hostOffline" };
  const result = await deps.save(input);
  if (result.status === "tooLarge") return result;
  if (result.status === "failed") return result;
  deps.openSaved(input);
  return { status: "opened" };
}
