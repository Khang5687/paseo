// Server copy of the app's file-mention grammar: `collectFileMentions` and its regexes from
// packages/app/src/components/markdown/source.ts, and `classifyForResolution` with its helpers
// from packages/app/src/assistant-file-links/resolver.ts. The server cannot import the app, so
// change both copies together; mentions.test.ts repeats the app's cases.
import {
  classifyAssistantFileLink,
  isFileLookingAssistantToken,
  type InlinePathTarget,
} from "./parse.js";
import { ASSISTANT_EXTENSIONLESS_FILE_NAMES, ASSISTANT_FILE_EXTENSIONS } from "./extensions.js";

interface AssistantFileLinkSource {
  href: string;
  text?: string;
  markup?: string;
  sourceType?: "inline-code";
}

export interface FileMentionContext {
  workspaceRoot?: string;
}

/** A file a message names: a path, or a bare name the host has to find first. */
export type FileMention =
  | { kind: "path"; path: string }
  | { kind: "needsLookup"; ambiguousQuery: string; token: string; target: InlinePathTarget };

type Resolution =
  | { kind: "file"; target: InlinePathTarget }
  | { kind: "ignored" }
  | Extract<FileMention, { kind: "needsLookup" }>;

const NON_ASCII = String.raw`\u0080-\u1FFF\u2070-\u2FFF\u3040-\uFF00\uFF10-\uFF19\uFF21-\uFFFF`;
const PATH_CHARACTER = String.raw`[a-zA-Z0-9${NON_ASCII}_@.%+-]`;
const PATH_LETTER = String.raw`[a-zA-Z]`;
const PATH_SEGMENT = String.raw`${PATH_CHARACTER}*[a-zA-Z0-9${NON_ASCII}_@%+-]`;
const LINE_SUFFIX = String.raw`(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?`;
const FILE_EXTENSIONS = [...ASSISTANT_FILE_EXTENSIONS]
  .map((extension) => extension.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`))
  .join("|");
const PATH_PREFIX = String.raw`(?:[A-Za-z]:[\\/]|\.{0,2}\/|~\/)`;
const HAS_PATH_LETTER = String.raw`(?=${PATH_CHARACTER}*(?:[\\/]${PATH_CHARACTER}*)*${PATH_LETTER})`;
const SEPARATED_PATH = String.raw`${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT})+`;
const FILE_NAME = String.raw`${PATH_SEGMENT}\.(?:${FILE_EXTENSIONS})`;
const NAMED_FILE = String.raw`(?:${[...ASSISTANT_EXTENSIONLESS_FILE_NAMES].join("|")})`;
const BARE_NAMED_FILE = String.raw`(?:${[...ASSISTANT_EXTENSIONLESS_FILE_NAMES]
  .filter((name) => /^[A-Z]\w*file$|^LICEN|^CODEOWNERS$/.test(name))
  .join("|")})`;
const DOTFILE = String.raw`\.(?:env|[a-z][a-z0-9_-]*(?:rc|ignore|config|attributes|profile))(?:\.[a-z0-9_-]+)*`;
const DIRECTORY_FILE_NAME = String.raw`(?:${PATH_SEGMENT}\.(?:[a-z][a-z0-9]{0,9}|${FILE_EXTENSIONS})|${NAMED_FILE})`;
const PROSE_PATH = String.raw`(?:${PATH_PREFIX}${HAS_PATH_LETTER}${SEPARATED_PATH}|(?:~|\.{1,2})\/${HAS_PATH_LETTER}${PATH_SEGMENT}|${HAS_PATH_LETTER}(?:${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT})*[\\/]${DIRECTORY_FILE_NAME}|${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT}){2,}|${SEPARATED_PATH}(?=:\d)))`;
const URL_CHARACTER = String.raw`[^\s<>()"'\x60]`;
const URL_GROUP = String.raw`\(${URL_CHARACTER}*\)`;
const BARE_URL = String.raw`https?://(?:${URL_CHARACTER}|${URL_GROUP})*(?:[^\s<>()"'\x60.,;:!?]|${URL_GROUP})`;
const TEXT_PATTERN = new RegExp(
  String.raw`(?:${BARE_URL}|(?<![a-zA-Z0-9${NON_ASCII}_@.%\x2b~:/\\-])(?:${PROSE_PATH}|${FILE_NAME}|${BARE_NAMED_FILE}|${DOTFILE})${LINE_SUFFIX}(?![a-zA-Z0-9${NON_ASCII}_@%+/\\-]|:(?!\s|$)|\.${PATH_CHARACTER}))`,
  "g",
);
const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;
// One run of backticks up to the next run of the same length: a CommonMark code span.
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const MARKDOWN_LINK_URL = /\]\(\s*<?([^\s<>()]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/**
 * The files a message links, as tapping them in the app would open them: prose paths,
 * inline-code paths and Markdown link targets, not code blocks. Unlike the app's collector,
 * prose matching skips code spans, so `cd ~/a && ls` does not name `~/a`: the app never
 * links text inside a code span, and a copy of `/usr/bin/env` would be wrong.
 */
export function collectFileMentions(source: string, context: FileMentionContext): FileMention[] {
  const prose = source.replace(FENCED_CODE, "");
  const text = prose.replace(CODE_SPAN, " ");
  const candidates: AssistantFileLinkSource[] = [
    ...[...text.matchAll(TEXT_PATTERN)].map((match) => ({
      href: match[0],
      text: match[0],
      markup: "linkify",
    })),
    ...[...collectInlineCodePaths(prose, context.workspaceRoot)].map((path) => ({
      href: path,
      text: path,
      sourceType: "inline-code" as const,
    })),
    ...[...text.matchAll(MARKDOWN_LINK_URL)].map((match) => ({ href: match[1], text: match[1] })),
  ];
  const mentions = new Map<string, FileMention>();
  for (const candidate of candidates) {
    const resolution = classifyForResolution(candidate, context);
    if (resolution.kind === "needsLookup") {
      mentions.set(`?${resolution.token}`, resolution);
    } else if (resolution.kind === "file") {
      const path = resolution.target.path;
      mentions.set(path, { kind: "path", path });
    }
  }
  return [...mentions.values()];
}

function collectInlineCodePaths(source: string, workspaceRoot?: string): Set<string> {
  const paths = new Set<string>();
  const previousEnds = new Map<number, number>();
  for (const match of source.matchAll(/`+/g)) {
    const length = match[0].length;
    const previousEnd = previousEnds.get(length);
    previousEnds.set(length, match.index + length);
    if (previousEnd === undefined) continue;
    let value = source.slice(previousEnd, match.index).replace(/\r\n?|\n/g, " ");
    // CommonMark code spans replace line endings and strip one surrounding space.
    if (value.startsWith(" ") && value.endsWith(" ") && /[^ ]/.test(value)) {
      value = value.slice(1, -1);
    }
    const classification = classifyAssistantFileLink(value, { workspaceRoot });
    if (classification && classification.kind !== "external") paths.add(value);
  }
  return paths;
}

function classifyForResolution(
  source: AssistantFileLinkSource,
  context: FileMentionContext,
): Resolution {
  const tokenInfo = getTokenInfo(source);
  const token = tokenInfo.token.trim();
  if (!token) return { kind: "ignored" };

  const classification = classifyAssistantFileLink(token, {
    workspaceRoot: context.workspaceRoot,
    decodeHref: tokenInfo.fromHref,
    explicitLink: source.sourceType !== "inline-code" && !isLinkifiedSource(source),
  });
  if (!classification || classification.kind === "external") return { kind: "ignored" };
  if (
    classification.kind === "directFile" &&
    !shouldResolveDirectFileThroughSuggestions(source, token, classification.target, context)
  ) {
    return { kind: "file", target: classification.target };
  }

  const workspaceRoot = context.workspaceRoot?.trim();
  if (!workspaceRoot) return { kind: "ignored" };
  return {
    kind: "needsLookup",
    ambiguousQuery: getAmbiguousSuggestionQuery(classification.target, workspaceRoot),
    token,
    target: classification.target,
  };
}

// Markdown link hrefs are percent-encoded; inline code and linkified text are raw paths.
function getTokenInfo(source: AssistantFileLinkSource): { token: string; fromHref: boolean } {
  if (source.sourceType === "inline-code") {
    return { token: source.text?.trim() || source.href, fromHref: false };
  }
  if (isLinkifiedSource(source)) {
    const text = source.text?.trim();
    if (text && isFileLookingAssistantToken(text)) return { token: text, fromHref: false };
  }
  return { token: source.href, fromHref: true };
}

function getAmbiguousSuggestionQuery(target: InlinePathTarget, workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = target.path.replace(/\\/g, "/");
  const prefix = `${normalizedRoot}/`;
  if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length);
  const lastSlash = normalizedPath.lastIndexOf("/");
  return lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
}

function shouldResolveDirectFileThroughSuggestions(
  source: AssistantFileLinkSource,
  token: string,
  target: InlinePathTarget,
  context: FileMentionContext,
): boolean {
  if (source.sourceType !== "inline-code") return false;
  const absolute =
    token.startsWith("/") ||
    token.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(token) ||
    token.toLowerCase().startsWith("file://");
  if (absolute) return false;
  const workspaceRoot = context.workspaceRoot?.trim();
  if (!workspaceRoot) return false;
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return target.path.replace(/\\/g, "/").startsWith(`${normalizedRoot}/`);
}

function isLinkifiedSource(source: AssistantFileLinkSource): boolean {
  return source.markup === "linkify";
}
