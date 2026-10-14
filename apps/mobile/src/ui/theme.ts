export const colors = {
  background: '#F6F4EF',
  surface: '#FFFFFF',
  ink: '#1B1F23',
  muted: '#5F6670',
  subtle: '#95939F',
  line: '#E3DFD6',
  accent: '#1F6F5C',
  accentInk: '#FFFFFF',
  accentSoft: '#E3F0EB',
  accentDark: '#0F4838',
  viewport: '#15181B',
  viewportInk: '#C9D1D9',
  pass: '#1F7A4D',
  passSoft: '#E2F3E9',
  fail: '#B3261E',
  failSoft: '#FBE7E5',
  pending: '#8A5A00',
  pendingSoft: '#FBF0DA',
  overlay: 'rgba(27, 31, 35, 0.08)',
  overlayStrong: 'rgba(27, 31, 35, 0.12)',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

export const type = {
  title: {
    fontSize: 32,
    fontWeight: '700' as const,
    color: colors.ink,
    letterSpacing: -0.6,
    lineHeight: 40,
  },
  heading: {
    fontSize: 20,
    fontWeight: '600' as const,
    color: colors.ink,
    lineHeight: 26,
  },
  subheading: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: colors.ink,
    lineHeight: 22,
  },
  body: { fontSize: 16, lineHeight: 24, color: colors.ink },
  bodyMuted: { fontSize: 16, lineHeight: 24, color: colors.muted },
  caption: { fontSize: 13, lineHeight: 18, color: colors.muted },
  captionEmph: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.subtle,
    fontWeight: '500' as const,
  },
  label: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: colors.muted,
    letterSpacing: 0.5,
  },
  stat: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: colors.ink,
    fontVariant: ['tabular-nums' as const],
    lineHeight: 32,
  },
};
