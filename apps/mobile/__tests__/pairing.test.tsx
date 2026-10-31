import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Alert, Linking, Text } from 'react-native';
import { FindYourMacScreen } from '../src/screens/FindYourMacScreen';
import {
  EXPIRED,
  invitation,
  pairingError,
  pairWithInvitation,
  UNREACHABLE,
  type CompanionNative,
  type PairingStatus,
} from '../src/companion/pairing';
import { Button } from '../src/ui/components';

const paired: PairingStatus = {
  state: 'paired',
  baseUrl: 'https://mac.example.ts.net',
  deviceId: 'id',
  expiresAt: 2000000000000,
};
function nativeMock(): CompanionNative {
  return {
    status: jest.fn(async () => paired),
    pair: jest.fn(async () => paired),
    pairAddresses: jest.fn(async () => paired),
    check: jest.fn(async () => paired),
    disconnect: jest.fn(async () => ({ state: 'disconnected' as const })),
    cancel: jest.fn(async () => {}),
  };
}
type Tree = Renderer.ReactTestRenderer;
async function press(tree: Tree, label: string) {
  await act(async () =>
    tree.root
      .findAllByType(Button)
      .find(x => x.props.label === label)!
      .props.onPress(),
  );
}
const hasButton = (tree: Tree, label: string) =>
  tree.root.findAllByType(Button).some(x => x.props.label === label);
function text(tree: Tree) {
  return tree.root
    .findAllByType(Text)
    .map(x => [x.props.children].flat().join(''))
    .join('\n');
}
const viewfinder = (tree: Tree) =>
  tree.root.find(n => String(n.type) === 'STMQRScannerView');
async function scanned(tree: Tree, value: string) {
  await act(async () =>
    viewfinder(tree).props.onCode({ nativeEvent: { value } }),
  );
}

const qrCode = 'Q'.repeat(20) + 'r_-'.repeat(4);
const pin = '0f'.repeat(32);
// Built the way your Mac builds it (URLSearchParams).
function qrLink(options: { expiresAt?: number; lan?: boolean } = {}): string {
  const params = new URLSearchParams({
    v: '1',
    u: options.lan ? 'https://192.168.1.20:9077' : paired.baseUrl!,
    c: qrCode,
    e: String(options.expiresAt ?? Date.now() + 300_000),
    ...(options.lan ? { f: pin } : {}),
  });
  return `scantomake://pair?${params.toString()}`;
}
async function render(
  native: CompanionNative,
  props: Partial<React.ComponentProps<typeof FindYourMacScreen>> = {},
) {
  let tree!: Tree;
  const onDone = jest.fn();
  await act(async () => {
    tree = Renderer.create(
      <FindYourMacScreen native={native} onDone={onDone} {...props} />,
    );
  });
  return { tree, onDone };
}
async function unpaired(
  props: Partial<React.ComponentProps<typeof FindYourMacScreen>> = {},
) {
  const native = nativeMock();
  (native.status as jest.Mock).mockResolvedValue({ state: 'disconnected' });
  return { native, ...(await render(native, props)) };
}

it('rejects expired and cross-host codes before anything is sent', () => {
  const json = JSON.stringify({
    version: 1,
    baseUrl: paired.baseUrl,
    code: 'A'.repeat(32),
    expiresAt: 2000,
  });
  expect(() => invitation(json, '', 2000)).toThrow();
  expect(() =>
    invitation(json, 'https://other.example.ts.net', 1000),
  ).toThrow();
  expect(invitation(json, '', 1000)).toEqual({
    baseUrl: paired.baseUrl,
    code: 'A'.repeat(32),
  });
});

it('recovery copy never repeats what your Mac sent, and says what to do', () => {
  expect(
    pairingError({ code: 'unauthorized', message: 'secret' }),
  ).not.toContain('secret');
  expect(pairingError({ code: 'expired-invitation' })).toBe(EXPIRED);
  expect(pairingError({ code: 'network' })).toBe(UNREACHABLE);
  expect(pairingError({ code: 'certificate-changed' })).toBe(
    'This Mac looks different from last time. Pair again to be safe.',
  );
});

it('Find your Mac opens on the viewfinder: point at the code and it pairs', async () => {
  const { tree, native, onDone } = await unpaired();
  expect(text(tree)).toContain('Find your Mac');
  expect(text(tree)).toContain('Point at the code in Scan to Make on your Mac');
  expect(viewfinder(tree).props.active).toBe(true);
  await scanned(tree, qrLink());
  expect(native.pair).toHaveBeenCalledWith(
    paired.baseUrl,
    qrCode,
    'My phone',
    null,
  );
  expect(text(tree)).toContain('Connected to your Mac');
  await press(tree, 'Open projects');
  expect(onDone).toHaveBeenCalledWith('projects');
  await act(async () => tree.unmount());
});

it('a v2 code pairs through every address with the public-key pin', async () => {
  const addresses = ['https://192.168.68.123:9077', 'https://mac.local:9077'];
  const key = 'ab'.repeat(32);
  const params = new URLSearchParams([
    ['v', '2'],
    ['c', qrCode],
    ['e', String(Date.now() + 300_000)],
    ['k', key],
    ...addresses.map(a => ['a', a]),
  ]);
  const { tree, native } = await unpaired();
  await scanned(tree, `scantomake://pair?${params}`);
  await press(tree, 'Continue');
  expect(native.pairAddresses).toHaveBeenCalledWith(
    addresses,
    qrCode,
    'My phone',
    key,
  );
  expect(native.pair).not.toHaveBeenCalled();
  expect(text(tree)).toContain('Connected to your Mac');
  await act(async () => tree.unmount());
});

it('pairWithInvitation uses the address list and key pin for v2, and the single address for v1', async () => {
  const native = nativeMock();
  const code = 'A'.repeat(32);
  await pairWithInvitation(native, { baseUrl: 'https://mac.tail1234.ts.net', code }, 'Phone');
  expect(native.pair).toHaveBeenLastCalledWith('https://mac.tail1234.ts.net', code, 'Phone', null);
  await pairWithInvitation(native, { baseUrl: 'https://192.168.1.20:9077', code, certificateSha256: pin }, 'Phone');
  expect(native.pair).toHaveBeenLastCalledWith('https://192.168.1.20:9077', code, 'Phone', pin);
  const addresses = ['https://192.168.1.20:9077', 'https://mac.local:9077'];
  await pairWithInvitation(native, { baseUrl: addresses[0], code, addresses, publicKeySha256: 'b'.repeat(64) }, 'Phone');
  expect(native.pairAddresses).toHaveBeenCalledWith(addresses, code, 'Phone', 'b'.repeat(64));
  expect(native.pair).toHaveBeenCalledTimes(2);
  expect(pairingError({ code: 'unsupported-invitation' })).toMatch(/newer Scan to Make/);
});

it('a code the camera sees many times is used once', async () => {
  const { tree, native } = await unpaired();
  let release!: () => void;
  (native.pair as jest.Mock).mockImplementation(
    () => new Promise(r => (release = () => r(paired))),
  );
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      viewfinder(tree).props.onCode({ nativeEvent: { value: qrLink() } });
    }
  });
  expect(native.pair).toHaveBeenCalledTimes(1);
  // While it's in use the camera is off, so it re-arms for the next code.
  expect(viewfinder(tree).props.active).toBe(false);
  await act(async () => release());
  await act(async () => tree.unmount());
});

it('the first code for a Mac on this Wi-Fi explains the local network question first', async () => {
  const { tree, native } = await unpaired();
  await scanned(tree, qrLink({ lan: true }));
  expect(native.pair).not.toHaveBeenCalled();
  expect(text(tree)).toContain(
    'To find your Mac, Scan to Make needs to look on your Wi-Fi.',
  );
  await press(tree, 'Continue');
  expect(native.pair).toHaveBeenCalledWith(
    'https://192.168.1.20:9077',
    qrCode,
    'My phone',
    pin,
  );
  await act(async () => tree.unmount());
});

it('the first v2 code also explains the local network question first', async () => {
  const addresses = ['https://192.168.1.20:9077', 'https://mac.local:9077'];
  const key = 'ab'.repeat(32);
  const params = new URLSearchParams([
    ['v', '2'],
    ['c', qrCode],
    ['e', String(Date.now() + 300_000)],
    ['k', key],
    ...addresses.map(a => ['a', a]),
  ]);
  const { tree, native } = await unpaired();
  await scanned(tree, `scantomake://pair?${params}`);
  expect(native.pairAddresses).not.toHaveBeenCalled();
  expect(native.pair).not.toHaveBeenCalled();
  expect(text(tree)).toContain(
    'To find your Mac, Scan to Make needs to look on your Wi-Fi.',
  );
  await press(tree, 'Continue');
  expect(native.pairAddresses).toHaveBeenCalledWith(
    addresses,
    qrCode,
    'My phone',
    key,
  );
  await act(async () => tree.unmount());
});

it('an unreachable Mac says so and tries the same code again; an expired one says how to get a new one', async () => {
  const { tree, native } = await unpaired();
  (native.pair as jest.Mock).mockRejectedValueOnce({ code: 'network' });
  await scanned(tree, qrLink());
  expect(text(tree)).toContain(UNREACHABLE);
  expect(viewfinder(tree).props.active).toBe(false);
  await press(tree, 'Try again');
  expect(native.pair).toHaveBeenCalledTimes(2);
  expect(text(tree)).toContain('Connected to your Mac');
  await act(async () => tree.unmount());

  const second = await unpaired();
  await scanned(second.tree, qrLink({ expiresAt: Date.now() - 1 }));
  expect(second.native.pair).not.toHaveBeenCalled();
  expect(text(second.tree)).toContain(EXPIRED);
  await press(second.tree, 'Try again');
  expect(viewfinder(second.tree).props.active).toBe(true);
  await act(async () => second.tree.unmount());
});

it('after pairing on a LiDAR device the next step is Scan something', async () => {
  const { tree, onDone } = await unpaired({ canScan: true });
  await scanned(tree, qrLink());
  await press(tree, 'Scan something');
  expect(onDone).toHaveBeenCalledWith('scan');
  await act(async () => tree.unmount());
});

it('a refused camera points to Settings', async () => {
  const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
  const { tree } = await unpaired();
  await act(async () =>
    viewfinder(tree).props.onState({ nativeEvent: { state: 'denied' } }),
  );
  expect(text(tree)).toContain('Scan to Make can’t use the camera.');
  await press(tree, 'Open Settings');
  expect(open).toHaveBeenCalled();
  open.mockRestore();
  await act(async () => tree.unmount());
});

it('a paired phone sees its Mac and can forget it', async () => {
  const native = nativeMock();
  const alert = jest.spyOn(Alert, 'alert');
  const { tree } = await render(native, { onBack: () => {} });
  expect(text(tree)).toContain('Your Mac');
  expect(text(tree)).toContain('Connected');
  expect(text(tree)).toContain('mac.example.ts.net');
  await press(tree, 'Forget this Mac');
  const buttons = alert.mock.calls.at(-1)![2]!;
  await act(async () => {
    await buttons.find(b => b.text === 'Forget')!.onPress!();
  });
  expect(native.disconnect).toHaveBeenCalled();
  expect(text(tree)).toContain('Find your Mac');
  alert.mockRestore();
  await act(async () => tree.unmount());
});

it('a pairing link pairs once when the screen opens', async () => {
  const native = nativeMock();
  (native.status as jest.Mock).mockResolvedValue({ state: 'disconnected' });
  const onLinkUsed = jest.fn();
  const { tree } = await render(native, { link: qrLink(), onLinkUsed });
  expect(onLinkUsed).toHaveBeenCalledTimes(1);
  expect(native.pair).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

it('a link while already paired asks before replacing the paired Mac', async () => {
  const native = nativeMock();
  const { tree } = await render(native, { link: qrLink() });
  expect(native.pair).not.toHaveBeenCalled();
  expect(text(tree)).toContain('Pair with another Mac?');
  await press(tree, 'Keep this Mac');
  expect(native.pair).not.toHaveBeenCalled();
  await act(async () => tree.unmount());

  const again = await render(nativeMock(), { link: qrLink() });
  await press(again.tree, 'Pair with that Mac');
  expect(hasButton(again.tree, 'Keep this Mac')).toBe(false);
  await act(async () => again.tree.unmount());
});

it('a link waits while the stored pairing can’t be read', async () => {
  const native = nativeMock();
  (native.status as jest.Mock).mockRejectedValueOnce({
    code: 'secure-storage',
  });
  const { tree } = await render(native, { link: qrLink() });
  expect(native.pair).not.toHaveBeenCalled();
  expect(text(tree)).toContain('This phone couldn’t read its pairing.');
  (native.status as jest.Mock).mockResolvedValueOnce({
    state: 'disconnected',
  });
  await press(tree, 'Try again');
  expect(native.pair).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

it('pairing another Mac stops the check of the paired one first', async () => {
  const native = nativeMock();
  // As on iOS, the phone sends one request to a Mac at a time.
  let checking: ((reason: unknown) => void) | null = null;
  (native.check as jest.Mock).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        checking = reject;
      }),
  );
  (native.cancel as jest.Mock).mockImplementation(async () => {
    checking?.({ code: 'cancelled' });
    checking = null;
  });
  (native.pair as jest.Mock).mockImplementation(async () => {
    if (checking) throw { code: 'busy' };
    return paired;
  });
  const alert = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) =>
      buttons?.[1]?.onPress?.(),
    );
  const { tree } = await render(native, { onBack: () => {} });
  expect(text(tree)).toContain('Looking for your Mac…');
  await press(tree, 'Pair another Mac');
  await scanned(tree, qrLink());
  expect(text(tree)).toContain('Connected to your Mac');
  alert.mockRestore();
  await act(async () => tree.unmount());
});

it('the camera waits for the stored pairing, so a paired Mac is never replaced unasked', async () => {
  const native = nativeMock();
  let read!: (value: PairingStatus) => void;
  (native.status as jest.Mock).mockImplementation(
    () =>
      new Promise(resolve => {
        read = resolve;
      }),
  );
  const { tree } = await render(native, { onBack: () => {} });
  expect(viewfinder(tree).props.active).toBe(false);
  await scanned(tree, qrLink());
  expect(native.pair).not.toHaveBeenCalled();
  await act(async () => read(paired));
  expect(text(tree)).toContain('Your Mac');
  expect(native.pair).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

it('a link that comes in while a code is in use is tried next', async () => {
  const { native, tree, onDone } = await unpaired();
  let fail!: (reason: unknown) => void;
  (native.pair as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  await scanned(tree, qrLink());
  const other = 'N'.repeat(32);
  const link = qrLink().replace(`c=${qrCode}`, `c=${other}`);
  await act(async () =>
    tree.update(
      <FindYourMacScreen native={native} onDone={onDone} link={link} />,
    ),
  );
  expect(native.pair).toHaveBeenCalledTimes(1);
  await act(async () => fail({ code: 'unauthorized' }));
  expect(native.pair).toHaveBeenCalledTimes(2);
  expect((native.pair as jest.Mock).mock.calls[1][1]).toBe(other);
  expect(text(tree)).toContain('Connected to your Mac');
  await act(async () => tree.unmount());
});

it('a link that comes in while pairing or on Connected asks before replacing the new Mac', async () => {
  const { native, tree, onDone } = await unpaired();
  let finish!: (value: PairingStatus) => void;
  (native.pair as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await scanned(tree, qrLink());
  const other = 'N'.repeat(32);
  const link = qrLink().replace(`c=${qrCode}`, `c=${other}`);
  const show = (next: string | null) =>
    act(async () =>
      tree.update(
        <FindYourMacScreen native={native} onDone={onDone} link={next} />,
      ),
    );
  // During the exchange.
  await show(link);
  await act(async () => finish(paired));
  expect(text(tree)).toContain('Pair with another Mac?');
  expect(hasButton(tree, 'Open projects')).toBe(false);
  await press(tree, 'Keep this Mac');
  expect(text(tree)).toContain('Connected to your Mac');
  expect(native.pair).toHaveBeenCalledTimes(1);
  // While Connected shows.
  await show(null);
  await show(link);
  expect(text(tree)).toContain('Pair with another Mac?');
  await press(tree, 'Pair with that Mac');
  expect(native.pair).toHaveBeenCalledTimes(2);
  expect((native.pair as jest.Mock).mock.calls[1][1]).toBe(other);
  expect(text(tree)).toContain('Connected to your Mac');
  await act(async () => tree.unmount());
});

it('a paired Mac that turns this phone away says to pair again, not to check the Wi-Fi', async () => {
  const native = nativeMock();
  (native.check as jest.Mock).mockRejectedValue({
    code: 'certificate-changed',
  });
  const { tree } = await render(native);
  expect(text(tree)).toContain(
    'This Mac looks different from last time. Pair again to be safe.',
  );
  expect(text(tree)).not.toContain('same Wi-Fi');
  await act(async () => tree.unmount());

  const offline = nativeMock();
  (offline.check as jest.Mock).mockRejectedValue({ code: 'network' });
  const again = await render(offline);
  expect(text(again.tree)).toContain(
    'Your phone can’t reach your Mac right now.',
  );
  expect(text(again.tree)).toContain(
    'Are they on the same Wi-Fi, or is your VPN on?',
  );
  await act(async () => again.tree.unmount());
});

// journey.md §9: words the app no longer uses.
const BANNED = [
  /companion/i,
  /invitation/i,
  /one-time code/i,
  /https address/i,
  /tailscale/i,
  /\bhost\b/i,
  /server/i,
  /\bcomputer\b/i,
];

it('every Find your Mac state uses only the plain words', async () => {
  const shown: string[] = [];
  const keep = (tree: Tree) => {
    shown.push(text(tree));
    shown.push(
      ...tree.root
        .findAll(n => typeof n.props.accessibilityLabel === 'string')
        .map(n => n.props.accessibilityLabel),
    );
  };
  const one = await unpaired();
  keep(one.tree);
  await scanned(one.tree, qrLink({ lan: true }));
  keep(one.tree);
  await act(async () => one.tree.unmount());
  for (const code of [
    'network',
    'expired-invitation',
    'unauthorized',
    'certificate-changed',
    'certificate',
    'wrong-host',
    'unavailable',
    'invalid-response',
    'rate-limited',
  ]) {
    const failing = await unpaired();
    (failing.native.pair as jest.Mock).mockRejectedValueOnce({ code });
    await scanned(failing.tree, qrLink());
    keep(failing.tree);
    await act(async () => failing.tree.unmount());
  }
  const done = await unpaired();
  await scanned(done.tree, qrLink());
  keep(done.tree);
  await act(async () => done.tree.unmount());
  const mine = await render(nativeMock(), { onBack: () => {} });
  keep(mine.tree);
  await act(async () => mine.tree.unmount());
  const all = shown.join('\n');
  for (const word of BANNED) expect(all).not.toMatch(word);
});

describe('keeping the credential alive (KAN-182)', () => {
  const {
    keepPairingFresh,
    KeepPairingFresh,
    REFRESH_WITHIN,
  } = require('../src/companion/keepPairingFresh');
  const { createRequestGate } = require('../src/screens/requestGate');
  const { AppState } = require('react-native');
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;
  function phone(daysLeft: number, refresh?: jest.Mock) {
    const native = nativeMock();
    (native.status as jest.Mock).mockResolvedValue({
      ...paired,
      expiresAt: now + daysLeft * DAY,
    });
    if (refresh) native.refresh = refresh;
    return native;
  }
  const fresh = (native: CompanionNative) =>
    keepPairingFresh(native, createRequestGate(), () => now);

  it('asks for more time only in the last 20 of 30 days', async () => {
    expect(REFRESH_WITHIN).toBe(20 * DAY);
    const early = jest.fn(async () => paired);
    expect(await fresh(phone(21, early))).toBe('fresh');
    expect(early).not.toHaveBeenCalled();
    const due = jest.fn(async () => paired);
    expect(await fresh(phone(19, due))).toBe('refreshed');
    expect(due).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the Mac is away or busy, and says pair again only when it refuses', async () => {
    for (const code of ['network', 'timeout', 'busy', 'unavailable']) {
      const refresh = jest.fn(async () => {
        throw { code };
      });
      expect(await fresh(phone(5, refresh))).toBe('skipped');
    }
    for (const code of ['unauthorized', 'forbidden', 'pairing-required']) {
      const refresh = jest.fn(async () => {
        throw { code };
      });
      expect(await fresh(phone(5, refresh))).toBe('pair-again');
    }
  });

  it('never refreshes an expired, missing or unreadable pairing, or on an older build', async () => {
    const refresh = jest.fn(async () => paired);
    const expired = phone(5, refresh);
    (expired.status as jest.Mock).mockResolvedValue({ state: 'expired' });
    expect(await fresh(expired)).toBe('pair-again');
    const none = phone(5, refresh);
    (none.status as jest.Mock).mockResolvedValue({ state: 'disconnected' });
    expect(await fresh(none)).toBe('skipped');
    const locked = phone(5, refresh);
    (locked.status as jest.Mock).mockRejectedValue({ code: 'secure-storage' });
    expect(await fresh(locked)).toBe('skipped');
    expect(refresh).not.toHaveBeenCalled();
    expect(await fresh(phone(5))).toBe('skipped');
  });

  it('runs when the app opens and comes back to the front, once at a time', async () => {
    let resolve!: () => void;
    const refresh = jest.fn(
      () =>
        new Promise<PairingStatus>(done => {
          resolve = () => done(paired);
        }),
    );
    const native = phone(5, refresh);
    let onChange!: (state: string) => void;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (s: string) => void,
    ) => {
      onChange = handler;
      return { remove };
    }) as never);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const onPairAgain = jest.fn();
    let tree!: Renderer.ReactTestRenderer;
    await act(async () => {
      tree = Renderer.create(
        <KeepPairingFresh native={native} onPairAgain={onPairAgain} />,
      );
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Still running: coming to the front again doesn't start another.
    await act(async () => onChange('active'));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    await act(async () => onChange('background'));
    await act(async () => onChange('active'));
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => resolve());
    expect(onPairAgain).not.toHaveBeenCalled();
    // Refused: the app is told to read the pairing again.
    refresh.mockImplementationOnce(async () => {
      throw { code: 'unauthorized' };
    });
    await act(async () => onChange('active'));
    expect(onPairAgain).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
    expect(remove).toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('Your Mac says to pair again when the Mac no longer accepts this phone', async () => {
    const native = nativeMock();
    (native.check as jest.Mock).mockRejectedValue({ code: 'unauthorized' });
    const { tree } = await render(native);
    expect(text(tree)).toContain('Pair this phone with your Mac again.');
    expect(text(tree)).not.toContain('same Wi-Fi');
    await act(async () => tree.unmount());
  });
});

it('Your Mac waits its turn behind a refresh instead of saying it can’t reach the Mac', async () => {
  const {
    RequestGateProvider,
    useRequestGate,
  } = require('../src/screens/requestGate');
  const native = nativeMock();
  let finishRefresh!: () => void;
  // A refresh already running in the app's queue.
  function Refreshing() {
    const gate = useRequestGate();
    React.useEffect(() => {
      gate(
        () =>
          new Promise<void>(done => {
            finishRefresh = done;
          }),
      );
    }, [gate]);
    return null;
  }
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <RequestGateProvider>
        <Refreshing />
        <FindYourMacScreen native={native} onDone={jest.fn()} />
      </RequestGateProvider>,
    );
  });
  expect(native.check).not.toHaveBeenCalled();
  expect(text(tree)).toContain('Looking for your Mac…');
  await act(async () => finishRefresh());
  expect(native.check).toHaveBeenCalledTimes(1);
  expect(text(tree)).toContain('Connected');
  await act(async () => tree.unmount());
});

it('a pairing still waiting its turn never starts once Find your Mac has closed', async () => {
  const {
    RequestGateProvider,
    useRequestGate,
  } = require('../src/screens/requestGate');
  const native = nativeMock();
  (native.status as jest.Mock).mockResolvedValue({ state: 'disconnected' });
  let finishRefresh!: () => void;
  function Refreshing() {
    const gate = useRequestGate();
    React.useEffect(() => {
      gate(
        () =>
          new Promise<void>(done => {
            finishRefresh = done;
          }),
      );
    }, [gate]);
    return null;
  }
  const app = (showing: boolean) => (
    <RequestGateProvider>
      <Refreshing />
      {showing ? (
        <FindYourMacScreen native={native} onDone={jest.fn()} />
      ) : null}
    </RequestGateProvider>
  );
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(app(true));
  });
  await scanned(tree, qrLink());
  // Closed while the code waits behind the refresh.
  await act(async () => tree.update(app(false)));
  await act(async () => finishRefresh());
  expect(native.pair).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});
