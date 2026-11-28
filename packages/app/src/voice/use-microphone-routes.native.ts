import {
  addExpoTwoWayAudioEventListener,
  getMicrophoneRoutes,
  setPreferredMicrophone,
  type MicrophoneRoutes,
} from "@getpaseo/expo-two-way-audio";
import { useEffect, useState } from "react";

export interface MicrophoneRoutesControl {
  state: MicrophoneRoutes;
  /** Remember a connected mic (null = automatic) and switch to it now. */
  choose: (key: string | null) => boolean;
}

/**
 * The phone's microphones while live voice is on. Null where the OS owns the route (iOS) or the
 * native engine has not started yet; the native module reports every connect, disconnect and
 * route switch, so the panel follows them without polling.
 */
export function useMicrophoneRoutes(): MicrophoneRoutesControl | null {
  const [state, setState] = useState<MicrophoneRoutes | null>(getMicrophoneRoutes);
  useEffect(() => {
    const refresh = () => setState(getMicrophoneRoutes());
    const subscription = addExpoTwoWayAudioEventListener("onMicrophoneRoutesChange", refresh);
    // The engine may have started between the first render and this subscription.
    refresh();
    return () => subscription.remove();
  }, []);
  return state ? { state, choose: setPreferredMicrophone } : null;
}
