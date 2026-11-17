"""Task checklists (`tmp/agent/checklists/*.md`, the task-checklists skill's format) in the open projects, for the
panel: per file, its items' counts, a suggested next item, and the open items that wait on the user, on something
else, or were deferred.

Only checkbox lines outside fenced code count: `[ ]` open, `[x]`/`[X]` done, `[-]` dropped from scope (left out of
the total). Other markers are counted as unknown, never as done. An open item may start with `User:`, `Waiting:` or
`Deferred:`; the first open item without one is the suggested next. Links to other checklists are listed for
navigation; their counts are not added in, since a link may be a citation and a parent may summarize its children.
Which chats edited a file comes from their transcripts (see providers.py), and is evidence, not ownership."""
import re
from pathlib import Path

FOLDER = Path('tmp/agent/checklists')
RECENT = 14 * 86400  # Updated this recently: listed as recent; older files with open items stay listed as older.
SHOWN = 10  # Items of each kind kept per file.
LENGTH = 240  # Characters kept of an item's text.
ITEM = re.compile(r'^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$')
FENCE = re.compile(r'^\s*(```|~~~)')
PREFIXES = {'user': 'User:', 'waiting': 'Waiting:', 'deferred': 'Deferred:'}
LINK = re.compile(r'\]\(([^)#\s]+\.md)\)')
# A path under a checklists folder in a tool call; what writes it is decided by the caller.
PATH = re.compile(r'(?:~|/|\.{1,2}/|[\w.-]+/)*tmp/agent/checklists/[\w./-]*?\.md')
# Shell commands that mention a checklist path and write a file, as far as their text shows.
WRITES = ('>', 'write_text', 'sed -i', 'perl -i', 'tee ', 'open(', 'cat <<', 'apply_patch', '.write(', 'mv ', 'cp ')


def short(text):
    text = ' '.join(text.split())
    return text if len(text) <= LENGTH else f'{text[:LENGTH - 1]}…'


def parse(text):
    """A checklist's title, item counts and the items worth showing."""
    result = {'title': None, 'done': 0, 'open': 0, 'dropped': 0, 'unknown': 0, 'next': None,
              'user': [], 'waiting': [], 'deferred': [], 'links': []}
    fenced = False
    for line in text.splitlines():
        if FENCE.match(line):
            fenced = not fenced
            continue
        if fenced: continue
        if result['title'] is None and line.startswith('# '): result['title'] = line[2:].strip()
        result['links'] += [link for link in LINK.findall(line) if not re.match(r'\w+:', link) and link not in result['links']]
        match = ITEM.match(line)
        if not match: continue
        mark, body = match[1], match[2].strip()
        if mark in 'xX': result['done'] += 1
        elif mark == '-': result['dropped'] += 1
        elif mark == ' ':
            result['open'] += 1
            kind = next((kind for kind, prefix in PREFIXES.items() if body.startswith(prefix)), None)
            if kind:
                if len(result[kind]) < SHOWN: result[kind].append(short(body[len(PREFIXES[kind]):]))
            elif result['next'] is None: result['next'] = short(body)
        else: result['unknown'] += 1
    return result


def edited(text, shell=False, cwd=None):
    """Checklist paths a tool call's text names; for a shell command, only if it seems to write a file. Relative paths
    resolve against `cwd` when given."""
    if shell and not any(cue in text for cue in WRITES): return []
    paths = []
    for found in PATH.findall(text):
        path = Path(found).expanduser()
        if not path.is_absolute():
            if not cwd: continue
            path = Path(cwd) / path
        paths.append(str(Path(*path.parts)))
    return paths


def scan(folders, cache, now):
    """For each folder, its checklists, newest first: those updated within RECENT, and older ones that still have open
    items; `older_closed` counts the older ones without. `cache` (path -> (mtime, size, parsed)) spares rereading
    files that have not changed."""
    result = {}
    for folder in sorted(set(folders)):
        files = []
        root = Path(folder) / FOLDER
        try: paths = sorted(root.rglob('*.md'))
        except OSError: paths = []
        closed = 0
        for path in paths:
            try: stat = path.stat()
            except OSError: continue
            cached = cache.get(str(path))
            if not cached or cached[:2] != (stat.st_mtime, stat.st_size):
                try: cached = (stat.st_mtime, stat.st_size, parse(path.read_text(errors='replace')))
                except OSError: continue
                cache[str(path)] = cached
            parsed = cached[2]
            recent = now - stat.st_mtime < RECENT
            if not recent and not parsed['open']:
                closed += 1
                continue
            links = []
            for link in parsed['links']:
                target = (path.parent / link).resolve()
                links.append({'path': str(target), 'exists': target.is_file()})
            files.append({**parsed, 'path': str(path), 'name': str(path.relative_to(root)), 'modified': stat.st_mtime,
                          'recent': recent, 'links': links})
        files.sort(key=lambda entry: -entry['modified'])
        if files or closed: result[folder] = {'files': files, 'older_closed': closed}
    return result
