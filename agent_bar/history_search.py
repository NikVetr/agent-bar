"""Local full-text index of the visible dialogue in saved conversations."""
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from .state import ROOT

INDEX = ROOT / 'history-search.sqlite'
# Context and notifications the clients encode as user messages.
CONTEXT = re.compile(r'^\s*<(environment_context|user_instructions|external_[\w-]+|ide_opened_file|ide_selection|'
                     r'codex_internal_context|turn_aborted|recommended_plugins|subagent_notification|agent-notification|'
                     r'agent-message|task-notification|system-reminder|command-name|command-message|local-command-[\w-]+)(?:\s|>)', re.I)
IDE_HEADERS = ('# Context from my IDE setup:', '# Files mentioned by the user:', '# Selected text:')


def dialogue(line, provider):
    # Compact JSONL is the providers' normal format. Skip large tool calls/results and reasoning records cheaply.
    if provider == 'codex':
        header = line[:220]
        if b'"type":"event_msg","payload":' in header or re.search(
                rb'"type":"response_item","payload":\{"type":"(?!message")[^"]+"', header): return None
    if provider == 'claude' and line.startswith(b'{"type":"api-request-blob"'):
        return None
    entry = json.loads(line)
    if provider == 'codex':
        message = entry.get('payload') or {}
        if entry.get('type') != 'response_item' or message.get('type') != 'message': return None
        if message.get('recipient') not in (None, 'all') or message.get('channel') == 'analysis': return None
    else:
        if entry.get('type') not in ('user', 'assistant') or any(entry.get(k) for k in
                ('isMeta', 'isSidechain', 'isCompactSummary', 'toolUseResult')): return None
        if (entry.get('origin') or {}).get('kind') not in (None, 'human'): return None
        message = entry.get('message') or {}
    role = message.get('role')
    if role not in ('user', 'assistant'): return None
    content = message.get('content') or []
    if isinstance(content, str):
        parts = [content]
    else:
        if role == 'user' and any(p.get('type') == 'tool_result' for p in content): return None
        parts = [p['text'] for p in content if p.get('type') in ('text', 'input_text', 'output_text')
                 and isinstance(p.get('text'), str)]
    if role == 'user':
        direct = []
        for part in parts:
            if part.lstrip().startswith(('# AGENTS.md instructions', '<permissions instructions>')): continue
            if part.startswith(IDE_HEADERS):
                part = part.partition('## My request for Codex:')[2]
            while wrapper := CONTEXT.match(part):
                part = part.partition(f'</{wrapper[1]}>')[2].lstrip()
            if part.startswith('<send_user_message_question_reply>'):
                try:
                    replies = json.loads(part.partition('>')[2].partition('</send_user_message_question_reply>')[0])
                    direct.extend(r['answer'] for r in replies if isinstance(r.get('answer'), str))
                except (ValueError, TypeError, AttributeError): pass
            else: direct.append(part)
        parts = direct
    text = '\n'.join(parts).strip()
    return (role, text) if text else None


def initialize(db):
    db.execute('CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, path TEXT, inode INTEGER, offset INTEGER, folder TEXT, title TEXT)')
    db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(key UNINDEXED, role UNINDEXED, body)')


def excerpt_parts(snippet, marker):
    """Alternate plain text and FTS-matched words, keeping the first hit in view."""
    parts = ' '.join(snippet.split()).split(marker)
    if len(parts[0]) > 38:
        parts[0] = '…' + parts[0][-37:]
    remaining = 160
    visible = []
    for index, part in enumerate(parts):
        visible.append(part[:remaining])
        remaining -= len(part)
        if remaining < 0 or (remaining == 0 and any(parts[index + 1:])):
            if index % 2: visible.append('…')
            else: visible[-1] += '…'
            break
    return visible


def match_context(db, key, match, message, hit):
    """Fetch one occurrence in one matching message, newest message first."""
    ids = [row[0] for row in db.execute('SELECT rowid FROM messages WHERE messages MATCH ? AND key=? ORDER BY rowid DESC',
                                        (match, key))]
    if not 1 <= message <= len(ids):
        raise ValueError('Matching message no longer available. Run the search again.')
    rowid = ids[message - 1]
    marker, omitted = uuid4().hex, uuid4().hex
    role, marked, snippet = db.execute("""SELECT role, highlight(messages, 2, ?, ?), snippet(messages, 2, ?, ?, ?, 18)
                                          FROM messages WHERE rowid=? AND messages MATCH ?""",
                                       (marker, marker, marker, marker, omitted, rowid, match)).fetchone()
    parts = marked.split(marker)
    hits = len(parts) // 2
    if hit is None:
        # Start on the first bold word in the compact FTS excerpt, which can be midway through a message.
        start = marked.index(snippet.removeprefix(omitted).removesuffix(omitted))
        hit = 1 + marked.count(marker, 0, start) // 2
    elif hit == -1:
        hit = hits
    if not 1 <= hit <= hits:
        raise ValueError('Occurrence outside this message.')
    at = 2 * hit - 1
    left, word, right = ''.join(parts[:at]), parts[at], ''.join(parts[at + 1:])
    def neighbor(previous):
        # Look in the same conversation even when transcripts were indexed in interleaved batches.
        direction, order, start = ('<', 'DESC', -161) if previous else ('>', 'ASC', 1)
        row = db.execute(f'SELECT role, substr(body, ?, 161) FROM messages WHERE key=? AND rowid {direction} ? '
                         f'ORDER BY rowid {order} LIMIT 1', (start, key, rowid)).fetchone()
        if not row: return None
        text = row[1]
        if len(text) == 161: text = '…' + text[1:] if previous else text[:-1] + '…'
        return {'role': row[0], 'text': text.strip()}
    return {'role': role, 'message': message, 'messages': len(ids), 'hit': hit, 'hits': hits,
            'parts': [left if len(left) <= 280 else '…' + left[-280:],
                      word if len(word) <= 360 else word[:360] + '…',
                      right if len(right) <= 280 else right[:280] + '…'],
            'before': neighbor(True) if len(left) <= 280 else None,
            'after': neighbor(False) if len(right) <= 280 else None}


def search(query, repo=None, path=INDEX, *, conversation=None, message=1, hit=None):
    """Match all literal keyword prefixes in one message and return one excerpt per conversation."""
    words = re.findall(r'[^\W_]+', query, re.UNICODE)
    if not conversation and (message != 1 or hit is not None):
        raise ValueError('Select a conversation with --conversation to navigate hits.')
    if conversation and not words: raise ValueError('Enter a search term to see matching context.')
    if not words: return {'ok': True, 'results': []}
    match = ' AND '.join(f'"{word}"*' for word in words)
    if not path.exists(): raise ValueError('Message index not built yet. Refresh History with ⟳.')
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.execute('BEGIN')
        if db.execute('PRAGMA user_version').fetchone()[0] != 1:
            raise ValueError('Message index is being built. Try again after the History scan.')
        scope_path = Path(repo.casefold()) if repo else None
        sources = {}
        for key, folder, title in db.execute('SELECT key,folder,title FROM sources WHERE folder IS NOT NULL'):
            path_parts = Path(folder.casefold())
            if (scope_path is None or path_parts.is_relative_to(scope_path)
                    or str(scope_path) in path_parts.parts):
                sources[key] = (folder, title)
        if conversation:
            if conversation not in sources: raise ValueError('Conversation outside the current search.')
            return {'ok': True, 'context': match_context(db, conversation, match, message, hit)}
        if not sources: return {'ok': True, 'results': []}
        # Pick the newest matching message per thread. Unary + keeps SQLite from expanding a common FTS
        # prefix again for each rowid; it runs MATCH once and tests membership before extracting excerpts.
        scope = 'AND key IN (SELECT value FROM json_each(?))' if repo else ''
        marker = uuid4().hex
        params = (marker, marker, match, match)
        rows = db.execute(f"""SELECT key, role, snippet(messages, 2, ?, ?, '…', 18) FROM messages
                           WHERE messages MATCH ? AND +rowid IN
                             (SELECT max(rowid) FROM messages WHERE messages MATCH ? {scope} GROUP BY key)""",
                          (*params, json.dumps(list(sources))) if repo else params)
        results = []
        for key, role, snippet in rows:
            if key in sources:
                parts = excerpt_parts(snippet, marker)
                results.append({'key': key, 'title': sources[key][1], 'folder': sources[key][0], 'role': role,
                                'excerpt': ''.join(parts), 'parts': parts})
    return {'ok': True, 'results': results}
