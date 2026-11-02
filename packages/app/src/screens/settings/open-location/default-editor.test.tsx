/**
 * @vitest-environment jsdom
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopEditorTargetDescriptor } from "@/desktop/host";
import { usePreferredEditor } from "@/hooks/use-preferred-editor";
import { useDefaultEditorSetting } from "./default-editor";

const DEFAULT_EDITOR_KEY = "@paseo:preferred-editor";
const TERMINAL_ICON = { kind: "symbol", name: "terminal" } as const;
const CURSOR = { id: "cursor", label: "Cursor", kind: "editor", icon: TERMINAL_ICON } as const;
const ZED = { id: "zed", label: "Zed", kind: "editor", icon: TERMINAL_ICON } as const;
const FINDER = {
  id: "finder",
  label: "Finder",
  kind: "file-manager",
  icon: TERMINAL_ICON,
} as const;

// Settings is opened inside the desktop app, which reports what is installed on this machine.
function installDesktopEditors(targets: DesktopEditorTargetDescriptor[]) {
  window.paseoDesktop = {
    editor: {
      listTargets: async () => targets,
      openTarget: async () => {},
    },
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

async function settledSetting() {
  const rendered = renderHook(() => useDefaultEditorSetting(), { wrapper });
  await waitFor(() => expect(rendered.result.current).not.toBeNull());
  return rendered;
}

describe("default editor setting", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    delete window.paseoDesktop;
  });

  it("offers the installed editors, not file managers, with the saved default selected", async () => {
    await AsyncStorage.setItem(DEFAULT_EDITOR_KEY, "zed");
    installDesktopEditors([CURSOR, FINDER, ZED]);

    const { result } = await settledSetting();

    expect(result.current?.editors.map((editor) => editor.id)).toEqual(["cursor", "zed"]);
    expect(result.current?.selected.id).toBe("zed");
  });

  it("shows the first installed editor when the saved default is no longer installed", async () => {
    await AsyncStorage.setItem(DEFAULT_EDITOR_KEY, "sublime");
    installDesktopEditors([CURSOR, ZED]);

    const { result } = await settledSetting();

    expect(result.current?.selected.id).toBe("cursor");
  });

  it("hides the row when the desktop reports no editors", async () => {
    installDesktopEditors([FINDER]);

    const { result } = renderHook(() => useDefaultEditorSetting(), { wrapper });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(result.current).toBeNull();
  });

  it("a new choice is selected, survives a restart, and reaches projects without their own editor", async () => {
    installDesktopEditors([CURSOR, ZED]);
    const { result } = await settledSetting();
    expect(result.current?.selected.id).toBe("cursor");

    act(() => result.current?.select("zed"));
    await waitFor(() => expect(result.current?.selected.id).toBe("zed"));

    cleanup();
    queryClient.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const restarted = await settledSetting();
    expect(restarted.result.current?.selected.id).toBe("zed");

    const project = renderHook(() => usePreferredEditor({ serverId: "host", projectId: "p" }), {
      wrapper,
    });
    await waitFor(() => expect(project.result.current.preferredEditorId).toBe("zed"));
  });
});
