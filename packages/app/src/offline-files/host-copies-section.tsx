import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  FileCopiesSettingsPayload,
  UpdateFileCopySettingsOptions,
} from "@getpaseo/client/internal/daemon-client";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { useFetchQueries } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { formatFileSize } from "@/utils/format-file-size";
import { NumberLimitRow } from "./settings-section";

const MB = 1024 * 1024;
// The phone reads a copy over the session socket, which caps a download at 64 MiB.
const HOST_COPY_BOUNDS = {
  keepDays: { min: 1, max: 365 },
  maxTotalMb: { min: 10, max: 1_000_000 },
  maxFileMb: { min: 1, max: 64 },
} as const;

type HostCopySettings = NonNullable<FileCopiesSettingsPayload["settings"]>;

const settingsKey = (serverId: string) => ["fileCopies", "settings", serverId] as const;

/**
 * "Copies on <host>": for each host that keeps copies of another host's files, how much it holds
 * and its limits. A host shows once it holds copies or another host sends to it.
 */
export function HostCopiesSection() {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const withFeature = useSessionStore((state) =>
    serverIds
      .filter((id) => state.sessions[id]?.serverInfo?.features?.fileCopies === true)
      .join("\n"),
  );
  const holders = useMemo(
    () =>
      hosts.filter(
        (host) =>
          statuses.get(host.serverId) === "online" &&
          withFeature.split("\n").includes(host.serverId),
      ),
    [hosts, statuses, withFeature],
  );
  const results = useFetchQueries<FileCopiesSettingsPayload>(
    holders.map((host) => ({
      queryKey: settingsKey(host.serverId),
      queryFn: async () => {
        const client = getHostRuntimeStore().getClient(host.serverId);
        if (!client) throw new Error(`Host ${host.serverId} is not connected`);
        return client.getFileCopySettings();
      },
      dataShape: "value",
      staleTimeMs: 30_000,
    })),
  );
  const targets = new Set(results.flatMap((result) => result.data?.settings?.targetServerId ?? []));
  const receivers = holders.flatMap((host, index) => {
    const data = results[index]?.data;
    if (!data?.settings) return [];
    const holds = (data.usage?.fileCount ?? 0) > 0 || targets.has(host.serverId);
    return holds ? [{ host, settings: data.settings, usage: data.usage }] : [];
  });

  return (
    <>
      {receivers.map(({ host, settings, usage }) => (
        <HostCopiesCard
          key={host.serverId}
          serverId={host.serverId}
          label={host.label}
          settings={settings}
          fileCount={usage?.fileCount ?? 0}
          totalBytes={usage?.totalBytes ?? 0}
        />
      ))}
    </>
  );
}

function HostCopiesCard({
  serverId,
  label,
  settings,
  fileCount,
  totalBytes,
}: {
  serverId: string;
  label: string;
  settings: HostCopySettings;
  fileCount: number;
  totalBytes: number;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const update = useCallback(
    async (change: Omit<UpdateFileCopySettingsOptions, "targetServerId">) => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) return;
      try {
        queryClient.setQueryData(
          settingsKey(serverId),
          await client.updateFileCopySettings(change),
        );
      } catch {
        await queryClient.invalidateQueries({ queryKey: settingsKey(serverId) });
      }
    },
    [queryClient, serverId],
  );
  const commitKeepDays = useCallback((keepDays: number) => void update({ keepDays }), [update]);
  const commitMaxTotal = useCallback(
    (mb: number) => void update({ maxTotalBytes: mb * MB }),
    [update],
  );
  const commitMaxFile = useCallback(
    (mb: number) => void update({ maxFileBytes: mb * MB }),
    [update],
  );
  return (
    <SettingsSection
      title={t("offlineFiles.hostCopies.title", { host: label })}
      testID={`host-copies-${serverId}`}
    >
      <SettingsCard>
        <SettingsRow
          label={t("offlineFiles.hostCopies.usage", {
            count: fileCount,
            size: formatFileSize(totalBytes),
          })}
          hint={t("offlineFiles.hostCopies.description", { host: label })}
          testID={`host-copies-usage-${serverId}`}
        />
        <NumberLimitRow
          label={t("offlineFiles.retentionDays.label")}
          hint={t("offlineFiles.hostCopies.keepDays")}
          value={settings.keepDays}
          bounds={HOST_COPY_BOUNDS.keepDays}
          onCommit={commitKeepDays}
          testID={`host-copies-keep-days-${serverId}`}
        />
        <NumberLimitRow
          label={t("offlineFiles.maxTotalMb.label")}
          hint={t("offlineFiles.maxTotalMb.description")}
          value={Math.round(settings.maxTotalBytes / MB)}
          bounds={HOST_COPY_BOUNDS.maxTotalMb}
          onCommit={commitMaxTotal}
          testID={`host-copies-max-total-${serverId}`}
        />
        <NumberLimitRow
          label={t("offlineFiles.maxFileMb.label")}
          hint={t("offlineFiles.maxFileMb.description")}
          value={Math.round(settings.maxFileBytes / MB)}
          bounds={HOST_COPY_BOUNDS.maxFileMb}
          onCommit={commitMaxFile}
          testID={`host-copies-max-file-${serverId}`}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
