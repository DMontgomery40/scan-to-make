import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { PrintReviewScreen } from '../src/screens/PrintReviewScreen';
import {
  unavailablePrintReviewServices,
  type PrintReviewServices,
} from '../src/screens/printReviewServices';
import {
  DESIGN,
  failure,
  fakePrintServices,
  syntheticPrint,
  syntheticReport,
} from '../src/screens/testing/fakePrintReviewServices';
import { PROJECT_ID } from '../src/screens/testing/fakeScanServices';

type Tree = Renderer.ReactTestRenderer;
function texts(tree: Tree) {
  return [
    ...tree.root
      .findAllByType(Text)
      .map(t => [t.props.children].flat().join('')),
    ...tree.root
      .findAll(n => String(n.type) === 'STMActionButton')
      .map(n => n.props.buttonTitle),
  ].join('\n');
}
// Native buttons render a host element inside a same-named mock wrapper.
const buttons = (tree: Tree, name: string) =>
  tree.root.findAll(
    n =>
      n.props.accessibilityRole === 'button' &&
      n.props.accessibilityLabel === name &&
      typeof n.props.onPress === 'function',
    { deep: false },
  );
async function press(tree: Tree, name: string) {
  const [match] = buttons(tree, name);
  if (!match) throw Error(`No button ${name}\n${texts(tree)}`);
  await act(async () => {
    match.props.onPress();
  });
}
const boxes = (tree: Tree) =>
  tree.root.findAll(
    n =>
      n.props.accessibilityRole === 'checkbox' &&
      typeof n.props.onPress === 'function',
    { deep: false },
  );
async function checkAll(tree: Tree) {
  for (const box of boxes(tree)) {
    await act(async () => {
      box.props.onPress();
    });
  }
}
const sendButton = (tree: Tree) => buttons(tree, 'Send to printer')[0];
async function render(services: PrintReviewServices) {
  const onCompanion = jest.fn();
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <PrintReviewScreen
        projectId={PROJECT_ID}
        design={DESIGN}
        designName="Drawer tray"
        services={services}
        onBack={() => {}}
        onCompanion={onCompanion}
      />,
    );
  });
  return { tree, onCompanion };
}
async function prepared(services: PrintReviewServices) {
  const rendered = await render(services);
  await press(rendered.tree, 'Check printability');
  return rendered;
}
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the app default says printing is not available yet', async () => {
  const { tree } = await render(unavailablePrintReviewServices());
  const shown = texts(tree);
  expect(shown).toContain('Not available here');
  expect(shown).toContain('can still be exported as an STL');
  expect(buttons(tree, 'Check printability')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a missing connection asks to connect the companion', async () => {
  const { services } = fakePrintServices();
  services.acknowledge = async () => {
    throw failure('pairing-required');
  };
  const { tree, onCompanion } = await render(services);
  expect(texts(tree)).toContain('Connect your companion');
  await press(tree, 'Connect companion');
  expect(onCompanion).toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('an unreachable companion is explained with a retry', async () => {
  const { services, calls } = fakePrintServices();
  const acknowledge = services.acknowledge;
  services.acknowledge = async () => {
    throw failure('network');
  };
  const { tree } = await render(services);
  expect(texts(tree)).toContain('Your companion isn’t answering');
  services.acknowledge = acknowledge;
  await press(tree, 'Try again');
  expect(calls).toContain('acknowledge');
  expect(texts(tree)).toContain('Check this design for printing');
  await act(async () => tree.unmount());
});

test('a printable design shows its summary and sends only after the checklist', async () => {
  const { services, calls } = fakePrintServices({
    prepared: [
      syntheticPrint({
        warnings: [
          {
            code: 'single-perimeter-thin-wall',
            message: 'Some walls are thin.',
          },
        ],
      }),
    ],
  });
  const { tree } = await render(services);
  expect(texts(tree)).toContain('Drawer tray');
  await press(tree, 'Check printability');
  const job = calls.find(c => c.startsWith('prepare'))!.split(' ')[2];
  expect(job).toMatch(UUID_V4);
  let shown = texts(tree);
  expect(shown).toContain('This design can print');
  expect(shown).toContain('Some walls are only one line thick');
  expect(shown).toContain('2 h 14 min');
  expect(shown).toContain('18.4 g');
  expect(shown).toContain('6.12 m');
  expect(shown).toContain(
    'Bambu Lab P1S · 0.4 mm hardened steel nozzle · Textured PEI plate',
  );
  expect(shown).toContain('PLA · AMS 1, slot 1');
  expect(shown).toContain('It doesn’t confirm the part will fit.');
  expect(boxes(tree).map(b => b.props.accessibilityLabel)).toEqual([
    'The Textured PEI plate is on the printer, empty and clean',
    'PLA is loaded in AMS 1, slot 1',
  ]);
  expect(sendButton(tree).props.disabled).toBe(true);
  await act(async () => {
    boxes(tree)[0].props.onPress();
  });
  expect(sendButton(tree).props.disabled).toBe(true);
  await act(async () => {
    boxes(tree)[1].props.onPress();
  });
  expect(sendButton(tree).props.disabled).toBe(false);
  await press(tree, 'Send to printer');
  // The approval names exactly the job the user reviewed.
  expect(calls).toContain(`claim ${'a1'.repeat(32)}`);
  shown = texts(tree);
  expect(shown).toContain('Sent to your companion for printing');
  expect(shown).not.toMatch(/\bPrinting\b/);
  expect(buttons(tree, 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('missing slicer figures are left out rather than shown as zero', async () => {
  const { services } = fakePrintServices({
    prepared: [
      syntheticPrint({
        slice: {
          estimatedPrintSeconds: 45,
          filamentWeightG: null,
          filamentLengthMm: null,
          layerCount: null,
        },
      }),
    ],
  });
  const { tree } = await prepared(services);
  const shown = texts(tree);
  expect(shown).toContain('Under a minute');
  expect(shown).not.toMatch(/NaN| 0\.0 g|0\.00 m|LAYERS|LENGTH/);
  await act(async () => tree.unmount());
});

test('a design that can’t print explains why in plain words, with no send', async () => {
  const { services } = fakePrintServices({
    prepared: [
      failure('printability-failed', {
        report: syntheticReport('not-printable', [
          'exceeds-build-volume',
          'brand-new-check',
        ]),
      }),
    ],
  });
  const { tree } = await prepared(services);
  const shown = texts(tree);
  expect(shown).toContain('This design can’t print as it is');
  expect(shown).toContain('It’s too big for this printer’s bed.');
  // Unknown codes fall back to the companion's own words.
  expect(shown).toContain('synthetic detail for brand-new-check');
  expect(buttons(tree, 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('needing supports asks first, then prepares a new job with them', async () => {
  const { services, calls } = fakePrintServices({
    prepared: [
      failure('supports-required', {
        report: syntheticReport('printable-with-supports', [
          'overhangs-require-supports',
        ]),
      }),
      syntheticPrint({ verdict: 'printable-with-supports' }),
    ],
  });
  const { tree } = await prepared(services);
  expect(texts(tree)).toContain('This design needs supports');
  expect(texts(tree)).toContain('need supports underneath');
  await press(tree, 'Prepare with supports');
  const prepares = calls.filter(c => c.startsWith('prepare'));
  expect(prepares[0]).toMatch(/^prepare plain /);
  expect(prepares[1]).toMatch(/^prepare supports /);
  // A changed request is a different job.
  expect(prepares[0].split(' ')[2]).not.toBe(prepares[1].split(' ')[2]);
  expect(texts(tree)).toContain('Supports are included.');
  await act(async () => tree.unmount());
});

test('a lost prepare reply retries the same job, so nothing is sliced twice', async () => {
  const { services, calls } = fakePrintServices({
    prepared: [failure('network'), syntheticPrint()],
  });
  const { tree } = await prepared(services);
  expect(texts(tree)).toContain('Trying again won’t prepare the print twice.');
  await press(tree, 'Check printability');
  const jobs = calls
    .filter(c => c.startsWith('prepare'))
    .map(c => c.split(' ')[2]);
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).toBe(jobs[1]);
  expect(texts(tree)).toContain('This design can print');
  await act(async () => tree.unmount());
});

test.each([
  ['printer-offline', 'Your printer seems to be off or offline.'],
  ['printer-busy', 'Your printer is busy with another job.'],
  ['approval-expired', 'That took too long to go through.'],
])(
  'a %s rejection explains it and lets the user send again',
  async (code, copy) => {
    const { services, calls } = fakePrintServices();
    const claim = services.claimIntent;
    services.claimIntent = async () => {
      throw failure(code);
    };
    const { tree } = await prepared(services);
    await checkAll(tree);
    await press(tree, 'Send to printer');
    expect(texts(tree)).toContain(copy);
    expect(sendButton(tree).props.disabled).toBe(false);
    expect(calls).not.toContain('attempt');
    services.claimIntent = claim;
    await press(tree, 'Send to printer');
    expect(texts(tree)).toContain('Sent to your companion for printing');
    await act(async () => tree.unmount());
  },
);

test('a lost send reply that reached the companion shows as sent', async () => {
  const fake = fakePrintServices();
  fake.services.claimIntent = async (_p, _a, jobId, approval) => {
    fake.recordIntent(jobId, approval.jobSha256);
    throw failure('ambiguous-send');
  };
  const { tree } = await prepared(fake.services);
  await checkAll(tree);
  await press(tree, 'Send to printer');
  expect(fake.calls).toContain('attempt');
  expect(texts(tree)).toContain('Sent to your companion for printing');
  await act(async () => tree.unmount());
});

test('a lost send reply that never arrived allows sending again', async () => {
  const fake = fakePrintServices();
  const claim = fake.services.claimIntent;
  fake.services.claimIntent = async () => {
    throw failure('ambiguous-send');
  };
  const { tree } = await prepared(fake.services);
  await checkAll(tree);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('nothing was sent');
  expect(sendButton(tree).props.disabled).toBe(false);
  fake.services.claimIntent = claim;
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('Sent to your companion for printing');
  await act(async () => tree.unmount());
});

test('if the status check also fails, sending stays off until it succeeds', async () => {
  const fake = fakePrintServices();
  const attempt = fake.services.attempt;
  fake.services.claimIntent = async (_p, _a, jobId, approval) => {
    fake.recordIntent(jobId, approval.jobSha256);
    throw Object.assign(Error('The request timed out.'));
  };
  fake.services.attempt = async () => {
    throw failure('network');
  };
  const { tree } = await prepared(fake.services);
  await checkAll(tree);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('We couldn’t confirm it was sent');
  expect(buttons(tree, 'Send to printer')).toHaveLength(0);
  await press(tree, 'Check again');
  expect(texts(tree)).toContain('We couldn’t confirm it was sent');
  expect(buttons(tree, 'Send to printer')).toHaveLength(0);
  fake.services.attempt = attempt;
  await press(tree, 'Check again');
  expect(texts(tree)).toContain('Sent to your companion for printing');
  await act(async () => tree.unmount());
});

test('an already-sent reply shows the sent state', async () => {
  const fake = fakePrintServices();
  fake.services.claimIntent = async (_p, _a, jobId, approval) => {
    fake.recordIntent(jobId, approval.jobSha256);
    throw failure('already-sent');
  };
  const { tree } = await prepared(fake.services);
  await checkAll(tree);
  await press(tree, 'Send to printer');
  expect(texts(tree)).toContain('Sent to your companion for printing');
  await act(async () => tree.unmount());
});

test('coming back after sending shows it as sent, with no second send', async () => {
  const { services, calls } = fakePrintServices();
  const first = await prepared(services);
  await checkAll(first.tree);
  await press(first.tree, 'Send to printer');
  await act(async () => first.tree.unmount());
  const again = await render(services);
  expect(texts(again.tree)).toContain('Sent to your companion for printing');
  expect(calls.filter(c => c.startsWith('claim'))).toHaveLength(1);
  expect(calls.filter(c => c.startsWith('prepare'))).toHaveLength(1);
  await act(async () => again.tree.unmount());
});

test('coming back before sending reopens the same prepared job', async () => {
  const { services, calls } = fakePrintServices();
  const first = await prepared(services);
  await act(async () => first.tree.unmount());
  const again = await render(services);
  const jobs = calls
    .filter(c => c.startsWith('prepare'))
    .map(c => c.split(' ')[2]);
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).toBe(jobs[1]);
  expect(texts(again.tree)).toContain('This design can print');
  // The checklist always starts unticked for the job on screen.
  expect(sendButton(again.tree).props.disabled).toBe(true);
  await act(async () => again.tree.unmount());
});

test('journal outcomes are reported as the companion’s, not as printing', async () => {
  const { services } = fakePrintServices();
  const attempt = services.attempt;
  const { tree } = await prepared(services);
  await checkAll(tree);
  await press(tree, 'Send to printer');
  services.attempt = async (...args) => ({
    ...(await attempt(...args)),
    outcome: 'started',
  });
  await press(tree, 'Check status');
  expect(texts(tree)).toContain('Your companion reports the print started.');
  await act(async () => tree.unmount());
});

test('a design edited since opening asks to reopen it', async () => {
  const { services } = fakePrintServices({
    prepared: [failure('project-changed', { status: 412 })],
  });
  const { tree } = await prepared(services);
  expect(texts(tree)).toContain('This design changed');
  expect(buttons(tree, 'Send to printer')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a lost reply while preparing with supports retries that same request', async () => {
  const { services, calls } = fakePrintServices({
    prepared: [
      failure('supports-required', {
        report: syntheticReport('printable-with-supports', [
          'overhangs-require-supports',
        ]),
      }),
      failure('network'),
      syntheticPrint({ verdict: 'printable-with-supports' }),
    ],
  });
  const { tree } = await prepared(services);
  await press(tree, 'Prepare with supports');
  expect(texts(tree)).toContain('Trying again won’t prepare the print twice.');
  // Whatever the retry button says, it must repeat the supports request.
  const retry = buttons(tree, 'Prepare with supports').length
    ? 'Prepare with supports'
    : 'Check printability';
  await press(tree, retry);
  const prepares = calls.filter(c => c.startsWith('prepare'));
  expect(prepares).toHaveLength(3);
  expect(prepares[2]).toBe(prepares[1]);
  expect(prepares[2]).toMatch(/^prepare supports /);
  expect(retry).toBe('Prepare with supports');
  expect(texts(tree)).toContain('Supports are included.');
  await act(async () => tree.unmount());
});

test('two fast presses prepare a single job', async () => {
  const { services, calls } = fakePrintServices();
  const { tree } = await render(services);
  const [check] = buttons(tree, 'Check printability');
  await act(async () => {
    check.props.onPress();
    check.props.onPress();
  });
  expect(calls.filter(c => c.startsWith('prepare'))).toHaveLength(1);
  expect(texts(tree)).toContain('This design can print');
  await act(async () => tree.unmount());
});
