import type { TFunction } from "i18next";
import {
  Blocks,
  CalendarClock,
  Gauge,
  HardDriveDownload,
  History,
  NotebookPen,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react-native";
import type { ComponentType } from "react";
import { pluginIconComponent } from "@/plugins/icons";
import { builtinSidebarNavLabelKey, type BuiltinSidebarItemId, type SidebarNavItem } from "./model";

export type SidebarNavIconComponent = ComponentType<{ size: number; color: string }>;

const BUILTIN_ICONS: Record<BuiltinSidebarItemId, LucideIcon> = {
  "new-workspace": Plus,
  history: History,
  search: Search,
  schedules: CalendarClock,
  notes: NotebookPen,
  usage: Gauge,
  saved: HardDriveDownload,
};

/** Plugin items register no icon, so they share this one; a legacy `addSidebarItem` keeps its own. */
export const PLUGIN_SIDEBAR_NAV_ICON: LucideIcon = Blocks;

/** The icon Settings and the phone's button list show for an item. */
export function sidebarNavItemIcon(item: SidebarNavItem): SidebarNavIconComponent {
  if (item.kind === "builtin") return BUILTIN_ICONS[item.id];
  return item.group.kind === "legacy"
    ? pluginIconComponent(item.group.icon)
    : PLUGIN_SIDEBAR_NAV_ICON;
}

export function sidebarNavItemLabel(t: TFunction, item: SidebarNavItem): string {
  return item.kind === "builtin" ? t(builtinSidebarNavLabelKey(item.id)) : item.group.title;
}
