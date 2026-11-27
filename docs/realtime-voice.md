# Realtime voice

Realtime voice is the voice agent the composer swaps in for the text field: the panel with the volume meter, Black, mute, and stop (`packages/app/src/components/realtime-voice-overlay.tsx`). The session itself runs in `packages/app/src/voice/voice-runtime.ts`, which holds the `paseo:voice` keep-awake for as long as voice is on.

## Black screen

Black covers the whole window in pure `#000` while voice keeps listening and speaking, so the phone can ride in a pocket. On OLED screens black pixels are off.

- The app must stay in front. Android pauses audio when the activity pauses, so dimming through the OS, locking, or leaving the app would end the session. The black screen is a modal over the app, and the voice keep-awake stops the screen from sleeping under it.
- Only a double-tap wakes it: two short, still taps within 300 ms of each other and close together (`packages/app/src/voice/black-screen-wake.ts`). A single tap, a long press, or a drag does nothing, because a pocket produces all three.
- Android back does not wake it. The modal has no `onRequestClose` for the same pocket reason.
- Escape wakes it on a hardware keyboard, and a screen reader's activate action wakes it.
- The state lives in the panel. Stopping voice unmounts the panel, which ends black with it.
- The status bar is hidden while black. The Android navigation bar stays: hiding it needs immersive mode, which React Native does not expose.

Check route: start realtime voice in a chat, tap Black. The screen goes black and voice keeps going. Tap once: nothing. Double-tap: the panel is back and voice is still on. On web at 390×844 the same taps work with the mouse, and Escape wakes it too.
