import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_MODES } from "@getpaseo/protocol/provider-manifest";
import { z } from "zod";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

const DEFAULT_OMP_MODE_ID = "full";
const DEFAULT_OMP_READY_TIMEOUT_MS = 20_000;
const DEFAULT_OMP_RPC_TIMEOUT_MS = 60_000;

export const MIN_SUPPORTED_OMP_VERSION = "16.3.9";
export { OMP_MODES };

export const OmpProviderOptionsSchema = z
  .object({
    sessionDir: z.string().min(1).optional(),
    rpcTimeoutMs: z.number().int().positive().optional(),
    smolModel: z.string().min(1).optional(),
    slowModel: z.string().min(1).optional(),
    planModel: z.string().min(1).optional(),
  })
  .strict();

export interface OmpRuntimeOptions {
  sessionDir?: string;
  readyTimeoutMs: number;
  rpcTimeoutMs: number;
}

export interface OmpModelRoles {
  smolModel?: string;
  slowModel?: string;
  planModel?: string;
}

/** The OMP `--approval-mode` each Paseo mode launches with. */
const OMP_APPROVAL_MODES: Readonly<Record<string, string>> = {
  full: "yolo",
  write: "write",
  ask: "always-ask",
  "read-only": "always-ask",
};

/**
 * The read-only files next to this module: the guard extension (`.ts` when the daemon runs from
 * source, `.js` from `dist`) and the config overlay. See `read-only-guard-extension.ts` for why
 * read-only mode needs them. OMP is a separate process that cannot read Electron's `app.asar`, so
 * the desktop app unpacks both files (`asarUnpack` in `packages/desktop/electron-builder.yml`)
 * and OMP loads those copies.
 */
export function resolveOmpReadOnlyFiles(moduleUrl: string = import.meta.url): {
  guardExtension: string;
  configOverlay: string;
} {
  const modulePath = fileURLToPath(moduleUrl);
  const beside = (fileName: string) =>
    join(dirname(modulePath), fileName).replace(
      `${sep}app.asar${sep}`,
      `${sep}app.asar.unpacked${sep}`,
    );
  return {
    guardExtension: beside(`read-only-guard-extension${extname(modulePath)}`),
    configOverlay: beside("read-only-config-overlay.yml"),
  };
}

const OMP_READ_ONLY_FILES = resolveOmpReadOnlyFiles();

/**
 * `read-only` launches like `ask` plus the guard extension, which keeps the tools that run without
 * a prompt inside the agent's folder, and the config overlay, which beats user and project config
 * so none of it can turn a prompt off; every shell command still asks.
 */
export function resolveOmpLaunchMode(
  modeId: string | undefined,
  modelRoles: OmpModelRoles = {},
): { modeId: string; extraArgs: string[] } {
  const resolvedModeId = modeId ?? DEFAULT_OMP_MODE_ID;
  const approvalMode = Object.hasOwn(OMP_APPROVAL_MODES, resolvedModeId)
    ? OMP_APPROVAL_MODES[resolvedModeId]
    : undefined;
  if (!approvalMode) {
    throw new Error(`Unsupported OMP mode '${modeId}'`);
  }
  const guardArgs =
    resolvedModeId === "read-only"
      ? [
          "--extension",
          OMP_READ_ONLY_FILES.guardExtension,
          "--config",
          OMP_READ_ONLY_FILES.configOverlay,
        ]
      : [];
  return {
    modeId: resolvedModeId,
    extraArgs: [
      "--approval-mode",
      approvalMode,
      ...guardArgs,
      ...resolveOmpModelRoleArgs(modelRoles),
    ],
  };
}

function resolveOmpModelRoleArgs(modelRoles: OmpModelRoles): string[] {
  const args: string[] = [];
  if (modelRoles.smolModel) args.push("--smol", modelRoles.smolModel);
  if (modelRoles.slowModel) args.push("--slow", modelRoles.slowModel);
  if (modelRoles.planModel) args.push("--plan", modelRoles.planModel);
  return args;
}

export interface OmpDiagnosticPaths {
  profile: string;
  configRoot: string;
  agentDir: string;
  agentDb: string;
  xdgDataRoot: string;
  xdgStateRoot: string;
  xdgCacheRoot: string;
}

export function resolveOmpDiagnosticPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): OmpDiagnosticPaths {
  const normalizedProfile = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
  const profile =
    normalizedProfile && normalizedProfile !== "default" ? normalizedProfile : "default";
  const baseConfigRoot = join(home, env.PI_CONFIG_DIR || ".omp");
  const configRoot =
    profile === "default" ? baseConfigRoot : join(baseConfigRoot, "profiles", profile);
  const defaultAgentDir = join(configRoot, "agent");
  const agentDir =
    profile === "default" && env.PI_CODING_AGENT_DIR
      ? resolve(env.PI_CODING_AGENT_DIR)
      : defaultAgentDir;
  const xdgSupported = platform === "linux" || platform === "darwin";
  const resolveXdgRoot = (variable: "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME") => {
    const base = env[variable];
    if (!xdgSupported || agentDir !== defaultAgentDir || !base) return undefined;
    const appRoot = join(base, "omp");
    const candidate = profile === "default" ? appRoot : join(appRoot, "profiles", profile);
    return existsSync(candidate) ? candidate : undefined;
  };
  const xdgDataRoot = resolveXdgRoot("XDG_DATA_HOME") ?? configRoot;
  const xdgStateRoot = resolveXdgRoot("XDG_STATE_HOME") ?? configRoot;
  const xdgCacheRoot = resolveXdgRoot("XDG_CACHE_HOME") ?? configRoot;

  return {
    profile,
    configRoot,
    agentDir,
    agentDb: join(xdgDataRoot === configRoot ? agentDir : xdgDataRoot, "agent.db"),
    xdgDataRoot,
    xdgStateRoot,
    xdgCacheRoot,
  };
}

export function formatOmpVersionSupport(versionOutput: string): string {
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return `unknown (minimum ${MIN_SUPPORTED_OMP_VERSION})`;
  const installed = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = MIN_SUPPORTED_OMP_VERSION.split(".").map(Number);
  const supported =
    installed[0]! > minimum[0]! ||
    (installed[0] === minimum[0] &&
      (installed[1]! > minimum[1]! ||
        (installed[1] === minimum[1]! && installed[2]! >= minimum[2]!)));
  return `${match[1]}.${match[2]}.${match[3]} (${supported ? "supported" : "unsupported"}; minimum ${MIN_SUPPORTED_OMP_VERSION})`;
}

export function resolveOmpProviderOptions(providerOptions: unknown): {
  runtimeOptions: OmpRuntimeOptions;
  modelRoles: OmpModelRoles;
} {
  const options = OmpProviderOptionsSchema.parse(providerOptions ?? {});
  const configuredRpcTimeoutMs = options.rpcTimeoutMs;
  return {
    runtimeOptions: {
      sessionDir: options.sessionDir,
      readyTimeoutMs: configuredRpcTimeoutMs ?? DEFAULT_OMP_READY_TIMEOUT_MS,
      rpcTimeoutMs: configuredRpcTimeoutMs ?? DEFAULT_OMP_RPC_TIMEOUT_MS,
    },
    modelRoles: {
      ...(options.smolModel ? { smolModel: options.smolModel } : {}),
      ...(options.slowModel ? { slowModel: options.slowModel } : {}),
      ...(options.planModel ? { planModel: options.planModel } : {}),
    },
  };
}

export function mergeOmpRuntimeSettings(
  base: ProviderRuntimeSettings | undefined,
  override: ProviderRuntimeSettings | undefined,
): ProviderRuntimeSettings | undefined {
  if (!base && !override) return undefined;
  return {
    command: override?.command ?? base?.command,
    env: base?.env || override?.env ? { ...base?.env, ...override?.env } : undefined,
    disallowedTools:
      base?.disallowedTools || override?.disallowedTools
        ? [...(base?.disallowedTools ?? []), ...(override?.disallowedTools ?? [])]
        : undefined,
  };
}
