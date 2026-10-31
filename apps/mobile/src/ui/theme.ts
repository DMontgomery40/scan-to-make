import { DynamicColorIOS, Platform, type ColorValue } from 'react-native';

// Light values are the original palette. Dark values keep the same warm,
// green-grey character and meet WCAG AA contrast for text on `background`
// and `surface`.
const light = {
  background: '#F4F1EA',
  surface: '#FFFEFA',
  ink: '#202621',
  muted: '#62675F',
  line: '#D9DDD3',
  accent: '#A93D20',
  accentInk: '#FFFFFF',
  accentSoft: '#F8E7DC',
  accentPressed: '#873018',
  // Fills (buttons, art). White on it is 4.6:1. Accent *text* stays `accent`,
  // because clay on paper is 4.1:1, below AA for small text.
  clay: '#C4512B',
  clayPressed: '#A8421F',
  pressedOverlay: '#E8EAE2',
  viewport: '#26332D',
  viewportInk: '#E4E9DB',
  pass: '#286044',
  passSoft: '#E1EDDF',
  fail: '#A52D26',
  failSoft: '#FAE4DF',
  pending: '#725118',
  pendingSoft: '#F1E8CF',
  // Tinted panels that carry ordinary body text.
  sage: '#E5E9DC',
  sageLine: '#CED5C6',
  sageInk: '#4C5948',
  sageMuted: '#53614D',
  sageStroke: '#74826C',
  sand: '#E9E3D5',
  stone: '#E6E2D8',
  stoneStroke: '#7C8071',
  placeholder: '#697064',
};
type Palette = Record<keyof typeof light, string>;
const dark: Palette = {
  background: '#131613',
  surface: '#1D211D',
  ink: '#ECEEE6',
  muted: '#A4AA9F',
  line: '#353B34',
  accent: '#F08A63',
  accentInk: '#131613',
  accentSoft: '#3B241A',
  accentPressed: '#C9603C',
  clay: '#F08A63',
  clayPressed: '#C9603C',
  pressedOverlay: '#2A2F29',
  viewport: '#3A4A40',
  viewportInk: '#E4E9DB',
  pass: '#7DC89C',
  passSoft: '#1B3226',
  fail: '#FF8C80',
  failSoft: '#3D1D1A',
  pending: '#E4BF6F',
  pendingSoft: '#3A3019',
  sage: '#202A23',
  sageLine: '#344037',
  sageInk: '#BAC5B1',
  sageMuted: '#A9B59F',
  sageStroke: '#7F8E77',
  sand: '#2A2720',
  stone: '#2B2A25',
  stoneStroke: '#9A9E8F',
  placeholder: '#8D9387',
};

/**
 * iOS resolves these natively from the current appearance, so module-level
 * StyleSheets follow light and dark mode without re-rendering. Android keeps
 * the light palette.
 */
function adaptive(values: Palette, night: Palette) {
  const result = {} as Record<keyof Palette, ColorValue>;
  for (const key of Object.keys(values) as (keyof Palette)[]) {
    result[key] =
      Platform.OS === 'ios'
        ? DynamicColorIOS({ light: values[key], dark: night[key] })
        : values[key];
  }
  return result;
}

export const palettes = { light, dark };
export const colors = adaptive(light, dark);
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { md: 16, lg: 24, pill: 999 };
export const type = {
  title: {
    fontSize: 34,
    lineHeight: 39,
    fontWeight: '600' as const,
    color: colors.ink,
    letterSpacing: -1.1,
  },
  heading: {
    fontSize: 21,
    lineHeight: 27,
    fontWeight: '600' as const,
    color: colors.ink,
    letterSpacing: -0.4,
  },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  caption: { fontSize: 13, lineHeight: 19, color: colors.muted },
  label: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700' as const,
    color: colors.muted,
    letterSpacing: 1.5,
  },
  stat: {
    fontSize: 27,
    lineHeight: 32,
    fontWeight: '600' as const,
    color: colors.ink,
    fontVariant: ['tabular-nums' as const],
  },
};
