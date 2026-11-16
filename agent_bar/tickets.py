"""Tickets: tasks the user or an agent wants done but that cannot or need not be done now, each in a project.

A ticket can wait for things Agent Bar already watches: a usage limit's reset, a project's queues finishing, a
time, or another ticket closing. Waits are fixed when the ticket is written (the reset time then in force, the
queues then outstanding), so a ticket is ready once all of them have passed. Tickets are taken by the chat that
works on them and closed as done or dropped; closed ones are kept for KEEP."""
import json
import os
import re
import sqlite3
import time
from datetime import datetime
from pathlib import Path

from . import bridge
from .state import ROOT, project_names

LENGTH_LIMIT = 4000
KEEP = 30 * 86400  # Closed tickets are kept this long.
CLOSED_LISTED = 20  # Closed tickets the panel lists.
STATUSES = {'open', 'started', 'done', 'dropped'}
AFTER_HELP = ('reset:<claude|codex>[:<limit>], queues, queue:<id>, date:<YYYY-MM-DD[ HH:MM]> or date:+<N>h|d, '
              'or ticket:<number>')


def author(explicit=None):
    """Who is writing: the agent conversation running this command, which cannot pass itself off as the user, or
    else `explicit`, or the user."""
    if os.environ.get('CLAUDE_CODE_SESSION_ID'): return f'claude:{os.environ["CLAUDE_CODE_SESSION_ID"]}'
    if os.environ.get('CODEX_THREAD_ID'): return f'codex:{os.environ["CODEX_THREAD_ID"]}'
    return explicit or 'user'


def connect(root=ROOT):
    connection = sqlite3.connect(Path(root) / 'tickets.sqlite', timeout=2)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('''CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, author TEXT NOT NULL, author_title TEXT,
        project TEXT NOT NULL, folder TEXT, body TEXT NOT NULL, after TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open', status_at REAL NOT NULL, taken_by TEXT, taken_title TEXT, note TEXT)''')
    return connection


def read_json(path, default):
    try: return json.loads(Path(path).read_text())
    except FileNotFoundError: return default


def chat(key, root=ROOT):
    """An open conversation's row from the last snapshot, or {}."""
    rows = read_json(Path(root) / 'snapshot.json', {'rows': []})['rows']
    return next((row for row in rows if row['key'] == key), {})


def parse_when(text, now):
    if match := re.fullmatch(r'\+(\d+(?:\.\d+)?)([hd])', text):
        return now + float(match[1]) * (3600 if match[2] == 'h' else 86400)
    try: return datetime.fromisoformat(text).timestamp()
    except ValueError: raise ValueError(f'Unreadable time {text!r}; use YYYY-MM-DD, YYYY-MM-DD HH:MM or +<N>h / +<N>d') from None


def parse_after(text, folder, root=ROOT, now=None):
    """One wait, fixed now: what it waits for and a label saying so."""
    now = now or time.time()
    kind, _, rest = text.partition(':')
    if kind == 'reset':
        provider, _, key = rest.partition(':')
        usage = read_json(Path(root) / 'snapshot.json', {}).get('usage') or {}
        limits = [limit for limit in (usage.get(provider) or {}).get('limits', []) if limit.get('resets_at')]
        if not limits: raise ValueError(f'No {provider or "?"} usage limit with a reset time is recorded (see `agent-bar usage`)')
        # By default the limit that binds now, else the weekly one.
        limit = next((limit for limit in limits if limit['key'] == key), None) if key else \
            next((limit for limit in limits if limit.get('limiting')), None) or next((limit for limit in limits if limit['key'] == 'weekly'), limits[0])
        if not limit: raise ValueError(f'{provider} has no limit {key!r}; it has {", ".join(limit["key"] for limit in limits)}')
        name = {'claude': 'Claude', 'codex': 'Codex'}.get(provider, provider)
        return {'kind': 'reset', 'provider': provider, 'limit': limit['key'], 'at': limit['resets_at'],
                'label': f'{name} {limit["name"].lower()} limit resets'}
    if kind in ('queues', 'queue'):
        queues = read_json(Path(root) / 'ledger.json', {'queues': {}})['queues']
        if kind == 'queue':
            if rest not in queues: raise ValueError(f'No queue {rest!r} is tracked')
            ids = [rest]
        else:
            names = project_names([folder]) if folder else set()
            ids = [id for id, queue in queues.items() if queue['project'] in names and queue.get('finished_at') is None]
            if not ids: raise ValueError(f'{Path(folder).name if folder else "This ticket"} has no queues outstanding')
        label = queues[ids[0]].get('label') or ids[0] if len(ids) == 1 else f'{len(ids)} queues'
        return {'kind': 'queues', 'ids': ids, 'label': f'{label} finish{"es" if len(ids) == 1 else ""}'}
    if kind == 'date':
        at = parse_when(rest, now)
        return {'kind': 'date', 'at': at, 'label': time.strftime('%a %b %-d, %H:%M', time.localtime(at))}
    if kind == 'ticket':
        if not rest.isdigit(): raise ValueError('ticket: takes a ticket number')
        with connect(root) as connection:
            if not connection.execute('SELECT 1 FROM tickets WHERE id=?', (int(rest),)).fetchone():
                raise ValueError(f'No ticket #{rest}')
        return {'kind': 'ticket', 'id': int(rest), 'label': f'#{rest} closes'}
    raise ValueError(f'Unknown wait {text!r}; use {AFTER_HELP}')


def add(body, folder=None, after=(), who=None, root=ROOT, now=None):
    """A new ticket in `folder`'s project: by default the writing chat's folder, or for the user the current one."""
    now = now or time.time()
    body = body.strip()
    if not body: raise ValueError('Empty ticket')
    if len(body) > LENGTH_LIMIT: raise ValueError(f'Tickets are limited to {LENGTH_LIMIT} characters; point to a file instead')
    who = author(who)
    mine = chat(who, root) if who != 'user' else {}
    folder = str(Path(folder).expanduser().resolve()) if folder else (mine.get('roots') or [None])[0] or str(Path.cwd())
    waits = [parse_after(text, folder, root, now) for text in after]
    with connect(root) as connection:
        connection.execute("DELETE FROM tickets WHERE status IN ('done', 'dropped') AND status_at<?", (now - KEEP,))
        cursor = connection.execute(
            'INSERT INTO tickets (at, author, author_title, project, folder, body, after, status_at) VALUES (?,?,?,?,?,?,?,?)',
            (now, who, mine.get('title'), Path(folder).name, folder, body, json.dumps(waits), now))
    return {'ok': True, 'id': cursor.lastrowid, 'project': Path(folder).name, 'waits': [wait['label'] for wait in waits]}


def change(number, status, note=None, who=None, root=ROOT, now=None):
    """Take (started), close (done or dropped) or reopen a ticket."""
    if status not in STATUSES: raise ValueError(f'Unknown status {status!r}')
    now, who = now or time.time(), author(who)
    with connect(root) as connection:
        row = connection.execute('SELECT status FROM tickets WHERE id=?', (number,)).fetchone()
        if not row: raise ValueError(f'No ticket #{number}')
        if status == 'started':
            connection.execute('UPDATE tickets SET status=?, status_at=?, taken_by=?, taken_title=? WHERE id=?',
                               (status, now, who, chat(who, root).get('title') if who != 'user' else None, number))
        else:
            connection.execute('UPDATE tickets SET status=?, status_at=?, note=coalesce(?, note) WHERE id=?',
                               (status, now, note, number))
    return {'ok': True, 'id': number, 'status': status}


def pending(ticket, queues, unclosed, now):
    """The labels of a ticket's waits that have not passed; `unclosed` holds the open and started tickets' numbers."""
    unmet = []
    for wait in ticket['after']:
        if wait['kind'] in ('reset', 'date'): done = now >= wait['at']
        # A queue the tracker has forgotten finished long ago.
        elif wait['kind'] == 'queues': done = all(queues.get(id, {'finished_at': 0}).get('finished_at') is not None for id in wait['ids'])
        else: done = wait['id'] not in unclosed
        if not done: unmet.append(wait['label'])
    return unmet


def prompt(ticket):
    """What to paste into a chat to have it do the ticket."""
    source = 'your user' if ticket['author'] == 'user' else f'the agent chat "{ticket["author_title"] or ticket["author"]}"'
    return (f'Agent Bar ticket #{ticket["id"]} in {ticket["project"]} ({ticket["folder"]}), written by {source}:\n\n{ticket["body"]}\n\n'
            f'Run `agent-bar ticket take {ticket["id"]}` before starting, and `agent-bar ticket done {ticket["id"]} --note "<one line>"` '
            'when it is finished.')


def start(number, root=ROOT):
    """Open a new Claude Code chat in the ticket's folder, in VS Code, with its prompt in the input box for the user to
    send; the chat takes the ticket itself, as the prompt asks."""
    with connect(root) as connection:
        row = connection.execute('SELECT * FROM tickets WHERE id=?', (number,)).fetchone()
    if not row: raise ValueError(f'No ticket #{number}')
    if row['status'] != 'open': raise ValueError(f'Ticket #{number} is {row["status"]}')
    if not row['folder']: raise ValueError(f'Ticket #{number} has no folder')
    bridge.in_folder(row['folder'], {'provider': 'claude', 'prompt': prompt(dict(row))}, 'start', 'start chats with a prompt', root)
    return {'ok': True, 'id': number}


def listing(root=ROOT, now=None, queues=None):
    """Open and started tickets, each with its unmet waits and whether it is ready, then the latest closed ones."""
    if not (Path(root) / 'tickets.sqlite').exists(): return {'ok': True, 'open': [], 'closed': []}
    now = now or time.time()
    if queues is None: queues = read_json(Path(root) / 'ledger.json', {'queues': {}})['queues']
    with connect(root) as connection:
        rows = [dict(row) for row in connection.execute(
            "SELECT * FROM tickets WHERE status IN ('open', 'started') OR status_at>? ORDER BY id", (now - KEEP,))]
    unclosed = {row['id'] for row in rows if row['status'] in ('open', 'started')}
    result = {'ok': True, 'open': [], 'closed': []}
    for row in rows:
        row['after'] = json.loads(row['after'])
        row['prompt'] = prompt(row)
        if row['status'] in ('open', 'started'):
            row['waiting'] = pending(row, queues, unclosed, now)
            row['ready'] = row['status'] == 'open' and not row['waiting']
            result['open'].append(row)
        else: result['closed'].append(row)
    result['closed'] = sorted(result['closed'], key=lambda row: -row['status_at'])[:CLOSED_LISTED]
    return result
