# Notifications

Use `notification-open` for OS notification taps. It owns delivery, parsing,
process-local deduplication, startup readiness, and native acknowledgement.
Keep agent and workspace navigation in their existing navigation modules.
Import the pure API from `@/notification-open` and the app-shell component from
`@/notification-open/react`; senders must not load the React routing runtime.

Agent payloads name a host and agent. Ignore their workspace hint when opening:
the agent can move after a notification is sent. Use `navigateToAgent`, which
uses the current store record or the agent route to resolve the workspace from
the host. Terminal payloads name their workspace and use `navigateToWorkspace`.

Note payloads add `noteId` to an agent or terminal payload (built by
`noteNotificationData`). The router resolves the note from the notes store,
else fetches it from its host (`findNote`), and opens it with `openNote`. A
missing note or unreachable host falls back to the agent or terminal fields.
Fired notes reach web and desktop on a separate `notes.fired` event feed,
subscribed only on hosts advertising `features.notes`; older hosts reject the
unknown event name. The daemon marks one recipient with `shouldNotify`.

Files sent from another device ("Send to…", or the `send_file_to_device` agent
tool) add `sentFilePath` to the payload. The tap keeps the file in Saved
through `addSavedFile` (the notification carries a path, never bytes), then
opens `/saved/file`. A host that is not connected after 10 seconds, or a file
over the offline size limit, shows a toast and opens nothing. `sentFilePath`
wins over every other field. The daemon keeps its own device list
(`file-devices.json`, built from `files.devices.register.request`) apart from
the push token store: that store drops a token after 48 hours without
activity, and a file sent to a phone that has not been opened for days must
still arrive. Phones get a push; web and desktop apps get a `files.sent` event
on their open connection and raise the OS notification themselves, so they
receive nothing while closed. A phone with its app open also gets `files.sent`
and shows an in-app toast, because a foreground push shows no banner.

See [agent targets and deferred opens](expo-router.md#agent-targets) for route
ownership and workspace recovery. Notification generation, presence, and push
eligibility remain daemon concerns.

## Native delivery

Keep the router instance at module scope. Android's `singleTask` Activity can
finish on Back while its JS context remains alive. A React ref is lost when the
root remounts; process-local handled IDs must survive that remount.

Clear `lastNotificationResponse` after dispatch. Reading a launch response does
not acknowledge it. Without clearing it, a later Activity launch can reopen the
old agent.

With expo-notifications 57, Android also replays its pending response list to
new native listeners. Clearing the last response does not drain that list.
Deduplication covers listener registration within one JS context. A development
JS reload creates another context and can replay a cold-launch response; do not
add persisted handled IDs to compensate. Recheck this limitation when upgrading
expo-notifications.

iOS drains pending responses when its delegate first handles them. Push data
read by Expo arrives under `userInfo.body`; simulator payloads must match:

```json
{
  "aps": { "alert": { "title": "Agent finished", "body": "Open the agent" }, "sound": "default" },
  "body": {
    "serverId": "host",
    "workspaceId": "workspace",
    "agentId": "agent",
    "reason": "finished"
  }
}
```

An Android FCM launch intent needs `google.message_id` and a JSON `body` extra.
An arbitrary Activity launch with data extras does not exercise Expo's FCM path.

Foreground pushes remain in Notification Center without a banner or sound.
This preserves notifications sent with stale presence information.

A phone schedules its own time-note reminder, on the push Android channel and
with the push payload shape, identified by `localReminderId`. Creating the note
records `localReminder: {deviceId, at}`; while that claim matches `wait.at` the
daemon resolves the note without pushing, so the owner gets one alert.
`NoteRemindersHost` reschedules or cancels reminders from note snapshots while
the app is in the foreground; a note missing from an online snapshot is
cancelled. Web has no local reminders.

## Startup and verification

Wait for the root navigator, host registry, remembered selection, and startup
redirects before handing off a tap. A compact agent route must demand the host's
directory itself; its sidebar can be closed for the entire cold launch.

Verify warm and cold taps, stale and missing workspace hints, two distinct taps,
and Android Back followed by launcher reopen or a different notification tap. Check the focused tab and every
workspace's saved layout, since a foreign pinned tab survives navigation.
Use the daemon's payload shape on both iOS and Android; a browser event alone
does not test native replay or acknowledgement.

To check "Send to…" without a phone, run a dev daemon in a scratch `PASEO_HOME` and the web app at 390×844. Connect a second client (`DaemonClient`, `registerFileDevice({ name, kind: "desktop" })`, `observeEvents(["files.sent"], { notifications: true })`) as the target. Right-click a file in Files, pick Send to…, pick that device: the app toasts "Sent to …" and the client logs `files.sent`. Dispatch `paseo:web-notification-click` on `window` with `{ serverId, sentFilePath }` as `detail.data` to play the tap: the app opens `/saved/file` and the file appears in Saved. Never register a real push token on a dev daemon; sending to a phone calls Expo. `daemon-e2e/send-to-device.e2e.test.ts` covers the daemon side with a recording push sender.

Existing foreign pins belong to the reconciliation fix in
[#6900](https://github.com/getpaseo/paseo/issues/6900). Desktop main-process window
selection is tracked separately in
[#6875](https://github.com/getpaseo/paseo/issues/6875).
