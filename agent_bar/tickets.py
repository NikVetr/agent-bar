"""Tickets: tasks the user or an agent wants done but that cannot or need not be done now, each in a project.

A ticket can wait for things Agent Bar already watches: a usage limit's reset, a project's queues finishing, a
time, or another ticket closing. Waits are fixed when the ticket is written (the reset time then in force, the
queues then outstanding), so a ticket is ready once all of them have passed. Tickets are taken by the chat that
works on them and closed as done or dropped; closed ones are kept for KEEP.

A ticket can also be sent: once ready, the service delivers its text as a message to a chosen open chat, from its
author (the user's own tickets arrive as the user's requests), and closes it, or, if it repeats, moves its time on
to the next occurrence and stays open."""
import calendar
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import bridge, messages
from .state import ROOT, project_names

LENGTH_LIMIT = 4000
KEEP = 30 * 86400  # Closed tickets are kept this long.
CLOSED_LISTED = 20  # Closed tickets the panel lists.
STATUSES = {'open', 'started', 'done', 'dropped'}
RETRY = 600  # Seconds before a failed delivery is tried again.
REPEAT_MIN = 3600  # The shortest repeat: a send at most hourly.
REPEAT_HELP = 'day, week, month, or <N>h, <N>d or <N>w (at least 1h)'
# Columns added after the first release of tickets.
DELIVERY = [('deliver_to', 'TEXT'), ('deliver_title', 'TEXT'), ('repeat', 'TEXT'), ('sent_at', 'REAL'),
            ('sent_count', 'INTEGER NOT NULL DEFAULT 0'), ('delivery_error', 'TEXT'), ('tried_at', 'REAL')]
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
    columns = {column[1] for column in connection.execute('PRAGMA table_info(tickets)')}
    for name, kind in DELIVERY:
        if name not in columns: connection.execute(f'ALTER TABLE tickets ADD COLUMN {name} {kind}')
    return connection


def repeat_seconds(repeat):
    """A repeat's length in seconds (a month counts as 28 days, for the minimum check only), or a ValueError."""
    named = {'day': 86400, 'week': 7 * 86400, 'month': 28 * 86400}
    if repeat in named: return named[repeat]
    match = re.fullmatch(r'(\d+(?:\.\d+)?)([hdw])', repeat or '')
    if not match: raise ValueError(f'Unreadable repeat {repeat!r}; use {REPEAT_HELP}')
    seconds = float(match[1]) * {'h': 3600, 'd': 86400, 'w': 7 * 86400}[match[2]]
    if seconds < REPEAT_MIN: raise ValueError('A ticket repeats at most hourly')
    return seconds


def repeat_label(repeat):
    if repeat in ('day', 'week', 'month'): return f'every {repeat}'
    number, unit = repeat[:-1], {'h': 'hour', 'd': 'day', 'w': 'week'}[repeat[-1]]
    return f'every {number} {unit}{"" if number == "1" else "s"}'


def next_time(at, repeat, now):
    """The first occurrence after `now` of a repeat that began at `at`; missed ones are skipped, not sent late."""
    if repeat == 'month':
        moment, months = datetime.fromtimestamp(at), 0
        while True:
            months += 1
            year, month = divmod(moment.month - 1 + months, 12)
            day = min(moment.day, calendar.monthrange(moment.year + year, month + 1)[1])
            candidate = moment.replace(year=moment.year + year, month=month + 1, day=day).timestamp()
            if candidate > now: return candidate
    step = repeat_seconds(repeat)
    if repeat in ('day', 'week'):
        # By the calendar, so a daily 09:00 stays at 09:00 across daylight saving changes.
        moment, days = datetime.fromtimestamp(at), 0
        while True:
            days += 1 if repeat == 'day' else 7
            # Local wall-clock arithmetic: timestamp() reads the result in the offset in force on that day.
            candidate = (moment + timedelta(days=days)).timestamp()
            if candidate > now: return candidate
    return at + (int((now - at) // step) + 1) * step


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


def add(body, folder=None, after=(), who=None, root=ROOT, now=None, to=None, repeat=None):
    """A new ticket in `folder`'s project: by default the writing chat's folder, or for the user the current one. With
    `to`, an open chat's key, it is sent there once ready; with `repeat`, again at each occurrence of its time."""
    now = now or time.time()
    body = body.strip()
    if not body: raise ValueError('Empty ticket')
    if len(body) > LENGTH_LIMIT: raise ValueError(f'Tickets are limited to {LENGTH_LIMIT} characters; point to a file instead')
    who = author(who)
    mine = chat(who, root) if who != 'user' else {}
    folder = str(Path(folder).expanduser().resolve()) if folder else (mine.get('roots') or [None])[0] or str(Path.cwd())
    waits = [parse_after(text, folder, root, now) for text in after]
    target = None
    if to:
        target = next((row for row in messages.agents(root) if row['key'] == to), None)
        if not target: raise ValueError(f'{to} is not an open Claude Code or Codex chat; `agent-bar agents` lists them')
        if to == who: raise ValueError('A chat cannot send a ticket to itself')
    if repeat:
        repeat_seconds(repeat)
        if not to: raise ValueError('Only a ticket sent to a chat repeats (--to)')
        if sum(wait['kind'] == 'date' for wait in waits) != 1:
            raise ValueError('A repeating ticket needs one time to start from (--after date:…)')
        for wait in waits:
            if wait['kind'] == 'date':
                # Occurrences count from here, so a monthly send on the 31st comes back to the 31st.
                wait['anchor'] = wait['at']
                wait['label'] += f', then {repeat_label(repeat)}'
    with connect(root) as connection:
        connection.execute("DELETE FROM tickets WHERE status IN ('done', 'dropped') AND status_at<?", (now - KEEP,))
        cursor = connection.execute(
            'INSERT INTO tickets (at, author, author_title, project, folder, body, after, status_at, deliver_to, deliver_title, repeat)'
            ' VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (now, who, mine.get('title'), Path(folder).name, folder, body, json.dumps(waits), now, to,
             target and target['title'], repeat))
    return {'ok': True, 'id': cursor.lastrowid, 'project': Path(folder).name, 'waits': [wait['label'] for wait in waits],
            **({'to': target['title']} if target else {}), **({'repeat': repeat_label(repeat)} if repeat else {})}


def due(ticket, now):
    """Whether a listed ticket should be sent now: ready, with a chat to go to, and not failed within RETRY."""
    return bool(ticket['ready'] and ticket.get('deliver_to') and (not ticket.get('tried_at') or now - ticket['tried_at'] >= RETRY))


def deliver_due(root=ROOT, now=None):
    """Send each ready ticket that has a chat to go to, from its author, then close it, or move a repeating one on to
    its next time. A failed send is recorded on the ticket and tried again after RETRY."""
    now = now or time.time()
    sent = []
    for ticket in listing(root, now)['open']:
        if not due(ticket, now): continue
        try:
            messages.send(ticket['author'], ticket['deliver_to'], ticket['body'], root, now, scheduled=ticket['id'])
        except (OSError, ValueError, KeyError, sqlite3.Error) as error:
            with connect(root) as connection:
                connection.execute('UPDATE tickets SET delivery_error=?, tried_at=? WHERE id=?', (str(error), now, ticket['id']))
            continue
        with connect(root) as connection:
            if ticket['repeat']:
                waits = ticket['after']
                for wait in waits:
                    if wait['kind'] == 'date':
                        wait['at'] = next_time(wait.get('anchor', wait['at']), ticket['repeat'], now)
                        wait['label'] = f'{time.strftime("%a %b %-d, %H:%M", time.localtime(wait["at"]))}, then {repeat_label(ticket["repeat"])}'
                connection.execute('UPDATE tickets SET after=?, sent_at=?, sent_count=sent_count+1, delivery_error=NULL, tried_at=NULL'
                                   ' WHERE id=?', (json.dumps(waits), now, ticket['id']))
            else:
                connection.execute("UPDATE tickets SET status='done', status_at=?, note=?, sent_at=?, sent_count=sent_count+1,"
                                   ' delivery_error=NULL, tried_at=NULL WHERE id=?',
                                   (now, f'Sent to {ticket["deliver_title"] or ticket["deliver_to"]}', now, ticket['id']))
        sent.append(ticket['id'])
    return sent


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
