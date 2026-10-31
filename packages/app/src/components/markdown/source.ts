import { classifyAssistantFileLink } from "@/assistant-file-links";
import {
  ASSISTANT_EXTENSIONLESS_FILE_NAMES,
  ASSISTANT_FILE_EXTENSIONS,
} from "@/assistant-file-links/extensions";
import { normalizeMarkdownHtml } from "./html";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { AssistantFileLinkSource } from "@/assistant-file-links";
import { decodeString } from "micromark-util-decode-string";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Link, Nodes, Paragraph, PhrasingContent, Root } from "mdast";

// Keep this regex in the syntax shared by JavaScript, ICU and java.util.regex.
// The Unicode flag makes Metro expand it to escapes rejected by native engines.
// Non-ASCII letters belong to paths; Unicode punctuation (… — “ ” 。 ， ：) ends them.
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
// Bare words like README read as prose; only `*file` names, licenses and CODEOWNERS link alone.
const BARE_NAMED_FILE = String.raw`(?:${[...ASSISTANT_EXTENSIONLESS_FILE_NAMES]
  .filter((name) => /^[A-Z]\w*file$|^LICEN|^CODEOWNERS$/.test(name))
  .join("|")})`;
const DOTFILE = String.raw`\.(?:env|[a-z][a-z0-9_-]*(?:rc|ignore|config|attributes|profile))(?:\.[a-z0-9_-]+)*`;
// Under a directory any lowercase extension marks a file: `records/q3/contract.pdf`.
const DIRECTORY_FILE_NAME = String.raw`(?:${PATH_SEGMENT}\.(?:[a-z][a-z0-9]{0,9}|${FILE_EXTENSIONS})|${NAMED_FILE})`;
// Bare prose paths need a known extension, a line suffix, or at least two separators.
const PROSE_PATH = String.raw`(?:${PATH_PREFIX}${HAS_PATH_LETTER}${SEPARATED_PATH}|(?:~|\.{1,2})\/${HAS_PATH_LETTER}${PATH_SEGMENT}|${HAS_PATH_LETTER}(?:${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT})*[\\/]${DIRECTORY_FILE_NAME}|${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT}){2,}|${SEPARATED_PATH}(?=:\d)))`;

function createFilePattern(path: string): RegExp {
  // The native adapter mistakes a literal + in lookbehind for a quantifier; use its hex escape.
  return new RegExp(
    // A colon ends a path only before a line number or a space: `src/app.ts:12`, `src/app.ts: …`.
    String.raw`(?:${BARE_URL}|(?<![a-zA-Z0-9${NON_ASCII}_@.%\x2b~:/\\-])(?:${path}|${FILE_NAME}|${BARE_NAMED_FILE}|${DOTFILE})${LINE_SUFFIX}(?![a-zA-Z0-9${NON_ASCII}_@%+/\\-]|:(?!\s|$)|\.${PATH_CHARACTER}))`,
    "g",
  );
}

// Matches bare URLs that MD4C does not autolink, like single-label or bracketed hosts.
// Quotes and unbalanced closing parentheses end the URL. Trailing sentence punctuation stays outside.
const URL_CHARACTER = String.raw`[^\s<>()"'\x60]`;
const URL_GROUP = String.raw`\(${URL_CHARACTER}*\)`;
const BARE_URL = String.raw`https?://(?:${URL_CHARACTER}|${URL_GROUP})*(?:[^\s<>()"'\x60.,;:!?]|${URL_GROUP})`;

const FILE_PATTERN = createFilePattern(PROSE_PATH);
function linkMetadata(inlineCodePaths: ReadonlySet<string>) {
  // The engine accepts regexes on both platforms. Classify complete code spans
  // first, then pass literal matches rather than maintaining a second path grammar.
  const alternatives = [...inlineCodePaths].map((path) =>
    path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return {
    linkRecognition: {
      text: FILE_PATTERN,
      inlineCode: new RegExp(
        String.raw`^(?:https?://[^\s<>]+${alternatives.length ? `|${alternatives.join("|")}` : ""})$`,
      ),
    },
    linkSource: markdownLinkSource,
  };
}

function collectInlineCodePaths(source: string, workspaceRoot?: string): Set<string> {
  const paths = new Set<string>();
  const previousEnds = new Map<number, number>();
  // Collect candidates between consecutive runs of equal length. The engine owns
  // Markdown context (escapes, fences, authored links); extra candidates are harmless
  // because recognition only applies to complete Code nodes. This avoids an AST
  // parse on every streaming reveal, including updates inside long code fences.
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

export function markdownLinkSource(
  url: string,
  sourceType?: "markdown" | "text" | "inline-code",
): AssistantFileLinkSource {
  if (sourceType === "inline-code") return { href: url, text: url, sourceType };
  if (sourceType === "text") return { href: url, text: url, markup: "linkify" };
  return { href: url, text: url };
}

// Generated by scripts/generate-markdown-image-placeholder.mjs; reserves the image box.
export const PENDING_MARKDOWN_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAoAAAAKACAYAAAAMzckjAAAACXBIWXMAAAsTAAALEwEAmpwYAAAKBklEQVR42u3dXWscVRgH8ElFLK032tiCN1nSEiiowdKAn8DY2rR+AG965Qt4Y24Sm91kd5tN1ogQaGzzFfIl43Nki+s4u+m+ZWfC7weH0M6Z2QPn5s8zc87JMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgKvm/Px8YXd3d7Hdbi/Ns6UxxHAWzAgAwIxE4LrebDafxd/f9/b2TkvSujGep2lsZggAYIr29/c/iZDVKlHwy7dmryIIAEA2hcpfo9Folzj89YdAlUAAgEml174VCH//tBjrhhkDAMgmXvDxn2/+4t+von0dbXmOC0CW6/X6ehpL/9iiUtnNLAwBAMgmef27mK+ypfCXlac6uZ4fX6fTuWXmAADGD4C1fMCKCtzdsowvjaUgoNbMHADA+AFwuSBgLRsfAIAAmL/vRrSVVqu1mipy0a4JgAAAVzAAbm9v34nrP0a/17l7/oz25PT09H0BEADgigTAnZ2d+3H9eNg2LXHvb9E+FAABACoeAFPl76Lw13f/r9mUtmoRAAEA5hQAe69933nD5uj/UAAEAKhoAOwt+Pgr1+cwFoB8Hn9vx159j+Lvm9xzfhEAAQCqGwBXCvp80d8n/u957vofAiAAQEUDYCz+WC3oczv3nMe5I9tOBEAAgOpWAP93Wkh67fv2+tnZ2Xtp9W+uz74ACABQ3QB4Le3zl+uTvvl73qv8vSh4xvcCIABAhVcB1+v1jRFWAb+OZ3x60RnE0b6Lvj+kFhXFZ3Hu75IACABQkgCYTvgoeM07aAuYx4N+7+jo6GZc/3nI/T9tbm7eFAABAEpwEkg64SOubw6r/EUl79tswCbQW1tbH8XikPZFATL1SX0FQACAEpwFnMJd2uQ57fMX7SjaSVrwkb75G/baNwW6uP5yhI2kX/buEQABAOYcAEd2Qfh7Edd2BoXA2Gx6VQAEAKhQABwU/tLJIrGwZC37d5HJWv60kd7r4K4ACABQkQCYwl88rz3gW8G1fP+o9n1ZFAIFQACACgTAUcPfKCFQAAQAKFkAHDf8vWsIFAABAEoUAId98xftwQjjejAoBHY6nXtmDgCgBAFwWuGvPwSmqmHB874ycwAAcw6A0w5/b8Ur40f5Z8Yr4vtmDgBgjgFwVuHPSSAAACUMgJMu+BAAAQAqFABnHf4EQACAEgXAywh/AiAAQEkC4GWFPwEQAKAEAfAyw58ACAAw5wB42eFPAAQAmE3AquUDVrvdvluG8Ncb372CAFgzcwAA4wesxXzAqtfr62UIf73xfVNwFNwtMwcAML6FCFXdXIXtVQS79fSqNdpn0Q4LqnBv0ikdUS1cmkVLv52e32g0TnK/e5jGbNoAALKJqmxPC6p7pWwx1idmDABg8gB4PcJVswLhb+/4+PgDMwYAMKVvAaO1yhz+0hjNFADAFKXqWnx3txHf3XVLFPwO02tflT8AgNlaSCtt02KMg4ODWlrpGyFsZVYLPoYsBPnYgg8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOBK+hsMQ7RDjzvGwwAAAABJRU5ErkJggg==";

export interface MarkdownImage {
  source: string;
  alt: string;
  title: string | null;
  start: number;
  end: number;
}

function workspaceHoverTitle(link: Link, markup: string, workspaceRoot?: string): string | null {
  if (link.title !== null || !workspaceRoot || !link.url.startsWith(`${workspaceRoot}/`))
    return null;
  // mdast represents both missing titles and authored empty titles as null.
  if (/\s(?:""|''|\(\))\s*\)$/.test(markup)) return null;
  return link.url.slice(workspaceRoot.length + 1);
}

/** Preserve source spelling; adapt workspace images, spoiler delimiters, and entity text. */
export function prepareMarkdownSource(
  source: string,
  workspaceRoot?: string,
  options: { supportsSvg?: boolean } = {},
) {
  source = normalizeMarkdownHtml(source);
  const images: MarkdownImage[] = [];
  let tree: Root | undefined;
  const getTree = () =>
    (tree ??= fromMarkdown(source, {
      extensions: [gfmTable()],
      mdastExtensions: [gfmTableFromMarkdown()],
    }));
  const inlineCodePaths = collectInlineCodePaths(source, workspaceRoot);
  const edits: { start: number; end: number; text: string }[] = [];
  if (
    !source.includes("![") &&
    !source.includes("||") &&
    !source.includes("&") &&
    !source.includes("```") &&
    !source.includes("~~~") &&
    !(workspaceRoot && source.includes("]("))
  ) {
    return { images, ...linkMetadata(inlineCodePaths), render: () => source };
  }

  const definitions = new Map<string, { url: string; title?: string | null }>();
  function definitionsIn(node: Nodes) {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if ("children" in node) node.children.forEach(definitionsIn);
  }
  definitionsIn(getTree());
  function collectImage(
    node: Extract<Nodes, { type: "image" | "imageReference" }>,
    start: number,
    end: number,
  ) {
    const target = node.type === "image" ? node : definitions.get(node.identifier);
    if (
      target &&
      options.supportsSvg === false &&
      /(?:\.svg(?:[?#]|$)|^data:image\/svg\+xml)/i.test(target.url)
    ) {
      edits.push({ start, end, text: escapeMarkdownText(node.alt ?? "") });
      return;
    }
    if (target)
      images.push({
        source: target.url,
        alt: node.alt ?? "",
        title: target.title ?? null,
        start,
        end,
      });
  }
  // Line boundaries already turned into paragraph breaks, by offset of their newline.
  const splitBoundaries = new Set<number>();
  function isImageLike(node: PhrasingContent): boolean {
    if (node.type === "image" || node.type === "imageReference") return true;
    return (
      (node.type === "link" || node.type === "linkReference") &&
      node.children.length === 1 &&
      isImageLike(node.children[0])
    );
  }
  // An image alone on its line becomes its own paragraph, so every platform renders
  // it as a block. The library only treats sole-child paragraph images as blocks;
  // with hardSoftBreaks every newline is a break node, which made these inline.
  function splitStandaloneImages(paragraph: Paragraph, start: number, end: number) {
    for (const child of paragraph.children) {
      const childStart = child.position?.start.offset;
      const childEnd = child.position?.end.offset;
      if (childStart === undefined || childEnd === undefined || !isImageLike(child)) continue;
      const lineStart = source.lastIndexOf("\n", childStart - 1) + 1;
      const newline = source.indexOf("\n", childEnd);
      const lineEnd = newline === -1 ? source.length : newline;
      const prefix = source.slice(lineStart, childStart);
      const suffix = source.slice(childEnd, lineEnd);
      const aloneBefore = childStart === start || /^[\s>]*$/.test(prefix);
      const aloneAfter = /^\s*\\?$/.test(suffix);
      if (!aloneBefore || !aloneAfter) continue;
      // Continuation lines inside quotes and lists keep their quote markers on the blank line.
      const blank = prefix.replace(/[^>]/g, " ").trimEnd();
      const split = (boundary: number) => {
        if (splitBoundaries.has(boundary)) return;
        splitBoundaries.add(boundary);
        // A trailing backslash was a hard break; at a paragraph end it would render literally.
        const cut = source[boundary - 1] === "\\" ? boundary - 1 : boundary;
        edits.push({ start: cut, end: boundary + 1, text: `\n${blank}\n` });
      };
      if (lineStart > start) split(lineStart - 1);
      if (lineEnd < end) split(lineEnd);
    }
  }
  // A fence that holds nothing but file paths is a list of files, not code. It renders as
  // inline code, one path per line, so each path gets the link and its menu.
  function rewritePathFence(start: number, end: number, value: string) {
    const raw = source.slice(start, end);
    const marker = /^(`{3,}|~{3,})/.exec(raw)?.[1];
    // Inside a quote every fence line carries the `>` markers.
    const lastLine = raw
      .slice(raw.lastIndexOf("\n") + 1)
      .replace(/^[\s>]*/, "")
      .trim();
    const closed =
      marker !== undefined &&
      raw.includes("\n") &&
      lastLine.length >= marker.length &&
      [...lastLine].every((character) => character === marker[0]);
    if (!closed) return;
    const paths = value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (paths.length === 0 || paths.length > MAX_PATH_FENCE_LINES) return;
    // Quoted or backticked lines are code that mentions a path, not a path.
    const allFiles = paths.every((path) => {
      if (/^[`'"]|[`'"]$/.test(path)) return false;
      const classification = classifyAssistantFileLink(path, { workspaceRoot });
      return classification !== null && classification.kind !== "external";
    });
    if (!allFiles) return;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const prefix = source.slice(lineStart, start);
    // Continuation lines keep quote markers and list indentation.
    const continuation = prefix.replace(/[^>]/g, " ");
    const blank = continuation.trimEnd();
    for (const path of paths) inlineCodePaths.add(path);
    // Blank lines keep the paths out of the paragraphs a fence may sit against.
    const previousLine = source.slice(source.lastIndexOf("\n", lineStart - 2) + 1, lineStart - 1);
    if (lineStart > 0 && previousLine.trim())
      edits.push({ start: lineStart - 1, end: lineStart, text: `\n${blank}\n` });
    const after = end < source.length ? `\n${blank}` : "";
    edits.push({
      start,
      end,
      text: paths.map(toInlineCode).join(`\n${continuation}`) + after,
    });
  }
  function visit(node: Nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "code") {
        rewritePathFence(start, end, node.value);
        return;
      }
      if (node.type === "paragraph") splitStandaloneImages(node, start, end);
      if (node.type === "link") {
        const title = workspaceHoverTitle(node, source.slice(start, end), workspaceRoot);
        if (title !== null)
          edits.push({ start: end - 1, end: end - 1, text: ` ${JSON.stringify(title)}` });
      }
      if (node.type === "tableRow") {
        // MD4C's always-enabled spoiler extension otherwise consumes adjacent cell
        // delimiters. Spaces keep empty GFM cells empty without producing spoilers.
        const row = source.slice(start, end);
        for (const match of row.matchAll(/(?<!\\)\|(?=\|)/g)) {
          edits.push({ start: start + match.index + 1, end: start + match.index + 1, text: " " });
        }
      }
      if (node.type === "image" || node.type === "imageReference") {
        collectImage(node, start, end);
        return;
      }
      if (node.type === "text") {
        const text = source
          .slice(start, end)
          .replace(/(?<!\\)&(?:#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]+);/g, (entity) =>
            decodeString(entity).replace(/[!-/:-@[-`{-~]/g, "\\$&"),
          )
          .replace(/(?<!\\)\|\|/g, "\\|\\|");
        if (text !== source.slice(start, end)) edits.push({ start, end, text });
      }
    }
    if ("children" in node) node.children.forEach(visit);
  }
  visit(getTree());
  return {
    images,
    ...linkMetadata(inlineCodePaths),
    render(
      urls: ReadonlyMap<string, string> = new Map(),
      unavailableImages: ReadonlySet<string> = new Set(),
      pendingImages: ReadonlySet<string> = new Set(),
    ) {
      const replacements = [...edits];
      for (const image of images) {
        const unavailable = unavailableImages.has(image.source);
        const pending = pendingImages.has(image.source);
        if (!unavailable && !pending && /^(https?:|data:|blob:)/i.test(image.source)) continue;
        let url = unavailable ? undefined : urls.get(image.source);
        if (pending && !unavailable) url = PENDING_MARKDOWN_IMAGE;
        replacements.push({
          start: image.start,
          end: image.end,
          text: url
            ? `![${image.alt.replace(/[[\]\\]/g, "\\$&")}](<${url}>${image.title ? ` ${JSON.stringify(image.title)}` : ""})`
            : escapeMarkdownText(image.alt),
        });
      }
      let result = source;
      for (const edit of replacements.sort((a, b) => b.start - a.start)) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      }
      return result;
    },
  };
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}

// Longer fences are listings, not a handful of files to open.
const MAX_PATH_FENCE_LINES = 20;

function toInlineCode(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const ticks = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}
