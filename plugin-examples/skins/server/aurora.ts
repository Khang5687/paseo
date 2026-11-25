import { encodePng } from "./png";

const STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [14, 17, 45],
  [58, 38, 112],
  [28, 120, 140],
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** A dark diagonal gradient with a soft glow, so the art reads as one skin. */
export function renderAurora(width: number, height: number): Buffer {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x / (width - 1) + y / (height - 1)) / 2;
      const segment = t < 0.5 ? 0 : 1;
      const local = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const from = STOPS[segment]!;
      const to = STOPS[segment + 1]!;
      const dx = x / width - 0.7;
      const dy = y / height - 0.3;
      const glow = Math.max(0, 1 - Math.hypot(dx, dy) * 2.2) * 40;
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        rgb[offset + channel] = Math.min(
          255,
          Math.round(lerp(from[channel]!, to[channel]!, local) + glow),
        );
      }
    }
  }
  return encodePng(width, height, rgb);
}
