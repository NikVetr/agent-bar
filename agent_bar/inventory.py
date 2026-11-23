"""Inventory every saved Claude and Codex conversation, open or not, and resume one.

Each transcript is read once and afterwards only from where the previous scan
stopped, so the nightly refresh reads just what was appended since."""
import json
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from . import bridge, history_search
from .providers import UUID, epoch
from .state import ROOT, atomic_json

OUTPUT = ROOT / 'inventory.json'
# A gap longer than this between transcript entries is idle, not active time.
IDLE = 600
TIMESTAMP = re.compile(rb'"timestamp":"([^"]+)"')
CWD = re.compile(rb'"cwd":("(?:[^"\\]|\\.)*")')


def scan(path, state, inspect):
    """Advance a file's totals over the complete lines appended since its last scan."""
    stat = path.stat()
    if state.get('inode') != stat.st_ino or stat.st_size < state.get('offset', 0):
        state.clear()
        state.update(inode=stat.st_ino, offset=0, first=0, last=0, active=0, prompts=0)
    if stat.st_size == state['offset']: return state
    with path.open('rb') as stream:
        stream.seek(state['offset'])
        for line in stream:
            if not line.endswith(b'\n'): break
            state['offset'] += len(line)
            match = TIMESTAMP.search(line)
            at = epoch(match[1].decode()) if match else 0
            if at:
                if 0 < at - state['last'] <= IDLE: state['active'] += at - state['last']
                state['first'] = state['first'] or at
                state['last'] = max(state['last'], at)
            try: inspect(line, state)
            except json.JSONDecodeError:
                # A few historical transcripts contain damaged complete lines. Skip just that record,
                # keeping the count alongside its file offset so refresh reports incomplete coverage.
                state['invalid_lines'] = state.get('invalid_lines', 0) + 1
    return state


def claude_line(line, state):
    if 'cwd' not in state and (match := CWD.search(line)):
        state['cwd'] = json.loads(match[1])
    if line.startswith((b'{"type":"ai-title"', b'{"type":"custom-title"')):
        entry = json.loads(line)
        state['custom' if entry['type'] == 'custom-title' else 'ai'] = entry.get('customTitle') or entry.get('aiTitle')
    elif b'"promptSource"' in line:
        entry = json.loads(line)
        if entry.get('type') == 'user' and (entry.get('origin') or {}).get('kind') == 'human':
            state['prompts'] += 1


def codex_line(line, state):
    # Newer rollouts have no user_message events; Codex injects context as user
    # messages that start with a tag or the AGENTS.md heading.
    if b'"role":"user"' in line and b'"type":"response_item"' in line:
        payload = json.loads(line).get('payload') or {}
        if payload.get('type') == 'message' and payload.get('role') == 'user':
            text = ''.join(part.get('text', '') for part in payload.get('content') or []).lstrip()
            if not text.startswith(('<', '# AGENTS.md')): state['prompts'] += 1


def build(home=None, previous=None, index=None):
    home = Path(home or Path.home())
    files = (previous or {}).get('files', {})
    result, seen, keys = [], {}, set()

    def read(path, key, inspect):
        state = files.get(str(path), {})
        if index is None: return scan(path, state, inspect)
        keys.add(key)
        saved = index.execute('SELECT path,inode,offset FROM sources WHERE key=?', (key,)).fetchone()
        stat = path.stat()
        if (saved != (str(path), state.get('inode'), state.get('offset')) or state.get('inode') != stat.st_ino
                or stat.st_size < state.get('offset', 0)):
            if saved: index.execute('DELETE FROM messages WHERE key=?', (key,))
            state = {}
        provider = key.split(':', 1)[0]
        insert = index.execute
        def index_line(line, totals):
            prompts = totals['prompts']
            inspect(line, totals)
            message = history_search.dialogue(line, provider)
            if message:
                if message[0] == 'user' and totals['prompts'] == prompts: totals['prompts'] += 1
                insert('INSERT INTO messages(key,role,body) VALUES(?,?,?)', (key, *message))
        state = scan(path, state, index_line)
        index.execute('INSERT OR REPLACE INTO sources(key,path,inode,offset) VALUES(?,?,?,?)',
                      (key, str(path), state['inode'], state['offset']))
        return state

    for path in sorted((home / '.claude/projects').glob('*/*.jsonl')):
        if not UUID.fullmatch(path.stem): continue
        state = read(path, f'claude:{path.stem}', claude_line)
        seen[str(path)] = state
        if state['prompts'] and state.get('cwd'):
            result.append({'provider': 'claude', 'id': path.stem, 'folder': state['cwd'],
                           'title': state.get('custom') or state.get('ai') or path.stem[:8],
                           'started': state['first'], 'last': state['last'],
                           'active': round(state['active']), 'prompts': state['prompts']})
    database = home / '.codex/state_5.sqlite'
    if database.exists():
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=2) as connection:
            # Subagent threads record their parent in `source`; user threads have a plain one.
            threads = connection.execute(
                "SELECT id, coalesce(nullif(name, ''), title), cwd, created_at, updated_at, rollout_path "
                "FROM threads WHERE archived = 0 AND source NOT LIKE '{%'").fetchall()
        for sid, title, cwd, created, updated, rollout in threads:
            path = Path(rollout)
            if not path.exists(): continue
            state = read(path, f'codex:{sid}', codex_line)
            seen[str(path)] = state
            if state['prompts']:
                result.append({'provider': 'codex', 'id': sid, 'folder': cwd, 'title': title or sid[:8],
                               'started': created, 'last': max(updated, state['last']),
                               'active': round(state['active']), 'prompts': state['prompts']})
    for row in result:
        row.update(key=f'{row["provider"]}:{row["id"]}', project=Path(row['folder']).name or row['folder'],
                   available=Path(row['folder']).is_dir())
    result.sort(key=lambda row: -row['last'])
    if index is not None:
        index.executemany('UPDATE sources SET folder=?,title=? WHERE key=?',
                          [(row['folder'], row['title'], row['key']) for row in result])
        for (key,) in index.execute('SELECT key FROM sources').fetchall():
            if key not in keys:
                index.execute('DELETE FROM messages WHERE key=?', (key,))
                index.execute('DELETE FROM sources WHERE key=?', (key,))
    return {'schema': 1, 'updated': time.time(), 'conversations': result, 'files': seen}


def refresh():
    started = time.time()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = history_search.INDEX
    path.touch(mode=0o600, exist_ok=True)
    with closing(sqlite3.connect(path)) as db, db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('BEGIN IMMEDIATE')
        history_search.initialize(db)
        previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else None
        inventory = build(previous=previous, index=db)
        db.execute('PRAGMA user_version=1')
        atomic_json(OUTPUT, inventory)
    return {'ok': True, 'conversations': len(inventory['conversations']), 'seconds': round(time.time() - started, 1),
            'invalid_lines': sum(s.get('invalid_lines', 0) for s in inventory['files'].values())}


def resume(key):
    """Open the conversation's folder in VS Code and have that window's bridge reopen it."""
    if not OUTPUT.exists(): raise ValueError('No conversation inventory yet; refresh it first')
    matches = [row for row in json.loads(OUTPUT.read_text())['conversations'] if row['key'] == key]
    if len(matches) != 1: raise ValueError('Conversation is not in the inventory; refresh it and retry')
    row = matches[0]
    return bridge.in_folder(row['folder'], {'provider': row['provider'], 'conversation': row['id']}, 'resume', 'reopen chats')
