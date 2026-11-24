"""What the panel's Info tab shows: installed skills, tracker health, and the agent instruction files that apply to
each open project. Read on demand from small local files; nothing polls."""
import json
from pathlib import Path

from . import hook_inventory, hooks
from .state import ROOT

# Instruction files an agent reads in a folder or any folder above it, up to home.
INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']


def frontmatter(path):
    """A SKILL.md's name and description, from its leading --- block."""
    fields = {}
    lines = path.read_text(errors='replace').splitlines()
    if lines[:1] != ['---']: return fields
    for line in lines[1:40]:
        if line == '---': break
        key, _, value = line.partition(':')
        if value and not key.startswith(' '): fields[key.strip()] = value.strip().strip('"\'')
    return fields


def skills(home):
    """Skills by name, with the tools that see them: Claude Code (~/.claude/skills, and those it syncs from
    claude.ai) and Codex (~/.agents/skills)."""
    found = {}
    usage = {}
    try: usage = json.loads((home / '.claude.json').read_text()).get('skillUsage') or {}
    except (OSError, ValueError): pass
    sources = [('claude', home / '.claude/skills', '*/SKILL.md'), ('codex', home / '.agents/skills', '*/SKILL.md'),
               ('claude.ai', home / '.claude/skills/synced', '*/*/SKILL.md')]
    for provider, folder, pattern in sources:
        for path in sorted(folder.glob(pattern)):
            try: fields = frontmatter(path)
            except OSError: continue
            name = fields.get('name') or path.parent.name
            skill = found.setdefault(name, {'name': name, 'description': fields.get('description', ''),
                                            'path': str(path.resolve()), 'providers': [], 'synced': provider == 'claude.ai',
                                            'uses': usage.get(name, {}).get('usageCount', 0),
                                            'last_used': (usage.get(name, {}).get('lastUsedAt') or 0) / 1000})
            if provider not in skill['providers']: skill['providers'].append(provider)
    return sorted(found.values(), key=lambda skill: (skill['synced'], skill['name']))


def health(root, home):
    """Whether the tracker's hooks are installed, when each provider's last arrived, and recent hook errors."""
    last = {}
    try:
        for key, row in json.loads((root / 'ledger.json').read_text())['conversations'].items():
            provider = key.split(':')[0]
            last[provider] = max(last.get(provider, 0), row.get('hook_seen', 0))
    except (OSError, ValueError, KeyError):
        pass
    errors = []
    try: errors = (root / 'hook-errors.log').read_text(errors='replace').splitlines()[-3:]
    except OSError: pass
    return {'hooks': {'claude': {'observer': False, 'waiter': False, **hooks.installed('claude', home)},
                      'codex': {'observer': False, **hooks.installed('codex', home)}},
            'last_event': last, 'errors': errors}


def instructions(folders, home):
    """For each open project folder, the instruction files that apply, nearest first, then the user-wide ones."""
    result = {}
    for folder in sorted(set(folders)):
        path, found = Path(folder), []
        for part in [path, *path.parents]:
            found += [str(part / name) for name in INSTRUCTIONS if (part / name).is_file()]
            if part == home or home not in part.parents: break
        result[folder] = found
    shared = [str(home / name) for name in ['.claude/CLAUDE.md', '.codex/AGENTS.md'] if (home / name).is_file()]
    return {'folders': result, 'user': shared}


def collect(root=ROOT, home=None, project=None):
    home = Path(home or Path.home())
    try: snapshot = json.loads((Path(root) / 'snapshot.json').read_text())
    except (OSError, ValueError): snapshot = {'windows': [], 'rows': []}
    folders = {root for window in snapshot['windows'] for root in window.get('roots') or []}
    return {'ok': True, 'skills': skills(home), 'hook_inventory': hook_inventory.inventory(home, Path(project or home).resolve()),
            'health': health(Path(root), home),
            'instructions': instructions(folders, home)}
