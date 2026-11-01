import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildRunInput, createRunNonce, readRunOutput } from "./command";
import type { CodeRunScope } from "./scope";
import {
  rememberCodeRun,
  setCodeRunLive,
  updateCodeRun,
  useCodeRunStore,
  type CodeRunRecord,
} from "./store";

export type CodeRunClient = Pick<
  DaemonClient,
  "createTerminal" | "observeTerminal" | "captureTerminal" | "sendTerminalInput" | "killTerminal"
>;

const RUN_TERMINAL_SIZE = { rows: 24, cols: 80 };
/** Captured tail of the terminal. The card shows less; the agent report keeps 8 KB of it. */
const CAPTURE_LINES = 400;
/** Output arrives in bursts; one capture per burst keeps the card current. */
const CAPTURE_COALESCE_MS = 120;
/** A shell that prints no prompt still gets the command once its rc files had time to run. */
const SHELL_READY_TIMEOUT_MS = 3000;
const TERMINAL_NAME_LENGTH = 40;

export class CodeRunStartError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CodeRunStartError";
  }
}

export async function startCodeRun(input: {
  client: CodeRunClient;
  scope: CodeRunScope;
  key: string;
  command: string;
}): Promise<void> {
  const { client, scope, key, command } = input;
  setCodeRunLive(key, { kind: "starting" });
  const payload = await client.createTerminal(scope.cwd, terminalName(command), undefined, {
    workspaceId: scope.workspaceId,
    size: RUN_TERMINAL_SIZE,
  });
  if (!payload.terminal) throw new CodeRunStartError(payload.error ?? "Terminal was not created");
  const terminalId = payload.terminal.id;
  const nonce = createRunNonce();
  rememberCodeRun(key, {
    terminalId,
    workspaceId: scope.workspaceId,
    command,
    nonce,
    startedAt: Date.now(),
    exitCode: null,
    durationSeconds: null,
    stopped: false,
  });
  await waitForShellOutput(client, terminalId);
  client.sendTerminalInput(terminalId, { type: "input", data: buildRunInput(command, nonce) });
  setCodeRunLive(key, { kind: "output", lines: [] });
}

/**
 * Runs the command again in the same terminal, so its history stays in one tab. The new
 * nonce makes the card read only the new run's output.
 */
export function rerunCodeRun(client: CodeRunClient, key: string, record: CodeRunRecord): void {
  const nonce = createRunNonce();
  rememberCodeRun(key, {
    ...record,
    nonce,
    startedAt: Date.now(),
    exitCode: null,
    durationSeconds: null,
    stopped: false,
  });
  setCodeRunLive(key, { kind: "output", lines: [] });
  client.sendTerminalInput(record.terminalId, {
    type: "input",
    data: buildRunInput(record.command, nonce),
  });
}

function terminalName(command: string): string {
  const firstLine = command.split("\n")[0].trim();
  return firstLine.length > TERMINAL_NAME_LENGTH
    ? `${firstLine.slice(0, TERMINAL_NAME_LENGTH - 1)}…`
    : firstLine;
}

/** Typing before the shell prints its prompt can lose the input to rc-file setup. */
async function waitForShellOutput(client: CodeRunClient, terminalId: string): Promise<void> {
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const subscription = client.observeTerminal(terminalId, (event) => {
    if (event.type === "output" && event.data.length > 0) markReady();
  });
  const timer = setTimeout(markReady, SHELL_READY_TIMEOUT_MS);
  void hasPrompt(client, terminalId, subscription.ready).then((printed) => {
    if (printed) markReady();
    return printed;
  }, markReady);
  await ready;
  clearTimeout(timer);
  void subscription.release().catch(console.error);
}

/** The prompt may have printed before the subscription attached; the screen still shows it. */
async function hasPrompt(
  client: CodeRunClient,
  terminalId: string,
  subscribed: Promise<unknown>,
): Promise<boolean> {
  await subscribed;
  const capture = await client.captureTerminal(terminalId, { stripAnsi: true });
  return capture.lines.some((line) => line.trim() !== "");
}

/**
 * Follows a run while its card is on screen: each output burst triggers one plain-text capture.
 * Stops on its own once the status line shows up, because a finished command prints no more.
 */
export function observeCodeRun(input: {
  client: CodeRunClient;
  key: string;
  record: Pick<CodeRunRecord, "terminalId" | "nonce">;
  liveRestore: boolean;
  /** Called once when this observation sees the run end. */
  onFinish: (exitCode: number) => void;
}): () => void {
  const { client, key, record, liveRestore, onFinish } = input;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let capturing = false;
  let captureAgain = false;

  const subscription = client.observeTerminal(
    record.terminalId,
    (event) => {
      if (event.type === "output") scheduleCapture();
    },
    liveRestore ? { restore: { mode: "live" } } : undefined,
  );
  subscription.subscribe({
    snapshot: () => scheduleCapture(),
    update: (message) => {
      if (message.type === "terminal_stream_exit" && !message.payload.error) markClosed();
    },
  });
  // A missing terminal and a dropped connection both reject here; only a capture tells them apart.
  void subscription.ready.then(scheduleCapture, scheduleCapture);

  function scheduleCapture() {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void capture().catch(console.error);
    }, CAPTURE_COALESCE_MS);
  }

  async function capture() {
    if (capturing) {
      captureAgain = true;
      return;
    }
    capturing = true;
    try {
      const result = await client.captureTerminal(record.terminalId, {
        start: -CAPTURE_LINES,
        stripAnsi: true,
      });
      if (disposed) return;
      // A live terminal always has at least its screen rows; none means it is gone.
      if (result.totalLines === 0) {
        markClosed();
        return;
      }
      const output = readRunOutput({
        lines: result.lines,
        nonce: record.nonce,
        complete: result.totalLines <= CAPTURE_LINES,
      });
      setCodeRunLive(key, { kind: "output", lines: output.lines });
      if (output.exitCode !== null) {
        const known = useCodeRunStore.getState().records[key]?.exitCode;
        updateCodeRun(key, {
          exitCode: output.exitCode,
          durationSeconds: output.durationSeconds,
        });
        dispose();
        if (known === null) onFinish(output.exitCode);
      }
    } finally {
      capturing = false;
      if (captureAgain && !disposed) {
        captureAgain = false;
        scheduleCapture();
      }
    }
  }

  function markClosed() {
    const live = useCodeRunStore.getState().live[key];
    const lines = live?.kind === "output" || live?.kind === "terminalClosed" ? live.lines : [];
    setCodeRunLive(key, { kind: "terminalClosed", lines });
    dispose();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    void subscription.release().catch(console.error);
  }

  return dispose;
}

/** Ctrl-C, as if typed. The shell drops the status line when the command dies of it. */
export function interruptCodeRun(client: CodeRunClient, key: string, record: CodeRunRecord): void {
  client.sendTerminalInput(record.terminalId, { type: "input", data: "\u0003" });
  updateCodeRun(key, { stopped: true });
}

/** Sends one line to the command. The text is not kept anywhere on this side. */
export function answerCodeRun(client: CodeRunClient, record: CodeRunRecord, answer: string): void {
  client.sendTerminalInput(record.terminalId, { type: "input", data: `${answer}\r` });
}

/** A single key the phone keyboard has no good way to type into the run. */
export type CodeRunKey = "enter" | "tab";

const KEY_INPUT: Record<CodeRunKey, string> = { enter: "\r", tab: "\t" };

export function pressCodeRunKey(client: CodeRunClient, record: CodeRunRecord, key: CodeRunKey) {
  client.sendTerminalInput(record.terminalId, { type: "input", data: KEY_INPUT[key] });
}
