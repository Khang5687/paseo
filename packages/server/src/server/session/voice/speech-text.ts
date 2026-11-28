/**
 * Prepares agent text for text-to-speech. A speech engine reads every character, so
 * fenced code, long paths and URLs turn into a minute of noise. This keeps the words a
 * listener can use and drops the rest; the chat log keeps the original text.
 */

const CODE_BLOCK_WORDS = "Code block.";

// A fence opens with 3+ backticks or tildes at the start of a line and closes with the same
// character. An unterminated fence (text cut off mid-block) runs to the end of the text.
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE = /`([^`\n]+)`/g;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((?:https?:\/\/|mailto:)[^)\s]*\)/g;
const URL_PATTERN = /\b(?:https?|ftp):\/\/([^\s/?#<>()"'`]+)[^\s<>()"'`]*/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s\\/:*?"<>|`]+\\)*([^\s\\/:*?"<>|`]+)/g;

// One path-looking token: no whitespace, quotes or brackets. Trailing sentence punctuation
// and an optional :line[:column] suffix are peeled off in `shortenPathToken`.
const PATH_TOKEN =
  /(?<![\w@.~/\\-])(?:~|\.{1,2})?(?:\/?[\w.@+%=-]+)(?:\/[\w.@+%=-]+)+\/?(?::\d+){0,2}/g;

const COMMON_PATH_ROOTS = new Set([
  "src",
  "lib",
  "app",
  "apps",
  "packages",
  "node_modules",
  "docs",
  "test",
  "tests",
  "dist",
  "build",
  "bin",
  "etc",
  "usr",
  "var",
  "home",
  "tmp",
  "opt",
  "scripts",
  "public",
]);

function isPathLike(token: string): boolean {
  const withoutSuffix = token.replace(/(?::\d+){1,2}$/, "").replace(/\/$/, "");
  const segments = withoutSuffix.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return false;
  }
  const anchored = /^(?:~|\.{1,2})?\//.test(withoutSuffix) || /^(?:~|\.{1,2})$/.test(segments[0]);
  if (anchored) {
    return true;
  }
  // Relative: "and/or", "read/write" and "24/7" are words, "src/app/index.ts" is a path.
  const last = segments[segments.length - 1];
  if (/\.[A-Za-z0-9]{1,8}$/.test(last)) {
    return true;
  }
  if (segments.length < 3 && !COMMON_PATH_ROOTS.has(segments[0].toLowerCase())) {
    return false;
  }
  return segments.some(
    (segment) => COMMON_PATH_ROOTS.has(segment.toLowerCase()) || /[._\-@\dA-Z]/.test(segment),
  );
}

function shortenPathToken(token: string): string {
  const lineMatch = token.match(/((?::\d+){1,2})$/);
  const body = lineMatch ? token.slice(0, -lineMatch[1].length) : token;
  const segments = body.split("/").filter((segment) => segment.length > 0);
  const name = segments[segments.length - 1];
  if (!name || /^\.{1,2}$/.test(name) || name === "~") {
    return token;
  }
  if (!lineMatch) {
    return name;
  }
  const lineNumber = lineMatch[1].split(":").find(Boolean);
  return `${name} line ${lineNumber}`;
}

function shortenPaths(text: string): string {
  const withoutWindows = text.replace(WINDOWS_PATH, (_match, name: string) => name);
  return withoutWindows.replace(PATH_TOKEN, (token) => {
    // Sentence punctuation glued to a path belongs to the sentence, not the path.
    const trailing = token.match(/[.,;:!?]+$/)?.[0] ?? "";
    const core = trailing ? token.slice(0, -trailing.length) : token;
    if (!isPathLike(core)) {
      return token;
    }
    return shortenPathToken(core) + trailing;
  });
}

/**
 * Fenced code becomes the words "Code block." once per text. Inline code keeps its words.
 * Paths shrink to their last segment, URLs to their host, Markdown links to their label.
 * Returns an empty string when nothing speakable is left.
 */
export function prepareTextForSpeech(text: string): string {
  let spokeCodeBlock = false;
  const withoutFences = text.replace(FENCED_BLOCK, () => {
    if (spokeCodeBlock) {
      return "\n";
    }
    spokeCodeBlock = true;
    return `\n${CODE_BLOCK_WORDS}\n`;
  });

  const unwrapped = withoutFences
    .replace(MARKDOWN_LINK, "$1")
    .replace(INLINE_CODE, "$1")
    .replace(URL_PATTERN, (_match, host: string) => host.replace(/^www\./, ""));

  return shortenPaths(unwrapped)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
