import { i18n } from "@/i18n/i18next";
import { chooseHostFrom } from "@/hosts/host-chooser";
import { getOfflineFile } from "@/offline-files/store";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { pickFileHost, type FileHostCandidate, type FileHostPick } from "./host-pick";

/**
 * Picks the host for a file a chat names outside its workspace, across every host the app knows.
 * The chat's own host is asked first and listed first in the chooser.
 */
export async function pickFileHostForChat(input: {
  path: string;
  chatServerId: string;
}): Promise<FileHostPick> {
  const store = getHostRuntimeStore();
  const hosts = store.getHosts();
  if (hosts.length < 2) return { kind: "chatHost" };
  const ordered = [
    ...hosts.filter((host) => host.serverId === input.chatServerId),
    ...hosts.filter((host) => host.serverId !== input.chatServerId),
  ];
  const candidates = ordered.map(
    (host): FileHostCandidate => ({
      serverId: host.serverId,
      label: host.label,
      client: isHostRuntimeConnected(store.getSnapshot(host.serverId))
        ? store.getClient(host.serverId)
        : null,
      hasSavedCopy: async (path) => (await getOfflineFile(host.serverId, path)) !== null,
    }),
  );
  return pickFileHost({
    path: input.path,
    chatServerId: input.chatServerId,
    hosts: candidates,
    choose: (matches) =>
      chooseHostFrom({
        title: i18n.t("panels.file.openFrom"),
        serverIds: matches.map((match) => match.serverId),
      }),
  });
}
