import React, { type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
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
  eyebrow,
  accessory,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  eyebrow?: string;
  accessory?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets={false}
      >
        <View style={styles.topbar}>
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
          ) : (
            <Text style={styles.brand}>SCAN TO MAKE</Text>
          )}
          {accessory}
        </View>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
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
    </KeyboardAvoidingView>
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
        pressed &&
          !disabled &&
          (primary
            ? styles.buttonPrimaryPressed
            : styles.buttonSecondaryPressed),
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          primary ? styles.buttonTextPrimary : styles.buttonTextSecondary,
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
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
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
  content: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    paddingBottom: 40,
  },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    marginBottom: space.lg,
  },
  brand: { ...type.label, color: colors.ink, letterSpacing: 2 },
  eyebrow: { ...type.label, color: colors.accent, marginBottom: space.md },
  back: {
    alignSelf: 'flex-start',
    minHeight: 48,
    justifyContent: 'center',
    marginLeft: -space.sm,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  backPressed: { backgroundColor: colors.pressedOverlay },
  backText: { fontSize: 15, color: colors.ink, fontWeight: '500' },
  subtitle: { ...type.body, color: colors.muted, marginTop: space.sm },
  body: { marginTop: space.xl, gap: space.lg },
  footer: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.background,
  },
  button: {
    minHeight: 56,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonPrimary: { backgroundColor: colors.ink },
  buttonPrimaryPressed: { backgroundColor: colors.accentPressed },
  buttonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  buttonSecondaryPressed: { backgroundColor: colors.pressedOverlay },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  buttonTextPrimary: { color: colors.accentInk },
  buttonTextSecondary: { color: colors.ink },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  pillText: { fontSize: 13, fontWeight: '700' },
  stat: { flexBasis: '45%', flexGrow: 1, gap: space.xs },
});
