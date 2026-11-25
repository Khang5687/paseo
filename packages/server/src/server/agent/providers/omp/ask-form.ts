/**
 * What Paseo reads from an OMP `ask` form (`{ html }`, OMP 18.18.3+).
 *
 * Over RPC, OMP walks the form's named fields one prompt at a time
 * (`select`/`input`/`editor`) and drops two things on the way: the form's context
 * text, and which options the form preselected. A checkbox walk toggles rows, so
 * replaying the user's choices needs the preselected rows. This is a scan, not a
 * DOM: it finds controls and context blocks, which is all the walk needs.
 */

/** A radio group, checkbox group or `<select>`, in the order OMP walks them. */
export interface OmpAskChoiceField {
  multi: boolean;
  required: boolean;
  /** Whether each option OMP lists (disabled ones dropped) is preselected. */
  checked: boolean[];
}

export interface OmpAskForm {
  /** The form's paragraphs, list items, headings and preformatted text, as Markdown. */
  context: string;
  choices: OmpAskChoiceField[];
}

interface ScannedOption {
  checked: boolean;
  disabled: boolean;
}

interface ScannedChoice {
  multi: boolean;
  required: boolean;
  options: ScannedOption[];
}

interface ContextBlock {
  tag: string;
  text: string;
  hasControl: boolean;
}

interface FormScan {
  choices: ScannedChoice[];
  /** Radio and checkbox groups by type and name; a group is one field. */
  groups: Map<string, ScannedChoice>;
  blocks: ContextBlock[];
  block: ContextBlock | null;
  select: ScannedChoice | null;
  skipText: number;
}

const TOKEN =
  /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const CONTEXT_TAGS: Record<string, true> = {
  p: true,
  li: true,
  pre: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
};
const CONTROL_TAGS: Record<string, true> = { input: true, select: true, textarea: true };
/** Text inside these never reaches the context: option labels, textarea defaults, code. */
const SKIPPED_TEXT_TAGS: Record<string, true> = {
  option: true,
  textarea: true,
  script: true,
  style: true,
};
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function readAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function blockMarkdown(block: ContextBlock): string {
  if (block.tag === "pre") {
    const text = block.text.replace(/^\n+|\s+$/g, "");
    return text ? `\`\`\`\n${text}\n\`\`\`` : "";
  }
  const text = block.text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (block.tag === "li") return `- ${text}`;
  return block.tag.startsWith("h") ? `**${text}**` : text;
}

function contextMarkdown(blocks: ContextBlock[]): string {
  let context = "";
  let previousTag = "";
  for (const block of blocks) {
    const markdown = blockMarkdown(block);
    if (!markdown) continue;
    // Consecutive list items stay one tight Markdown list.
    if (context) context += block.tag === "li" && previousTag === "li" ? "\n" : "\n\n";
    context += markdown;
    previousTag = block.tag;
  }
  return context;
}

function addChoiceInput(scan: FormScan, attributes: Map<string, string>): void {
  const type = attributes.get("type")?.toLowerCase();
  const name = attributes.get("name");
  if ((type !== "radio" && type !== "checkbox") || !name) return;
  const option = { checked: attributes.has("checked"), disabled: attributes.has("disabled") };
  const key = `${type}\0${name}`;
  const group = scan.groups.get(key);
  if (group) {
    group.options.push(option);
    group.required ||= attributes.has("required");
    return;
  }
  const field = {
    multi: type === "checkbox",
    required: attributes.has("required"),
    options: [option],
  };
  scan.groups.set(key, field);
  scan.choices.push(field);
}

function openTag(scan: FormScan, tag: string, attributes: Map<string, string>): void {
  if (CONTEXT_TAGS[tag] && !scan.block) scan.block = { tag, text: "", hasControl: false };
  else if (tag === "br" && scan.block) scan.block.text += "\n";
  if (CONTROL_TAGS[tag] && scan.block) scan.block.hasControl = true;
  if (SKIPPED_TEXT_TAGS[tag]) scan.skipText++;

  if (tag === "select") {
    const field: ScannedChoice = {
      multi: attributes.has("multiple"),
      required: attributes.has("required"),
      options: [],
    };
    // OMP skips unnamed fields, so an unnamed select still takes its options.
    if (attributes.get("name")) scan.choices.push(field);
    scan.select = field;
  } else if (tag === "option" && scan.select) {
    scan.select.options.push({
      checked: attributes.has("selected"),
      disabled: attributes.has("disabled"),
    });
  } else if (tag === "input") {
    addChoiceInput(scan, attributes);
  }
}

function closeTag(scan: FormScan, tag: string): void {
  if (tag === "select") scan.select = null;
  if (SKIPPED_TEXT_TAGS[tag]) scan.skipText = Math.max(0, scan.skipText - 1);
  if (scan.block && tag === scan.block.tag) {
    if (!scan.block.hasControl) scan.blocks.push(scan.block);
    scan.block = null;
  }
}

export function parseOmpAskForm(html: string): OmpAskForm {
  const scan: FormScan = {
    choices: [],
    groups: new Map(),
    blocks: [],
    block: null,
    select: null,
    skipText: 0,
  };
  for (const [, closing, rawTag, rawAttributes, text] of html.matchAll(TOKEN)) {
    if (text !== undefined) {
      if (scan.block && scan.skipText === 0) scan.block.text += decodeEntities(text);
    } else if (rawTag && closing) {
      closeTag(scan, rawTag.toLowerCase());
    } else if (rawTag) {
      openTag(scan, rawTag.toLowerCase(), readAttributes(rawAttributes ?? ""));
    }
  }

  return {
    context: contextMarkdown(scan.blocks),
    choices: scan.choices.map((choice) => ({
      multi: choice.multi,
      required: choice.required,
      checked: choice.options.filter((option) => !option.disabled).map((option) => option.checked),
    })),
  };
}
