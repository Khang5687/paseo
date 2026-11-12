import type {
  AgentMetadata,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "../../agent-sdk-types.js";
import { readQuestionAnswerList } from "../../question-answers.js";
import { splitMultiSelectAnswer } from "../question-card-answer.js";
import { type OmpAskChoiceField, parseOmpAskForm } from "./ask-form.js";
import type { OmpAgentMessage, OmpRuntimeEvent } from "./rpc-types.js";

type UiRequest = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;
interface UiResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}
type SendResponse = (id: string, response: UiResponse) => void;

const OTHER = "Other (type your own)";
const ANSWER_HEADER = "Response";

interface SelectOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  title: string;
  multi: boolean;
  options: SelectOption[];
}

/** The rest of an answer, replayed into OMP's follow-up prompts for the same question. */
interface PendingAnswer {
  matches: (title: string) => boolean;
  /** Rows still to send: options to toggle, then Other. */
  queue: string[];
  custom: string | null;
  multi: boolean;
  next: "select" | "text";
  /** A form's checkbox walk returns to its select after the Other text; the old ask ended there. */
  selectAfterText: boolean;
}

interface ActiveForm {
  context: string;
  choices: OmpAskChoiceField[];
  /** Index of the first choice field no select has matched yet. */
  next: number;
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
    case "editor": {
      // OMP opens its editor on this text; an empty answer keeps it.
      const prefill = event.prefill?.trim() ? event.prefill : undefined;
      const request = genericQuestion(
        event,
        provider,
        event.title ?? "Edit text",
        [],
        prefill ? { placeholder: prefill, allowEmpty: true } : {},
      );
      return prefill
        ? { ...request, metadata: { ...request.metadata, editorPrefill: prefill } }
        : request;
    }
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
): UiResponse {
  if (response.behavior === "deny") return { cancelled: true };
  const answers = record(response.updatedInput?.answers);
  const answer = Object.values(answers ?? {}).find(
    (value): value is string => typeof value === "string",
  );
  if (answer === undefined) return { cancelled: true };
  const prefill = request.metadata?.editorPrefill;
  if (answer === "" && typeof prefill === "string") return { value: prefill };
  return request.metadata?.extensionUiMethod === "confirm"
    ? { confirmed: /^yes$/i.test(answer.trim()) }
    : { value: answer };
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

function askAnswer(
  updatedInput: AgentMetadata | undefined,
  labels: string[],
  multi: boolean,
): { selected: string[]; custom: string | null } | null {
  const answerList = readQuestionAnswerList(updatedInput, ANSWER_HEADER);
  if (answerList) {
    // The app lists the checked labels, then the Other text. Any entry that is not
    // exactly an option label is the Other text.
    const custom = answerList.filter((item) => !labels.includes(item));
    return {
      selected: answerList.filter((item) => labels.includes(item)),
      custom: custom.length > 0 ? custom.join(", ") : null,
    };
  }
  const answer = record(updatedInput?.answers)?.[ANSWER_HEADER];
  return typeof answer === "string" ? legacySelectedAnswer(answer, labels, multi) : null;
}

// COMPAT(question-answer-lists): added in v0.11.0, remove after 2027-04-08. Apps before
// v0.11.0 send only a comma-joined answer, so labels are peeled off its front.
function legacySelectedAnswer(
  answer: string,
  labels: string[],
  multi: boolean,
): { selected: string[]; custom: string | null } {
  if (!multi)
    return labels.includes(answer)
      ? { selected: [answer], custom: null }
      : { selected: [], custom: answer };
  return splitMultiSelectAnswer(answer, labels);
}

function isDoneRow(row: string): boolean {
  return row.endsWith(" Done selecting");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Owns OMP question mapping and the ask tool's multi-RPC answer sequence.
 *
 * OMP's RPC host has no form surface, so `ask` arrives as one prompt per field: a
 * `select` per choice question (checkboxes toggle a row per prompt until a Done
 * row; "Other" opens a text prompt) and `input`/`editor` per text field. Paseo
 * shows one card per choice question and replays the answer into that sequence.
 * Two argument shapes exist: `{ questions }` (OMP before 18.18.3) and `{ html }`.
 */
export class OmpQuestionUi {
  private askId: string | null = null;
  private questions: AskQuestion[] = [];
  private form: ActiveForm | null = null;
  private pending: PendingAnswer | null = null;

  observeMessage(message: OmpAgentMessage): void {
    if (message.role !== "assistant") return;
    for (const item of message.content) {
      if (item.type === "toolCall" && item.name === "ask") {
        this.start(item.name, item.arguments, item.id);
      }
    }
  }

  /**
   * OMP sends the assistant message, then the first prompt, then
   * `tool_execution_start`; the second sighting of the same call keeps its state.
   */
  start(toolName: string, args: unknown, toolCallId: string): void {
    if (toolName !== "ask" || toolCallId === this.askId) return;
    this.askId = toolCallId;
    this.questions = readQuestions(args);
    const html = record(args)?.html;
    this.form = typeof html === "string" ? { ...parseOmpAskForm(html), next: 0 } : null;
    this.pending = null;
  }

  finish(toolName: string): void {
    if (toolName === "ask") {
      this.askId = null;
      this.questions = [];
      this.form = null;
      this.pending = null;
    }
  }

  handleRequest(
    event: UiRequest,
    provider: AgentProvider,
    send: SendResponse,
  ): AgentPermissionRequest | null {
    if (this.consume(event, send)) return null;
    const request =
      this.mapAsk(event, provider) ??
      this.mapFormChoice(event, provider) ??
      mapGenericQuestion(event, provider);
    return request ? this.withFormContext(request) : null;
  }

  private mapAsk(event: UiRequest, provider: AgentProvider): AgentPermissionRequest | null {
    if (event.method !== "select" || typeof event.title !== "string") return null;
    const title = event.title;
    const question = this.questions.find((item) => matchesQuestion(title, item));
    if (!question || !Array.isArray(event.options) || !event.options.includes(OTHER)) return null;

    const descriptions = new Map(
      question.options.map((option) => [option.label, option.description]),
    );
    const options = readSelectOptions(event)
      .filter((option) => option.label !== OTHER && !isDoneRow(option.label))
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

  /** A `select` from an `{ html }` ask, matched to the form's next choice field by option count. */
  private mapFormChoice(event: UiRequest, provider: AgentProvider): AgentPermissionRequest | null {
    const form = this.form;
    if (!form || event.method !== "select" || typeof event.title !== "string") return null;
    const rows = event.options ?? [];
    const labels = rows.filter((row) => row !== OTHER && !isDoneRow(row));
    const index = form.choices.findIndex(
      (field, fieldIndex) => fieldIndex >= form.next && field.checked.length === labels.length,
    );
    const field = form.choices[index];
    if (!field) return null;
    form.next = index + 1;

    // A preselected checkbox already counts: OMP titles its first prompt "(1 selected) …".
    const title = questionTitle(event.title);
    const preselected = labels.filter((_, optionIndex) => field.checked[optionIndex]);
    return {
      id: event.id,
      provider,
      name: "OMP ask",
      kind: "question",
      title,
      input: {
        questions: [
          {
            question: title,
            header: ANSWER_HEADER,
            options: labels.map((label) =>
              preselected.includes(label) ? { label, description: "Recommended" } : { label },
            ),
            multiSelect: field.multi,
            ...(rows.includes(OTHER) ? { allowOther: true } : {}),
            ...(field.multi && !field.required ? { allowEmpty: true } : {}),
          },
        ],
      },
      metadata: {
        ompAsk: true,
        ompAskForm: true,
        answerHeader: ANSWER_HEADER,
        optionLabels: labels,
        selectRows: rows,
        multiSelect: field.multi,
        preselected,
      },
    };
  }

  /** OMP's walk drops the form's context text; the ask's first card carries it. */
  private withFormContext(request: AgentPermissionRequest): AgentPermissionRequest {
    const context = this.form?.context;
    const questions = request.input?.questions;
    if (!this.form || !context || request.kind !== "question" || !Array.isArray(questions)) {
      return request;
    }
    const [first, ...rest] = questions;
    const question = record(first);
    if (!question || typeof question.question !== "string") return request;
    this.form.context = "";
    return {
      ...request,
      input: {
        ...request.input,
        questions: [{ ...question, question: `${context}\n\n${question.question}` }, ...rest],
      },
    };
  }

  private respondFormChoice(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
    send: SendResponse,
  ): void {
    const metadata = request.metadata ?? {};
    const multi = metadata.multiSelect === true;
    const labels = stringList(metadata.optionLabels);
    const answer =
      response.behavior === "allow" ? askAnswer(response.updatedInput, labels, multi) : null;
    if (!answer) return this.cancel(request.id, send);
    const { selected, custom } = answer;
    const other = custom?.trim() ? custom : null;
    const preselected = stringList(metadata.preselected);
    // Checkbox rows toggle, so send the rows whose state changes.
    const queue = multi
      ? labels.filter((label) => selected.includes(label) !== preselected.includes(label))
      : selected.slice(0, 1);
    if (other !== null && (multi || queue.length === 0)) queue.push(OTHER);
    if (!multi && queue.length === 0) return this.cancel(request.id, send);
    const title = request.title ?? "";
    this.advance(
      {
        matches: (eventTitle) => questionTitle(eventTitle) === title,
        queue,
        custom: other,
        multi,
        next: "select",
        selectAfterText: multi,
      },
      request.id,
      stringList(metadata.selectRows),
      send,
    );
  }

  respond(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
    send: SendResponse,
  ): void {
    const metadata = request.metadata;
    if (metadata?.ompAsk !== true) {
      send(request.id, genericResponse(request, response));
      return;
    }
    if (metadata.ompAskForm === true) {
      this.respondFormChoice(request, response, send);
      return;
    }
    const labels = stringList(metadata.optionLabels);
    const question = this.questions.find((item) => item.title === request.title);
    const answer =
      response.behavior === "allow" && question
        ? askAnswer(response.updatedInput, labels, question.multi)
        : null;
    if (!answer || !question) return this.cancel(request.id, send);
    const { selected, custom } = answer;
    const queue = question.multi ? [...selected] : selected.slice(0, 1);
    if (custom !== null && (question.multi || queue.length === 0)) queue.push(OTHER);
    if (queue.length === 0) return this.cancel(request.id, send);
    this.advance(
      {
        matches: (eventTitle) => matchesQuestion(eventTitle, question),
        queue,
        custom,
        multi: question.multi,
        next: "select",
        selectAfterText: false,
      },
      request.id,
      [...labels, OTHER],
      send,
    );
  }

  consume(event: UiRequest, send: SendResponse): boolean {
    const pending = this.pending;
    if (!pending) return false;
    if (pending.next === "text") {
      if ((event.method !== "input" && event.method !== "editor") || pending.custom === null) {
        return false;
      }
      const custom = pending.custom;
      pending.custom = null;
      if (pending.selectAfterText) pending.next = "select";
      else this.pending = null;
      send(event.id, { value: custom });
      return true;
    }
    if (
      event.method !== "select" ||
      typeof event.title !== "string" ||
      !Array.isArray(event.options) ||
      !pending.matches(event.title)
    ) {
      return false;
    }
    this.advance(pending, event.id, event.options, send);
    return true;
  }

  /** Answers one select of the question with the next queued row, else its Done row. */
  private advance(
    pending: PendingAnswer,
    id: string,
    rows: readonly string[],
    send: SendResponse,
  ): void {
    const row = pending.queue[0];
    if (row !== undefined && rows.includes(row)) {
      pending.queue.shift();
      if (row === OTHER) pending.next = "text";
      this.pending = row === OTHER || pending.multi ? pending : null;
      send(id, { value: row });
      return;
    }
    // OMP omits Done in a multi-question old-shape ask (it wants a right-arrow
    // callback) and in a required checkbox group with nothing checked; RPC can
    // finish neither.
    const done = rows.find(isDoneRow);
    this.pending = null;
    send(id, done ? { value: done } : { cancelled: true });
  }

  private cancel(id: string, send: SendResponse): void {
    this.pending = null;
    send(id, { cancelled: true });
  }
}
