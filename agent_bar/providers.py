"""Read live window metadata and bounded, incremental provider event sources."""
import contextlib
import datetime
import json
import os
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

from . import checklists, usage
from .hook import automatic

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f-]{27}$', re.I)
CODEX_ROLLOUT = re.compile(r'/rollout-[0-9T-]+-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$', re.I)
CODEX_APP = '/usr/lib/chatgpt/'  # The ChatGPT desktop app's bundled Codex server.
# Terminal and desktop-app sessions change rarely; scanning processes is the costly part.
EXTERNAL_EVERY = 10
PROC_RECHECK = 60  # Seconds before processes found not to be Codex terminal or app clients are looked at again.
NOTIFICATION = re.compile(r'<task-notification>.*?</task-notification>', re.S)
TASK_ENDED = {'completed', 'failed', 'stopped', 'killed'}
# A task whose ending was never reported (e.g. VS Code restarted) stops counting after a day.
TASK_LIMIT = 86400
# Codex calls that only wait; they are not activity.
CODEX_WAITS = {'sleep', 'wait', 'wait_agent'}
# Antigravity's App and IDE share one data folder; its CLI (agy) keeps another, mirrored into the first.
ANTIGRAVITY = ['.gemini/antigravity-cli', '.gemini/antigravity']
ANTIGRAVITY_BUSY = {'CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY', 'CASCADE_RUN_STATUS_CANCELING'}
# How rows and stand-in windows name where a conversation runs; any other is a terminal.
SURFACES = {('codex', 'app'): 'Codex app', ('antigravity', 'app'): 'Antigravity app', ('antigravity', 'ide'): 'Antigravity IDE'}
COPILOT_SESSION = re.compile(rb'(Registering|Unregistering) foreground session: ([0-9a-f-]{36})')


def epoch(value):
    if isinstance(value, (int, float)):
        return value / 1000 if value > 100_000_000_000 else value
    try:
        # Python 3.10 reads at most microseconds; Antigravity writes nanoseconds.
        value = re.sub(r'(\.\d{6})\d+', r'\1', value.replace('Z', '+00:00'))
        return datetime.datetime.fromisoformat(value).timestamp()
    except (ValueError, AttributeError):
        return 0


class Tail:
    """Complete lines only. Cap bootstrap and per-tick IO; never rescan a rollout."""
    def __init__(self, path, initial=2 * 1024 * 1024):
        self.path, self.initial = Path(path), initial
        self.inode, self.offset, self.partial = None, 0, b''
        self.truncated = False

    def read(self, on_reset=None):
        prefix = []
        with self.path.open('rb') as stream:
            stat = os.fstat(stream.fileno())
            reset = self.inode != stat.st_ino or stat.st_size < self.offset
            if reset:
                if on_reset: prefix = on_reset(self.path, self)
                self.inode, self.partial = stat.st_ino, b''
                self.offset = max(0, stat.st_size - self.initial)
                self.truncated = bool(self.offset)
                if self.offset:
                    stream.seek(self.offset)
                    stream.readline()
                    self.offset = stream.tell()
            stream.seek(self.offset)
            chunk = stream.read(self.initial if reset and on_reset else 2 * 1024 * 1024)
            self.offset = stream.tell()
        parts = (self.partial + chunk).split(b'\n')
        self.partial = parts.pop()
        return prefix + [line.decode('utf8', errors='replace') for line in parts]


class Background:
    """What a Claude agent will be woken for, from its transcript: unfinished background
    commands, subagents and monitors, and a scheduled wake-up. Also whether its latest
    prompt came from a person, and when its last turn ended."""
    MARKERS = ('run_in_background', '"Monitor"', 'ScheduleWakeup', 'TaskStop', 'task-notification',
               'promptSource', 'backgroundTaskId', 'agentId', 'taskId', 'scheduledFor', 'stop_hook_summary',
               'tmp/agent/checklists/')

    def __init__(self, path):
        self.tail = Tail(path)
        self.pending, self.wakeups = {}, set()
        self.wake_at, self.human, self.ended_at = 0, True, 0
        self.checklists = {}  # Checklist path -> when this chat last edited it.

    def read(self):
        for line in self.tail.read():
            if not any(marker in line for marker in self.MARKERS): continue
            try: self.feed(json.loads(line))
            except ValueError: continue

    def feed(self, entry):
        at = epoch(entry.get('timestamp'))
        content = (entry.get('message') or {}).get('content')
        if entry.get('type') == 'user' and entry.get('promptSource'):
            self.human, self.ended_at = (entry.get('origin') or {}).get('kind') == 'human', 0
        if entry.get('type') == 'system' and entry.get('subtype') == 'stop_hook_summary':
            self.ended_at = at
        text = content if isinstance(content, str) else ''
        result = entry.get('toolUseResult') if isinstance(entry.get('toolUseResult'), dict) else {}
        for item in content if isinstance(content, list) else []:
            if not isinstance(item, dict): continue
            kind = item.get('type')
            if kind == 'text':
                text += item.get('text', '')
            elif kind == 'tool_use':
                name, args = item.get('name'), item.get('input') or {}
                if name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
                    touched = checklists.edited(args.get('file_path') or args.get('notebook_path') or '')
                else: touched = checklists.edited(args.get('command') or '', shell=True, cwd=entry.get('cwd')) if name == 'Bash' else []
                for path in touched: self.checklists[path] = max(at, self.checklists.get(path, 0))
                if name == 'Monitor' or (name in ('Bash', 'Agent') and args.get('run_in_background')):
                    limit = args['timeout_ms'] / 1000 if name == 'Monitor' and args.get('timeout_ms') else TASK_LIMIT
                    self.pending[item['id']] = {'task': None, 'expires': at + limit}
                elif name == 'ScheduleWakeup':
                    if args.get('stop'): self.wake_at = 0
                    else: self.wakeups.add(item['id'])
                elif name == 'TaskStop':
                    self.finish(task=args.get('task_id'))
            elif kind == 'tool_result':
                use = item.get('tool_use_id')
                if use in self.pending:
                    if item.get('is_error'): self.pending.pop(use)
                    else: self.pending[use]['task'] = (result.get('backgroundTaskId') or result.get('agentId')
                                                       or result.get('taskId'))
                if use in self.wakeups:
                    self.wakeups.discard(use)
                    if result.get('scheduledFor'): self.wake_at = epoch(result['scheduledFor'])
        for note in NOTIFICATION.findall(text):
            status = re.search(r'<status>(\w+)</status>', note)
            if status and status.group(1) in TASK_ENDED:
                use = re.search(r'<tool-use-id>(\S+?)</tool-use-id>', note)
                task = re.search(r'<task-id>(\S+?)</task-id>', note)
                self.finish(use and use.group(1), task and task.group(1))

    def finish(self, use=None, task=None):
        self.pending.pop(use, None)
        for key in [k for k, v in self.pending.items() if task and v['task'] == task]:
            self.pending.pop(key)

    def waiting(self, now):
        return self.wake_at > now - 60 or any(v['expires'] > now for v in self.pending.values())


def process(pid, proc='/proc'):
    """A live process's parent, start time (clock ticks after boot) and executable, or None."""
    try:
        stat = Path(f'{proc}/{pid}/stat').read_text()
        exe = os.readlink(f'{proc}/{pid}/exe')
    except OSError:
        return None
    fields = stat[stat.rindex(')') + 2:].split()
    return {'ppid': int(fields[1]), 'start': fields[19], 'exe': exe}


def lineage(pid, proc='/proc'):
    """A process and its ancestors, nearest first, as (pid, executable) pairs."""
    chain = []
    while pid > 1 and len(chain) < 32:
        info = process(pid, proc)
        if not info: break
        chain.append((pid, info['exe']))
        pid = info['ppid']
    return chain


def held_locks(proc='/proc'):
    """Inode -> pid of each process holding a file lock, from /proc/locks (blocked waiters skipped)."""
    held = {}
    with contextlib.suppress(OSError):
        for line in Path(f'{proc}/locks').read_text().splitlines():
            fields = line.split()
            if len(fields) >= 6 and fields[1] != '->':
                with contextlib.suppress(ValueError): held[int(fields[5].rsplit(':', 1)[1])] = int(fields[4])
    return held


def folder_window(windows, path):
    """The VS Code window with the deepest folder holding `path`, or None when none or two tie."""
    def depth(window):
        return max((len(root) for root in window.get('roots') or []
                    if path == root or path.startswith(root.rstrip('/') + '/')), default=0)
    ranked = sorted(windows, key=depth, reverse=True)
    if not ranked or not depth(ranked[0]) or (len(ranked) > 1 and depth(ranked[1]) == depth(ranked[0])):
        return None
    return ranked[0]


def workspace_panels(storage):
    if not storage:
        return []
    database = Path(storage).parent / 'state.vscdb'
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=0.2) as connection:
        result = connection.execute("SELECT json_extract(value, '$.panelTabSessions') FROM ItemTable WHERE key=?",
                                    ('Anthropic.claude-code',)).fetchone()
        data = json.loads(result[0]) if result and result[0] else []
    return data


CODEX_SUBMIT = '[info] Reasoning summary turn-start config resolved conversationId='
CODEX_VIEW = ('thread_stream_view_activity_changed', 'Activating Codex extension', CODEX_SUBMIT)


def codex_view_history(path, previous=None, limit=32 * 1024 * 1024):
    """The view-activity and activation lines of a window's rotated Codex logs (Codex.1.log newest), oldest first, back
    to the last activation: the views open now are the ones these lines leave active. Found by byte search, since a
    window can keep several 5 MB rotations."""
    markers = [marker.encode() for marker in CODEX_VIEW]
    found = []
    for number in range(1, 100):
        rotated = path.with_name(f'Codex.{number}.log')
        try:
            with rotated.open('rb') as stream:
                stat = os.fstat(stream.fileno())
                if stat.st_size > limit: break
                last = previous is not None and previous.inode == stat.st_ino
                if previous is not None and last: stream.seek(previous.offset - len(previous.partial))
                data = stream.read()
        except FileNotFoundError: break
        starts = set()
        for marker in markers:
            index = data.find(marker)
            while index >= 0:
                starts.add(data.rfind(b'\n', 0, index) + 1)
                index = data.find(marker, index + len(marker))
        picked = []
        for begin in sorted(starts):
            end = data.find(b'\n', begin)
            if end >= 0: picked.append(data[begin:end].decode(errors='replace'))
        found = picked + found
        if last or any(CODEX_VIEW[1] in line for line in picked): break
    return found


class Providers:
    def __init__(self, home=None, proc='/proc'):
        self.home, self.proc = Path(home or Path.home()), proc
        self.logs, self.views, self.tails = {}, {}, {}
        self.metadata, self.backgrounds, self.titles = {}, {}, {}
        self.names, self.names_stamp = {}, None
        self.copilot_logs, self.copilot_final = {}, {}
        self.antigravity = {}  # Conversation id -> its summary database, for events.
        # Codex chat key -> checklist path -> when it last edited it, and the folder its turns run in.
        self.codex_checklists, self.codex_cwd = {}, {}
        self.codex_session_reset = {}  # Latest exhausted five-hour window reported in each thread's current turn.
        self.external_at, self.external_found = 0, ([], [], [])
        # Process ids found not to be Codex CLI or app clients, skipped until PROC_RECHECK passes, which covers a
        # process that starts Codex after it was looked at.
        self.not_codex, self.not_codex_at = set(), 0.0

    def checklist_editors(self):
        """Checklist path -> {chat key: when it last edited it}, from the open chats' transcripts read so far."""
        result = {}
        for key, edits in [*((f'claude:{sid}', background.checklists) for sid, background in self.backgrounds.items()),
                           *self.codex_checklists.items()]:
            for path, at in edits.items(): result.setdefault(path, {})[key] = at
        return result

    def claude_background(self, sid):
        if sid not in self.backgrounds:
            found = list((self.home / '.claude/projects').glob(f'*/{sid}.jsonl'))
            if len(found) != 1: return None
            self.backgrounds[sid] = Background(found[0])
        return self.backgrounds[sid]

    def codex_open(self, window, editors=()):
        path = Path(window['log']).parent / 'openai.chatgpt/Codex.log'
        key = window['id']
        # Codex rotates its log at 5 MB, and a view opened days ago may be logged several rotations back.
        tail = self.logs.setdefault(key, Tail(path, initial=32 * 1024 * 1024))
        saved = self.views.get(key, {})
        active = set(saved.get('active', []))
        submitted = saved.get('submitted')
        try:
            lines = tail.read(on_reset=codex_view_history)
        except FileNotFoundError:
            # The current name can be absent between rotating the log and opening its replacement.
            if key not in self.views: raise
            lines = []
        for line in lines:
            if 'Activating Codex extension' in line:
                active.clear()
                submitted = None
            if CODEX_SUBMIT in line:
                sid = line.partition(CODEX_SUBMIT)[2].partition(' ')[0]
                if UUID.fullmatch(sid) and sid not in active and sid not in editors:
                    submitted = sid
            if 'thread_stream_view_activity_changed' not in line:
                continue
            match = re.search(r'active=(true|false) conversationId=([0-9a-f-]+)', line)
            if match:
                if match[2] == submitted: submitted = None
                if match[1] == 'true': active.add(match[2])
                else: active.discard(match[2])
        if tail.truncated:
            raise ValueError('Codex view log exceeds bootstrap limit; reopen its views to establish a baseline')
        if submitted in editors: submitted = None
        self.views[key] = {'active': sorted(active), 'submitted': submitted}
        return active | ({submitted} if submitted else set())

    def codex_metadata(self, ids):
        if not ids: return {}
        path = self.home / '.codex/state_5.sqlite'
        names = self.codex_names()
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=0.2) as connection:
            rows = connection.execute(
                'SELECT id,title,cwd,rollout_path,source FROM threads WHERE id IN (' +
                ','.join('?' for _ in ids) + ')', list(ids))
            return {r[0]: {'title': names.get(r[0]) or r[1], 'cwd': r[2], 'path': r[3], 'source': r[4]} for r in rows}

    def codex_names(self):
        """Thread names as Codex lists them. Its thread table can keep the first prompt as the title
        (the desktop app's threads), while this index gets the generated or renamed one, latest last."""
        path = self.home / '.codex/session_index.jsonl'
        try:
            stamp = path.stat().st_mtime
            if stamp != self.names_stamp:
                names = {}
                for line in path.read_text().splitlines():
                    with contextlib.suppress(ValueError, KeyError, TypeError):
                        entry = json.loads(line)
                        if entry.get('thread_name'): names[entry['id']] = entry['thread_name']
                self.names, self.names_stamp = names, stamp
        except OSError:
            self.names, self.names_stamp = {}, None
        return self.names

    def claude_terminals(self):
        """Interactive Claude Code CLI sessions whose process is still the one that wrote its record."""
        found = []
        for path in (self.home / '.claude/sessions').glob('*.json'):
            try: data = json.loads(path.read_text())
            except (OSError, ValueError): continue
            if data.get('entrypoint') != 'cli' or data.get('kind') != 'interactive': continue
            info = process(data.get('pid'), self.proc)
            # A recycled PID belongs to another process.
            if not info or info['start'] != str(data.get('procStart')) or not UUID.fullmatch(data.get('sessionId', '')):
                continue
            sid = data['sessionId']
            found.append({'provider': 'claude', 'id': sid, 'title': self.claude_title(sid) or data.get('name') or sid[:8],
                          'cwd': data.get('cwd'), 'pid': data['pid'], 'surface': 'terminal'})
        return found

    def copilot_terminals(self):
        """Copilot CLI sessions. Each `copilot` process logs to process-<ms>-<pid>.log which session it has in
        the foreground; that session's workspace.yaml names its folder and its generated or chosen title."""
        newest = {}
        for log in (self.home / '.copilot/logs').glob('process-*-*.log'):
            try: started, pid = (int(value) for value in log.stem.split('-')[1:3])
            except ValueError: continue
            # A recycled PID writes a newer log of its own.
            if started > newest.get(pid, (0, None))[0]: newest[pid] = started, log
        found = []
        for pid, (_, log) in newest.items():
            info = process(pid, self.proc)
            if not info or Path(info['exe']).name != 'copilot': continue  # VS Code's copilot-runtime logs here too.
            sid = self.copilot_session(log)
            folder = self.home / '.copilot/session-state' / str(sid)
            if not sid or not folder.is_dir(): continue
            workspace = {}
            with contextlib.suppress(OSError):
                for line in (folder / 'workspace.yaml').read_text().splitlines():
                    key, _, value = line.partition(': ')
                    workspace[key.strip()] = value.strip().strip('"\'')
            found.append({'provider': 'copilot', 'id': sid, 'title': workspace.get('name') or sid[:8],
                          'cwd': workspace.get('cwd'), 'pid': pid, 'surface': 'terminal', 'path': str(folder / 'events.jsonl')})
        return found

    def copilot_session(self, log):
        """The session a Copilot log last registered and has not unregistered, reading only appended bytes."""
        state = self.copilot_logs.setdefault(log, {'offset': 0, 'session': None})
        try:
            with log.open('rb') as stream:
                stream.seek(state['offset'])
                chunk = stream.read()
        except OSError:
            return None
        # A partial last line waits for the next read.
        end = chunk.rfind(b'\n') + 1
        state['offset'] += end
        for action, sid in COPILOT_SESSION.findall(chunk[:end]):
            if action == b'Registering': state['session'] = sid.decode()
            elif state['session'] == sid.decode(): state['session'] = None
        return state['session']

    def antigravity_sessions(self):
        """Antigravity conversations open in its IDE, App or CLI: each holds presence/<id>.lock while it shows one."""
        held, found, seen = held_locks(self.proc), [], set()
        for folder in ANTIGRAVITY:
            root = self.home / folder
            opened = {}
            for lock in (root / 'presence').glob('*.lock'):
                with contextlib.suppress(OSError):
                    if lock.stat().st_ino in held and lock.stem not in seen: opened[lock.stem] = held[lock.stat().st_ino]
            if not opened: continue
            summaries = self.antigravity_summaries(root / 'conversation_summaries.db', opened.keys())
            for cid, pid in opened.items():
                summary = summaries.get(cid)
                if not summary or summary['parent_conversation_id'] or summary['nesting_depth']: continue
                seen.add(cid)
                self.antigravity[cid] = root / 'conversation_summaries.db'
                uris = json.loads(summary['workspace_uris'] or '[]')
                cwd = unquote(urlparse(uris[0]).path) if uris else None
                exes = [Path(exe).name for _, exe in lineage(pid, self.proc)]
                surface = 'ide' if 'antigravity-ide' in exes else 'app' if 'antigravity' in exes else 'terminal'
                found.append({'provider': 'antigravity', 'id': cid, 'title': summary['title'] or cid[:8], 'cwd': cwd,
                              'pid': pid, 'surface': surface,
                              # IDE windows are titled after their folder, not the conversation.
                              'hint': f'{Path(cwd).name} - Antigravity IDE' if surface == 'ide' and cwd else None})
        return found

    def antigravity_summaries(self, path, ids):
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=0.2) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                'SELECT conversation_id, title, workspace_uris, status, killed, last_user_input_time, last_modified_time,'
                ' parent_conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id IN (%s)'
                % ','.join('?' * len(ids)), list(ids))
            return {row['conversation_id']: dict(row) for row in rows}

    def antigravity_events(self, cid):
        """Turns from the conversation's summary: its last prompt, then a finish once it is idle again."""
        summary = self.antigravity_summaries(self.antigravity[cid], [cid]).get(cid)
        if not summary: return []
        prompt, changed = epoch(summary['last_user_input_time']), epoch(summary['last_modified_time'])
        turn = f'input:{prompt}'
        if summary['killed']: return [('message', prompt, turn), ('interrupted', changed, None)]
        if summary['status'] in ANTIGRAVITY_BUSY: return [('message', prompt, turn), ('resume', changed, None)]
        return [('message', prompt, turn), ('complete', changed, turn)] if changed >= prompt else [('message', prompt, turn)]

    def claude_title(self, sid):
        """The title the CLI puts on its terminal: the conversation's /rename, else its generated one.
        Its session record keeps only a name derived from the folder."""
        from .inventory import claude_line, scan  # inventory imports this module.
        if sid not in self.titles:
            found = list((self.home / '.claude/projects').glob(f'*/{sid}.jsonl'))
            if len(found) != 1: return None
            self.titles[sid] = found[0], {}
        path, state = self.titles[sid]
        try: scan(path, state, claude_line)
        except OSError: return None
        return state.get('custom') or state.get('ai')

    def codex_clients(self):
        """Conversations a Codex CLI or desktop-app process has loaded, from the rollouts it holds
        open, as {id: (pid, surface)}. The VS Code extension's servers are left to the bridge."""
        found, sessions = {}, f'{self.home}/.codex/sessions/'
        if time.time() - self.not_codex_at > PROC_RECHECK: self.not_codex, self.not_codex_at = set(), time.time()
        alive = set()
        for name in os.listdir(self.proc):
            if not name.isdigit(): continue
            alive.add(name)
            if name in self.not_codex: continue
            try:
                with open(f'{self.proc}/{name}/comm', 'rb') as stream: comm = stream.read().strip()
                exe = os.readlink(f'{self.proc}/{name}/exe') if comm == b'codex' else ''
            except OSError:
                continue
            # VS Code's own Codex servers are left to the bridge; only then are a process's open files listed.
            if comm != b'codex' or '/.vscode/extensions/' in exe:
                self.not_codex.add(name)
                continue
            try: fds = os.listdir(f'{self.proc}/{name}/fd')
            except OSError: continue
            for fd in fds:
                with contextlib.suppress(OSError):
                    link = os.readlink(f'{self.proc}/{name}/fd/{fd}')
                    match = CODEX_ROLLOUT.search(link)
                    if match and link.startswith(sessions):
                        found.setdefault(match[1], (int(name), 'app' if exe.startswith(CODEX_APP) else 'terminal'))
        self.not_codex &= alive
        return found

    def external(self, windows, now):
        """Terminal and desktop-app conversations, and the stand-in windows that show them. A session
        in VS Code's own terminal belongs to the VS Code window whose folder holds it; any other gets
        a window naming the processes that may own its native window."""
        if now - self.external_at < EXTERNAL_EVERY: return self.external_found
        self.external_at = now
        sessions, warnings = self.claude_terminals() + self.copilot_terminals(), []
        try: sessions += self.antigravity_sessions()
        except (OSError, ValueError, sqlite3.Error) as error:
            warnings.append(f'Antigravity sessions unavailable: {error}')
        try:
            loaded = self.codex_clients()
            metadata = self.codex_metadata(loaded.keys())
        except (OSError, sqlite3.Error) as error:
            loaded, metadata = {}, {}
            warnings.append(f'Codex terminal and app sessions unavailable: {error}')
        for sid, (pid, surface) in sorted(loaded.items()):
            meta = metadata.get(sid)
            # Subagent threads record their spawn as a JSON source.
            if not meta or (meta['source'] or '').startswith('{'): continue
            sessions.append({'provider': 'codex', 'id': sid, 'title': meta['title'] or sid[:8], 'cwd': meta['cwd'],
                             'pid': pid, 'surface': surface, 'path': meta['path']})
        rows, made = [], {}
        for session in sessions:
            cwd, pid, surface = session.pop('cwd') or str(self.home), session.pop('pid'), session.pop('surface')
            chain = lineage(pid, self.proc)
            holder = folder_window(windows, cwd)
            project = holder['workspace'] if holder else Path(cwd).name
            label, hint = SURFACES.get((session['provider'], surface), 'Terminal'), session.pop('hint', None)
            if holder and any(Path(exe).name == 'code' for _, exe in chain):
                window = holder
            else:
                wid = f'{surface}:{pid}'
                window = made.setdefault(wid, {'id': wid, 'kind': surface, 'label': label, 'updated': now, 'titles': [],
                                               'workspace': label if surface == 'app' else project,
                                               'roots': [] if surface == 'app' else [cwd], 'pids': [p for p, _ in chain]})
                window['titles'].append(hint or session['title'])
            rows.append({**session, 'target': {'kind': 'window'}, 'key': f'{session["provider"]}:{session["id"]}',
                         'window': window['id'], 'project': project, 'roots': [cwd], 'surface': surface,
                         'surface_label': label})
        self.external_found = rows, list(made.values()), warnings
        return self.external_found

    def discover(self, window):
        rows, warnings = [], []
        claude_tabs = [t for t in window['tabs'] if 'claudeVSCodePanel' in (t['viewType'] or '')]
        try:
            panels = workspace_panels(window['storage'])
        except (OSError, ValueError, sqlite3.Error) as error:
            panels = []
            warnings.append(f'Claude tab metadata unavailable: {error}')
        for tab in claude_tabs:
            matches = [p for p in panels if p.get('title') == tab['label']]
            # A duplicate title cannot establish which live tab owns which ID.
            unique_tab = sum(t['label'] == tab['label'] for t in claude_tabs) == 1
            if len(matches) != 1 or not unique_tab or not UUID.fullmatch(matches[0].get('sessionId', '')):
                warnings.append(f'Claude tab needs identity refresh: {tab["label"]}')
                continue
            sid = matches[0]['sessionId']
            # The tab's label is the title shortened; the transcript has it whole.
            rows.append({'provider': 'claude', 'id': sid, 'title': self.claude_title(sid) or tab['label'],
                         'target': {'kind': 'tab', **tab}})
        custom = {}
        for tab in window['tabs']:
            if tab['viewType'] != 'chatgpt.conversationEditor' or not tab['uri']:
                continue
            uri = urlparse(tab['uri'])
            parts = uri.path.split('/')
            if uri.scheme == 'openai-codex' and len(parts) >= 3 and parts[1] == 'local' and UUID.fullmatch(parts[2]):
                custom[parts[2]] = tab
            else:
                warnings.append('Codex panel has no local conversation ID yet')
        active = set(custom)
        try:
            active.update(self.codex_open(window, custom))
        except (OSError, ValueError) as error:
            warnings.append(f'Codex view source unavailable: {error}')
        try:
            metadata = self.codex_metadata(active)
        except (OSError, sqlite3.Error) as error:
            metadata = {}
            warnings.append(f'Codex metadata unavailable: {error}')
        sidebars = active - custom.keys()
        for sid in sorted(active):
            meta = metadata.get(sid, {})
            if sid in custom:
                target = {'kind': 'tab', **custom[sid]}
            elif len(sidebars) == 1 and sid != self.views.get(window['id'], {}).get('submitted'):
                target = {'kind': 'codex-sidebar'}
            else:
                # The log identifies the thread, but focusing the sidebar could show another one.
                target = {'kind': 'codex-editor', 'conversation': sid}
            rows.append({'provider': 'codex', 'id': sid, 'title': meta.get('title') or sid[:8],
                         'target': target, 'path': meta.get('path')})
        for row in rows:
            row.update(key=f'{row["provider"]}:{row["id"]}', window=window['id'],
                       project=window['workspace'], roots=window['roots'])
        return rows, warnings

    def events(self, row):
        if row['provider'] == 'claude':
            # Live status comes from the lifecycle hook; the transcript only tells
            # what the agent will be woken for.
            background = self.claude_background(row['id'])
            if background: background.read()
            return []
        if row['provider'] == 'antigravity':
            return self.antigravity_events(row['id']) if row['id'] in self.antigravity else []
        path = row.get('path')
        if not path: return []
        if row['provider'] == 'copilot':
            # Written only once the session has its first event.
            if not Path(path).exists(): return []
            return self.copilot_events(row['key'], self.tails.setdefault(row['key'], Tail(path)).read())
        tail = self.tails.setdefault(row['key'], Tail(path))
        result = []
        for line in tail.read():
            try: data = json.loads(line)
            except ValueError: continue
            payload = data.get('payload', {})
            if data.get('type') == 'turn_context' and payload.get('cwd'): self.codex_cwd[row['key']] = payload['cwd']
            if data.get('type') == 'response_item' and payload.get('type') in ['function_call', 'custom_tool_call']:
                call = payload.get('input') or payload.get('arguments') or ''
                if 'tmp/agent/checklists/' in call:
                    cwd = self.codex_cwd.get(row['key']) or (row.get('roots') or [None])[0]
                    edits = self.codex_checklists.setdefault(row['key'], {})
                    for touched in checklists.edited(call, shell=payload.get('name') != 'apply_patch', cwd=cwd):
                        edits[touched] = max(epoch(data.get('timestamp')), edits.get(touched, 0))
                if payload.get('name') in CODEX_WAITS: continue
                kind = 'question' if 'request_user_input' in payload.get('name', '') else 'resume'
                result.append((kind, epoch(data.get('timestamp')), None))
                continue
            if data.get('type') != 'event_msg': continue
            key = row['key']
            if payload.get('type') == 'task_started':
                self.codex_session_reset.pop(key, None)
            rates = payload.get('rate_limits')
            if isinstance(rates, dict):
                windows = usage.codex_windows(rates)
                if (rates.get('rate_limit_reached_type') not in (None, 'rate_limit_reached')
                        or rates.get('spend_control_reached')):
                    self.codex_session_reset.pop(key, None)
                elif windows:
                    exhausted = [w for w in windows if w['percent'] >= 100]
                    self.codex_session_reset[key] = (exhausted[0]['resets_at'] if len(exhausted) == 1
                                                     and exhausted[0]['key'] == 'session' else None)
            kind = {'task_started': 'start', 'task_complete': 'complete',
                    'turn_aborted': 'interrupted', 'task_failed': 'failure',
                    'user_message': 'message', 'patch_apply_end': 'resume',
                    'exec_command_begin': 'resume'}.get(payload.get('type'))
            if payload.get('type') == 'agent_message' and payload.get('phase') == 'commentary':
                kind = 'resume'
            # A queued Agent Bar note starts a turn, but no person wrote it.
            if kind == 'message' and automatic(payload.get('message')): kind = 'start'
            error = payload.get('error')
            if kind in ('complete', 'failure') and isinstance(error, dict) and error.get('codex_error_info') == 'usage_limit_exceeded':
                at = epoch(data.get('timestamp'))
                reset = self.codex_session_reset.get(key)
                if reset and at < reset <= at + usage.FIVE_HOURS and 'out of credits' not in (error.get('message') or '').lower():
                    result.append(('limit', at, payload.get('turn_id'), reset))
                    continue
                kind = 'limit'
            if kind:
                result.append((kind, epoch(data.get('timestamp')), payload.get('turn_id')))
        return result


    def copilot_events(self, key, lines):
        """Copilot's events.jsonl as tracker events. A prompt runs several assistant turns, one per round of
        tool calls; the turn ending on a reply without tool requests is the one that finishes it."""
        result = []
        turn = self.copilot_final.setdefault(key, {'interaction': None, 'final': False})
        for line in lines:
            try: data = json.loads(line)
            except ValueError: continue
            if data.get('agentId'): continue  # A subagent's events.
            kind, value, at = data.get('type'), data.get('data') or {}, epoch(data.get('timestamp'))
            if kind == 'user.message':
                turn.update(interaction=value.get('interactionId'), final=False)
                automatic = value.get('isAutopilotContinuation') or value.get('source') not in [None, '', 'user']
                result.append(('start' if automatic else 'message', at, turn['interaction']))
            elif kind == 'assistant.message':
                turn['final'] = not value.get('toolRequests')
                result.append(('resume', at, None))
            elif kind == 'assistant.turn_end' and turn['final']:
                result.append(('complete', at, turn['interaction']))
                turn['final'] = False
            elif kind in ['assistant.turn_start', 'permission.completed', 'tool.execution_complete']:
                result.append(('resume', at, None))
            elif kind == 'tool.execution_start':
                result.append(('question' if value.get('toolName') == 'ask_user' else 'resume', at, None))
            elif kind == 'permission.requested': result.append(('approval', at, None))
            elif kind == 'session.error': result.append(('failure', at, None))
            elif kind == 'abort': result.append(('interrupted', at, None))
        return result


def queue_snapshot(path):
    """Read the ROTA monitor's queue TSV (21 columns plus an optional ETA warning). No cluster queries."""
    lines = Path(path).read_text().splitlines()
    try:
        details = Path(str(path) + '.details').read_text().splitlines()
    except FileNotFoundError:
        details = []
    # A crashed or older producer may leave a stale companion. Only attach
    # warnings from the exact rows the caller is reading.
    if details and ['\t'.join(line.split('\t')[:21]) for line in details] == lines:
        lines = details
    result = []
    for line in lines:
        cells = line.split('\t')
        if len(cells) not in (21, 22):
            raise ValueError(f'Unexpected queue snapshot schema ({len(cells)} columns)')
        result.append({'id': cells[16], 'project': cells[17], 'label': cells[5],
                       'state': cells[4], 'done': int(cells[7]), 'total': int(cells[8]),
                       'pct': float(cells[11]), 'eta': int(cells[10]), 'workers': cells[6],
                       'eta_warning': cells[21] if len(cells) == 22 and cells[21] != '-' else None,
                       'queue_file': cells[15], 'started': int(cells[3]), 'elapsed': int(cells[9]),
                       # The monitor reuses the end column as the start time while a queue is active.
                       'ended': int(cells[13]) if cells[14] else None,
                       # Jobs that ended without a done marker and were not yet rerun, and
                       # the monitor's display time of the newest one.
                       'failed': int(cells[18]), 'failed_at': cells[19] or None, 'rerun': int(cells[20])})
    return result
