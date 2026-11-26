import stripAnsi from "strip-ansi";
import { z } from "zod";
import type { AgentBackgroundWorkInput } from "../../background-work/index.js";

/** Lines kept per job: the details sheet shows 20, the list row the last 2. */
const OUTPUT_TAIL_LINES = 20;
const OUTPUT_LINE_CHARS = 300;
/** Output alone republishes at most this often; starts, ends and waits publish at once. */
const OUTPUT_PUBLISH_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

interface OmpJob {
  id: string;
  type: string;
  command: string | null;
  description: string | null;
  outputTail: string[];
}

interface AsyncState {
  state: string;
  jobId: string;
  type: string;
}

interface WaitedJob {
  id: string;
  type: string;
  status: string;
  label: string | null;
}

export interface OmpBackgroundJobsOptions {
  publish: (items: AgentBackgroundWorkInput[] | null) => void;
  /** Sends an OMP slash command over RPC without starting a Paseo turn. */
  sendCommand: (message: string) => Promise<void>;
  outputPublishIntervalMs?: number;
}

/**
 * OMP runs `bash` and `eval` calls with `async: true` as jobs that outlive the tool call. OMP's
 * RPC already reports them: the tool call ends with `details.async = {state: "running", jobId}`,
 * the job keeps sending `tool_execution_update` frames under the same tool call id with its
 * output and state, and the `wait` tool reports the jobs it blocks on every 500 ms. This turns
 * those frames into the agent's background work. `task` jobs are subagents and stay in the
 * subagents track.
 */
export class OmpBackgroundJobs {
  private readonly jobs = new Map<string, OmpJob>();
  private readonly jobIdByToolCallId = new Map<string, string>();
  private readonly launches = new Map<string, { command: string | null; intent: string | null }>();
  /** Null while no `wait` call runs. Empty until its first report: then it waits on every job. */
  private waitedOn: ReadonlySet<string> | null = null;
  private waitToolCallId: string | null = null;
  private readonly pendingStops = new Set<string>();
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private published = false;

  constructor(private readonly options: OmpBackgroundJobsOptions) {}

  toolStarted(toolCallId: string, toolName: string, args: unknown, intent: unknown): void {
    if (toolName === "wait") {
      this.waitToolCallId = toolCallId;
      this.waitedOn = new Set();
      this.publishNow();
      return;
    }
    if (toolName !== "bash" && toolName !== "eval") return;
    this.launches.set(toolCallId, {
      command: readCommand(toolName, args),
      // The model's own reason for the call, when it gave one.
      intent: typeof intent === "string" && intent.trim() ? intent.trim() : null,
    });
  }

  toolUpdated(toolCallId: string, toolName: string, partialResult: unknown): void {
    if (toolName === "wait" && toolCallId === this.waitToolCallId) {
      this.applyWaitReport(readWaitedJobs(partialResult));
      return;
    }
    const jobId = this.jobIdByToolCallId.get(toolCallId);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job) return;
    const state = readAsyncState(partialResult);
    if (state && TERMINAL_STATES.has(state.state)) {
      this.removeJob(job.id);
      return;
    }
    const outputTail = readOutputTail(partialResult);
    if (outputTail && !sameLines(outputTail, job.outputTail)) {
      job.outputTail = outputTail;
      this.publishSoon();
    }
  }

  toolEnded(toolCallId: string, toolName: string, result: unknown): void {
    if (toolName === "wait") {
      if (toolCallId === this.waitToolCallId) {
        this.waitToolCallId = null;
        this.waitedOn = null;
        this.applyWaitReport(readWaitedJobs(result), { waiting: false });
      }
      return;
    }
    const launch = this.launches.get(toolCallId);
    this.launches.delete(toolCallId);
    const state = readAsyncState(result);
    if (!launch || state?.state !== "running" || state.type === "task") return;
    this.jobIdByToolCallId.set(toolCallId, state.jobId);
    this.jobs.set(state.jobId, {
      id: state.jobId,
      type: state.type,
      command: launch.command,
      description: launch.intent,
      outputTail: readOutputTail(result) ?? [],
    });
    this.publishNow();
  }

  /** True when OMP's reply belongs to a stop Paseo sent, so the chat should not show it. */
  consumeCommandOutput(text: string): boolean {
    for (const jobId of this.pendingStops) {
      if (text.includes(jobId)) {
        this.pendingStops.delete(jobId);
        return true;
      }
    }
    return false;
  }

  /** OMP's `/jobs kill <id>` cancels the job; its last frame then reports `cancelled`. */
  async stop(jobId: string): Promise<void> {
    if (!this.jobs.has(jobId)) throw new Error("Background job is no longer running");
    this.pendingStops.add(jobId);
    try {
      await this.options.sendCommand(`/jobs kill ${jobId}`);
    } catch (error) {
      this.pendingStops.delete(jobId);
      throw error;
    }
  }

  /** The OMP process is gone, and its jobs with it. */
  clear(): void {
    this.cancelPublish();
    this.jobs.clear();
    this.jobIdByToolCallId.clear();
    this.launches.clear();
    this.pendingStops.clear();
    this.waitedOn = null;
    this.waitToolCallId = null;
    if (this.published) this.options.publish(null);
    this.published = false;
  }

  private applyWaitReport(jobs: WaitedJob[] | null, { waiting = true } = {}): void {
    if (!jobs) {
      this.publishNow();
      return;
    }
    const running = new Set<string>();
    for (const job of jobs) {
      if (job.type === "task") continue;
      if (TERMINAL_STATES.has(job.status)) {
        this.jobs.delete(job.id);
        continue;
      }
      running.add(job.id);
      // A job started before Paseo attached still has a name in the wait report.
      if (!this.jobs.has(job.id)) {
        this.jobs.set(job.id, {
          id: job.id,
          type: job.type,
          command: job.label,
          description: null,
          outputTail: [],
        });
      }
    }
    if (waiting) this.waitedOn = running;
    this.publishNow();
  }

  private removeJob(jobId: string): void {
    this.jobs.delete(jobId);
    for (const [toolCallId, id] of this.jobIdByToolCallId) {
      if (id === jobId) this.jobIdByToolCallId.delete(toolCallId);
    }
    this.publishNow();
  }

  private items(): AgentBackgroundWorkInput[] {
    const waitsOnAll = this.waitedOn?.size === 0;
    return [...this.jobs.values()].map((job) => {
      const item: AgentBackgroundWorkInput = {
        id: job.id,
        kind: job.type === "bash" ? "shell" : "other",
        description: job.description,
        canStop: true,
      };
      if (job.command) item.command = job.command;
      if (job.outputTail.length) item.outputTail = job.outputTail;
      if (waitsOnAll || this.waitedOn?.has(job.id)) item.waitedOn = true;
      return item;
    });
  }

  private publishSoon(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishNow();
    }, this.options.outputPublishIntervalMs ?? OUTPUT_PUBLISH_INTERVAL_MS);
  }

  private publishNow(): void {
    this.cancelPublish();
    if (this.jobs.size === 0 && !this.published) return;
    this.published = this.jobs.size > 0;
    this.options.publish(this.jobs.size > 0 ? this.items() : null);
  }

  private cancelPublish(): void {
    if (!this.publishTimer) return;
    clearTimeout(this.publishTimer);
    this.publishTimer = null;
  }
}

const ToolArgsSchema = z
  .object({ command: z.string().optional(), title: z.string().optional() })
  .passthrough();

const AsyncStateSchema = z.object({
  details: z.object({
    async: z.object({ state: z.string(), jobId: z.string().min(1), type: z.string().optional() }),
  }),
});

const WaitReportSchema = z.object({
  details: z.object({
    op: z.literal("wait"),
    jobs: z.array(
      z.object({
        id: z.string().min(1),
        status: z.string(),
        type: z.string().optional(),
        label: z.string().optional(),
      }),
    ),
  }),
});

const ToolContentSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** `bash` runs a command; `eval` runs code under a short title. */
function readCommand(toolName: string, args: unknown): string | null {
  const parsed = ToolArgsSchema.safeParse(args);
  if (!parsed.success) return null;
  const command = toolName === "bash" ? parsed.data.command : parsed.data.title;
  return command?.trim() || null;
}

function readAsyncState(result: unknown): AsyncState | null {
  const parsed = AsyncStateSchema.safeParse(result);
  if (!parsed.success) return null;
  const { state, jobId, type } = parsed.data.details.async;
  return { state, jobId, type: type ?? "bash" };
}

function readWaitedJobs(result: unknown): WaitedJob[] | null {
  const parsed = WaitReportSchema.safeParse(result);
  if (!parsed.success) return null;
  return parsed.data.details.jobs.map((job) => ({
    id: job.id,
    status: job.status,
    type: job.type ?? "bash",
    label: job.label?.trim() || null,
  }));
}

/** OMP sends the job's whole output preview each time; keep its last lines. */
function readOutputTail(result: unknown): string[] | null {
  const parsed = ToolContentSchema.safeParse(result);
  if (!parsed.success) return null;
  const text = parsed.data.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
  const trimmed = stripAnsi(text).replace(/\s+$/, "");
  if (!trimmed) return [];
  return trimmed
    .split(/\r?\n/)
    .slice(-OUTPUT_TAIL_LINES)
    .map((line) => line.slice(0, OUTPUT_LINE_CHARS));
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
