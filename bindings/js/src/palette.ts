import roleColors from './roles.json';

export type Theme = 'light' | 'dark';

/**
 * Contrast steps, as WCAG contrast ratios of the text to its background: from the least WCAG
 * allows for text (AA) to black on white.
 */
export const CONTRASTS = [4.5, 7, 10, 14, 21];
const MOST = 21;

/**
 * Colors of text by its role – verse numbers, headings, a word as written where another is read,
 * tajweed rules – as made for black on white.
 * Each keeps its hue and its share of the contrast: on a dark background a dark color turns light,
 * and as the contrast is lowered, the colors move toward the background with the text.
 */
export const ROLE_COLORS: Record<string, string> = roleColors;
const HIGHLIGHT = '#FFE082';
/** On a dark background a highlight needs a larger share of the contrast to show. */
const DARK_HIGHLIGHT_SHARE = 0.28;
/** A light background turns a little warm as the contrast is lowered, like paper. */
const PAPER = { hue: 85, chroma: 0.03 };

export type Palette = {
  dark: boolean;
  background: string;
  text: string;
  /** Text of less weight, such as captions. */
  secondary: string;
  border: string;
  highlight: string;
  roles: Record<string, string>;
};

/** The colors for a theme at a contrast, one of CONTRASTS; text by its role as `roles` have it for black on white. */
export function palette(theme: Theme, contrast: number, roles = ROLE_COLORS): Palette {
  const dark = theme === 'dark';
  // Of the contrast taken away from black on white, a quarter goes to the background, the rest
  // to the text. Contrast ratios multiply, so the shares are of its logarithm.
  const lowered = Math.log(MOST / contrast);
  const backgroundY = dark ? 0.05 * Math.exp(lowered / 4) - 0.05 : 1.05 * Math.exp(-lowered / 4) - 0.05;
  // The luminance on the text's side of the background at the given share of the contrast.
  const at = (share: number) => {
    const ratio = contrast ** share;
    return dark ? ratio * (backgroundY + 0.05) - 0.05 : (backgroundY + 0.05) / ratio - 0.05;
  };
  const textLightness = lightnessFor(at(1), 0, 0);
  const like = (base: string, share = shareOf(base)) => {
    const [, chroma, hue] = oklch(base);
    return hex(inGamut(lightnessFor(at(share), hue, chroma), chroma, hue));
  };
  // Dark colors leave little room for chroma: on a dark background, a light color such as orange
  // would turn brown. Text in color gets as light as its chroma needs, though not lighter than the text.
  const textLike = (base: string) => {
    if (!dark) return like(base);
    const [, chroma, hue] = oklch(base);
    const lightness = Math.min(Math.max(lightnessFor(at(shareOf(base)), hue, chroma), lightnessForChroma(chroma, hue)), textLightness);
    return hex(inGamut(lightness, chroma, hue));
  };
  const paperChroma = dark ? 0 : PAPER.chroma * (lowered / Math.log(MOST));
  return {
    dark,
    background: hex(inGamut(lightnessFor(backgroundY, PAPER.hue, paperChroma), paperChroma, PAPER.hue)),
    text: like('#000000', 1),
    secondary: like('#000000', 0.75),
    border: like('#000000', 0.3),
    highlight: like(HIGHLIGHT, dark ? DARK_HIGHLIGHT_SHARE : undefined),
    roles: Object.fromEntries(Object.entries(roles).map(([role, color]) => [role, textLike(color)])),
  };
}

/** A color's share of the contrast of black on white, measured against white. */
const shareOf = (color: string) => Math.log(1.05 / (luminance(linear(color)) + 0.05)) / Math.log(MOST);

/** The lightness at which this hue and chroma, as much of it as fits in sRGB, has the given WCAG luminance. */
function lightnessFor(target: number, hue: number, chroma: number) {
  const [low, high] = bisect(0, 1, (lightness) => luminance(inGamut(lightness, chroma, hue)) < target);
  return (low + high) / 2;
}

/** The least lightness at which this chroma fits in sRGB, or where the hue has the most chroma. */
function lightnessForChroma(chroma: number, hue: number) {
  // A hue's chroma in sRGB grows with the lightness up to a peak, then shrinks.
  const most = (lightness: number) => bisect(0, 0.4, (candidate) => fits(lightness, candidate, hue))[0];
  let [low, high] = [0, 1];
  for (let step = 0; step < 24; step++) {
    const [left, right] = [low + (high - low) / 3, high - (high - low) / 3];
    if (most(left) < most(right)) low = left;
    else high = right;
  }
  const peak = (low + high) / 2;
  return most(peak) <= chroma ? peak : bisect(0, peak, (lightness) => most(lightness) < chroma)[1];
}

const fits = (lightness: number, chroma: number, hue: number) =>
  fromOklch(lightness, chroma, hue).every((value) => value >= -1e-4 && value <= 1 + 1e-4);

/** Linear sRGB of an OKLCH color, its chroma lowered until it fits. */
function inGamut(lightness: number, chroma: number, hue: number) {
  const chromaThatFits = fits(lightness, chroma, hue) ? chroma : bisect(0, chroma, (candidate) => fits(lightness, candidate, hue))[0];
  return fromOklch(lightness, chromaThatFits, hue);
}

/** Narrows [low, high] to where `below` turns from true to false. */
function bisect(low: number, high: number, below: (value: number) => boolean) {
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2;
    if (below(middle)) low = middle;
    else high = middle;
  }
  return [low, high];
}

const luminance = ([red, green, blue]: number[]) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;

function linear(color: string) {
  const channels = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16) / 255);
  return channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
}

function hex(channels: number[]) {
  const encoded = channels.map((value) => {
    const clamped = Math.min(Math.max(value, 0), 1);
    const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(gamma * 255).toString(16).padStart(2, '0');
  });
  return `#${encoded.join('')}`.toUpperCase();
}

// OKLab, after Björn Ottosson: perceptual lightness, and hue and chroma that stay put as the
// lightness changes.
function oklch(color: string) {
  const [red, green, blue] = linear(color);
  const [l, m, s] = [
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
  ].map(Math.cbrt);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [lightness, Math.hypot(a, b), (Math.atan2(b, a) * 180) / Math.PI];
}

function fromOklch(lightness: number, chroma: number, hue: number) {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const [l, m, s] = [
    lightness + 0.3963377774 * a + 0.2158037573 * b,
    lightness - 0.1055613458 * a - 0.0638541728 * b,
    lightness - 0.0894841775 * a - 1.291485548 * b,
  ].map((value) => value ** 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
