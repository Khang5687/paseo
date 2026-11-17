import { fromMarkdown } from "mdast-util-from-markdown";
import type { Code, Definition, RootContent } from "mdast";

type ExtractedFence =
  | { kind: "mermaid"; source: string }
  /** `meta`: the info string after the language, where a fence names its run host. */
  | { kind: "shell"; source: string; language: string; meta: string | null };

export type FenceSegment = (ExtractedFence | { kind: "markdown"; source: string }) & { id: string };

/** Decides whether a fence leaves the library to get a Run control. */
export type IsShellFence = (language: string, code: string, meta: string | null) => boolean;

/**
 * Native enriched-markdown has no fenced-block override. Diagrams, and shell fences when the
 * message can run them, leave its engine as separate views. Web keeps diagrams in the engine
 * (`diagrams: false`) and splits only shell fences whose info string the engine drops.
 */
export function splitNativeFences(
  markdown: string,
  isShellFence: IsShellFence | null = null,
  options: { diagrams?: boolean } = {},
): FenceSegment[] {
  const diagrams = options.diagrams ?? true;
  const mayHaveShell = isShellFence !== null && /```|~~~/.test(markdown);
  if (!(diagrams && /mermaid/i.test(markdown)) && !mayHaveShell)
    return [{ kind: "markdown", id: "0", source: markdown }];
  const segments: FenceSegment[] = [];
  const definitions = new Map<string, Definition>();
  let cursor = 0;
  function extract(node: Code): ExtractedFence | null {
    if (diagrams && node.lang?.toLowerCase() === "mermaid")
      return { kind: "mermaid", source: node.value };
    const meta = node.meta ?? null;
    if (isShellFence?.(node.lang ?? "", node.value, meta))
      return { kind: "shell", source: node.value, language: node.lang ?? "", meta };
    return null;
  }
  function visit(node: RootContent): void {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    const fence = node.type === "code" && node.position ? extract(node) : null;
    if (fence && node.position) {
      const start = node.position.start.offset!;
      if (start > cursor)
        segments.push({
          kind: "markdown",
          id: String(segments.length),
          source: markdown.slice(cursor, start),
        });
      segments.push({ ...fence, id: String(segments.length) });
      cursor = node.position.end.offset!;
    } else if ("children" in node) node.children.forEach(visit);
  }
  const tree = fromMarkdown(markdown);
  tree.children.forEach(visit);
  if (cursor < markdown.length || segments.length === 0)
    segments.push({
      kind: "markdown",
      id: String(segments.length),
      source: markdown.slice(cursor),
    });
  // Prepend the document's first definitions after splitting, so fragment-local
  // duplicates cannot override them. Original source slices and fence offsets stay intact.
  if (segments.some((segment) => segment.kind !== "markdown")) {
    const referenceSource = [...definitions.values()]
      .map((node) => {
        const label = node.identifier.replace(/[\\[\]]/g, "\\$&");
        const url = node.url.replace(/[\\<>]/g, "\\$&");
        const title = node.title ? ` "${node.title.replace(/[\\"]/g, "\\$&")}"` : "";
        return `[${label}]: <${url}>${title}`;
      })
      .join("\n");
    if (referenceSource)
      for (const segment of segments) {
        if (segment.kind === "markdown") segment.source = `${referenceSource}\n\n${segment.source}`;
      }
  }
  return segments;
}
