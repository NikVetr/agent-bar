"""Attention bookkeeping, independent of providers and the desktop."""
import json
import os
import time
from pathlib import Path

ROOT = Path.home() / '.local/state/agent-bar'
# UNLISTED: the queue monitor stopped listing an active queue, so its outcome is unknown but it is no longer running.
TERMINAL = {'COMPLETED', 'FINISHED_INCOMPLETE', 'FAILED', 'KILLED', 'UNLISTED'}
KEEP_QUEUES = 7 * 86400  # A finished queue no count includes, and the monitor no longer lists, is kept this long.
KEEP_CHATS = 30 * 86400  # A closed chat with no activity this long is forgotten.


def project_names(paths, home=None):
    """Folder names a queue's project may use: each root and its ancestors under home."""
    home = Path(home or Path.home())
    names = set()
    for value in paths:
        path = Path(value)
        if home not in path.parents:
            names.add(path.name)
            continue
        for part in [path, *path.parents]:
            if part == home: break
            names.add(part.name)
    return names


def agent_ancestor():
    """Whether a Claude Code or Codex process started this one. An agent can unset the session variables its tools get,
    but not its process ancestry, so commands reserved for the user check both. Linux only (/proc); elsewhere False."""
    pid = os.getpid()
    for _ in range(64):
        try:
            parent = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
            if parent <= 1: return False
            name = Path(f'/proc/{parent}/comm').read_text().strip()
        except (OSError, ValueError, IndexError): return False
        if name == 'claude' or name.startswith('codex'): return True
        pid = parent
    return False


def atomic_json(path, value, indent=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.next')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=indent, separators=None if indent else (',', ':'))
        if indent: stream.write('\n')
    temporary.replace(path)


def ended(queue):
    """When a finished queue ended: the monitor's end time, or when the tracker saw it end if that was sooner. The
    tracker sees an end only at the monitor's next refresh, so a turn after the monitor's own end time, such as an
    agent woken by that end, has already answered it."""
    finished = queue['finished_at']
    return min(queue.get('ended') or finished, finished)


class Ledger:
    def __init__(self, data=None):
        self.data = data or {'since': time.time(), 'conversations': {}, 'queues': {}, 'project_turns': {}}
        for retired in ['links', 'receipts']:
            self.data.pop(retired, None)
        if 'project_turns' not in self.data:
            # Queues that finished before per-turn counting began are already seen.
            self.data['project_turns'] = {}
            for queue in self.data['queues'].values():
                queue['finished_at'] = 0 if queue['state'] in TERMINAL else None

    def conversation(self, key):
        return self.data['conversations'].setdefault(key, {
            'state': 'unknown', 'state_at': 0, 'ack': 0, 'reasons': {}, 'turn': None,
        })

    def event(self, key, kind, at, turn=None, resets=None):
        """kind 'limit': a turn a usage limit stopped, which resets at `resets` (epoch seconds) if known."""
        row = self.conversation(key)
        # The chat stays stopped by the limit until its next turn starts.
        if kind in ['message', 'start']:
            row['began'] = max(at, row.get('began', 0))
            if row.get('limited', {}).get('at', at) < at: del row['limited']
        if kind == 'limit':
            if at >= row.get('began', 0): row['limited'] = {'at': at, 'resets': resets}
            kind = 'failure'
        # A provider hook and its transcript can report the same completion.
        # Preserve the original notification timestamp after it was reviewed.
        seen = row.setdefault('seen', {})
        identity = turn or (row.get('turn') if kind != 'message' else None)
        # 'hold': the turn ended, but the agent will be woken for pending work, so it is no reply to review.
        # A completion is a duplicate only if the chat did nothing since the last one; otherwise its turn's start
        # was missed and it carries the previous turn's identity.
        if (kind in ['complete', 'failure', 'hold'] and identity and seen.get(kind) == identity
                and (kind == 'failure' or row.get('completed_at', 0) >= row['state_at'])):
            return
        if kind in ['complete', 'failure', 'hold'] and identity:
            seen[kind] = identity
        if kind in ['complete', 'hold']:
            row['completed_at'] = max(at, row.get('completed_at', 0))
        if kind == 'message':
            row['ack'] = max(row['ack'], at)
            # A human prompt: resets the message loop guard for this conversation.
            row['human_at'] = max(at, row.get('human_at', 0))
        states = {'message': 'working', 'start': 'working', 'complete': 'finished',
                  'failure': 'failed', 'question': 'input needed', 'approval': 'approval needed',
                  'resume': 'working', 'interrupted': 'interrupted', 'hold': 'waiting'}
        if kind in states and at >= row['state_at']:
            row.update(state=states[kind], state_at=at,
                       # An automatic continuation is a new turn too; otherwise its completion
                       # looks like a duplicate of the previous turn's and is dropped.
                       turn=turn or ({'message': f'input:{at}', 'start': f'start:{at}'}.get(kind) or row['turn']))
        # A question or approval needs the user only until the turn moves on: any later event of the turn means it
        # was answered, or, like approvals Codex reports and grants at once, never waited for them.
        if kind not in ['question', 'approval']:
            for name in ['Input needed', 'Approval needed']:
                if row['reasons'].get(name, at) < at: del row['reasons'][name]
        reasons = {'complete': 'Reply finished', 'failure': 'Turn failed',
                   'question': 'Input needed', 'approval': 'Approval needed'}
        if kind in reasons and at >= self.data['since']:
            row['reasons'][reasons[kind]] = max(at, row['reasons'].get(reasons[kind], 0))

    def acknowledge(self, key, cutoff):
        row = self.conversation(key)
        row['ack'] = max(row['ack'], cutoff)

    def pending(self, key, queues_at=None):
        """Unread reasons and when each arrived; queues_at: when this conversation's project last had all its
        queues finish."""
        row = self.conversation(key)
        reasons = {name: at for name, at in row['reasons'].items() if at > row['ack']}
        if queues_at and queues_at > row['ack']: reasons['Queues finished'] = queues_at
        return reasons

    def unread(self, key, queues_at=None):
        return list(self.pending(key, queues_at))

    def queue(self, value, observed):
        previous = self.data['queues'].get(value['id'], {})
        finished = previous.get('finished_at')
        counts = lambda queue: [queue.get(name) for name in ['done', 'total', 'failed', 'rerun']]
        changed = 'done' in previous and counts(value) != counts(previous)
        if value['state'] not in TERMINAL:
            # parallel-workers flips some finished batches to DRAINING and back with no worker running and nothing
            # done, so such a report keeps the finish; running workers or new counts reopen the queue.
            idle = not sum(int(n) for n in (value.get('workers') or '').split(' ')[0].split('-') if n.isdigit())
            if finished is not None and previous['state'] != 'UNLISTED' and idle and not changed:
                value = {**value, 'state': previous['state'], 'ended': previous.get('ended')}
            else: finished = None
        # A finished queue with new counts (a rerun inside one monitor refresh, or jobs added) has finished again.
        elif finished is None or changed: finished = observed
        self.data['queues'][value['id']] = {**value, 'observed': observed, 'finished_at': finished}

    def unlisted(self, listed, observed):
        for queue in list(self.data['queues'].values()):
            if queue['id'] not in listed and queue['state'] not in TERMINAL:
                self.queue({**queue, 'state': 'UNLISTED'}, observed)

    def turn(self, paths, at):
        turns = self.data['project_turns']
        for name in project_names(paths):
            turns[name] = max(at, turns.get(name, 0))

    def counted(self, queue):
        """Whether a queue is outstanding or ended since its project's last turn."""
        return queue.get('finished_at') is None or ended(queue) > self.data['project_turns'].get(queue['project'], 0)

    def queue_counts(self):
        """Per queue project: queues finished since its last turn / queues not yet seen finished."""
        counts = {}
        for queue in filter(self.counted, self.data['queues'].values()):
            count = counts.setdefault(queue['project'], {'done': 0, 'total': 0})
            count['total'] += 1
            count['done'] += queue.get('finished_at') is not None
        return counts

    def queues_finished(self):
        """Per queue project whose queues since its last turn have all finished: when the tracker saw the last."""
        projects = {}
        for queue in filter(self.counted, self.data['queues'].values()):
            projects.setdefault(queue['project'], []).append(queue)
        return {project: max(queue['finished_at'] for queue in queues) for project, queues in projects.items()
                if all(queue.get('finished_at') is not None for queue in queues)}

    def prune(self, now, listed, open_keys):
        """Forget finished queues that no count includes and the monitor no longer lists (`listed`, None when not yet
        known), KEEP_QUEUES after they finished, and closed chats with no activity for KEEP_CHATS."""
        for id, queue in list(self.data['queues'].items()) if listed is not None else []:
            finished = queue.get('finished_at')
            if id not in listed and finished is not None and finished < now - KEEP_QUEUES and not self.counted(queue):
                del self.data['queues'][id]
        for key, row in list(self.data['conversations'].items()):
            last = max([row['state_at'], row['ack']] + [row.get(name, 0) for name in ['human_at', 'hook_seen', 'began']])
            if key in open_keys or last >= now - KEEP_CHATS: continue
            if key.startswith('claude:'): del self.data['conversations'][key]
            # Other providers' events are reread from their logs when the chat opens again; only the cutoff that
            # keeps those already reviewed is kept.
            elif row['reasons'] or row['state_at'] or set(row) - {'state', 'state_at', 'ack', 'reasons', 'turn'}:
                self.data['conversations'][key] = {'state': 'unknown', 'state_at': 0, 'ack': last, 'reasons': {}, 'turn': None}

