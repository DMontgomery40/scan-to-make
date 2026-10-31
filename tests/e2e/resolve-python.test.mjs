import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { resolveCaptureTestPython } from './resolve-python.mjs';

test('resolveCaptureTestPython honors CAPTURE_TEST_PYTHON when set', () => {
  const interpreter = resolveCaptureTestPython();
  assert.ok(isAbsolute(interpreter));
  assert.equal(
    resolveCaptureTestPython({ env: { CAPTURE_TEST_PYTHON: interpreter } }),
    interpreter
  );
});

test('resolveCaptureTestPython resolves python3 on PATH when CAPTURE_TEST_PYTHON is unset', () => {
  const saved = process.env.CAPTURE_TEST_PYTHON;
  delete process.env.CAPTURE_TEST_PYTHON;
  try {
    const resolved = resolveCaptureTestPython({ env: process.env });
    assert.ok(isAbsolute(resolved));
    assert.match(resolved, /python/i);
  } finally {
    if (saved === undefined) delete process.env.CAPTURE_TEST_PYTHON;
    else process.env.CAPTURE_TEST_PYTHON = saved;
  }
});

test('resolveCaptureTestPython fails clearly when unset and python3 is missing', () => {
  assert.throws(
    () =>
      resolveCaptureTestPython({
        env: { PATH: '/var/empty', CAPTURE_TEST_PYTHON: '' },
      }),
    (err) => {
      assert.match(err.message, /Could not resolve a Python interpreter/);
      assert.match(err.message, /os\.execv/);
      return true;
    }
  );
});
