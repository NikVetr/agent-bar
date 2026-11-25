"""A saved conversation as Markdown or HTML: the messages between you and the agent, in order, as History indexes
them (no tool calls, tool results, reasoning or client-supplied context)."""
import html
import json
import re
import sqlite3
import subprocess
from datetime import datetime
from pathlib import Path

from . import history_search
from .providers import epoch
from .state import ROOT

TIMESTAMP = re.compile(rb'"timestamp":\s*"([^"]+)"')
CWD = re.compile(rb'"cwd":\s*"((?:[^"\\]|\\.)*)"')
FORMATS = {'markdown': '.md', 'html': '.html'}
NAMES = {'claude': 'Claude', 'codex': 'Codex'}


def transcripts(key, home):
    """The transcript files of a saved conversation, oldest first: a Codex thread continued in a later file has
    several."""
    provider, _, ident = key.partition(':')
    if provider == 'claude':
        return sorted((home / '.claude/projects').glob(f'*/{ident}.jsonl'))
    if provider == 'codex':
        found = [path for folder in ['sessions', 'archived_sessions']
                 for path in (home / '.codex' / folder).glob(f'**/rollout-*-{ident}*.jsonl')]
        if not found and (database := home / '.codex/state_5.sqlite').exists():
            with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=2) as connection:
                row = connection.execute('SELECT rollout_path FROM threads WHERE id = ?', (ident,)).fetchone()
            found = [Path(row[0])] if row and Path(row[0]).exists() else []
        return sorted(found, key=lambda path: path.name)
    raise ValueError('Only Claude Code and Codex conversations can be exported')


def read(key, home):
    """The conversation's messages as (role, text, time) and the folder it ran in."""
    paths = transcripts(key, home)
    if not paths: raise ValueError(f'No saved transcript for {key}')
    provider, messages, folder = key.split(':', 1)[0], [], None
    for path in paths:
        with path.open('rb') as stream:
            for line in stream:
                if folder is None and (match := CWD.search(line)): folder = json.loads(f'"{match[1].decode()}"')
                try: message = history_search.dialogue(line, provider)
                except ValueError: continue
                if message:
                    stamp = TIMESTAMP.search(line)
                    messages.append((*message, epoch(stamp[1].decode()) if stamp else None))
    return messages, folder


def title_of(key, root):
    try: rows = json.loads((Path(root) / 'inventory.json').read_text())['conversations']
    except (OSError, ValueError, KeyError): return None
    return next((row['title'] for row in rows if row['key'] == key), None)


def when(at):
    return datetime.fromtimestamp(at).strftime('%Y-%m-%d %H:%M') if at else ''


def markdown(title, key, folder, messages):
    agent = NAMES[key.split(':')[0]]
    where = f' in `{folder}`' if folder else ''
    lines = [f'# {title}', '', f'{agent} conversation `{key}`{where}.',
             f'Exported {when(datetime.now().timestamp())} by Agent Bar: your messages and the agent\'s replies, without tool calls.', '']
    for role, text, at in messages:
        lines += [f'## {"You" if role == "user" else agent}' + (f' · {when(at)}' if at else ''), '', text, '']
    return '\n'.join(lines)


def page(title, key, folder, messages):
    agent = NAMES[key.split(':')[0]]
    blocks = '\n'.join(
        f'<article class="{role}"><header>{"You" if role == "user" else agent}<time>{when(at)}</time></header>'
        f'<div class="text">{html.escape(text)}</div></article>' for role, text, at in messages)
    where = f' in <code>{html.escape(folder)}</code>' if folder else ''
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
:root {{ --bg: #fbfbfa; --fg: #1d2129; --muted: #69707d; --you: #eef3fb; --agent: #ffffff; --line: #dfe3e8; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #16181c; --fg: #e6e8eb; --muted: #9aa3ad; --you: #1e2733; --agent: #1c1f24; --line: #2c3138; }} }}
body {{ margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, sans-serif; }}
main {{ max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }}
h1 {{ font-size: 22px; margin: 0 0 4px; }}
.meta {{ color: var(--muted); font-size: 13px; margin-bottom: 24px; }}
article {{ border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin: 12px 0; background: var(--agent); }}
article.user {{ background: var(--you); }}
header {{ font-weight: 600; font-size: 13px; display: flex; gap: 12px; margin-bottom: 6px; }}
time {{ color: var(--muted); font-weight: 400; }}
.text {{ white-space: pre-wrap; overflow-wrap: anywhere; }}
code {{ font-size: 13px; }}
</style></head>
<body><main><h1>{html.escape(title)}</h1>
<div class="meta">{agent} conversation <code>{html.escape(key)}</code>{where}. Exported {when(datetime.now().timestamp())} by Agent Bar:
your messages and the agent's replies, without tool calls.</div>
{blocks}
</main></body></html>
'''


def downloads(home):
    """The desktop's Downloads folder, or ~/Downloads."""
    try:
        folder = subprocess.run(['xdg-user-dir', 'DOWNLOAD'], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        folder = ''
    return Path(folder) if folder and Path(folder) != home else home / 'Downloads'


def export(key, fmt='markdown', output=None, home=None, root=ROOT):
    """Write the conversation to `output` (a .md or .html file, or a folder for a generated name; Downloads by default) without
    replacing an existing file. Returns the path and the number of messages."""
    if fmt not in FORMATS: raise ValueError(f'Unknown format {fmt}; use markdown or html')
    home = Path(home or Path.home())
    messages, folder = read(key, home)
    if not messages: raise ValueError('This conversation has no messages to export')
    title = title_of(key, root) or (messages[0][1].splitlines()[0][:80] if messages[0][0] == 'user' else key)
    target = Path(output).expanduser() if output else downloads(home)
    # A path ending in .md or .html names the file; any other names a folder, made if missing.
    if target.suffix.lower() not in ('.md', '.markdown', '.html', '.htm') or target.is_dir():
        slug = re.sub(r'[^\w.-]+', '-', title).strip('-')[:60] or key.split(':')[1][:8]
        target.mkdir(parents=True, exist_ok=True)
        base = target / f'{slug}-{datetime.now().strftime("%Y-%m-%d")}'
        target, number = base.with_name(base.name + FORMATS[fmt]), 2
        while target.exists():
            target, number = base.with_name(f'{base.name}-{number}{FORMATS[fmt]}'), number + 1
    elif target.exists():
        raise ValueError(f'{target} already exists')
    render = markdown if fmt == 'markdown' else page
    target.write_text(render(title, key, folder, messages))
    return {'ok': True, 'path': str(target), 'messages': len(messages)}
