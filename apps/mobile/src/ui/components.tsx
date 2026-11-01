import React, { type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type ColorValue,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space, type } from './theme';
import { NativeActionButton } from './NativeActionButton';

/**
 * Screens read as one centred column at most this wide (points, before
 * padding), so lines and buttons stay a readable size on iPad and an
 * unfolded iPhone Duo.
 */
export const READABLE_WIDTH = 640;

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
  const { height } = useWindowDimensions();
  // A fixed action stack plus the software keyboard can consume a short window.
  // Keep the form and actions in one scroll surface at these sizes.
  const scrollFooter = Platform.OS === 'ios' && height < 500;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[
        styles.screen,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      <ScrollView
        contentContainerStyle={[styles.column, styles.content]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets={false}
      >
        <View style={styles.topbar}>
          {onBack && Platform.OS === 'ios' ? (
            <NativeActionButton
              label="‹ Back"
              accessibilityLabel="Back"
              onPress={onBack}
              compact
            />
          ) : onBack ? (
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
            <Text style={styles.brand}>Counterpart</Text>
          )}
          {accessory}
        </View>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text accessibilityRole="header" style={type.title}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        <View style={styles.body}>{children}</View>
        {footer && scrollFooter ? (
          <View style={styles.inlineFooter}>{footer}</View>
        ) : null}
      </ScrollView>
      {footer && !scrollFooter ? (
        <View style={styles.footer}>
          <View style={[styles.column, styles.footerActions]}>{footer}</View>
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
  accessibilityLabel,
  systemImage,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  /** iOS: an SF Symbol before the label. */
  systemImage?: string;
  disabled?: boolean;
  accessibilityHint?: string;
  /** Spoken name when the visible label repeats across a list. */
  accessibilityLabel?: string;
}) {
  const primary = variant === 'primary';
  if (Platform.OS === 'ios') {
    return (
      <NativeActionButton
        label={label}
        onPress={onPress}
        primary={primary}
        disabled={disabled}
        accessibilityHint={accessibilityHint}
        accessibilityLabel={accessibilityLabel}
        systemImage={systemImage}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
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

export type Tone = 'neutral' | 'pass' | 'fail' | 'pending' | 'accent';
const TONES: Record<Tone, { fg: ColorValue; bg: ColorValue }> = {
  neutral: { fg: colors.muted, bg: colors.background },
  pass: { fg: colors.pass, bg: colors.passSoft },
  fail: { fg: colors.fail, bg: colors.failSoft },
  pending: { fg: colors.pending, bg: colors.pendingSoft },
  accent: { fg: colors.accent, bg: colors.accentSoft },
};

/** A short status label. Pair it with text that explains the state. */
export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: Tone;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: TONES[tone].bg }]}>
      <Text style={[styles.pillText, { color: TONES[tone].fg }]}>{label}</Text>
    </View>
  );
}

/** An inline message that screen readers announce when it changes. */
export function Notice({
  title,
  children,
  tone = 'neutral',
  action,
}: {
  title?: string;
  children?: ReactNode;
  tone?: Tone;
  action?: ReactNode;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.notice, { backgroundColor: TONES[tone].bg }]}
    >
      {title ? (
        <Text style={[styles.noticeTitle, { color: TONES[tone].fg }]}>
          {title}
        </Text>
      ) : null}
      {typeof children === 'string' ? (
        <Text style={type.body}>{children}</Text>
      ) : (
        children
      )}
      {action}
    </View>
  );
}

/** A labelled text input. The label is also its accessibility name. */
export function Field({
  label,
  hint,
  error,
  suffix,
  style,
  containerStyle,
  ...input
}: TextInputProps & {
  label: string;
  hint?: string;
  error?: string | null;
  suffix?: string;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint ? <Text style={type.caption}>{hint}</Text> : null}
      <View style={[styles.inputRow, error ? styles.inputError : null]}>
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={hint}
          placeholderTextColor={colors.placeholder}
          {...input}
          style={[styles.input, style]}
        />
        {suffix ? (
          <Text style={styles.suffix} importantForAccessibility="no">
            {suffix}
          </Text>
        ) : null}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  column: {
    width: '100%',
    maxWidth: READABLE_WIDTH + space.xl * 2,
    alignSelf: 'center',
  },
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
  brand: { ...type.body, fontWeight: '600', color: colors.muted },
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
    paddingTop: space.md,
    paddingBottom: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.background,
  },
  footerActions: { paddingHorizontal: space.xl, gap: space.sm },
  inlineFooter: { marginTop: space.lg, gap: space.sm },
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
  notice: { borderRadius: radius.md, padding: space.lg, gap: space.sm },
  noticeTitle: { fontSize: 15, lineHeight: 21, fontWeight: '700' },
  field: { gap: 6 },
  fieldLabel: { ...type.body, fontWeight: '600' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    backgroundColor: colors.surface,
    paddingHorizontal: space.md,
  },
  inputError: { borderColor: colors.fail },
  input: {
    flex: 1,
    minHeight: 50,
    paddingVertical: 12,
    fontSize: 17,
    color: colors.ink,
  },
  suffix: { ...type.body, color: colors.muted, marginLeft: space.xs },
  fieldError: { ...type.caption, color: colors.fail },
});
