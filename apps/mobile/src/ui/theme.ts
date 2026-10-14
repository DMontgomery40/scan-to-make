export const colors = {
  background: '#F6F4EF',
  surface: '#FFFFFF',
  ink: '#1B1F23',
  muted: '#5F6670',
  line: '#E3DFD6',
  accent: '#1F6F5C',
  accentInk: '#FFFFFF',
  accentSoft: '#E3F0EB',
  viewport: '#15181B',
  viewportInk: '#C9D1D9',
  pass: '#1F7A4D',
  passSoft: '#E2F3E9',
  fail: '#B3261E',
  failSoft: '#FBE7E5',
  pending: '#8A5A00',
  pendingSoft: '#FBF0DA',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { md: 12, lg: 16, pill: 999 };

export const type = {
  title: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: colors.ink,
    letterSpacing: -0.4,
  },
  heading: { fontSize: 18, fontWeight: '600' as const, color: colors.ink },
  body: { fontSize: 16, lineHeight: 22, color: colors.ink },
  caption: { fontSize: 13, lineHeight: 18, color: colors.muted },
  label: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: colors.muted,
    letterSpacing: 0.4,
  },
  stat: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: colors.ink,
    fontVariant: ['tabular-nums' as const],
  },
};
