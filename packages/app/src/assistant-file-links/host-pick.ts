import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";

/** A host the app can ask whether a path names a file there, in the order to try them. */
export interface FileHostCandidate {
  serverId: string;
  label: string;
  /** Null while the host is not connected. */
  client: {
    listDirectory(
      cwd: string,
      path: string,
    ): Promise<{ entries: readonly { name: string; kind: "file" | "directory" }[] }>;
  } | null;
  /** Whether this device keeps a saved copy of the file; asked only while the host is offline. */
  hasSavedCopy(path: string): Promise<boolean>;
}

export interface FileHostMatch {
  serverId: string;
  label: string;
  /** The host is offline and the match is this device's saved copy. */
  savedCopy: boolean;
}

export type FileHostPick =
  | { kind: "chatHost" }
  | { kind: "otherHost"; serverId: string }
  | { kind: "cancelled" };

const PROBE_TIMEOUT_MS = 4000;

/**
 * Asks every host whether `path` names a file there. `path` is absolute or `~`-relative, so each
 * host reads it against its own filesystem and home. A host that errors or is slow counts as not
 * having the file.
 */
export async function findFileHosts(input: {
  path: string;
  hosts: readonly FileHostCandidate[];
  timeoutMs?: number;
}): Promise<FileHostMatch[]> {
  const location = splitParent(input.path);
  if (!location) return [];
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const found = await Promise.all(
    input.hosts.map(async (host): Promise<FileHostMatch | null> => {
      if (!host.client) {
        const saved = await host.hasSavedCopy(input.path).catch(() => false);
        return saved ? { serverId: host.serverId, label: host.label, savedCopy: true } : null;
      }
      const listing = await withTimeout(
        host.client.listDirectory(location.cwd, location.directory),
        timeoutMs,
      ).catch(() => null);
      const isFile = listing?.entries.some(
        (entry) => entry.name === location.name && entry.kind === "file",
      );
      return isFile ? { serverId: host.serverId, label: host.label, savedCopy: false } : null;
    }),
  );
  return found.filter((match): match is FileHostMatch => match !== null);
}

/**
 * Picks the host that opens a file named outside the chat's workspace. One host with the file
 * opens it; several ask `choose`; none leaves it on the chat's host, which shows "not found".
 */
export async function pickFileHost(input: {
  path: string;
  chatServerId: string;
  hosts: readonly FileHostCandidate[];
  choose: (matches: readonly FileHostMatch[]) => Promise<string | null>;
}): Promise<FileHostPick> {
  const matches = await findFileHosts({ path: input.path, hosts: input.hosts });
  const serverId =
    matches.length > 1 ? await input.choose(matches) : (matches[0]?.serverId ?? input.chatServerId);
  if (!serverId) return { kind: "cancelled" };
  return serverId === input.chatServerId ? { kind: "chatHost" } : { kind: "otherHost", serverId };
}

function splitParent(path: string): { cwd: string; directory: string; name: string } | null {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  if (slash < 0 || !name) return null;
  const directory = slash === 0 ? "/" : path.slice(0, slash);
  const target = resolveFilePreviewReadTarget({ path: directory });
  return target ? { cwd: target.cwd, directory: target.path, name } : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
