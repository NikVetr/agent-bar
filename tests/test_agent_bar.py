import contextlib
import datetime
import io
import json
import tempfile
import unittest
import unittest.mock
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from agent_bar.state import Ledger, project_names
from agent_bar.providers import Background, Tail, queue_snapshot


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.ledger = Ledger({'since': 100, 'conversations': {}, 'queues': {}, 'project_turns': {}})

    def test_host_projects_uses_reservations_and_sampled_memory(self):
        from agent_bar.cluster import host_projects
        with tempfile.TemporaryDirectory() as root:
            report = Path(root) / '.parallel-workers/adaptive/last-known/node.tsv'
            report.parent.mkdir(parents=True)
            updated = int(time.time())
            header = 'record_type pool_id host_id resource_sample_epoch telemetry_state queue_id state cpu_units current_memory_mib'
            lines = [header, f'agent pool node {updated} ok - - - -',
                     'reservation pool node - - a running 3 150', 'reservation pool node - - b running 1 50',
                     'reservation pool node - - c uncertain 2 0']
            report.write_text('\n'.join(line.replace(' ', '\t') for line in lines))
            snapshot = {'updated': updated, 'collector': {'local_host': 'node'},
                        'hosts': [{'id': 'node', 'ok': True, 'mount': {'ok': True, 'root': root},
                                   'slots': None, 'memory': {'total_bytes': 2**30}}],
                        'scheduler': {'ok': True, 'pool': {'id': 'pool'}, 'hosts': [{'id': 'node', 'cpu_units': 8}], 'queues': [
                            {'queue_id': 'a', 'project': 'one'}, {'queue_id': 'b', 'project': 'one'},
                            {'queue_id': 'c', 'project': 'two'}]}}
            result = host_projects('node', snapshot)
            self.assertEqual(result['cpu_slots'], 8)
            self.assertEqual(result['projects'], [
                {'project': 'one', 'jobs': 2, 'cpu_slots': 4, 'memory_mib': 200},
                {'project': 'two', 'jobs': 1, 'cpu_slots': 2, 'memory_mib': None}])
            with unittest.mock.patch('time.time', return_value=updated + 300), self.assertRaisesRegex(ValueError, 'node report is stale'):
                host_projects('node', {**snapshot, 'updated': updated + 300})
            snapshot['scheduler']['pool']['id'] = 'new'
            with self.assertRaisesRegex(ValueError, 'current pool'):
                host_projects('node', snapshot)

    def test_host_projects_fixed_slots_follow_host_order(self):
        from agent_bar.cluster import host_projects
        now = time.time()
        snapshot = {'updated': now, 'scheduler': {'ok': True, 'pool': {'state': 'INACTIVE'}},
                    'hosts': [{'id': name, 'ok': True, 'slots': 8} for name in ['b', 'a']],
                    'queue_refresh': {'ok': True, 'updated': now}, 'queues': [
                        {'group': 'active', 'workers': '2-3', 'project': 'test'},
                        {'group': 'active', 'workers': '0-?', 'project': 'missing'},
                        {'group': 'finished', 'workers': '3-3', 'project': 'old'}]}
        result = host_projects('a', snapshot)
        self.assertEqual(result['projects'], [{'project': 'test', 'jobs': 0, 'fixed_slots': 3,
                                              'cpu_slots': 3, 'memory_mib': None}])
        self.assertTrue(result['incomplete_fixed_slots'])

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

    def test_a_usage_limit_stop_marks_the_chat_until_its_next_turn_and_continue_goes_by_provider(self):
        import asyncio
        from agent_bar import messages, service
        from agent_bar.providers import Providers
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            # Claude Code's StopFailure, with the API error that ends the transcript naming the reset.
            transcript = root / 'a.jsonl'
            transcript.write_text(json.dumps({'type': 'user', 'message': {}}) + '\n' + json.dumps(
                {'type': 'assistant', 'isApiErrorMessage': True, 'error': 'rate_limit', 'quotaLimits': {'resetsAt': 1794106800}}) + '\n')
            subprocess.run([sys.executable, '-m', 'agent_bar.hook'], text=True, check=True, input=json.dumps(
                {'hook_event_name': 'StopFailure', 'session_id': 'a', 'error': 'rate_limit', 'transcript_path': str(transcript)}),
                env={**os.environ, 'AGENT_BAR_STATE_DIR': str(root / 'state')})
            event = json.loads(next((root / 'state/events').glob('*.json')).read_text())
            self.assertEqual((event['kind'], event['resets']), ('limit', 1794106800))
            # Codex ends the turn with the limit as its error.
            rollout = root / 'rollout.jsonl'
            rollout.write_text(json.dumps({'type': 'event_msg', 'timestamp': '2026-11-07T23:24:53.689Z', 'payload': {
                'type': 'task_complete', 'turn_id': 't1', 'error': {'codex_error_info': 'usage_limit_exceeded'}}}) + '\n')
            [(kind, _, turn)] = Providers(root).events({'provider': 'codex', 'key': 'codex:b', 'id': 'b', 'path': str(rollout)})
            self.assertEqual((kind, turn), ('limit', 't1'))
        self.ledger.event('claude:a', 'message', 110)
        self.ledger.event('claude:a', 'limit', 120, None, 1794106800)
        self.assertEqual(self.ledger.conversation('claude:a')['limited'], {'at': 120, 'resets': 1794106800})
        self.assertEqual((self.ledger.conversation('claude:a')['state'], self.ledger.unread('claude:a')), ('failed', ['Turn failed']))
        self.ledger.event('claude:a', 'message', 130)
        self.assertNotIn('limited', self.ledger.conversation('claude:a'))
        # A limit stop from before the latest turn started, read again later, does not come back.
        self.ledger.event('claude:a', 'limit', 115)
        self.assertNotIn('limited', self.ledger.conversation('claude:a'))
        # Continuing: Codex gets the note queued, a Claude chat gets the text back to paste, and nothing else qualifies.
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        tracker = service.Tracker(state.name)
        tracker.ledger = self.ledger
        tab = {'kind': 'tab'}
        tracker.rows = [{'key': 'claude:a', 'provider': 'claude', 'id': 'a', 'target': tab},
                        {'key': 'codex:b', 'provider': 'codex', 'id': 'b', 'target': {'kind': 'codex-sidebar'}},
                        {'key': 'codex:c', 'provider': 'codex', 'id': 'c', 'target': {'kind': 'window'}}]
        for key in ['claude:a', 'codex:b', 'codex:c']: self.ledger.event(key, 'limit', 140)
        queued = []
        with unittest.mock.patch.object(messages, 'codex_queue', lambda thread, text: queued.append((thread, text))):
            self.assertEqual(asyncio.run(tracker.go_on('claude:a')), {'ok': True, 'paste': service.CONTINUE})
            self.assertEqual(asyncio.run(tracker.go_on('codex:b')), {'ok': True, 'queued': True})
            with self.assertRaisesRegex(ValueError, 'not open in VS Code'): asyncio.run(tracker.go_on('codex:c'))
            self.ledger.event('codex:b', 'start', 150)
            with self.assertRaisesRegex(ValueError, 'No usage limit'): asyncio.run(tracker.go_on('codex:b'))
        self.assertEqual(queued, [('b', service.CONTINUE)])

    def test_codex_five_hour_reset_queues_once_for_the_same_open_thread(self):
        import asyncio
        from agent_bar import messages, service
        with tempfile.TemporaryDirectory() as root:
            tracker = service.Tracker(root)
            rollout = Path(root) / 'thread.jsonl'
            row = {'provider': 'codex', 'key': 'codex:a', 'id': 'a', 'path': str(rollout),
                   'target': {'kind': 'codex-editor'}}
            now = int(time.time())
            reset = now + 40
            def append(kind, at, **data):
                with rollout.open('a') as out:
                    out.write(json.dumps({'timestamp': at, 'type': 'event_msg', 'payload': {'type': kind, **data}}) + '\n')
            def read():
                for event in tracker.providers.events(row): tracker.ledger.event(row['key'], *event)
            def deliver(at):
                with unittest.mock.patch('time.time', return_value=at): asyncio.run(tracker.resume_due_codex())
            append('task_started', now, turn_id='one')
            append('token_count', now + 1, rate_limits={'primary': {'used_percent': 100, 'window_minutes': 300,
                                                                   'resets_at': reset}})
            read()
            append('token_count', now + 2, rate_limits={'limit_id': 'premium', 'primary': None})
            append('task_complete', now + 3, turn_id='one', error={'codex_error_info': 'usage_limit_exceeded'})
            read()
            self.assertEqual(tracker.ledger.conversation('codex:a')['limited']['resets'], reset)
            tracker.rows = [row]
            with unittest.mock.patch.object(messages, 'codex_queue') as queue:
                deliver(reset)  # Off.
                tracker.resume_codex = True
                deliver(reset - 1)
                tracker.rows = []
                deliver(reset)
                queue.assert_not_called()
                tracker.rows = [row, row]
                deliver(reset)
                queue.assert_called_once_with('a', 'Continue from where you left off.')
                tracker = service.Tracker(root)
                tracker.rows, tracker.resume_codex = [row], True
                read()  # Replaying the same stop after restarting preserves its delivery.
                deliver(reset + 1)
                asyncio.run(tracker.go_on('codex:a'))
                self.assertEqual(queue.call_count, 1)
                append('task_started', reset + 2, turn_id='two')
                read()
                self.assertNotIn('limited', tracker.ledger.conversation('codex:a'))

    def test_codex_reset_excludes_weekly_credit_and_unconfirmed_stops(self):
        from agent_bar.providers import Providers
        window = {'used_percent': 100, 'window_minutes': 300, 'resets_at': 190}
        weekly = {**window, 'window_minutes': 10080, 'resets_at': 600}
        for rates, message in [
            ({'primary': weekly}, ''), ({'primary': window, 'secondary': weekly}, ''),
            ({'primary': window, 'rate_limit_reached_type': 'workspace_member_credits_depleted'}, ''),
            ({'primary': window}, 'Your workspace is out of credits.'), ({}, ''),
            ({'primary': {**window, 'used_percent': 99}}, ''), ({'primary': {**window, 'resets_at': 50}}, ''),
        ]:
            with self.subTest(rates=rates, message=message), tempfile.TemporaryDirectory() as root:
                rollout = Path(root) / 'thread.jsonl'
                events = [{'type': 'token_count', 'rate_limits': rates},
                          {'type': 'task_complete', 'error': {'codex_error_info': 'usage_limit_exceeded', 'message': message}}]
                rollout.write_text(''.join(json.dumps({'timestamp': 100, 'type': 'event_msg', 'payload': p}) + '\n' for p in events))
                self.assertEqual(Providers(root).events({'provider': 'codex', 'key': 'codex:a', 'path': str(rollout)}),
                                 [('limit', 100, None)])

    def test_codex_continuation_retry_and_cancellation(self):
        import asyncio
        from agent_bar import messages, service
        with tempfile.TemporaryDirectory() as root:
            tracker = service.Tracker(root)
            tracker.resume_codex = True
            key = 'codex:a'
            tracker.rows = [{'provider': 'codex', 'id': 'a', 'key': key, 'target': {'kind': 'tab'}}]
            tracker.ledger.event(key, 'limit', 100, 'one', 115)
            def run(at):
                with unittest.mock.patch('time.time', return_value=at):
                    asyncio.run(tracker.resume_due_codex())
            with unittest.mock.patch.object(messages, 'codex_queue', side_effect=ValueError('unavailable')) as queue:
                run(115)
                run(116)
                self.assertEqual(queue.call_count, 1)
                tracker.ledger.event(key, 'start', 125, 'two')
                run(180)
                self.assertEqual(queue.call_count, 1)
                tracker.ledger.event(key, 'limit', 190, 'two', 200)
                uncertain = ValueError('queue timed out')
                uncertain.__cause__ = subprocess.TimeoutExpired('codex queue', 30)
                queue.side_effect = uncertain
                run(200)
                run(300)
                self.assertEqual(queue.call_count, 2)
                queue.side_effect = None
                asyncio.run(tracker.go_on(key))
                run(310)
                self.assertEqual(queue.call_count, 3)

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

    def test_codex_review_follows_the_current_turn(self):
        key = 'codex:a'
        self.ledger.event(key, 'complete', 110, 'one')
        self.ledger.event(key, 'start', 130, 'two')
        self.ledger.event(key, 'complete', 131, 'one')  # A late hook for the old reply.
        self.ledger.event(key, 'approval', 122, 'one')
        self.assertEqual(self.ledger.conversation(key)['state'], 'working')
        self.assertEqual(self.ledger.pending(key, 128), {'Queues finished': 128})
        self.ledger.event(key, 'complete', 140, 'two')
        self.assertEqual(self.ledger.pending(key), {'Reply finished': 140})

    def test_codex_approval_must_still_be_pending_to_raise_the_button(self):
        from agent_bar import service
        with tempfile.TemporaryDirectory() as root:
            tracker = service.Tracker(root)
            tracker.rows = [{'key': 'codex:a', 'id': 'a', 'provider': 'codex', 'project': 'p', 'roots': []}]
            tracker.ledger = self.ledger
            def unread(at):
                with unittest.mock.patch('time.time', return_value=at):
                    return tracker.snapshot()['rows'][0]['unread']
            self.ledger.event('codex:a', 'approval', 115)
            self.assertEqual(unread(118), [])
            self.ledger.event('codex:a', 'resume', 119)
            self.assertEqual(unread(130), [])
            self.ledger.event('codex:a', 'approval', 140)
            self.assertEqual(unread(140 + service.CODEX_APPROVAL_GRACE), ['Approval needed'])
            self.ledger.event('codex:a', 'complete', 158)
            self.assertEqual(unread(158), ['Reply finished'])

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

    def test_clearing_a_projects_queues_drops_only_its_finished_ones(self):
        import asyncio
        from agent_bar.service import Tracker
        with tempfile.TemporaryDirectory() as root:
            tracker = Tracker(root)
            for id, state in [('a', 'COMPLETED'), ('b', 'RUNNING')]:
                tracker.ledger.queue({'id': id, 'project': 'code', 'state': state}, 100)
            asyncio.run(tracker.dispatch({'op': 'clear-queues', 'project': 'code'}))
            self.assertEqual(tracker.ledger.queue_counts(), {'code': {'done': 0, 'total': 1}})
            with self.assertRaises(ValueError): asyncio.run(tracker.dispatch({'op': 'clear-queues', 'project': 'other'}))

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
            # The guard's behavior, at a limit of three.
            with unittest.mock.patch.object(messages, 'SETTINGS', root / 'settings.json'), unittest.mock.patch.object(messages, 'PEER_LIMIT', 3):
                self.assertIsNone(messages.notice('codex:b', root))
                for n in range(3):
                    self.assertEqual(messages.send('claude:a', 'codex:b', f'note {n}', root, now=200 + n)['remaining'], 2 - n)
                with self.assertRaisesRegex(ValueError, 'Not sent. Loop guard.*does not lift with time'):
                    messages.send('claude:a', 'codex:b', 'more', root, now=210)
                for bad in ['claude:a', 'codex:gone']:
                    with self.assertRaises(ValueError): messages.send('claude:a', bad, 'x', root, now=211)
                self.assertIn('3 unread messages', messages.notice('codex:b', root) or '')
                self.assertIn('"Fix login"', messages.notice('codex:b', root) or '')
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
            with unittest.mock.patch.object(messages, 'SETTINGS', root / 'settings.json'), unittest.mock.patch.object(messages, 'PEER_LIMIT', 3):
                for n in range(3): messages.send('claude:a', 'claude:b', f'm{n}', root, now=100 + n)
                for n in range(2):
                    with self.assertRaises(ValueError): messages.send('claude:a', 'claude:b', 'more', root, now=110 + n)
                self.assertEqual(messages.summary(root, now=120)['held'], [{'sender': 'claude:a', 'recipient': 'claude:b', 'refused': 2}])
                # A human prompt to the sender after the holds also lifts them.
                self.assertEqual(messages.summary(root, {'claude:a': 115}, now=120)['held'], [])
                messages.reset_limit('claude:b', 'claude:a', root, now=130)
                self.assertEqual(messages.summary(root, now=131)['held'], [])
                self.assertTrue(messages.send('claude:a', 'claude:b', 'after reset', root, now=140)['ok'])

    def test_the_hourly_cap_says_when_sending_resumes(self):
        from agent_bar import messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            rows = [{'key': f'claude:{n}', 'provider': 'claude', 'title': str(n), 'project': 'p', 'state': 'finished'} for n in range(12)]
            (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            with unittest.mock.patch.object(messages, 'SETTINGS', root / 'settings.json'):
                # Ten chats, one message each: the per-pair limit is not reached, the hourly one is.
                for n in range(1, 11): messages.send('claude:0', f'claude:{n}', 'hi', root, now=1000 + n * 60)
                with self.assertRaisesRegex(ValueError, r'10 messages sent in the last hour\. Sending resumes in about 41 minutes'):
                    messages.send('claude:0', 'claude:11', 'one more', root, now=1000 + 20 * 60)

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
                old = time.time() - 8 * 86400
                os.utime(messages.wake_files('claude:live', root)[2], (old, old))
                self.assertEqual(messages.stranded(unread, rows, root), ['codex:c', 'claude:idle', 'claude:live', 'claude:used'])

    def test_no_waiter_holds_a_headless_claude_session_open(self):
        from agent_bar import hook, messages
        with tempfile.TemporaryDirectory() as root, unittest.mock.patch.object(messages, 'SETTINGS', Path(root) / 'settings.json'):
            (Path(root) / 'settings.json').write_text(json.dumps({'wake': True}))
            for entrypoint in ['sdk-cli', 'sdk-py']:
                with unittest.mock.patch.dict(os.environ, {'CLAUDE_CODE_ENTRYPOINT': entrypoint, 'AGENT_BAR_STATE_DIR': root}):
                    started = time.time()
                    self.assertIsNone(hook.wait({'session_id': 's', 'hook_event_name': 'Stop'}))
                    self.assertLess(time.time() - started, 1)
            with unittest.mock.patch.dict(os.environ, {'CLAUDE_CODE_ENTRYPOINT': 'claude-vscode'}):
                self.assertFalse(hook.headless())

    def test_waking_queues_one_note_for_a_codex_chat_open_in_vs_code(self):
        from agent_bar import hook, messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            row = lambda key, kind: {'key': key, 'provider': key.split(':')[0], 'title': key, 'project': 'p',
                                     'state': 'finished', 'target': {'kind': kind}}
            rows = [row('claude:a', 'tab'), row('codex:v', 'codex-sidebar'), row('codex:t', 'window')]
            (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            settings, calls = root / 'settings.json', []
            run = lambda command, **_: calls.append(command) or subprocess.CompletedProcess(command, 0, 'Queued', '')
            with unittest.mock.patch.object(messages, 'SETTINGS', settings), \
                    unittest.mock.patch.object(shutil, 'which', lambda name: '/bin/codex'), \
                    unittest.mock.patch.object(subprocess, 'run', run), \
                    unittest.mock.patch.dict(os.environ, {'AGENT_BAR_STATE_DIR': str(root)}):
                self.assertEqual(messages.send('claude:a', 'codex:v', 'one', root)['delivery'], 'at its next turn')
                settings.write_text(json.dumps({'wake': True}))
                self.assertEqual(messages.send('claude:a', 'codex:v', 'two', root)['delivery'], 'by a queued wake-up turn')
                [command] = calls
                self.assertEqual(command[1:4], ['queue', '--thread', 'v'])
                self.assertTrue(command[-1].startswith('<agent-message>[agent-bar] 2 unread messages'))
                # One note at a time; it reports every unread message once its turn starts.
                self.assertEqual(messages.send('claude:a', 'codex:v', 'three', root)['delivery'], 'with the wake-up already queued')
                self.assertEqual(messages.stranded({'codex:v': 3}, rows, root), [])
                # Codex elsewhere than VS Code is not woken.
                self.assertEqual(messages.send('claude:a', 'codex:t', 'x', root)['delivery'], 'at its next turn')
                self.assertEqual(len(calls), 1)
                # The note's turn starts: no longer pending, so unread messages left after it strand.
                with unittest.mock.patch('sys.argv', ['hook', 'codex']), unittest.mock.patch('sys.stdin', io.StringIO(json.dumps(
                        {'hook_event_name': 'UserPromptSubmit', 'session_id': 'v', 'prompt': command[-1]}))):
                    hook.main()
                self.assertFalse(messages.codex_pending('codex:v', root))
                self.assertEqual(messages.stranded({'codex:v': 3}, rows, root), ['codex:v'])

    def test_a_codex_chat_in_a_turn_is_woken_after_it_only_for_messages_still_unread(self):
        from agent_bar import hook, messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            snapshot = root / 'snapshot.json'
            state = lambda value: snapshot.write_text(json.dumps({'rows': [
                {'key': 'claude:a', 'provider': 'claude', 'title': 'A', 'project': 'p', 'state': 'finished', 'target': {'kind': 'tab'}},
                {'key': 'codex:v', 'provider': 'codex', 'title': 'V', 'project': 'p', 'state': value, 'target': {'kind': 'codex-sidebar'}}]}))
            state('working')
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            settings, calls = root / 'settings.json', []
            settings.write_text(json.dumps({'wake': True}))
            run = lambda command, **_: calls.append(command) or subprocess.CompletedProcess(command, 0, 'Queued', '')
            with unittest.mock.patch.object(messages, 'SETTINGS', settings), \
                    unittest.mock.patch.object(shutil, 'which', lambda name: '/bin/codex'), \
                    unittest.mock.patch.object(subprocess, 'run', run), \
                    unittest.mock.patch.dict(os.environ, {'AGENT_BAR_STATE_DIR': str(root)}):
                def turn(text):
                    output = io.StringIO()
                    with unittest.mock.patch('sys.argv', ['hook', 'codex']), unittest.mock.patch('sys.stdin', io.StringIO(json.dumps(
                            {'hook_event_name': 'UserPromptSubmit', 'session_id': 'v', 'prompt': text}))), \
                            contextlib.redirect_stdout(output):
                        hook.main()
                    return output.getvalue()
                # Mid-turn, nothing is queued yet; the chat does not strand meanwhile.
                self.assertEqual(messages.send('claude:a', 'codex:v', 'one', root)['delivery'], 'by a wake-up turn after its current turn')
                self.assertEqual(calls, [])
                self.assertEqual(messages.stranded({'codex:v': 1}, json.loads(snapshot.read_text())['rows'], root), [])
                messages.deliver_deferred(root)
                self.assertEqual(calls, [])  # Still in its turn.
                state('finished')
                messages.deliver_deferred(root)
                [command] = calls
                self.assertIn('1 unread message', command[-1])
                self.assertEqual(messages.deferred(root), [])
                # Read during the turn: no note once it ends.
                turn(command[-1])
                state('working')
                messages.send('claude:a', 'codex:v', 'two', root)
                messages.inbox('codex:v', root)
                state('finished')
                messages.deliver_deferred(root)
                self.assertEqual(len(calls), 1)
                # A note that arrives after its messages were read says so.
                messages.send('claude:a', 'codex:v', 'three', root)
                self.assertEqual(len(calls), 2)
                messages.inbox('codex:v', root)
                self.assertIn('already been read', turn(calls[-1][-1]))
                # A note queued but never run on its own no longer holds back the next once a turn of the user's starts.
                # (The sender's user writes to it first, as the loop guard allows three messages between their prompts.)
                (root / 'ledger.json').write_text(json.dumps({'conversations': {'claude:a': {'human_at': time.time()}}}))
                messages.send('claude:a', 'codex:v', 'four', root)
                self.assertTrue(messages.codex_pending('codex:v', root))
                self.assertIn('1 unread message', turn('what is new?'))
                self.assertFalse(messages.codex_pending('codex:v', root))

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

    def test_info_merges_skills_and_reads_instructions(self):
        from agent_bar import info
        with tempfile.TemporaryDirectory() as root:
            home, state = Path(root) / 'home', Path(root) / 'state'
            for folder, name in [('.claude/skills', 'plot'), ('.agents/skills', 'plot'), ('.claude/skills/synced/x', 'pdf')]:
                (home / folder / name).mkdir(parents=True)
                (home / folder / name / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: Does {name}.\n---\n\n# {name}\n')
            (home / '.claude.json').write_text(json.dumps({'skillUsage': {'plot': {'usageCount': 3, 'lastUsedAt': 5000}}}))
            project = home / 'repos/demo/sub'; project.mkdir(parents=True)
            (home / 'repos/demo/AGENTS.md').write_text('rules')
            state.mkdir()
            (state / 'snapshot.json').write_text(json.dumps({'windows': [{'roots': [str(project)]}], 'rows': []}))
            (state / 'ledger.json').write_text(json.dumps({'conversations': {'claude:a': {'hook_seen': 70}, 'codex:b': {}}}))
            result = info.collect(state, home)
            self.assertEqual([(s['name'], s['providers'], s['synced'], s['uses']) for s in result['skills']],
                             [('plot', ['claude', 'codex'], False, 3), ('pdf', ['claude.ai'], True, 0)])
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

    def test_a_finished_queue_reported_active_again_without_progress_stays_finished(self):
        def queue(state, at, id='q', done=9, workers='0-0-0 P50 CLOSED'):
            self.ledger.queue({'id': id, 'project': 'demo', 'state': state, 'done': done, 'total': 10, 'failed': 1, 'rerun': 0,
                               'workers': workers, 'ended': at if state != 'DRAINING' else None}, at)
        queue('RUNNING', 101, done=5, workers='2-1-0 P50')
        queue('FINISHED_INCOMPLETE', 110)
        self.ledger.data['project_turns']['demo'] = 120  # Cleared, or a turn there.
        # parallel-workers flips it to DRAINING and back with nothing running or done: the same finish, still seen.
        for at in [130, 140, 150]: queue('DRAINING' if at == 140 else 'FINISHED_INCOMPLETE', at)
        record = self.ledger.data['queues']['q']
        self.assertEqual((record['state'], record['finished_at']), ('FINISHED_INCOMPLETE', 110))
        self.assertEqual((self.ledger.queue_counts(), self.ledger.queues_finished()), ({}, {}))
        # A rerun reopens it, even with nothing done yet; finishing again needs review.
        queue('RUNNING', 160, workers='1-0-0 P50')
        self.assertEqual(self.ledger.queue_counts(), {'demo': {'done': 0, 'total': 1}})
        queue('COMPLETED', 170, done=10)
        self.assertEqual(self.ledger.queues_finished(), {'demo': 170})
        # A rerun inside one monitor refresh still shows as new counts.
        self.ledger.data['project_turns']['demo'] = 180
        queue('COMPLETED', 190, done=10, id='r')
        self.ledger.queue({**self.ledger.data['queues']['r'], 'total': 12, 'done': 12}, 200)
        self.assertEqual(self.ledger.queues_finished(), {'demo': 200})
        # A queue the monitor dropped for a refresh and lists again is running, not finished.
        self.ledger.data['project_turns']['demo'] = 210
        queue('RUNNING', 211, id='u', workers='1-0-0 P50')
        self.ledger.unlisted(set(), 220)
        queue('RUNNING', 230, id='u', workers='1-0-0 P50')
        self.assertEqual(self.ledger.data['queues']['u']['finished_at'], None)

    def test_queue_counts_and_queues_finished_agree_on_when_a_queue_ended(self):
        self.ledger.queue({'id': 'q', 'project': 'demo', 'state': 'RUNNING'}, 50)
        # The agent woken by the queue's end (100) starts a turn before the tracker sees the end (120).
        self.ledger.data['project_turns']['demo'] = 110
        self.ledger.queue({'id': 'q', 'project': 'demo', 'state': 'COMPLETED', 'ended': 100}, 120)
        self.assertEqual((self.ledger.queue_counts(), self.ledger.queues_finished()), ({}, {}))

    def test_a_completion_after_activity_is_new_even_without_its_turn_start(self):
        self.ledger.event('claude:a', 'message', 110)
        self.ledger.event('claude:a', 'complete', 120)
        self.ledger.acknowledge('claude:a', 125)
        # An automatic turn whose start never arrived: tools ran, then it stopped again.
        self.ledger.event('claude:a', 'resume', 130)
        self.ledger.event('claude:a', 'complete', 140)
        self.assertEqual(self.ledger.unread('claude:a'), ['Reply finished'])
        self.ledger.event('claude:a', 'question', 150)
        self.assertEqual(self.ledger.pending('claude:a', 145), {'Reply finished': 140, 'Input needed': 150, 'Queues finished': 145})

    def test_prompts_are_automatic_only_when_they_begin_as_one(self):
        from agent_bar.hook import automatic
        from agent_bar.providers import Providers
        for prompt in ['<task-notification>\n<summary>done</summary>', '  <agent-message>[agent-bar] 1 unread',
                       'Another Claude session sent a message: <agent-message from="x">', 'Continue from where you left off.']:
            self.assertTrue(automatic(prompt), prompt)
        for prompt in ['why does <system-reminder> show here?', '<pasted_content>log: <task-notification>', 'Continue from where you left off. Then stop.']:
            self.assertFalse(automatic(prompt), prompt)
        # Codex's rollout records a queued note as a user message; no person wrote it.
        with tempfile.TemporaryDirectory() as root:
            rollout = Path(root) / 'rollout.jsonl'
            rollout.write_text(''.join(json.dumps({'timestamp': f'2026-11-10T00:00:0{n}Z', 'type': 'event_msg', 'payload': {
                'type': 'user_message', 'message': text}}) + '\n' for n, text in enumerate(['fix it', '<agent-message>[agent-bar] 1 unread'])))
            kinds = [kind for kind, _, _ in Providers(root).events({'provider': 'codex', 'key': 'codex:a', 'id': 'a', 'path': str(rollout)})]
            self.assertEqual(kinds, ['message', 'start'])

    def test_broken_inputs_are_reported_without_stopping_the_snapshots(self):
        from agent_bar import messages, service
        from agent_bar.providers import Providers
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / 'proc').mkdir()
            settings, queues = root / 'settings.json', root / 'parallel-workers/queue-progress.tsv'
            queues.parent.mkdir()
            with unittest.mock.patch.object(service, 'SETTINGS', settings), unittest.mock.patch.object(messages, 'SETTINGS', settings), \
                    unittest.mock.patch.object(service, 'QUEUES', queues):
                tracker = service.Tracker(root / 'state')
                tracker.providers = Providers(root, str(root / 'proc'))
                bad = root / 'state/events/bad.json'
                bad.write_text(json.dumps({'provider': 'gemini', 'session': 's', 'kind': 'start', 'at': 1}))
                queues.write_text('')  # The monitor lists no queues: a fresh snapshot all the same.
                settings.write_text('[]')
                tracker.collect()
                warnings = json.loads((root / 'state/snapshot.json').read_text())['warnings']
                self.assertFalse(bad.exists())
                self.assertTrue(any('discarded' in w for w in warnings) and any('not a JSON object' in w for w in warnings))
                self.assertFalse(any('stale' in w for w in warnings))
                # Unread mail makes the snapshot read the wake setting.
                rows = [{'key': key, 'provider': 'claude', 'title': key, 'project': 'p', 'state': 'finished'} for key in ['claude:a', 'claude:b']]
                (root / 'state/snapshot.json').write_text(json.dumps({'rows': rows}))
                settings.write_text('{}')
                messages.send('claude:a', 'claude:b', 'hi', root / 'state')
                settings.write_text('{"wake": true,')
                self.assertIsNone(tracker.message_summary(rows))
                self.assertTrue(any('Agent messages unreadable' in w for w in tracker.warnings))

    def test_message_ids_keep_rising_after_old_ones_are_pruned(self):
        from agent_bar import messages
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            rows = [{'key': key, 'provider': 'claude', 'title': key, 'project': 'p', 'state': 'finished'} for key in ['claude:a', 'claude:b']]
            (root / 'snapshot.json').write_text(json.dumps({'rows': rows}))
            (root / 'ledger.json').write_text(json.dumps({'conversations': {}}))
            with unittest.mock.patch.object(messages, 'SETTINGS', root / 'settings.json'):
                old = [messages.send('claude:a', 'claude:b', f'm{n}', root, now=100 + n)['id'] for n in range(2)]
                messages.inbox('claude:b', root, now=110)
                self.assertGreater(messages.send('claude:a', 'claude:b', 'much later', root, now=110 + messages.KEEP + 1)['id'], max(old))
            self.assertEqual((root / 'messages.sqlite').stat().st_mode & 0o777, 0o600)

    def test_claude_limits_include_scoped_models_and_their_share(self):
        from agent_bar import usage
        with tempfile.TemporaryDirectory() as home:
            limits = [{'kind': 'session', 'group': 'session', 'percent': 21, 'resets_at': '2026-11-12T01:40:00+00:00', 'is_active': False},
                      {'kind': 'weekly_all', 'group': 'weekly', 'percent': 88, 'resets_at': '2026-11-15T03:00:00+00:00', 'is_active': False},
                      {'kind': 'weekly_scoped', 'group': 'weekly', 'percent': 100, 'resets_at': '2026-11-15T02:59:59+00:00',
                       'scope': {'model': {'display_name': 'Fable'}}, 'is_active': True}]
            (Path(home) / '.claude.json').write_text(json.dumps({'cachedUsageUtilization': {'fetchedAtMs': 9000, 'utilization': {
                'limits': limits, 'weekly_scoped_shares': [{'limit_index': 2, 'used_percent_of_weekly': 50, 'allowance_percent_of_weekly': 50}]}}}))
            found = usage.claude(Path(home))
            self.assertEqual(found['as_of'], 9)
            self.assertEqual([(l['key'], l['name'], l['percent'], l['window'], l['limiting']) for l in found['limits']],
                             [('session', '5-hour', 21, 18000, False), ('weekly', 'Weekly', 88, 604800, False),
                              ('weekly:Fable', 'Weekly · Fable', 100, 604800, True)])
            self.assertEqual(found['limits'][2]['share'], {'used': 50, 'allowance': 50})
            # Older caches name only the two windows.
            (Path(home) / '.claude.json').write_text(json.dumps({'cachedUsageUtilization': {'fetchedAtMs': 9000, 'utilization': {
                'five_hour': {'utilization': 26, 'resets_at': '2026-11-04T18:30:00+00:00'}, 'seven_day': {'utilization': 33}}}}))
            self.assertEqual([(l['key'], l['percent']) for l in usage.claude(Path(home))['limits']], [('session', 26), ('weekly', 33)])

    def test_claude_reads_are_opt_in_never_renew_the_sign_in_and_wait_longer_after_failures(self):
        from agent_bar import usage
        import urllib.error
        with tempfile.TemporaryDirectory() as root:
            home, state = Path(root) / 'home', Path(root) / 'state'
            (home / '.claude').mkdir(parents=True); state.mkdir()
            now = 1_800_000_000.0
            credentials = home / '.claude/.credentials.json'
            credentials.write_text(json.dumps({'claudeAiOauth': {'accessToken': 'secret', 'expiresAt': (now + 3600) * 1000}}))
            reading = {'limits': [{'kind': 'weekly_all', 'group': 'weekly', 'percent': 99, 'resets_at': '2027-01-15T03:00:00+00:00'}]}
            sent = []

            class Answer(io.BytesIO):
                def __enter__(self): return self
                def __exit__(self, *_): return False

            def opened(request, timeout):
                sent.append((request.full_url, request.get_header('Authorization'), timeout))
                return Answer(json.dumps(reading).encode())
            with unittest.mock.patch('urllib.request.urlopen', opened):
                usage.refresh(home, state, now=now)
                self.assertEqual(sent, [])  # Off unless the user turns it on.
                summary = usage.refresh(home, state, now=now, fetch=True)
                self.assertEqual(sent, [(usage.USAGE_URL, 'Bearer secret', 10)])
                self.assertEqual(summary['claude']['limits'][0]['percent'], 99)
                self.assertEqual((summary['claude']['as_of'], summary['claude']['fetch']['ok']), (now, True))
                usage.refresh(home, state, now=now + 60, fetch=True)
                self.assertEqual(len(sent), 1)  # Not again until FETCH_EVERY has passed.
                # An expired sign-in is left for Claude Code to renew, and nothing is sent.
                credentials.write_text(json.dumps({'claudeAiOauth': {'accessToken': 'secret', 'expiresAt': now * 1000}}))
                summary = usage.refresh(home, state, now=now + usage.FETCH_EVERY, fetch=True)
                self.assertEqual(len(sent), 1)
                self.assertIn('expired', summary['claude']['fetch']['error'])
                self.assertEqual(summary['claude']['limits'][0]['percent'], 99)  # The last reading stays.
            credentials.write_text(json.dumps({'claudeAiOauth': {'accessToken': 'secret', 'expiresAt': (now + 86400) * 1000}}))

            def refused(request, timeout):
                raise urllib.error.HTTPError(request.full_url, 401, 'Unauthorized', {}, None)
            with unittest.mock.patch('urllib.request.urlopen', refused):
                waits = []
                # The expired sign-in already doubled the wait to 20 minutes; each refusal doubles it, up to an hour.
                at = usage.load(state)['fetch']['next']
                for _ in range(3):
                    fetch = usage.refresh(home, state, now=at, fetch=True)['claude']['fetch']
                    waits.append(fetch['next'] - at)
                    at = fetch['next']
                self.assertIn('refused', fetch['error'])
                self.assertEqual(waits, [2400, 3600, 3600])

    def test_codex_limit_history_reads_new_rollout_lines_and_keeps_changes(self):
        from agent_bar import usage
        with tempfile.TemporaryDirectory() as root:
            home, state = Path(root) / 'home', Path(root) / 'state'
            state.mkdir()
            rollout = home / '.codex/sessions/2026/11/10/rollout-x.jsonl'; rollout.parent.mkdir(parents=True)
            line = lambda at, percent, resets: json.dumps({'timestamp': at, 'payload': {'rate_limits': {
                'primary': {'used_percent': percent, 'window_minutes': 10080, 'resets_at': resets}, 'secondary': None}}},
                separators=(',', ':')) + '\n'
            now = usage.epoch('2026-11-10T12:00:00Z')
            rollout.write_text(line('2026-11-10T00:00:00Z', 10, now + 86400) + line('2026-11-10T01:00:00Z', 10, now + 86402)
                               + json.dumps({'payload': {'rate_limits': None}}) + '\n' + line('2026-11-10T02:00:00Z', 12, now + 86401))
            usage.refresh(home, state, now=now)
            history = usage.load(state)
            # The reset time drifting by seconds is the same window, so the second reading adds nothing.
            self.assertEqual([row[1] for row in history['series']['codex:weekly']], [10, 12])
            offset = history['offsets'][str(rollout)]
            with rollout.open('a') as stream: stream.write(line('2026-11-10T03:00:00Z', 15, now + 86400) + '{"partial')
            usage.refresh(home, state, now=now)
            history = usage.load(state)
            self.assertEqual([row[1] for row in history['series']['codex:weekly']], [10, 12, 15])
            self.assertGreater(history['offsets'][str(rollout)], offset)
            self.assertEqual(history['current']['codex']['limits'][0]['percent'], 15)
            self.assertEqual(usage.report(state, now=now)['usage']['codex']['limits'][0]['left'], 85)

    def test_limit_summary_projects_the_last_days_pace_and_splits_days_by_scoped_model(self):
        from agent_bar import usage
        resets = usage.epoch('2026-11-15T03:00:00Z')
        start = resets - usage.WEEK
        hour = 3600
        week = {'key': 'weekly', 'name': 'Weekly', 'window': usage.WEEK, 'resets_at': resets, 'limiting': False}
        fable = {'key': 'weekly:Fable', 'name': 'Weekly · Fable', 'window': usage.WEEK, 'resets_at': resets, 'limiting': False}
        as_of = start + 72 * hour
        history = {'current': {'claude': {'as_of': as_of, 'limits': [{**week, 'percent': 40.0}, {**fable, 'percent': 60.0, 'share': {'used': 30.0}}]}},
                   'series': {'claude:weekly': [[start + 20 * hour, 10.0, resets, None], [start + 48 * hour, 18.0, resets, None],
                                                [as_of, 40.0, resets, None]],
                              'claude:weekly:Fable': [[start + 20 * hour, 20.0, resets, 10.0], [as_of, 60.0, resets, 30.0]]}}
        weekly = usage.summary(history, now=as_of + hour)['claude']['limits'][0]
        # 18% a day before, 40% now: 22 points in 24 h.
        self.assertEqual(weekly['pace']['basis'], 'day')
        self.assertAlmostEqual(weekly['pace']['per_hour'], 22 / 24)
        self.assertAlmostEqual(weekly['runs_out_at'], as_of + 60 / (22 / 24) * hour)
        # It runs out before the reset, 96 h away.
        self.assertEqual(weekly['at_reset'], 100.0)
        self.assertEqual(weekly['readings'], 3)
        self.assertAlmostEqual(sum(day['used'] for day in weekly['days']), 40.0)
        parts = [dict(day['parts']) for day in weekly['days']]
        self.assertAlmostEqual(sum(part['Fable'] for part in parts), 30.0)
        self.assertAlmostEqual(sum(part['Other'] for part in parts), 10.0)
        # Without a reading a day back, the pace is since the window began, empty.
        lone = {'current': {'codex': {'as_of': as_of, 'limits': [{**week, 'percent': 36.0}]}}, 'series': {}}
        only = usage.summary(lone, now=as_of)['codex']['limits'][0]
        self.assertEqual((only['pace']['basis'], only['pace']['per_hour']), ('window', 0.5))

    def test_hook_install_edits_a_linked_settings_file_where_it_lives(self):
        from agent_bar import hooks
        with tempfile.TemporaryDirectory() as home, unittest.mock.patch('pathlib.Path.home', return_value=Path(home)):
            real = Path(home) / 'dotfiles/settings.json'; real.parent.mkdir()
            real.write_text(json.dumps({'model': 'opus'}))
            (Path(home) / '.claude').mkdir()
            link = Path(home) / '.claude/settings.json'; link.symlink_to(real)
            hooks.install('claude')
            self.assertTrue(link.is_symlink())
            self.assertTrue(real.read_text().startswith('{\n  "model": "opus"'))
            self.assertEqual(hooks.installed('claude'), {'observer': True, 'waiter': True})

    def test_pruning_forgets_only_what_nothing_uses(self):
        from agent_bar import service
        day = 86400
        with tempfile.TemporaryDirectory() as root:
            tracker = service.Tracker(root)
            ledger, now = tracker.ledger, 100 * day
            for id, finished in [('old', now - 8 * day), ('listed', now - 8 * day), ('recent', now - day)]:
                ledger.data['queues'][id] = {'id': id, 'project': 'demo', 'state': 'COMPLETED', 'finished_at': finished}
            ledger.data['project_turns']['demo'] = now
            for key, at in [('claude:closed', now - 31 * day), ('claude:open', now - 31 * day), ('claude:fresh', now - day),
                            ('codex:closed', now - 31 * day)]:
                ledger.event(key, 'complete', at)
            stale = Path(root) / 'windows/gone.json'; stale.write_text('{}'); os.utime(stale, (0, 0))
            ledger.data['returns'] = {'gone': {}, 'terminal:999999999': {}}
            tracker.rows = [{'key': 'claude:open'}]
            tracker.prune(now)  # Before the monitor's first listing: chats only.
            self.assertEqual(len(ledger.data['queues']), 3)
            tracker.listed = {'listed'}
            tracker.prune(now)
            self.assertEqual(sorted(ledger.data['queues']), ['listed', 'recent'])
            self.assertEqual(sorted(ledger.data['conversations']), ['claude:fresh', 'claude:open', 'codex:closed'])
            self.assertEqual((stale.exists(), ledger.data['returns']), (False, {}))
            # A Codex chat's log is reread when it opens again, so its reviewed cutoff stays.
            ledger.event('codex:closed', 'complete', now - 31 * day, 'replayed')
            self.assertEqual(ledger.unread('codex:closed'), [])

    def test_a_folder_outside_git_is_checked_again_later(self):
        from agent_bar import git
        with tempfile.TemporaryDirectory() as root, unittest.mock.patch.object(git, 'RECHECK', 0):
            repositories = git.Repositories()
            self.assertEqual(repositories.read([root]), [])
            subprocess.run(['git', 'init', '-q', root], check=True)
            self.assertEqual([repo['top'] for repo in repositories.read([root])], [str(Path(root).resolve())])

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

    def test_an_automatic_turn_that_read_agent_messages_is_a_reply_to_review(self):
        from types import SimpleNamespace
        from agent_bar import messages, service
        with tempfile.TemporaryDirectory() as root:
            tracker = service.Tracker(Path(root) / 'state')
            tracker.ledger.data['since'] = 0
            # Automatic turns with background work still pending.
            tracker.providers.backgrounds['a'] = SimpleNamespace(read=lambda: None, human=False, waiting=lambda at: True, checklists={})
            def turn(began, ended):
                for kind, at in [('start', began), ('complete', ended)]:
                    (tracker.root / 'events' / f'{at}.json').write_text(json.dumps(
                        {'provider': 'claude', 'session': 'a', 'kind': kind, 'at': at}))
                    tracker.collect()
            with messages.connect(tracker.root) as connection:
                connection.execute("INSERT INTO messages (at, sender, recipient, body, read_at) "
                                   "VALUES (100, 'codex:b', 'claude:a', 'hi', 105)")
            turn(110, 120)
            self.assertEqual(tracker.ledger.conversation('claude:a')['state'], 'waiting')
            self.assertFalse(tracker.ledger.unread('claude:a'))
            with messages.connect(tracker.root) as connection:
                connection.execute("INSERT INTO messages (at, sender, recipient, body, read_at) "
                                   "VALUES (200, 'codex:b', 'claude:a', 'hi', 215)")
            turn(210, 220)
            self.assertEqual(tracker.ledger.unread('claude:a'), ['Reply finished'])

    def test_codex_navigation_targets_when_several_chats_share_a_window(self):
        from agent_bar.providers import Providers
        first, second, editor = [f'00000000-0000-4000-8000-{n:012d}' for n in range(3)]
        tab = {'viewType': 'chatgpt.conversationEditor', 'uri': f'openai-codex://route/local/{editor}'}
        window = {'id': 'w', 'workspace': 'project', 'roots': [], 'storage': None, 'tabs': [tab]}
        provider = Providers()
        metadata = {sid: {'title': 'Same title'} for sid in (first, second, editor)}
        with unittest.mock.patch.object(provider, 'codex_metadata', return_value=metadata), \
                unittest.mock.patch.object(provider, 'codex_open', side_effect=[{first, second}, {second}]):
            rows, warnings = provider.discover(window)
            self.assertEqual(warnings, [])
            self.assertEqual({r['id']: r['target'] for r in rows}, {
                first: {'kind': 'codex-editor', 'conversation': first},
                second: {'kind': 'codex-editor', 'conversation': second},
                editor: {'kind': 'tab', **tab}})
            rows, _ = provider.discover(window)
            self.assertEqual(next(r['target'] for r in rows if r['id'] == second), {'kind': 'codex-sidebar'})

    def test_codex_view_state_survives_log_rotation(self):
        with tempfile.TemporaryDirectory() as root:
            logs = Path(root) / 'openai.chatgpt'; logs.mkdir()
            (logs / 'Codex.1.log').write_text('thread_stream_view_activity_changed active=true conversationId=abc-1\n')
            (logs / 'Codex.log').write_text('other line\n')
            from agent_bar.providers import Providers
            self.assertEqual(Providers(root).codex_open({'id': 'w', 'log': str(Path(root) / 'bridge')}), {'abc-1'})

    def test_codex_window_recovers_a_submitted_turn_and_observes_its_close(self):
        from agent_bar.providers import Providers, CODEX_SUBMIT
        with tempfile.TemporaryDirectory() as root:
            logs = Path(root) / 'openai.chatgpt'; logs.mkdir()
            path = logs / 'Codex.log'
            sid, other = [f'00000000-0000-4000-8000-{n:012d}' for n in range(2)]
            window = {'id': 'w', 'log': str(Path(root) / 'bridge'), 'workspace': 'p',
                      'tabs': [], 'roots': [], 'storage': None}
            (logs / 'Codex.1.log').write_text(f'{CODEX_SUBMIT}{sid} summary=none\n')
            path.write_text(f'[info] maybe_resume_started conversationId={other}\n')
            provider = Providers(root)
            with unittest.mock.patch.object(provider, 'codex_metadata', return_value={}):
                rows, warnings = provider.discover(window)
                self.assertEqual(warnings, [])
                self.assertEqual([r['target'] for r in rows], [{'kind': 'codex-editor', 'conversation': sid}])
            # Restart after all evidence of submission rotated away.
            (logs / 'Codex.1.log').unlink()
            restored = Providers(root)
            restored.views = json.loads(json.dumps(provider.views))
            self.assertEqual(restored.codex_open(window), {sid})
            # A close written after the last poll but before rotation must still be read.
            with path.open('a') as stream:
                stream.write(f'thread_stream_view_activity_changed active=false conversationId={sid}\n')
            path.rename(logs / 'Codex.1.log')
            path.write_text('other line\n')
            self.assertEqual(restored.codex_open(window), set())
            with path.open('a') as stream:
                stream.write(f'{CODEX_SUBMIT}{sid} summary=none\nActivating Codex extension\n')
            self.assertEqual(restored.codex_open(window), set())

    def test_codex_view_opened_several_rotations_ago_is_still_open(self):
        with tempfile.TemporaryDirectory() as root:
            logs = Path(root) / 'openai.chatgpt'; logs.mkdir()
            view = 'x thread_stream_view_activity_changed active={} conversationId={}\n'
            # Oldest first: an activation that a later one supersedes, the view opened, then rotations of other lines.
            (logs / 'Codex.5.log').write_text('Activating Codex extension\n' + view.format('true', 'old-1'))
            (logs / 'Codex.4.log').write_text('Activating Codex extension\n' + view.format('true', 'abc-1') + view.format('true', 'abc-2'))
            (logs / 'Codex.3.log').write_text('noise\n' * 1000 + view.format('false', 'abc-2'))
            for number in [2, 1]: (logs / f'Codex.{number}.log').write_text('noise\n' * 1000)
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
            details = Path(str(path) + '.details')
            details.write_text('\t'.join(cells + ['recent_slower']) + '\n')
            self.assertEqual(queue_snapshot(path)[0]['eta_warning'], 'recent_slower')
            finished = cells[:4] + ['COMPLETED'] + cells[5:13] + ['160', 'end'] + cells[15:]
            path.write_text('\t'.join(finished) + '\n')
            self.assertEqual(queue_snapshot(path)[0]['ended'], 160)
            self.assertIsNone(queue_snapshot(path)[0]['eta_warning'])
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


class GitTests(unittest.TestCase):
    def test_status_asks_only_git_status_again_until_head_or_config_change(self):
        from agent_bar import git
        with tempfile.TemporaryDirectory() as root:
            env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@x', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@x'}
            run = lambda *args: subprocess.run(['git', '-C', root, *args], check=True, capture_output=True, env=env)
            run('init', '-q'); Path(root, 'a').write_text('1'); run('add', 'a'); run('commit', '-qm', 'first')
            asked = []
            real = git.git
            def counting(top, *args):
                asked.append(args[0])
                return real(top, *args)
            known = {}
            with unittest.mock.patch.object(git, 'git', counting):
                self.assertEqual(git.status(root, known)['subject'], 'first')
                self.assertEqual(sorted(asked), ['log', 'remote', 'remote', 'rev-parse', 'status'])
                asked.clear()
                Path(root, 'b').write_text('new')
                self.assertEqual(git.status(root, known)['untracked'], 1)
                self.assertEqual(asked, ['status'])
                time.sleep(0.01)
                run('add', 'b'); run('commit', '-qm', 'second')
                asked.clear()
                self.assertEqual(git.status(root, known)['subject'], 'second')
                self.assertIn('log', asked)


class ChecklistTests(unittest.TestCase):
    def test_only_checkbox_lines_outside_code_count_and_open_items_sort_by_prefix(self):
        from agent_bar import checklists
        parsed = checklists.parse("""# Fit the model

Status: prose, not counted. A [link](child.md) and [a site](https://x.org/a.md).
- [x] Done one
  - [X] Done two, indented
- [-] Dropped: superseded
- [ ] Waiting: queue run-42 finishes
- [ ] Write the results
- [ ] User: choose the prior
- [ ] Deferred: appendix figure
- [~] A legacy marker
1. [ ] Numbered item
```markdown
- [ ] An example in a fence
```
""")
        self.assertEqual({key: parsed[key] for key in ['title', 'done', 'open', 'dropped', 'unknown', 'next', 'user', 'waiting', 'deferred', 'links']},
                         {'title': 'Fit the model', 'done': 2, 'open': 5, 'dropped': 1, 'unknown': 1, 'next': 'Write the results',
                          'user': ['choose the prior'], 'waiting': ['queue run-42 finishes'], 'deferred': ['appendix figure'],
                          'links': ['child.md']})

    def test_edits_are_writes_to_checklist_paths(self):
        from agent_bar import checklists
        self.assertEqual(checklists.edited('cat > tmp/agent/checklists/fit.md <<EOF', True, '/r/p'), ['/r/p/tmp/agent/checklists/fit.md'])
        self.assertEqual(checklists.edited('cat tmp/agent/checklists/fit.md', True, '/r/p'), [])
        self.assertEqual(checklists.edited('tmp/agent/checklists/fit.md'), [])
        self.assertEqual(checklists.edited('*** Update File: tmp/agent/checklists/a/b.md', cwd='/r/p'), ['/r/p/tmp/agent/checklists/a/b.md'])

    def test_scan_keeps_recent_files_and_older_ones_with_open_items(self):
        from agent_bar import checklists
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / 'tmp/agent/checklists'
            (folder / 'sub').mkdir(parents=True)
            for name, text, age in [('new.md', '- [x] a\n- [ ] [child](sub/kid.md)', 0), ('old-open.md', '- [ ] User: decide', 30),
                                    ('old-done.md', '- [x] a', 30), ('sub/kid.md', '- [ ] b', 1)]:
                (folder / name).write_text(text)
                os.utime(folder / name, (time.time() - age * 86400,) * 2)
            cache = {}
            found = checklists.scan([root], cache, time.time())[root]
            self.assertEqual([(f['name'], f['recent']) for f in found['files']], [('new.md', True), ('sub/kid.md', True), ('old-open.md', False)])
            self.assertEqual((found['older_closed'], found['files'][0]['links']), (1, [{'path': str(folder / 'sub/kid.md'), 'exists': True}]))
            self.assertEqual(len(cache), 4)

    def test_open_chats_transcripts_say_who_edited_a_checklist(self):
        from agent_bar.providers import Background, Providers
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'chat.jsonl'
            entry = {'type': 'assistant', 'timestamp': '2026-11-17T10:00:00Z', 'cwd': '/r/p', 'message': {'content': [
                {'type': 'tool_use', 'id': 't1', 'name': 'Edit', 'input': {'file_path': '/r/p/tmp/agent/checklists/fit.md'}},
                {'type': 'tool_use', 'id': 't2', 'name': 'Bash', 'input': {'command': 'echo "- [x] b" >> tmp/agent/checklists/two.md'}},
                {'type': 'tool_use', 'id': 't3', 'name': 'Read', 'input': {'file_path': '/r/p/tmp/agent/checklists/read.md'}}]}}
            path.write_text(json.dumps(entry) + '\n')
            background = Background(path)
            background.read()
            self.assertEqual(sorted(background.checklists), ['/r/p/tmp/agent/checklists/fit.md', '/r/p/tmp/agent/checklists/two.md'])
            providers = Providers(root)
            providers.backgrounds['s1'] = background
            providers.codex_checklists['codex:c'] = {'/r/p/tmp/agent/checklists/fit.md': 5.0}
            self.assertEqual(set(providers.checklist_editors()['/r/p/tmp/agent/checklists/fit.md']), {'claude:s1', 'codex:c'})


class SkillInstallTests(unittest.TestCase):
    def test_skills_go_only_where_none_of_that_name_is_and_only_ours_are_replaced_or_removed(self):
        from agent_bar import install
        home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, home)
        (home / '.codex').mkdir()
        own = home / 'mine' / 'agent-messages'
        own.mkdir(parents=True)
        (own / 'SKILL.md').write_text('the user\'s own')
        (home / '.claude/skills').mkdir(parents=True)
        (home / '.claude/skills/agent-messages').symlink_to(own)
        with unittest.mock.patch.dict(os.environ, {'HOME': str(home)}), contextlib.redirect_stdout(io.StringIO()):
            install.install_skills()
            ours = home / '.agents/skills/agent-messages'
            self.assertIn('ticket take', (ours / 'SKILL.md').read_text())
            self.assertEqual((home / '.claude/skills/agent-messages/SKILL.md').read_text(), "the user's own")
            (ours / 'SKILL.md').write_text('old copy')
            install.install_skills()
            self.assertIn('ticket take', (ours / 'SKILL.md').read_text())
            install.remove_skills()
        self.assertFalse(ours.exists())
        self.assertEqual((own / 'SKILL.md').read_text(), "the user's own")


class TicketTests(unittest.TestCase):
    def setUp(self):
        from agent_bar import tickets
        self.tickets = tickets
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.folder = str(self.root / 'repos' / 'proj')
        (self.root / 'snapshot.json').write_text(json.dumps({'rows': [
            {'key': 'claude:a', 'provider': 'claude', 'title': 'Agent chat', 'roots': [self.folder], 'project': 'proj', 'state': 'finished'}],
            'usage': {'claude': {'limits': [{'key': 'session', 'name': '5-hour', 'resets_at': 1000, 'limiting': False},
                                            {'key': 'weekly', 'name': 'Weekly', 'resets_at': 5000, 'limiting': True}]}}}))
        (self.root / 'ledger.json').write_text(json.dumps({'queues': {
            'q1': {'project': 'proj', 'label': 'fits', 'finished_at': None},
            'q2': {'project': 'other', 'label': 'x', 'finished_at': None}}}))
        patcher = unittest.mock.patch.dict(os.environ, {'CLAUDE_CODE_SESSION_ID': '', 'CODEX_THREAD_ID': ''})
        patcher.start()
        self.addCleanup(patcher.stop)
        # These tests run under an agent; the ancestry check has its own test.
        ancestry = unittest.mock.patch.object(tickets, 'agent_ancestor', return_value=False)
        ancestry.start()
        self.addCleanup(ancestry.stop)

    def test_waits_are_fixed_when_written_and_ready_once_all_pass(self):
        t = self.tickets
        first = t.add('Audit with Fable', self.folder, ['reset:claude', 'queues'], root=self.root, now=100)
        self.assertEqual(first['waits'], ['Claude weekly limit resets', 'fits finishes'])
        t.add('After the audit', self.folder, ['ticket:1', 'date:+1h'], root=self.root, now=100)
        t.add('Any time', self.folder, [], root=self.root, now=100)
        state = lambda now, queues=None: [(row['id'], row['ready'], row['waiting'])
                                          for row in t.listing(self.root, now, queues)['open']]
        self.assertEqual(state(200), [(1, False, ['Claude weekly limit resets', 'fits finishes']),
                                      (2, False, ['#1 closes', unittest.mock.ANY]), (3, True, [])])
        # The reset passed, and a queue the tracker forgot counts as finished; the 5-hour reset was not the one fixed.
        self.assertEqual(state(5000, {})[0], (1, True, []))
        t.change(1, 'done', 'clean', root=self.root, now=5001)
        listing = t.listing(self.root, 5002, {})
        self.assertEqual([(row['id'], row['ready']) for row in listing['open']], [(2, True), (3, True)])
        self.assertEqual([(row['id'], row['status'], row['note']) for row in listing['closed']], [(1, 'done', 'clean')])

    def test_an_agent_that_drops_its_session_id_cannot_write_as_the_user(self):
        with unittest.mock.patch.object(self.tickets, 'agent_ancestor', return_value=True):
            with self.assertRaisesRegex(ValueError, 'cannot tell which chat'): self.tickets.add('x', self.folder, root=self.root)
        from agent_bar import state
        # This test suite runs under Claude Code or Codex, or under neither (CI); the check must not fail either way.
        self.assertIsInstance(state.agent_ancestor(), bool)

    def test_authors_projects_and_errors(self):
        t = self.tickets
        with unittest.mock.patch.dict(os.environ, {'CLAUDE_CODE_SESSION_ID': 'a'}):
            # An agent cannot write as the user, and its ticket goes in its own folder by default.
            t.add('From an agent', who='user', root=self.root, now=100)
            t.change(1, 'started', root=self.root, now=110)
        row = t.listing(self.root, 120)['open'][0]
        self.assertEqual((row['author'], row['author_title'], row['folder'], row['status'], row['taken_title']),
                         ('claude:a', 'Agent chat', self.folder, 'started', 'Agent chat'))
        self.assertIn('the agent chat "Agent chat"', row['prompt'])
        self.assertIn('agent-bar ticket take 1', row['prompt'])
        t.add('Mine', self.folder, root=self.root, now=130)
        self.assertIn('written by your user', t.listing(self.root, 140)['open'][1]['prompt'])
        for wait, error in [('reset:codex', 'No codex usage limit'), ('reset:claude:fable', 'no limit'), ('queue:zz', 'No queue'),
                            ('ticket:9', 'No ticket #9'), ('date:soon', 'Unreadable time'), ('later', 'Unknown wait')]:
            with self.assertRaisesRegex(ValueError, error): t.add('x', self.folder, [wait], root=self.root)
        with self.assertRaisesRegex(ValueError, 'no queues outstanding'): t.add('x', str(self.root / 'elsewhere'), ['queues'], root=self.root)
        with self.assertRaisesRegex(ValueError, 'Empty'): t.add('  ', self.folder, root=self.root)
        with self.assertRaisesRegex(ValueError, 'No ticket #7'): t.change(7, 'done', root=self.root)

    def test_closed_tickets_are_kept_for_a_while(self):
        t = self.tickets
        t.add('Old', self.folder, root=self.root, now=100)
        t.change(1, 'dropped', root=self.root, now=100)
        t.add('New', self.folder, root=self.root, now=100 + t.KEEP + 1)
        listing = t.listing(self.root, 100 + t.KEEP + 2)
        self.assertEqual(([row['id'] for row in listing['open']], listing['closed']), ([2], []))


    def test_start_hands_the_prompt_to_the_window_on_its_folder(self):
        from agent_bar import bridge
        t = self.tickets
        Path(self.folder).mkdir(parents=True)
        t.add('Do the thing', self.folder, root=self.root, now=100)
        windows = self.root / 'windows'
        windows.mkdir()
        # A window on the folder whose bridge predates starting chats is asked to reload.
        (windows / 'w.json').write_text(json.dumps({'roots': [self.folder], 'updated': time.time(), 'resume': True}))
        with self.assertRaisesRegex(ValueError, 'Reload Window'): t.start(1, root=self.root)
        (windows / 'w.json').write_text(json.dumps({'roots': [self.folder], 'updated': time.time(), 'resume': True, 'start': True}))
        (self.root / 'responses').mkdir()
        launched = []

        def answer(command, **_):
            # The bridge takes the request and answers.
            launched.append(command)
            request = json.loads(next((self.root / 'resume').glob('*.json')).read_text())
            self.assertEqual((request['provider'], request['folder'], 'conversation' in request), ('claude', self.folder, False))
            self.assertIn('Do the thing', request['prompt'])
            (self.root / 'responses' / f'{request["id"]}.json').write_text('{"ok": true}')

        with unittest.mock.patch.object(bridge.shutil, 'which', return_value='/usr/bin/code'), \
                unittest.mock.patch.object(bridge.subprocess, 'Popen', side_effect=answer):
            self.assertEqual(t.start(1, root=self.root), {'ok': True, 'id': 1})
        self.assertEqual(launched, [['/usr/bin/code', self.folder]])
        self.assertEqual(list((self.root / 'resume').iterdir()), [])
        t.change(1, 'done', root=self.root)
        with self.assertRaisesRegex(ValueError, 'is done'): t.start(1, root=self.root)


    def test_a_sent_ticket_arrives_as_the_users_request_and_a_repeating_one_moves_on(self):
        from agent_bar import messages
        t = self.tickets
        snapshot = json.loads((self.root / 'snapshot.json').read_text())
        snapshot['rows'].append({'key': 'codex:b', 'provider': 'codex', 'title': 'Weekly report', 'project': 'proj', 'state': 'finished'})
        (self.root / 'snapshot.json').write_text(json.dumps(snapshot))
        ledger = json.loads((self.root / 'ledger.json').read_text())
        (self.root / 'ledger.json').write_text(json.dumps({**ledger, 'conversations': {}}))
        with unittest.mock.patch.object(messages, 'SETTINGS', self.root / 'settings.json'):
            once = t.add('Run the audit', self.folder, ['date:2026-11-20 09:00'], root=self.root, now=100, to='codex:b')
            weekly = t.add('Draft the weekly update', self.folder, ['date:2026-11-20 09:00'], root=self.root, now=100,
                           to='codex:b', repeat='week')
            self.assertEqual((once['to'], weekly['repeat']), ('Weekly report', 'every week'))
            start = datetime.datetime(2026, 11, 20, 9).timestamp()
            self.assertEqual(t.deliver_due(self.root, start - 60), [])
            self.assertEqual(t.deliver_due(self.root, start + 5), [1, 2])
            box = messages.inbox('codex:b', self.root, peek=True)
            self.assertEqual([(m['sender'], m['sender_title'], m['body']) for m in box['messages']],
                             [('user', 'You (ticket #1)', 'Run the audit'), ('user', 'You (ticket #2)', 'Draft the weekly update')])
            self.assertIn("your user's own requests", box['note'])
            self.assertIn('2 messages your user scheduled', messages.notice('codex:b', self.root) or '')
            listing = t.listing(self.root, start + 10)
            self.assertEqual([(row['id'], row['status'], row['note']) for row in listing['closed']], [(1, 'done', 'Sent to Weekly report')])
            [row] = listing['open']
            self.assertEqual((row['ready'], row['sent_count']), (False, 1))
            self.assertEqual(datetime.datetime.fromtimestamp(row['after'][0]['at']), datetime.datetime(2026, 11, 27, 9))
            # A week of missed sends (the computer was off) is one send, not seven.
            self.assertEqual(t.deliver_due(self.root, start + 40 * 86400), [2])
            self.assertEqual(t.listing(self.root, start + 40 * 86400)['open'][0]['sent_count'], 2)
            # Nothing run in a chat may send as the user.
            with self.assertRaisesRegex(ValueError, 'Only a ticket the user scheduled'):
                messages.send('user', 'codex:b', 'pretend', self.root)

    def test_a_ticket_to_a_closed_chat_records_the_failure_and_tries_again_later(self):
        from agent_bar import messages
        t = self.tickets
        (self.root / 'ledger.json').write_text(json.dumps({'queues': {}, 'conversations': {}}))
        with unittest.mock.patch.object(messages, 'SETTINGS', self.root / 'settings.json'):
            # An agent's ticket goes from that agent.
            with unittest.mock.patch.dict(os.environ, {'CLAUDE_CODE_SESSION_ID': 'b'}):
                snapshot = json.loads((self.root / 'snapshot.json').read_text())
                (self.root / 'snapshot.json').write_text(json.dumps(snapshot))
                t.add('Check the fit', self.folder, [], root=self.root, now=100, to='claude:a')
            (self.root / 'snapshot.json').write_text(json.dumps({'rows': []}))
            self.assertEqual(t.deliver_due(self.root, 200), [])
            row = t.listing(self.root, 201)['open'][0]
            self.assertIn('not an open', row['delivery_error'])
            self.assertFalse(t.due(row, 201 + t.RETRY - 10))
            self.assertTrue(t.due(row, 200 + t.RETRY))
            (self.root / 'snapshot.json').write_text(json.dumps(snapshot))
        for repeat, error in [('fortnightly', 'Unreadable repeat'), ('0.5h', 'at most hourly')]:
            with self.assertRaisesRegex(ValueError, error): t.add('x', self.folder, ['date:+1h'], root=self.root, to='claude:a', repeat=repeat)
        with self.assertRaisesRegex(ValueError, 'needs one time'): t.add('x', self.folder, [], root=self.root, to='claude:a', repeat='day')
        with self.assertRaisesRegex(ValueError, 'Only a ticket sent'): t.add('x', self.folder, ['date:+1h'], root=self.root, repeat='day')
        with self.assertRaisesRegex(ValueError, 'not an open'): t.add('x', self.folder, [], root=self.root, to='codex:gone')


if __name__ == '__main__': unittest.main()
