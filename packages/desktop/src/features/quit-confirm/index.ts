import { app, BrowserWindow } from "electron";
import { createQuitConfirm, isQuitShortcut } from "./policy.js";

// Renderer listens through listenToDesktopEvent("quit-confirm") and draws the toast.
const QUIT_CONFIRM_EVENT = "paseo:event:quit-confirm";

interface QuitConfirmEventPayload {
  visible: boolean;
}

function sendQuitConfirm(win: BrowserWindow, payload: QuitConfirmEventPayload): void {
  if (!win.isDestroyed()) {
    win.webContents.send(QUIT_CONFIRM_EVENT, payload);
  }
}

/**
 * Routes Cmd+Q through the quit confirmation on macOS. Every webContents
 * (windows, browser webviews, devtools) intercepts the shortcut before the menu
 * accelerator sees it, so held keys report auto-repeat. Returns the handler the
 * application menu calls when its Cmd+Q accelerator fires instead, or null when
 * the platform has no quit shortcut.
 */
export function registerQuitConfirm(): (() => void) | null {
  if (process.platform !== "darwin") {
    return null;
  }
  // The window the shortcut was pressed in. A browser webview's key events
  // arrive on its guest webContents, so resolve through the host.
  let pressedIn: BrowserWindow | null = null;
  const confirm = createQuitConfirm({
    showToast: () => {
      if (pressedIn) {
        sendQuitConfirm(pressedIn, { visible: true });
      }
    },
    // Focus can move between press and expiry; clear the toast everywhere.
    hideToast: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        sendQuitConfirm(win, { visible: false });
      }
    },
    quit: () => app.quit(),
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("before-input-event", (event, input) => {
      if (!isQuitShortcut(input)) {
        return;
      }
      event.preventDefault();
      pressedIn = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
      confirm.press({ repeat: input.isAutoRepeat });
    });
  });

  // The menu accelerator only fires when no webContents has focus. With no
  // focused window there is nowhere to show the toast, so quit as before.
  return () => {
    pressedIn = BrowserWindow.getFocusedWindow();
    if (pressedIn) {
      confirm.press({ repeat: false });
    } else {
      app.quit();
    }
  };
}
