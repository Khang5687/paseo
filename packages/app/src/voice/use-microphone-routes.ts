import type { MicrophoneRoutes } from "@getpaseo/expo-two-way-audio";

export interface MicrophoneRoutesControl {
  state: MicrophoneRoutes;
  choose: (key: string | null) => boolean;
}

/** The browser and desktop own the microphone choice; the native file has the Android picker. */
export function useMicrophoneRoutes(): MicrophoneRoutesControl | null {
  return null;
}
