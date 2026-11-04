"""Inventory every saved Claude and Codex conversation, open or not, and resume one.

Each transcript is read once and afterwards only from where the previous scan
stopped, so the nightly refresh reads just what was appended since."""
import json
import re
import shutil
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path

from .providers import UUID, epoch
from .state import ROOT, atomic_json

OUTPUT = ROOT / 'inventory.json'
# A gap longer than this between transcript entries is idle, not active time.
IDLE = 600
TIMESTAMP = re.compile(rb'"timestamp":"([^"]+)"')
CWD = re.compile(rb'"cwd":("(?:[^"\\]|\\.)*")')
RESUME_WAIT = 45


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
            inspect(line, state)
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


def build(home=None, previous=None):
    home = Path(home or Path.home())
    files = (previous or {}).get('files', {})
    result, seen = [], {}
    for path in sorted((home / '.claude/projects').glob('*/*.jsonl')):
        if not UUID.fullmatch(path.stem): continue
        state = scan(path, files.get(str(path), {}), claude_line)
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
            state = scan(path, files.get(str(path), {}), codex_line)
            seen[str(path)] = state
            if state['prompts']:
                result.append({'provider': 'codex', 'id': sid, 'folder': cwd, 'title': title or sid[:8],
                               'started': created, 'last': max(updated, state['last']),
                               'active': round(state['active']), 'prompts': state['prompts']})
    for row in result:
        row.update(key=f'{row["provider"]}:{row["id"]}', project=Path(row['folder']).name or row['folder'],
                   available=Path(row['folder']).is_dir())
    result.sort(key=lambda row: -row['last'])
    return {'schema': 1, 'updated': time.time(), 'conversations': result, 'files': seen}


def refresh():
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else None
    started = time.time()
    inventory = build(previous=previous)
    atomic_json(OUTPUT, inventory)
    return {'ok': True, 'conversations': len(inventory['conversations']), 'seconds': round(time.time() - started, 1)}


def resume(key):
    """Open the conversation's folder in VS Code and have that window's bridge reopen it."""
    if not OUTPUT.exists(): raise ValueError('No conversation inventory yet; refresh it first')
    matches = [row for row in json.loads(OUTPUT.read_text())['conversations'] if row['key'] == key]
    if len(matches) != 1: raise ValueError('Conversation is not in the inventory; refresh it and retry')
    row = matches[0]
    if not row['available']: raise ValueError(f'Its folder no longer exists: {row["folder"]}')
    live = []
    for path in (ROOT / 'windows').glob('*.json'):
        try: window = json.loads(path.read_text())
        except (OSError, ValueError): continue
        if row['folder'] in window.get('roots', []) and time.time() - window.get('updated', 0) < 15: live.append(window)
    # `code` focuses an open window on the folder instead of opening another.
    if live and not any(window.get('resume') for window in live):
        raise ValueError(f'The VS Code window on {row["project"]} started before resume support; '
                         'run Developer: Reload Window in it, then retry')
    code = shutil.which('code')
    if not code: raise ValueError('The VS Code `code` command is not on PATH')
    action = str(uuid.uuid4())
    (ROOT / 'resume').mkdir(mode=0o700, exist_ok=True)
    request = ROOT / 'resume' / f'{action}.json'
    response = ROOT / 'responses' / f'{action}.json'
    atomic_json(request, {'id': action, 'provider': row['provider'], 'conversation': row['id'],
                          'folder': row['folder'], 'expires': time.time() + RESUME_WAIT})
    # Focuses the window already open on this folder, or opens a new one.
    subprocess.Popen([code, row['folder']], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        for _ in range(RESUME_WAIT * 4):
            time.sleep(.25)
            if response.exists():
                result = json.loads(response.read_text())
                response.unlink()
                if not result['ok']: raise ValueError(result.get('error', 'VS Code could not reopen it'))
                return {'ok': True}
        raise ValueError(f'No VS Code window on {row["folder"]} took the request within {RESUME_WAIT} s')
    finally:
        request.unlink(missing_ok=True)
