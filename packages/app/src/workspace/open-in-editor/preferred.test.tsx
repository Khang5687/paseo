/**
 * @vitest-environment jsdom
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { OpenDesktopTargetInput } from "@/workspace/desktop-open-targets";
import { useOpenInPreferredEditor } from "./preferred";

const LOCAL_SERVER_ID = "local-host";
const WORKSPACE = "/Users/test/project";
const DEFAULT_EDITOR_KEY = "@paseo:preferred-editor";
const TERMINAL_ICON = { kind: "symbol", name: "terminal" } as const;

// The desktop app as the renderer sees it: a local daemon and two installed editors.
function installDesktopHost(opened: OpenDesktopTargetInput[]) {
  window.paseoDesktop = {
    invoke: async (command) => {
      if (command !== "desktop_daemon_status") throw new Error(`Unexpected command ${command}`);
      return { serverId: LOCAL_SERVER_ID, status: "running" };
    },
    editor: {
      listTargets: async () => [
        { id: "cursor", label: "Cursor", kind: "editor", icon: TERMINAL_ICON },
        { id: "zed", label: "Zed", kind: "editor", icon: TERMINAL_ICON },
      ],
      openTarget: async (input) => {
        opened.push(input);
      },
    },
  };
}

const toast: ToastApi = { show: () => () => {}, copied: () => {}, error: () => {} };

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastApiProvider api={toast}>{children}</ToastApiProvider>
    </QueryClientProvider>
  );
}

let queryClient: QueryClient;

async function openFileFrom(projectId: string | null, opened: OpenDesktopTargetInput[]) {
  const { result } = renderHook(
    () =>
      useOpenInPreferredEditor({
        serverId: LOCAL_SERVER_ID,
        workspaceDirectory: WORKSPACE,
        projectId,
      }),
    { wrapper },
  );
  await waitFor(() => expect(result.current).not.toBeNull());
  result.current?.openFile({ path: `${WORKSPACE}/src/app.ts`, lineStart: 7 });
  await waitFor(() => expect(opened).toHaveLength(1));
  return { targetName: result.current?.targetName, opened: opened[0] };
}

describe("opening files in the preferred editor", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    delete window.paseoDesktop;
  });

  it("opens links outside any project in the default editor chosen in Settings", async () => {
    await AsyncStorage.setItem(DEFAULT_EDITOR_KEY, "zed");
    const opened: OpenDesktopTargetInput[] = [];
    installDesktopHost(opened);

    expect(await openFileFrom(null, opened)).toEqual({
      targetName: "Zed",
      opened: {
        editorId: "zed",
        workspacePath: WORKSPACE,
        filePath: `${WORKSPACE}/src/app.ts`,
        line: 7,
      },
    });
  });

  it("opens a project without its own choice in the default editor", async () => {
    await AsyncStorage.setItem(DEFAULT_EDITOR_KEY, "zed");
    const opened: OpenDesktopTargetInput[] = [];
    installDesktopHost(opened);

    const { targetName, opened: target } = await openFileFrom("project-without-choice", opened);

    expect(targetName).toBe("Zed");
    expect(target.editorId).toBe("zed");
  });

  it("keeps a project's own choice over the default editor", async () => {
    await AsyncStorage.setItem(DEFAULT_EDITOR_KEY, "zed");
    await AsyncStorage.setItem(
      `${DEFAULT_EDITOR_KEY}:${JSON.stringify([LOCAL_SERVER_ID, "project-with-choice"])}`,
      "cursor",
    );
    const opened: OpenDesktopTargetInput[] = [];
    installDesktopHost(opened);

    const { targetName, opened: target } = await openFileFrom("project-with-choice", opened);

    expect(targetName).toBe("Cursor");
    expect(target.editorId).toBe("cursor");
  });
});
