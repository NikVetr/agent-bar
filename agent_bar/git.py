"""Read-only git status of the repositories that hold open projects. Never fetches or locks. With the panel's
pull-request setting on, also asks GitHub, through the gh command, about each branch's pull request."""
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

TIMEOUT = 10
RECHECK = 300  # Seconds before a folder found outside any repository is checked again.
PULL_EVERY = 300  # Seconds a branch's pull request, once read from GitHub, is shown before it is asked again.
DIFF_FILES = 8  # Most-changed files listed with a diff summary.
# Background readers must not take index.lock, which would make an agent's own git command fail.
ENV = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'LC_ALL': 'C', 'GIT_TERMINAL_PROMPT': '0'}
OPERATIONS = [('rebase-merge', 'rebasing'), ('rebase-apply', 'rebasing'), ('MERGE_HEAD', 'merging'),
              ('CHERRY_PICK_HEAD', 'cherry-picking'), ('REVERT_HEAD', 'reverting'), ('BISECT_LOG', 'bisecting')]


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True,
                            timeout=TIMEOUT, env=ENV, stdin=subprocess.DEVNULL)
    if result.returncode: raise ValueError(result.stderr.strip() or f'git {args[0]} failed')
    return result.stdout


def parse_status(text):
    """`git status --porcelain=v2 --branch -z` as branch, upstream, ahead/behind and change counts."""
    value = {'branch': None, 'upstream': None, 'ahead': 0, 'behind': 0,
             'staged': 0, 'modified': 0, 'untracked': 0, 'conflicts': 0}
    fields = iter(text.split('\0'))
    for field in fields:
        if field.startswith('# branch.head '):
            head = field[len('# branch.head '):]
            value['branch'] = None if head == '(detached)' else head
        elif field.startswith('# branch.upstream '): value['upstream'] = field[len('# branch.upstream '):]
        elif field.startswith('# branch.ab '):
            ahead, behind = field[len('# branch.ab '):].split()
            value['ahead'], value['behind'] = int(ahead), -int(behind)
        elif field[:2] in ['1 ', '2 ']:
            value['staged'] += field[2] != '.'
            value['modified'] += field[3] != '.'
            if field[0] == '2': next(fields, None)  # A rename's original path is its own field.
        elif field.startswith('u '): value['conflicts'] += 1
        elif field.startswith('? '): value['untracked'] += 1
    return value


def parse_numstat(text):
    """`git diff --numstat` as files changed, lines added and removed, and the files most changed (binary files count as
    changed with no lines)."""
    files = []
    for line in text.splitlines():
        parts = line.split('\t', 2)
        if len(parts) != 3: continue
        added, removed = (int(value) if value.isdigit() else 0 for value in parts[:2])
        files.append([parts[2], added, removed])
    files.sort(key=lambda entry: -(entry[1] + entry[2]))
    return {'files': len(files), 'added': sum(f[1] for f in files), 'removed': sum(f[2] for f in files), 'top': files[:DIFF_FILES]}


def checks_state(rollup):
    """One word for a pull request's checks: failing, pending, passing, or None when it has none."""
    states = [(item.get('conclusion') or item.get('state') or '').upper() if (item.get('status') or 'COMPLETED').upper() == 'COMPLETED'
              else 'PENDING' for item in rollup or [] if isinstance(item, dict)]
    if any(state in ('FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE') for state in states): return 'failing'
    if any(state in ('PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', '') for state in states): return 'pending'
    return 'passing' if states else None


def pull_request(top, branch):
    """The GitHub pull request whose head is `branch`, through gh, or None when there is none."""
    result = subprocess.run(['gh', 'pr', 'view', branch, '--json', 'number,title,state,isDraft,url,reviewDecision,statusCheckRollup'],
                            cwd=top, capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL,
                            env={**ENV, 'GH_PROMPT_DISABLED': '1', 'GH_NO_UPDATE_NOTIFIER': '1'})
    if result.returncode:
        message = (result.stderr.strip() or 'gh pr view failed').splitlines()[0]
        if 'no pull requests found' in message.lower(): return None
        raise ValueError(message[:200])
    data = json.loads(result.stdout)
    return {'number': data['number'], 'title': data['title'], 'state': data['state'].lower(), 'draft': bool(data.get('isDraft')),
            'url': data['url'], 'review': (data.get('reviewDecision') or '').lower() or None,
            'checks': checks_state(data.get('statusCheckRollup'))}


def web_url(remote):
    """The browser page of a GitHub-style remote, or None."""
    match = (re.match(r'^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?/?$', remote)
             or re.match(r'^(?:ssh|https?)://(?:[^@/]+@)?([\w.-]+)(?::\d+)?/(.+?)(?:\.git)?/?$', remote))
    return f'https://{match[1]}/{match[2]}' if match else None


def stamp(gitdir):
    """What changes when HEAD moves (a commit, checkout or reset writes HEAD's reflog), or the remotes do."""
    marks = []
    for name in ['HEAD', 'logs/HEAD', 'config', 'packed-refs']:
        try: marks.append((gitdir / name).stat().st_mtime_ns)
        except OSError: marks.append(None)
    return tuple(marks)


def status(top, known=None):
    """A repository's state. `known` (kept between calls) holds its git directory and what only a commit, checkout or
    remote change alters, so those are asked again only when the git directory shows such a change; `git status`,
    which sees edits to the working tree, runs every time."""
    known = {} if known is None else known
    if 'gitdir' not in known: known['gitdir'] = Path(git(top, 'rev-parse', '--absolute-git-dir').strip())
    gitdir = known['gitdir']
    value = {'top': str(top), 'name': Path(top).name, **parse_status(
        git(top, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'))}
    value['operation'] = next((name for marker, name in OPERATIONS if (gitdir / marker).exists()), None)
    marks = stamp(gitdir)
    if known.get('stamp') != marks:
        known.update(stamp=marks, urls={})
        try:
            at, subject = git(top, 'log', '-1', '--format=%ct%x1f%s').rstrip('\n').split('\x1f', 1)
            known['commit'] = int(at), subject
        except ValueError:  # No commits yet.
            known['commit'] = None, None
        known['remotes'] = len(git(top, 'remote').split())
    value['commit_at'], value['subject'] = known['commit']
    value['remotes'] = known['remotes']
    remote = (value['upstream'] or 'origin/').split('/')[0]
    if remote not in known['urls']:
        try: known['urls'][remote] = web_url(git(top, 'remote', 'get-url', remote).strip())
        except ValueError: known['urls'][remote] = None
    value['web'] = known['urls'][remote]
    value['github'] = bool(value['web'] and 'github.com/' in value['web'])
    if value['web'] and value['branch'] and value['github']:
        value['web'] += f'/tree/{value["branch"]}'
    # Lines changed in tracked files since the last commit, staged or not; untracked files are counted above.
    value['diff'] = None
    if (value['staged'] or value['modified']) and known['commit'][0] is not None:
        try: value['diff'] = parse_numstat(git(top, 'diff', 'HEAD', '--numstat', '--no-renames'))
        except ValueError: pass
    return value


class Repositories:
    def __init__(self):
        self.tops = {}  # Folder -> (its repository's top level, or None outside any; when that was found).
        self.known = {}  # Repository top level -> what status() keeps between reads.
        self.pulls = {}  # (top level, branch) -> (when read, pull request or None, error or None).

    def top(self, folder):
        # A folder outside any repository may become one (git init, or a timeout that passes), so ask again later.
        top, at = self.tops.get(folder, (None, None))
        if at is None or (top is None and time.time() - at > RECHECK):
            try: top = git(folder, 'rev-parse', '--show-toplevel').strip() or None
            except (ValueError, OSError, subprocess.TimeoutExpired): top = None
            self.tops[folder] = top, time.time()
        return top

    def pull(self, value):
        """The branch's pull request and why it could not be read, asked of GitHub at most every PULL_EVERY."""
        if not shutil.which('gh'): return None, 'the gh command is not installed'
        key = (value['top'], value['branch'])
        at, found, error = self.pulls.get(key, (0, None, None))
        if time.time() - at >= PULL_EVERY:
            try: found, error = pull_request(value['top'], value['branch']), None
            except (ValueError, OSError, subprocess.TimeoutExpired, KeyError, json.JSONDecodeError) as problem:
                found, error = None, str(problem) or type(problem).__name__
            self.pulls[key] = (time.time(), found, error)
        return found, error

    def read(self, folders, pulls=False):
        """Status of each repository holding one of these folders, with the folders it holds; with `pulls`, each
        GitHub branch's pull request."""
        held = {}
        for folder in folders:
            if Path(folder).is_dir() and (top := self.top(folder)): held.setdefault(top, set()).add(folder)
        result = []
        for top, inside in sorted(held.items()):
            try: value = status(top, self.known.setdefault(top, {}))
            except (ValueError, OSError, subprocess.TimeoutExpired) as error:
                self.known.pop(top, None)
                value = {'top': top, 'name': Path(top).name, 'error': (str(error) or type(error).__name__).splitlines()[0][:200]}
            if pulls and value.get('github') and value.get('branch'):
                value['pull'], value['pull_error'] = self.pull(value)
            result.append({**value, 'folders': sorted(inside)})
        return result
