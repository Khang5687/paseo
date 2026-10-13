import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import type { OmpAccountLoginStatus } from "@getpaseo/protocol/messages";
import type { OmpRuntime, OmpRuntimeSession } from "../agent/providers/omp/runtime.js";
import type { OmpRuntimeEvent } from "../agent/providers/omp/rpc-types.js";
import { execCommand } from "../../utils/spawn.js";
import { OmpCliRuntime } from "../agent/providers/omp/cli-runtime.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const PROVIDER_ID = "anthropic";

type Failure = NonNullable<OmpAccountLoginStatus["failure"]>;

export interface OmpAccountLoginOptions {
  runtime: OmpRuntime;
  /** Opens the authorize URL in the host's default browser. */
  openUrl: (url: string) => Promise<void>;
  logger: Logger;
  timeoutMs?: number;
}

/** macOS only: the daemon has no other host browser opener, and Paseo supports no paste-code path. */
export function openUrlOnMac(url: string): Promise<void> {
  return execCommand("open", [url], { timeout: 10_000 }).then(() => undefined);
}

/**
 * One host-side Claude sign-in at a time. A short-lived plain `omp --mode rpc` runs OMP's own
 * `login`: OMP serves the loopback callback and writes the credential into its native store. This
 * class only opens the browser and relays the outcome. The authorize URL, codes and tokens never
 * reach the protocol, the app, or a log line, and OMP's error text is dropped for the same reason.
 */
export class OmpAccountLogin {
  private current: OmpAccountLoginStatus = { state: "idle" };
  private teardown: (() => void) | null = null;

  constructor(private readonly options: OmpAccountLoginOptions) {}

  status(): OmpAccountLoginStatus {
    return { ...this.current };
  }

  start(): { status: OmpAccountLoginStatus; error: "already_running" | null } {
    if (this.current.state === "running")
      return { status: this.status(), error: "already_running" };
    this.current = { state: "running", startedAt: Date.now() };
    const run = this.current;
    void this.run(run);
    return { status: this.status(), error: null };
  }

  cancel(): OmpAccountLoginStatus {
    if (this.current.state === "running") this.settle(this.current, { state: "cancelled" });
    return this.status();
  }

  dispose(): void {
    this.cancel();
  }

  /** Records the outcome of `run` once and stops its process. A stale run cannot change a newer one. */
  private settle(
    run: OmpAccountLoginStatus,
    outcome: { state: "succeeded" | "cancelled" | "failed"; failure?: Failure },
  ): void {
    if (this.current !== run || run.state !== "running") return;
    this.current = { ...outcome, startedAt: run.startedAt };
    this.teardown?.();
    this.teardown = null;
    this.options.logger.info(
      { state: outcome.state, failure: outcome.failure },
      "OMP account login ended",
    );
  }

  private async run(run: OmpAccountLoginStatus): Promise<void> {
    const { runtime, openUrl } = this.options;
    let session: OmpRuntimeSession | undefined;
    let cwd: string | undefined;
    let pastedCodeRequested = false;
    const timer = setTimeout(
      () => this.settle(run, { state: "failed", failure: "timeout" }),
      this.options.timeoutMs ?? LOGIN_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timer);
      void session?.close().catch(() => undefined);
      if (cwd) void rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    };
    this.teardown = cleanup;

    const onEvent = (event: OmpRuntimeEvent) => {
      if (event.type !== "extension_ui_request") return;
      if (event.method === "open_url") {
        const url = parseHttpsUrl(event.url);
        if (!url) return this.settle(run, { state: "failed", failure: "browser_open_failed" });
        openUrl(url).catch(() =>
          this.settle(run, { state: "failed", failure: "browser_open_failed" }),
        );
      } else if (event.method === "input") {
        // OMP asks for a pasted code only when the loopback callback did not arrive.
        pastedCodeRequested = true;
        session?.cancelExtensionUiRequest(event.id);
      } else if (["select", "confirm", "editor"].includes(event.method)) {
        session?.cancelExtensionUiRequest(event.id);
      }
    };

    try {
      cwd = await mkdtemp(path.join(tmpdir(), "paseo-omp-login-"));
      session = await runtime.startSession({ cwd, protocolMode: "rpc", noSession: true });
      if (this.current !== run) return cleanup();
      session.onEvent(onEvent);
      await session.login(PROVIDER_ID);
      this.settle(run, { state: "succeeded" });
    } catch {
      this.settle(run, { state: "failed", failure: failureOf(session, pastedCodeRequested) });
    } finally {
      cleanup();
    }
  }
}

function parseHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function failureOf(session: OmpRuntimeSession | undefined, pastedCodeRequested: boolean): Failure {
  if (!session) return "spawn_failed";
  return pastedCodeRequested ? "paste_code_unsupported" : "omp_failed";
}

/** The macOS host login, or undefined elsewhere: no other platform has a host browser opener here. */
export function createMacAccountLogin(input: {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}): OmpAccountLogin | undefined {
  if (process.platform !== "darwin") return undefined;
  return new OmpAccountLogin({
    runtime: new OmpCliRuntime({ logger: input.logger, runtimeSettings: input.runtimeSettings }),
    openUrl: openUrlOnMac,
    logger: input.logger.child({ module: "omp-account-login" }),
  });
}
