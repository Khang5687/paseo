import { describe, expect, it } from "vitest";
import { buildTerminalContextMenuTemplate, reloadActiveBrowserOrWindow } from "./menu.js";

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

describe("buildTerminalContextMenuTemplate", () => {
  it("keeps the Copy / Paste / Select All menu when the renderer sends no Add note label", () => {
    const template = buildTerminalContextMenuTemplate(
      { kind: "terminal", hasSelection: true },
      () => {},
    );

    expect(template.map((item) => item.label ?? item.type)).toEqual([
      "Copy",
      "Paste",
      "separator",
      "Select All",
    ]);
  });

  it("adds the renderer's Add note item and reports it when clicked", () => {
    const actions: string[] = [];
    const template = buildTerminalContextMenuTemplate(
      { kind: "terminal", hasSelection: true, addNoteLabel: "Add note" },
      (action) => actions.push(action),
    );

    expect(template.map((item) => item.label ?? item.type)).toEqual([
      "Copy",
      "Add note",
      "Paste",
      "separator",
      "Select All",
    ]);
    const addNote = template.find((item) => item.label === "Add note");
    (addNote?.click as (() => void) | undefined)?.();
    expect(actions).toEqual(["add-note"]);
  });
});
