import { describe, expect, it } from "vitest";
import type { MicrophoneRoutes } from "@getpaseo/expo-two-way-audio";
import { buildMicrophoneMenu, type MicrophoneLabels } from "./microphone-menu";

const labels: MicrophoneLabels = {
  automatic: "Automatic",
  androidPicks: "Android picks",
  notConnected: (name) => `${name} is not connected`,
  phone: "Phone mic",
  wired: "Wired headset",
  usb: "USB headset",
  bluetooth: (name) => `${name} (Bluetooth)`,
  hearingAid: (name) => `${name} (hearing aid)`,
};

const phone = { key: "phone", kind: "phone", name: "Pixel 9" } as const;
const earbuds = {
  key: "bluetooth:Liberty 5 Pro",
  kind: "bluetooth",
  name: "Liberty 5 Pro",
} as const;

function state(overrides: Partial<MicrophoneRoutes>): MicrophoneRoutes {
  return {
    routes: [phone, earbuds],
    preferredKey: null,
    preferredName: null,
    activeKey: earbuds.key,
    ...overrides,
  };
}

describe("buildMicrophoneMenu", () => {
  it("ticks automatic and shows the mic Android picked when nothing is remembered", () => {
    const menu = buildMicrophoneMenu(state({}), labels);
    expect(menu.active).toEqual({ label: "Liberty 5 Pro", kind: "bluetooth" });
    expect(menu.rows).toEqual([
      { key: "phone", kind: "phone", label: "Phone mic", selected: false },
      {
        key: "bluetooth:Liberty 5 Pro",
        kind: "bluetooth",
        label: "Liberty 5 Pro (Bluetooth)",
        selected: false,
      },
      {
        key: null,
        kind: null,
        label: "Automatic",
        description: "Android picks",
        selected: true,
      },
    ]);
  });

  it("ticks the remembered mic when it is connected", () => {
    const menu = buildMicrophoneMenu(
      state({ preferredKey: "phone", preferredName: "Pixel 9", activeKey: "phone" }),
      labels,
    );
    expect(menu.active).toEqual({ label: "Phone mic", kind: "phone" });
    expect(menu.rows.filter((row) => row.selected).map((row) => row.key)).toEqual(["phone"]);
  });

  it("falls back to automatic and names the remembered mic when it is gone", () => {
    const menu = buildMicrophoneMenu(
      state({
        routes: [phone],
        preferredKey: earbuds.key,
        preferredName: earbuds.name,
        activeKey: "phone",
      }),
      labels,
    );
    expect(menu.active).toEqual({ label: "Phone mic", kind: "phone" });
    expect(menu.rows).toEqual([
      { key: "phone", kind: "phone", label: "Phone mic", selected: false },
      {
        key: null,
        kind: null,
        label: "Automatic",
        description: "Liberty 5 Pro is not connected",
        selected: true,
      },
    ]);
  });
});
