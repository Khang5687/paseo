import type { AgentOptionControl, AgentOptionToggleControl } from "../../agent-sdk-types.js";
import { buildOutputStyleControl, type OutputStyle } from "../../output-styles.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";

export const CLAUDE_FAST_MODE_CONTROL: AgentOptionToggleControl = {
  type: "toggle",
  key: "fast_mode",
  label: "Fast",
  description: "Lower latency responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return claudeManifestModelSupportsFastMode(modelId);
}

export function buildClaudeControls(
  modelId: string | null | undefined,
  outputStyles: readonly OutputStyle[],
): AgentOptionControl[] {
  const controls: AgentOptionControl[] = [];
  if (claudeModelSupportsFastMode(modelId)) {
    controls.push({ ...CLAUDE_FAST_MODE_CONTROL });
  }
  controls.push(buildOutputStyleControl({ styles: outputStyles }));
  return controls;
}
