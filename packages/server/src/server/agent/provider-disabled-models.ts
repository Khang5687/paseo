import type { AgentModelDefinition, ProviderSnapshotEntry } from "./agent-sdk-types.js";

export class DisabledModelError extends Error {
  readonly code = "model_disabled" as const;

  constructor(
    readonly provider: string,
    readonly model: string,
  ) {
    super(`Model '${model}' is disabled for provider '${provider}' in Provider settings`);
    this.name = "DisabledModelError";
  }
}

export class NoEnabledModelError extends Error {
  readonly code = "no_enabled_model" as const;

  constructor(readonly provider: string) {
    super(`Every model for provider '${provider}' is disabled in Provider settings`);
    this.name = "NoEnabledModelError";
  }
}

/**
 * Moves disabled models out of `models` into `disabledModels`, so every reader of the
 * snapshot sees the enabled list and only Provider settings reads the disabled one.
 */
export function partitionDisabledModels(
  entry: ProviderSnapshotEntry,
  disabledModelIds: readonly string[],
): ProviderSnapshotEntry {
  const models = entry.models ?? [];
  const enabled = models.filter((model) => !disabledModelIds.includes(model.id));
  if (enabled.length === models.length) return entry;
  const disabled = models.filter((model) => disabledModelIds.includes(model.id));
  return { ...entry, models: enabled, disabledModels: disabled };
}

/**
 * Model-less creation uses the provider default when it is enabled, otherwise the first
 * enabled model in catalog order — the same model the app pickers preselect.
 */
export function pickDefaultEnabledModel(
  models: readonly AgentModelDefinition[],
  disabledModelIds: readonly string[],
): AgentModelDefinition | undefined {
  const enabled = models.filter((model) => !disabledModelIds.includes(model.id));
  return enabled.find((model) => model.isDefault) ?? enabled[0];
}

/**
 * Throws when a new selection would land on a disabled model. `requestedModel` may be an
 * alias; `catalog` resolves it to the canonical ID when available. An omitted model is
 * rejected only when the catalog proves every model is disabled.
 */
export function assertModelEnabled(input: {
  provider: string;
  requestedModel: string | undefined;
  disabledModelIds: readonly string[];
  catalog: readonly AgentModelDefinition[] | null;
}): void {
  const { provider, requestedModel, disabledModelIds, catalog } = input;
  if (disabledModelIds.length === 0) return;
  if (requestedModel) {
    const canonicalId =
      catalog?.find(
        (model) => model.id === requestedModel || model.aliases?.includes(requestedModel),
      )?.id ?? requestedModel;
    if (disabledModelIds.includes(canonicalId)) {
      throw new DisabledModelError(provider, requestedModel);
    }
    return;
  }
  const everyModelDisabled =
    catalog !== null &&
    catalog.length > 0 &&
    catalog.every((model) => disabledModelIds.includes(model.id));
  if (everyModelDisabled) throw new NoEnabledModelError(provider);
}
