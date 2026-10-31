import React, { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, TextInput } from 'react-native';
import { Button, Card, Screen } from '../ui/components';
import { colors, type } from '../ui/theme';
import {
  parsePairingQR,
  qrScanner,
  type QRScanner,
} from '../companion/pairingLink';
import {
  companionNative,
  invitation,
  pairingError,
  type CompanionNative,
  type PairingStatus,
} from '../companion/pairing';

export function CompanionScreen({
  onBack,
  native = companionNative(),
  scanner = qrScanner(),
  link,
  onLinkUsed,
}: {
  onBack: () => void;
  native?: CompanionNative;
  scanner?: QRScanner;
  /** A pairing link the app was opened with, e.g. from the Camera app. */
  link?: string | null;
  onLinkUsed?: () => void;
}) {
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('My phone');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const [manual, setManual] = useState(false);
  // A pairing link waiting to be used, e.g. from the Camera app.
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    native
      ?.status()
      .then(value => {
        if (live) {
          setStatus(value);
          setUrl(value.baseUrl ?? '');
        }
      })
      .catch(error => {
        if (live) {
          setMessage(
            pairingError(error) ??
              'Could not read the connection. Retry after unlocking this device.',
          );
        }
      });
    return () => {
      live = false;
      native?.cancel().catch(() => {});
    };
  }, [native]);
  const run = async (action: () => Promise<PairingStatus>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      setStatus(result);
      setUrl(result.baseUrl ?? '');
      setReplace(false);
      setMessage(success);
    } catch (error) {
      setMessage(
        pairingError(error) ??
          'The connection could not complete. Your projects are unchanged.',
      );
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      const parsed = invitation(code, url);
      // Do not retain the invitation in the form after exchange, even on error.
      setCode('');
      return native!.pair(
        parsed.baseUrl,
        parsed.code,
        name.trim(),
        parsed.certificateSha256 ?? null,
      );
    }, 'Paired securely on this device. Check connection to verify the companion is ready.');
  const pairWith = (value: string) =>
    run(async () => {
      const parsed = parsePairingQR(value);
      return native!.pair(
        parsed.baseUrl,
        parsed.code,
        name.trim() || 'My phone',
        parsed.certificateSha256 ?? null,
      );
    }, 'Paired with your computer.');
  const scan = async () => {
    let value: string;
    try {
      value = await scanner!.scan();
    } catch (error) {
      if ((error as { code?: string })?.code !== 'cancelled') {
        setMessage((error as { message?: string })?.message ?? null);
      }
      return;
    }
    await pairWith(value);
  };
  // A link is taken once. It pairs only after the stored pairing has been
  // read successfully, and never replaces an existing pairing without asking.
  useEffect(() => {
    if (!link) return;
    onLinkUsed?.();
    setPending(link);
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps
  const paired = status?.state === 'paired' && !replace;
  useEffect(() => {
    if (!pending || !native || !status || busy || paired) return;
    setPending(null);
    pairWith(pending);
  }, [pending, native, status, busy, paired]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Screen
      title="Your companion"
      eyebrow="CLEANUP ON YOUR COMPUTER"
      subtitle="Your computer cleans up your scans. Your projects stay with you."
      onBack={busy ? undefined : onBack}
      footer={
        <Button
          label={busy ? 'Connecting…' : 'Done'}
          disabled={busy}
          onPress={onBack}
        />
      }
    >
      {!native ? (
        <Card>
          <Text style={type.heading}>Pairing is available on iOS</Text>
          <Text style={type.body}>
            You can keep planning and saving projects here. This platform’s
            secure companion connection is not available yet.
          </Text>
        </Card>
      ) : (
        <>
          {status === null && !message ? (
            <Text style={type.body}>Reading secure connection…</Text>
          ) : null}
          {message ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={type.body}
            >
              {message}
            </Text>
          ) : null}
          {status?.fixture ? (
            <Card>
              <Text style={type.heading}>Simulator fixture</Text>
              <Text style={type.caption}>
                Local test transport. This does not verify HTTPS, a Tailscale
                connection or a physical phone.
              </Text>
            </Card>
          ) : null}
          {pending && paired ? (
            <Card>
              <Text style={type.heading}>Pair with a new computer?</Text>
              <Text style={type.body}>
                This phone is already paired. Pairing with the computer in this
                code replaces the current pairing.
              </Text>
              <Button
                label="Pair with this one"
                disabled={busy}
                onPress={() => setReplace(true)}
              />
              <Button
                label="Keep current pairing"
                variant="secondary"
                disabled={busy}
                onPress={() => setPending(null)}
              />
            </Card>
          ) : null}
          {paired ? (
            <Card>
              <Text style={type.label}>SAVED COMPANION</Text>
              <Text selectable style={type.heading}>
                {status.baseUrl}
              </Text>
              <Text style={type.caption}>
                Pairing expires{' '}
                {new Date(status.expiresAt!).toLocaleDateString()}. No printer
                access is granted.
              </Text>
              <Button
                label="Check connection"
                disabled={busy}
                onPress={() =>
                  run(
                    () => native.check(),
                    'Connected. Your companion is ready to clean up your scans.',
                  )
                }
              />
              <Button
                label="Use a new invitation"
                variant="secondary"
                disabled={busy}
                onPress={() => {
                  setReplace(true);
                  setMessage(null);
                }}
              />
            </Card>
          ) : (
            <>
              <Card>
                <Text style={type.heading}>
                  {status?.state === 'expired'
                    ? 'Pairing expired. Scan a new code.'
                    : 'Pair with your computer'}
                </Text>
                <Text style={type.body}>
                  Open the Scan to Make companion on your computer and scan the
                  QR code it shows. Your phone needs to reach your computer: the
                  same Wi-Fi, your VPN or Tailscale.
                </Text>
                <Button
                  label={busy ? 'Connecting…' : 'Scan QR code'}
                  disabled={busy || !scanner}
                  onPress={scan}
                />
                <Button
                  label={manual ? 'Hide code entry' : 'Enter code instead'}
                  variant="secondary"
                  disabled={busy}
                  onPress={() => setManual(value => !value)}
                />
                <Button
                  label="Tailscale setup guide"
                  variant="secondary"
                  onPress={() => {
                    Linking.openURL(
                      'https://tailscale.com/docs/install/ios',
                    ).catch(() =>
                      setMessage(
                        'Could not open the guide. Visit tailscale.com/docs/install/ios in your browser.',
                      ),
                    );
                  }}
                />
              </Card>
              {manual ? (
                <Card>
                  <Text style={type.heading}>
                    {status?.state === 'expired'
                      ? 'Pairing expired'
                      : 'Add your invitation'}
                  </Text>
                  <Text style={type.body}>
                    Enter the companion address and one-time code, or paste the
                    invitation JSON into the code field. Invitations expire
                    after five minutes. Leave the address blank when using the
                    full invitation.
                  </Text>
                  <Text style={type.label}>COMPANION HTTPS ADDRESS</Text>
                  <TextInput
                    accessibilityLabel="Companion HTTPS address"
                    value={url}
                    onChangeText={setUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    editable={!busy}
                    placeholder="https://computer.network.ts.net"
                    style={styles.input}
                  />
                  <Text style={type.label}>PAIRING CODE OR INVITATION</Text>
                  <TextInput
                    accessibilityLabel="Pairing code or invitation"
                    value={code}
                    onChangeText={setCode}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                    editable={!busy}
                    maxLength={2048}
                    placeholder="One-time invitation"
                    style={styles.input}
                  />
                  <Text style={type.label}>THIS DEVICE’S NAME</Text>
                  <TextInput
                    accessibilityLabel="Device name"
                    value={name}
                    onChangeText={setName}
                    maxLength={80}
                    editable={!busy}
                    style={styles.input}
                  />
                  <Button
                    label="Pair companion"
                    disabled={busy || !code.trim() || !name.trim()}
                    onPress={connect}
                  />
                  <Text style={type.caption}>
                    Pairing credentials are kept in this device’s secure
                    storage, separate from your projects.
                  </Text>
                </Card>
              ) : null}
            </>
          )}
          {status?.baseUrl ? (
            <Card>
              <Button
                label="Disconnect this device"
                variant="secondary"
                disabled={busy}
                onPress={() =>
                  run(
                    () => native.disconnect(),
                    'Disconnected. Your projects and drafts are unchanged.',
                  )
                }
              />
              <Text style={type.caption}>
                Removes the credential from this device. To revoke a lost
                device, ask the companion owner to remove its pairing on the
                computer.
              </Text>
            </Card>
          ) : null}
          {status === null && message ? (
            <Button
              label="Retry secure storage"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                run(() => native.status(), 'Secure storage is available.')
              }
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}
const styles = StyleSheet.create({
  input: {
    ...type.body,
    minHeight: 52,
    padding: 12,
    backgroundColor: colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
  },
});
