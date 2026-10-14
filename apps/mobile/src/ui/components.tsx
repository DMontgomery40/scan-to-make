import React, { type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Verdict } from '../spike/d004';
import { colors, radius, space, type } from './theme';

export function Screen({
  title,
  subtitle,
  onBack,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        scrollIndicatorInsets={{ right: 1 }}
      >
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
            onPress={onBack}
            style={({ pressed }) => [
              styles.back,
              pressed && styles.backPressed,
            ]}
          >
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
        ) : null}
        <Text accessibilityRole="header" style={type.title}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        <View style={styles.body}>{children}</View>
      </ScrollView>
      {footer ? (
        <View
          style={[styles.footer, { paddingBottom: insets.bottom + space.lg }]}
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        disabled && styles.buttonDisabled,
        pressed && !disabled && (primary ? styles.buttonPrimaryPressed : styles.buttonSecondaryPressed),
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          primary ? styles.buttonTextPrimary : styles.buttonTextSecondary,
          disabled && styles.buttonTextDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({
  children,
  style,
  highlight,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  highlight?: boolean;
}) {
  return (
    <View style={[styles.card, highlight && styles.cardHighlight, style]}>
      {children}
    </View>
  );
}

const VERDICT_STYLE: Record<Verdict, { fg: string; bg: string; text: string }> =
  {
    pass: { fg: colors.pass, bg: colors.passSoft, text: 'Pass' },
    fail: { fg: colors.fail, bg: colors.failSoft, text: 'Fail' },
    inconclusive: {
      fg: colors.pending,
      bg: colors.pendingSoft,
      text: 'Not yet known',
    },
  };

export function VerdictPill({ verdict }: { verdict: Verdict }) {
  const v = VERDICT_STYLE[verdict];
  return (
    <View style={[styles.pill, { backgroundColor: v.bg }]}>
      <Text style={[styles.pillText, { color: v.fg }]}>{v.text}</Text>
    </View>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={styles.stat}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text style={type.label}>{label.toUpperCase()}</Text>
      <Text style={type.stat}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.xl, paddingBottom: space.xxl },
  back: {
    alignSelf: 'flex-start',
    marginBottom: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  backPressed: { backgroundColor: colors.overlay },
  backText: { fontSize: 17, color: colors.accent, fontWeight: '600' },
  subtitle: { ...type.bodyMuted, marginTop: space.md },
  body: { marginTop: space.xl, gap: space.lg },
  footer: {
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.background,
  },
  button: {
    minHeight: 56,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonPrimaryPressed: { backgroundColor: colors.accentDark },
  buttonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.line,
  },
  buttonSecondaryPressed: { backgroundColor: colors.overlay },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontSize: 17, fontWeight: '600' },
  buttonTextPrimary: { color: colors.accentInk },
  buttonTextSecondary: { color: colors.ink },
  buttonTextDisabled: { color: colors.muted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    gap: space.sm,
  },
  cardHighlight: {
    borderColor: colors.accent,
    borderWidth: 2,
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  pillText: { fontSize: 12, fontWeight: '700' },
  stat: { flexBasis: '45%', flexGrow: 1, gap: space.xs },
});
