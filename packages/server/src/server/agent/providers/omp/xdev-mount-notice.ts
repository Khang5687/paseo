import { randomUUID } from "node:crypto";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { OmpNoticeEvent } from "./rpc-types.js";

/** Tool name the app keys the plug icon and "MCP" label on. */
export const MCP_SERVERS_TOOL_NAME = "mcp_servers";

const XDEV_NOTICE_SOURCE = "xdev";
const XDEV_NOTICE_PREFIX = "xd://: ";
const MCP_TOOL_PREFIX = "mcp__";
const MAX_LABEL_SERVERS = 3;

export interface XdevMountChange {
  added: string[];
  removed: string[];
}

export interface McpMountGroup {
  /** Sanitized server id as OMP minted it, e.g. `gmail_usa`; a non-MCP device keeps its name. */
  server: string;
  label: string;
  /** Tool names without the `mcp__<server>_` prefix. */
  tools: string[];
}

type McpServersStatusLine = Extract<AgentTimelineItem, { type: "tool_call" }>;

/**
 * OMP announces `xd://` mount changes as `xd://: mounted a, b; unmounted c` (session-tools.ts
 * `#notifyXdevMountDelta`). Returns null for every other notice so it keeps the plain row.
 */
export function parseXdevMountNotice(notice: OmpNoticeEvent): XdevMountChange | null {
  if (notice.source !== undefined && notice.source !== XDEV_NOTICE_SOURCE) return null;
  if (!notice.message.startsWith(XDEV_NOTICE_PREFIX)) return null;
  const change: XdevMountChange = { added: [], removed: [] };
  for (const part of notice.message.slice(XDEV_NOTICE_PREFIX.length).split("; ")) {
    const match = /^(mounted|unmounted) (.+)$/.exec(part);
    if (!match) return null;
    const names = match[2]!.split(", ").filter((name) => name.length > 0);
    if (match[1] === "mounted") change.added.push(...names);
    else change.removed.push(...names);
  }
  return change.added.length > 0 || change.removed.length > 0 ? change : null;
}

/**
 * Splits OMP tool names into servers. OMP mints `mcp__<server>_<tool>` with one underscore, and
 * sanitized server and tool names both contain underscores, so the name alone is ambiguous and
 * RPC exposes no owning server. Rules, in order:
 * - the first token is always server;
 * - a group of 3+ tools that all share the next token extends the server through it
 *   (`chrome_devtools`), unless that token repeats the previous one: a server's tools often carry
 *   its last word (`gmail_usa` + `usa_read_email`). Two tools sharing a word are as likely one
 *   server's `notebook_create` and `notebook_list`, and a too-short id is the safer mistake: tool
 *   names keep their words;
 * - a group that forks into two or more branches, each of 2+ tools that again share a token,
 *   splits into one server per branch (`gmail_usa_usa_*` beside `gmail_vn_vn_*`).
 * Every tool keeps at least one token of its own.
 */
export function groupXdevMountNames(names: readonly string[]): McpMountGroup[] {
  // Insertion order keeps groups in notice order; a non-MCP device is its own group.
  const buckets = new Map<string, string[][] | string>();
  for (const name of names) {
    const tokens = name.startsWith(MCP_TOOL_PREFIX)
      ? name.slice(MCP_TOOL_PREFIX.length).split("_")
      : [];
    if (tokens.length < 2 || tokens.some((token) => token.length === 0)) {
      buckets.set(`\0${name}`, name);
      continue;
    }
    const bucket = buckets.get(tokens[0]!);
    if (Array.isArray(bucket)) bucket.push(tokens);
    else buckets.set(tokens[0]!, [tokens]);
  }
  const groups: McpMountGroup[] = [];
  for (const bucket of buckets.values()) {
    if (typeof bucket === "string") {
      groups.push({ server: bucket, label: bucket, tools: [bucket] });
      continue;
    }
    for (const { depth, entries } of resolveServers(bucket, 1)) {
      const server = entries[0]!.slice(0, depth).join("_");
      groups.push({
        server,
        label: server
          .split("_")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" "),
        tools: entries.map((tokens) => tokens.slice(depth).join("_")),
      });
    }
  }
  return groups;
}

function resolveServers(
  entries: string[][],
  startDepth: number,
): Array<{ depth: number; entries: string[][] }> {
  let depth = startDepth;
  if (entries.length < 2) return [{ depth, entries }];
  while (entries.length >= 3 && entries.every((tokens) => tokens.length > depth + 1)) {
    const next = entries[0]![depth]!;
    if (next === entries[0]![depth - 1] || entries.some((tokens) => tokens[depth] !== next)) break;
    depth += 1;
  }
  const branches = new Map<string, string[][]>();
  for (const tokens of entries) {
    const key = tokens.length > depth + 1 ? tokens[depth]! : "";
    const branch = branches.get(key);
    if (branch) branch.push(tokens);
    else branches.set(key, [tokens]);
  }
  const splits =
    branches.size >= 2 &&
    [...branches].every(
      ([key, branch]) => key !== "" && branch.length >= 2 && sharesToken(branch, depth + 1),
    );
  if (!splits) return [{ depth, entries }];
  return [...branches.values()].flatMap((branch) => resolveServers(branch, depth + 1));
}

function sharesToken(entries: string[][], index: number): boolean {
  const token = entries[0]![index];
  return entries.every((tokens) => tokens.length > index + 1 && tokens[index] === token);
}

function formatLabelPart(groups: readonly McpMountGroup[], verb: string): string {
  const shown = groups.slice(0, MAX_LABEL_SERVERS).map((group) => group.label);
  const hidden = groups.length - shown.length;
  const servers = hidden > 0 ? `${shown.join(", ")} +${hidden} more` : shown.join(", ");
  const count = groups.reduce((total, group) => total + group.tools.length, 0);
  return `${servers} ${verb} (${count === 1 ? "1 tool" : `${count} tools`})`;
}

function formatTextSection(title: string, groups: readonly McpMountGroup[]): string {
  const lines = [title];
  for (const group of groups) {
    if (group.tools.length === 1 && group.tools[0] === group.server) {
      lines.push(group.label);
      continue;
    }
    const count = group.tools.length;
    lines.push(`${group.label} (${count === 1 ? "1 tool" : `${count} tools`})`);
    for (const tool of group.tools) lines.push(`  ${tool}`);
  }
  return lines.join("\n");
}

export function buildMcpServersStatusLine(change: XdevMountChange): McpServersStatusLine {
  const added = groupXdevMountNames(change.added);
  const removed = groupXdevMountNames(change.removed);
  const labelParts: string[] = [];
  const textSections: string[] = [];
  if (added.length > 0) {
    labelParts.push(formatLabelPart(added, "connected"));
    textSections.push(formatTextSection("Connected", added));
  }
  if (removed.length > 0) {
    labelParts.push(formatLabelPart(removed, "disconnected"));
    textSections.push(formatTextSection("Disconnected", removed));
  }
  return {
    type: "tool_call",
    // Unique per row: a remount after an unmount is a new row, never an update of the old one.
    callId: `omp-xdev-mounts:${randomUUID()}`,
    name: MCP_SERVERS_TOOL_NAME,
    status: "completed",
    error: null,
    detail: {
      type: "plain_text",
      label: labelParts.join(" · "),
      text: textSections.join("\n\n"),
      // Apps without the plug icon fall back to this one.
      icon: "wrench",
    },
    metadata: { synthetic: true, source: "omp_xdev_mounts", added, removed },
  };
}

/**
 * Per-session filter for OMP's mount notices. OMP repeats an identical delta, for example when a
 * restarted runtime remounts the same MCP servers, so a notice that matches the last announced
 * change is dropped. Any different change, including an unmount between two identical mounts,
 * resets the comparison, so real churn always shows.
 */
export class OmpXdevMountNotices {
  private lastSignature: string | null = null;

  /** Null when the notice repeats the last announced change. */
  map(change: XdevMountChange): McpServersStatusLine | null {
    const signature = JSON.stringify([[...change.added].sort(), [...change.removed].sort()]);
    if (signature === this.lastSignature) return null;
    this.lastSignature = signature;
    return buildMcpServersStatusLine(change);
  }
}
