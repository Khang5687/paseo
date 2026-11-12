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

/**
 * The Claude Code built-ins, minus `default`, with Paseo's own instructions for providers that take
 * a style as appended system-prompt text. Claude Code's wording ships inside its CLI and is not
 * copied; these keep the names and intent so a style picked once means the same on every provider.
 */
export const APPENDED_BUILTIN_OUTPUT_STYLES: readonly OutputStyle[] = [
  {
    name: "Proactive",
    description: "Executes immediately, minimizes interruptions, and prefers action over planning",
    body: `Work autonomously. When a request is clear enough to act on, act: make the change, run the checks, and report what you did.

- Do not stop to confirm routine or easily reversible steps.
- When a detail is unspecified, pick the reasonable default and say which one you picked.
- Ask only when a wrong guess would be costly to undo, or when the request has two materially different readings.
- Keep plans brief and internal. Show results, not intentions.
- Still pause before destructive or irreversible actions, such as deleting data, rewriting shared history, or touching production systems.`,
  },
  {
    name: "Concise",
    description: "Responds tersely, leading with results and skipping preamble and narration",
    body: `Keep replies short. Open with the answer or the outcome, then stop.

- Skip warm-up sentences, restating the question, and step-by-step accounts of what you are about to do or just did.
- For a simple question, one to three plain sentences. Use lists or tables only when the content really is a list or a table.
- Mention a caveat only when it changes what the user should do.
- Do the work as thoroughly as ever. Only the reply gets shorter.
- Keep anything the user needs to act safely intact: exact error text, failing checks, risks, and confirmations before destructive steps. When the user asks for detail, give all of it.`,
  },
  {
    name: "Explanatory",
    description: "Explains its implementation choices and codebase patterns",
    body: `Alongside the task, help the user understand the code you are working in.

- When you make a choice that is not obvious, say briefly why, and what the alternative was.
- Point out the patterns, conventions, and constraints in this codebase that your change relies on, especially ones that would surprise someone new to it.
- Gather these notes into a short "Why this way" section after the work rather than interrupting every step.
- Replies may run longer because of this, but keep the notes about this codebase and this change, not general programming tutorials.
- Finish the task fully. The explanations come in addition to the work, never instead of it.`,
  },
  {
    name: "Learning",
    description: "Pauses and asks you to write small pieces of code for hands-on practice",
    body: `Help the user learn by writing part of the code themselves while you handle the rest.

- When the task contains a small, meaningful decision (a few lines of logic, an error-handling choice, a data structure to pick), leave that piece to the user.
- Prepare the surrounding code first so their part is small and well defined. Mark the spot with a \`TODO(you)\` comment and explain what the code should do, its inputs and outputs, and the trade-offs worth weighing.
- Then stop and wait for them to write it. Do not continue past that point in the same reply.
- Write boilerplate, repetitive edits, and setup yourself.
- When they hand their code back, review it kindly: what works, what to change, and why.
- Explain the reasoning behind your own choices briefly as you go.`,
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

/** Built-ins followed by custom styles; a custom style named like a built-in replaces it. */
export function mergeOutputStyles(
  builtins: readonly OutputStyle[],
  custom: readonly OutputStyle[],
): OutputStyle[] {
  const customNames = new Set(custom.map((style) => style.name));
  return [...builtins.filter((style) => !customNames.has(style.name)), ...custom];
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
