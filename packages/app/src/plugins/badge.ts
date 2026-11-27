import type { PluginBadge } from "@getpaseo/plugin/client";

/** A badge a plugin passed, or null when it is not one the sidebar can draw. */
export function readPluginBadge(value: unknown): PluginBadge | null {
  if (typeof value !== "object" || value === null) return null;
  const { tone, count } = value as { tone?: unknown; count?: unknown };
  if (tone !== "attention" && tone !== "warning") return null;
  if (count === undefined) return { tone };
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
  return { tone, count: Math.floor(count) };
}
