import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";

export type DrawerTerminal = ListTerminalsResponse["payload"]["terminals"][number];

/** Where the phone sheet rests. `chat` is the full-screen terminal sent behind the chat. */
export type PhoneDrawerSnap = "bar" | "half" | "full" | "chat";

export function buildChatDrawerKey(serverId: string, agentId: string): string {
  return `agent:${serverId}:${agentId}`;
}

/** The terminals in one chat's drawer, oldest first, so tabs keep their places. */
export function selectChatTerminals(
  terminals: readonly DrawerTerminal[],
  agentId: string,
): DrawerTerminal[] {
  return terminals
    .filter((terminal) => terminal.ownerAgentId === agentId)
    .sort((left, right) => {
      const byCreated = (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
      return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
    });
}

/** The remembered terminal while it lives, else the newest one. */
export function resolveActiveDrawerTerminalId(
  terminals: readonly DrawerTerminal[],
  rememberedId: string | null,
): string | null {
  if (rememberedId && terminals.some((terminal) => terminal.id === rememberedId)) {
    return rememberedId;
  }
  return terminals.at(-1)?.id ?? null;
}

/** The tab a sideways swipe or a closed tab lands on. */
export function neighborDrawerTerminalId(
  terminals: readonly DrawerTerminal[],
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  const index = terminals.findIndex((terminal) => terminal.id === currentId);
  if (index < 0) return terminals[0]?.id ?? null;
  return terminals[index + delta]?.id ?? null;
}

export type DrawerToggleStep = "open" | "focus" | "close";

/**
 * VS Code's terminal toggle: a hidden drawer opens with focus, an open drawer without focus takes
 * it, and a focused drawer closes and hands focus back to the composer.
 */
export function resolveDrawerToggle(input: { open: boolean; focused: boolean }): DrawerToggleStep {
  if (!input.open) return "open";
  return input.focused ? "close" : "focus";
}

export const DESKTOP_DRAWER_DEFAULT_HEIGHT = 280;
export const DESKTOP_DRAWER_MIN_HEIGHT = 120;
/** The chat keeps this much height above a docked drawer. */
export const DESKTOP_CHAT_MIN_HEIGHT = 160;

export function clampDesktopDrawerHeight(height: number, containerHeight: number): number {
  const max = Math.max(DESKTOP_DRAWER_MIN_HEIGHT, containerHeight - DESKTOP_CHAT_MIN_HEIGHT);
  return Math.round(Math.min(max, Math.max(DESKTOP_DRAWER_MIN_HEIGHT, height)));
}

export const PHONE_DRAWER_BAR_HEIGHT = 44;
export const PHONE_DRAWER_HALF_SHARE = 0.5;

/** The sheet's height in each snap; `chat` and `full` fill the pane. */
export function phoneDrawerSnapHeight(snap: PhoneDrawerSnap, containerHeight: number): number {
  "worklet";
  switch (snap) {
    case "bar":
      return PHONE_DRAWER_BAR_HEIGHT;
    case "half":
      return Math.round(containerHeight * PHONE_DRAWER_HALF_SHARE);
    case "full":
    case "chat":
      return containerHeight;
  }
}

/** A flick past this speed (points per second) moves one snap in its direction. */
const PHONE_DRAWER_FLICK_VELOCITY = 600;

/**
 * The snap a released drag settles on. `height` is the sheet's height at release and `velocityY`
 * the finger's speed, positive downward. A flick moves one snap from where the drag started; a
 * slow release settles on the nearest snap.
 */
export function settlePhoneDrawerDrag(input: {
  from: Exclude<PhoneDrawerSnap, "chat">;
  height: number;
  velocityY: number;
  containerHeight: number;
}): Exclude<PhoneDrawerSnap, "chat"> {
  "worklet";
  const order = ["bar", "half", "full"] as const;
  const fromIndex = order.indexOf(input.from);
  if (input.velocityY > PHONE_DRAWER_FLICK_VELOCITY) {
    return order[Math.max(0, fromIndex - 1)]!;
  }
  if (input.velocityY < -PHONE_DRAWER_FLICK_VELOCITY) {
    return order[Math.min(order.length - 1, fromIndex + 1)]!;
  }
  const heights = [
    PHONE_DRAWER_BAR_HEIGHT,
    Math.round(input.containerHeight * PHONE_DRAWER_HALF_SHARE),
    input.containerHeight,
  ];
  let nearest = 0;
  for (let index = 1; index < heights.length; index += 1) {
    if (Math.abs(heights[index]! - input.height) < Math.abs(heights[nearest]! - input.height)) {
      nearest = index;
    }
  }
  return order[nearest]!;
}

/** The line the thin bar shows: the last one with text, since rows below the cursor are blank. */
export function lastPrintedLine(lines: readonly string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length > 0) return line;
  }
  return "";
}
