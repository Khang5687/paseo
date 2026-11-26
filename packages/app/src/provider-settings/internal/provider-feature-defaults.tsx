import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import type { ProviderFeatureDefaults } from "@getpaseo/protocol/provider-config";
import { FEATURE_DEFAULTS_CWD, FeatureDefaultRow } from "@/components/feature-default-row";
import { SettingsSection } from "@/components/settings";
import { type ControlSize } from "@/components/ui/control-geometry";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";

const CONTROL_SIZE: ControlSize = "md";

/** The defaults a provider's features start with on every new agent. Absent when it has none. */
export function ProviderFeatureDefaultsSection({
  serverId,
  provider,
}: {
  serverId: string;
  provider: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsFeatureDefaults = useHostFeature(serverId, "providerFeatureDefaults");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [savingFeatureId, setSavingFeatureId] = useState<string | null>(null);

  const featuresQuery = useFetchQuery({
    queryKey: ["providerFeatureDefaults", serverId, provider],
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    enabled: Boolean(client && isConnected && supportsFeatureDefaults),
    retry: false,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listProviderFeatures({ provider, cwd: FEATURE_DEFAULTS_CWD });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? [];
    },
  });
  const features = featuresQuery.data;
  const featureDefaults = useMemo<ProviderFeatureDefaults>(
    () => config?.providers?.[provider]?.featureDefaults ?? {},
    [config?.providers, provider],
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
      setSavingFeatureId(feature.id);
      void patchConfig({ providers: { [provider]: { featureDefaults: next } } })
        .then(() => queryClient.invalidateQueries({ queryKey: ["providerFeatures", serverId] }))
        .catch((error) => toast.error(toErrorMessage(error)))
        .finally(() => {
          setSavingFeatureId((current) => (current === feature.id ? null : current));
        });
    },
    [featureDefaults, patchConfig, provider, queryClient, serverId, toast],
  );

  if (!supportsFeatureDefaults || !features || features.length === 0) {
    return null;
  }

  return (
    <SettingsSection
      title={t("settings.providers.featureDefaults.title")}
      testID="provider-feature-defaults"
    >
      <View style={settingsStyles.card}>
        {features.map((feature, index) => (
          <FeatureDefaultRow
            key={feature.id}
            feature={feature}
            stored={featureDefaults[feature.id]}
            isFirst={index === 0}
            disabled={savingFeatureId !== null}
            size={CONTROL_SIZE}
            onChange={handleChange}
          />
        ))}
      </View>
    </SettingsSection>
  );
}
