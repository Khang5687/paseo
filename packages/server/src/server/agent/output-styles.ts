import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentFeatureSelect } from "./agent-sdk-types.js";
import { claudeConfigDir } from "./providers/claude/project-dir.js";

export const OUTPUT_STYLE_FEATURE_ID = "output_style";
/** Claude Code's name for "no output style"; OMP uses the same id for "append nothing". */
export const DEFAULT_OUTPUT_STYLE = "default";

export interface OutputStyle {
  /** The value Claude Code's `outputStyle` setting takes: frontmatter `name`, else the file name. */
  name: string;
  description?: string;
  /** Style instructions. Null for Claude Code built-ins, whose text ships inside the CLI. */
  body: string | null;
}

export type DiscoverOutputStyles = (input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<OutputStyle[]>;

// Descriptions match Claude Code's `/output-style` picker.
export const CLAUDE_BUILTIN_OUTPUT_STYLES: readonly OutputStyle[] = [
  {
    name: DEFAULT_OUTPUT_STYLE,
    description: "Completes coding tasks efficiently and provides concise responses",
    body: null,
  },
  {
    name: "Proactive",
    description: "Executes immediately, minimizes interruptions, and prefers action over planning",
    body: null,
  },
  {
    name: "Concise",
    description: "Responds tersely, leading with results and skipping preamble and narration",
    body: null,
  },
  {
    name: "Explanatory",
    description: "Explains its implementation choices and codebase patterns",
    body: null,
  },
  {
    name: "Learning",
    description: "Pauses and asks you to write small pieces of code for hands-on practice",
    body: null,
  },
];

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseOutputStyleFile(fileName: string, source: string): OutputStyle | null {
  const match = FRONTMATTER_PATTERN.exec(source);
  let frontmatter: unknown = null;
  if (match) {
    try {
      frontmatter = parseYaml(match[1] ?? "");
    } catch {
      return null;
    }
  }
  const fields =
    frontmatter && typeof frontmatter === "object" ? (frontmatter as Record<string, unknown>) : {};
  const name =
    typeof fields.name === "string" && fields.name.trim()
      ? fields.name.trim()
      : basename(fileName, ".md");
  const body = (match ? source.slice(match[0].length) : source).trim();
  if (!body) return null;
  return {
    name,
    ...(typeof fields.description === "string" && fields.description.trim()
      ? { description: fields.description.trim() }
      : {}),
    body,
  };
}

async function readOutputStyleDir(dir: string): Promise<OutputStyle[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const styles = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .sort()
      .map(async (entry) => {
        try {
          return parseOutputStyleFile(entry, await fs.readFile(join(dir, entry), "utf8"));
        } catch {
          return null;
        }
      }),
  );
  return styles.filter((style): style is OutputStyle => style !== null);
}

/** `.claude/output-styles` dirs from `cwd` up to its git root, closest first. */
async function projectOutputStyleDirs(cwd: string): Promise<string[]> {
  const dirs: string[] = [];
  let current = cwd;
  for (;;) {
    dirs.push(join(current, ".claude", "output-styles"));
    const parent = dirname(current);
    if (parent === current) break;
    const atGitRoot = await fs.access(join(current, ".git")).then(
      () => true,
      () => false,
    );
    if (atGitRoot) break;
    current = parent;
  }
  return dirs;
}
/**
 * Custom output styles in Claude Code's file format, from the user's Claude config dir and the
 * project's `.claude/output-styles` dirs. A project style shadows a user style of the same name,
 * and a closer project dir shadows a farther one, as in Claude Code. Plugin styles are not read.
 */
export const discoverOutputStyleFiles: DiscoverOutputStyles = async ({ cwd, env }) => {
  const userDir = join(claudeConfigDir(env), "output-styles");
  const projectDirs = (await projectOutputStyleDirs(cwd)).filter((dir) => dir !== userDir);
  const byName = new Map<string, OutputStyle>();
  // Lowest precedence first so later dirs overwrite.
  for (const dir of [userDir, ...projectDirs.toReversed()]) {
    for (const style of await readOutputStyleDir(dir)) {
      byName.set(style.name, style);
    }
  }
  return [...byName.values()];
};

export function readOutputStyleValue(
  featureValues: Record<string, unknown> | undefined,
): string | null {
  const value = featureValues?.[OUTPUT_STYLE_FEATURE_ID];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Claude Code built-ins followed by custom styles; a custom style named like a built-in wins. */
export function mergeClaudeOutputStyles(custom: readonly OutputStyle[]): OutputStyle[] {
  const customNames = new Set(custom.map((style) => style.name));
  return [
    ...CLAUDE_BUILTIN_OUTPUT_STYLES.filter((style) => !customNames.has(style.name)),
    ...custom,
  ];
}

export function buildOutputStyleFeature(input: {
  styles: readonly OutputStyle[];
  value: string | null;
}): AgentFeatureSelect {
  return {
    type: "select",
    id: OUTPUT_STYLE_FEATURE_ID,
    label: "Style",
    description: "How the agent writes its replies to you",
    tooltip: "Select output style",
    icon: "message-square-text",
    desktopTrigger: "icon",
    value: input.value,
    options: input.styles.map((style) => ({
      id: style.name,
      label: style.name === DEFAULT_OUTPUT_STYLE ? "Default" : style.name,
      ...(style.description ? { description: style.description } : {}),
    })),
  };
}

/** The system-prompt block for providers that take a style as appended instructions. */
export function renderOutputStylePrompt(style: OutputStyle | undefined): string | undefined {
  if (!style?.body) return undefined;
  return `# Output style: ${style.name}\n\n${style.body}`;
}
