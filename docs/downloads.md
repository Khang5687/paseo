# Downloads

Where the Download button puts a file, and who decides. Every Download goes through `useFileDownload` → `download-store.ts` → `downloads/save-file` (`.web.ts` for browser and Electron, the base file for iOS and Android). It also keeps a pinned copy in Saved on this device ([offline-files.md](offline-files.md)); that copy never asks and never moves.

Over a relay or SSH session the download streams once into that pinned copy (`addSavedFile`, up to 500 MB, with progress in the toast), then delivers from it: a copy in the cache folder on phones, a Blob in the browser, the managed file path on Electron. Direct connections still fetch over HTTP and save the pinned copy in the background.

## The setting

Settings → Files → "Ask where to save" (`downloadAskWhere`) is on by default.

| Platform         | On (ask)                                                | Off                                                                                            |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Electron desktop | Native Save dialog, starting in Downloads               | Writes `Downloads/Paseo/<name>`, adds ` (1)` instead of overwriting, toast with Show in folder |
| Browser          | The browser decides; the switch is disabled with a note | Same                                                                                           |
| iOS              | Share sheet (it has Save to Files and Save Video)       | `Documents/Downloads`, which Files shows as On My iPhone › Paseo                               |
| Android          | System folder picker every time                         | A folder picked once (`downloadFolderUri`), then straight there                                |

Share on the offline copy bar is a separate action. It always opens the share sheet on phones and the browser download on web, whatever this setting says.

## Gotchas

- **iOS shows all of Documents.** `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` (in `app.config.js`) expose the whole app Documents folder, including `SQLite/` and the skins cache. Downloads go in a `Downloads` subfolder so they stay apart from those. The keys are native config: they need a new iOS build.
- **Android has no "save as" picker.** `expo-file-system` offers a folder picker (`Directory.pickDirectoryAsync`), not `ACTION_CREATE_DOCUMENT`, so "ask" picks a folder each time and keeps the file's own name. A real save-as dialog needs a small native module. The picked folder's permission is persisted by the library; when it is revoked or the folder is deleted, the next save asks again.
- **The Electron main process copies the file.** A streamed Download sends `sourcePath`, a file in managed storage, over IPC (`paseo:files:save`); main copies it with `COPYFILE_EXCL`, so no bytes cross IPC. The older `bytes` input stays for the HTTP path. Main strips any directory part from the name, refuses a `sourcePath` outside managed storage, and "show in folder" only opens paths main wrote itself.
- **A desktop shell older than this feature** has no `files` bridge; the app falls back to the browser download there (`COMPAT(desktopFileSave)`).

## Checking it again

- Unit: `npx vitest run src/stores/download-store.test.ts src/downloads` in `packages/app`; `npx vitest run src/features/file-save.test.ts` in `packages/desktop`.
- Browser: `npx playwright test e2e/browser/save-location.spec.ts` shows the switch at 390×844.
- Electron: `PASEO_HOME` set to a scratch dir, run the desktop app, Download a file with the switch on (Save dialog) and off (file in `~/Downloads/Paseo`, toast).
- Big file: the "Checking it again" route in [offline-files.md](offline-files.md) covers a 300 MB save with a memory number.
