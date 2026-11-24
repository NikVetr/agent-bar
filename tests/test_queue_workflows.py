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

    def test_retired_queue_lookup_checks_full_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index = root / '.parallel-workers/adaptive/queue-index'
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

    def test_numbers_persist_across_pruning_and_missing_metadata(self):
        ledger = Ledger({'since': 0, 'queues': {'z': {'id': 'z', 'started': 2}, 'a': {'id': 'a', 'started': 1}},
                         'project_turns': {}})
        self.assertEqual([ledger.queue_number(k) for k in ('a', 'z')], [1, 2])
        del ledger.data['queues']['z']
        number = ledger.queue_number('pool/unlisted-token')
        restored = Ledger(ledger.data)
        self.assertEqual(restored.queue_number('restored-tag', 'pool/unlisted-token'), number)
        self.assertEqual(restored.queue_number('z'), 2)
        self.assertGreater(restored.queue_number('new'), number)
