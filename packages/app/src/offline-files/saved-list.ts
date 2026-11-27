import type { OfflineFile } from "./store";

export interface SavedFileGroup {
  serverId: string;
  totalBytes: number;
  /** Newest first. */
  files: OfflineFile[];
}

/**
 * Saved files grouped by host, each group newest first, keeping only paths that contain `query`
 * (case-insensitive). Groups follow `hostOrder`; hosts the app no longer knows come last.
 * Settings → Files shows this.
 */
export function groupSavedFiles(
  files: readonly OfflineFile[],
  input: { query: string; hostOrder: readonly string[] },
): SavedFileGroup[] {
  const query = input.query.trim().toLowerCase();
  const groups = new Map<string, SavedFileGroup>();
  for (const file of files) {
    if (query && !file.path.toLowerCase().includes(query)) continue;
    let group = groups.get(file.serverId);
    if (!group) {
      group = { serverId: file.serverId, totalBytes: 0, files: [] };
      groups.set(file.serverId, group);
    }
    group.totalBytes += file.size;
    group.files.push(file);
  }
  const rank = (serverId: string) => {
    const index = input.hostOrder.indexOf(serverId);
    return index === -1 ? input.hostOrder.length : index;
  };
  const result = [...groups.values()];
  for (const group of result) group.files.sort((a, b) => b.savedAt - a.savedAt);
  return result.sort(
    (a, b) => rank(a.serverId) - rank(b.serverId) || a.serverId.localeCompare(b.serverId),
  );
}

// ---------------------------------------------------------------------------
// The Saved screen: chips, sort and sections
// ---------------------------------------------------------------------------

/** The chip row's one-of filter. "sent" is a file another device sent here. */
export type SavedKindFilter = "all" | "sent" | "apps" | "docs" | "images" | "code";
export type SavedFileType = "apps" | "docs" | "images" | "code";
export type SavedSort = "newest" | "biggest" | "name";
export type SavedGrouping = "day" | "project";
export type SavedDay = "today" | "yesterday" | "week" | "earlier";

/** A folder a host knows as part of a project: a project root or a workspace (worktree) folder. */
export interface SavedProjectRoot {
  path: string;
  name: string;
}

/** A saved file with what its row and the filters show. */
export interface SavedFileItem {
  file: OfflineFile;
  key: string;
  name: string;
  project: string;
  /** The host's label, or its id when the app no longer knows it. */
  device: string;
  type: SavedFileType | null;
}

export interface SavedFilters {
  query: string;
  kind: SavedKindFilter;
  /** A project name from the Project chip, or null for every project. */
  project: string | null;
  /** A host id from the Device chip, or null for every device. */
  serverId: string | null;
}

export interface SavedSection {
  /** `day:<SavedDay>`, `project:<name>`, or `all` for one untitled section. */
  key: string;
  day?: SavedDay;
  project?: string;
  totalBytes: number;
  items: SavedFileItem[];
}

const TYPE_EXTENSIONS: Record<SavedFileType, readonly string[]> = {
  apps: ["apk", "aab", "xapk", "ipa", "dmg", "pkg", "exe", "msi", "deb", "rpm", "appimage"],
  images: [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "heic",
    "heif",
    "bmp",
    "ico",
    "avif",
    "tiff",
  ],
  docs: [
    "pdf",
    "md",
    "markdown",
    "txt",
    "rtf",
    "doc",
    "docx",
    "odt",
    "pages",
    "epub",
    "xls",
    "xlsx",
    "ods",
    "numbers",
    "csv",
    "tsv",
    "ppt",
    "pptx",
    "odp",
    "key",
  ],
  code: [
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "xml",
    "html",
    "css",
    "scss",
    "less",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "kts",
    "swift",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "php",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "sql",
    "lua",
    "dart",
    "vue",
    "svelte",
    "astro",
    "gradle",
    "nix",
    "tf",
    "ini",
    "conf",
    "env",
  ],
};

const TYPE_BY_EXTENSION = new Map<string, SavedFileType>(
  (Object.keys(TYPE_EXTENSIONS) as SavedFileType[]).flatMap((type) =>
    TYPE_EXTENSIONS[type].map((extension) => [extension, type] as const),
  ),
);

/** Which type chip a file falls under, from its extension; an image the host read as one counts. */
export function savedFileType(file: Pick<OfflineFile, "path" | "kind">): SavedFileType | null {
  const name = file.path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const type = dot > 0 ? TYPE_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) : undefined;
  return type ?? (file.kind === "image" ? "images" : null);
}

/**
 * The project a saved path belongs to: the deepest known project or workspace folder that holds
 * it. With none, the name of the folder the file sits in.
 */
export function savedFileProject(path: string, roots: readonly SavedProjectRoot[]): string {
  let best: string | null = null;
  let bestLength = 0;
  for (const root of roots) {
    const prefix = root.path.replace(/[\\/]+$/, "");
    if (!prefix || !(path === prefix || path.startsWith(`${prefix}/`))) continue;
    if (prefix.length > bestLength) {
      best = root.name;
      bestLength = prefix.length;
    }
  }
  if (best) return best;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : path;
}

export function describeSavedFiles(
  files: readonly OfflineFile[],
  input: {
    rootsByServer: ReadonlyMap<string, readonly SavedProjectRoot[]>;
    hostLabels: ReadonlyMap<string, string>;
  },
): SavedFileItem[] {
  return files.map((file) => ({
    file,
    key: `${file.serverId}\n${file.path}`,
    name: file.path.split(/[\\/]/).pop() ?? file.path,
    project: savedFileProject(file.path, input.rootsByServer.get(file.serverId) ?? []),
    device: input.hostLabels.get(file.serverId) ?? file.serverId,
    type: savedFileType(file),
  }));
}

/** The files every chip and the search allow. The search matches the path, project and device. */
export function filterSavedFiles(
  items: readonly SavedFileItem[],
  filters: SavedFilters,
): SavedFileItem[] {
  const query = filters.query.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.kind === "sent") {
      if (item.file.sent !== true) return false;
    } else if (filters.kind !== "all" && item.type !== filters.kind) {
      return false;
    }
    if (filters.project !== null && item.project !== filters.project) return false;
    if (filters.serverId !== null && item.file.serverId !== filters.serverId) return false;
    if (!query) return true;
    return (
      item.file.path.toLowerCase().includes(query) ||
      item.project.toLowerCase().includes(query) ||
      item.device.toLowerCase().includes(query)
    );
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which day heading a save falls under, counted from local midnight. */
export function savedDay(savedAt: number, now: number): SavedDay {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  if (savedAt >= today) return "today";
  if (savedAt >= today - DAY_MS) return "yesterday";
  if (savedAt >= today - 6 * DAY_MS) return "week";
  return "earlier";
}

const DAY_ORDER: readonly SavedDay[] = ["today", "yesterday", "week", "earlier"];

function compareItems(sort: SavedSort) {
  return (a: SavedFileItem, b: SavedFileItem) => {
    if (sort === "biggest") return b.file.size - a.file.size || b.file.savedAt - a.file.savedAt;
    if (sort === "name") {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    }
    return b.file.savedAt - a.file.savedAt;
  };
}

function sectionOf(
  key: string,
  items: SavedFileItem[],
  heading: Pick<SavedSection, "day" | "project"> = {},
): SavedSection {
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  return { key, totalBytes, items, day: heading.day, project: heading.project };
}

/**
 * Sorts the files and splits them into sections. By day, newest first, the headings are Today,
 * Yesterday, This week and Earlier; day headings only make sense in date order, so Biggest and
 * Name show one list. By project, the sections go A to Z and the sort applies inside each.
 */
export function arrangeSavedFiles(
  items: readonly SavedFileItem[],
  input: { sort: SavedSort; grouping: SavedGrouping; now: number },
): SavedSection[] {
  const sorted = [...items].sort(compareItems(input.sort));
  if (input.grouping === "project") {
    const byProject = new Map<string, SavedFileItem[]>();
    for (const item of sorted) {
      const list = byProject.get(item.project);
      if (list) list.push(item);
      else byProject.set(item.project, [item]);
    }
    return [...byProject.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .map(([project, list]) => sectionOf(`project:${project}`, list, { project }));
  }
  if (input.sort !== "newest") return sorted.length > 0 ? [sectionOf("all", sorted)] : [];
  const byDay = new Map<SavedDay, SavedFileItem[]>();
  for (const item of sorted) {
    const day = savedDay(item.file.savedAt, input.now);
    const list = byDay.get(day);
    if (list) list.push(item);
    else byDay.set(day, [item]);
  }
  return DAY_ORDER.filter((day) => byDay.has(day)).map((day) =>
    sectionOf(`day:${day}`, byDay.get(day) ?? [], { day }),
  );
}
