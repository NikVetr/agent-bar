"""Add agent-bar's hooks to Claude Code's and Codex's settings, or take them out, keeping every other hook."""
import json
import shlex
import shutil
import sys
import time
from pathlib import Path

from .state import atomic_json

MODULE = '-m agent_bar.hook'
# Events the metadata-only observer watches, with their tool matchers.
EVENTS = {
    'claude': {'UserPromptSubmit': None, 'Stop': None, 'StopFailure': None, 'PermissionRequest': '*', 'Elicitation': '*',
               'ElicitationResult': '*', 'PostToolUse': '*', 'PreToolUse': 'AskUserQuestion', 'SessionEnd': None},
    'codex': {'UserPromptSubmit': None, 'Stop': None, 'PermissionRequest': '*', 'PostToolUse': '*',
              'PreToolUse': '.*request_user_input.*', 'Interrupt': None},
}


def settings(provider, home=None):
    return Path(home or Path.home()) / ('.claude/settings.json' if provider == 'claude' else '.codex/hooks.json')


def wanted(provider):
    """(event, matcher, hook) for each hook agent-bar needs, run by this installation's Python."""
    base = f'{shlex.quote(sys.executable)} {MODULE}'
    observer = base + (' codex' if provider == 'codex' else '')
    hooks = [(event, matcher, {'type': 'command', 'command': observer, 'timeout': 3})
             for event, matcher in EVENTS[provider].items()]
    if provider == 'claude':
        # Runs in the background after each turn and wakes the chat for a new agent message when waking is on, for up
        # to a week; exec leaves no shell waiting beside it.
        hooks.append(('Stop', None, {'type': 'command', 'command': f'exec {base} wait', 'asyncRewake': True, 'timeout': 604800}))
    return hooks


def ours(hook):
    return MODULE in hook.get('command', '')


def write(path, data, before):
    if json.dumps(data, sort_keys=True) == before: return False
    if path.exists():
        backup = path.with_name(f'{path.name}.before-agent-bar-{int(time.time())}')
        shutil.copy2(path, backup)
        print(f'Backup: {backup}')
    # A settings file linked from elsewhere, such as a dotfiles folder, is edited where it lives, indented as the
    # tools write it.
    atomic_json(path.resolve(), data, indent=2)
    return True


def strip(hooks, keep=lambda hook: False):
    """Drop agent-bar's hooks except those `keep` accepts, and any entries or events left empty."""
    for event in list(hooks):
        for entry in hooks[event]:
            entry['hooks'] = [hook for hook in entry.get('hooks', []) if not ours(hook) or keep(hook)]
        hooks[event] = [entry for entry in hooks[event] if entry['hooks']]
        if not hooks[event]: del hooks[event]


def install(provider):
    path = settings(provider)
    data = json.loads(path.read_text()) if path.exists() else {}
    before = json.dumps(data, sort_keys=True)
    hooks = data.setdefault('hooks', {})
    current = wanted(provider)
    # Hooks from an earlier installation's interpreter go; this one's stay.
    strip(hooks, keep=lambda hook: any(hook == wanted_hook for _, _, wanted_hook in current))
    for event, matcher, hook in current:
        entries = hooks.setdefault(event, [])
        if any(existing == hook for entry in entries for existing in entry.get('hooks', [])): continue
        entries.append({**({'matcher': matcher} if matcher else {}), 'hooks': [hook]})
    if write(path, data, before): print(f'Installed {provider} hooks in {path}')


def remove(provider):
    path = settings(provider)
    if not path.exists(): return
    data = json.loads(path.read_text())
    before = json.dumps(data, sort_keys=True)
    strip(data.get('hooks', {}))
    if write(path, data, before): print(f'Removed {provider} hooks from {path}')


def registrations(data):
    """Yield the event, matcher and handler from a hook settings document."""
    groups = data.get('hooks', {}) if isinstance(data, dict) else None
    if not isinstance(groups, dict): raise ValueError('expected a hook event map')
    for event, entries in groups.items():
        if not isinstance(entries, list): raise ValueError(f'{event}: expected a list of matchers')
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get('hooks'), list):
                raise ValueError(f'{event}: invalid matcher group')
            for handler in entry['hooks']:
                if not isinstance(handler, dict): raise ValueError(f'{event}: invalid hook handler')
                yield event, entry.get('matcher'), handler


def installed(provider, home=None):
    """Which of agent-bar's hooks the provider's settings hold, by kind."""
    try:
        data = json.loads(settings(provider, home).read_text())
        commands = [hook['command'] for _, _, hook in registrations(data) if isinstance(hook.get('command'), str)]
    except (OSError, ValueError): return {}
    found = {'observer': any(command.endswith(MODULE + (' codex' if provider == 'codex' else '')) for command in commands)}
    if provider == 'claude': found['waiter'] = any(command.endswith(f'{MODULE} wait') for command in commands)
    return found
