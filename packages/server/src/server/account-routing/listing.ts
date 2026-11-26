import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { OmpCliRuntime } from "../agent/providers/omp/cli-runtime.js";
import type { OmpRuntime } from "../agent/providers/omp/runtime.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import type { AccountRoutingAuthority } from "./authority.js";

const PROVIDER_ID = "anthropic";

/**
 * A plain OMP runtime that reads its command and env from the current OMP provider config on every
 * session, so the sign-in child, the listing child and agents launch the same binary and store.
 */
export function createConfiguredOmpRuntime(
  logger: Logger,
  settings: () => ProviderRuntimeSettings | undefined,
  /** Test seam: replaces the real CLI runtime. */
  create: (runtimeSettings: ProviderRuntimeSettings | undefined) => OmpRuntime = (
    runtimeSettings,
  ) => new OmpCliRuntime({ logger, runtimeSettings }),
): OmpRuntime {
  return { startSession: (input) => create(settings()).startSession(input) };
}

export interface OmpAccountLister {
  /** Resolves once the listing has been read and handed to the authority (or has failed quietly). */
  refresh(source: "listing" | "login"): Promise<void>;
}

/**
 * Lists the OMP store's Claude accounts without an agent. It asks a short-lived plain
 * `omp --mode rpc` for `get_logout_accounts`, which reloads the store and reads labels: no token
 * refresh, no provider call, no routing launch marker. Runs are serialized; one that arrives while
 * another is running is merged into a single follow-up read.
 */
export function createOmpAccountLister(options: {
  authority: Pick<AccountRoutingAuthority, "publishListing">;
  runtime: OmpRuntime;
  logger: Logger;
}): OmpAccountLister {
  let running: Promise<void> | null = null;
  let again: "listing" | "login" | null = null;

  async function readOnce(source: "listing" | "login"): Promise<void> {
    let cwd: string | undefined;
    let session: Awaited<ReturnType<OmpRuntime["startSession"]>> | undefined;
    try {
      cwd = await mkdtemp(path.join(tmpdir(), "paseo-omp-listing-"));
      session = await options.runtime.startSession({ cwd, protocolMode: "rpc", noSession: true });
      const accounts = await session.getLogoutAccounts(PROVIDER_ID);
      const rows = accounts
        .filter((a) => a.type === "oauth")
        .map((a) => ({ nativeRowId: a.credentialId, label: a.label }));
      if (!options.authority.publishListing(source, rows))
        options.logger.info("OMP account listing skipped: store namespace not known yet");
    } catch (error) {
      options.logger.warn({ err: error }, "OMP account listing failed");
    } finally {
      await session?.close().catch(() => undefined);
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    refresh(source) {
      if (running) {
        again = source;
        return running;
      }
      const run = (async () => {
        let next: "listing" | "login" | null = source;
        while (next) {
          again = null;
          await readOnce(next);
          next = again;
        }
      })().finally(() => {
        running = null;
      });
      running = run;
      return run;
    },
  };
}
