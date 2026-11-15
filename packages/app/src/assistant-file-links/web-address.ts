import { ASSISTANT_FILE_EXTENSIONS } from "./extensions";

// The Markdown text pattern (components/markdown/source.ts) and the tap resolver share these,
// so a link the renderer draws is one the resolver can open. Keep them in the regex syntax
// shared by JavaScript, ICU and java.util.regex.

/** A segment that reads as a host (`github.com`, `v1.2`) never starts a workspace path. */
export const DOMAIN_LIKE_SEGMENT = String.raw`[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`;

// Quotes and unbalanced closing parentheses end a URL. Trailing sentence punctuation stays outside.
const URL_CHARACTER = String.raw`[^\s<>()"'\x60]`;
const URL_GROUP = String.raw`\(${URL_CHARACTER}*\)`;
/** Everything after `scheme://` or after a bare host. */
export const URL_TAIL = String.raw`(?:${URL_CHARACTER}|${URL_GROUP})*(?:[^\s<>()"'\x60.,;:!?]|${URL_GROUP})`;

// A file extension as the last label is a product name in prose (`Node.js/Deno`), not a host.
const EXTENSION_LABEL = [...ASSISTANT_FILE_EXTENSIONS]
  .filter((extension) => /^[a-z0-9]+$/.test(extension))
  .join("|");
/**
 * A host with a lowercase letters-only top-level domain, then a path, written without a scheme:
 * `github.com/owner/repo`. Agents write repositories and docs pages this way.
 */
export const BARE_WEB_ADDRESS = String.raw`(?:[A-Za-z0-9-]+\.)+(?!(?:${EXTENSION_LABEL})/)[a-z]{2,}/${URL_TAIL}`;

const WHOLE_BARE_WEB_ADDRESS = new RegExp(String.raw`^${BARE_WEB_ADDRESS}$`);
const WHOLE_DOMAIN_LIKE_SEGMENT = new RegExp(String.raw`^${DOMAIN_LIKE_SEGMENT}$`);

/** The https URL that schemeless text like `github.com/owner/repo` names, or null. */
export function bareWebAddressUrl(value: string): string | null {
  return WHOLE_BARE_WEB_ADDRESS.test(value) ? `https://${value}` : null;
}

export function isDomainLikeSegment(segment: string): boolean {
  return WHOLE_DOMAIN_LIKE_SEGMENT.test(segment);
}
