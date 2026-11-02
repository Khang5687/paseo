import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

const RETENTION_DAY_CHOICES = [1, 3, 7, 14, 30] as const;
const DEFAULT_RETENTION_DAYS = 7;

// Host-wide, persisted, and applied by the daemon's draft history pruning.
export function DraftHistoryRetentionCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "agentDraftSync");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: async (next: number) => {
      const result = await patchConfig({ draftHistoryRetentionDays: next });
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const options = useMemo<SegmentedControlOption<string>[]>(
    () =>
      RETENTION_DAY_CHOICES.map((days) => ({
        value: String(days),
        label: t("settings.host.agents.draftHistory.days", { count: days }),
        disabled: mutation.isPending,
        testID: `host-page-draft-history-retention-option-${days}`,
      })),
    [t, mutation.isPending],
  );

  const handleValueChange = useCallback(
    (next: string) => {
      mutation.mutate(Number(next));
    },
    [mutation],
  );

  if (!isConnected || !isSupported || !config) return null;

  const days = config.draftHistoryRetentionDays ?? DEFAULT_RETENTION_DAYS;

  return (
    <View style={settingsStyles.card} testID="host-page-draft-history-retention-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.agents.draftHistory.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.agents.draftHistory.hint", { count: days })}
          </Text>
          {mutation.error ? (
            <Text style={settingsStyles.rowError} testID="host-page-draft-history-retention-error">
              {mutation.error.message}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <SegmentedControl
          options={options}
          value={String(days)}
          onValueChange={handleValueChange}
          size="sm"
          testID="host-page-draft-history-retention-control"
        />
      </View>
    </View>
  );
}
