export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsv {
  /** Hue in degrees [0, 360). */
  h: number;
  /** Saturation in [0, 1]. */
  s: number;
  /** Value (brightness) in [0, 1]. */
  v: number;
}

/**
 * Pastel gamut tuned for soft, muted wool/yarn rug shades:
 * high value (bright & airy) with low-to-moderate saturation.
 */
export const PASTEL_S_MIN = 0.02;
export const PASTEL_S_MAX = 0.42;
export const PASTEL_V_MIN = 0.68;
export const PASTEL_V_MAX = 0.96;

/** Curated soft pastel presets inspired by warm wool & dusty pastel palettes. */
export const PASTEL_PRESETS: readonly string[] = [
  '#f0d3c8',
  '#e3d3b5',
  '#d9bc8c',
  '#e3c39d',
  '#cfc5b9',
  '#d5b9a5',
  '#c7c1bd',
  '#c5c8ca',
  '#d2c4d4',
  '#b8cfba',
  '#b6cad6',
  '#dfb9c2',
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function hexToRgb(hex: string): Rgb {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return { r: 0, g: 0, b: 0 };
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : delta / max;
  return { h: h % 360, s, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 1);
  const vv = clamp(v, 0, 1);
  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (hh < 60) [rn, gn, bn] = [c, x, 0];
  else if (hh < 120) [rn, gn, bn] = [x, c, 0];
  else if (hh < 180) [rn, gn, bn] = [0, c, x];
  else if (hh < 240) [rn, gn, bn] = [0, x, c];
  else if (hh < 300) [rn, gn, bn] = [x, 0, c];
  else [rn, gn, bn] = [c, 0, x];
  return {
    r: Math.round((rn + m) * 255),
    g: Math.round((gn + m) * 255),
    b: Math.round((bn + m) * 255),
  };
}

export function hexToHsv(hex: string): Hsv {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

export function hsvToHex(h: number, s: number, v: number): string {
  const { r, g, b } = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}

export function toPastelHsv(hsv: Hsv): Hsv {
  const h = ((hsv.h % 360) + 360) % 360;
  if (hsv.s < 0.01 && (hsv.v < 0.1 || hsv.v > 0.99)) {
    return { h: h || 28, s: 0.22, v: 0.86 };
  }
  return {
    h,
    s: clamp(hsv.s, PASTEL_S_MIN, PASTEL_S_MAX),
    v: clamp(hsv.v, PASTEL_V_MIN, PASTEL_V_MAX),
  };
}

export function isPastelHsv(hsv: Hsv): boolean {
  const eps = 0.015;
  return (
    hsv.s >= PASTEL_S_MIN - eps &&
    hsv.s <= PASTEL_S_MAX + eps &&
    hsv.v >= PASTEL_V_MIN - eps &&
    hsv.v <= PASTEL_V_MAX + eps
  );
}

export function padToHsv(nx: number, ny: number, h: number, pastel: boolean): Hsv {
  const x = clamp(nx, 0, 1);
  const y = clamp(ny, 0, 1);
  const hh = ((h % 360) + 360) % 360;
  if (pastel) {
    return {
      h: hh,
      s: PASTEL_S_MIN + x * (PASTEL_S_MAX - PASTEL_S_MIN),
      v: PASTEL_V_MAX - y * (PASTEL_V_MAX - PASTEL_V_MIN),
    };
  }
  return {
    h: hh,
    s: x,
    v: 1 - y,
  };
}

export function hsvToPad(hsv: Hsv, pastel: boolean): { nx: number; ny: number } {
  if (pastel) {
    return {
      nx: clamp((hsv.s - PASTEL_S_MIN) / (PASTEL_S_MAX - PASTEL_S_MIN), 0, 1),
      ny: clamp((PASTEL_V_MAX - hsv.v) / (PASTEL_V_MAX - PASTEL_V_MIN), 0, 1),
    };
  }
  return {
    nx: clamp(hsv.s, 0, 1),
    ny: clamp(1 - hsv.v, 0, 1),
  };
}
