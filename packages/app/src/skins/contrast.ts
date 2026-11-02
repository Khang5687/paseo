/** sRGB color with 0–255 channels and 0–1 alpha. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_PATTERN = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_PATTERN =
  /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseRgbChannel(token: string): number {
  if (token.endsWith("%")) return clamp((parseFloat(token) / 100) * 255, 0, 255);
  return clamp(parseFloat(token), 0, 255);
}

function parseAlphaChannel(token: string | undefined): number {
  if (token === undefined) return 1;
  if (token.endsWith("%")) return clamp(parseFloat(token) / 100, 0, 1);
  return clamp(parseFloat(token), 0, 1);
}

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` colors. */
export function parseColor(value: string): Rgba {
  const input = value.trim();
  const hex = HEX_PATTERN.exec(input);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) {
      digits = [...digits].map((digit) => digit + digit).join("");
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = RGB_PATTERN.exec(input);
  if (rgb) {
    return {
      r: parseRgbChannel(rgb[1]),
      g: parseRgbChannel(rgb[2]),
      b: parseRgbChannel(rgb[3]),
      a: parseAlphaChannel(rgb[4]),
    };
  }
  throw new Error(`Unsupported color: ${value}`);
}

function linearizeChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function encodeChannel(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return c * 255;
}

/** WCAG 2.x relative luminance (0–1) of an opaque sRGB color with 0–255 channels. */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * linearizeChannel(color.r) +
    0.7152 * linearizeChannel(color.g) +
    0.0722 * linearizeChannel(color.b)
  );
}

/** WCAG 2.x contrast ratio (1–21) between two opaque colors. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Gray whose relative luminance is `luminance` (0–1). */
export function grayForLuminance(luminance: number): Rgb {
  const channel = encodeChannel(clamp(luminance, 0, 1));
  return { r: channel, g: channel, b: channel };
}

/**
 * Composites `base` at `alpha` over `art` per channel in gamma-encoded sRGB, which is how
 * Chromium (and the platform compositors) blend.
 */
export function blendOver(base: Rgb, art: Rgb, alpha: number): Rgb {
  const inverse = 1 - alpha;
  return {
    r: alpha * base.r + inverse * art.r,
    g: alpha * base.g + inverse * art.g,
    b: alpha * base.b + inverse * art.b,
  };
}

const ALPHA_PRECISION = 0.001;

export interface GateAlphaInput {
  /** Text color that must stay legible. */
  text: Rgb;
  /** Opaque surface color that becomes translucent. */
  base: Rgb;
  /** Relative luminance (0–1) of the worst-case art pixel behind the surface. */
  artLuminance: number;
  /** Required contrast ratio, e.g. 4.5 or 7. */
  target: number;
}

/**
 * Smallest surface alpha in [0, 1] at which `text` still reaches `target` contrast on the
 * surface blended over the worst-case art pixel. Returns 1 when even the opaque surface fails.
 *
 * The blend must also stay on the surface's side of the text (lighter than dark text, darker
 * than light text). A mid-grey text can pass against black art and against white surface but
 * drops to 1:1 between them, so without the polarity rule `passes` is not monotonic and the
 * search can stop at an alpha that only works for one pixel colour.
 */
export function computeGateAlpha({ text, base, artLuminance, target }: GateAlphaInput): number {
  const art = grayForLuminance(artLuminance);
  const textLuminance = relativeLuminance(text);
  const baseIsLighter = relativeLuminance(base) > textLuminance;
  const passes = (alpha: number) => {
    const shown = blendOver(base, art, alpha);
    if (relativeLuminance(shown) > textLuminance !== baseIsLighter) return false;
    return contrastRatio(text, shown) >= target;
  };
  if (passes(0)) return 0;
  if (!passes(1)) return 1;
  let low = 0;
  let high = 1;
  while (high - low > ALPHA_PRECISION / 2) {
    const mid = (low + high) / 2;
    if (passes(mid)) high = mid;
    else low = mid;
  }
  return high;
}

/** Contrast targets: primary text at the WCAG body-text level, secondary (muted) text at 3:1. */
const TARGETS = {
  standard: { foreground: 4.5, muted: 3 },
  more: { foreground: 7, muted: 4.5 },
} as const;

export interface ArtLimitInput {
  /** Opaque page color the art is drawn over (the theme's `surface0`). */
  surface: string;
  foreground: string;
  foregroundMuted: string;
  colorScheme: "light" | "dark";
  /** Measured art luminance; null assumes pure white (dark themes) or pure black (light themes). */
  luminance: { low: number; high: number } | null;
  /** The OS asks for more contrast. */
  moreContrast: boolean;
}

/**
 * Largest art opacity (0–1) over `surface` that keeps primary text at 4.5:1 and muted text at
 * 3:1 against the worst pixel of the art (7:1 and 4.5:1 with more contrast). Muted text is held
 * to the 3:1 tier because light themes leave it no room: Paseo's light muted grey is only 4.83:1
 * on plain white, so a 4.5:1 floor would hide every skin behind a ~96% veil.
 */
export function computeArtLimit(input: ArtLimitInput): number {
  const base = parseColor(input.surface);
  const artLuminance =
    input.colorScheme === "dark" ? (input.luminance?.high ?? 1) : (input.luminance?.low ?? 0);
  const targets = input.moreContrast ? TARGETS.more : TARGETS.standard;
  const gate = (text: string, target: number) =>
    computeGateAlpha({ text: parseColor(text), base, artLuminance, target });
  return (
    1 -
    Math.max(gate(input.foreground, targets.foreground), gate(input.foregroundMuted, targets.muted))
  );
}
