"""Read-only git status of the repositories that hold open projects. Never fetches or locks."""
import os
import re
import subprocess
from pathlib import Path

TIMEOUT = 10
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


def web_url(remote):
    """The browser page of a GitHub-style remote, or None."""
    match = (re.match(r'^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?/?$', remote)
             or re.match(r'^(?:ssh|https?)://(?:[^@/]+@)?([\w.-]+)(?::\d+)?/(.+?)(?:\.git)?/?$', remote))
    return f'https://{match[1]}/{match[2]}' if match else None


def status(top):
    gitdir = Path(git(top, 'rev-parse', '--absolute-git-dir').strip())
    value = {'top': str(top), 'name': Path(top).name, **parse_status(
        git(top, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'))}
    value['operation'] = next((name for marker, name in OPERATIONS if (gitdir / marker).exists()), None)
    try:
        stamp, subject = git(top, 'log', '-1', '--format=%ct%x1f%s').rstrip('\n').split('\x1f', 1)
        value['commit_at'], value['subject'] = int(stamp), subject
    except ValueError:  # No commits yet.
        value['commit_at'], value['subject'] = None, None
    value['remotes'] = len(git(top, 'remote').split())
    remote = (value['upstream'] or 'origin/').split('/')[0]
    try: value['web'] = web_url(git(top, 'remote', 'get-url', remote).strip())
    except ValueError: value['web'] = None
    if value['web'] and value['branch'] and 'github.com/' in value['web']:
        value['web'] += f'/tree/{value["branch"]}'
    return value


class Repositories:
    def __init__(self):
        self.tops = {}  # Folder -> its repository's top level, or None outside any.

    def top(self, folder):
        if folder not in self.tops:
            try: self.tops[folder] = git(folder, 'rev-parse', '--show-toplevel').strip() or None
            except (ValueError, OSError, subprocess.TimeoutExpired): self.tops[folder] = None
        return self.tops[folder]

    def read(self, folders):
        """Status of each repository holding one of these folders, with the folders it holds."""
        held = {}
        for folder in folders:
            if Path(folder).is_dir() and (top := self.top(folder)): held.setdefault(top, set()).add(folder)
        result = []
        for top, inside in sorted(held.items()):
            try: value = status(top)
            except (ValueError, OSError, subprocess.TimeoutExpired) as error:
                value = {'top': top, 'name': Path(top).name, 'error': (str(error) or type(error).__name__).splitlines()[0][:200]}
            result.append({**value, 'folders': sorted(inside)})
        return result
