// The send beep: a short two-note rise that says "your message is about to go". Built in code
// so it needs no asset and plays through the same audio_output path as speech, on every client.

const SAMPLE_RATE = 24000;
export const SEND_CUE_FORMAT = `pcm;rate=${SAMPLE_RATE}`;

const NOTES = [
  { hz: 880, ms: 70 },
  { hz: 1320, ms: 90 },
];
const FADE_MS = 8;
const AMPLITUDE = 0.25;

let cached: Buffer | null = null;

/** 16-bit mono PCM at 24 kHz, about 160 ms. */
export function sendCuePcm(): Buffer {
  if (cached) return cached;
  const fade = Math.round((SAMPLE_RATE * FADE_MS) / 1000);
  const parts = NOTES.map(({ hz, ms }) => {
    const samples = Math.round((SAMPLE_RATE * ms) / 1000);
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      const envelope = Math.min(1, i / fade, (samples - 1 - i) / fade);
      const value = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * AMPLITUDE * envelope;
      pcm.writeInt16LE(Math.round(value * 32767), i * 2);
    }
    return pcm;
  });
  cached = Buffer.concat(parts);
  return cached;
}
