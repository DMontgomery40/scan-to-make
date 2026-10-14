export const colors = {
  background: '#F4F1EA',
  surface: '#FFFEFA',
  ink: '#202621',
  muted: '#62675F',
  line: '#D9DDD3',
  accent: '#A93D20',
  accentInk: '#FFFFFF',
  accentSoft: '#F8E7DC',
  accentPressed: '#873018',
  pressedOverlay: '#E8EAE2',
  viewport: '#26332D',
  viewportInk: '#E4E9DB',
  pass: '#286044',
  passSoft: '#E1EDDF',
  fail: '#A52D26',
  failSoft: '#FAE4DF',
  pending: '#725118',
  pendingSoft: '#F1E8CF',
};
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
