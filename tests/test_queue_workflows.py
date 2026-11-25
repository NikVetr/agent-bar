import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

from agent_bar.queue_workflows import read
from agent_bar.state import Ledger


class QueueWorkflowTests(unittest.TestCase):
    def test_individual_prerequisites_and_retirement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            refs = []
            for name, life in [('a', 'FINISHED_INCOMPLETE'), ('b', 'RUNNING'), ('c', 'COMPLETED')]:
                batch = root / name
                (batch / 'adaptive').mkdir(parents=True)
                (batch / 'run_meta.env').write_text(f'execution_mode=adaptive-shared-queue\nrun_token={name}\npool_id=p\ntag_clean={name}-tag\n')
                (batch / 'adaptive/status.env').write_text(f'queue_id={name}\nlifecycle={life}\npropagation=complete\nrunning_workers=0\ntarget_workers=0\n')
                refs.append({'queue_id': name, 'pool_id': 'p', 'batch_dir': str(batch)})
            parent = root / 'parent/adaptive'
            parent.mkdir(parents=True)
            (parent / 'resources.env').write_text('schema_version=2\nqueue_id=parent\ndependencies=' + json.dumps(refs))
            scheduler = {'ok': True, 'updated': time.time(), 'queues': [
                {'tag': 'next', 'queue_id': 'parent', 'batch_dir': str(parent.parent)}]}
            snapshot = {'scheduler': scheduler, 'hosts': [{'id': 'local', 'mount': {'ok': True, 'root': tmp}}],
                        'collector': {'local_host': 'local'}}
            path = root / 'snapshot.json'
            path.write_text(json.dumps(snapshot))
            cached, result = read(path, {'next': 1}, {}, {'next'})
            self.assertEqual([d['state'] for d in result['links']['next']], ['failed', 'waiting', 'complete'])
            scheduler['queues'] = []
            path.write_text(json.dumps(snapshot))
            markers = root / 'c/share-interrupted'
            markers.mkdir()
            (markers / 'job_1').touch()
            (root / 'a/adaptive/status.env').write_text('queue_id=replaced\nlifecycle=COMPLETED')
            _, result = read(path, {'next': 1}, cached, {'next'})
            self.assertEqual([d['state'] for d in result['links']['next']], ['unknown', 'waiting', 'verify'])
            (markers / 'confirmed').mkdir()
            (markers / 'job_1').rename(markers / 'confirmed/job_1')
            self.assertEqual(read(path, {'next': 1}, cached, {'next'})[1]['links']['next'][2]['state'], 'complete')

    def test_reverse_links_include_hidden_parents_and_match_the_target_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tag = 'visible'
            ref = {'pool_id': 'p', 'queue_id': 'first', 'batch_dir': str(root / 'first')}
            cache = {name: {'pool': 'p', 'id': token, 'batch_dir': str(root / token), 'refs': refs}
                     for name, token, refs in [(tag, 'first', []), ('hidden', 'second', [ref]),
                                               ('other', 'third', [{**ref, 'pool_id': 'old'}])]}
            path = root / 'snapshot.json'
            path.write_text(json.dumps({'scheduler': {'ok': True, 'updated': time.time()},
                                        'collector': {'local_host': 'local'},
                                        'hosts': [{'id': 'local', 'mount': {'ok': True, 'root': tmp}}]}))
            _, result = read(path, dict.fromkeys(cache, 1), cache, {tag})
            self.assertEqual(result['dependents'], {tag: ['hidden']})
            self.assertFalse(result['links'])

    def test_retired_queue_lookup_checks_full_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index = root / '.rota/adaptive/queue-index'
            index.mkdir(parents=True)
            token = 'batch_00005_2026-11-24_100_abc'
            tag = 'project/path__habc__b00005'
            tracked = {tag: 100}
            batch = root / 'batch'
            (batch / 'adaptive').mkdir(parents=True)
            (batch / 'adaptive/resources.env').write_text(f'schema_version=2\nqueue_id={token}\ndependencies=[]')
            reg = index / (token + '.env')
            reg.write_text(f'tag_clean={tag}\nqueue_id={token}\nbatch_dir={batch}')
            snapshot = root / 'cluster.json'
            snapshot.write_text(json.dumps({'scheduler': {'ok': True, 'updated': time.time(), 'queues': []},
                                'collector': {'local_host': 'local'}, 'hosts': [{'id': 'local', 'mount': {'ok': True, 'root': tmp}}]}))
            cached, result = read(snapshot, tracked, {}, {tag})
            self.assertEqual(cached[tag]['id'], token)
            self.assertFalse(result['errors'])
            reg.write_text(f'tag_clean=wrong\nqueue_id={token}\nbatch_dir={batch}')
            self.assertIn(tag, read(snapshot, tracked, {}, {tag})[1]['errors'])
            self.assertEqual(read(snapshot, tracked, {}, set())[0], {})

    def test_active_numbers_follow_launch_order_within_each_project(self):
        queues = {tag: {'id': tag, 'project': project, 'started': started, 'state': state}
                  for tag, project, started, state in [('z', 'one', 3, 'PENDING'), ('b', 'two', 2, 'RUNNING'),
                                                       ('a', 'one', 3, 'DRAINING'), ('c', 'one', 2, 'PENDING'),
                                                       ('f', 'one', 0, 'FINISHED_INCOMPLETE')]}
        ledger = Ledger({'queues': queues, 'queue_numbers': {'z': 298}, 'project_turns': {}})
        self.assertNotIn('queue_numbers', ledger.data)
        self.assertEqual(ledger.active_queue_numbers(), {'c': 1, 'a': 2, 'z': 3, 'b': 1})
        queues['c']['state'] = 'COMPLETED'
        self.assertEqual(ledger.active_queue_numbers(), {'a': 1, 'z': 2, 'b': 1})

    def test_cached_dependencies_resolve_against_current_project_numbers(self):
        from agent_bar.service import Tracker
        with tempfile.TemporaryDirectory() as tmp:
            tracker = Tracker(tmp)
            queues = {tag: {'id': tag, 'project': project, 'state': 'RUNNING', 'started': i}
                      for i, (tag, project) in enumerate([('a', 'one'), ('b', 'one'), ('c', 'two')])}
            tracker.ledger.data['queues'] = queues
            tracker.workflow_tags, tracker.workflow_at = set(queues), time.monotonic()
            tracker.workflow_result = {'dependents': {}, 'links': {'a': [{'tag': 'b'}], 'b': [{'tag': 'a'}], 'c': [{'tag': 'b'}]}, 'errors': {}}
            query = tracker.queue_dependencies
            self.assertEqual(set(asyncio.run(query([1]))['links']), {'a', 'c'})
            self.assertEqual(asyncio.run(query([1], 'two'))['links']['c'][0]['number'], 2)
            queues['a']['state'] = 'COMPLETED'
            self.assertEqual(asyncio.run(query([1], 'two'))['links']['c'][0]['number'], 1)
            self.assertIsNone(asyncio.run(query([], ids=['b']))['links']['b'][0]['number'])
            self.assertEqual(set(asyncio.run(query([], ids=['a']))['links']), {'a'})
