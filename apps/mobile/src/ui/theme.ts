import { DynamicColorIOS, Platform, type ColorValue } from 'react-native';

// Matte-PLA paper and graphite ink, one cobalt for the action that moves
// something forward (Print, Scan, Send), and a dark build-plate panel behind
// renders. Text colours meet WCAG AA on `background` and `surface`.
const light = {
  background: '#F1F2F4',
  surface: '#FFFFFF',
  ink: '#252A31',
  muted: '#5E6670',
  line: '#D8DCE1',
  accent: '#2448D8',
  accentInk: '#FFFFFF',
  accentSoft: '#E3E9FD',
  accentPressed: '#1B37A8',
  clay: '#2448D8',
  clayPressed: '#1B37A8',
  pressedOverlay: '#E4E7EB',
  // The build plate a render sits on.
  viewport: '#2C3138',
  viewportInk: '#E9ECEF',
  pass: '#1E7B4F',
  passSoft: '#DFF1E7',
  fail: '#B3261E',
  failSoft: '#FBE5E3',
  pending: '#8A5A00',
  pendingSoft: '#F8EDD6',
  sage: '#E7EAEE',
  sageLine: '#D0D5DB',
  sageInk: '#3E4650',
  sageMuted: '#55606B',
  sageStroke: '#7A848F',
  sand: '#E9EBEE',
  stone: '#E6E8EB',
  stoneStroke: '#7C8590',
  placeholder: '#6B737D',
};
type Palette = Record<keyof typeof light, string>;
const dark: Palette = {
  background: '#15181C',
  surface: '#1F2329',
  ink: '#ECEEF1',
  muted: '#A3ABB5',
  line: '#353B43',
  accent: '#7B95FF',
  accentInk: '#0E1220',
  accentSoft: '#1E2747',
  accentPressed: '#5C78E8',
  clay: '#7B95FF',
  clayPressed: '#5C78E8',
  pressedOverlay: '#2A2F36',
  viewport: '#0E1013',
  viewportInk: '#E9ECEF',
  pass: '#74CFA0',
  passSoft: '#16301F',
  fail: '#FF8A80',
  failSoft: '#3B1C1A',
  pending: '#E7B95A',
  pendingSoft: '#352A14',
  sage: '#242A30',
  sageLine: '#363D45',
  sageInk: '#C3CAD2',
  sageMuted: '#AAB2BB',
  sageStroke: '#848E98',
  sand: '#262B31',
  stone: '#272C32',
  stoneStroke: '#99A2AC',
  placeholder: '#8E97A1',
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
    fontFamily: Platform.OS === 'ios' ? 'ui-rounded' : undefined,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700' as const,
    color: colors.ink,
    letterSpacing: -0.6,
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
    fontFamily: Platform.OS === 'ios' ? 'ui-rounded' : undefined,
    fontSize: 27,
    lineHeight: 32,
    fontWeight: '600' as const,
    color: colors.ink,
    fontVariant: ['tabular-nums' as const],
  },
};
