import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginHostProps,
  PluginNeedsYouItemProps,
  PluginOpenScreenInput,
} from "@getpaseo/plugin/client";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { create } from "zustand";
import { useInstalledPlugins } from "../registry";
import { pluginScreensHostKey, rememberPluginContributionHost } from "../contribution-host";
import { pluginThemeMapping, renderNothing, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { buildPluginSurfaceRoute } from "../routes";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { parsePluginOpenScreenInput } from "../surface-contribution";
import type { InstalledPlugin, PluginNeedsYouItemContribution } from "../types";

interface NeedsYouItemTarget {
  /** `<pluginId>/<itemId>`. */
  key: string;
  plugin: InstalledPlugin;
  item: PluginNeedsYouItemContribution;
}

interface NeedsYouCountState {
  counts: Readonly<Record<string, number>>;
}

const useNeedsYouCountStore = create<NeedsYouCountState>(() => ({ counts: {} }));

function setCount(key: string, count: number | null): void {
  useNeedsYouCountStore.setState((state) => {
    if (count === null) {
      if (!(key in state.counts)) return state;
      const { [key]: _removed, ...rest } = state.counts;
      return { counts: rest };
    }
    if (state.counts[key] === count) return state;
    return { counts: { ...state.counts, [key]: count } };
  });
}

/**
 * Plugin Needs you items, one per `<pluginId>/<itemId>`: a plugin installed on two hosts counts
 * once, on the first host's copy, so the same tasks never count twice.
 */
function useNeedsYouItemTargets(): NeedsYouItemTarget[] {
  const installed = useInstalledPlugins();
  return useMemo(() => {
    const targets = new Map<string, NeedsYouItemTarget>();
    for (const plugin of installed) {
      for (const item of plugin.needsYouItems ?? []) {
        const key = `${plugin.id}/${item.id}`;
        if (!targets.has(key)) targets.set(key, { key, plugin, item });
      }
    }
    return [...targets.values()];
  }, [installed]);
}

/** What every plugin item counts, added up, for the rail's Needs you number. */
export function usePluginNeedsYouCount(): number {
  return useNeedsYouCountStore((state) =>
    Object.values(state.counts).reduce((sum, count) => sum + count, 0),
  );
}

/** Runs each plugin item's `useCount` for as long as the app runs. Mounted once, at the root. */
export function PluginNeedsYouCounters() {
  const targets = useNeedsYouItemTargets();
  return targets.map((target) => (
    <ThemedCounterHost key={target.key} target={target} uniProps={pluginThemeMapping} />
  ));
}

function CounterHost({ target, theme }: { target: NeedsYouItemTarget; theme: PluginTheme }) {
  const { environment, props } = usePluginItemHost(target.plugin, theme);
  return (
    <SurfaceErrorBoundary
      installation={target.plugin}
      Surface={target.item.Component}
      renderError={renderNothing}
    >
      <PluginEnvironmentProvider environment={environment}>
        <Counter targetKey={target.key} useCount={target.item.useCount} hostProps={props} />
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedCounterHost = withUnistyles(CounterHost);

function Counter({
  targetKey,
  useCount,
  hostProps,
}: {
  targetKey: string;
  useCount: PluginNeedsYouItemContribution["useCount"];
  hostProps: PluginHostProps;
}): null {
  const raw = useCount(hostProps);
  const count = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  useEffect(() => setCount(targetKey, count), [count, targetKey]);
  // Unmounted when the item goes away or its hook throws: either way it counts nothing.
  useEffect(() => () => setCount(targetKey, null), [targetKey]);
  return null;
}

/** The page rows of the plugin items whose count is above 0. */
export function PluginNeedsYouItems() {
  const targets = useNeedsYouItemTargets();
  const counts = useNeedsYouCountStore((state) => state.counts);
  return targets
    .filter((target) => (counts[target.key] ?? 0) > 0)
    .map((target) => (
      <ThemedItemHost
        key={target.key}
        target={target}
        count={counts[target.key] ?? 0}
        uniProps={pluginThemeMapping}
      />
    ));
}

function ItemHost({
  target,
  count,
  theme,
}: {
  target: NeedsYouItemTarget;
  count: number;
  theme: PluginTheme;
}) {
  const { plugin } = target;
  const { environment, props: hostProps } = usePluginItemHost(plugin, theme);
  const openScreen = useCallback(
    (input: PluginOpenScreenInput) => {
      const { screenId, params } = parsePluginOpenScreenInput(plugin, input);
      rememberPluginContributionHost(pluginScreensHostKey(plugin.id), plugin.serverId);
      router.push(
        buildPluginSurfaceRoute(
          plugin.serverId,
          plugin.id,
          { kind: "surface", id: screenId },
          params,
        ),
      );
    },
    [plugin],
  );
  const props = useMemo<PluginNeedsYouItemProps>(
    () => ({ ...hostProps, count, openScreen }),
    [count, hostProps, openScreen],
  );
  const Item = target.item.Component;
  return (
    <SurfaceErrorBoundary installation={target.plugin} Surface={Item} renderError={renderNothing}>
      <PluginEnvironmentProvider environment={environment}>
        <Item {...props} />
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedItemHost = withUnistyles(ItemHost);
