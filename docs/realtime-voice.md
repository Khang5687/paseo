# Realtime voice

Realtime voice is the voice agent the composer swaps in for the text field: the panel with the volume meter, Black, mute, and stop (`packages/app/src/components/realtime-voice-overlay.tsx`). The session itself runs in `packages/app/src/voice/voice-runtime.ts`, which holds the `paseo:voice` keep-awake for as long as voice is on.

## Black screen

Black covers the whole window in pure `#000` while voice keeps listening and speaking, so the phone can ride in a pocket. On OLED screens black pixels are off.

- The app must stay in front. Android pauses audio when the activity pauses, so dimming through the OS, locking, or leaving the app would end the session. The black screen is a modal over the app, and the voice keep-awake stops the screen from sleeping under it.
- Only a double-tap wakes it: two short, still taps within 300 ms of each other and close together (`packages/app/src/voice/black-screen-wake.ts`). A single tap, a long press, or a drag does nothing, because a pocket produces all three.
- Android back does not wake it. The modal has no `onRequestClose` for the same pocket reason.
- Escape wakes it on a hardware keyboard, and a screen reader's activate action wakes it.
- The state lives in the panel. Stopping voice unmounts the panel, which ends black with it.
- The status bar is hidden while black. On Android the modal is its own dialog window, and React Native hides the bar only on windows it already knows, so the black screen calls `StatusBar.setHidden` after the modal's `onShow`. Called earlier, it hides the bar behind the dialog and the clock stays visible. Use the imperative call, not `<StatusBar hidden />`: the component resets the bar style when it unmounts, which overrides the theme's `SystemBars` (react-native-edge-to-edge) style and leaves white icons on the light theme. The Android navigation bar stays: hiding it needs immersive mode, which React Native does not expose.

Check route: start realtime voice in a chat, tap Black. The screen goes black, the status bar (clock, battery) is gone, and voice keeps going. Tap once: nothing. Double-tap: the panel is back with the status bar in its theme colors (dark icons on the light theme), and voice is still on. On Android, screenshot with `adb -s <device> exec-out screencap -p`; the black frame has no lit pixels except the navigation pill. On web at 390×844 the same taps work with the mouse, and Escape wakes it too.

## Other audio

Music and other apps keep playing, quieter, while voice or dictation holds the audio session, and go back to full volume when Paseo releases it ([Releasing the audio session when idle](mobile-testing.md#releasing-the-audio-session-when-idle)).

- Android: `AudioEngine.kt` asks for `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`. Android then lowers the other app's players itself. Two kinds of player are left to their app, which gets `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK` and decides: players that mark their content as speech (a podcast app may pause instead), and AAudio players (Chrome lowers its own volume).
- iOS: `AudioEngine.swift` sets `.duckOthers` on the `.playAndRecord`/`.voiceChat` category.
- On Android, another app that takes full focus while voice runs (you press play in a music app) still ends voice: its focus loss raises the `blocked` interruption.
- Ducked music on the phone speaker still reaches the microphone, so loud music can sound like speech to turn detection. Earbuds avoid it.

Check route: on an emulator, play a song in YouTube Music or Chrome, start voice in Paseo, and run `adb -s <device> shell dumpsys audio`. The focus stack shows `sh.paseo.debug` with `gain: GAIN_TRANSIENT_MAY_DUCK` and the media app with `loss: LOSS_TRANSIENT_CAN_DUCK`, and the media app's player stays `state:started`. Stop voice: the media app's `loss` returns to `none`.

## Microphone

On Android the talk panel has a microphone button before Black. It lists the phone's mic and every connected headset (Bluetooth, BLE, wired, USB, hearing aid), plus Automatic. The pick is stored by the native module in Android `SharedPreferences` (`expo-two-way-audio`), so it holds across restarts and for dictation too, and applies each time the engine takes the communication route.

- A route key is `phone` or `<kind>:<productName>`. The key survives reconnects; a device with no stable name collides with another of the same kind and name, which is acceptable for a phone.
- A remembered device that is not connected is not an error: Android routing falls back to the automatic order (Bluetooth, then wired or USB, then the phone), and the Automatic row says which mic is missing. It is used again when it reconnects.
- On a phone-width panel the button is the mic's icon and a chevron, no name: with the name, Black, mute and Stop no longer fit (Stop was pushed off the panel at 412 dp). Wider panels show the name. Don't add text to the panel row without checking it at 390 dp.
- Android 12+ selects with `setCommunicationDevice`. Below that, a Bluetooth pick starts SCO and the phone pick turns the speakerphone on.
- The earpiece is left out: voice replies there are too quiet with the phone away from your ear.
- iOS, web and desktop show no button: the OS or browser owns the input choice. The app also hides it on an Android binary that predates the native functions.

Check route: start voice on an Android emulator or phone and tap the mic button. The sheet lists "Phone mic" (and any headset) with a check on the current pick and "Automatic · Android picks". Pick one: a "Mic: <name>" toast shows. `adb shell dumpsys audio` lists `sh.paseo.debug` under "Communication route clients" with the picked device. The native logic is covered by `AudioEngineTest` (`pickedMicrophoneIsRememberedByTheNextEngine`, `rememberedMicrophoneThatIsGoneFallsBackToAutomatic`), and the menu rows by `packages/app/src/voice/microphone-menu.test.ts`.
