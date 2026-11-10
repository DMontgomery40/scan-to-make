"""The simulator test-address rule (CompanionAddress.isFixture) as a Release build compiles it.

Debug simulator builds accept extra http ports (9080–9097) so several ux_screens runs can wait at once. A Release build
must be exactly as strict as before #500: http 9078 and https 9079 only. That is a compile-time property: the wider range
and its branch sit inside `#if DEBUG`, which a Release build never compiles. The XCTest suite runs in Debug and can't
see Release, so this reads the Swift source the way a Release build does (DEBUG undefined) and checks what is left."""
import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import re
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / 'packages/CounterpartKit/Sources/CounterpartKit/Pairing/PairingRecord.swift'


def as_compiled(text: str, debug: bool) -> str:
    """The lines a build keeps with DEBUG defined or not. Conditions other than DEBUG keep both branches (conservative:
    anything they guard counts as compiled)."""
    kept, stack = [], []  # stack of (is_debug_condition, keeping_this_branch)
    for line in text.splitlines():
        directive = line.strip()
        if directive.startswith('#if'):
            condition = directive[3:].strip()
            if condition in ('DEBUG', '!DEBUG'):
                stack.append((True, debug if condition == 'DEBUG' else not debug))
            else:
                stack.append((False, True))
            continue
        if directive.startswith('#else') or directive.startswith('#elseif'):
            is_debug, keeping = stack[-1]
            stack[-1] = (is_debug, (not keeping) if is_debug else True)
            continue
        if directive.startswith('#endif'):
            stack.pop()
            continue
        if all(keeping for _, keeping in stack):
            kept.append(line)
    assert not stack, 'unbalanced #if in ' + str(SOURCE)
    return '\n'.join(kept)


def address_rule(text: str) -> str:
    """The CompanionAddress enum's code up to its next type, without comment lines (they don't compile)."""
    start = text.index('enum CompanionAddress')
    end = text.index('\npublic struct', start)
    return '\n'.join(line for line in text[start:end].splitlines() if not line.strip().startswith('//'))


class FixtureAddressRuleTests(unittest.TestCase):
    def setUp(self):
        self.source = SOURCE.read_text()

    def test_a_release_build_contains_neither_the_wider_range_nor_its_branch(self):
        release = address_rule(as_compiled(self.source, debug=False))
        for port in range(9080, 9098):
            self.assertNotIn(str(port), release, f'Release would accept http {port}')
        self.assertNotIn('debugFixturePorts', release)
        self.assertIn('port == 9078', release)
        self.assertIn('port == 9079', release)

    def test_a_debug_build_has_the_wider_range(self):
        debug = address_rule(as_compiled(self.source, debug=True))
        self.assertIn('debugFixturePorts: ClosedRange<Int> = 9080...9097', debug)
        self.assertIn('debugFixturePorts.contains(port)', debug)

    def test_the_wider_rule_is_not_public(self):
        rule = address_rule(self.source)
        self.assertIsNone(re.search(r'public\s+static\s+(let|var)\s+debugFixturePorts', rule))
        self.assertIsNone(re.search(r'public\s+static\s+func\s+isFixture\(_ url: URL\?, simulator', rule),
                          'the rule with a simulator argument stays internal; apps call isFixture(_:) only')

    def test_the_reader_drops_debug_only_code(self):
        sample = 'a\n#if DEBUG\nb\n#else\nc\n#endif\n#if targetEnvironment(simulator)\nd\n#endif'
        self.assertEqual(as_compiled(sample, debug=False).split(), ['a', 'c', 'd'])
        self.assertEqual(as_compiled(sample, debug=True).split(), ['a', 'b', 'd'])


if __name__ == '__main__':
    unittest.main()
