# Offline files

Each device keeps its own copies of host files so they open with no signal and every host asleep. The user sees them as **Saved on this device**: a sidebar footer row (Appearance settings can hide or move it), the Saved screen (`/saved`, `/saved/file`), and the list in Settings → Files.

Code: `packages/app/src/offline-files/`.

## Where copies come from

| Source                             | How                                                                   | Pinned |
| ---------------------------------- | --------------------------------------------------------------------- | ------ |
| Opening a file in the file pane    | `withSavedCopy` (`session.ts`) keeps the bytes the panel already read | no     |
| Auto-save of files a chat mentions | `use-auto-save.ts`, off by default on web, Wi-Fi gate                 | no     |
| Save offline, Download             | `addSavedFile` (`saver.ts`)                                           | yes    |
| Tap on a file another device sent  | `addSavedFile`, from `send-to/open-sent-file.ts`                      | yes    |

Anything the user saves on purpose goes through `addSavedFile({ serverId, path, workspaceRoot?, onProgress? })`. It reads the file from that host's live session and fails with the "host disconnected" message when the host is not connected. Do not write to the store directly from a new feature.

## Big files stream, they are never held whole

`addSavedFile` calls `client.readFileToSink` (`packages/client`), which hands each 256 KiB chunk of the daemon's binary file frames to a sink. The sink writes into an `AttachmentStore.openWriter` writer, so memory holds a few chunks, not the file:

| Platform | Writer                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser  | A file in the origin private file system (`createWritable`), plus a small IndexedDB record that says so. Without `createWritable` (older Safari), IndexedDB chunk records of 8 MB; `loadBlob` joins them on open |
| Phone    | A file in app storage, opened for append (`FileMode.Append`)                                                                                                                                                     |
| Electron | The main process appends to a managed file over IPC (`append_attachment_bytes`) in 4 MB batches                                                                                                                  |

A WebSocket cannot be paused, so there is no network backpressure: if the disk is slower than the link, frames queue in the client until the writer catches up. In the browser, an IndexedDB blob write is not an option for big files: Chromium kept about the whole file in its browser process for 10 to 20 seconds, measured with a plain script that writes 38 blobs of 8 MB. The private file system stayed flat in the same script. Measure memory when you change this path (see Checking it again). The legacy daemon without the binary channel sends the file in one JSON message and the sink gets it in one write.

Do not read a saved file with `readAttachmentBytes` on a path a big file can reach. It base64-encodes the whole file. The offline copy bar's Share and `createOfflineFileSession.read()` still do this, so Share on a file over roughly 100 MB can run out of memory.

None of these ask. Where a Download goes outside Paseo is a separate choice: [downloads.md](downloads.md). There is no Files app or Finder folder; Share on the offline copy bar hands a copy to other apps.

## Limits and pinning

The limits in Settings → Files (keep for N days, total MB, largest file MB) apply to unpinned copies. Pinned copies never age out, and the total cap counts them first, so over the cap the oldest unpinned copies go. A pinned copy has its own fixed cap, `PINNED_FILE_MAX_MB` (500 MB), instead of the largest-file setting, so a file saved on purpose works up to 500 MB. A pinned file over 500 MB, or one that does not fit in the total cap, is refused with a message that names the limit. The total defaults to 2 GB; devices that already stored the old 500 MB keep it until the user changes it. Saving an unchanged pinned copy again keeps it pinned; opening it only touches its timestamp.

## The Saved file view has no workspace

Saved entries store only host and absolute path. `SavedFilePane` (`file-pane/pane.tsx`) reads the device copy only, even when the host is online, and the Saved screen wraps it in a stand-in pane context (`library-screen.tsx`) because file panels expect a workspace tab around them. Panel actions that need a workspace (open another file, import) do nothing there.

## Checking it again

- Unit: in `packages/client`, `npx vitest run src/daemon-client.test.ts -t readFile`. In `packages/app`, `npx vitest run src/offline-files src/attachments src/desktop/attachments src/stores/download-store.test.ts`.
- Browser, 390×844: `npx playwright test --project=browser e2e/browser/big-file-save.spec.ts` in `packages/app`. It writes a 300 MB file in the host's repo, long-presses the file link, taps Save offline, and samples the browser's memory. It prints `BIG_FILE_MEMORY {...}`; growth must stay under 60% of the file (a 300 MB save measured +137 MB at the peak, almost all of it frames queued in the page, with the JS heap flat). The spec runs the browser with a profile on disk: Playwright's default profile is in memory, and then the saved file itself counts as memory. The screenshots are in the test's output folder: progress toast, Saved list with the size, the file opened with the host stopped and the browser offline.
- Phone and Electron need a device or a desktop build: Save offline on a big file link, watch the toast, then turn on flight mode and open it from Saved.
