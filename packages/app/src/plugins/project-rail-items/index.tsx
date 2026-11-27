import type { PluginBadge } from "@getpaseo/plugin/client";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useCallback, useMemo, type ComponentType } from "react";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createPluginClientStateSource } from "../client-state/source";
import {
  getPreferredPluginContributionHost,
  pluginScreensHostKey,
  rememberPluginContributionHost,
} from "../contribution-host";
import { readPluginBadge } from "../badge";
import { pluginIconComponent } from "../icons";
import { PluginEnvironmentProvider, type PluginEnvironment } from "../popover";
import { useInstalledPlugins } from "../registry";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "../routes";
import { currentPluginScreen } from "../surface-contribution";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import type { InstalledPlugin, PluginProjectRailItemContribution } from "../types";

/** What the rail draws for one plugin button. The rail owns the look; this module owns the rest. */
export interface ProjectRailButtonProps {
  icon: ComponentType<{ size: number; color: string }>;
  label: string;
  open: boolean;
  selected: boolean;
  badge: PluginBadge | null;
  onPress: () => void;
  testID: string;
}

interface ProjectRailTarget {
  plugin: InstalledPlugin;
  item: PluginProjectRailItemContribution;
}

/** One rail button, coalesced across every host whose plugin adds it. */
interface ProjectRailGroup {
  key: string;
  pluginId: string;
  itemId: string;
  targets: ProjectRailTarget[];
}

/**
 * Every plugin's project rail buttons, one per plugin and item id. A button whose screen the
 * plugin never added is left out on that host.
 */
function groupProjectRailItems(plugins: InstalledPlugin[]): ProjectRailGroup[] {
  const groups = new Map<string, ProjectRailGroup>();
  for (const plugin of plugins) {
    for (const item of plugin.projectRailItems) {
      if (!plugin.surfaces.some((surface) => surface.id === item.screen)) continue;
      const key = `${plugin.id}/${item.id}`;
      const group = groups.get(key);
      if (group) group.targets.push({ plugin, item });
      else
        groups.set(key, { key, pluginId: plugin.id, itemId: item.id, targets: [{ plugin, item }] });
    }
  }
  return [...groups.values()];
}

/** The current route's host, else the host the plugin's screens last used, else the first. */
function selectTarget(group: ProjectRailGroup, currentHostId: string | null): ProjectRailTarget {
  const remembered = getPreferredPluginContributionHost(pluginScreensHostKey(group.pluginId));
  return (
    group.targets.find((target) => target.plugin.serverId === currentHostId) ??
    group.targets.find((target) => target.plugin.serverId === remembered) ??
    group.targets[0]
  );
}

/** Plugin buttons for the desktop project rail, below the projects. */
export function PluginProjectRailItems({
  open,
  Button,
}: {
  open: boolean;
  Button: ComponentType<ProjectRailButtonProps>;
}) {
  const plugins = useInstalledPlugins();
  const groups = useMemo(() => groupProjectRailItems(plugins), [plugins]);
  return (
    <>
      {groups.map((group) => (
        <PluginProjectRailItem key={group.key} group={group} open={open} Button={Button} />
      ))}
    </>
  );
}

/** Whether any plugin adds a rail button, so the rail can skip the divider above them. */
export function useHasPluginProjectRailItems(): boolean {
  const plugins = useInstalledPlugins();
  return useMemo(() => groupProjectRailItems(plugins).length > 0, [plugins]);
}

function PluginProjectRailItem({
  group,
  open,
  Button,
}: {
  group: ProjectRailGroup;
  open: boolean;
  Button: ComponentType<ProjectRailButtonProps>;
}) {
  const pathname = usePathname();
  const routeParams = useGlobalSearchParams();
  const { plugin, item } = selectTarget(group, hostIdFromPathname(pathname));
  const client = useHostRuntimeClient(plugin.serverId);
  const toast = useToast();
  const environment = useMemo<PluginEnvironment>(
    () => ({ installation: plugin, toast, state: createPluginClientStateSource(plugin.serverId) }),
    [plugin, toast],
  );
  const selected = group.targets.some(
    (target) =>
      currentPluginScreen(target.plugin, pathname, routeParams)?.screenId === target.item.screen,
  );
  const handlePress = useCallback(() => {
    rememberPluginContributionHost(pluginScreensHostKey(plugin.id), plugin.serverId);
    router.push(
      buildPluginSurfaceRoute(plugin.serverId, plugin.id, { kind: "surface", id: item.screen }),
    );
  }, [item.screen, plugin.id, plugin.serverId]);
  const icon = useMemo(() => pluginIconComponent(item.icon), [item.icon]);
  const label = plugin.i18n.resolve(item.title, plugin.locale);
  const testID = `plugin-project-rail-${group.pluginId}-${group.itemId}`;
  const buttonProps = useMemo(
    () => ({ icon, label, open, selected, onPress: handlePress, testID }),
    [handlePress, icon, label, open, selected, testID],
  );
  const useBadge = item.useBadge;
  const renderWithoutBadge = useCallback(
    () => <Button {...buttonProps} badge={null} />,
    [Button, buttonProps],
  );
  if (!useBadge || !client) return <Button {...buttonProps} badge={null} />;
  // The badge hook runs in the plugin's runtime; if it throws, the button still shows, bare.
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={useBadge} renderError={renderWithoutBadge}>
      <PluginEnvironmentProvider environment={environment}>
        <BadgedRailButton {...buttonProps} useBadge={useBadge} Button={Button} />
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

function BadgedRailButton({
  useBadge,
  Button,
  ...buttonProps
}: Omit<ProjectRailButtonProps, "badge"> & {
  useBadge: () => PluginBadge | null;
  Button: ComponentType<ProjectRailButtonProps>;
}) {
  const badge = readPluginBadge(useBadge());
  return <Button {...buttonProps} badge={badge} />;
}
