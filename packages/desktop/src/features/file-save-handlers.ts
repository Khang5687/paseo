import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { saveFile } from "./file-save.js";

/** Paths this app wrote; "show in folder" only opens those. */
const savedPaths = new Set<string>();

export function registerFileSaveHandlers(): void {
  ipcMain.handle("paseo:files:save", async (event, input: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const result = await saveFile(input, {
      downloadsDir: app.getPath("downloads"),
      chooseSavePath: async (defaultPath) => {
        const options = { defaultPath, properties: ["showOverwriteConfirmation" as const] };
        const chosen = win
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options);
        return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
      },
    });
    if (result.status === "saved") {
      savedPaths.add(path.resolve(result.path));
    }
    return result;
  });

  ipcMain.handle("paseo:files:reveal", (_event, value: unknown) => {
    if (typeof value !== "string" || !savedPaths.has(path.resolve(value))) {
      return;
    }
    shell.showItemInFolder(value);
  });
}
