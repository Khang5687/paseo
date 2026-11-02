import { describe, expect, it } from "vitest";

import {
  applyTerminalRendererReadyChange,
  resolveTerminalStreamTarget,
  shouldShowTerminalLoadingOverlay,
} from "./terminal-renderer-readiness";

describe("terminal-renderer-readiness", () => {
  it("preserves the attach loader even after the renderer is ready", () => {
    expect(
      shouldShowTerminalLoadingOverlay({
        isWorkspaceFocused: true,
        hasStreamError: false,
        isAttaching: true,
        rendererReadyStreamKey: "scope:terminal-1",
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(true);
  });

  it("keeps the loader visible until the current renderer is ready", () => {
    expect(
      shouldShowTerminalLoadingOverlay({
        isWorkspaceFocused: true,
        hasStreamError: false,
        isAttaching: false,
        rendererReadyStreamKey: null,
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(true);
  });

  it("hides the loader only after attach completes and the current renderer is ready", () => {
    expect(
      shouldShowTerminalLoadingOverlay({
        isWorkspaceFocused: true,
        hasStreamError: false,
        isAttaching: false,
        rendererReadyStreamKey: "scope:terminal-1",
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(false);
  });

  it("does not cover stream errors", () => {
    expect(
      shouldShowTerminalLoadingOverlay({
        isWorkspaceFocused: true,
        hasStreamError: true,
        isAttaching: true,
        rendererReadyStreamKey: null,
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(false);
  });

  it("ignores stale unready events from an old renderer", () => {
    const current = applyTerminalRendererReadyChange("scope:terminal-2", {
      streamKey: "scope:terminal-1",
      isReady: false,
    });

    expect(current).toBe("scope:terminal-2");
  });

  it("clears readiness when the current renderer unmounts", () => {
    const current = applyTerminalRendererReadyChange("scope:terminal-1", {
      streamKey: "scope:terminal-1",
      isReady: false,
    });

    expect(current).toBeNull();
  });

  const onScreen = {
    terminalId: "terminal-1",
    terminalStreamKey: "scope:terminal-1",
    rendererReadyStreamKey: "scope:terminal-1",
    isWorkspaceFocused: true,
    isPanelActive: true,
    isAppVisible: true,
    streamHiddenTabs: false,
  };

  it("does not attach the stream before the matching renderer is ready", () => {
    expect(resolveTerminalStreamTarget({ ...onScreen, rendererReadyStreamKey: null })).toBeNull();
  });

  it("attaches the stream after the matching renderer is ready", () => {
    expect(resolveTerminalStreamTarget(onScreen)).toBe("terminal-1");
  });

  it("detaches and restores the same stream across renderer replacement", () => {
    const targetForRenderer = (rendererReadyStreamKey: string | null) =>
      resolveTerminalStreamTarget({ ...onScreen, rendererReadyStreamKey });

    expect([
      targetForRenderer("scope:terminal-1"),
      targetForRenderer(null),
      targetForRenderer("scope:terminal-1"),
    ]).toEqual(["terminal-1", null, "terminal-1"]);
  });

  it("on phones, streams only while the terminal tab is shown and the app is visible", () => {
    const target = (state: { isPanelActive: boolean; isAppVisible: boolean }) =>
      resolveTerminalStreamTarget({ ...onScreen, ...state });

    expect([
      target({ isPanelActive: true, isAppVisible: true }),
      target({ isPanelActive: false, isAppVisible: true }),
      target({ isPanelActive: true, isAppVisible: false }),
      target({ isPanelActive: true, isAppVisible: true }),
    ]).toEqual(["terminal-1", null, null, "terminal-1"]);
  });

  it("on desktop, keeps hidden tabs of the focused workspace streaming", () => {
    const desktop = { ...onScreen, streamHiddenTabs: true };

    expect([
      resolveTerminalStreamTarget({ ...desktop, isPanelActive: false }),
      resolveTerminalStreamTarget({ ...desktop, isAppVisible: false }),
      resolveTerminalStreamTarget({ ...desktop, isWorkspaceFocused: false }),
    ]).toEqual(["terminal-1", "terminal-1", null]);
  });
});
