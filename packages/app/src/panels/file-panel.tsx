import { Text, View } from "react-native";
import { useMemo } from "react";
import invariant from "tiny-invariant";
import { useTranslation } from "react-i18next";
import { FilePane } from "@/file-pane/pane";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useHosts } from "@/runtime/host-runtime";
import { createMaterialFileIcon } from "@/components/material-file-icon";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function useFilePanelDescriptor(target: { kind: "file"; path: string; serverId?: string }) {
  const fileName = target.path.split("/").findLast(Boolean) ?? target.path;
  const icon = useMemo(() => createMaterialFileIcon(fileName), [fileName]);
  const hostLabel = useOtherHostLabel(target.serverId);
  const location = hostLabel ? `${hostLabel}: ${target.path}` : target.path;
  return {
    label: fileName,
    subtitle: location,
    tooltip: location,
    titleState: "ready" as const,
    icon,
    statusBucket: null,
  };
}

function useOtherHostLabel(serverId: string | undefined): string | null {
  const hosts = useHosts();
  if (!serverId) return null;
  return hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
}

function FilePanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, panelRevision } = usePaneContext();
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  invariant(target.kind === "file", "FilePanel requires file target");
  // A file on another host has no workspace there; its path is absolute or `~`-relative.
  if (target.serverId) {
    return (
      <FilePane
        serverId={target.serverId}
        workspaceId={null}
        workspaceRoot=""
        location={target}
        navigationRevision={panelRevision ?? 0}
      />
    );
  }
  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <FilePane
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceDirectory}
      location={target}
      navigationRevision={panelRevision ?? 0}
    />
  );
}

export const filePanelRegistration = definePanel("file", {
  component: FilePanel,
  useDescriptor: useFilePanelDescriptor,
});
