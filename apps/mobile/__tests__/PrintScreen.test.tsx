import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import {
  HANDOFF_POLL_MS,
  MAX_POLL_FAILURES,
  PrintScreen,
} from '../src/screens/PrintScreen';
import {
  storedHandoffMemory,
  type Handoff,
  type PrinterHandoff,
  type PrinterOption,
} from '../src/printing/printerHandoff';
import type { ScanServices } from '../src/screens/scanServices';
import {
  fakeScanServices,
  syntheticTarget,
} from '../src/screens/testing/fakeScanServices';

type Tree = Renderer.ReactTestRenderer;
const texts = (tree: Tree) =>
  [
    ...tree.root
      .findAllByType(Text)
      .map(t => [t.props.children].flat().join('')),
    ...tree.root
      .findAll(n => String(n.type) === 'STMActionButton')
      .map(n => n.props.buttonTitle),
  ].join('\n');
const find = (tree: Tree, role: string, name: string) =>
  tree.root.findAll(
    n =>
      n.props.accessibilityRole === role &&
      n.props.accessibilityLabel === name &&
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

// A status entry that is an Error makes that check fail, like a dropped connection.
function printing(
  options: PrinterOption[],
  statuses: (Handoff['status'] | Error)[] = [],
  failure?: string,
) {
  const calls: string[] = [];
  const queue = [...statuses];
  const client: PrinterHandoff = {
    backends: async () => {
      calls.push('backends');
      return options;
    },
    create: async (_p, _c, _a, request) => {
      calls.push(`create ${request.backend} "${request.prompt}"`);
      return { id: 'h1', backend: request.backend, status: 'ready' };
    },
    find: async (_p, _c, _a, request) => {
      calls.push(`find "${request.prompt}"`);
      return null;
    },
    status: async (_p, _c, _a, id) => {
      const status = queue.shift() ?? 'ready';
      calls.push(`status ${id}`);
      if (status instanceof Error) throw status;
      return {
        id,
        backend: 'bambu-printer-mcp',
        status,
        ...(status === 'failed' && failure ? { failure } : {}),
      };
    },
  };
  return { client, calls };
}
async function render(client?: PrinterHandoff, shared?: ScanServices) {
  const services = shared ?? fakeScanServices().services;
  if (client) services.printing = client;
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <PrintScreen
        target={syntheticTarget()}
        services={services}
        onBack={() => {}}
        onCompanion={() => {}}
      />,
    );
  });
  return tree;
}
afterEach(() => jest.useRealTimers());

test('without the companion route the screen says printing is not available yet', async () => {
  const tree = await render();
  expect(texts(tree)).toContain('Not available yet');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('one configured backend is named and used without a choice', async () => {
  const { client, calls } = printing([
    { backend: 'mcp-3d-printer-server', selection: { printerType: 'klipper' } },
  ]);
  const tree = await render(client);
  const shown = texts(tree);
  expect(shown).toContain('Other 3D printers');
  expect(shown).toContain('set up for klipper');
  expect(
    tree.root.findAll(n => n.props.accessibilityRole === 'radio'),
  ).toHaveLength(0);
  await press(tree, 'Send to printer');
  expect(calls).toContain('create mcp-3d-printer-server "Print a copy."');
  await act(async () => tree.unmount());
});

test('with both backends the chosen printer and the prompt are sent', async () => {
  const { client, calls } = printing([
    { backend: 'bambu-printer-mcp' },
    { backend: 'mcp-3d-printer-server' },
  ]);
  const tree = await render(client);
  const radios = () =>
    tree.root
      .findAll(
        n =>
          n.props.accessibilityRole === 'radio' &&
          typeof n.props.onPress === 'function',
        { deep: false },
      )
      .map(n => [
        n.props.accessibilityLabel,
        n.props.accessibilityState.checked,
      ]);
  expect(radios()).toEqual([
    ['Bambu Lab printer', true],
    ['Other 3D printers', false],
  ]);
  await press(tree, 'Other 3D printers', 'radio');
  expect(radios()).toEqual([
    ['Bambu Lab printer', false],
    ['Other 3D printers', true],
  ]);
  await act(async () => {
    tree.root
      .find(
        n =>
          n.type === TextInput &&
          n.props.accessibilityLabel === 'What should your printer make?',
      )
      .props.onChangeText('  A stand that holds it upright ');
  });
  await press(tree, 'Send to printer');
  expect(calls).toContain(
    'create mcp-3d-printer-server "A stand that holds it upright"',
  );
  await act(async () => tree.unmount());
});

test('a sent job is followed until it reaches the printer', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  const { client, calls } = printing(
    [{ backend: 'bambu-printer-mcp' }],
    ['claimed', 'sliced', 'printed'],
  );
  const tree = await render(client);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('Waiting for the agent on your computer');
  for (const expected of [
    'The agent on your computer is working on it.',
    'Sliced and ready for your printer.',
    'Sent to your printer.',
  ]) {
    await act(async () => {
      jest.advanceTimersByTime(HANDOFF_POLL_MS);
    });
    expect(texts(tree)).toContain(expected);
  }
  await act(async () => {
    jest.advanceTimersByTime(HANDOFF_POLL_MS * 3);
  });
  expect(calls.filter(c => c.startsWith('status'))).toHaveLength(3);
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a failed job shows the reason and can start over', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  const { client } = printing(
    [{ backend: 'bambu-printer-mcp' }],
    ['failed'],
    'Slicing failed: no build plate selected.',
  );
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await act(async () => {
    jest.advanceTimersByTime(HANDOFF_POLL_MS);
  });
  const shown = texts(tree);
  expect(shown).toContain('This didn’t reach your printer.');
  expect(shown).toContain('Slicing failed: no build plate selected.');
  await press(tree, 'Start over');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a failed status check is retried and the job’s final state still shows', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  const dropped = Object.assign(Error('The companion took too long.'), {
    code: 'timeout',
  });
  const { client, calls } = printing(
    [{ backend: 'bambu-printer-mcp' }],
    [dropped, 'printed'],
  );
  const tree = await render(client);
  await press(tree, 'Send to printer');
  await act(async () => {
    jest.advanceTimersByTime(HANDOFF_POLL_MS);
  });
  expect(texts(tree)).toContain('Couldn’t reach your companion. Trying again…');
  // The retry waits twice as long after a failure.
  await act(async () => {
    jest.advanceTimersByTime(HANDOFF_POLL_MS * 2);
  });
  const shown = texts(tree);
  expect(shown).toContain('Sent to your printer.');
  expect(shown).not.toContain('Trying again');
  expect(calls.filter(c => c.startsWith('status'))).toHaveLength(2);
  await act(async () => tree.unmount());
});

test('repeated failed checks stop and offer to check again', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  const dropped = () =>
    Object.assign(Error('Couldn’t reach your companion.'), { code: 'network' });
  const { client, calls } = printing(
    [{ backend: 'bambu-printer-mcp' }],
    [...Array.from({ length: MAX_POLL_FAILURES }, dropped), 'printed'],
  );
  const tree = await render(client);
  await press(tree, 'Send to printer');
  for (let attempt = 0; attempt < MAX_POLL_FAILURES; attempt++) {
    await act(async () => {
      jest.advanceTimersByTime(HANDOFF_POLL_MS * 2 ** attempt);
    });
  }
  expect(texts(tree)).toContain('Lost touch with your companion');
  // Stopped: no more checks until the user asks.
  await act(async () => {
    jest.advanceTimersByTime(HANDOFF_POLL_MS * 20);
  });
  expect(calls.filter(c => c.startsWith('status'))).toHaveLength(
    MAX_POLL_FAILURES,
  );
  await press(tree, 'Check again');
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  const shown = texts(tree);
  expect(shown).toContain('Sent to your printer.');
  expect(shown).not.toContain('Lost touch with your companion');
  await act(async () => tree.unmount());
});

test('leaving and reopening reattaches to the sent job instead of sending again', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  const { services } = fakeScanServices();
  const { client, calls } = printing(
    [{ backend: 'bambu-printer-mcp' }],
    ['claimed', 'claimed', 'printed'],
  );
  const first = await render(client, services);
  await press(first, 'Send to printer');
  await act(async () => first.unmount());

  const reopened = await render(client, services);
  let shown = texts(reopened);
  expect(shown).toContain('The agent on your computer is working on it.');
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(0);
  expect(calls.filter(c => c.startsWith('create'))).toHaveLength(1);
  // Polling carries on from the reattached job.
  for (let check = 0; check < 2; check++) {
    await act(async () => {
      jest.advanceTimersByTime(HANDOFF_POLL_MS);
    });
  }
  shown = texts(reopened);
  expect(shown).toContain('Sent to your printer.');
  await press(reopened, 'Send again');
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => reopened.unmount());

  // Starting over forgets the job, so the next visit offers a new send.
  const later = await render(client, services);
  expect(find(later, 'button', 'Send to printer')).toHaveLength(1);
  expect(calls.filter(c => c.startsWith('status'))).toHaveLength(3);
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
  const { client, calls } = printing([{ backend: 'bambu-printer-mcp' }]);
  const tree = await render(client, services);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('This phone couldn’t save your send, so nothing was sent.');
  expect(calls.some(c => c.startsWith('create'))).toBe(false);
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
  const { client, calls } = printing([{ backend: 'bambu-printer-mcp' }], ['claimed']);
  const first = await render(client, services);
  await press(first, 'Send to printer');
  expect(texts(first)).toContain('couldn’t save the job for after a restart');
  await act(async () => first.unmount());
  const reopened = await render(client, services);
  expect(texts(reopened)).toContain('The agent on your computer is working on it.');
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

const lostReply = () =>
  Object.assign(Error('The companion response was interrupted.'), {
    code: 'network',
  });

test('a send whose reply was lost finds the job on the companion instead of sending again', async () => {
  const { services } = fakeScanServices();
  const { client, calls } = printing([{ backend: 'bambu-printer-mcp' }], ['claimed']);
  client.create = async () => {
    calls.push('create (reply lost)');
    throw lostReply();
  };
  client.find = async (_p, _c, _a, request) => {
    calls.push(`find "${request.prompt}" ${request.backend}`);
    return { id: 'h1', backend: 'bambu-printer-mcp', status: 'ready' };
  };
  const tree = await render(client, services);
  await press(tree, 'Send to printer');
  expect(calls).toEqual([
    'backends',
    'create (reply lost)',
    'find "Print a copy." bambu-printer-mcp',
  ]);
  expect(texts(tree)).toContain('Waiting for the agent on your computer');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
  // Reopening reattaches to the job that was found.
  const reopened = await render(client, services);
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(0);
  expect(calls.filter(c => c.startsWith('create'))).toHaveLength(1);
  await act(async () => reopened.unmount());
});

test('an unconfirmed send blocks sending until the companion is checked, even after reopening', async () => {
  const { services } = fakeScanServices();
  const { client, calls } = printing([{ backend: 'bambu-printer-mcp' }]);
  client.create = async () => {
    throw lostReply();
  };
  let reachable = false;
  client.find = async () => {
    calls.push('find');
    if (!reachable) throw lostReply();
    return null;
  };
  const tree = await render(client, services);
  await press(tree, 'Send to printer');
  let shown = texts(tree);
  expect(shown).toContain('Couldn’t confirm your send');
  expect(shown).toContain('The job may already be on your companion.');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());

  // Still unconfirmed after reopening; this time the companion answers.
  reachable = true;
  const reopened = await render(client, services);
  shown = texts(reopened);
  expect(shown).toContain('Your job didn’t reach your companion, so nothing was sent.');
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(1);
  expect(calls.filter(c => c === 'find')).toHaveLength(2);
  await act(async () => reopened.unmount());
});

test('a send cut off by the app closing is checked on the companion when it reopens', async () => {
  const { services } = fakeScanServices();
  const { client, calls } = printing([{ backend: 'bambu-printer-mcp' }], ['claimed']);
  // The request is in flight when the screen goes away.
  client.create = () => new Promise(() => {});
  client.find = async (_p, _c, _a, request) => {
    calls.push(`find "${request.prompt}"`);
    return { id: 'h1', backend: 'bambu-printer-mcp', status: 'ready' };
  };
  const first = await render(client, services);
  await press(first, 'Send to printer');
  await act(async () => first.unmount());
  const reopened = await render(client, services);
  expect(calls).toContain('find "Print a copy."');
  expect(texts(reopened)).toContain('Waiting for the agent on your computer');
  expect(find(reopened, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => reopened.unmount());
});

test('Send anyway is the person’s explicit choice after an unconfirmed send', async () => {
  const { client } = printing([{ backend: 'bambu-printer-mcp' }]);
  client.create = async () => {
    throw lostReply();
  };
  client.find = async () => {
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
  const { client, calls } = printing([{ backend: 'bambu-printer-mcp' }]);
  client.create = async () => {
    throw Object.assign(Error('Your companion is busy. Try again shortly.'), { status: 429 });
  };
  const tree = await render(client);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('Your companion is busy. Try again shortly.');
  expect(calls.some(c => c.startsWith('find'))).toBe(false);
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a remembered job the companion no longer has is forgotten', async () => {
  const { services } = fakeScanServices();
  await services.handoffs.save(
    syntheticTarget().projectId,
    syntheticTarget().capture.captureId,
    { handoffId: 'gone' },
  );
  const { client } = printing([{ backend: 'bambu-printer-mcp' }]);
  client.status = async () => {
    throw Object.assign(Error('Not found'), { status: 404 });
  };
  const tree = await render(client, services);
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  expect(
    await services.handoffs.load(
      syntheticTarget().projectId,
      syntheticTarget().capture.captureId,
    ),
  ).toBeNull();
  await act(async () => tree.unmount());
});

test('a lost companion connection asks to connect, and Try again recovers', async () => {
  const { client, calls } = printing([{ backend: 'bambu-printer-mcp' }]);
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
  let shown = texts(tree);
  expect(shown).toContain('Connect your companion');
  expect(shown).toContain('Your companion connection expired.');
  expect(find(tree, 'button', 'Connect companion')).toHaveLength(1);
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await press(tree, 'Try again');
  shown = texts(tree);
  expect(shown).not.toContain('Connect your companion');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(1);
  expect(calls).toEqual(['backends']);
  await act(async () => tree.unmount());
});

test('no configured printer says what to set up', async () => {
  const { client } = printing([]);
  const tree = await render(client);
  expect(texts(tree)).toContain('No printer set up');
  expect(find(tree, 'button', 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});
