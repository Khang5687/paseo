import { getForgeDefinitionOrNeutral } from "@getpaseo/protocol/forge-manifest";
import type { AgentAttachment, InlineAttachmentRef } from "@getpaseo/protocol/messages";
import type { UserMessageAttachmentFile } from "@getpaseo/protocol/agent-types";
import type { AgentPromptContentBlock, AgentPromptInput } from "./agent-sdk-types.js";

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

export function buildAgentPrompt(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
  attachments?: AgentAttachment[],
  attachmentRefs?: InlineAttachmentRef[],
  // Where the daemon saved each image (see saveInlineImages), in image order.
  imagePaths?: readonly string[],
): AgentPromptInput {
  const normalized = text.trim();
  const hasImages = (images?.length ?? 0) > 0;
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!hasImages && !hasAttachments) {
    return normalized;
  }

  const imageLabels = new Map<number, string>();
  const attachmentLabels = new Map<number, string>();
  for (const ref of attachmentRefs ?? []) {
    if (ref.imageIndex !== undefined && images?.[ref.imageIndex]) {
      imageLabels.set(ref.imageIndex, ref.label);
    } else if (ref.attachmentIndex !== undefined && attachments?.[ref.attachmentIndex]) {
      attachmentLabels.set(ref.attachmentIndex, ref.label);
    }
  }

  const chatHistoryAttachments: AgentAttachment[] = [];
  const otherAttachments: AgentPromptContentBlock[] = [];
  (attachments ?? []).forEach((attachment, index) => {
    if (attachment.type === "text" && attachment.contextKind === "chat_history") {
      chatHistoryAttachments.push(attachment);
      return;
    }
    const label = attachmentLabels.get(index);
    if (label === undefined) {
      otherAttachments.push(attachment);
    } else if (attachment.type === "uploaded_file") {
      otherAttachments.push(inlineRefNote(`[${label}]: ${attachment.path}`));
    } else {
      otherAttachments.push(inlineRefNote(`[${label}]:`), attachment);
    }
  });

  const blocks: AgentPromptContentBlock[] = [...chatHistoryAttachments];
  if (normalized.length > 0) {
    const placeholders = [...imageLabels.values(), ...attachmentLabels.values()]
      .map((label) => `[${label}]`)
      .filter((placeholder) => normalized.includes(placeholder));
    blocks.push(
      placeholders.length > 0
        ? { type: "text", text: normalized, placeholders }
        : { type: "text", text: normalized },
    );
  }
  (images ?? []).forEach((image, index) => {
    const path = imagePaths?.[index];
    const label =
      imageLabels.get(index) ?? (path === undefined ? undefined : `Image #${index + 1}`);
    if (label !== undefined) blocks.push(inlineRefNote(`[${label}]:${path ? ` ${path}` : ""}`));
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  });
  blocks.push(...otherAttachments);
  return blocks;
}

// Labels ride as text attachments: every adapter already renders them in prompt order, and the
// mimeType keeps them out of the submitted user message text (see submittedPromptText).
function inlineRefNote(text: string): AgentAttachment {
  return { type: "text", mimeType: "text/plain", text };
}

// The notes buildAgentPrompt adds: `[Image #1]: <absolute path>` (older history: `[Image #1]:`
// alone), `[File #2]: <absolute path>`.
const INLINE_REF_NOTE_LINE = /^\[((?:Image|File) #\d+)\]:(?: ((?:\/|[A-Za-z]:[\\/]).*))?$/;

function parseInlineRefNote(line: string): { file: UserMessageAttachmentFile | null } | null {
  const match = INLINE_REF_NOTE_LINE.exec(line.trim());
  if (!match) return null;
  const label = match[1] ?? "";
  const path = match[2];
  if (path === undefined) return label.startsWith("File ") ? null : { file: null };
  return { file: { label, path } };
}

/**
 * Provider history replays a user turn as all of its text, including the label notes the user
 * never typed. Split those lines off, so the replayed message matches what was sent, and keep the
 * paths they name: they are how a replayed message finds its images again.
 */
export function splitInlineRefNotes(text: string): {
  text: string;
  files: UserMessageAttachmentFile[];
} {
  const lines = text.split("\n");
  const kept: string[] = [];
  const files: UserMessageAttachmentFile[] = [];
  for (const line of lines) {
    const note = parseInlineRefNote(line);
    if (!note) kept.push(line);
    else if (note.file) files.push(note.file);
  }
  if (kept.length === lines.length) return { text, files };
  return {
    text: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    files,
  };
}

export function renderPromptAttachmentAsText(attachment: AgentAttachment): string {
  switch (attachment.type) {
    case "forge_change_request": {
      return renderChangeRequestAttachment({
        forge: attachment.forge,
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        projectPath: attachment.projectPath,
        baseRefName: attachment.baseRefName,
        headRefName: attachment.headRefName,
      });
    }
    // COMPAT(githubAttachmentKinds): render legacy wire attachments until
    // 2027-01-17, when supported client and daemon floors are >= v0.2.0.
    case "github_pr": {
      return renderChangeRequestAttachment({
        forge: "github",
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        baseRefName: attachment.baseRefName,
        headRefName: attachment.headRefName,
      });
    }
    case "forge_issue": {
      return renderIssueAttachment({
        forge: attachment.forge,
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
        projectPath: attachment.projectPath,
      });
    }
    // COMPAT(githubAttachmentKinds): render legacy wire attachments until
    // 2027-01-17, when supported client and daemon floors are >= v0.2.0.
    case "github_issue": {
      return renderIssueAttachment({
        forge: "github",
        number: attachment.number,
        title: attachment.title,
        url: attachment.url,
        body: attachment.body,
      });
    }
    case "text": {
      return attachment.text;
    }
    case "review": {
      const lines = [`Paseo review attachment (${attachment.mode})`, `CWD: ${attachment.cwd}`];
      if (attachment.baseRef) {
        lines.push(`Base: ${attachment.baseRef}`);
      }
      attachment.comments.forEach((comment, index) => {
        lines.push(
          "",
          `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
          comment.body,
          comment.context.hunkHeader,
        );
        const target = comment.context.targetLine;
        for (const line of comment.context.lines) {
          const isTarget =
            line.oldLineNumber === target.oldLineNumber &&
            line.newLineNumber === target.newLineNumber &&
            line.type === target.type &&
            line.content === target.content;
          const prefix = isTarget ? "> " : "  ";
          const oldLn = padLineNumber(line.oldLineNumber);
          const newLn = padLineNumber(line.newLineNumber);
          lines.push(`${prefix}${oldLn} ${newLn} ${REVIEW_LINE_MARKERS[line.type]}${line.content}`);
        }
      });
      return lines.join("\n");
    }
    case "uploaded_file": {
      return [
        `Uploaded file: ${attachment.fileName}`,
        `Path: ${attachment.path}`,
        `MIME: ${attachment.mimeType}`,
        `Size: ${attachment.size} bytes`,
      ].join("\n");
    }
    default:
      throw new Error("unreachable");
  }
}

function renderChangeRequestAttachment(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
  baseRefName?: string | null;
  headRefName?: string | null;
}): string {
  const lines = [
    `${formatForgeLabel(input.forge)} ${formatChangeRequestAbbrev(input.forge)} ${formatChangeRequestNumber(input.forge, input.number)}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) {
    lines.push(`Project: ${input.projectPath}`);
  }
  if (input.baseRefName) {
    lines.push(`Base: ${input.baseRefName}`);
  }
  if (input.headRefName) {
    lines.push(`Head: ${input.headRefName}`);
  }
  if (input.body) {
    lines.push("", input.body);
  }
  return lines.join("\n");
}

function renderIssueAttachment(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
}): string {
  const lines = [
    `${formatForgeLabel(input.forge)} Issue ${formatIssueNumber(input.forge, input.number)}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) {
    lines.push(`Project: ${input.projectPath}`);
  }
  if (input.body) {
    lines.push("", input.body);
  }
  return lines.join("\n");
}

function formatForgeLabel(forge: string): string {
  return getForgeDefinitionOrNeutral(forge).displayName;
}

function formatChangeRequestAbbrev(forge: string): string {
  return getForgeDefinitionOrNeutral(forge).changeRequestAbbrev;
}

function formatChangeRequestNumber(forge: string, number: number): string {
  return `${getForgeDefinitionOrNeutral(forge).changeRequestNumberPrefix}${number}`;
}

function formatIssueNumber(forge: string, number: number): string {
  return `${getForgeDefinitionOrNeutral(forge).issueNumberPrefix}${number}`;
}

function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}

export function buildAgentBranchNameSeed(
  firstAgentContext: { prompt?: string; attachments?: readonly AgentAttachment[] } | undefined,
): string | undefined {
  if (!firstAgentContext) {
    return undefined;
  }
  const parts: string[] = [];
  const prompt = firstAgentContext.prompt?.trim();
  if (prompt) {
    parts.push(["<user-prompt>", prompt, "</user-prompt>"].join("\n"));
  }
  const renderedAttachments: string[] = [];
  for (const attachment of firstAgentContext.attachments ?? []) {
    const rendered = renderPromptAttachmentAsText(attachment).trim();
    if (rendered) {
      renderedAttachments.push(rendered);
    }
  }
  if (renderedAttachments.length > 0) {
    parts.push(["<attachments>", renderedAttachments.join("\n\n"), "</attachments>"].join("\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
