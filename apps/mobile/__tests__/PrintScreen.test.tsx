import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Image, Linking, Text, TextInput } from 'react-native';
import { HANDOFF_POLL_MS, MAX_POLL_FAILURES, PrintScreen, RECHECK_MS } from '../src/screens/PrintScreen';
import {
  sessionPrinterChoice,
  storedHandoffMemory,
  type PrinterHandoff,
} from '../src/printing/printerHandoff';
import type { ScanServices } from '../src/screens/scanServices';
import {
  fakeScanServices,
  syntheticJob,
  syntheticTarget,
} from '../src/screens/testing/fakeScanServices';
import {
  HANDOFF_ID,
  MODEL_QUESTION,
  fakePrinting,
  syntheticConfirmation,
} from '../src/screens/testing/fakePrinterHandoff';

type Tree = Renderer.ReactTestRenderer;
const texts = (tree: Tree) =>
  [
    ...tree.root.findAllByType(Text).map(t => [t.props.children].flat().join('')),
    ...tree.root
      .findAll(n => String(n.type) === 'STMActionButton')
      .map(n => n.props.buttonTitle),
  ].join('\n');
const find = (tree: Tree, role: string, name: string) =>
  tree.root.findAll(
    n =>
      (n.props.accessibilityRole === role ||
        (role === 'button' && String(n.type) === 'STMActionButton')) &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) === name &&
      typeof n.props.onPress === 'function',
    { deep: false },
  );
async function press(tree: Tree, name: string, role = 'button') {
  const [match] = find(tree, role, name);
  if (!match) throw Error(`No ${role} ${name}\n${texts(tree)}`);
  await act(async () => {
    match.props.onPress();
  });
}
const disabled = (tree: Tree, name: string) => !!find(tree, 'button', name)[0]?.props.disabled;
async function tick(ms = HANDOFF_POLL_MS) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

async function render(
  client?: PrinterHandoff,
  shared?: ScanServices,
  job: ReturnType<typeof syntheticJob> | null = syntheticJob('succeeded'),
) {
  const services = shared ?? fakeScanServices().services;
  if (client) services.printing = client;
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <PrintScreen
        target={syntheticTarget()}
        job={job}
        services={services}
        onBack={() => {}}
        onCompanion={() => {}}
      />,
    );
  });
  return tree;
}
beforeEach(() =>
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }),
);
afterEach(() => jest.useRealTimers());

test('without the companion route the screen says printing is not available yet', async () => {
  const tree = await render();
  expect(texts(tree)).toContain('Not available yet');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('Send to printer sends the verified cleaned-up model and starts printing', async () => {
  const { services, calls: scanCalls } = fakeScanServices();
  const { client, calls } = fakePrinting();
  const tree = await render(client, services);
  expect(texts(tree)).toContain('Bambu Lab printer');
  await press(tree, 'Send to printer');
  expect(scanCalls).toContain('download repaired.stl');
  expect(calls).toEqual([
    'backends',
    'bundles',
    'create bambu-printer-mcp "" model/stl',
    `print ${HANDOFF_ID}`,
  ]);
  expect(texts(tree)).toContain('Preparing your print…');
  expect(find(tree, 'button', 'Cancel print')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('the printer’s confirmation shows its camera photo and needs the box ticked', async () => {
  const snapshot = { mediaType: 'image/jpeg' as const, base64: '/9j/4AAQ' };
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }, { printing: true }, { status: 'printed', printing: false }],
    confirmations: [[syntheticConfirmation({ cameraSnapshot: snapshot })], []],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  let shown = texts(tree);
  expect(shown).toContain('YOUR PRINTER IS ASKING');
  expect(shown).toContain('Check that the bed is clear, then confirm the print.');
  expect(shown).toContain('Answer within about 10 min.');
  const [photo] = tree.root.findAllByType(Image);
  expect(photo!.props.source.uri).toBe('data:image/jpeg;base64,/9j/4AAQ');
  expect(disabled(tree, 'Approve')).toBe(true);
  await press(tree, 'I checked the printer and confirm this operation', 'checkbox');
  expect(disabled(tree, 'Approve')).toBe(false);
  await press(tree, 'Approve');
  expect(calls).toContain('answer q1 {"action":"accept","content":{"confirmed":true}}');
  expect(texts(tree)).not.toContain('YOUR PRINTER IS ASKING');
  await tick();
  await tick();
  shown = texts(tree);
  expect(shown).toContain('Sent to your printer.');
  expect(find(tree, 'button', 'Send again')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('Deny declines, and the reason the print stopped is shown', async () => {
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }, { status: 'failed', printing: false, failure: 'tool-failed' }],
    confirmations: [[syntheticConfirmation()]],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  await press(tree, 'Deny');
  expect(calls).toContain('answer q1 {"action":"decline"}');
  await tick();
  const shown = texts(tree);
  expect(shown).toContain('This didn’t reach your printer.');
  expect(shown).toContain('tool-failed');
  await press(tree, 'Start over');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a printer-model question is answered with the chosen model', async () => {
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }],
    confirmations: [[syntheticConfirmation({ id: 'q2', message: 'Which printer?', requestedSchema: MODEL_QUESTION })]],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  expect(disabled(tree, 'Approve')).toBe(true);
  await press(tree, 'X1 Carbon', 'radio');
  await press(tree, 'Approve');
  expect(calls).toContain('answer q2 {"action":"accept","content":{"bambu_model":"x1c"}}');
  await act(async () => tree.unmount());
});

test('a link question without a safe https link can only be denied', async () => {
  const { client } = fakePrinting({
    statuses: [{ printing: true }],
    confirmations: [[syntheticConfirmation({ mode: 'url', url: 'http://printer.local/auth', requestedSchema: undefined })]],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  expect(texts(tree)).toContain('This question needs an answer this app can’t give.');
  expect(find(tree, 'button', 'Approve')).toHaveLength(0);
  expect(find(tree, 'button', 'Open link')).toHaveLength(0);
  expect(find(tree, 'button', 'Deny')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a question that times out can’t be answered and says nothing was sent', async () => {
  const { client } = fakePrinting({
    statuses: [{ printing: true }],
    confirmations: [[syntheticConfirmation({ expiresAtMs: Date.now() + 60000 })]],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  expect(texts(tree)).toContain('Answer within about 1 min.');
  await tick(60000);
  expect(texts(tree)).toContain('This question timed out. Nothing was sent to your printer.');
  expect(disabled(tree, 'Deny')).toBe(true);
  await act(async () => tree.unmount());
});

test('Cancel print answers waiting questions with cancel, then stops the job', async () => {
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }, { status: 'failed', printing: false, failure: 'cancelled' }],
    confirmations: [[syntheticConfirmation()]],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  await press(tree, 'Cancel print');
  expect(calls.slice(-2)).toEqual([
    'answer q1 {"action":"cancel"}',
    `cancel ${HANDOFF_ID}`,
  ]);
  await tick(0);
  const shown = texts(tree);
  expect(shown).toContain('You cancelled this print.');
  expect(shown).not.toContain('YOUR PRINTER IS ASKING');
  await act(async () => tree.unmount());
});

test('a companion that can’t stop a job says it will still ask first', async () => {
  const { client } = fakePrinting({ statuses: [{ printing: true }], cancel: false });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await press(tree, 'Cancel print');
  expect(texts(tree)).toContain('It still asks here before anything prints, so you can deny it then.');
  await act(async () => tree.unmount());
});

test('a cancel that couldn’t reach a question says so and keeps it to deny', async () => {
  const { client } = fakePrinting({
    statuses: [{ printing: true }],
    confirmations: [[syntheticConfirmation()]],
    cancel: false,
  });
  client.answer = async () => {
    throw Object.assign(Error('Couldn’t reach your companion.'), { code: 'network' });
  };
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  await press(tree, 'Cancel print');
  const shown = texts(tree);
  expect(shown).toContain('Some of your printer’s questions couldn’t be cancelled.');
  expect(shown).not.toContain('Nothing was sent to your printer.');
  expect(shown).toContain('YOUR PRINTER IS ASKING');
  await act(async () => tree.unmount());
});

test('a request waits for an agent, and the result is printed on demand', async () => {
  const { client, calls } = fakePrinting({ statuses: [{ status: 'claimed' }, { status: 'designed' }] });
  const tree = await render(client);
  const [input] = tree.root.findAllByType(TextInput);
  await act(async () => {
    input!.props.onChangeText('Add a flat base');
  });
  await press(tree, 'Send with request');
  expect(calls).toContain('create bambu-printer-mcp "Add a flat base" model/stl');
  expect(calls).not.toContain(`print ${HANDOFF_ID}`);
  expect(texts(tree)).toContain('Waiting for an agent on your computer.');
  expect(find(tree, 'button', 'Print without changes')).toHaveLength(1);
  await tick();
  expect(texts(tree)).toContain('An agent on your computer is working on your request.');
  await tick();
  expect(texts(tree)).toContain('The change is ready to print.');
  await press(tree, 'Print it');
  expect(calls).toContain(`print ${HANDOFF_ID}`);
  expect(texts(tree)).toContain('Preparing your print…');
  await act(async () => tree.unmount());
});

test('the printer software choice is sent and remembered for next time', async () => {
  const { services } = fakeScanServices();
  services.printerChoice = sessionPrinterChoice();
  const both = [{ backend: 'bambu-printer-mcp' as const }, { backend: 'mcp-3d-printer-server' as const }];
  const first = fakePrinting({ backends: both });
  const tree = await render(first.client, services);
  expect(texts(tree)).toContain('This phone remembers your choice for next time.');
  await press(tree, 'Other 3D printers', 'radio');
  await press(tree, 'Send to printer');
  expect(first.calls).toContain('create mcp-3d-printer-server "" model/stl');
  await act(async () => tree.unmount());
  await services.handoffs.save(syntheticTarget().projectId, syntheticTarget().capture.captureId, null);

  const second = fakePrinting({ backends: both });
  const later = await render(second.client, services);
  const [chosen] = find(later, 'radio', 'Other 3D printers');
  expect(chosen!.props.accessibilityState.checked).toBe(true);
  await act(async () => later.unmount());
});

test('a companion that doesn’t list printers picks its own', async () => {
  const { client, calls } = fakePrinting({ backends: null });
  const tree = await render(client);
  expect(texts(tree)).toContain('Your companion’s printer software');
  await press(tree, 'Send to printer');
  expect(calls).toContain('create companion "" model/stl');
  await act(async () => tree.unmount());
});

test('without a finished scan check there is nothing to send', async () => {
  const { client } = fakePrinting();
  const tree = await render(client, undefined, null);
  expect(texts(tree)).toContain('Check your scan first');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a failed status check is retried and the job’s final state still shows', async () => {
  const dropped = Object.assign(Error('The companion took too long.'), { code: 'timeout' });
  const { client, calls } = fakePrinting({ statuses: [dropped, { status: 'printed', printing: false }] });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  expect(texts(tree)).toContain('Couldn’t reach your companion. Trying again…');
  await tick(HANDOFF_POLL_MS * 2);
  const shown = texts(tree);
  expect(shown).toContain('Sent to your printer.');
  expect(shown).not.toContain('Trying again');
  expect(calls.filter(c => c.startsWith('status'))).toHaveLength(2);
  await act(async () => tree.unmount());
});

test('repeated failed checks stop and offer to check again', async () => {
  const dropped = () => Object.assign(Error('Couldn’t reach your companion.'), { code: 'network' });
  const { client, calls } = fakePrinting({
    statuses: [...Array.from({ length: MAX_POLL_FAILURES }, dropped), { status: 'printed', printing: false }],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  for (let attempt = 0; attempt < MAX_POLL_FAILURES; attempt++) await tick(HANDOFF_POLL_MS * 2 ** attempt);
  expect(texts(tree)).toContain('Lost touch with your companion');
  await tick(HANDOFF_POLL_MS * 20);
  expect(calls.filter(c => c.startsWith('status'))).toHaveLength(MAX_POLL_FAILURES);
  await press(tree, 'Check again');
  await tick(0);
  expect(texts(tree)).toContain('Sent to your printer.');
  await act(async () => tree.unmount());
});

test('leaving and reopening reattaches to the sent job instead of sending again', async () => {
  const { services } = fakeScanServices();
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }, { printing: true }, { status: 'printed', printing: false }],
  });
  const first = await render(client, services);
  await press(first, 'Send to printer');
  await act(async () => first.unmount());

  const reopened = await render(client, services);
  expect(texts(reopened)).toContain('Preparing your print…');
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(0);
  expect(calls.filter(c => c.startsWith('create'))).toHaveLength(1);
  await tick();
  await tick();
  expect(texts(reopened)).toContain('Sent to your printer.');
  await press(reopened, 'Send again');
  await act(async () => reopened.unmount());

  const later = await render(client, services);
  expect(find(later, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => later.unmount());
});

test('nothing is sent when this phone can’t first record the send', async () => {
  const { services } = fakeScanServices();
  services.handoffs = storedHandoffMemory({
    read: async () => null,
    write: async () => {
      throw Object.assign(Error('Storage is full.'), { code: 'storage-error' });
    },
  });
  const { client, calls } = fakePrinting();
  const tree = await render(client, services);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('This phone couldn’t save your send, so nothing was sent.');
  expect(calls.some(c => c.startsWith('create'))).toBe(false);
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => tree.unmount());
});

const lostReply = () =>
  Object.assign(Error('The companion response was interrupted.'), { code: 'network' });

test('a send whose reply was lost finds the job on the companion instead of sending again', async () => {
  const { services } = fakeScanServices();
  const { client, calls } = fakePrinting({
    found: { id: HANDOFF_ID, backend: 'bambu-printer-mcp', status: 'ready', printing: true },
  });
  client.create = async () => {
    calls.push('create (reply lost)');
    throw lostReply();
  };
  const tree = await render(client, services);
  await press(tree, 'Send to printer');
  expect(calls).toEqual(['backends', 'bundles', 'create (reply lost)', 'find "" bambu-printer-mcp']);
  expect(texts(tree)).toContain('Preparing your print…');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
  const reopened = await render(client, services);
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(0);
  expect(calls.filter(c => c.startsWith('create'))).toHaveLength(1);
  await act(async () => reopened.unmount());
});

test('an unconfirmed send blocks sending until the companion is checked, even after reopening', async () => {
  const { services } = fakeScanServices();
  const offline = fakePrinting({ found: lostReply() });
  offline.client.create = async () => {
    throw lostReply();
  };
  const tree = await render(offline.client, services);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('Couldn’t confirm your send');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());

  // Reopened while the companion answers: the job isn't there.
  const online = fakePrinting({ found: null });
  const reopened = await render(online.client, services);
  expect(online.calls).toContain('find "" bambu-printer-mcp');
  // Just sent, so it is looked for again before saying nothing was sent.
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(0);
  await tick(RECHECK_MS);
  await tick(RECHECK_MS);
  expect(online.calls.filter(c => c.startsWith('find'))).toHaveLength(3);
  expect(texts(reopened)).toContain('Your job didn’t reach your companion, so nothing was sent.');
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => reopened.unmount());
});

test('a send cut off by the app closing is checked on the companion when it reopens', async () => {
  const { services } = fakeScanServices();
  const { client, calls } = fakePrinting({
    found: { id: HANDOFF_ID, backend: 'bambu-printer-mcp', status: 'ready' },
  });
  client.create = () => new Promise(() => {});
  const first = await render(client, services);
  await press(first, 'Send to printer');
  await act(async () => first.unmount());
  const reopened = await render(client, services);
  expect(calls).toContain('find "" bambu-printer-mcp');
  expect(texts(reopened)).toContain('Ready to print.');
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => reopened.unmount());
});

test('Send anyway is the person’s explicit choice after an unconfirmed send', async () => {
  const { client } = fakePrinting({ found: lostReply() });
  client.create = async () => {
    throw lostReply();
  };
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await press(tree, 'Send anyway');
  expect(texts(tree)).not.toContain('Couldn’t confirm your send');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a send the companion refused can be sent again straight away', async () => {
  const { client, calls } = fakePrinting();
  client.create = async () => {
    throw Object.assign(Error('Your companion is already printing another job.'), { status: 409 });
  };
  const tree = await render(client);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('Your companion is already printing another job.');
  expect(calls.some(c => c.startsWith('find'))).toBe(false);
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a job whose ID this phone couldn’t store still reattaches in this session', async () => {
  const { services } = fakeScanServices();
  let writes = 0;
  services.handoffs = storedHandoffMemory({
    read: async () => null,
    // The record before sending is saved; saving the job's ID fails.
    write: async () => {
      if (writes++ > 0) {
        throw Object.assign(Error('Storage is full.'), { code: 'storage-error' });
      }
    },
  });
  const { client, calls } = fakePrinting({ statuses: [{ printing: true }] });
  const first = await render(client, services);
  await press(first, 'Send to printer');
  expect(texts(first)).toContain('couldn’t save the job for after a restart');
  await act(async () => first.unmount());
  const reopened = await render(client, services);
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(0);
  expect(calls.filter(c => c.startsWith('create'))).toHaveLength(1);
  await act(async () => reopened.unmount());
});

test('a job cleared while this phone can’t store it stays cleared', async () => {
  const stored: Record<string, string> = {};
  let writable = true;
  const memory = storedHandoffMemory({
    read: async key => stored[key] ?? null,
    write: async (key, body) => {
      if (!writable) throw Object.assign(Error('Storage is full.'), { code: 'storage-error' });
      stored[key] = body;
    },
  });
  await memory.save('p', 'c', { handoffId: 'h1' });
  writable = false;
  await expect(memory.save('p', 'c', null)).rejects.toThrow('Storage is full.');
  expect(await memory.load('p', 'c')).toBeNull();
  // A fresh session (after a relaunch) reads what the device kept.
  const relaunched = storedHandoffMemory({ read: async key => stored[key] ?? null, write: async () => {} });
  expect(await relaunched.load('p', 'c')).toEqual({ handoffId: 'h1' });
});

test('a remembered job the companion no longer has is forgotten', async () => {
  const { services } = fakeScanServices();
  const target = syntheticTarget();
  await services.handoffs.save(target.projectId, target.capture.captureId, { handoffId: 'gone' });
  const { client } = fakePrinting();
  client.status = async () => {
    throw Object.assign(Error('Not found'), { status: 404 });
  };
  const tree = await render(client, services);
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  expect(await services.handoffs.load(target.projectId, target.capture.captureId)).toBeNull();
  await act(async () => tree.unmount());
});

test('a lost companion connection asks to connect, and Try again recovers', async () => {
  const { client } = fakePrinting();
  const backends = client.backends;
  let rejected = false;
  client.backends = async ack => {
    if (!rejected) {
      rejected = true;
      throw Object.assign(Error('Your companion connection expired.'), { status: 401 });
    }
    return backends(ack);
  };
  const tree = await render(client);
  expect(texts(tree)).toContain('Connect your companion');
  expect(find(tree, 'button', 'Connect companion')).toHaveLength(1);
  await press(tree, 'Try again');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a companion without printer handoff, or a pairing without its scope, says so up front', async () => {
  const old = fakePrinting();
  old.client.backends = async () => {
    throw Object.assign(Error('Update it'), { code: 'not-available', status: 404 });
  };
  let tree = await render(old.client);
  expect(texts(tree)).toContain('Not available yet');
  await act(async () => tree.unmount());

  const capturesOnly = fakePrinting();
  capturesOnly.client.backends = async () => {
    throw Object.assign(Error('Connect to your companion with a printer invitation.'), { code: 'scope-denied' });
  };
  tree = await render(capturesOnly.client);
  expect(texts(tree)).toContain('Connect to your companion with a printer invitation.');
  expect(find(tree, 'button', 'Connect companion')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('no configured printer says what to set up', async () => {
  const { client } = fakePrinting({ backends: [] });
  const tree = await render(client);
  expect(texts(tree)).toContain('No printer set up');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a job the printer software may have started says to check the printer, with no retry', async () => {
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }, { status: 'uncertain', printing: false, failure: 'dispatch-uncertain' }],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  await tick();
  const shown = texts(tree);
  expect(shown).toContain('Check your printer.');
  expect(shown).toContain('It won’t be sent again from here.');
  expect(shown).not.toContain('dispatch-uncertain');
  for (const name of ['Send again', 'Start over', 'Print it', 'Send to printer', 'Cancel print']) {
    expect(find(tree, 'button', name)).toHaveLength(0);
  }
  // Finished: no more checks.
  const checks = calls.filter(c => c.startsWith('status')).length;
  await tick();
  expect(calls.filter(c => c.startsWith('status'))).toHaveLength(checks);
  await act(async () => tree.unmount());
});

test('a refused print of a job that may have started checks it again instead of offering a retry', async () => {
  const { client, calls } = fakePrinting({
    statuses: [{ status: 'uncertain', printing: false, failure: 'dispatch-uncertain' }],
  });
  client.print = async id => {
    calls.push(`print ${id}`);
    throw Object.assign(Error('Check your printer.'), { code: 'dispatch-uncertain', status: 409 });
  };
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick(0);
  expect(calls.filter(c => c.startsWith('print'))).toHaveLength(1);
  expect(texts(tree)).toContain('Check your printer.');
  expect(find(tree, 'button', 'Print it')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a lost reply to the print request doesn’t offer Print it until the companion says so', async () => {
  const { client, calls } = fakePrinting({ statuses: [{ printing: false }] });
  client.print = async id => {
    calls.push(`print ${id}`);
    throw lostReply();
  };
  const tree = await render(client);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('Preparing your print…');
  expect(find(tree, 'button', 'Print it')).toHaveLength(0);
  await tick(0);
  // The companion says it never started, so printing is offered again.
  expect(calls).toContain(`status ${HANDOFF_ID}`);
  expect(find(tree, 'button', 'Print it')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a question stays answerable when the phone’s clock is eleven minutes ahead of the companion', async () => {
  const companionNow = Date.now() - 11 * 60000;
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }],
    confirmations: [[syntheticConfirmation({ createdAtMs: companionNow, expiresAtMs: companionNow + 10 * 60000 })]],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  expect(texts(tree)).toContain('Answer within about 10 min.');
  expect(disabled(tree, 'Deny')).toBe(false);
  await press(tree, 'I checked the printer and confirm this operation', 'checkbox');
  await press(tree, 'Approve');
  expect(calls).toContain('answer q1 {"action":"accept","content":{"confirmed":true}}');
  await act(async () => tree.unmount());
});

test('two quick taps send one answer', async () => {
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }],
    confirmations: [[syntheticConfirmation()]],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  const [deny] = find(tree, 'button', 'Deny');
  await act(async () => {
    deny!.props.onPress();
    deny!.props.onPress();
  });
  expect(calls.filter(c => c.startsWith('answer'))).toEqual(['answer q1 {"action":"decline"}']);
  await act(async () => tree.unmount());
});

test('a link question is accepted only once the link has opened', async () => {
  const open = jest.spyOn(Linking, 'openURL');
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }],
    confirmations: [[syntheticConfirmation({ mode: 'url', url: 'https://printer.example/auth', requestedSchema: undefined })]],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  open.mockRejectedValueOnce(Error('no handler'));
  await press(tree, 'Open link');
  expect(calls.filter(c => c.startsWith('answer'))).toHaveLength(0);
  expect(texts(tree)).toContain('The link didn’t open.');
  open.mockResolvedValueOnce(undefined);
  await press(tree, 'Open link');
  expect(calls).toContain('answer q1 {"action":"accept","content":{}}');
  open.mockRestore();
  await act(async () => tree.unmount());
});

test('a send records the jobs already on the companion, and recovery is limited to new ones', async () => {
  const { services } = fakeScanServices();
  const { client, calls } = fakePrinting({ bundleIds: ['earlier-job'], found: null });
  let looked: unknown;
  client.create = async () => {
    calls.push('create (reply lost)');
    throw lostReply();
  };
  const find0 = client.find;
  client.find = async (...args) => {
    looked = args[3];
    return find0(...args);
  };
  const tree = await render(client, services);
  await press(tree, 'Send to printer');
  expect(looked).toMatchObject({ before: ['earlier-job'] });
  await tick(RECHECK_MS);
  await tick(RECHECK_MS);
  expect(texts(tree)).toContain('nothing was sent');
  await act(async () => tree.unmount());
});

test('while one question’s answer is on its way, the other questions wait too', async () => {
  const { client, calls } = fakePrinting({
    statuses: [{ printing: true }],
    confirmations: [[syntheticConfirmation(), syntheticConfirmation({ id: 'q2', message: 'Second question.' })]],
  });
  let reply!: () => void;
  client.answer = async id => {
    calls.push(`answer ${id}`);
    await new Promise<void>(r => (reply = r));
  };
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  const denies = () => find(tree, 'button', 'Deny');
  expect(denies()).toHaveLength(2);
  await act(async () => {
    denies()[0]!.props.onPress();
  });
  expect(denies().every(b => b.props.disabled)).toBe(true);
  await act(async () => reply());
  expect(denies()).toHaveLength(1);
  expect(denies()[0]!.props.disabled).toBe(false);
  expect(calls.filter(c => c.startsWith('answer'))).toEqual(['answer q1']);
  await act(async () => tree.unmount());
});

// Muse on #132: the companion marks a job uncertain just before it calls the
// printer software, whose own confirmation is asked during that call.
test('an uncertain job that is still printing keeps its questions and keeps being checked', async () => {
  const { client, calls } = fakePrinting({
    statuses: [
      { status: 'uncertain', failure: 'dispatch-uncertain', printing: true },
      { status: 'uncertain', failure: 'dispatch-uncertain', printing: true },
      { status: 'printed', printing: false },
    ],
    confirmations: [[syntheticConfirmation()], []],
  });
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await tick();
  expect(texts(tree)).toContain('YOUR PRINTER IS ASKING');
  expect(texts(tree)).not.toContain('Check your printer.');
  expect(find(tree, 'button', 'Cancel print')).toHaveLength(1);
  await press(tree, 'I checked the printer and confirm this operation', 'checkbox');
  await press(tree, 'Approve');
  expect(calls).toContain('answer q1 {"action":"accept","content":{"confirmed":true}}');
  await tick();
  await tick();
  expect(texts(tree)).toContain('Sent to your printer.');
  await act(async () => tree.unmount());
});

test('two quick taps on Send to printer send once', async () => {
  const { client, calls } = fakePrinting();
  const tree = await render(client);
  const [sendButton] = find(tree, 'button', 'Send to printer');
  await act(async () => {
    sendButton!.props.onPress();
    sendButton!.props.onPress();
  });
  expect(calls.filter(c => c.startsWith('create'))).toHaveLength(1);
  expect(calls.filter(c => c.startsWith('print'))).toHaveLength(1);
  await act(async () => tree.unmount());
});
