import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { FEATURE_DEFAULTS_CWD, FeatureDefaultRow } from "@/components/feature-default-row";
import { type FieldControlSize } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import type { AgentFeature, AgentFeatureSelect } from "@getpaseo/protocol/agent-types";
import type { ProviderFeatureDefaults } from "@getpaseo/protocol/provider-config";

const OUTPUT_STYLE_FEATURE_ID = "output_style";

/**
 * Daemon-wide default for the Style feature. The options are every style any ready provider
 * offers, so a style that only one provider knows can still be picked; providers without it keep
 * their own default.
 */
export function DefaultOutputStyleCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsGlobalDefaults = useHostFeature(serverId, "globalFeatureDefaults");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId, { enabled: supportsGlobalDefaults });
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [isSaving, setIsSaving] = useState(false);

  const readyProviders = useMemo(
    () =>
      (entries ?? [])
        .filter((entry) => entry.enabled && entry.status === "ready")
        .map((entry) => entry.provider)
        .sort(),
    [entries],
  );

  const styleQuery = useFetchQuery({
    queryKey: ["globalOutputStyleFeature", serverId, readyProviders],
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    enabled: Boolean(client && isConnected && supportsGlobalDefaults && readyProviders.length > 0),
    retry: false,
    queryFn: async (): Promise<AgentFeatureSelect | null> => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payloads = await Promise.all(
        readyProviders.map((provider) =>
          client.listProviderFeatures({ provider, cwd: FEATURE_DEFAULTS_CWD }).catch(() => null),
        ),
      );
      let merged: AgentFeatureSelect | null = null;
      const seen = new Set<string>();
      for (const payload of payloads) {
        const feature = payload?.features?.find(
          (candidate): candidate is AgentFeatureSelect =>
            candidate.id === OUTPUT_STYLE_FEATURE_ID && candidate.type === "select",
        );
        if (!feature) continue;
        merged ??= { ...feature, value: null, options: [] };
        for (const option of feature.options) {
          if (seen.has(option.id)) continue;
          seen.add(option.id);
          merged.options.push(option);
        }
      }
      return merged;
    },
  });

  const featureDefaults = useMemo<ProviderFeatureDefaults>(
    () => config?.featureDefaults ?? {},
    [config?.featureDefaults],
  );

  const handleChange = useCallback(
    (feature: AgentFeature, value: boolean | string | null) => {
      // The daemon replaces the map wholesale, so send every default; omitting a key clears it.
      const next: ProviderFeatureDefaults = Object.fromEntries(
        Object.entries(featureDefaults).filter(([featureId]) => featureId !== feature.id),
      );
      if (value !== null) {
        next[feature.id] = value;
      }
      setIsSaving(true);
      void patchConfig({ featureDefaults: next })
        .then(() => queryClient.invalidateQueries({ queryKey: ["providerFeatures", serverId] }))
        .catch((error) => toast.error(toErrorMessage(error)))
        .finally(() => setIsSaving(false));
    },
    [featureDefaults, patchConfig, queryClient, serverId, toast],
  );

  // Providers report their styles only once their probe finishes; until then the row keeps its
  // place and shows the stored value, so the cards below do not jump.
  const loadedFeature = styleQuery.data;
  const feature = useMemo<AgentFeatureSelect>(
    () =>
      loadedFeature ?? {
        type: "select",
        id: OUTPUT_STYLE_FEATURE_ID,
        label: t("settings.host.agents.defaultStyle.title"),
        value: null,
        options: [],
      },
    [loadedFeature, t],
  );
  if (!isConnected || !supportsGlobalDefaults) {
    return null;
  }

  return (
    <View style={settingsStyles.card} testID="host-page-default-output-style-card">
      <FeatureDefaultRow
        feature={feature}
        stored={featureDefaults[OUTPUT_STYLE_FEATURE_ID]}
        isFirst
        disabled={isSaving || !styleQuery.data}
        size={controlSize}
        title={t("settings.host.agents.defaultStyle.title")}
        hint={t("settings.host.agents.defaultStyle.hint")}
        testIDPrefix="host-page-default-output-style"
        onChange={handleChange}
      />
    </View>
  );
}
