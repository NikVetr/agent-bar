"""Single local state collector and CLI command service."""
import asyncio
import contextlib
import fcntl
import json
import os
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path

from . import checklists, messages, queue_workflows, tickets, usage
from .git import Repositories
from .providers import Providers, queue_snapshot
from .state import ROOT, Ledger, atomic_json, project_names

PROVIDERS = ['claude', 'codex', 'copilot', 'antigravity']
TURNS = {'start', 'message'}  # Any turn start, including automatic continuations.
QUIET = 300  # An open turn with no activity this long is waiting on something.
CONTINUE = 'Please continue where you left off.'  # Sent to chats a usage limit stopped.
GIT_EVERY = 20  # Seconds between git status reads of the open projects' repositories while the Git tab shows them.
GIT_IDLE = 300  # Seconds between them otherwise.
GIT_WATCHED = 30  # The panel touches git-watched every 10 s while its Git tab is open; this old, it has closed.
HEARTBEAT = 10  # Seconds an unchanged snapshot stands before it is written again, so the panel can tell the service runs.
CODEX_APPROVAL_GRACE = 10  # Brief permission checks often resolve automatically while Codex is still working.
USAGE_EVERY = 60  # Seconds between reads of the usage limits Claude Code and Codex record.
CHECKLIST_EVERY = 30  # Seconds between scans of the open projects' task checklists.
TICKET_EVERY = 30  # Seconds a ticket listing stands while nothing it reads changes; its waits on times pass meanwhile.
PRUNE_EVERY = 3600  # Seconds between clean-ups of what closed chats, windows and old queues left behind.
STALE_WINDOW = 86400  # A VS Code bridge silent this long has gone with its window.
SETTINGS = Path.home() / '.config/agent-bar/settings.json'  # Written by the panel.
# Replaced atomically by the parallel-workers monitor on each of its refreshes.
QUEUES = Path(os.environ.get('PARALLEL_WORKERS_QUEUE_SNAPSHOT')
              or Path.home() / '.local/state/parallel-workers/queue-progress.tsv')


class Tracker:
    def __init__(self, root: 'str | Path' = ROOT):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        for directory in ['windows', 'requests', 'responses', 'events']:
            (self.root / directory).mkdir(exist_ok=True, mode=0o700)
        self.state_file = self.root / 'ledger.json'
        self.ledger = Ledger(json.loads(self.state_file.read_text()) if self.state_file.exists() else None)
        self.providers = Providers()
        self.providers.views = self.ledger.data.setdefault('codex_views', {})
        self.rows, self.windows, self.warnings = [], {}, []
        self.quiet, self.scheduler, self.settings_stamp = QUIET, True, None
        self.git_enabled, self.repositories, self.git = True, Repositories(), None
        self.messages_enabled = True
        # The ticket listing and what it was read from.
        self.tickets, self.tickets_read = None, None
        # The usage limits summary (usage.py), refreshed off the collection loop, and why it last failed.
        self.usage, self.usage_error = None, None
        # Whether the user turned on Agent Bar's own reads of Claude's limits (off unless chosen).
        self.claude_reads = False
        self.resume_codex = False
        self.continuing = set()
        self.workflow_lock = asyncio.Lock()
        self.workflow_result, self.workflow_at, self.workflow_tags = None, 0, set()
        # 'on', 'off' (turned off in settings) or 'missing' (parallel-workers is not set up here).
        self.scheduler_status = 'on'
        self.queue_mtime = max((q.get('observed', 0) for q in self.ledger.data['queues'].values()), default=0)
        self.last_saved = None
        # The snapshot as last written, without its times, and when.
        self.snapshot_written, self.snapshot_at = None, 0
        self.navigation = set()
        # Queue ids in the monitor's latest snapshot, once read; pruning keeps every listed queue.
        self.listed, self.pruned_at = None, 0
        # Parsed checklists by path, the per-folder counts in the snapshot, and what checklists.json last held.
        self.checklist_cache, self.checklist_counts, self.checklists_written, self.checklists_at = {}, {}, None, 0

    def collect(self):
        now = time.time()
        windows, rows, warnings = {}, [], []
        try:
            stamp = SETTINGS.stat().st_mtime
            if stamp != self.settings_stamp:
                saved = json.loads(SETTINGS.read_text())
                if not isinstance(saved, dict): raise ValueError('not a JSON object')
                self.quiet = int(saved.get('quietMinutes', QUIET // 60)) * 60
                self.scheduler = saved.get('scheduler', True) is not False
                self.git_enabled = saved.get('git', True) is not False
                self.messages_enabled = saved.get('messages', True) is not False
                self.claude_reads = saved.get('claudeUsage', False) is True
                self.resume_codex = saved.get('resumeCodex', False) is True
                self.settings_stamp = stamp
        except FileNotFoundError:
            self.quiet, self.settings_stamp = QUIET, None
            self.scheduler = self.git_enabled = self.messages_enabled = True
            self.claude_reads = self.resume_codex = False
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
                for event in self.providers.events(row):
                    kind, at = event[:2]
                    if not at: continue
                    self.ledger.event(row['key'], *event)
                    if kind in TURNS: self.ledger.turn(row['roots'] or [row['project']], at)
            except (OSError, ValueError) as error:
                warnings.append(f'{row["title"]}: event source unavailable ({error})')
                row['source_stale'] = True
        consumed = []
        for path in sorted((self.root / 'events').glob('*.json'), key=lambda p: p.stat().st_mtime):
            try:
                try:
                    event = json.loads(path.read_text())
                    key = f'{event["provider"]}:{event["session"]}'
                    if event['provider'] not in ['claude', 'codex']: raise ValueError('Unknown hook provider')
                    kind, _ = event['kind'], float(event['at'])
                except (ValueError, KeyError, TypeError) as error:
                    # Hooks write each file whole, so a malformed one stays malformed: report it once and drop it.
                    print(f'Discarded hook event {path.name}: {type(error).__name__}: {error}', flush=True)
                    warnings.append(f'Hook event discarded: {error}')
                    consumed.append(path)
                    continue
                background = self.providers.backgrounds.get(event['session']) if event['provider'] == 'claude' else None
                if kind == 'complete' and background:
                    background.read()
                    # A reply to an automatic wake-up while work is still pending is a progress note, unless the
                    # turn read agent messages: then the reply answers them.
                    began = self.ledger.conversation(key).get('began', event['at'])
                    if (not background.human and background.waiting(event['at'])
                            and not messages.read_since(key, began, self.root)): kind = 'hold'
                self.ledger.event(key, kind, event['at'], event.get('turn'), event.get('resets'))
                self.ledger.conversation(key)['hook_seen'] = event['at']
                if event['kind'] in TURNS and event.get('cwd'):
                    self.ledger.turn([event['cwd']], event['at'])
                consumed.append(path)
            except (OSError, ValueError, KeyError, sqlite3.Error) as error:
                warnings.append(f'Hook event error: {error}')
        # The monitor owns collection. We read only its local snapshot, never SMB
        # queue directories or worker logs, and only when it has changed.
        self.scheduler_status = 'off' if not self.scheduler else 'on' if QUEUES.parent.exists() else 'missing'
        try:
            if self.scheduler_status != 'on': raise FileNotFoundError
            stamp = QUEUES.stat().st_mtime
            values = queue_snapshot(QUEUES) if stamp > self.queue_mtime else None
            # An empty snapshot is not evidence that the listed queues ended, but it is a fresh one.
            if values:
                for value in values:
                    if (value['state'] not in ['COMPLETED', 'FAILED', 'KILLED'] or
                            value['started'] > self.ledger.data['since'] - 86400 or
                            value['id'] in self.ledger.data['queues']):
                        self.ledger.queue(value, stamp)
                self.listed = {value['id'] for value in values}
                self.ledger.unlisted(self.listed, stamp)
            if values is not None: self.queue_mtime = stamp
        except FileNotFoundError:
            pass  # Reported below as a stale snapshot.
        except (OSError, ValueError) as error:
            warnings.append(f'Queue snapshot unavailable: {error}')
        if self.scheduler_status == 'on' and now - self.queue_mtime > 120:
            warnings.append('Queue snapshot stale; start the parallel-workers monitor to refresh it')
        self.windows, self.rows, self.warnings = windows, rows, warnings
        if now - self.pruned_at > PRUNE_EVERY: self.prune(now)
        if now - self.checklists_at > CHECKLIST_EVERY: self.read_checklists(now)
        snapshot = self.snapshot()
        content = json.dumps({key: value for key, value in snapshot.items() if key not in ('updated', 'cutoff')}, sort_keys=True)
        if content != self.snapshot_written or now - self.snapshot_at >= HEARTBEAT:
            atomic_json(self.root / 'snapshot.json', snapshot)
            self.snapshot_written, self.snapshot_at = content, now
        self.save_ledger()
        for path in consumed:
            path.unlink(missing_ok=True)

    def save_ledger(self):
        serialized = json.dumps(self.ledger.data, sort_keys=True)
        if serialized != self.last_saved:
            atomic_json(self.state_file, self.ledger.data)
            self.last_saved = serialized

    def read_checklists(self, now):
        """The open projects' task checklists into checklists.json, which the panel reads when it shows them, with the
        chats seen editing each; the snapshot keeps only counts per folder."""
        self.checklists_at = now
        folders = {root for window in self.windows.values() if window.get('kind') != 'app' for root in window.get('roots') or []}
        folders |= {root for row in self.rows for root in row.get('roots') or []}
        try: found = checklists.scan(folders, self.checklist_cache, now)
        except OSError as error:
            self.warnings.append(f'Checklists unreadable: {error}')
            return
        editors = self.providers.checklist_editors()
        for entry in found.values():
            for file in entry['files']:
                file['editors'] = sorted(([key, at] for key, at in editors.get(file['path'], {}).items()), key=lambda pair: -pair[1])
        self.checklist_counts = {folder: {'files': len(entry['files']), 'open': sum(file['open'] for file in entry['files']),
                                          'user': sum(len(file['user']) for file in entry['files']),
                                          'recent': sum(file['recent'] for file in entry['files'])}
                                 for folder, entry in found.items()}
        serialized = json.dumps(found, sort_keys=True)
        if serialized != self.checklists_written:
            atomic_json(self.root / 'checklists.json', {'updated': now, 'folders': found})
            self.checklists_written = serialized
        # Unchanged files and gone ones leave the cache only when their folder is no longer open.
        self.checklist_cache = {path: value for path, value in self.checklist_cache.items()
                                if any(path.startswith(f'{folder}/') for folder in folders)}

    def prune(self, now):
        """Drop what closed chats, gone windows and long-seen queues leave behind, keeping anything still in use."""
        self.pruned_at = now
        self.ledger.prune(now, self.listed, {row['key'] for row in self.rows})
        for path in [*(self.root / 'windows').glob('*.json'), *(self.root / 'windows').glob('*.next')]:
            with contextlib.suppress(OSError):
                if now - path.stat().st_mtime > STALE_WINDOW: path.unlink()
        for key in list(self.providers.views):
            if key not in self.windows and not (self.root / 'windows' / f'{key}.json').exists():
                self.providers.views.pop(key)
                self.providers.logs.pop(key, None)
        # A return record outlives its window only while that window could come back.
        returns = self.ledger.data.get('returns', {})
        for id in list(returns):
            pid = id.split(':', 1)[1] if ':' in id else None
            gone = not Path(f'/proc/{pid}').exists() if pid else not (self.root / 'windows' / f'{id}.json').exists()
            if id not in self.windows and gone: del returns[id]
        for path in (self.root / 'wake').glob('*'):
            with contextlib.suppress(OSError):
                if now - path.stat().st_mtime > messages.KEEP: path.unlink()

    def snapshot(self):
        rows, now = [], time.time()
        continuation_warnings = []
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
            limit = state.get('limited') or {}
            if limit.get('delivery') == 'dispatching' and row['key'] not in self.continuing:
                continuation_warnings.append(f'{row["title"]}: could not confirm Codex continuation. Check the chat before using Continue.')
            elif limit.get('delivery') == 'failed':
                continuation_warnings.append(f'{row["title"]}: {limit.get("delivery_error")}')
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
            pending = self.ledger.pending(row['key'], queues_at.get(row['key']))
            if (row['provider'] == 'codex' and 'Approval needed' in pending
                    and now - pending['Approval needed'] < CODEX_APPROVAL_GRACE):
                del pending['Approval needed']
                if shown == 'approval needed': shown = 'working'
            rows.append({**{k: v for k, v in row.items() if k != 'path'},
                         'state': shown,
                         'state_at': state['state_at'], 'turn': state['turn'],
                         'completed_at': state.get('completed_at',
                                                   state['state_at'] if state['state'] == 'finished' else 0),
                         'unread': list(pending),
                         # When each reason arrived, for the longest-waiting order.
                         'unread_at': pending,
                         'limited': state.get('limited'),
                         'queue_counts': {'done': sum(c['done'] for c in matched),
                                          'total': sum(c['total'] for c in matched)}})
        unique = {r['key']: r for r in rows}
        numbers = self.ledger.active_queue_numbers() if scheduler else {}
        queues = [{**queue, 'number': numbers.get(queue['id']), 'counted': self.ledger.counted(queue)}
                  for queue in self.ledger.data['queues'].values()] if scheduler else []
        return {'schema': 1, 'updated': time.time(), 'cutoff': time.time(),
                'rows': rows, 'windows': list(self.windows.values()),
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
                'usage': self.usage, 'usage_error': self.usage_error,
                'tickets': self.ticket_summary(now),
                'checklists': self.checklist_counts,
                'returns': self.ledger.data.get('returns', {}),
                'warnings': list(dict.fromkeys(self.warnings + continuation_warnings))}

    def ticket_summary(self, now):
        """Tickets for the panel, reread when the database or the queues change, or every TICKET_EVERY."""
        stamps = []
        for name in ['tickets.sqlite', 'tickets.sqlite-wal']:
            try: stamps.append((self.root / name).stat().st_mtime_ns)
            except FileNotFoundError: stamps.append(None)
        read = (*stamps, self.queue_mtime, int(now // TICKET_EVERY))
        if read != self.tickets_read:
            try: self.tickets = tickets.listing(self.root, now, self.ledger.data['queues'])
            except (OSError, ValueError, sqlite3.Error) as error:
                self.warnings.append(f'Tickets unreadable: {error}')
                return None
            self.tickets_read = read
        return self.tickets

    def message_summary(self, rows):
        """Messages for the panel, with the open chats whose unread ones wait for the user to start a turn."""
        human = {key: row.get('human_at', 0) for key, row in self.ledger.data['conversations'].items()}
        try:
            summary = messages.summary(self.root, human)
            return {**summary, 'stranded': messages.stranded(summary['unread'], rows, self.root)}
        except (OSError, ValueError, sqlite3.Error) as error:
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
        if row['target']['kind'] == 'codex-editor' and not (window or {}).get('codexEditor'):
            raise ValueError('To open this Codex conversation by ID, run Developer: Reload Window in its VS Code window')
        result = await self.bridge(window_id, {'type': 'navigate', 'target': row['target'], 'input': input})
        # Recheck the live source before acknowledging a sidebar.
        if row['target']['kind'] == 'codex-sidebar':
            current, _ = self.providers.discover(self.windows[window_id])
            if not any(r['key'] == key and r['target'] == row['target'] for r in current):
                raise ValueError('The sidebar conversation changed during navigation')
        return {'ok': True, 'input': bool(result.get('input'))}

    async def go_on(self, key, automatic=False):
        """Have an open VS Code chat a usage limit stopped go on: a Codex chat gets CONTINUE queued, which its
        VS Code starts as a turn; for a Claude chat, the text comes back for the panel to put in its input box."""
        rows = [row for row in self.rows if row['key'] == key and (row.get('target') or {}).get('kind') in messages.VSCODE]
        if not rows: raise ValueError('This chat is not open in VS Code')
        limit = self.ledger.conversation(key).get('limited')
        if not limit: raise ValueError('No usage limit stopped this chat')
        if rows[0]['provider'] == 'claude': return {'ok': True, 'paste': CONTINUE}
        if rows[0]['provider'] != 'codex': raise ValueError('Only Claude and Codex chats can be continued')
        if key in self.continuing: raise ValueError('A continuation is already being queued')
        if limit.get('delivery') == 'queued': return {'ok': True, 'queued': True}
        # Claim the stop durably before touching Codex. A crash or timeout can leave delivery uncertain;
        # in that case only an explicit Continue can retry it.
        self.continuing.add(key)
        try:
            limit['delivery'] = 'dispatching'
            self.save_ledger()
            await asyncio.to_thread(messages.codex_queue, rows[0]['id'],
                                    'Continue from where you left off.' if automatic else CONTINUE)
            limit['delivery'] = 'queued'
            limit.pop('delivery_error', None)
        except ValueError as error:
            limit['delivery_error'] = str(error)
            if not isinstance(error.__cause__, subprocess.TimeoutExpired):
                limit['attempts'] = limit.get('attempts', 0) + 1
                limit['retry_at'] = time.time() + 60
                limit['delivery'] = 'failed'
            raise
        finally:
            self.continuing.discard(key)
            self.save_ledger()
        return {'ok': True, 'queued': True}

    async def resume_due_codex(self):
        for row in self.rows:
            if not self.resume_codex: return
            if row['provider'] != 'codex' or (row.get('target') or {}).get('kind') not in messages.VSCODE: continue
            state = self.ledger.conversation(row['key'])
            limit = state.get('limited') or {}
            now = time.time()
            if (not limit.get('resets') or limit['resets'] > now or row.get('source_stale')
                    or state['state'] not in ('failed', 'finished') or limit.get('delivery') in ('dispatching', 'queued')
                    or limit.get('attempts', 0) >= 3 or limit.get('retry_at', 0) > now): continue
            try: await self.go_on(row['key'], automatic=True)
            except ValueError as error: print(f'Codex continuation failed for {row["key"]}: {error}', flush=True)

    async def show_scm(self, window_id):
        window = self.windows.get(window_id)
        if not window or window.get('kind'): raise ValueError('Not a VS Code window')
        if not window.get('scm'):
            raise ValueError("This VS Code window's Agent Bar bridge predates Source Control; reload the window")
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

    async def queue_dependencies(self, numbers, project=None, ids=None):
        async with self.workflow_lock:
            if self.scheduler_status != 'on': raise ValueError('Scheduler integration unavailable')
            queues = self.ledger.data['queues']
            active = self.ledger.active_queue_numbers()
            requested = set(numbers)
            tags = set(queues) if ids is None else set(ids).intersection(queues)
            if project is not None: tags = {tag for tag in tags if queues[tag]['project'] == project}
            if requested: tags = {tag for tag in tags if active.get(tag) in requested}
            if self.workflow_result is None or not tags <= self.workflow_tags or time.monotonic() - self.workflow_at >= 30:
                tracked = {tag: q.get('started') for tag, q in queues.items()}
                cached = self.ledger.data.get('queue_workflows', {})
                path = QUEUES.with_name('cluster-status.json')
                declarations, result = await asyncio.to_thread(queue_workflows.read, path, tracked, cached, tags)
                self.ledger.data['queue_workflows'] = declarations
                self.save_ledger()
                self.workflow_result, self.workflow_at, self.workflow_tags = result, time.monotonic(), tags
            # Cache outcomes by identity. Their display numbers belong to the requesting snapshot.
            return {'links': {tag: [{**d, 'number': active.get(d.get('tag'))} for d in deps]
                              for tag, deps in self.workflow_result['links'].items() if tag in tags},
                    'errors': {tag: error for tag, error in self.workflow_result['errors'].items() if tag in tags}}

    async def dispatch(self, command):
        op = command.get('op')
        if op == 'queue-dependencies':
            return await self.queue_dependencies(command.get('numbers', []), command.get('project'), command.get('ids'))
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
        elif op == 'clear-queues':
            # The user marks a project's finished queues seen, as a turn there would.
            if not any(queue['project'] == command['project'] for queue in self.ledger.data['queues'].values()):
                raise ValueError('No queues for that project')
            turns = self.ledger.data['project_turns']
            turns[command['project']] = max(time.time(), turns.get(command['project'], 0))
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
        """Git status of the repositories holding open projects, off the collection loop: every GIT_EVERY while the
        panel's Git tab is open (at once when it opens), every GIT_IDLE otherwise, since nothing else shows it."""
        last, watched_before = 0, False
        while True:
            try: watched = time.time() - (self.root / 'git-watched').stat().st_mtime < GIT_WATCHED
            except FileNotFoundError: watched = False
            due = time.time() - last >= (GIT_EVERY if watched else GIT_IDLE) or (watched and not watched_before)
            watched_before = watched
            if self.git_enabled and due:
                last = time.time()
                folders = {root for window in self.windows.values() for root in window.get('roots', [])}
                folders |= {root for row in self.rows for root in row['roots']}
                try: self.git = {'updated': time.time(), 'repos': await asyncio.to_thread(self.repositories.read, folders)}
                except Exception as error:
                    print(f'Git status failed: {type(error).__name__}: {error}', flush=True)
            await asyncio.sleep(3)

    async def deliver_wakes(self):
        try: await asyncio.to_thread(messages.deliver_deferred, self.root)
        except Exception as error:
            print(f'Wake-up delivery failed: {type(error).__name__}: {error}', flush=True)

    async def deliver_tickets(self):
        try: await asyncio.to_thread(tickets.deliver_due, self.root)
        except Exception as error:
            print(f'Ticket delivery failed: {type(error).__name__}: {error}', flush=True)

    async def read_usage(self):
        """Usage limit readings into their history and the snapshot's summary, off the collection loop; the first read
        of Codex's session logs takes a few seconds, later ones only their new lines."""
        while True:
            try:
                self.usage = await asyncio.to_thread(usage.refresh, Path.home(), self.root, None, self.claude_reads)
                self.usage_error = None
            except Exception as error:
                print(f'Usage limits failed: {type(error).__name__}: {error}', flush=True)
                self.usage_error = f'{type(error).__name__}: {error}'
            await asyncio.sleep(USAGE_EVERY)

    async def run(self):
        lock = (self.root / 'service.lock').open('w')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        socket = self.root / 'service.sock'
        with contextlib.suppress(FileNotFoundError): socket.unlink()
        server = await asyncio.start_unix_server(self.client, path=str(socket))
        os.chmod(socket, 0o600)
        refresh = asyncio.create_task(self.read_git())
        delivery = sending = continuing = None
        limits = asyncio.create_task(self.read_usage())
        async with server:
            while True:
                try:
                    self.collect()
                    if self.resume_codex and (continuing is None or continuing.done()):
                        continuing = asyncio.create_task(self.resume_due_codex())
                except Exception as error:
                    print(f'Collection failed: {type(error).__name__}: {error}', flush=True)
                # Wake-up notes held back while their Codex chats were in a turn go once the turn has ended.
                if (delivery is None or delivery.done()) and messages.deferred(self.root):
                    delivery = asyncio.create_task(self.deliver_wakes())
                # Tickets sent to a chat go once ready; the listing in the snapshot says which are.
                if (sending is None or sending.done()) and any(tickets.due(ticket, time.time()) for ticket in (self.tickets or {}).get('open', [])):
                    sending = asyncio.create_task(self.deliver_tickets())
                await asyncio.sleep(3)

