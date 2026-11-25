import json
import tempfile
import unittest
from pathlib import Path

from agent_bar import costs

DAY = '2026-11-20T12:00:00Z'


def claude_line(message_id, usage, model='claude-opus-5-5', session='s1', request='r1', at=DAY):
    return json.dumps({'type': 'assistant', 'sessionId': session, 'requestId': request, 'timestamp': at,
                       'message': {'id': message_id, 'model': model, 'role': 'assistant', 'usage': usage}}) + '\n'


def codex_lines(model, events):
    lines = [json.dumps({'timestamp': DAY, 'type': 'turn_context', 'payload': {'model': model}})]
    for total, last in events:
        lines.append(json.dumps({'timestamp': DAY, 'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
            'total_token_usage': {'total_tokens': total}, 'last_token_usage': last}}}))
    return '\n'.join(lines) + '\n'


class CostTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home, self.root = Path(self.dir.name) / 'home', Path(self.dir.name) / 'state'
        self.root.mkdir(parents=True)
        self.now = (costs.epoch(DAY) or 0) + 3600
        self.reader = costs.Costs()
        self.override = Path(self.dir.name) / 'none.json'

    def tearDown(self):
        self.dir.cleanup()

    def refresh(self):
        return self.reader.refresh(self.home, self.root, self.now, override=self.override)

    def test_claude_rates_cover_cache_lifetimes_and_count_a_reply_once(self):
        usage = {'input_tokens': 1_000_000, 'cache_read_input_tokens': 1_000_000, 'output_tokens': 1_000_000,
                 'cache_creation_input_tokens': 2_000_000,
                 'cache_creation': {'ephemeral_5m_input_tokens': 1_000_000, 'ephemeral_1h_input_tokens': 1_000_000}}
        transcript = self.home / '.claude/projects/p/s1.jsonl'
        transcript.parent.mkdir(parents=True)
        # Two content blocks of one reply repeat its usage.
        transcript.write_text(claude_line('m1', usage) * 2)
        summary = self.refresh()
        # Opus 5.5: input 4 + 5m write 5 + 1h write 8 + read 0.2 + output 20.
        self.assertAlmostEqual(summary['chats']['claude:s1'], 37.2)
        self.assertEqual(summary['models'][0]['model'], 'claude-opus-5-5')
        with transcript.open('a') as stream:
            stream.write(claude_line('m2', {'input_tokens': 1_000_000, 'output_tokens': 0, 'speed': 'fast'}, request='r2'))
        self.assertAlmostEqual(self.refresh()['chats']['claude:s1'], 37.2 + 8)

    def test_codex_counts_each_response_once_and_unknown_models_stay_unpriced(self):
        rollout = self.home / '.codex/sessions/2026/11/20/rollout-2026-11-20T10-00-00-01a1efe2-a86c-71c3-9881-0732b8af12b6.jsonl'
        rollout.parent.mkdir(parents=True)
        last = {'input_tokens': 2_000_000, 'cached_input_tokens': 1_000_000, 'output_tokens': 1_000_000, 'total_tokens': 3_000_000}
        # The second event repeats the first reading (a rate-limit update) and must not count again.
        rollout.write_text(codex_lines('gpt-6.2-astra', [(3_000_000, last), (3_000_000, last)]))
        summary = self.refresh()
        # One million fresh input at 8, one million cached at 0.4, one million output at 40.
        self.assertAlmostEqual(summary['chats']['codex:01a1efe2-a86c-71c3-9881-0732b8af12b6'], 48.4)
        other = rollout.with_name('rollout-2026-11-20T11-00-00-01a1efe2-0000-71c3-9881-0732b8af12b6.jsonl')
        other.write_text(codex_lines('mystery-model', [(10, {'total_tokens': 10})]))
        self.assertEqual(self.refresh()['unpriced'], {'codex:mystery-model': 10})

    def test_an_override_adds_prices_and_recounts(self):
        transcript = self.home / '.claude/projects/p/s1.jsonl'
        transcript.parent.mkdir(parents=True)
        transcript.write_text(claude_line('m1', {'input_tokens': 1_000_000, 'output_tokens': 0}, model='claude-new-1'))
        self.assertEqual(self.refresh()['unpriced'], {'claude:claude-new-1': 1_000_000})
        self.override.write_text(json.dumps({'models': {'claude-new-1': {'input': 3, 'cache_write_5m': 0,
            'cache_write_1h': 0, 'cache_read': 0, 'output': 0}}}))
        summary = self.refresh()
        self.assertEqual(summary['unpriced'], {})
        self.assertAlmostEqual(summary['week'], 3)

    def test_dated_model_ids_use_the_family_price(self):
        rates = costs.model_rates(costs.load_prices(self.override), 'claude-sonnet-4-5-20250929')
        self.assertEqual(rates['input'], 3)


if __name__ == '__main__':
    unittest.main()
