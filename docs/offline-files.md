# Offline files

Each device keeps its own copies of host files so they open with no signal and every host asleep. The user sees them as **Saved on this device**: a sidebar footer row (Appearance settings can hide or move it), the Saved screen (`/saved`, `/saved/file`), and the list in Settings → Files.

Code: `packages/app/src/offline-files/`.

## Where copies come from

| Source                             | How                                                                   | Pinned |
| ---------------------------------- | --------------------------------------------------------------------- | ------ |
| Opening a file in the file pane    | `withSavedCopy` (`session.ts`) keeps the bytes the panel already read | no     |
| Auto-save of files a chat mentions | `use-auto-save.ts`, off by default on web, Wi-Fi gate                 | no     |
| Save offline, Download             | `addSavedFile` (`saver.ts`)                                           | yes    |
| Send to another device (later)     | `addSavedFile`                                                        | yes    |

Anything the user saves on purpose goes through `addSavedFile({ serverId, path, workspaceRoot? })`. It reads the file from that host's live session and fails with the "host disconnected" message when the host is not connected. Do not write to the store directly from a new feature.

None of these ask. Where a Download goes outside Paseo is a separate choice: [downloads.md](downloads.md). There is no Files app or Finder folder; Share on the offline copy bar hands a copy to other apps.

## Limits and pinning

The limits in Settings → Files (keep for N days, total MB, largest file MB) apply to unpinned copies. Pinned copies never age out, and the total cap counts them first, so over the cap the oldest unpinned copies go. Pinned copies still obey the largest-file limit, because `addSavedFile` refuses bigger files. Saving an unchanged pinned copy again keeps it pinned; opening it only touches its timestamp.

## The Saved file view has no workspace

Saved entries store only host and absolute path. `SavedFilePane` (`file-pane/pane.tsx`) reads the device copy only, even when the host is online, and the Saved screen wraps it in a stand-in pane context (`library-screen.tsx`) because file panels expect a workspace tab around them. Panel actions that need a workspace (open another file, import) do nothing there.
