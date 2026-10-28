import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadActiveBrowserOrWindow, setupApplicationMenu } from "./menu.js";

const electron = vi.hoisted(() => ({
  quit: vi.fn(),
  templates: [] as Electron.MenuItemConstructorOptions[][],
}));

vi.mock("electron", () => ({
  app: { name: "Paseo", quit: electron.quit, on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      electron.templates.push(template);
      return template;
    },
    setApplicationMenu: vi.fn(),
  },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
}));

class FakeWebContents {
  public readonly reloads: string[] = [];

  public constructor(public readonly id: number) {}

  public isLoadingMainFrame(): boolean {
    return false;
  }

  public stop(): void {
    this.reloads.push("stop");
  }

  public reload(): void {
    this.reloads.push("reload");
  }

  public reloadIgnoringCache(): void {
    this.reloads.push("force-reload");
  }
}

class BrowserReloads {
  public readonly firstWindow = { webContents: new FakeWebContents(101) };
  public readonly secondWindow = { webContents: new FakeWebContents(202) };
  public readonly firstBrowser = new FakeWebContents(11);
  public readonly secondBrowser = new FakeWebContents(22);
  public readonly resolvedHostWindowIds: number[] = [];

  public activeBrowserForHostWindow(hostWebContentsId: number): FakeWebContents | null {
    this.resolvedHostWindowIds.push(hostWebContentsId);
    return hostWebContentsId === 101 ? this.firstBrowser : this.secondBrowser;
  }
}

describe("reloadActiveBrowserOrWindow", () => {
  it("reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.firstWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([101]);
    expect(browserReloads.firstBrowser.reloads).toEqual(["reload"]);
    expect(browserReloads.secondBrowser.reloads).toEqual([]);
    expect(browserReloads.firstWindow.webContents.reloads).toEqual([]);
  });

  it("force reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.secondWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
      ignoreCache: true,
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([202]);
    expect(browserReloads.firstBrowser.reloads).toEqual([]);
    expect(browserReloads.secondBrowser.reloads).toEqual(["force-reload"]);
    expect(browserReloads.secondWindow.webContents.reloads).toEqual([]);
  });
});

describe("macOS Quit menu item", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    electron.quit.mockReset();
    electron.templates.length = 0;
  });

  function quitItemFor(onQuitShortcut: (() => void) | null) {
    Object.defineProperty(process, "platform", { value: "darwin" });
    setupApplicationMenu({ onNewWindow: () => {}, onQuitShortcut });
    const appMenu = electron.templates.at(-1)?.[0]
      ?.submenu as Electron.MenuItemConstructorOptions[];
    const quit = appMenu.find((item) => item.accelerator === "Command+Q");
    if (!quit?.click) throw new Error("No Cmd+Q item in the app menu");
    const click = quit.click;
    return (triggeredByAccelerator: boolean) =>
      click({} as Electron.MenuItem, undefined, {
        triggeredByAccelerator,
      } as Electron.KeyboardEvent);
  }

  it("routes the Cmd+Q accelerator to the quit confirmation instead of quitting", () => {
    const confirmations: string[] = [];
    const pressQuit = quitItemFor(() => confirmations.push("confirm"));

    pressQuit(true);

    expect(confirmations).toEqual(["confirm"]);
    expect(electron.quit).not.toHaveBeenCalled();
  });

  it("quits immediately when the item is clicked with the mouse", () => {
    const confirmations: string[] = [];
    const pressQuit = quitItemFor(() => confirmations.push("confirm"));

    pressQuit(false);

    expect(confirmations).toEqual([]);
    expect(electron.quit).toHaveBeenCalledTimes(1);
  });
});
