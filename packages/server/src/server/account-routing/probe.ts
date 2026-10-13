import type { Logger } from "pino";

import { mergeRuntimeSettings, toRuntimeSettings } from "../agent/provider-registry.js";
import type { OmpCapabilityProbe } from "../agent/providers/omp/account-routing-bridge.js";
import { OmpCliRuntime } from "../agent/providers/omp/cli-runtime.js";
import type { ProviderOverride, ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import type { AccountRoutingAuthority } from "./authority.js";

type Capability = ReturnType<AccountRoutingAuthority["snapshot"]>["capability"];

/** Same rule a live runtime follows: only a complete version-1 document is supported. */
export function capabilityFromProbe(probe: OmpCapabilityProbe): Capability {
  if (probe.unavailable) return { status: "unknown", reason: null };
  if (probe.complete && probe.version === 1) return { status: "supported", reason: null };
  return { status: "unsupported", reason: "unsupported_runtime" };
}

export interface OmpCapabilityProber {
  /** Re-probes when the OMP provider config differs from the last one probed. */
  update(override: ProviderOverride | undefined): void;
  dispose(): void;
}

/**
 * Lets the daemon learn OMP routing support before any agent runs. The probe is the same
 * `account-routing-capabilities` call each launch makes, so an old OMP is rejected before any prompt.
 */
export function createOmpCapabilityProber(options: {
  authority: Pick<AccountRoutingAuthority, "setProbedCapability">;
  baseSettings: ProviderRuntimeSettings | undefined;
  logger: Logger;
  probe?: (settings: ProviderRuntimeSettings | undefined) => Promise<OmpCapabilityProbe>;
  /** Whether the probed OMP has the add-only login guard; false whenever nothing was learned. */
  onLoginGuard?: (supported: boolean) => void;
}): OmpCapabilityProber {
  const probe =
    options.probe ??
    ((settings) =>
      new OmpCliRuntime({
        logger: options.logger,
        runtimeSettings: settings,
        command: ["omp"],
      }).probeConfigured());
  let lastKey: string | undefined;
  let generation = 0;
  let disposed = false;
  return {
    update(override) {
      const settings = mergeRuntimeSettings(options.baseSettings, toRuntimeSettings(override));
      const enabled = override?.enabled !== false;
      const key = JSON.stringify([enabled, settings ?? null]);
      if (key === lastKey || disposed) return;
      lastKey = key;
      const mine = ++generation;
      if (!enabled) {
        options.onLoginGuard?.(false);
        options.authority.setProbedCapability({ status: "unknown", reason: null });
        return;
      }
      void (async () => {
        let next: Capability = { status: "unknown", reason: null };
        let loginGuard = false;
        try {
          const result = await probe(settings);
          next = capabilityFromProbe(result);
          loginGuard = result.loginExisting === true;
        } catch (error) {
          options.logger.warn({ err: error }, "OMP account routing capability probe failed");
        }
        if (mine !== generation || disposed) return;
        options.onLoginGuard?.(loginGuard);
        options.authority.setProbedCapability(next);
      })();
    },
    dispose() {
      disposed = true;
    },
  };
}
