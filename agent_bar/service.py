"""Single local state collector and CLI command service."""
import asyncio
import contextlib
import fcntl
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

from . import messages
from .git import Repositories
from .providers import Providers, queue_snapshot
from .state import ROOT, Ledger, atomic_json, project_names

PROVIDERS = ['claude', 'codex', 'copilot', 'antigravity']
TURNS = {'start', 'message'}  # Any turn start, including automatic continuations.
QUIET = 300  # An open turn with no activity this long is waiting on something.
CONTINUE = 'Please continue where you left off.'  # Sent to chats a usage limit stopped.
GIT_EVERY = 20  # Seconds between git status reads of the open projects' repositories.
SETTINGS = Path.home() / '.config/agent-bar/settings.json'  # Written by the panel.
# Replaced atomically by the parallel-workers monitor on each of its refreshes.
QUEUES = Path(os.environ.get('PARALLEL_WORKERS_QUEUE_SNAPSHOT')
              or Path.home() / '.local/state/parallel-workers/queue-progress.tsv')


class Tracker:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        for directory in ['windows', 'requests', 'responses', 'events']:
            (self.root / directory).mkdir(exist_ok=True, mode=0o700)
        self.state_file = self.root / 'ledger.json'
        self.ledger = Ledger(json.loads(self.state_file.read_text()) if self.state_file.exists() else None)
        self.providers = Providers()
        self.rows, self.windows, self.warnings = [], {}, []
        self.quiet, self.scheduler, self.settings_stamp = QUIET, True, None
        self.git_enabled, self.repositories, self.git = True, Repositories(), None
        self.messages_enabled = True
        # 'on', 'off' (turned off in settings) or 'missing' (parallel-workers is not set up here).
        self.scheduler_status = 'on'
        self.queue_mtime = max((q.get('observed', 0) for q in self.ledger.data['queues'].values()), default=0)
        self.last_saved = None
        self.navigation = set()

    def collect(self):
        now = time.time()
        windows, rows, warnings = {}, [], []
        try:
            stamp = SETTINGS.stat().st_mtime
            if stamp != self.settings_stamp:
                saved = json.loads(SETTINGS.read_text())
                self.quiet = int(saved.get('quietMinutes', QUIET // 60)) * 60
                self.scheduler = saved.get('scheduler', True) is not False
                self.git_enabled = saved.get('git', True) is not False
                self.messages_enabled = saved.get('messages', True) is not False
                self.settings_stamp = stamp
        except FileNotFoundError:
            self.quiet, self.settings_stamp = QUIET, None
            self.scheduler = self.git_enabled = self.messages_enabled = True
        except (OSError, ValueError, TypeError) as error:
            warnings.append(f'Panel settings unreadable: {error}')
        for path in (self.root / 'windows').glob('*.json'):
            try:
                window = json.loads(path.read_text())
                if now - window['updated'] > 20:
                    # A dead bridge cannot establish that its old tabs are open.
                    if now - window['updated'] < 3600:
                        warnings.append(f'{window["workspace"]}: VS Code bridge is stale')
                    continue
                windows[window['id']] = window
                found, issues = self.providers.discover(window)
                warnings.extend(f'{window["workspace"]}: {issue}' for issue in issues)
                rows.extend(found)
            except (OSError, ValueError, KeyError) as error:
                warnings.append(f'Window metadata error: {error}')
        found, extra, issues = self.providers.external(list(windows.values()), now)
        rows.extend(found)
        warnings.extend(issues)
        windows.update((window['id'], window) for window in extra)
        for row in rows:
            try:
                for kind, at, turn in self.providers.events(row):
                    if not at: continue
                    self.ledger.event(row['key'], kind, at, turn)
                    if kind in TURNS: self.ledger.turn(row['roots'] or [row['project']], at)
            except (OSError, ValueError) as error:
                warnings.append(f'{row["title"]}: event source unavailable ({error})')
                row['source_stale'] = True
        consumed = []
        for path in sorted((self.root / 'events').glob('*.json'), key=lambda p: p.stat().st_mtime):
            try:
                event = json.loads(path.read_text())
                key = f'{event["provider"]}:{event["session"]}'
                if event['provider'] not in ['claude', 'codex']: raise ValueError('Unknown hook provider')
                kind = event['kind']
                background = self.providers.backgrounds.get(event['session']) if event['provider'] == 'claude' else None
                if kind == 'complete' and background:
                    background.read()
                    # A reply to an automatic wake-up while work is still pending is a progress note.
                    if not background.human and background.waiting(event['at']): kind = 'hold'
                self.ledger.event(key, kind, event['at'], event.get('turn'), event.get('resets'))
                self.ledger.conversation(key)['hook_seen'] = event['at']
                if event['kind'] in TURNS and event.get('cwd'):
                    self.ledger.turn([event['cwd']], event['at'])
                consumed.append(path)
            except (OSError, ValueError, KeyError) as error:
                warnings.append(f'Hook event error: {error}')
        # The monitor owns collection. We read only its local snapshot, never SMB
        # queue directories or worker logs, and only when it has changed.
        self.scheduler_status = 'off' if not self.scheduler else 'on' if QUEUES.parent.exists() else 'missing'
        try:
            if self.scheduler_status != 'on': raise FileNotFoundError
            stamp = QUEUES.stat().st_mtime
            values = queue_snapshot(QUEUES) if stamp > self.queue_mtime else None
            # An empty snapshot is not evidence that the listed queues ended.
            if values:
                for value in values:
                    if (value['state'] not in ['COMPLETED', 'FAILED', 'KILLED'] or
                            value['started'] > self.ledger.data['since'] - 86400 or
                            value['id'] in self.ledger.data['queues']):
                        self.ledger.queue(value, stamp)
                self.ledger.unlisted({value['id'] for value in values}, stamp)
                self.queue_mtime = stamp
        except FileNotFoundError:
            pass  # Reported below as a stale snapshot.
        except (OSError, ValueError) as error:
            warnings.append(f'Queue snapshot unavailable: {error}')
        if self.scheduler_status == 'on' and now - self.queue_mtime > 120:
            warnings.append('Queue snapshot stale; start the parallel-workers monitor to refresh it')
        self.windows, self.rows, self.warnings = windows, rows, warnings
        snapshot = self.snapshot()
        atomic_json(self.root / 'snapshot.json', snapshot)
        serialized = json.dumps(self.ledger.data, sort_keys=True)
        if serialized != self.last_saved:
            atomic_json(self.state_file, self.ledger.data)
            self.last_saved = serialized
        for path in consumed:
            path.unlink(missing_ok=True)

    def snapshot(self):
        rows, now = [], time.time()
        scheduler = self.scheduler_status == 'on'
        projects = self.ledger.queue_counts() if scheduler else {}
        # A project's finished queues need review in its most recently active open conversation,
        # whichever provider that is.
        finished, owners = self.ledger.queues_finished() if scheduler else {}, {}
        for row in self.rows:
            at = self.ledger.conversation(row['key'])['state_at']
            for name in (project_names(row['roots']) | {row['project']}) & finished.keys():
                if name not in owners or at > owners[name][1]: owners[name] = row['key'], at
        queues_at = {}
        for name, (key, _) in owners.items():
            queues_at[key] = max(finished[name], queues_at.get(key, 0))
        for row in self.rows:
            state = self.ledger.conversation(row['key'])
            shown = 'unknown' if row.get('source_stale') else state['state']
            background = self.providers.backgrounds.get(row['id']) if row['provider'] == 'claude' else None
            pending = bool(background and background.waiting(now))
            if shown == 'working' and background and background.ended_at >= state['state_at']:
                # The transcript shows the turn ended though its Stop event was missed.
                shown = 'waiting' if pending else 'finished'
            elif shown == 'working' and self.quiet and now - state['state_at'] > self.quiet: shown = 'waiting'
            elif shown == 'finished' and pending: shown = 'waiting'
            elif shown == 'waiting' and not pending: shown = 'finished'
            names = project_names(row['roots']) | {row['project']}
            matched = [projects[name] for name in names if name in projects]
            rows.append({**{k: v for k, v in row.items() if k != 'path'},
                         'state': shown,
                         'state_at': state['state_at'], 'turn': state['turn'],
                         'completed_at': state.get('completed_at',
                                                   state['state_at'] if state['state'] == 'finished' else 0),
                         'unread': self.ledger.unread(row['key'], queues_at.get(row['key'])),
                         'limited': state.get('limited'),
                         'queue_counts': {'done': sum(c['done'] for c in matched),
                                          'total': sum(c['total'] for c in matched)}})
        unique = {r['key']: r for r in rows}
        queues = [{**queue, 'counted': self.ledger.counted(queue)}
                  for queue in self.ledger.data['queues'].values()] if scheduler else []
        return {'schema': 1, 'updated': time.time(), 'cutoff': time.time(),
                'rows': rows, 'windows': list(self.windows.values()), 'warnings': self.warnings,
                'counts': {**{provider: sum(r['provider'] == provider for r in unique.values())
                              for provider in PROVIDERS},
                           'working': sum(r['state'] == 'working' for r in unique.values()),
                           'waiting': sum(r['state'] == 'waiting' for r in unique.values()),
                           'review': sum(bool(r['unread']) for r in unique.values()),
                           'queues': sum(c['total'] for c in projects.values()),
                           'done': sum(c['done'] for c in projects.values())},
                'queues': queues, 'queue_counts': projects, 'queue_updated': self.queue_mtime,
                'scheduler': self.scheduler_status,
                'git': self.git if self.git_enabled else None,
                'messages': self.message_summary(rows) if self.messages_enabled else None,
                'returns': self.ledger.data.get('returns', {})}

    def message_summary(self, rows):
        """Messages for the panel, with the open chats whose unread ones wait for the user to start a turn."""
        human = {key: row.get('human_at', 0) for key, row in self.ledger.data['conversations'].items()}
        try:
            summary = messages.summary(self.root, human)
            return {**summary, 'stranded': messages.stranded(summary['unread'], rows, self.root)}
        except (OSError, sqlite3.Error) as error:
            self.warnings.append(f'Agent messages unreadable: {error}')
            return None

    async def navigate(self, key, window_id, input=False):
        """Select a conversation in its window; with `input`, also put the cursor in a Claude chat's input box when
        that can be done surely, saying so as `input`."""
        if window_id in self.navigation: raise ValueError('This window is already navigating')
        matches = [r for r in self.rows if r['key'] == key and r['window'] == window_id]
        if len(matches) != 1 or not matches[0]['target']:
            raise ValueError('No unambiguous open conversation target')
        # Terminal and app sessions have nothing to select once their window is forward.
        if matches[0]['target']['kind'] == 'window': return {'ok': True}
        window = self.windows.get(window_id)
        row = matches[0]
        result = await self.bridge(window_id, {'type': 'navigate', 'target': row['target'], 'input': input})
        # Recheck the live source before acknowledging a sidebar.
        if row['target']['kind'] == 'codex-sidebar':
            current = self.providers.codex_open(window)
            if row['id'] not in current:
                raise ValueError('The sidebar conversation changed during navigation')
        return {'ok': True, 'input': bool(result.get('input'))}

    async def go_on(self, key):
        """Have an open VS Code chat a usage limit stopped go on: a Codex chat gets CONTINUE queued, which its
        VS Code starts as a turn; for a Claude chat, the text comes back for the panel to put in its input box."""
        rows = [row for row in self.rows if row['key'] == key and (row.get('target') or {}).get('kind') in messages.VSCODE]
        if not rows: raise ValueError('This chat is not open in VS Code')
        if not self.ledger.conversation(key).get('limited'): raise ValueError('No usage limit stopped this chat')
        if rows[0]['provider'] == 'claude': return {'ok': True, 'paste': CONTINUE}
        if rows[0]['provider'] != 'codex': raise ValueError('Only Claude and Codex chats can be continued')
        await asyncio.to_thread(messages.codex_queue, rows[0]['id'], CONTINUE)
        return {'ok': True, 'queued': True}

    async def show_scm(self, window_id):
        window = self.windows.get(window_id)
        if not window or window.get('kind'): raise ValueError('Not a VS Code window')
        if not window.get('scm'):
            raise ValueError("This VS Code window's tracker bridge predates Source Control; reload the window")
        return await self.bridge(window_id, {'type': 'scm'})

    async def bridge(self, window_id, action):
        """Hand one action to a window's VS Code bridge and wait for its answer."""
        window = self.windows.get(window_id)
        if not window or time.time() - window['updated'] > 15:
            raise ValueError('The VS Code bridge is stale')
        if window_id in self.navigation: raise ValueError('This window is already navigating')
        self.navigation.add(window_id)
        action = {**action, 'id': str(uuid.uuid4()), 'expires': time.time() + 8}
        response = self.root / 'responses' / f'{action["id"]}.json'
        request = self.root / 'requests' / f'{window_id}.json'
        try:
            atomic_json(request, action)
            for _ in range(80):
                await asyncio.sleep(.1)
                if response.exists():
                    result = json.loads(response.read_text())
                    response.unlink()
                    if not result['ok']: raise ValueError(result.get('error', 'VS Code could not do that'))
                    return result
            raise ValueError('VS Code did not confirm within eight seconds')
        finally:
            self.navigation.discard(window_id)
            with contextlib.suppress(FileNotFoundError): request.unlink()

    async def dispatch(self, command):
        op = command.get('op')
        if op == 'snapshot': return self.snapshot()
        if op == 'navigate': return await self.navigate(command['key'], command['window'], command.get('input', False))
        if op == 'continue': return await self.go_on(command['key'])
        if op == 'show-scm': return await self.show_scm(command['window'])
        if op == 'ack':
            if command['key'] not in self.ledger.data['conversations']:
                raise ValueError('Unknown conversation')
            cutoff = min(float(command['cutoff']), time.time())
            self.ledger.acknowledge(command['key'], cutoff)
        elif op == 'save-return':
            if command['window'] not in self.windows: raise ValueError('Unknown window')
            value = json.loads(command['record'])
            if not isinstance(value, dict): raise ValueError('Invalid return record')
            self.ledger.data.setdefault('returns', {})[command['window']] = value
        elif op == 'clear-return':
            self.ledger.data.setdefault('returns', {}).pop(command['window'], None)
        else:
            raise ValueError(f'Unsupported operation: {op}')
        atomic_json(self.state_file, self.ledger.data)
        atomic_json(self.root / 'snapshot.json', self.snapshot())
        return {'ok': True}

    async def client(self, reader, writer):
        try:
            data = await asyncio.wait_for(reader.readline(), 3)
            result = await self.dispatch(json.loads(data))
        except Exception as error:
            result = {'ok': False, 'error': str(error)}
        writer.write((json.dumps(result) + '\n').encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async def read_git(self):
        """Git status of the repositories holding open projects, off the collection loop."""
        while True:
            if self.git_enabled:
                folders = {root for window in self.windows.values() for root in window.get('roots', [])}
                folders |= {root for row in self.rows for root in row['roots']}
                try: self.git = {'updated': time.time(), 'repos': await asyncio.to_thread(self.repositories.read, folders)}
                except Exception as error:
                    print(f'Git status failed: {type(error).__name__}: {error}', flush=True)
            await asyncio.sleep(GIT_EVERY)

    async def run(self):
        lock = (self.root / 'service.lock').open('w')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        socket = self.root / 'service.sock'
        with contextlib.suppress(FileNotFoundError): socket.unlink()
        server = await asyncio.start_unix_server(self.client, path=str(socket))
        os.chmod(socket, 0o600)
        refresh = asyncio.create_task(self.read_git())
        async with server:
            while True:
                try: self.collect()
                except Exception as error:
                    print(f'Collection failed: {type(error).__name__}: {error}', flush=True)
                await asyncio.sleep(3)

