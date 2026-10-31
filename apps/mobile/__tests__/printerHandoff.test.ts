import {
  confirmationDeadline,
  storedHandoffMemory,
  type Confirmation,
} from '../src/printing/printerHandoff';

const question = (createdAtMs: number | undefined, expiresAtMs: number): Confirmation => ({
  id: 'q1',
  mode: 'form',
  message: 'Confirm the print.',
  ...(createdAtMs !== undefined ? { createdAtMs } : {}),
  expiresAtMs,
});

// Codex P2 on #132: a phone clock eleven minutes ahead of the companion used
// to expire a fresh ten-minute question on arrival.
test('a question’s deadline counts from when the phone saw it, not from either clock', () => {
  const phoneNow = 1_800_000_000_000;
  for (const companionNow of [phoneNow - 11 * 60000, phoneNow, phoneNow + 11 * 60000]) {
    const asked = question(companionNow, companionNow + 10 * 60000);
    expect(confirmationDeadline(asked, phoneNow)).toBe(phoneNow + 10 * 60000);
  }
  expect(confirmationDeadline(question(5, 1), 100)).toBe(100);
  // An older companion that doesn't say when it asked: only it ends the question.
  expect(confirmationDeadline(question(undefined, 1), 100)).toBeNull();
});

test('a lost send keeps the jobs listed before it across a relaunch', async () => {
  const stored = new Map<string, string>();
  const device = {
    read: async (key: string) => stored.get(key) ?? null,
    write: async (key: string, body: string) => {
      stored.set(key, body);
    },
  };
  const uncertain = { startedAtMs: 1, prompt: '', backend: null, model: 'a'.repeat(64), before: ['x', 'y'] };
  await storedHandoffMemory(device).save('p', 'c', { uncertain });
  expect(await storedHandoffMemory(device).load('p', 'c')).toEqual({ uncertain });
  // Records from before this field still load, without it.
  const older = { startedAtMs: 1, prompt: '', backend: null, model: 'a'.repeat(64) };
  await storedHandoffMemory(device).save('p', 'c', { uncertain: older });
  expect(await storedHandoffMemory(device).load('p', 'c')).toEqual({ uncertain: older });
  // An unreadable list never loses the send; it falls back to matching by time.
  for (const before of ['x', [1], null]) {
    stored.set([...stored.keys()][0]!, JSON.stringify({ uncertain: { ...uncertain, before } }));
    expect(await storedHandoffMemory(device).load('p', 'c')).toEqual({ uncertain: older });
  }
  const many = new Array(5000).fill('x');
  await storedHandoffMemory(device).save('p', 'c', { uncertain: { ...uncertain, before: many } });
  expect(await storedHandoffMemory(device).load('p', 'c')).toEqual({ uncertain: { ...uncertain, before: many } });
});
