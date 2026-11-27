import type { CodeRunScope } from "./scope";

/** The options after a fence's language: ```` ```bash host=mac cwd=~/src ````. */
export interface FenceRunRequest {
  host: string | null;
  cwd: string | null;
}

export interface FenceInfo {
  language: string | null;
  request: FenceRunRequest;
}

/** `key=value`, `key="value with spaces"` or `key='value'`. */
const INFO_OPTION = /(?:^|\s)([A-Za-z]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;

/**
 * Splits a fence's info string. Parsers hand it over as a first word (`lang`) and the rest
 * (`meta`); an untagged fence with options puts the first option in `lang`.
 */
export function parseFenceInfo(
  language: string | null | undefined,
  meta: string | null | undefined,
): FenceInfo {
  const info = [language, meta].filter(Boolean).join(" ").trim();
  const first = info.split(/\s+/)[0] ?? "";
  const request: FenceRunRequest = { host: null, cwd: null };
  for (const match of info.matchAll(INFO_OPTION)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (value === "") continue;
    const key = match[1].toLowerCase();
    if (key === "host") request.host = value;
    else if (key === "cwd") request.cwd = value;
  }
  return { language: first !== "" && !first.includes("=") ? first : null, request };
}

export function hasRunRequest(request: FenceRunRequest): boolean {
  return request.host !== null || request.cwd !== null;
}

export interface KnownHost {
  serverId: string;
  label: string;
}

function normalizeHostName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

/** A host the app knows, by its label (case and spaces ignored) or its serverId. */
export function matchCodeRunHost<T extends KnownHost>(name: string, hosts: readonly T[]): T | null {
  const wanted = normalizeHostName(name);
  if (wanted === "") return null;
  return (
    hosts.find((host) => normalizeHostName(host.label) === wanted) ??
    hosts.find((host) => host.serverId === name.trim()) ??
    null
  );
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed === "" ? path.slice(0, 1) : trimmed;
}

/** `cwd=` on the host, `~` and relative paths against its home. Null when the home is unknown. */
export function resolveRunFolder(cwd: string | null, homeDirectory: string | null): string | null {
  const path = cwd ?? "~";
  if (isAbsolutePath(path)) return trimTrailingSeparators(path);
  const home = homeDirectory?.trim() ? trimTrailingSeparators(homeDirectory.trim()) : null;
  if (!home) return null;
  if (path === "~") return home;
  const rest = path.startsWith("~/") || path.startsWith("~\\") ? path.slice(2) : path;
  return rest === "" ? home : trimTrailingSeparators(`${home}/${rest}`);
}

export interface RunWorkspace {
  id: string;
  workspaceDirectory: string;
  archivingAt: string | null;
}

function isSameOrInside(root: string, path: string): boolean {
  const base = trimTrailingSeparators(root);
  return path === base || path.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/** A terminal belongs to a workspace; the daemon takes one whose folder holds the run's. */
export function ownerWorkspace(
  folder: string,
  workspaces: Iterable<RunWorkspace>,
): RunWorkspace | null {
  let owner: RunWorkspace | null = null;
  for (const workspace of workspaces) {
    if (workspace.archivingAt !== null) continue;
    if (!isSameOrInside(workspace.workspaceDirectory, folder)) continue;
    if (!owner || workspace.workspaceDirectory.length > owner.workspaceDirectory.length)
      owner = workspace;
  }
  return owner;
}

/** Where a run's terminal opens. */
export interface RunPlace {
  serverId: string;
  cwd: string;
  /** Null when no open workspace on the host holds `cwd`: the run opens a hidden one there first. */
  workspaceId: string | null;
}

export type CodeRunTarget =
  | { kind: "ready"; place: RunPlace }
  | { kind: "unknownHost"; name: string }
  | { kind: "offline"; serverId: string; hostLabel: string }
  /** `cwd=` was relative or absent and the host never reported its home folder. */
  | { kind: "noHome"; serverId: string; hostLabel: string };

/** What the fence's target host looks like to the app right now. */
export interface TargetHostState {
  /** The host `host=` named, or the chat's host when the fence has only `cwd=`. */
  host: KnownHost | null;
  connected: boolean;
  homeDirectory: string | null;
  /** Open workspaces on that host, hidden ones included, so a hidden run workspace is reused. */
  workspaces: Iterable<RunWorkspace>;
}

/**
 * An untagged fence runs where the chat runs. A tagged one runs on the host it names, in
 * `cwd=` or that host's home, and never falls back to the chat's host.
 */
export function resolveCodeRunTarget(
  chatScope: CodeRunScope,
  request: FenceRunRequest,
  state: TargetHostState,
): CodeRunTarget {
  if (!hasRunRequest(request))
    return {
      kind: "ready",
      place: {
        serverId: chatScope.serverId,
        cwd: chatScope.cwd,
        workspaceId: chatScope.workspaceId,
      },
    };
  const { host } = state;
  if (!host) return { kind: "unknownHost", name: request.host ?? "" };
  if (!state.connected) return { kind: "offline", serverId: host.serverId, hostLabel: host.label };
  const folder = resolveRunFolder(request.cwd, state.homeDirectory);
  if (!folder) return { kind: "noHome", serverId: host.serverId, hostLabel: host.label };
  const workspace = ownerWorkspace(folder, state.workspaces);
  return {
    kind: "ready",
    place: { serverId: host.serverId, cwd: folder, workspaceId: workspace?.id ?? null },
  };
}

/** The host a run lives on; an unknown host has none. */
export function targetServerId(target: CodeRunTarget): string | null {
  if (target.kind === "ready") return target.place.serverId;
  if (target.kind === "unknownHost") return null;
  return target.serverId;
}
