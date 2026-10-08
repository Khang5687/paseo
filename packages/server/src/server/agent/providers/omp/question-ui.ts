import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "../../agent-sdk-types.js";
import {
  OmpAskDialogQuestionSchema,
  type OmpAgentMessage,
  type OmpAskDialogAnswer,
  type OmpAskDialogQuestion,
  type OmpExtensionUiResponse,
  type OmpRuntimeEvent,
} from "./rpc-types.js";

type UiRequest = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;
type SendResponse = (id: string, response: OmpExtensionUiResponse) => void;

const OTHER = "Other (type your own)";
const ANSWER_HEADER = "Response";
const RECOMMENDED_SUFFIX = " (Recommended)";

interface SelectOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  title: string;
  multi: boolean;
  options: SelectOption[];
}

interface PendingAnswer {
  question: AskQuestion;
  selected: string[];
  custom: string | null;
  next: "select" | "editor";
}

/** What `respond` needs to turn Paseo's answers back into OMP's `ask` answers. */
interface AskDialogQuestionRef {
  id: string;
  header: string;
  /** OMP's option labels, aligned with `displayLabels`. */
  labels: string[];
  displayLabels: string[];
  multi: boolean;
  notes: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readSelectOptions(event: UiRequest): SelectOption[] {
  const details = Array.isArray(event.optionDetails) ? event.optionDetails : [];
  return (event.options ?? []).map((label, index) => {
    const description = string(record(details[index])?.description);
    return description?.trim() ? { label, description } : { label };
  });
}

function isOptionalInput(placeholder: string | undefined): boolean {
  return /\boptional\b|\bskip\b/i.test(placeholder ?? "");
}

function inputTitle(title: string | undefined, placeholder: string | undefined): string {
  if (!isOptionalInput(placeholder)) return title ?? "Enter a value";
  return /\bcomment\b/i.test(`${title ?? ""}\n${placeholder ?? ""}`)
    ? "Optional comment"
    : "Optional response";
}

function genericQuestion(
  event: UiRequest,
  provider: AgentProvider,
  title: string,
  options: SelectOption[],
  input: { placeholder?: string; allowEmpty?: boolean; dismissLabel?: string } = {},
): AgentPermissionRequest {
  return {
    id: event.id,
    provider,
    name: `OMP ${event.method}`,
    kind: "question",
    title,
    input: {
      questions: [
        { question: title, header: ANSWER_HEADER, options, multiSelect: false, ...input },
      ],
    },
    metadata: { extensionUiMethod: event.method, answerHeader: ANSWER_HEADER },
  };
}

function mapGenericQuestion(
  event: UiRequest,
  provider: AgentProvider,
): AgentPermissionRequest | null {
  switch (event.method) {
    case "select":
      return genericQuestion(
        event,
        provider,
        event.title ?? "Select an option",
        readSelectOptions(event),
      );
    case "input": {
      const placeholder = event.placeholder;
      const optional = isOptionalInput(placeholder);
      return genericQuestion(event, provider, inputTitle(event.title, placeholder), [], {
        ...(placeholder ? { placeholder } : {}),
        ...(optional ? { allowEmpty: true, dismissLabel: "Skip" } : {}),
      });
    }
    case "editor":
      return genericQuestion(event, provider, event.title ?? "Edit text", []);
    case "confirm":
      return genericQuestion(
        event,
        provider,
        [event.title, event.message].filter(Boolean).join("\n\n"),
        [{ label: "Yes" }, { label: "No" }],
      );
    default:
      return null;
  }
}

function genericResponse(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): OmpExtensionUiResponse {
  if (response.behavior === "deny") return { cancelled: true };
  const answers = record(response.updatedInput?.answers);
  const answer = Object.values(answers ?? {}).find(
    (value): value is string => typeof value === "string",
  );
  if (answer === undefined) return { cancelled: true };
  return request.metadata?.extensionUiMethod === "confirm"
    ? { confirmed: /^yes$/i.test(answer.trim()) }
    : { value: answer };
}

/** Paseo keys answers by header, so each must be unique; OMP's optional header is a display chip that may repeat. */
function askDialogHeaders(questions: OmpAskDialogQuestion[]): string[] {
  const headers = questions.map((question) => question.header?.trim() || question.id);
  return new Set(headers).size === headers.length
    ? headers
    : questions.map((question) => question.id);
}

function mapAskDialog(
  event: UiRequest,
  provider: AgentProvider,
  notes: boolean,
): AgentPermissionRequest | null {
  const parsed = OmpAskDialogQuestionSchema.array().min(1).safeParse(event.questions);
  if (!parsed.success) return null;
  const questions = parsed.data;
  const headers = askDialogHeaders(questions);
  const refs: AskDialogQuestionRef[] = [];
  const paseoQuestions = questions.map((question, index) => {
    const header = headers[index] ?? question.id;
    const options = question.options.map((option, optionIndex) => {
      const label =
        optionIndex === question.recommended
          ? `${option.label}${RECOMMENDED_SUFFIX}`
          : option.label;
      const description = option.description?.trim();
      return description ? { label, description } : { label };
    });
    refs.push({
      id: question.id,
      header,
      labels: question.options.map((option) => option.label),
      displayLabels: options.map((option) => option.label),
      multi: question.multi === true,
      notes,
    });
    return {
      question: question.question,
      header,
      options,
      multiSelect: question.multi === true,
      // OMP never lists "Other"; hosts always offer free text.
      allowOther: true,
      ...(notes ? { allowNotes: true } : {}),
    };
  });
  return {
    id: event.id,
    provider,
    name: "OMP ask",
    kind: "question",
    title: questions.length === 1 ? questions[0]!.question : "Questions",
    input: { questions: paseoQuestions },
    metadata: { ompAskDialog: refs },
  };
}

// COMPAT(question-answer-lists): added in v0.11.1, remove after 2027-04-08 once every
// supported app sends `answerLists`. Older apps send only the comma-joined `answers`
// string, which is split on exact option labels.
function legacyAnswerList(answer: unknown, labels: string[], multi: boolean): string[] {
  if (typeof answer !== "string" || answer.trim() === "") return [];
  const { selected, custom } = selectedAnswer(answer, labels, multi);
  return custom === null ? selected : [...selected, custom];
}

function askDialogAnswers(
  refs: AskDialogQuestionRef[],
  response: AgentPermissionResponse,
): OmpAskDialogAnswer[] | null {
  if (response.behavior === "deny") return null;
  const input = response.updatedInput;
  const answers = record(input?.answers);
  const answerLists = record(input?.answerLists);
  if (!answers && !answerLists) return null;
  const notes = record(input?.notes);
  return refs.map((ref) => {
    const listed = answerLists?.[ref.header];
    const list =
      Array.isArray(listed) && listed.every((item) => typeof item === "string")
        ? (listed as string[])
        : legacyAnswerList(answers?.[ref.header], ref.displayLabels, ref.multi);
    const selected: string[] = [];
    const custom: string[] = [];
    for (const item of list) {
      const label = ref.labels[ref.displayLabels.indexOf(item)];
      if (label === undefined) {
        if (item.trim()) custom.push(item.trim());
      } else if (!selected.includes(label)) {
        selected.push(label);
      }
    }
    const customInput = custom.join(", ") || undefined;
    // A single-select carries one answer; Paseo's Other text replaces the option.
    let selectedOptions = selected;
    if (!ref.multi) selectedOptions = customInput ? [] : selected.slice(0, 1);
    const note = ref.notes ? string(notes?.[ref.header])?.trim() : undefined;
    return {
      id: ref.id,
      selectedOptions,
      ...(customInput ? { customInput } : {}),
      ...(note ? { note } : {}),
    };
  });
}

function questionTitle(title: string): string {
  return title.replace(/^\(\d+ selected\) /, "");
}

function matchesQuestion(title: string, question: AskQuestion): boolean {
  const plainTitle = questionTitle(title);
  if (plainTitle === question.title) return true;
  return (
    plainTitle.startsWith(question.title) &&
    /^ \(\d+\/\d+\)$/.test(plainTitle.slice(question.title.length))
  );
}

function readQuestions(args: unknown): AskQuestion[] {
  const questions = record(args)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((item) => {
    const question = record(item);
    if (typeof question?.question !== "string" || !Array.isArray(question.options)) return [];
    const options = question.options.flatMap((optionValue) => {
      const option = record(optionValue);
      if (typeof option?.label !== "string") return [];
      return [
        {
          label: option.label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        },
      ];
    });
    return [{ title: question.question, multi: question.multi === true, options }];
  });
}

function selectedAnswer(
  answer: string,
  labels: string[],
  multi: boolean,
): { selected: string[]; custom: string | null } {
  if (!multi)
    return labels.includes(answer)
      ? { selected: [answer], custom: null }
      : { selected: [], custom: answer };

  // The shared question UI sends a comma-joined answer in click order. Consume
  // exact option labels from the front; any remaining text is the Other answer.
  let remaining = answer;
  const selected: string[] = [];
  while (remaining.length > 0) {
    const label = labels
      .filter((candidate) => !selected.includes(candidate))
      .sort((left, right) => right.length - left.length)
      .find((candidate) => remaining === candidate || remaining.startsWith(`${candidate}, `));
    if (!label) break;
    selected.push(label);
    remaining = remaining === label ? "" : remaining.slice(label.length + 2);
  }
  return { selected, custom: remaining || null };
}

/**
 * Owns OMP question mapping. OMP's `ask` tool arrives as one `ask` dialog once
 * `set_ask_dialog` succeeds; older OMP builds replay it through select/editor prompts.
 */
export class OmpQuestionUi {
  private askDialog: { notes: boolean } | null = null;
  private questions: AskQuestion[] = [];
  private pending: PendingAnswer | null = null;

  /** Records what the current runtime's `set_ask_dialog` reported; null keeps the replay. */
  useAskDialog(support: { notes: boolean } | null): void {
    this.askDialog = support;
    this.questions = [];
    this.pending = null;
  }

  observeMessage(message: OmpAgentMessage): void {
    if (message.role !== "assistant") return;
    for (const item of message.content) {
      if (item.type === "toolCall" && item.name === "ask") this.start(item.name, item.arguments);
    }
  }

  start(toolName: string, args: unknown): void {
    if (toolName === "ask" && !this.askDialog) {
      this.questions = readQuestions(args);
      this.pending = null;
    }
  }

  finish(toolName: string): void {
    if (toolName === "ask") {
      this.questions = [];
      this.pending = null;
    }
  }

  handleRequest(
    event: UiRequest,
    provider: AgentProvider,
    send: SendResponse,
  ): AgentPermissionRequest | null {
    if (event.method === "ask") {
      const request = mapAskDialog(event, provider, this.askDialog?.notes === true);
      // An unreadable dialog would otherwise block the ask tool until OMP times out.
      if (!request) send(event.id, { cancelled: true });
      return request;
    }
    if (this.consume(event, send)) return null;
    return this.mapAsk(event, provider) ?? mapGenericQuestion(event, provider);
  }

  respond(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
    send: SendResponse,
  ): void {
    const askDialogRefs = request.metadata?.ompAskDialog;
    if (Array.isArray(askDialogRefs)) {
      const answers = askDialogAnswers(askDialogRefs as AskDialogQuestionRef[], response);
      // Dismissing the card cancels the ask, which aborts the turn as OMP's own dialog does.
      send(request.id, answers ? { answers } : { cancelled: true });
      return;
    }
    if (request.metadata?.ompAsk !== true) {
      send(request.id, genericResponse(request, response));
      return;
    }
    this.respondToReplay(request, response, send);
  }

  // COMPAT(ompAskDialog): added in v0.11.1, remove after 2027-04-08 once the minimum
  // supported OMP is 18.4.10, which sends the whole ask as one `ask` dialog. Older
  // builds prompt each choice with `select` and free text with `editor`; mapAsk,
  // respondToReplay, and consume replay one Paseo answer through those prompts.
  private mapAsk(event: UiRequest, provider: AgentProvider): AgentPermissionRequest | null {
    if (event.method !== "select" || typeof event.title !== "string") return null;
    const title = event.title;
    const question = this.questions.find((item) => matchesQuestion(title, item));
    if (!question || !Array.isArray(event.options) || !event.options.includes(OTHER)) return null;

    const descriptions = new Map(
      question.options.map((option) => [option.label, option.description]),
    );
    const options = readSelectOptions(event)
      .filter((option) => option.label !== OTHER && !option.label.endsWith(" Done selecting"))
      .map((option) => {
        const description =
          descriptions.get(option.label) ??
          descriptions.get(option.label.replace(/ \(Recommended\)$/, "")) ??
          option.description;
        return description ? { label: option.label, description } : { label: option.label };
      });
    return {
      id: event.id,
      provider,
      name: "OMP ask",
      kind: "question",
      title: question.title,
      input: {
        questions: [
          {
            question: question.title,
            header: ANSWER_HEADER,
            options,
            multiSelect: question.multi,
            allowOther: true,
          },
        ],
      },
      metadata: {
        ompAsk: true,
        answerHeader: ANSWER_HEADER,
        optionLabels: options.map((option) => option.label),
      },
    };
  }

  private respondToReplay(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
    send: SendResponse,
  ): void {
    const question = this.questions.find((item) => item.title === request.title);
    const answers = record(
      response.behavior === "allow" ? response.updatedInput?.answers : undefined,
    );
    const answer = answers?.[ANSWER_HEADER];
    if (response.behavior === "deny" || typeof answer !== "string" || !question) {
      this.pending = null;
      send(request.id, { cancelled: true });
      return;
    }

    const labels = Array.isArray(request.metadata?.optionLabels)
      ? request.metadata.optionLabels.filter((item): item is string => typeof item === "string")
      : [];
    const { selected, custom } = selectedAnswer(answer, labels, question.multi);
    if (selected.length === 0 && custom === null) {
      this.pending = null;
      send(request.id, { cancelled: true });
      return;
    }
    if (question.multi) {
      this.pending = { question, selected: selected.slice(1), custom, next: "select" };
      send(request.id, { value: selected[0] ?? OTHER });
      if (selected.length === 0) this.pending.next = "editor";
    } else if (custom !== null) {
      this.pending = { question, selected: [], custom, next: "editor" };
      send(request.id, { value: OTHER });
    } else {
      this.pending = null;
      send(request.id, { value: selected[0] });
    }
  }

  private consume(event: UiRequest, send: SendResponse): boolean {
    const pending = this.pending;
    if (pending?.next === "editor" && event.method === "editor" && pending.custom !== null) {
      this.pending = null;
      send(event.id, { value: pending.custom });
      return true;
    }
    if (
      !pending ||
      typeof event.title !== "string" ||
      !matchesQuestion(event.title, pending.question)
    )
      return false;
    if (pending.next !== "select" || event.method !== "select" || !Array.isArray(event.options))
      return false;

    const choice = pending.selected[0];
    if (choice && event.options.includes(choice)) {
      pending.selected.shift();
      send(event.id, { value: choice });
      return true;
    }
    if (pending.custom !== null && event.options.includes(OTHER)) {
      pending.next = "editor";
      send(event.id, { value: OTHER });
      return true;
    }
    const done = event.options.find((option) => option.endsWith(" Done selecting"));
    if (!done) {
      // OMP omits Done for multi-question asks and expects a right-arrow
      // navigation callback, which its RPC response cannot express.
      this.pending = null;
      send(event.id, { cancelled: true });
      return true;
    }
    this.pending = null;
    send(event.id, { value: done });
    return true;
  }
}
