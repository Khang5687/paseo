const MAX_COMMAND_LENGTH = 500;

/**
 * A leading shell prompt: `$ `, `% `, `# `, `❯ `, `➜ `, `λ `, `> `, optionally after
 * `user@host:path` (bash/zsh defaults such as `me@box:~/src$ `).
 */
const PROMPT_PATTERN = /^(?:[^\s$%#❯➜λ>]*[@:][^\s$%#❯➜λ>]*\s?)?[$%#❯➜λ>]\s+/u;

/** The program word: a command name, a path to one, or a `VAR=value` assignment. */
const COMMAND_WORD_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|[~./]*[A-Za-z0-9_@+][\w@%+.:/~-]*)$/;

/**
 * The command line a terminal selection shows, or undefined when it isn't one.
 *
 * Only a single line counts. A leading prompt is stripped. Without a prompt the line must start
 * with a lowercase program word (or a path / assignment), so selected output such as
 * `Compiling foo` or `error: bar` is not mistaken for a command.
 */
export function terminalSelectionCommand(selection: string): string | undefined {
  const line = selection.trim();
  if (line.length === 0 || line.includes("\n")) return undefined;

  const prompt = PROMPT_PATTERN.exec(line);
  const command = (prompt ? line.slice(prompt[0].length) : line).trim();
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) return undefined;

  const [word] = command.split(/\s+/, 1);
  if (!word || !COMMAND_WORD_PATTERN.test(word) || word.includes("://")) return undefined;
  if (!/[A-Za-z]/.test(word) || /[:,]$/.test(word)) return undefined;
  if (!prompt && !/^(?:[a-z_~./]|[A-Za-z_][A-Za-z0-9_]*=)/.test(word)) return undefined;
  return command;
}
