"""Inspect local hook registrations for one project without running a hook."""
import asyncio
import json
import os
import shlex
from pathlib import Path

from . import hooks
from .codex_rpc import RpcError, app_server


def hook_action(handler, kind):
    """Return a display name, declared action and, for our own commands, a known effect."""
    status = handler.get('statusMessage')
    if kind == 'command':
        command = handler.get('command') or ''
        if isinstance(handler.get('args'), list):
            words = [command, *handler['args']]
        else:
            try: words = shlex.split(command)
            except ValueError: words = []
            if words[:1] == ['exec']: words = words[1:]
        executable = Path(words[0]).name if words else ''
        python = executable.rstrip('0123456789.') == 'python'
        if len(words) >= 3 and words[1:3] == ['-m', 'agent_bar.hook'] and python:
            if words[3:] == ['wait']:
                return ('Agent Bar message waiter', 'Run agent_bar.hook wait',
                        'Wakes an idle Claude chat when another agent sends it a message and waking is enabled.')
            if words[3:] in ([], ['codex']):
                return ('Agent Bar lifecycle observer', 'Run ' + ' '.join(words[2:]),
                        'Reports turn and tool events to Agent Bar and surfaces unread agent messages at turn start.')
        if executable and '=' not in words[0]:
            target = executable
            if (python or executable in ('node', 'bash', 'sh')) and len(words) > 1 and not words[1].startswith('-'):
                target = Path(words[1]).name
            return status or target, f'Run {target}', ''
    if kind in ('mcpTool', 'mcp_tool'):
        tool = handler.get('tool') or 'MCP tool'
        return status or tool, 'Call ' + ' / '.join(filter(None, [handler.get('server'), tool])), ''
    action = {'command': 'Run a shell command', 'http': 'Send an HTTP request', 'prompt': 'Evaluate a prompt',
              'agent': 'Run an agent'}.get(kind, f'Run {kind} hook')
    return status or f'{kind} hook', action, ''


def claude_sources(home, project, warnings):
    def read(path):
        try:
            data = json.loads(path.read_text())
            if not isinstance(data, dict): raise ValueError('expected an object')
            return data
        except FileNotFoundError: return {}
        except (OSError, ValueError) as error:
            warnings.append(f'{path}: {error}')
            return {}

    config = Path(os.environ.get('CLAUDE_CONFIG_DIR') or home / '.claude')
    settings = {config / 'settings.json': 'user'}
    if project != home:
        settings.update({project / '.claude/settings.json': 'project', project / '.claude/settings.local.json': 'project local'})
    managed = Path('/etc/claude-code')
    for path in [managed / 'managed-settings.json', *sorted((managed / 'managed-settings.d').glob('*.json'))]:
        settings[path] = 'managed'
    sources = []
    plugins = {}
    disabled = managed_disabled = managed_only = False
    managed_plugins = {}
    for path, scope in settings.items():
        data = read(path)
        if not data: continue
        if 'disableAllHooks' in data: disabled = data['disableAllHooks'] is True
        if scope == 'managed':
            if 'disableAllHooks' in data: managed_disabled = disabled
            if 'allowManagedHooksOnly' in data: managed_only = data['allowManagedHooksOnly'] is True
            managed_plugins.update(data.get('enabledPlugins') or {})
        plugins.update(data.get('enabledPlugins') or {})
        sources.append((path, scope, data))
    if any(plugins.values()):
        installs = read(config / 'plugins/installed_plugins.json').get('plugins', {})
        for plugin, enabled in plugins.items():
            if not enabled: continue
            for install in installs.get(plugin, []):
                if install.get('projectPath') and Path(install['projectPath']) != project: continue
                folder = Path(install['installPath'])
                default = folder / 'hooks/hooks.json'
                sources.append((default, plugin, read(default)))
                manifest = folder / '.claude-plugin/plugin.json'
                extra = read(manifest).get('hooks', [])
                for entry in extra if isinstance(extra, list) else [extra]:
                    if isinstance(entry, str):
                        path = folder / entry
                        if path != default: sources.append((path, plugin, read(path)))
                    elif isinstance(entry, dict): sources.append((manifest, plugin, {'hooks': entry}))
    for path, scope, data in sources:
        blocked = managed_disabled if scope == 'managed' else disabled or (managed_only and not managed_plugins.get(scope))
        status = 'Disabled' if blocked else 'Configured'
        try:
            for event, matcher, handler in hooks.registrations(data):
                yield path, scope, status, event, matcher, handler
        except ValueError as error: warnings.append(f'{path}: {error}')


async def codex_hooks(project):
    async with app_server() as request:
        return (await request('hooks/list', {'cwds': [str(project)]}))['data']


def inventory(home, project):
    found, warnings = {}, []

    def add(provider, path, scope, status, event, matcher, handler):
        kind = handler.get('type') or handler.get('handlerType') or 'command'
        name, action, description = hook_action(handler, kind)
        target = {key: handler[key] for key in ('command', 'args', 'prompt', 'url', 'server', 'tool') if key in handler}
        mode = ('Background with reawakening' if handler.get('asyncRewake') else
                'Background' if handler.get('async') else '')
        timeout = handler.get('timeout', handler.get('timeoutSec'))
        identity = (provider, str(path), scope, status, kind, name, json.dumps(target, sort_keys=True), mode, timeout)
        row = found.setdefault(identity, {'provider': provider, 'path': str(path), 'scope': scope, 'status': status,
                                          'type': kind, 'name': name, 'action': action, 'description': description,
                                          'mode': mode, 'timeout': timeout, 'triggers': [], 'events': []})
        trigger = {'event': event, 'matcher': matcher or '', 'condition': handler.get('if') or ''}
        if trigger not in row['triggers']: row['triggers'].append(trigger)
        # Keep the display strings published by the info CLI alongside the structured triggers.
        display = f'{event} · {matcher}' if matcher else event
        if display not in row['events']: row['events'].append(display)

    try:
        for path, scope, status, event, matcher, handler in claude_sources(home, project, warnings):
            add('claude', path, scope, status, event, matcher, handler)
    except (KeyError, TypeError, AttributeError) as error:
        warnings.append(f'Claude hook settings could not be read: {error}')
    if Path(os.environ.get('CODEX_HOME') or home / '.codex').is_dir() or (project / '.codex').is_dir():
        try:
            for entry in asyncio.run(asyncio.wait_for(codex_hooks(project), timeout=5)):
                warnings.extend(entry.get('warnings', []))
                warnings.extend(err['message'] for err in entry.get('errors', []))
                for handler in entry['hooks']:
                    trust = handler['trustStatus']
                    status = ('Disabled' if not handler['enabled'] else 'Enabled' if trust in ('trusted', 'managed')
                              else 'Changed since approval' if trust == 'modified' else 'Needs approval')
                    event = handler['eventName']
                    add('codex', handler['sourcePath'], handler.get('pluginId') or handler['source'], status,
                        event[:1].upper() + event[1:], handler.get('matcher'), handler)
        except (OSError, EOFError, RpcError, asyncio.TimeoutError, KeyError, ValueError, TypeError) as error:
            warnings.append(f'Codex hook inventory unavailable: {str(error) or type(error).__name__}')
    return {'items': sorted(found.values(), key=lambda row: (row['provider'], row['name'], row['path'])),
            'warnings': warnings}
