import type { OfflineSaveResult } from "@/offline-files/saver";

export type ReceiveSentFileOutcome =
  | { status: "saved" }
  | { status: "hostOffline" }
  | { status: "tooLarge"; maxFileMb: number }
  | { status: "failed"; error: string };

export interface ReceiveSentFileDeps {
  /** Resolves true once the host connection is up, false if it is not up in time. */
  waitForHost: (serverId: string) => Promise<boolean>;
  /** Adds the file to Saved, pinned. */
  save: (input: { serverId: string; path: string }) => Promise<OfflineSaveResult>;
  /** Says "<file> saved", with Open and, for an APK on Android, Install. */
  noteSaved: (input: { serverId: string; path: string }) => void;
}

/**
 * What a tap on "<file> is ready" does: keep the file in Saved, then say it is there. The owner
 * opens it from the note or from Saved on this device; the app does not leave the screen they are
 * on. The note can arrive before the app has reconnected to the host, so it waits for the host
 * first.
 */
export async function receiveSentFile(
  input: { serverId: string; path: string },
  deps: ReceiveSentFileDeps,
): Promise<ReceiveSentFileOutcome> {
  if (!(await deps.waitForHost(input.serverId))) return { status: "hostOffline" };
  const result = await deps.save(input);
  if (result.status === "tooLarge") return result;
  if (result.status === "failed") return result;
  deps.noteSaved(input);
  return { status: "saved" };
}
