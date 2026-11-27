# Downloads

Where the Download button puts a file, and who decides. Every Download goes through `useFileDownload` → `download-store.ts` → `downloads/save-file` (`.web.ts` for browser and Electron, the base file for iOS and Android). It also keeps a pinned copy in Saved on this device ([offline-files.md](offline-files.md)); that copy never asks and never moves.

Over a relay or SSH session the download streams once into that pinned copy (`addSavedFile`, up to 500 MB, with progress in the download bar), then delivers from it: a copy in the cache folder on phones, a Blob in the browser, the managed file path on Electron. Direct connections still fetch over HTTP and save the pinned copy in the background.

## The setting

Settings → Files → "Ask where to save" (`downloadAskWhere`) is on by default.

| Platform         | On (ask)                                                | Off                                                                                           |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Electron desktop | Native Save dialog, starting in Downloads               | Writes `Downloads/Paseo/<name>`, adds ` (1)` instead of overwriting, note with Show in folder |
| Browser          | The browser decides; the switch is disabled with a note | Same                                                                                          |
| iOS              | Share sheet (it has Save to Files and Save Video)       | `Documents/Downloads`, which Files shows as On My iPhone › Paseo                              |
| Android          | System folder picker every time                         | A folder picked once (`downloadFolderUri`), then straight there                               |

Share on the offline copy bar is a separate action. It always opens the share sheet on phones and the browser download on web, whatever this setting says.

## The download bar

`components/download-bar.tsx` shows the newest entry in `download-store.ts`, app-wide, right under the screen header: a full-width strip on a phone, a centered box on a wide window so it leaves the sidebar alone. It holds the file name and percent while the download runs, then a one-line note. It never covers the composer. It is mounted once at the root, so it stays at the same place when the owner leaves the chat that started it, and shows over whatever screen is open (Saved, Settings, another chat). A copy under 5 MB gets no bar (`withTransferProgress`), only the note.

The note says where the file went and what it can do next: Show in folder on desktop, and, for a file another device sent ([notifications.md](notifications.md)), Open, which goes to the Saved copy. An APK there also gets Install on Android.

## Installing an APK

Install hands the Saved copy to Android's package installer: `ACTION_VIEW` with type `application/vnd.android.package-archive` and `FLAG_GRANT_READ_URI_PERMISSION`, through `expo-intent-launcher` (`downloads/install-package.android.ts`). The URI is the copy's `contentUri` from `expo-file-system`'s FileProvider, which shares the cache folder Saved files live in, so nothing is copied first. The first time, Android asks to allow installs from Paseo and sends the user to Settings; that install request is dropped, so after allowing it the user taps Install again and gets Android's own update screen. The same button is on the offline copy bar of an APK in Saved, which is where that second tap usually happens once the note has closed. A chat link to an APK this device saved after the message opens that Saved copy, so a second tap on the link reaches Install without downloading again; a copy with the same name saved before the message is an older build and does not count ([offline-files.md](offline-files.md#chat-links-open-the-saved-copy)).

The installer refuses apps that do not declare `REQUEST_INSTALL_PACKAGES`, and Google Play restricts that permission. `app.config.js` declares it only for the debug variant (`APP_VARIANT=development`, not F-Droid), and passes `extra.installPackages` so the app hides Install everywhere else (`canInstallPackages` in `constants/build-profile.ts`). The permission and the new module are native: they need a new Android build.

## Gotchas

- **iOS shows all of Documents.** `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` (in `app.config.js`) expose the whole app Documents folder, including `SQLite/` and the skins cache. Downloads go in a `Downloads` subfolder so they stay apart from those. The keys are native config: they need a new iOS build.
- **Android has no "save as" picker.** `expo-file-system` offers a folder picker (`Directory.pickDirectoryAsync`), not `ACTION_CREATE_DOCUMENT`, so "ask" picks a folder each time and keeps the file's own name. A real save-as dialog needs a small native module. The picked folder's permission is persisted by the library; when it is revoked or the folder is deleted, the next save asks again.
- **The Electron main process copies the file.** A streamed Download sends `sourcePath`, a file in managed storage, over IPC (`paseo:files:save`); main copies it with `COPYFILE_EXCL`, so no bytes cross IPC. The older `bytes` input stays for the HTTP path. Main strips any directory part from the name, refuses a `sourcePath` outside managed storage, and "show in folder" only opens paths main wrote itself.
- **A desktop shell older than this feature** has no `files` bridge; the app falls back to the browser download there (`COMPAT(desktopFileSave)`).

## Checking it again

- Unit: `npx vitest run src/stores/download-store.test.ts src/downloads src/send-to` in `packages/app`; `npx vitest run src/features/file-save.test.ts` in `packages/desktop`.
- Browser: `npx playwright test e2e/browser/save-location.spec.ts` shows the switch at 390×844 and the Show in folder note; `e2e/browser/download-bar.spec.ts` plays a file sent to the phone at 390×844: the bar under the header, the "saved" note, Open.
- Install: a debug Android build on an emulator, against a dev daemon on another port (`PASEO_LISTEN=127.0.0.1:<port>`, `adb reverse` for it and Metro; check `adb reverse --list` after an install, the rules were gone after one). Send the APK by calling the dev daemon's agent MCP: `curl -X POST http://127.0.0.1:<port>/mcp/agents -H "content-type: application/json" -H "accept: application/json, text/event-stream"` with a JSON-RPC `tools/call` of `send_file_to_device` and `{"path": "<apk>"}`. The notice closes after 8 seconds, so script the send and the tap together. Expect the bar under the header, then "<file> saved" with Open and Install; Install asks to allow installs from Paseo Debug, then Install on the Saved copy shows "Do you want to update this app?". A production build (`APP_VARIANT` unset) shows no Install button.
- Electron: `PASEO_HOME` set to a scratch dir, run the desktop app, Download a file with the switch on (Save dialog) and off (file in `~/Downloads/Paseo`, note with Show in folder).
- Big file: the "Checking it again" route in [offline-files.md](offline-files.md) covers a 300 MB save with a memory number.
