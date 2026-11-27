import type { PluginBadge } from "@getpaseo/plugin/client";
import type { SidebarNavIconComponent } from "@/sidebar-nav/item-presentation";
import type { SidebarNavItem } from "@/sidebar-nav/model";

/**
 * Which header buttons the phone keeps in its row when they do not all fit. Lower stays longer:
 * New workspace and Search are what people reach for, plugin buttons go to More first.
 */
const BUILTIN_KEEP_RANK: Record<string, number> = {
  "new-workspace": 0,
  search: 1,
  history: 2,
  schedules: 3,
  notes: 4,
};
const PLUGIN_KEEP_RANK = 5;

export function sidebarNavItemKeepRank(item: SidebarNavItem<"header">): number {
  if (item.kind === "plugin") return PLUGIN_KEEP_RANK;
  return BUILTIN_KEEP_RANK[item.id] ?? PLUGIN_KEEP_RANK;
}

/** One icon button as the row places it. An item may draw several buttons (a row per bot). */
export interface IconRowButtonPosition {
  key: string;
  /** The item's place in the user's display order. */
  itemOrder: number;
  /** `sidebarNavItemKeepRank` of the item. */
  keepRank: number;
  /** The button's place among its item's buttons. */
  seq: number;
}

function byDisplayOrder(a: IconRowButtonPosition, b: IconRowButtonPosition): number {
  return a.itemOrder - b.itemOrder || a.seq - b.seq;
}

function byKeepOrder(a: IconRowButtonPosition, b: IconRowButtonPosition): number {
  return a.keepRank - b.keepRank || byDisplayOrder(a, b);
}

/**
 * The keys of the buttons that move into More, in display order. `slots` is how many buttons
 * fit, More included: when everything fits there is no More; otherwise More takes the last slot.
 */
export function planIconRowOverflow(
  buttons: readonly IconRowButtonPosition[],
  slots: number,
): string[] {
  if (buttons.length <= slots) return [];
  const keep = new Set(
    [...buttons]
      .sort(byKeepOrder)
      .slice(0, Math.max(slots - 1, 0))
      .map((button) => button.key),
  );
  return [...buttons]
    .sort(byDisplayOrder)
    .filter((button) => !keep.has(button.key))
    .map((button) => button.key);
}

/** What the More menu shows for a button that moved there. */
export interface IconRowOverflowEntry {
  key: string;
  label: string;
  icon: SidebarNavIconComponent | null;
  badge: PluginBadge | null;
  /** The button's own test ID, for the menu row's. */
  testID: string | null;
  press: () => void;
}

export type IconRowButtonDisplay = Omit<IconRowOverflowEntry, "key" | "press">;

interface Registration {
  position: IconRowButtonPosition;
  display: IconRowButtonDisplay;
  press: () => void;
}

function sameBadge(a: PluginBadge | null, b: PluginBadge | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.count === b.count && a.tone === b.tone;
}

function sameDisplay(a: IconRowButtonDisplay, b: IconRowButtonDisplay): boolean {
  return (
    a.label === b.label && a.icon === b.icon && a.testID === b.testID && sameBadge(a.badge, b.badge)
  );
}

const NO_ENTRIES: readonly IconRowOverflowEntry[] = [];

/**
 * The phone icon row's buttons. Each button registers here while it is mounted, the row reports
 * how many fit, and each button reads whether it stays in the row or moves to More. Buttons in
 * More stay mounted (a plugin item keeps its state and popover) and draw nothing.
 */
export class IconRowOverflowStore {
  private readonly registrations = new Map<string, Registration>();
  private readonly listeners = new Set<() => void>();
  private slots = Number.POSITIVE_INFINITY;
  private overflowKeys: ReadonlySet<string> = new Set();
  private entries: readonly IconRowOverflowEntry[] = NO_ENTRIES;
  private nextSeq = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isOverflow(key: string): boolean {
    return this.overflowKeys.has(key);
  }

  getEntries = (): readonly IconRowOverflowEntry[] => this.entries;

  setSlots(slots: number): void {
    if (slots === this.slots) return;
    this.slots = slots;
    this.replan();
  }

  /** Mount order is the order of an item's own buttons, so the store numbers them. */
  register(
    position: Omit<IconRowButtonPosition, "seq">,
    display: IconRowButtonDisplay,
    press: () => void,
  ): void {
    this.nextSeq += 1;
    this.registrations.set(position.key, {
      position: { ...position, seq: this.nextSeq },
      display,
      press,
    });
    // A button that comes back under a key already in More brings a new press.
    if (!this.replan() && this.overflowKeys.has(position.key)) this.rebuildEntries();
  }

  unregister(key: string): void {
    if (!this.registrations.delete(key)) return;
    this.replan();
  }

  /** A label, icon or badge change. Only entries in More are drawn from it. */
  updateDisplay(key: string, display: IconRowButtonDisplay): void {
    const registration = this.registrations.get(key);
    if (!registration || sameDisplay(registration.display, display)) return;
    registration.display = display;
    if (this.overflowKeys.has(key)) this.rebuildEntries();
  }

  /** Recomputes which buttons move to More; answers whether that changed. */
  private replan(): boolean {
    const positions = [...this.registrations.values()].map((registration) => registration.position);
    const keys = planIconRowOverflow(positions, this.slots);
    const current = [...this.overflowKeys];
    if (keys.length === current.length && keys.every((key, index) => key === current[index])) {
      return false;
    }
    this.overflowKeys = new Set(keys);
    this.rebuildEntries();
    return true;
  }

  private rebuildEntries(): void {
    const entries: IconRowOverflowEntry[] = [];
    for (const key of this.overflowKeys) {
      const registration = this.registrations.get(key);
      if (registration) entries.push({ key, ...registration.display, press: registration.press });
    }
    this.entries = entries.length === 0 ? NO_ENTRIES : entries;
    for (const listener of this.listeners) listener();
  }
}
