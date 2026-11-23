"""Local full-text index of the visible dialogue in saved conversations."""
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path

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


def search(query, repo=None, path=INDEX):
    """Match all literal keyword prefixes in one message and return one excerpt per conversation."""
    words = re.findall(r'[^\W_]+', query, re.UNICODE)
    if not words: return {'ok': True, 'results': []}
    match = ' AND '.join(f'"{word}"*' for word in words)
    if not path.exists(): raise ValueError('Message index not built yet. Refresh History with ⟳.')
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA user_version').fetchone()[0] != 1:
            raise ValueError('Message index is being built. Try again after the History scan.')
        scope_path = Path(repo.casefold()) if repo else None
        sources = {}
        for key, folder, title in db.execute('SELECT key,folder,title FROM sources WHERE folder IS NOT NULL'):
            path_parts = Path(folder.casefold())
            if (scope_path is None or path_parts.is_relative_to(scope_path)
                    or str(scope_path) in path_parts.parts):
                sources[key] = (folder, title)
        if not sources: return {'ok': True, 'results': []}
        # Pick the newest matching message per thread. Unary + keeps SQLite from expanding a common FTS
        # prefix again for each rowid; it runs MATCH once and tests membership before extracting excerpts.
        scope = 'AND key IN (SELECT value FROM json_each(?))' if repo else ''
        rows = db.execute(f"""SELECT key, role, snippet(messages, 2, '', '', '…', 18) FROM messages
                           WHERE messages MATCH ? AND +rowid IN
                             (SELECT max(rowid) FROM messages WHERE messages MATCH ? {scope} GROUP BY key)""",
                          (match, match, json.dumps(list(sources))) if repo else (match, match))
        results = [{'key': key, 'title': sources[key][1], 'folder': sources[key][0], 'role': role,
                    'excerpt': ' '.join(excerpt.split())[:360]} for key, role, excerpt in rows if key in sources]
    return {'ok': True, 'results': results}
