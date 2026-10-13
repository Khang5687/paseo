import type {
  AgentModelDefinition,
  AgentSelectOption,
  ProviderSnapshotEntry,
} from "./agent-types.js";

export interface CompactProviderSnapshotModel extends Omit<
  AgentModelDefinition,
  "provider" | "thinkingOptions"
> {
  thinkingSet?: number;
}

export interface CompactProviderSnapshotEntry extends Omit<
  ProviderSnapshotEntry,
  "models" | "disabledModels"
> {
  models?: CompactProviderSnapshotModel[];
  disabledModels?: CompactProviderSnapshotModel[];
}

export interface ProviderSnapshotThinkingSet {
  options: AgentSelectOption[];
  defaultOptionId?: string;
}

export interface CompactProviderSnapshot {
  entries: CompactProviderSnapshotEntry[];
  thinkingSets: ProviderSnapshotThinkingSet[];
}

function thinkingSetKey(set: ProviderSnapshotThinkingSet): string {
  return JSON.stringify(set);
}

function compactModel(
  {
    provider: _provider,
    thinkingOptions,
    defaultThinkingOptionId,
    ...modelFields
  }: AgentModelDefinition,
  thinkingSets: ProviderSnapshotThinkingSet[],
  thinkingSetIndexes: Map<string, number>,
): CompactProviderSnapshotModel {
  const compact: CompactProviderSnapshotModel = modelFields;

  if (thinkingOptions === undefined) {
    if (defaultThinkingOptionId !== undefined) {
      compact.defaultThinkingOptionId = defaultThinkingOptionId;
    }
    return compact;
  }

  const thinkingSet: ProviderSnapshotThinkingSet = {
    options: thinkingOptions,
    ...(defaultThinkingOptionId !== undefined ? { defaultOptionId: defaultThinkingOptionId } : {}),
  };
  const key = thinkingSetKey(thinkingSet);
  const existingIndex = thinkingSetIndexes.get(key);
  if (existingIndex !== undefined) {
    compact.thinkingSet = existingIndex;
    return compact;
  }

  const index = thinkingSets.length;
  thinkingSets.push(thinkingSet);
  thinkingSetIndexes.set(key, index);
  compact.thinkingSet = index;
  return compact;
}

export function compactProviderSnapshot(entries: ProviderSnapshotEntry[]): CompactProviderSnapshot {
  const thinkingSets: ProviderSnapshotThinkingSet[] = [];
  const thinkingSetIndexes = new Map<string, number>();
  const compactModels = (models: AgentModelDefinition[]) =>
    models.map((model) => compactModel(model, thinkingSets, thinkingSetIndexes));
  const compactEntries = entries.map((entry): CompactProviderSnapshotEntry => {
    const { models, disabledModels, ...entryFields } = entry;
    return {
      ...entryFields,
      ...(models !== undefined ? { models: compactModels(models) } : {}),
      ...(disabledModels !== undefined ? { disabledModels: compactModels(disabledModels) } : {}),
    };
  });
  return { entries: compactEntries, thinkingSets };
}

function expandModel(
  provider: string,
  model: CompactProviderSnapshotModel,
  thinkingSets: ProviderSnapshotThinkingSet[],
): AgentModelDefinition {
  const { thinkingSet: thinkingSetIndex, ...modelFields } = model;
  if (thinkingSetIndex === undefined) {
    return { provider, ...modelFields };
  }

  const thinkingSet = thinkingSets[thinkingSetIndex];
  if (!thinkingSet) {
    throw new RangeError(`Provider snapshot references missing thinking set ${thinkingSetIndex}`);
  }
  return {
    provider,
    ...modelFields,
    thinkingOptions: thinkingSet.options,
    ...(thinkingSet.defaultOptionId !== undefined
      ? { defaultThinkingOptionId: thinkingSet.defaultOptionId }
      : {}),
  };
}

export function expandProviderSnapshot(snapshot: CompactProviderSnapshot): ProviderSnapshotEntry[] {
  return snapshot.entries.map((entry): ProviderSnapshotEntry => {
    const { models, disabledModels, ...entryFields } = entry;
    const expandModels = (compact: CompactProviderSnapshotModel[]) =>
      compact.map((model) => expandModel(entryFields.provider, model, snapshot.thinkingSets));
    return {
      ...entryFields,
      ...(models !== undefined ? { models: expandModels(models) } : {}),
      ...(disabledModels !== undefined ? { disabledModels: expandModels(disabledModels) } : {}),
    };
  });
}
