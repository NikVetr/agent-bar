import json
import tempfile
import unittest
from pathlib import Path

from agent_bar import export


def claude(role, text, at):
    content = text if role == 'user' else [{'type': 'text', 'text': text}]
    return json.dumps({'type': role, 'timestamp': at, 'cwd': '/work/demo', 'message': {'role': role, 'content': content}}) + '\n'


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home = Path(self.dir.name)
        path = self.home / '.claude/projects/p/abc.jsonl'
        path.parent.mkdir(parents=True)
        tool = json.dumps({'type': 'user', 'timestamp': '2026-11-20T10:00:02Z', 'message': {'role': 'user',
                           'content': [{'type': 'tool_result', 'content': 'secret tool output'}]}}) + '\n'
        path.write_text(claude('user', 'Plot the <fits> v1.2', '2026-11-20T10:00:00Z') + tool
                        + claude('assistant', 'Done: see fig.png', '2026-11-20T10:00:05Z'))

    def tearDown(self):
        self.dir.cleanup()

    def test_markdown_and_html_hold_the_dialogue_only_and_never_overwrite(self):
        first = export.export('claude:abc', 'markdown', str(self.home / 'out'), home=self.home, root=self.home)
        text = Path(first['path']).read_text()
        self.assertEqual(first['messages'], 2)
        self.assertIn('## You · 2026-11-20', text)
        self.assertIn('Done: see fig.png', text)
        self.assertNotIn('secret tool output', text)
        self.assertIn('in `/work/demo`', text)
        # A title with a dot keeps all of it in the name.
        self.assertTrue(Path(first['path']).name.startswith('Plot-the-fits-v1.2-'))
        second = export.export('claude:abc', 'markdown', str(self.home / 'out'), home=self.home, root=self.home)
        self.assertNotEqual(first['path'], second['path'])
        page = Path(export.export('claude:abc', 'html', str(self.home / 'out'), home=self.home, root=self.home)['path']).read_text()
        self.assertIn('Plot the &lt;fits&gt; v1.2', page)

    def test_unknown_conversations_and_providers_fail_clearly(self):
        with self.assertRaisesRegex(ValueError, 'No saved transcript'):
            export.export('claude:missing', home=self.home, root=self.home)
        with self.assertRaisesRegex(ValueError, 'Only Claude Code and Codex'):
            export.export('copilot:x', home=self.home, root=self.home)


if __name__ == '__main__':
    unittest.main()
