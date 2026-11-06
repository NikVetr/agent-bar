import io
import json
import tempfile
import unittest
import unittest.mock
import os
import subprocess
import sys
import time
from pathlib import Path

from agent_bar.state import Ledger, project_names
from agent_bar.providers import Background, Tail, queue_snapshot


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.ledger = Ledger({'since': 100, 'conversations': {}, 'queues': {}, 'project_turns': {}})

    def test_navigation_cutoff_preserves_newer_and_other_completions(self):
        for key in ['codex:a', 'claude:b']:
            self.ledger.event(key, 'complete', 110)
        self.ledger.event('codex:a', 'question', 120)
        self.ledger.acknowledge('codex:a', 115)
        self.assertEqual(self.ledger.unread('codex:a'), ['Input needed'])
        self.assertEqual(self.ledger.unread('claude:b'), ['Reply finished'])

    def test_new_message_clears_attention(self):
        self.ledger.event('claude:a', 'complete', 110)
        self.ledger.event('claude:a', 'message', 120)
        self.assertEqual(self.ledger.conversation('claude:a')['state'], 'working')
        self.assertFalse(self.ledger.unread('claude:a'))

    def test_acknowledging_permission_does_not_erase_underlying_request(self):
        self.ledger.event('claude:a', 'approval', 110)
        self.ledger.acknowledge('claude:a', 120)
        self.assertFalse(self.ledger.unread('claude:a'))
        self.assertEqual(self.ledger.conversation('claude:a')['state'], 'approval needed')

    def test_an_answered_question_or_approval_no_longer_needs_review(self):
        self.ledger.event('codex:a', 'approval', 110)
        self.ledger.event('codex:a', 'question', 111)
        self.assertEqual(self.ledger.unread('codex:a'), ['Approval needed', 'Input needed'])
        # A tool result from before the question, processed late, leaves the question standing.
        self.ledger.event('codex:a', 'resume', 110.5)
        self.assertEqual(self.ledger.unread('codex:a'), ['Input needed'])
        self.ledger.event('codex:a', 'resume', 113)
        self.assertEqual(self.ledger.conversation('codex:a')['state'], 'working')
        self.assertFalse(self.ledger.unread('codex:a'))
        # Approved mid-turn, the finished reply is what is left to review.
        self.ledger.event('codex:a', 'approval', 120)
        self.ledger.event('codex:a', 'complete', 130)
        self.assertEqual(self.ledger.unread('codex:a'), ['Reply finished'])

    def test_duplicate_hook_and_transcript_completion_stays_reviewed(self):
        self.ledger.event('codex:a', 'complete', 110, 'turn-1')
        self.ledger.acknowledge('codex:a', 115)
        self.ledger.event('codex:a', 'complete', 120, 'turn-1')
        self.assertFalse(self.ledger.unread('codex:a'))
        self.ledger.event('codex:a', 'complete', 130, 'turn-2')
        self.assertEqual(self.ledger.unread('codex:a'), ['Reply finished'])

    def test_automatic_continuation_completion_is_not_a_duplicate(self):
        self.ledger.event('claude:a', 'message', 110)
        self.ledger.event('claude:a', 'complete', 120)
        self.ledger.acknowledge('claude:a', 125)
        self.ledger.event('claude:a', 'start', 130)
        self.ledger.event('claude:a', 'complete', 140)
        self.assertEqual(self.ledger.conversation('claude:a')['state'], 'finished')
        self.assertEqual(self.ledger.unread('claude:a'), ['Reply finished'])

    def test_latest_completion_survives_a_new_working_turn(self):
        self.ledger.event('claude:a', 'complete', 110)
        self.ledger.event('claude:a', 'message', 120)
        self.assertEqual(self.ledger.conversation('claude:a')['completed_at'], 110)
        self.assertEqual(self.ledger.conversation('claude:a')['state'], 'working')

    def test_project_queue_counts_reset_at_each_turn(self):
        paths = ['/home/u/repos/demo']
        queue = lambda n, state, at: self.ledger.queue({'id': f'q{n}', 'project': 'demo', 'state': state}, at)
        counts = lambda: self.ledger.queue_counts().get('demo', {'done': 0, 'total': 0})
        with unittest.mock.patch('pathlib.Path.home', return_value=Path('/home/u')):
            self.ledger.turn(paths, 100)
            for n in range(4): queue(n, 'RUNNING', 101)
            self.assertEqual(counts(), {'done': 0, 'total': 4})
            queue(0, 'COMPLETED', 110)
            self.assertEqual(counts(), {'done': 1, 'total': 4})
            self.ledger.turn(paths, 120)
            self.assertEqual(counts(), {'done': 0, 'total': 3})
            self.ledger.turn(paths, 130)
            for n in [4, 5]: queue(n, 'PENDING', 131)
            self.assertEqual(counts(), {'done': 0, 'total': 5})
            for n in [1, 2]: queue(n, 'FAILED', 140)
            for n in [3, 4, 5]: queue(n, 'FINISHED_INCOMPLETE', 140)
            self.assertEqual(counts(), {'done': 5, 'total': 5})
            self.ledger.turn(paths, 150)
            self.assertEqual(counts(), {'done': 0, 'total': 0})

    def test_project_queues_finishing_need_review_until_a_turn_or_ack(self):
        queue = lambda n, state, at, ended=None: self.ledger.queue(
            {'id': f'q{n}', 'project': 'demo', 'state': state, 'ended': ended}, at)
        with unittest.mock.patch('pathlib.Path.home', return_value=Path('/home/u')):
            self.ledger.turn(['/home/u/demo'], 100)
            for n in range(2): queue(n, 'RUNNING', 101)
            queue(0, 'COMPLETED', 110, ended=108)
            self.assertEqual(self.ledger.queues_finished(), {})
            queue(1, 'FAILED', 130, ended=125)
            self.assertEqual(self.ledger.queues_finished(), {'demo': 130})
            self.assertEqual(self.ledger.unread('codex:a', 130), ['Queues finished'])
            self.ledger.acknowledge('codex:a', 135)
            self.assertEqual(self.ledger.unread('codex:a', 130), [])
            # An agent woken by the last end began a turn before the tracker saw it.
            queue(2, 'RUNNING', 140)
            queue(2, 'COMPLETED', 160, ended=150)
            self.ledger.turn(['/home/u/demo'], 155)
            self.assertEqual(self.ledger.queues_finished(), {})

    def test_finished_queues_go_to_the_most_recently_active_chat(self):
        from agent_bar.service import Tracker
        with tempfile.TemporaryDirectory() as root:
            tracker = Tracker(root)
            ledger = tracker.ledger
            ledger.data['since'] = 0
            ledger.queue({'id': 'q', 'project': 'demo', 'state': 'COMPLETED', 'ended': 115}, 120)
            ledger.event('claude:a', 'complete', 105)
            ledger.event('codex:b', 'complete', 110)
            ledger.acknowledge('claude:a', 111)
            ledger.acknowledge('codex:b', 111)
            row = lambda key, provider, roots: {'key': key, 'provider': provider, 'id': key[-1], 'roots': roots,
                                                'project': Path(roots[0]).name, 'title': key, 'window': 'w'}
            tracker.rows = [row('claude:a', 'claude', ['/home/u/demo']), row('codex:b', 'codex', ['/home/u/demo/sub']),
                            row('claude:c', 'claude', ['/home/u/other'])]
            with unittest.mock.patch('pathlib.Path.home', return_value=Path('/home/u')):
                unread = {r['key']: r['unread'] for r in tracker.snapshot()['rows']}
            self.assertEqual(unread, {'claude:a': [], 'codex:b': ['Queues finished'], 'claude:c': []})

    def test_tracker_runs_without_or_with_the_scheduler_turned_off(self):
        from agent_bar import service
        from agent_bar.providers import Providers
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / 'proc').mkdir()
            settings, queues = root / 'settings.json', root / 'parallel-workers/queue-progress.tsv'
            with unittest.mock.patch.object(service, 'SETTINGS', settings), unittest.mock.patch.object(service, 'QUEUES', queues):
                tracker = service.Tracker(root / 'state')
                tracker.providers = Providers(root, str(root / 'proc'))
                tracker.ledger.queue({'id': 'q', 'project': 'demo', 'state': 'RUNNING'}, 100)
                tracker.collect()
                snapshot = json.loads((root / 'state/snapshot.json').read_text())
                self.assertEqual((snapshot['scheduler'], snapshot['warnings']), ('missing', []))
                self.assertEqual((snapshot['queues'], snapshot['counts']['queues']), ([], 0))
                queues.parent.mkdir()
                tracker.collect()
                snapshot = json.loads((root / 'state/snapshot.json').read_text())
                self.assertEqual((snapshot['scheduler'], snapshot['counts']['queues']), ('on', 1))
                self.assertTrue(any('stale' in warning for warning in snapshot['warnings']))
                settings.write_text(json.dumps({'scheduler': False}))
                tracker.collect()
                snapshot = json.loads((root / 'state/snapshot.json').read_text())
                self.assertEqual((snapshot['scheduler'], snapshot['warnings'], snapshot['queues']), ('off', [], []))

    def test_git_status_counts_changes_without_taking_the_index_lock(self):
        from agent_bar.git import Repositories, parse_status, web_url
        text = '\0'.join(['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
                          '1 M. N... 100644 100644 100644 a b one.txt', '1 .M N... 100644 100644 100644 a b two.txt',
                          '2 R. N... 100644 100644 100644 a b R100 new.txt', 'old.txt', 'u UU N... 1 2 3 4 a b c both.txt',
                          '? loose.txt', ''])
        self.assertEqual(parse_status(text), {'branch': 'main', 'upstream': 'origin/main', 'ahead': 2, 'behind': 1,
                                              'staged': 2, 'modified': 1, 'untracked': 1, 'conflicts': 1})
        self.assertEqual(web_url('git@github.com:me/tool.git'), 'https://github.com/me/tool')
        self.assertEqual(web_url('https://gitlab.com/me/tool/'), 'https://gitlab.com/me/tool')
        self.assertIsNone(web_url('/srv/git/tool.git'))
        with tempfile.TemporaryDirectory() as root:
            repo = Path(root) / 'tool'
            (repo / 'sub').mkdir(parents=True)
            run = lambda *args: subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
            run('init', '-q', '-b', 'main')
            (repo / 'a.txt').write_text('a')
            run('add', 'a.txt')
            run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'First')
            (repo / 'a.txt').write_text('b')
            (repo / 'b.txt').write_text('new')
            [value] = Repositories().read([str(repo / 'sub'), str(repo), str(Path(root) / 'missing')])
            self.assertEqual((value['name'], value['branch'], value['upstream'], value['remotes']), ('tool', 'main', None, 0))
            self.assertEqual((value['modified'], value['untracked'], value['subject'], value['web']), (1, 1, 'First', None))
            self.assertEqual(value['folders'], [str(repo), str(repo / 'sub')])
            self.assertFalse((repo / '.git/index.lock').exists())

    def test_messages_reach_one_open_chat_and_stop_after_three_without_a_human_prompt(self):
        from agent_bar import messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            rows = [{'key': key, 'provider': key.split(':')[0], 'title': title, 'project': 'p', 'state': 'finished'}
                    for key, title in [('claude:a', 'Fix login'), ('codex:b', 'Audit scheduler')]]
            (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
            ledger = {'conversations': {'claude:a': {'human_at': 100}}}
            (root / 'ledger.json').write_text(json.dumps(ledger))
            with unittest.mock.patch.object(messages, 'SETTINGS', root / 'settings.json'):
                self.assertIsNone(messages.notice('codex:b', root))
                for n in range(3):
                    self.assertEqual(messages.send('claude:a', 'codex:b', f'note {n}', root, now=200 + n)['remaining'], 2 - n)
                with self.assertRaisesRegex(ValueError, 'Loop guard'): messages.send('claude:a', 'codex:b', 'more', root, now=210)
                for bad in ['claude:a', 'codex:gone']:
                    with self.assertRaises(ValueError): messages.send('claude:a', bad, 'x', root, now=211)
                self.assertIn('3 unread messages', messages.notice('codex:b', root))
                self.assertIn('"Fix login"', messages.notice('codex:b', root))
                self.assertEqual(messages.summary(root)['unread'], {'codex:b': 3})
                self.assertEqual(len(messages.inbox('codex:b', root, peek=True)['messages']), 3)
                self.assertEqual([m['body'] for m in messages.inbox('codex:b', root)['messages']], ['note 0', 'note 1', 'note 2'])
                self.assertIsNone(messages.notice('codex:b', root))
                # The reply is the other direction's first message; a new prompt resets the sender's count.
                self.assertEqual(messages.send('codex:b', 'claude:a', 'thanks', root, now=220)['remaining'], 2)
                ledger['conversations']['claude:a']['human_at'] = 230
                (root / 'ledger.json').write_text(json.dumps(ledger))
                self.assertTrue(messages.send('claude:a', 'codex:b', 'again', root, now=240)['ok'])
                (root / 'settings.json').write_text(json.dumps({'messages': False}))
                self.assertIsNone(messages.notice('codex:b', root))
                with self.assertRaisesRegex(ValueError, 'turned off'): messages.send('claude:a', 'codex:b', 'x', root, now=250)
            with unittest.mock.patch.dict(os.environ, {'CLAUDE_CODE_SESSION_ID': '', 'CODEX_THREAD_ID': 't1'}):
                self.assertEqual(messages.caller(), 'codex:t1')

    def test_held_pairs_show_refused_sends_until_the_user_resets_them(self):
        from agent_bar import messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            rows = [{'key': key, 'provider': 'claude', 'title': key, 'project': 'p', 'state': 'finished'} for key in ['claude:a', 'claude:b']]
            (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            with unittest.mock.patch.object(messages, 'SETTINGS', root / 'settings.json'):
                for n in range(3): messages.send('claude:a', 'claude:b', f'm{n}', root, now=100 + n)
                for n in range(2):
                    with self.assertRaises(ValueError): messages.send('claude:a', 'claude:b', 'more', root, now=110 + n)
                self.assertEqual(messages.summary(root, now=120)['held'], [{'sender': 'claude:a', 'recipient': 'claude:b', 'refused': 2}])
                # A human prompt to the sender after the holds also lifts them.
                self.assertEqual(messages.summary(root, {'claude:a': 115}, now=120)['held'], [])
                messages.reset_limit('claude:b', 'claude:a', root, now=130)
                self.assertEqual(messages.summary(root, now=131)['held'], [])
                self.assertTrue(messages.send('claude:a', 'claude:b', 'after reset', root, now=140)['ok'])

    def test_waiter_wakes_an_idle_claude_chat_once_per_new_message(self):
        from agent_bar import hook, messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            rows = [{'key': key, 'provider': 'claude', 'title': key, 'project': 'p', 'state': 'finished'} for key in ['claude:a', 'claude:s']]
            (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            settings = root / 'settings.json'
            with unittest.mock.patch.object(messages, 'SETTINGS', settings), \
                    unittest.mock.patch.dict(os.environ, {'AGENT_BAR_STATE_DIR': str(root)}), \
                    unittest.mock.patch.object(hook, 'WAIT', 0.3):
                data = {'session_id': 's', 'hook_event_name': 'Stop'}
                messages.send('claude:a', 'claude:s', 'hello', root)
                self.assertIsNone(hook.wait(data, every=0.05))  # Waking is off by default.
                settings.write_text(json.dumps({'wake': True}))
                with unittest.mock.patch('sys.stderr', new_callable=io.StringIO) as stderr, self.assertRaises(SystemExit) as woke:
                    hook.wait(data, every=0.05)
                self.assertEqual(woke.exception.code, 2)
                self.assertIn('1 unread message', stderr.getvalue())
                [event] = [json.loads(path.read_text()) for path in (root / 'events').glob('*.json')]
                self.assertEqual((event['kind'], event['session']), ('start', 's'))
                # Already woken for it: the next turn's waiter stays quiet until another message arrives.
                self.assertIsNone(hook.wait(data, every=0.05))
                messages.send('claude:a', 'claude:s', 'again', root)
                with unittest.mock.patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
                    hook.wait(data, every=0.05)

    def test_unread_messages_strand_in_chats_nothing_will_wake(self):
        from agent_bar import messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            row = lambda key, state='finished': {'key': key, 'provider': key.split(':')[0], 'state': state}
            rows = [row('codex:c'), row('codex:c'), row('claude:idle'), row('claude:busy', 'working'),
                    row('claude:live'), row('claude:used'), row('claude:none')]
            unread = {key: 1 for key in ['codex:c', 'claude:idle', 'claude:busy', 'claude:live', 'claude:used', 'claude:gone']}
            # A live waiter (this test's own pid) watches live and used; only live has a message newer than its wake.
            for key, latest, woken in [('claude:live', 5, 4), ('claude:used', 5, 5), ('claude:idle', 5, 4)]:
                newest, done, waiter, _ = messages.wake_files(key, root)
                newest.write_text(str(latest))
                done.write_text(str(woken))
                waiter.write_text(str(os.getpid() if key != 'claude:idle' else 2 ** 22 + 1))
            settings = root / 'settings.json'
            with unittest.mock.patch.object(messages, 'SETTINGS', settings):
                self.assertEqual(messages.stranded(unread, rows, root), ['codex:c', 'claude:idle', 'claude:busy', 'claude:live', 'claude:used'])
                settings.write_text(json.dumps({'wake': True}))
                self.assertEqual(messages.stranded(unread, rows, root), ['codex:c', 'claude:idle', 'claude:used'])
                # A waiter past the hook's lifetime is gone, even if its pid is reused.
                old = time.time() - 3 * 3600
                os.utime(messages.wake_files('claude:live', root)[2], (old, old))
                self.assertEqual(messages.stranded(unread, rows, root), ['codex:c', 'claude:idle', 'claude:live', 'claude:used'])

    def test_a_busy_chat_gets_messages_mid_turn_only_as_the_user_allows(self):
        from agent_bar import hook, messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            rows = [{'key': 'claude:a', 'provider': 'claude', 'title': 'A', 'project': 'p', 'state': 'finished'},
                    {'key': 'claude:s', 'provider': 'claude', 'title': 'S', 'project': 'p', 'state': 'working'}]
            (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            settings, data = root / 'settings.json', {'session_id': 's', 'hook_event_name': 'Stop'}
            woke = lambda: self.assertRaises(SystemExit)
            with unittest.mock.patch.object(messages, 'SETTINGS', settings), \
                    unittest.mock.patch.dict(os.environ, {'AGENT_BAR_STATE_DIR': str(root)}), \
                    unittest.mock.patch.object(hook, 'WAIT', 0.2), unittest.mock.patch('sys.stderr', new_callable=io.StringIO):
                settings.write_text(json.dumps({'wake': True}))
                messages.send('claude:a', 'claude:s', 'routine', root)
                self.assertIsNone(hook.wait(data, every=0.05))  # After its turn, by default.
                settings.write_text(json.dumps({'wake': True, 'midturn': 'urgent'}))
                self.assertIsNone(hook.wait(data, every=0.05))
                messages.send('claude:a', 'claude:s', 'stop writing to out/', root, urgent=True)
                with woke(): hook.wait(data, every=0.05)
                messages.send('claude:a', 'claude:s', 'routine again', root)
                settings.write_text(json.dumps({'wake': True, 'midturn': 'always'}))
                with woke(): hook.wait(data, every=0.05)
                # Waiting for the user's answer is still its turn.
                settings.write_text(json.dumps({'wake': True}))
                rows[1]['state'] = 'input needed'
                (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
                messages.reset_limit('claude:a', 'claude:s', root)
                messages.send('claude:a', 'claude:s', 'while it asks', root)
                self.assertIsNone(hook.wait(data, every=0.05))
                # Once its turn ends it is idle, and a new message reaches it whatever the setting.
                rows[1]['state'] = 'finished'
                (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
                messages.reset_limit('claude:a', 'claude:s', root)
                messages.send('claude:a', 'claude:s', 'after the turn', root)
                with woke(): hook.wait(data, every=0.05)

    def test_recipients_are_claude_or_codex_chats_most_recent_first_and_agents_cannot_lift_the_guard(self):
        from agent_bar import messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            row = lambda key, at: {'key': key, 'provider': key.split(':')[0], 'title': key, 'project': 'p', 'state': 'finished', 'state_at': at}
            (root / 'snapshot.json').write_text(json.dumps({'rows': [row('claude:old', 10), row('codex:new', 30), row('copilot:x', 40)]}))
            self.assertEqual([(a['key'], a['last_active']) for a in messages.agents(root)], [('codex:new', 30), ('claude:old', 10)])
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            with unittest.mock.patch.object(messages, 'SETTINGS', root / 'settings.json'):
                with self.assertRaisesRegex(ValueError, 'Claude Code or Codex'): messages.send('claude:old', 'copilot:x', 'hi', root)
        refused = subprocess.run([sys.executable, '-m', 'agent_bar', 'reset-limit', 'claude:a', 'claude:b'], capture_output=True, text=True,
                                 env={**os.environ, 'CLAUDE_CODE_SESSION_ID': 'a', 'HOME': '/nonexistent'})
        self.assertEqual(refused.returncode, 1)
        self.assertIn('Only the user resets', refused.stdout)

    def test_hook_install_keeps_other_hooks_replaces_stale_ones_and_removes_cleanly(self):
        from agent_bar import hooks
        with tempfile.TemporaryDirectory() as home, unittest.mock.patch('pathlib.Path.home', return_value=Path(home)):
            settings = Path(home) / '.claude/settings.json'; settings.parent.mkdir()
            mine = {'type': 'command', 'command': 'notify-send done'}
            stale = {'type': 'command', 'command': '/old/venv/bin/python -m agent_bar.hook', 'timeout': 3}
            settings.write_text(json.dumps({'model': 'opus', 'hooks': {'Stop': [{'hooks': [mine]}, {'hooks': [stale]}]}}))
            hooks.install('claude')
            data = json.loads(settings.read_text())
            commands = [h['command'] for entry in data['hooks']['Stop'] for h in entry['hooks']]
            self.assertIn('notify-send done', commands)
            self.assertNotIn(stale['command'], commands)
            self.assertEqual(hooks.installed('claude'), {'observer': True, 'waiter': True})
            hooks.install('claude')  # Already current: nothing changes, no new backup.
            self.assertEqual(len(list(settings.parent.glob('settings.json.before-agent-bar-*'))), 1)
            hooks.remove('claude')
            self.assertEqual(json.loads(settings.read_text()), {'model': 'opus', 'hooks': {'Stop': [{'hooks': [mine]}]}})

    def test_info_merges_skills_and_reads_recorded_usage_and_instructions(self):
        from agent_bar import info
        with tempfile.TemporaryDirectory() as root:
            home, state = Path(root) / 'home', Path(root) / 'state'
            for folder, name in [('.claude/skills', 'plot'), ('.agents/skills', 'plot'), ('.claude/skills/synced/x', 'pdf')]:
                (home / folder / name).mkdir(parents=True)
                (home / folder / name / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: Does {name}.\n---\n\n# {name}\n')
            (home / '.claude.json').write_text(json.dumps({'skillUsage': {'plot': {'usageCount': 3, 'lastUsedAt': 5000}},
                'cachedUsageUtilization': {'fetchedAtMs': 9000, 'utilization': {
                    'five_hour': {'utilization': 26, 'resets_at': '2026-11-04T18:30:00+00:00'}, 'seven_day': {'utilization': 33}}}}))
            rollout = home / '.codex/sessions/2026/11/04/rollout-2026-11-04T10-00-00-x.jsonl'; rollout.parent.mkdir(parents=True)
            rollout.write_text(json.dumps({'timestamp': '2026-11-04T18:27:35Z', 'type': 'event_msg', 'payload': {'type': 'token_count',
                'rate_limits': {'primary': {'used_percent': 61.0, 'window_minutes': 10080, 'resets_at': 1794095235}, 'secondary': None}}}) + '\n')
            project = home / 'repos/demo/sub'; project.mkdir(parents=True)
            (home / 'repos/demo/AGENTS.md').write_text('rules')
            state.mkdir()
            (state / 'snapshot.json').write_text(json.dumps({'windows': [{'roots': [str(project)]}], 'rows': []}))
            (state / 'ledger.json').write_text(json.dumps({'conversations': {'claude:a': {'hook_seen': 70}, 'codex:b': {}}}))
            result = info.collect(state, home)
            self.assertEqual([(s['name'], s['providers'], s['synced'], s['uses']) for s in result['skills']],
                             [('plot', ['claude', 'codex'], False, 3), ('pdf', ['claude.ai'], True, 0)])
            self.assertEqual(result['usage']['claude']['limits'][0], {'name': '5-hour', 'percent': 26, 'resets_at': '2026-11-04T18:30:00+00:00'})
            self.assertEqual(result['usage']['codex']['limits'], [{'name': 'Weekly', 'percent': 61.0, 'resets_at': 1794095235}])
            self.assertEqual(result['instructions']['folders'], {str(project): [str(home / 'repos/demo/AGENTS.md')]})
            self.assertEqual((result['health']['hooks']['claude'], result['health']['last_event']['claude']),
                             ({'observer': False, 'waiter': False}, 70))

    def test_hook_adds_a_turn_start_note_only_for_unread_messages(self):
        from agent_bar import messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            rows = [{'key': 'claude:a', 'provider': 'claude', 'title': 'A', 'project': 'p', 'state': 'finished'},
                    {'key': 'claude:s', 'provider': 'claude', 'title': 'B', 'project': 'p', 'state': 'finished'}]
            (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            env = {**os.environ, 'AGENT_BAR_STATE_DIR': str(root), 'HOME': str(root)}
            hook = lambda: subprocess.run([sys.executable, '-m', 'agent_bar.hook'], env=env, capture_output=True, text=True,
                                          input=json.dumps({'hook_event_name': 'UserPromptSubmit', 'session_id': 's', 'prompt': 'hi'}))
            self.assertEqual(hook().stdout, '')
            with unittest.mock.patch.object(messages, 'SETTINGS', root / 'settings.json'):
                messages.send('claude:a', 'claude:s', 'hello', root)
            output = json.loads(hook().stdout)['hookSpecificOutput']
            self.assertEqual(output['hookEventName'], 'UserPromptSubmit')
            self.assertIn('1 unread message from', output['additionalContext'])
            woken = subprocess.run([sys.executable, '-m', 'agent_bar.hook'], env=env, capture_output=True, text=True,
                                   input=json.dumps({'hook_event_name': 'UserPromptSubmit', 'session_id': 's',
                                                     'prompt': '<task-notification>[agent-bar] 1 unread…'}))
            self.assertEqual(woken.stdout, '')

    def test_nested_windows_share_their_ancestor_project(self):
        names = project_names(['/home/u/repos/omics/tmp/audit'], home='/home/u')
        self.assertTrue({'omics', 'tmp', 'audit'} <= names)
        self.assertNotIn('u', names)

    def test_migration_treats_finished_queues_as_already_seen(self):
        ledger = Ledger({'since': 100, 'conversations': {}, 'links': {}, 'queues': {
            'a': {'id': 'a', 'project': 'demo', 'state': 'COMPLETED'},
            'b': {'id': 'b', 'project': 'demo', 'state': 'RUNNING'}}})
        self.assertNotIn('links', ledger.data)
        self.assertEqual(ledger.queue_counts(), {'demo': {'done': 0, 'total': 1}})

    def test_active_queue_dropped_by_mmm_counts_as_finished(self):
        for n, state in enumerate(['RUNNING', 'PENDING', 'COMPLETED']):
            self.ledger.queue({'id': f'q{n}', 'project': 'demo', 'state': state}, 101)
        self.ledger.unlisted({'q1'}, 110)
        queues = self.ledger.data['queues']
        self.assertEqual((queues['q0']['state'], queues['q0']['finished_at']), ('UNLISTED', 110))
        self.assertEqual(queues['q1']['state'], 'PENDING')
        self.assertEqual(queues['q2']['finished_at'], 101)
        self.assertEqual(self.ledger.queue_counts(), {'demo': {'done': 2, 'total': 3}})

    def test_background_work_pending_until_notified_stopped_or_due(self):
        def use(id, name, **args):
            return {'type': 'assistant', 'timestamp': 100, 'message': {'content': [
                {'type': 'tool_use', 'id': id, 'name': name, 'input': args}]}}
        def result(id, **value):
            return {'type': 'user', 'timestamp': 101, 'toolUseResult': value,
                    'message': {'content': [{'type': 'tool_result', 'tool_use_id': id}]}}
        def note(id, status):
            return {'type': 'user', 'timestamp': 200, 'promptSource': 'system', 'origin': {'kind': 'task-notification'},
                    'message': {'content': f'<task-notification><tool-use-id>{id}</tool-use-id>'
                                           f'<status>{status}</status></task-notification>'}}
        with tempfile.TemporaryDirectory() as root:
            background = Background(Path(root) / 'none')
            for entry in [use('job', 'Bash', run_in_background=True), result('job', backgroundTaskId='t1'),
                          use('fg', 'Bash'), use('agent', 'Agent', run_in_background=True)]:
                background.feed(entry)
            self.assertEqual(set(background.pending), {'job', 'agent'})
            background.feed(note('agent', 'completed'))
            background.feed(use('stop', 'TaskStop', task_id='t1'))
            self.assertFalse(background.waiting(150))
            self.assertFalse(background.human)
            background.feed(use('wake', 'ScheduleWakeup', delaySeconds=600))
            background.feed(result('wake', scheduledFor=1_800_000_700_000))  # epoch milliseconds
            self.assertTrue(background.waiting(1_800_000_650))
            self.assertFalse(background.waiting(1_800_000_800))
            background.feed({'type': 'user', 'timestamp': 900, 'promptSource': 'sdk', 'origin': {'kind': 'human'},
                             'message': {'content': 'next'}})
            self.assertTrue(background.human)
            background.feed({'type': 'system', 'subtype': 'stop_hook_summary', 'timestamp': 950})
            self.assertEqual(background.ended_at, 950)

    def test_hold_is_a_finished_turn_without_review(self):
        self.ledger.event('claude:a', 'start', 110)
        self.ledger.event('claude:a', 'hold', 120)
        row = self.ledger.conversation('claude:a')
        self.assertEqual((row['state'], row['completed_at']), ('waiting', 120))
        self.assertFalse(self.ledger.unread('claude:a'))

    def test_codex_view_state_survives_log_rotation(self):
        with tempfile.TemporaryDirectory() as root:
            logs = Path(root) / 'openai.chatgpt'; logs.mkdir()
            (logs / 'Codex.1.log').write_text('thread_stream_view_activity_changed active=true conversationId=abc-1\n')
            (logs / 'Codex.log').write_text('other line\n')
            from agent_bar.providers import Providers
            self.assertEqual(Providers(root).codex_open({'id': 'w', 'log': str(Path(root) / 'bridge')}), {'abc-1'})

    def test_terminal_and_app_sessions_get_their_windows(self):
        import sqlite3
        from agent_bar.providers import Providers
        with tempfile.TemporaryDirectory() as root:
            home, proc = Path(root) / 'home', Path(root) / 'proc'
            rollout = lambda sid: f'{home}/.codex/sessions/2026/11/03/rollout-2026-11-03T10-00-00-{sid}.jsonl'
            ids = {name: f'01a1a378-06f1-73f2-ade4-{n:012x}' for n, name in enumerate(['claude', 'old', 'cli', 'app', 'sub', 'vsc'])}

            def task(pid, ppid, exe, comm='bash', start=7, fds=()):
                path = proc / str(pid); (path / 'fd').mkdir(parents=True)
                (path / 'stat').write_text(f'{pid} ({comm}) S {ppid} ' + ' '.join(['0'] * 17) + f' {start} 0\n')
                (path / 'comm').write_text(comm + '\n')
                os.symlink(exe, path / 'exe')
                for n, target in enumerate(fds): os.symlink(target, path / 'fd' / str(n))

            task(80, 1, '/usr/libexec/gnome-terminal-server')
            task(90, 80, '/usr/bin/bash')
            task(100, 90, '/usr/bin/claude', 'claude', start=555)
            task(101, 90, '/usr/bin/claude', 'claude', start=999)  # Recycled since its record was written.
            task(190, 1, '/usr/share/code/code', 'code')
            task(200, 190, f'{home}/.codex/packages/codex', 'codex', fds=[rollout(ids['cli'])])
            task(300, 1, '/usr/lib/chatgpt/resources/codex', 'codex', fds=[rollout(ids['app']), rollout(ids['sub'])])
            task(400, 1, f'{home}/.vscode/extensions/openai.chatgpt/bin/codex', 'codex', fds=[rollout(ids['vsc'])])
            sessions = home / '.claude/sessions'; sessions.mkdir(parents=True)
            for pid, sid, start, entry in [(100, ids['claude'], 555, 'cli'), (101, ids['old'], 444, 'cli'),
                                           (90, ids['vsc'], 7, 'claude-vscode')]:
                (sessions / f'{pid}.json').write_text(json.dumps({'pid': pid, 'sessionId': sid, 'procStart': str(start),
                    'cwd': '/r/proj/sub', 'entrypoint': entry, 'kind': 'interactive', 'name': 'sub-87'}))
            # The terminal shows the transcript's title; a /rename outranks the generated one.
            transcript = home / f'.claude/projects/-r-proj-sub/{ids["claude"]}.jsonl'; transcript.parent.mkdir(parents=True)
            transcript.write_text(''.join(json.dumps(entry, separators=(',', ':')) + '\n' for entry in [
                {'type': 'ai-title', 'aiTitle': 'Login bug'}, {'type': 'custom-title', 'customTitle': 'Fix login'}]))
            (home / '.codex').mkdir(exist_ok=True)
            with sqlite3.connect(home / '.codex/state_5.sqlite') as db:
                db.execute('CREATE TABLE threads (id, title, cwd, rollout_path, source)')
                db.executemany('INSERT INTO threads VALUES (?,?,?,?,?)', [
                    (ids['cli'], 'Plot', '/r/proj', rollout(ids['cli']), 'cli'),
                    (ids['app'], 'Draft', '/r/other', rollout(ids['app']), 'vscode'),
                    (ids['sub'], 'Helper', '/r/other', rollout(ids['sub']), '{"subagent": {}}')])
            bridge = {'id': 'w1', 'workspace': 'proj', 'roots': ['/r/proj']}
            other = {'id': 'w2', 'workspace': 'r', 'roots': ['/r/pro']}  # A name prefix is not a parent folder.
            rows, windows, warnings = Providers(home, str(proc)).external([bridge, other], 1000)
            self.assertEqual(warnings, [])
            found = {row['title']: (row['window'], row['project'], row['target']['kind']) for row in rows}
            # The terminal session joins the project of the folder holding it; the VS Code terminal one, its window.
            self.assertEqual(found, {'Fix login': ('terminal:100', 'proj', 'window'), 'Plot': ('w1', 'proj', 'window'),
                                     'Draft': ('app:300', 'other', 'window')})
            self.assertEqual({w['id']: (w['kind'], w['workspace'], w['pids'][-1]) for w in windows},
                             {'terminal:100': ('terminal', 'proj', 80), 'app:300': ('app', 'Codex app', 300)})
            self.assertEqual(next(r for r in rows if r['title'] == 'Plot')['path'], rollout(ids['cli']))

    def test_copilot_cli_sessions_from_logs_and_their_turns_from_events(self):
        from agent_bar.providers import Providers
        with tempfile.TemporaryDirectory() as root:
            home, proc = Path(root) / 'home', Path(root) / 'proc'
            sid, gone = '7e6201c5-2e8b-4f46-8405-931d04bc0b27', 'd8fa5c20-fb8e-4d04-8704-ad3645a18b13'
            for pid, ppid, exe in [(80, 1, '/usr/libexec/gnome-terminal-server'), (90, 80, '/usr/bin/bash'),
                                   (100, 90, '/opt/copilot-linux-x64/copilot'), (200, 1, '/snap/code/copilot-runtime')]:
                (proc / str(pid)).mkdir(parents=True)
                (proc / str(pid) / 'stat').write_text(f'{pid} (x) S {ppid} ' + ' '.join(['0'] * 17) + ' 5 0\n')
                os.symlink(exe, proc / str(pid) / 'exe')
            logs = home / '.copilot/logs'; logs.mkdir(parents=True)
            line = lambda action, s: f'2026-11-04T18:16:36.598Z [INFO] {action} foreground session: {s}\n'
            # An older log of a recycled pid; the runtime VS Code bundles; the live CLI, mid-line.
            (logs / 'process-1000-100.log').write_text(line('Registering', gone))
            (logs / 'process-3000-200.log').write_text(line('Registering', gone))
            log = logs / 'process-2000-100.log'
            log.write_text(line('Registering', gone) + line('Unregistering', gone) + line('Registering', sid)[:40])
            folder = home / '.copilot/session-state' / sid; folder.mkdir(parents=True)
            (folder / 'workspace.yaml').write_text(f'id: {sid}\ncwd: /r/proj\nname: Audio Connection Check\nuser_named: false\n')
            providers = Providers(home, str(proc))
            self.assertEqual(providers.copilot_terminals(), [])
            with log.open('a') as stream: stream.write(line('Registering', sid)[40:])
            [session] = providers.copilot_terminals()
            self.assertEqual((session['id'], session['title'], session['cwd'], session['pid']),
                             (sid, 'Audio Connection Check', '/r/proj', 100))
            event = lambda kind, at, **data: json.dumps({'type': kind, 'timestamp': f'2026-11-04T18:17:{at:02d}Z', 'data': data})
            kinds = [kind for kind, _, _ in providers.copilot_events('copilot:x', [
                event('user.message', 1, interactionId='i1'), event('assistant.turn_start', 2),
                event('assistant.message', 3, toolRequests=[{'name': 'bash'}]), event('permission.requested', 4),
                event('assistant.turn_end', 5), event('assistant.turn_start', 6), event('assistant.message', 7, toolRequests=[]),
                event('assistant.turn_end', 8), event('user.message', 9, interactionId='i2', isAutopilotContinuation=True),
                json.dumps({'type': 'user.message', 'agentId': 'sub', 'data': {}}), event('abort', 10)])]
            # Only the turn ending on a reply without tool requests finishes the prompt.
            self.assertEqual(kinds, ['message', 'resume', 'resume', 'approval', 'resume', 'resume', 'complete', 'start', 'interrupted'])
            with log.open('a') as stream: stream.write(line('Unregistering', sid))
            self.assertEqual(providers.copilot_terminals(), [])

    def test_antigravity_conversations_open_while_their_presence_lock_is_held(self):
        import sqlite3
        from agent_bar.providers import Providers
        with tempfile.TemporaryDirectory() as root:
            home, proc = Path(root) / 'home', Path(root) / 'proc'
            for pid, ppid, exe in [(10, 1, '/opt/antigravity-ide/antigravity-ide'), (20, 10, '/opt/antigravity-ide/antigravity-ide'),
                                   (30, 20, f'{home}/.gemini/bin/agy')]:
                (proc / str(pid)).mkdir(parents=True)
                (proc / str(pid) / 'stat').write_text(f'{pid} (x) S {ppid} ' + ' '.join(['0'] * 17) + ' 5 0\n')
                os.symlink(exe, proc / str(pid) / 'exe')
            data = home / '.gemini/antigravity'; (data / 'presence').mkdir(parents=True)
            ids = ['901ba5e2-e772-42b1-b1ef-7391e4906654', '11111111-e772-42b1-b1ef-7391e4906654', '22222222-e772-42b1-b1ef-7391e4906654']
            for cid in ids: (data / 'presence' / f'{cid}.lock').touch()
            inode = lambda cid: (data / 'presence' / f'{cid}.lock').stat().st_ino
            # Open and a subagent conversation, each held by the IDE's agent; the last only waits for a lock.
            (proc / 'locks').write_text(f'1: FLOCK  ADVISORY  WRITE 30 fd:01:{inode(ids[0])} 0 EOF\n'
                                        f'2: FLOCK  ADVISORY  WRITE 30 fd:01:{inode(ids[1])} 0 EOF\n'
                                        f'3: -> FLOCK  ADVISORY  WRITE 30 fd:01:{inode(ids[2])} 0 EOF\n')
            with sqlite3.connect(data / 'conversation_summaries.db') as db:
                db.execute('CREATE TABLE conversation_summaries (conversation_id, title, workspace_uris, status, killed,'
                           ' last_user_input_time, last_modified_time, parent_conversation_id, nesting_depth)')
                row = lambda cid, status, parent='': (cid, 'Audio Connection Test', '["file:///r/my%20repos"]', status, 0,
                                                      '2026-11-04 17:34:07.518246639+00:00', '2026-11-04 17:34:12.454998101+00:00', parent, 0)
                db.executemany('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)',
                               [row(ids[0], 'CASCADE_RUN_STATUS_IDLE'), row(ids[1], 'CASCADE_RUN_STATUS_IDLE', ids[0]),
                                row(ids[2], 'CASCADE_RUN_STATUS_IDLE')])
            providers = Providers(home, str(proc))
            rows, windows, warnings = providers.external([], 1000)
            self.assertEqual(warnings, [])
            [row] = rows
            self.assertEqual((row['key'], row['title'], row['roots'], row['surface_label']),
                             (f'antigravity:{ids[0]}', 'Audio Connection Test', ['/r/my repos'], 'Antigravity IDE'))
            self.assertEqual([(w['kind'], w['label'], w['titles'], w['pids']) for w in windows],
                             [('ide', 'Antigravity IDE', ['my repos - Antigravity IDE'], [30, 20, 10])])
            self.assertEqual([kind for kind, _, _ in providers.events(row)], ['message', 'complete'])
            with sqlite3.connect(data / 'conversation_summaries.db') as db:
                db.execute("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING'")
            self.assertEqual([kind for kind, _, _ in providers.events(row)], ['message', 'resume'])

    def test_tail_holds_partial_line_and_recovers_rotation(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'events'
            path.write_text('one\ntw')
            tail = Tail(path)
            self.assertEqual(tail.read(), ['one'])
            with path.open('a') as stream: stream.write('o\n')
            self.assertEqual(tail.read(), ['two'])
            path.write_text('new\n')
            self.assertEqual(tail.read(), ['new'])
            self.assertEqual(tail.read(), [])

    def test_snapshot_uses_canonical_project_and_rejects_changed_schema(self):
        cells = ['0', '0', '0', '100', 'RUNNING', 'fit [b00001]', '2-2',
                 '4', '8', '10', '10', '50.0', 'date', '100', '', 'queue.txt', 'tag', 'project', '3', '12:19', '1']
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'queues'
            path.write_text('\t'.join(cells) + '\n')
            row = queue_snapshot(path)[0]
            self.assertEqual((row['project'], row['done'], row['total']), ('project', 4, 8))
            self.assertEqual((row['elapsed'], row['ended']), (10, None))
            self.assertEqual((row['failed'], row['failed_at'], row['rerun']), (3, '12:19', 1))
            finished = cells[:4] + ['COMPLETED'] + cells[5:13] + ['160', 'end'] + cells[15:]
            path.write_text('\t'.join(finished) + '\n')
            self.assertEqual(queue_snapshot(path)[0]['ended'], 160)
            path.write_text('\t'.join(cells[:-1]) + '\n')
            with self.assertRaises(ValueError): queue_snapshot(path)

    def test_inventory_counts_typed_prompts_and_rescans_only_appended_lines(self):
        import sqlite3
        from agent_bar.inventory import build
        with tempfile.TemporaryDirectory() as home:
            sid = '11111111-2222-3333-4444-555555555555'
            transcript = Path(home, '.claude/projects/-r-x', f'{sid}.jsonl')
            transcript.parent.mkdir(parents=True)
            human = {'type': 'user', 'promptSource': 'sdk', 'origin': {'kind': 'human'}, 'cwd': '/r/x'}
            lines = [{**human, 'timestamp': '2026-11-01T00:00:00Z'},
                     {'type': 'user', 'promptSource': 'system', 'origin': {'kind': 'task-notification'},
                      'timestamp': '2026-11-01T00:05:00Z'},
                     {'type': 'ai-title', 'aiTitle': 'Generated'}, {'type': 'custom-title', 'customTitle': 'Named'},
                     {'type': 'assistant', 'timestamp': '2026-11-01T02:00:00Z'}]
            transcript.write_text(''.join(json.dumps(x, separators=(',', ':')) + '\n' for x in lines))
            rollout = Path(home, 'rollout.jsonl')
            message = lambda text: json.dumps({'timestamp': '2026-11-02T00:00:00Z', 'type': 'response_item', 'payload': {
                'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': text}]}},
                separators=(',', ':')) + '\n'
            rollout.write_text(message('<environment_context>') + message('# AGENTS.md instructions') + message('hello'))
            Path(home, '.codex').mkdir()
            with sqlite3.connect(Path(home, '.codex/state_5.sqlite')) as db:
                db.execute('CREATE TABLE threads (id, title, name, cwd, created_at, updated_at, rollout_path, archived, source)')
                db.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)', ('c1', 'Codex chat', None, home, 5, 9, str(rollout), 0, 'vscode'))
                db.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)', ('c2', 'Subagent', None, home, 5, 9, str(rollout), 0, '{"subagent":{}}'))
            first = build(home)
            rows = {r['key']: r for r in first['conversations']}
            self.assertEqual(sorted(rows), [f'claude:{sid}', 'codex:c1'])
            claude = rows[f'claude:{sid}']
            self.assertEqual((claude['title'], claude['prompts'], claude['active'], claude['folder']), ('Named', 1, 300, '/r/x'))
            self.assertFalse(claude['available'])
            self.assertEqual((rows['codex:c1']['prompts'], rows['codex:c1']['available']), (1, True))
            with rollout.open('a') as stream: stream.write(message('again') + message('half')[:20])
            second = build(home, first)
            self.assertEqual({r['key']: r for r in second['conversations']}['codex:c1']['prompts'], 2)
            with rollout.open('a') as stream: stream.write(message('half')[20:])
            self.assertEqual({r['key']: r for r in build(home, second)['conversations']}['codex:c1']['prompts'], 3)

    def test_queue_counted_matches_project_counts(self):
        self.ledger.data['project_turns'] = {'p': 150}
        self.ledger.data['queues'] = {
            'old': {'id': 'old', 'project': 'p', 'state': 'COMPLETED', 'finished_at': 120},
            'new': {'id': 'new', 'project': 'p', 'state': 'COMPLETED', 'finished_at': 180},
            'run': {'id': 'run', 'project': 'p', 'state': 'RUNNING', 'finished_at': None}}
        self.assertEqual([q for q, v in self.ledger.data['queues'].items() if self.ledger.counted(v)], ['new', 'run'])
        self.assertEqual(self.ledger.queue_counts(), {'p': {'done': 1, 'total': 2}})

    def test_hook_records_metadata_without_prompt_or_tool_output(self):
        with tempfile.TemporaryDirectory() as root:
            data = {'hook_event_name': 'UserPromptSubmit', 'session_id': 'test-session',
                    'cwd': '/project', 'prompt': '<task-notification>private text</task-notification>'}
            result = subprocess.run([sys.executable, '-m', 'agent_bar.hook'], input=json.dumps(data),
                                    text=True, capture_output=True,
                                    env={**os.environ, 'AGENT_BAR_STATE_DIR': root})
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
            events = list((Path(root) / 'events').glob('*.json'))
            self.assertEqual(len(events), 1)
            text = events[0].read_text()
            self.assertNotIn('private text', text)
            self.assertEqual(json.loads(text)['kind'], 'start')
            events[0].unlink()
            data['prompt'] = 'Another Claude session sent a message:\n<agent-message from="a1">report</agent-message>'
            subprocess.run([sys.executable, '-m', 'agent_bar.hook'], input=json.dumps(data), text=True,
                           env={**os.environ, 'AGENT_BAR_STATE_DIR': root}, check=True)
            self.assertEqual(json.loads(next((Path(root) / 'events').glob('*.json')).read_text())['kind'], 'start')
            # A question is only a question, even as a permission request, and the answer acknowledges it.
            for event, kind in [('PreToolUse', 'question'), ('PermissionRequest', 'question'), ('PostToolUse', 'message')]:
                for path in (Path(root) / 'events').glob('*.json'): path.unlink()
                subprocess.run([sys.executable, '-m', 'agent_bar.hook'], text=True, check=True,
                               input=json.dumps({'hook_event_name': event, 'session_id': 's', 'tool_name': 'AskUserQuestion'}),
                               env={**os.environ, 'AGENT_BAR_STATE_DIR': root})
                self.assertEqual(json.loads(next((Path(root) / 'events').glob('*.json')).read_text())['kind'], kind)


if __name__ == '__main__': unittest.main()
