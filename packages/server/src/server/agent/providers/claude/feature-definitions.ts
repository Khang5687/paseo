import type { AgentFeature, AgentFeatureToggle } from "../../agent-sdk-types.js";
import { buildOutputStyleFeature, type OutputStyle } from "../../output-styles.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";

export const CLAUDE_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return claudeManifestModelSupportsFastMode(modelId);
}

export function buildClaudeFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  outputStyles: readonly OutputStyle[];
  outputStyle: string | null;
}): AgentFeature[] {
  const features: AgentFeature[] = [];
  if (claudeModelSupportsFastMode(input.modelId)) {
    features.push({ ...CLAUDE_FAST_MODE_FEATURE, value: input.fastModeEnabled });
  }
  features.push(buildOutputStyleFeature({ styles: input.outputStyles, value: input.outputStyle }));
  return features;
}
