# Offline files

Each device keeps its own copies of host files so they open with no signal and every host asleep. The user sees them as **Saved on this device**: a sidebar footer row (Appearance settings can hide or move it), the Saved screen (`/saved`, `/saved/file`), and the list in Settings → Files.

Code: `packages/app/src/offline-files/`.

## Where copies come from

| Source                             | How                                                                   | Pinned |
| ---------------------------------- | --------------------------------------------------------------------- | ------ |
| Opening a file in the file pane    | `withSavedCopy` (`session.ts`) keeps the bytes the panel already read | no     |
| Auto-save of files a chat mentions | `use-auto-save.ts`, off by default on web, Wi-Fi gate                 | no     |
| Save offline, Download             | `addSavedFile` (`saver.ts`)                                           | yes    |
| Tap on a file another device sent  | `addSavedFile`, from `send-to/receive-sent-file.ts`                   | yes    |

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

The limits in Settings → Files (keep for N days, total MB, largest file MB) apply to unpinned copies. Pinned copies never age out, and the total cap counts them first, so over the cap the oldest unpinned copies go. A pinned copy has its own fixed cap, `PINNED_FILE_MAX_MB` (500 MB), instead of the largest-file setting, so a file saved on purpose works up to 500 MB. A pinned file over 500 MB, or one that does not fit in the total cap, is refused with a message that names the limit. The total defaults to 2 GB. A stored 500 MB (the old default, written to storage like every default, so it cannot be told from a choice) moves to 2 GB once, through the `offline-total-2gb` entry in `hooks/use-settings/migrations.ts`; any other stored value stays, and picking 500 MB afterwards sticks. Saving an unchanged pinned copy again keeps it pinned; opening it only touches its timestamp.

## Chat links open the saved copy

A tap on a link in an agent reply opens this device's saved copy when one exists and was saved after the reply was written; otherwise the tap works as before. `findSavedLinkCopy` (`link-copy.ts`) decides, `use-saved-link-copy.ts` maps a link to what it names, and the markdown renderer's link press calls it with the reply's time. A web link matches a saved file by file name on any host, a host path by host and absolute path, and a bare file name by host and the end of the path.

The rule is "saved after the message", not "same name". A build reuses one file name for every build (`paseo-fork-main.apk`), so an older copy under that name is an earlier build and must not open for a newer link. The reply time comes from the daemon's clock and the save time from the device's, so a device clock running behind can miss a copy saved seconds after the reply; the tap then downloads as before. User messages have no reply time and keep the old tap.

On a phone, a long-press on such a link offers Open saved copy, Download again (a new download for a web link, Save offline for a host file) and Copy link. Web and desktop add no menu: the browser's own menu covers a web link, and the file menu's Save offline covers a host file.

## The Saved file view has no workspace

Saved entries store only host and absolute path. `SavedFilePane` (`file-pane/pane.tsx`) reads the device copy only, even when the host is online, and the Saved screen wraps it in a stand-in pane context (`library-screen.tsx`) because file panels expect a workspace tab around them. Panel actions that need a workspace (open another file, import) do nothing there.

## Checking it again

- Unit: in `packages/client`, `npx vitest run src/daemon-client.test.ts -t readFile`. In `packages/app`, `npx vitest run src/offline-files src/attachments src/desktop/attachments src/stores/download-store.test.ts`.
- Chat link to a saved copy, 390×844: `npx playwright test --project=browser e2e/browser/saved-link-copy.spec.ts` in `packages/app`. It saves a file from a chat link, changes the file on the host, taps the link, and expects the Saved page with the old text. Screenshot `saved-link-copy-phone.png` in the test's output folder.
- Browser, 390×844: `npx playwright test --project=browser e2e/browser/big-file-save.spec.ts` in `packages/app`. It writes a 300 MB file in the host's repo, long-presses the file link, taps Save offline, and samples the browser's memory. It prints `BIG_FILE_MEMORY {...}`; growth must stay under 60% of the file (a 300 MB save measured +137 MB at the peak, almost all of it frames queued in the page, with the JS heap flat). The spec runs the browser with a profile on disk: Playwright's default profile is in memory, and then the saved file itself counts as memory. The screenshots are in the test's output folder: progress toast, Saved list with the size, the file opened with the host stopped and the browser offline.
- Phone and Electron need a device or a desktop build: Save offline on a big file link, watch the toast, then turn on flight mode and open it from Saved.
