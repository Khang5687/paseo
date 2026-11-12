/**
 * A wall-clock-aligned JS timer shared by every mounted instance of one animation. It wakes only
 * at step boundaries and only while an instance holds it, so a running indicator costs a few
 * timer callbacks per second instead of a frame callback on every display refresh. A frame
 * callback keeps the device rendering at full refresh rate for as long as an agent runs.
 */
export interface SteppedClock {
  /** Starts the clock if it is idle and returns the matching release. */
  retain(): () => void;
}

export function createSteppedClock(input: {
  stepMs: number;
  onStep: (nowMs: number) => void;
}): SteppedClock {
  let holders = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    timer = setTimeout(tick, input.stepMs - (Date.now() % input.stepMs));
  };

  function tick(): void {
    timer = null;
    if (holders === 0) return;
    input.onStep(Date.now());
    schedule();
  }

  return {
    retain() {
      holders += 1;
      if (holders === 1) {
        input.onStep(Date.now());
        schedule();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders === 0 && timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}
