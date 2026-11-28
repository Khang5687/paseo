import { type PermissionResponse } from "expo-modules-core";
import ExpoTwoWayAudioModule from "./ExpoTwoWayAudioModule";

export async function initialize() {
  return await ExpoTwoWayAudioModule.initialize();
}

export function playPCMData(audioData: Uint8Array) {
  return ExpoTwoWayAudioModule.playPCMData(audioData);
}

export function bypassVoiceProcessing(bypass: boolean) {
  return ExpoTwoWayAudioModule.bypassVoiceProcessing(bypass);
}

export function toggleRecording(val: boolean): boolean {
  return ExpoTwoWayAudioModule.toggleRecording(val);
}

/** Capture speech without treating another app's playback focus as a microphone failure. */
export function startDictation(): boolean {
  // COMPAT(dictationCapture): added after v0.11.2, remove after 2027-01-16 once
  // the native binary floor includes startDictation. Older OTA clients retain legacy capture.
  if (typeof ExpoTwoWayAudioModule.startDictation !== "function") {
    return ExpoTwoWayAudioModule.toggleRecording(true);
  }
  return ExpoTwoWayAudioModule.startDictation();
}

export function isRecording(): boolean {
  return ExpoTwoWayAudioModule.isRecording();
}

/**
 * Hand the OS audio session / audio focus back once nothing is being captured or played,
 * so other apps' audio can resume. Safe to call when already released.
 */
export function releaseAudioSession() {
  // COMPAT(releaseAudioSession): added in v0.2.6. An OTA JS update can land on an older
  // binary whose native module lacks this function, so probe the native object rather than
  // this wrapper (which always exists). Drop the guard once the binary floor is >= v0.2.6.
  if (typeof ExpoTwoWayAudioModule.releaseAudioSession !== "function") {
    return;
  }
  return ExpoTwoWayAudioModule.releaseAudioSession();
}

export function tearDown() {
  return ExpoTwoWayAudioModule.tearDown();
}

export function restart() {
  return ExpoTwoWayAudioModule.restart();
}

export async function getMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return ExpoTwoWayAudioModule.getMicrophonePermissionsAsync();
}

export async function requestMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return ExpoTwoWayAudioModule.requestMicrophonePermissionsAsync();
}

export function getMicrophoneModeIOS() {
  return ExpoTwoWayAudioModule.getMicrophoneModeIOS();
}

export function setMicrophoneModeIOS() {
  return ExpoTwoWayAudioModule.setMicrophoneModeIOS();
}

export function isPlaying(): boolean {
  return ExpoTwoWayAudioModule.isPlaying();
}

export function stopPlayback() {
  return ExpoTwoWayAudioModule.stopPlayback();
}

export function pausePlayback() {
  return ExpoTwoWayAudioModule.pausePlayback();
}

export function resumePlayback() {
  return ExpoTwoWayAudioModule.resumePlayback();
}

export type MicrophoneRouteKind = "phone" | "bluetooth" | "wired" | "usb" | "hearing_aid";

export interface MicrophoneRoute {
  /** Stays the same when the device reconnects; this is what the remembered pick stores. */
  key: string;
  kind: MicrophoneRouteKind;
  name: string;
}

export interface MicrophoneRoutes {
  routes: MicrophoneRoute[];
  /** The remembered pick, or null for automatic. It may name a device that is not connected. */
  preferredKey: string | null;
  preferredName: string | null;
  /** The route in use while capturing or playing, else the one the next session would use. */
  activeKey: string | null;
}

/**
 * The microphones voice and dictation can use, Android only. Null on iOS (the OS owns the route),
 * on a binary without the picker, and before `initialize()`.
 */
export function getMicrophoneRoutes(): MicrophoneRoutes | null {
  if (typeof ExpoTwoWayAudioModule.getMicrophoneRoutes !== "function") {
    return null;
  }
  return ExpoTwoWayAudioModule.getMicrophoneRoutes();
}

/** Remember a connected route as this phone's microphone; null goes back to automatic. */
export function setPreferredMicrophone(key: string | null): boolean {
  if (typeof ExpoTwoWayAudioModule.setPreferredMicrophone !== "function") {
    return false;
  }
  return ExpoTwoWayAudioModule.setPreferredMicrophone(key);
}
