import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pass_watch  # noqa: E402


def entry(kind, at, **fields):
    return json.dumps({'type': kind, 'timestamp': f'2026-11-11T{at}Z', **fields})


def assistant(at, message_id, blocks, tokens, stop='tool_use'):
    return entry('assistant', at, message={'id': message_id, 'stop_reason': stop, 'usage': {'output_tokens': tokens}, 'content': blocks})


# Pass A's shape (#859, Nov 11): a turn that thinks to max_tokens and loses its work, then a long one before the first build.
TRANSCRIPT = [
    entry('api-request', '17:46:04.983'),
    assistant('18:09:47.682', 'm1', [{'type': 'thinking', 'thinking': ''}], 128000, stop='max_tokens'),
    entry('user', '18:10:29.319', message={'content': [{'type': 'text', 'text': 'Output token limit hit. Resume directly'}]}),
    entry('api-request', '18:10:29.369'),
    assistant('18:29:08.543', 'm2', [{'type': 'thinking', 'thinking': ''}], 101890),
    # Claude Code writes one entry per content block, each repeating the message's usage: it counts once.
    assistant('18:29:45.000', 'm2', [{'type': 'tool_use', 'id': 't1', 'name': 'mcp__printer__cad_run', 'input': {'name': 'swivel_mount', 'script': 'x' * 11748}}], 101890),
    entry('user', '18:29:59.388', message={'content': [{'type': 'tool_result', 'tool_use_id': 't1', 'content': '{"valid": false}'}]}),
    'not json',
]


class PassWatchTests(unittest.TestCase):
    def test_a_transcript_reads_as_turns_calls_and_their_times(self):
        watch = pass_watch.Watch()
        lines = [text for raw in TRANSCRIPT for text in watch.line(raw)]
        self.assertIn('18:09:47  model  turn 1:  1423s, 128000 output tokens  <<< long think  !!! hit max_tokens: this turn\'s work is lost', lines)
        self.assertIn('18:29:08  model  turn 2:  1119s, 101890 output tokens  <<< long think', lines)
        self.assertIn('18:29:45  call   cad_run swivel_mount script=11748ch', lines)
        self.assertIn('18:29:59  done   cad_run 14s  {"valid": false}', lines)
        self.assertTrue(any('note   Claude Code: Output token limit hit' in text for text in lines))
        self.assertEqual((watch.turns, watch.output_tokens, watch.limit_hits, watch.big_turns), (2, 229890, 1, 2))
        self.assertIn('max_tokens hits: 1', watch.summary())

    def test_while_the_model_thinks_it_says_for_how_long(self):
        watch = pass_watch.Watch()
        watch.line(TRANSCRIPT[0])
        later = pass_watch._ts('2026-11-11T17:56:04.983Z')
        self.assertEqual(watch.waiting(later), '17:56:04  ...    thinking for 600s')
        watch.line(TRANSCRIPT[1])
        self.assertIsNone(watch.waiting(later), 'nothing to say once it answered')

    def test_once_reads_a_whole_transcript_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'session.jsonl'
            path.write_text('\n'.join(TRANSCRIPT) + '\n')
            self.assertEqual(pass_watch.main(['--file', str(path), '--once']), 0)


if __name__ == '__main__':
    unittest.main()
