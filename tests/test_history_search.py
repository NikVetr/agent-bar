import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_bar import history_search, inventory


class HistorySearchTests(unittest.TestCase):
    def test_only_direct_dialogue_is_searchable(self):
        def extract(provider, entry):
            return history_search.dialogue(json.dumps(entry).encode(), provider)
        def codex(role, parts, **fields):
            return extract('codex', {'type': 'response_item', 'payload': {
                'type': 'message', 'role': role, 'content': parts, **fields}})
        def text(value):
            return {'type': 'input_text', 'text': value}
        self.assertEqual(codex('user', [text('<environment_context>hidden'), text('search this')]), ('user', 'search this'))
        self.assertEqual(codex('user', [text('<div>valid code example')]), ('user', '<div>valid code example'))
        self.assertIsNone(codex('developer', [text('hidden instructions')]))
        self.assertIsNone(codex('assistant', [text('hidden reasoning')], channel='analysis'))
        self.assertIsNone(codex('assistant', [text('hidden command')], recipient='functions.exec'))
        self.assertIsNone(codex('user', [text('# AGENTS.md instructions for /test')]))
        self.assertEqual(codex('user', [text('# Context from my IDE setup:\nsecret IDE text\n## My request for Codex:\nfind me')]),
                         ('user', 'find me'))
        self.assertEqual(codex('user', [text('<ide_selection>editor text</ide_selection>\nactual request')]),
                         ('user', 'actual request'))
        for top in ('user', 'assistant'):
            blocks = [{'type': 'text', 'text': 'visible'}, {'type': 'thinking', 'thinking': 'hidden'}]
            entry = {'type': top, 'message': {'role': top, 'content': blocks}}
            self.assertEqual(extract('claude', entry), (top, 'visible'))
            for extra in [{'isSidechain': True}, {'isMeta': True}, {'isCompactSummary': True}, {'type': 'api-request-blob'}]:
                self.assertIsNone(extract('claude', {**entry, **extra}))
        self.assertIsNone(extract('claude', {'type': 'user', 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'content': 'result'}, {'type': 'text', 'text': 'injected'}]}}))

    def test_incremental_index_scope_excerpt_and_deletions(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            index, output = home/'index.sqlite', home/'inventory.json'
            sid = '11111111-2222-3333-4444-555555555555'
            path = home/'.claude/projects/p'/f'{sid}.jsonl'
            path.parent.mkdir(parents=True)
            other = path.with_name('22222222-2222-3333-4444-555555555555.jsonl')
            def msg(role, body, repo='my repo'):
                return json.dumps({'type': role, 'message': {'role': role, 'content': body}, 'cwd': f'/repos/{repo}',
                                   'timestamp': '2026-11-01T12:01:00Z'}, separators=(',', ':')) + '\n'
            path.write_text(msg('user', 'A keyword about maple trees') + msg('assistant', 'Maple foliage'))
            other.write_text(msg('user', 'maple elsewhere', 'other'))
            def hits(q, scope=None): return history_search.search(q, scope, index)['results']
            with patch.object(inventory, 'OUTPUT', output), patch.object(history_search, 'INDEX', index), patch('pathlib.Path.home', return_value=home):
                inventory.refresh()
                self.assertEqual(len(hits('maple')), 2)
                match, = hits('mapl', 'MY REPO')
                self.assertEqual((match['role'], match['excerpt']), ('assistant', 'Maple foliage'))
                self.assertEqual(hits('absent maple'), [])
                self.assertEqual(hits('" OR *'), [])
                self.assertEqual(hits('maple', '/repos/my repo'), [match])
                self.assertEqual(len(hits('maple', '/repos')), 2)
                self.assertEqual(hits('maple', '/rep'), [])
                appended = msg('user', 'walnut trees')
                with path.open('a') as out: out.write(appended[:-2])
                inventory.refresh()
                self.assertEqual(hits('walnut'), [])
                with path.open('a') as out: out.write(appended[-2:])
                inventory.refresh()
                self.assertEqual(hits('walnut')[0]['role'], 'user')
                inventory.refresh()
                with sqlite3.connect(index) as db: self.assertEqual(db.execute('select count(*) from messages').fetchone()[0], 4)
                path.write_text(msg('user', 'new content'))
                other.unlink()
                inventory.refresh()
                self.assertEqual(hits('maple'), [])
                self.assertEqual(len(hits('content')), 1)

    def test_existing_codex_inventory_is_backfilled_and_archived_threads_leave_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            index, output, rollout = home/'index.sqlite', home/'inventory.json', home/'rollout.jsonl'
            def message(role, text):
                return json.dumps({'type': 'response_item', 'payload': {'type': 'message', 'role': role,
                    'content': [{'type': 'output_text' if role == 'assistant' else 'input_text', 'text': text}]}},
                    separators=(',', ':')) + '\n'
            rollout.write_text(message('user', 'A question') + message('assistant', 'An apricot answer'))
            database = home/'.codex/state_5.sqlite'
            database.parent.mkdir()
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE threads (id, title, name, cwd, created_at, updated_at, rollout_path, archived, source)')
                db.execute("INSERT INTO threads VALUES ('a','Fruit',null,?,1,2,?,0,'vscode')", (str(home), str(rollout)))
            output.write_text(json.dumps(inventory.build(home)))
            with patch.object(inventory, 'OUTPUT', output), patch.object(history_search, 'INDEX', index), patch('pathlib.Path.home', return_value=home):
                inventory.refresh()
                self.assertEqual(history_search.search('apricot', path=index)['results'][0]['key'], 'codex:a')
                with sqlite3.connect(database) as db: db.execute('UPDATE threads SET archived=1')
                inventory.refresh()
                self.assertEqual(history_search.search('apricot', path=index)['results'], [])

    def test_excerpt_keeps_highlighted_fts_words_visible_after_long_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'history.sqlite'
            with sqlite3.connect(path) as db:
                history_search.initialize(db)
                db.execute('PRAGMA user_version=1')
                db.execute("INSERT INTO sources(key,folder,title) VALUES ('a','/repo','Title')")
                body = 'x' * 500 + ' <Démultiplexing> & demux 🐈 ' + 'y' * 250
                db.execute("INSERT INTO messages VALUES ('a','assistant',?)", (body,))
            hit, = history_search.search('demu', path=path)['results']
            self.assertEqual(hit['parts'][1::2], ['Démultiplexing', 'demux'])
            self.assertEqual(''.join(hit['parts']), hit['excerpt'])
            self.assertIn('<Démultiplexing> & demux 🐈', hit['excerpt'])
            self.assertLessEqual(len(hit['parts'][0]), 38)
            self.assertLessEqual(len(hit['excerpt']), 161)

    def test_context_follows_preview_and_pages_through_occurrences_and_messages(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'history.sqlite'
            with sqlite3.connect(path) as db:
                history_search.initialize(db)
                db.execute('PRAGMA user_version=1')
                db.execute("INSERT INTO sources(key,folder,title) VALUES ('a','/repo','Title')")
                db.executemany('INSERT INTO messages VALUES (?,?,?)', [
                    ('a', 'user', 'Maple and oak?'), ('a', 'assistant', 'A short reply.'),
                    ('b', 'assistant', 'Another conversation.'),
                    ('a', 'user', 'maple ' + 'filler ' * 110 + 'Dwarf maple & oak.'),
                    ('b', 'user', 'Unrelated follow-up.'), ('a', 'assistant', 'Will check.')])
            def context(message=1, hit=None):
                return history_search.search('mapl oak', 'repo', path, conversation='a', message=message, hit=hit)['context']
            selected = context()
            self.assertEqual((selected['message'], selected['messages'], selected['hit'], selected['hits']), (1, 2, 2, 3))
            self.assertEqual(selected['parts'][1], 'maple')
            self.assertIsNone(selected['before'])
            self.assertEqual(selected['after']['text'], 'Will check.')
            first = context(hit=1)
            self.assertEqual(first['before']['text'], 'A short reply.')
            self.assertNotEqual(first['parts'], selected['parts'])
            self.assertIsNone(first['after'])
            self.assertEqual(context(hit=-1)['parts'][1], 'oak')
            older = context(2, 1)
            self.assertEqual(older['parts'][1], 'Maple')
            self.assertIsNone(older['before'])
            self.assertEqual(older['after']['text'], 'A short reply.')
            for message, hit in [(0, 1), (3, 1), (1, 4), (1, 0)]:
                with self.assertRaises(ValueError):
                    context(message, hit)
            with self.assertRaisesRegex(ValueError, 'outside the current search'):
                history_search.search('mapl', '/other', path, conversation='a')
