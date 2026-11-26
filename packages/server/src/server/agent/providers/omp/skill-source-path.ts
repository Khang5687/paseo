import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import type { AgentSlashCommand } from "../../agent-sdk-types.js";

/**
 * OMP advertises a skill as `skill:<name>` or `skill:<namespace>/<name>` with no file path.
 * Paseo rebuilds the path from OMP's discovery rules (`discovery/agents.ts`, `claude.ts`,
 * `builtin.ts`) and shows it only when exactly one candidate SKILL.md explains the command.
 * A missing path is better than a wrong one: skills OMP loads from other places (plugins,
 * Codex, Cursor, settings paths) are not searched, so a lookalike here must also match the
 * advertised description to count.
 */

interface SkillRoot {
  dir: string;
  /** OMP provider id; the namespace of a skill whose path owner is a dotted directory. */
  provider: "agents" | "claude" | "native";
}

interface SkillCandidate {
  dir: string;
  namespace: string;
}

const PROJECT_SKILL_DIRS: readonly {
  segments: readonly string[];
  provider: SkillRoot["provider"];
}[] = [
  { segments: [".agent", "skills"], provider: "agents" },
  { segments: [".agents", "skills"], provider: "agents" },
  { segments: [".claude", "skills"], provider: "claude" },
  { segments: [".omp", "skills"], provider: "native" },
];

const USER_SKILL_DIRS: readonly { segments: readonly string[]; provider: SkillRoot["provider"] }[] =
  [
    { segments: [".agent", "skills"], provider: "agents" },
    { segments: [".agents", "skills"], provider: "agents" },
    { segments: [".claude", "skills"], provider: "claude" },
    { segments: [".omp", "agent", "skills"], provider: "native" },
  ];

// SKILL.md descriptions by path, valid while the file's mtime is unchanged.
const descriptionCache = new Map<string, { mtimeMs: number; description: string | null }>();

/** Mirrors `skillNamespace` in OMP `extensibility/skills.ts` for `<root>/<name>/SKILL.md`. */
function skillNamespace(skillDir: string, provider: SkillRoot["provider"]): string {
  const segments = skillDir.split(/[\\/]/);
  const skillsIndex = segments.lastIndexOf("skills");
  const pathRoot = skillsIndex > 0 ? segments[skillsIndex - 1] : undefined;
  if (!pathRoot || pathRoot.startsWith(".")) {
    return provider;
  }
  const safe = pathRoot.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return safe || provider;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Project ancestors OMP scans: cwd up to the git root, else up to home (or `/` outside home). */
async function projectAncestors(cwd: string, home: string): Promise<string[]> {
  const ancestors: string[] = [];
  const cwdIsUnderHome = cwd === home || cwd.startsWith(home + path.sep);
  let current = cwd;
  for (;;) {
    if (current !== home) {
      ancestors.push(current);
    }
    let atGitRoot = false;
    try {
      await fs.stat(path.join(current, ".git"));
      atGitRoot = true;
    } catch {
      // not a git root
    }
    if (atGitRoot || (cwdIsUnderHome && current === home)) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return ancestors;
}

async function listSkillRoots(cwd: string, home: string): Promise<SkillRoot[]> {
  const candidates: SkillRoot[] = [];
  for (const ancestor of await projectAncestors(cwd, home)) {
    for (const entry of PROJECT_SKILL_DIRS) {
      candidates.push({ dir: path.join(ancestor, ...entry.segments), provider: entry.provider });
    }
  }
  for (const entry of USER_SKILL_DIRS) {
    candidates.push({ dir: path.join(home, ...entry.segments), provider: entry.provider });
  }
  const exists = await Promise.all(candidates.map((root) => isDirectory(root.dir)));
  return candidates.filter((_, index) => exists[index]);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function readSkillDescription(skillFile: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(skillFile)).mtimeMs;
  } catch {
    return null;
  }
  const cached = descriptionCache.get(skillFile);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.description;
  }
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillFile, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (match) {
      const frontmatter: unknown = parseYaml(match[1] ?? "");
      const value =
        frontmatter && typeof frontmatter === "object"
          ? (frontmatter as Record<string, unknown>).description
          : undefined;
      description = typeof value === "string" ? normalizeText(value) : "";
    }
  } catch {
    description = null;
  }
  descriptionCache.set(skillFile, { mtimeMs, description });
  return description;
}

function parseSkillCommandName(commandName: string): { namespace?: string; name: string } | null {
  if (!commandName.startsWith("skill:")) {
    return null;
  }
  const rest = commandName.slice("skill:".length);
  const slash = rest.indexOf("/");
  const namespace = slash === -1 ? undefined : rest.slice(0, slash);
  const name = slash === -1 ? rest : rest.slice(slash + 1);
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || namespace === "") {
    return null;
  }
  return { ...(namespace ? { namespace } : {}), name };
}

/**
 * Adds `sourcePath` (the skill's folder) to each OMP skill command that exactly one
 * candidate SKILL.md accounts for. Other commands and unresolved skills pass through.
 */
export async function attachOmpSkillSourcePaths(
  commands: readonly AgentSlashCommand[],
  options: { cwd: string; home: string },
): Promise<AgentSlashCommand[]> {
  const skillCommands = commands.filter(
    (command) => command.kind === "skill" && parseSkillCommandName(command.name) !== null,
  );
  if (skillCommands.length === 0) {
    return [...commands];
  }
  const roots = await listSkillRoots(options.cwd, options.home);
  const resolved = new Map<string, string>();
  await Promise.all(
    skillCommands.map(async (command) => {
      const parsed = parseSkillCommandName(command.name);
      if (!parsed) {
        return;
      }
      const wanted = normalizeText(command.description);
      const candidates: SkillCandidate[] = roots
        .map((root) => ({
          dir: path.join(root.dir, parsed.name),
          namespace: skillNamespace(path.join(root.dir, parsed.name), root.provider),
        }))
        .filter((candidate) => !parsed.namespace || candidate.namespace === parsed.namespace);
      const descriptions = await Promise.all(
        candidates.map((candidate) => readSkillDescription(path.join(candidate.dir, "SKILL.md"))),
      );
      // OMP substitutes "Run <name> skill" when the frontmatter has no description.
      const matches = candidates.filter((_, index) => {
        const description = descriptions[index];
        if (description === null || description === undefined) {
          return false;
        }
        return (description || `Run ${parsed.name} skill`) === wanted;
      });
      // One file reached through several roots (a symlinked copy) is one skill; the first
      // root in scan order is the one shown.
      const realPaths = await Promise.all(
        matches.map((match) => fs.realpath(path.join(match.dir, "SKILL.md")).catch(() => null)),
      );
      const distinct = matches.filter(
        (_, index) => realPaths[index] === null || realPaths.indexOf(realPaths[index]) === index,
      );
      const only = distinct.length === 1 ? distinct[0] : undefined;
      if (only) {
        resolved.set(command.name, only.dir);
      }
    }),
  );
  return commands.map((command) => {
    const sourcePath = resolved.get(command.name);
    return sourcePath ? { ...command, sourcePath } : command;
  });
}
