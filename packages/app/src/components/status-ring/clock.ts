import { useLayoutEffect, useState } from "react";
import { makeMutable, type SharedValue, useSharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { createSteppedClock } from "@/components/stepped-clock";
import { useAppVisible } from "@/hooks/use-app-visible";
import { STATUS_RING_PERIOD_MS } from "@/components/status-ring/geometry";

// Nine positions per turn, 40 degrees apart, ten updates a second. The ring reads as a ticking
// spinner rather than a smooth one; that is the trade for not rendering every display frame on a
// phone for as long as an agent runs.
const STATUS_RING_STEPS = 9;
const STATUS_RING_STEP_MS = STATUS_RING_PERIOD_MS / STATUS_RING_STEPS;

function getSteppedStatusRingRotation(nowMs: number): number {
  const step = Math.floor((nowMs % STATUS_RING_PERIOD_MS) / STATUS_RING_STEP_MS);
  return step * (360 / STATUS_RING_STEPS);
}

const sharedRotation = makeMutable(getSteppedStatusRingRotation(Date.now()));
const statusRingClock = createSteppedClock({
  stepMs: STATUS_RING_STEP_MS,
  onStep: (nowMs) => {
    sharedRotation.value = getSteppedStatusRingRotation(nowMs);
  },
});
let nextListenerId = 1;

function registerStatusRing(
  rotation: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  rotation.value = sharedRotation.value;
  sharedRotation.addListener(listenerId, (value) => {
    rotation.value = value;
  });
}

function unregisterStatusRing(registered: SharedValue<boolean>, listenerId: number): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  sharedRotation.removeListener(listenerId);
}

export function useStatusRingRotation(): SharedValue<number> {
  // Hidden retained views and a backgrounded app must not keep the shared clock running.
  const panelActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const active = panelActive && appVisible;
  const rotation = useSharedValue(getSteppedStatusRingRotation(Date.now()));
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextListenerId++);

  useLayoutEffect(() => {
    if (!active) return;
    const release = statusRingClock.retain();
    scheduleOnUI(registerStatusRing, rotation, registered, listenerId);
    return () => {
      release();
      scheduleOnUI(unregisterStatusRing, registered, listenerId);
    };
  }, [active, listenerId, registered, rotation]);

  return rotation;
}
