import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

export interface ProviderDiscoveredModelsCache {
  serverId: string;
  provider: string;
  models: AgentModelDefinition[];
}

export interface ResolveProviderDiscoveredModelsInput {
  serverId: string;
  provider: string;
  currentModels: AgentModelDefinition[] | undefined;
  currentDisabledModels: AgentModelDefinition[] | undefined;
  providerSnapshotRefreshing: boolean;
  previousCache: ProviderDiscoveredModelsCache | null;
}

export interface ResolveProviderDiscoveredModelsResult {
  models: AgentModelDefinition[];
  cache: ProviderDiscoveredModelsCache | null;
}

// Disabling a model moves it from the snapshot's `models` to `disabledModels`. Rows keep the
// position they already had so a toggle never makes the list jump under the pointer.
function keepPreviousOrder(
  models: AgentModelDefinition[],
  previous: AgentModelDefinition[],
): AgentModelDefinition[] {
  const previousIndex = new Map(previous.map((model, index) => [model.id, index]));
  const ranked = models.map((model, index) => ({
    model,
    rank: previousIndex.get(model.id) ?? previous.length + index,
  }));
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map(({ model }) => model);
}

export function resolveProviderDiscoveredModels({
  serverId,
  provider,
  currentModels,
  currentDisabledModels,
  providerSnapshotRefreshing,
  previousCache,
}: ResolveProviderDiscoveredModelsInput): ResolveProviderDiscoveredModelsResult {
  const reportedModels = filterSelectableModels([
    ...(currentModels ?? []),
    ...(currentDisabledModels ?? []),
  ]);
  const providerCache =
    previousCache?.serverId === serverId && previousCache.provider === provider
      ? previousCache
      : null;
  if (reportedModels && reportedModels.length > 0) {
    const models = providerCache
      ? keepPreviousOrder(reportedModels, providerCache.models)
      : reportedModels;
    return { models, cache: { serverId, provider, models } };
  }

  if (providerSnapshotRefreshing && providerCache) {
    return { models: providerCache.models, cache: providerCache };
  }

  return { models: [], cache: previousCache };
}
