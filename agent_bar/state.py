"""Attention bookkeeping, independent of providers and the desktop."""
import json
import os
import time
from pathlib import Path

ROOT = Path.home() / '.local/state/agent-bar'
# UNLISTED: the queue monitor stopped listing an active queue, so its outcome is unknown but it is no longer running.
TERMINAL = {'COMPLETED', 'FINISHED_INCOMPLETE', 'FAILED', 'KILLED', 'UNLISTED'}


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


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.next')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, separators=(',', ':'))
    temporary.replace(path)


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
        if kind in ['complete', 'failure', 'hold'] and identity and seen.get(kind) == identity:
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

    def unread(self, key, queues_at=None):
        """Unread reasons; queues_at: when this conversation's project last had all its queues finish."""
        row = self.conversation(key)
        reasons = [name for name, at in row['reasons'].items() if at > row['ack']]
        return reasons + ['Queues finished'] if queues_at and queues_at > row['ack'] else reasons

    def queue(self, value, observed):
        finished = self.data['queues'].get(value['id'], {}).get('finished_at')
        if value['state'] not in TERMINAL: finished = None
        elif finished is None: finished = observed
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
        """Whether a queue is outstanding or finished since its project's last turn."""
        finished = queue.get('finished_at')
        return finished is None or finished > self.data['project_turns'].get(queue['project'], 0)

    def queue_counts(self):
        """Per queue project: queues finished since its last turn / queues not yet seen finished."""
        counts = {}
        for queue in filter(self.counted, self.data['queues'].values()):
            count = counts.setdefault(queue['project'], {'done': 0, 'total': 0})
            count['total'] += 1
            count['done'] += queue.get('finished_at') is not None
        return counts

    def queues_finished(self):
        """Per queue project whose queues since its last turn have all finished: when the tracker saw the last.
        The tracker sees an end only at the monitor's next refresh, so a turn after the monitor's own end time, such as
        an agent woken by that end, has already answered it."""
        projects = {}
        for queue in filter(self.counted, self.data['queues'].values()):
            projects.setdefault(queue['project'], []).append(queue)
        result = {}
        for project, queues in projects.items():
            if any(queue.get('finished_at') is None for queue in queues): continue
            ended = max(min(queue.get('ended') or queue['finished_at'], queue['finished_at']) for queue in queues)
            if ended > self.data['project_turns'].get(project, 0):
                result[project] = max(queue['finished_at'] for queue in queues)
        return result

