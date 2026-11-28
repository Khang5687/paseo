import type {
  MicrophoneRoute,
  MicrophoneRouteKind,
  MicrophoneRoutes,
} from "@getpaseo/expo-two-way-audio";

export interface MicrophoneLabels {
  automatic: string;
  androidPicks: string;
  notConnected: (name: string) => string;
  phone: string;
  wired: string;
  usb: string;
  bluetooth: (name: string) => string;
  hearingAid: (name: string) => string;
}

export interface MicrophoneMenuRow {
  /** The key to pick; null is automatic. */
  key: string | null;
  /** Null on the automatic row. */
  kind: MicrophoneRouteKind | null;
  label: string;
  description?: string;
  selected: boolean;
}

export interface MicrophoneMenu {
  /** What the panel button shows: the mic in use (a headset by its own name), or null if none. */
  active: { label: string; kind: MicrophoneRouteKind } | null;
  rows: MicrophoneMenuRow[];
}

export function microphoneLabel(route: MicrophoneRoute, labels: MicrophoneLabels): string {
  switch (route.kind) {
    case "phone":
      return labels.phone;
    case "wired":
      return labels.wired;
    case "usb":
      return labels.usb;
    case "bluetooth":
      return labels.bluetooth(route.name);
    case "hearing_aid":
      return labels.hearingAid(route.name);
  }
}

/**
 * One row per connected mic plus automatic. A remembered mic that is not connected gets no row
 * of its own: automatic is ticked, since that is what Android uses, and its description names
 * the missing mic so the fallback is not silent.
 */
export function buildMicrophoneMenu(
  state: MicrophoneRoutes,
  labels: MicrophoneLabels,
): MicrophoneMenu {
  const preferredConnected = state.routes.some((route) => route.key === state.preferredKey);
  const chosenKey = preferredConnected ? state.preferredKey : null;
  const active = state.routes.find((route) => route.key === state.activeKey);
  const missingName = state.preferredName ?? state.preferredKey;
  return {
    active: active ? { label: buttonLabel(active, labels), kind: active.kind } : null,
    rows: [
      ...state.routes.map((route) => ({
        key: route.key,
        kind: route.kind,
        label: microphoneLabel(route, labels),
        selected: route.key === chosenKey,
      })),
      {
        key: null,
        kind: null,
        label: labels.automatic,
        description:
          missingName !== null && !preferredConnected
            ? labels.notConnected(missingName)
            : labels.androidPicks,
        selected: chosenKey === null,
      },
    ],
  };
}

/** A headset reads as its own name on the button; the menu rows add what kind it is. */
function buttonLabel(route: MicrophoneRoute, labels: MicrophoneLabels): string {
  return route.kind === "bluetooth" || route.kind === "hearing_aid"
    ? route.name
    : microphoneLabel(route, labels);
}
