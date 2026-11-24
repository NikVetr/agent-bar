import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_bar import hook_inventory


class HookInventoryTests(unittest.TestCase):
    def test_project_scope_status_and_grouping(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            project = home / 'repo'
            for folder in (home/'.claude', home/'.codex', project/'.claude'):
                folder.mkdir(parents=True)
            handler = {'type': 'command', 'command': 'python -m agent_bar.hook'}
            (home/'.claude/settings.json').write_text(json.dumps({'hooks': {
                'Stop': [{'hooks': [handler]}], 'PostToolUse': [{'matcher': 'Write', 'hooks': [handler]}]}}))
            (project/'.claude/settings.local.json').write_text(json.dumps({'disableAllHooks': True}))
            codex = dict(enabled=True, trustStatus='trusted', handlerType='command', command='python audit.py',
                         sourcePath='/config/hooks.json', source='user', eventName='preToolUse')
            response = [{'hooks': [codex, {**codex, 'trustStatus': 'modified'}, {**codex, 'enabled': False}],
                         'errors': [], 'warnings': []}]
            with patch.dict('os.environ', {'CODEX_HOME': str(home/'.codex'), 'CLAUDE_CONFIG_DIR': str(home/'.claude')}), \
                    patch.object(hook_inventory, 'codex_hooks', return_value=response) as read:
                result = hook_inventory.inventory(home, project)
                read.assert_awaited_once_with(project)
                self.assertEqual(result['warnings'], [])
                claude, *others = result['items']
                self.assertEqual((claude['name'], claude['events'], claude['status']),
                                 ('Agent Bar lifecycle observer', ['Stop', 'PostToolUse · Write'], 'Disabled'))
                self.assertEqual({h['status'] for h in others}, {'Enabled', 'Disabled', 'Changed since approval'})
                self.assertEqual(hook_inventory.inventory(home, home)['items'][0]['status'], 'Configured')

    def test_unavailable_provider_keeps_other_hooks_and_reports_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home/'.codex').mkdir()
            (home/'.claude').mkdir()
            (home/'.claude/settings.json').write_text('{"hooks":{"Stop":[{"hooks":[{"type":"prompt"}]}]}}')
            with patch.dict('os.environ', {'CODEX_HOME': str(home/'.codex'), 'CLAUDE_CONFIG_DIR': str(home/'.claude')}), \
                    patch.object(hook_inventory, 'codex_hooks', side_effect=FileNotFoundError('CLI missing')):
                result = hook_inventory.inventory(home, home)
            self.assertEqual(result['items'][0]['name'], 'prompt hook')
            self.assertIn('CLI missing', result['warnings'][0])

    def test_only_enabled_installed_plugins_contribute_hooks(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            config = home / '.claude'
            plugins = config / 'plugins'
            folder = plugins / 'formatter'
            (folder / 'hooks').mkdir(parents=True)
            settings = config / 'settings.json'
            settings.write_text(json.dumps({'enabledPlugins': {'formatter@test': True, 'off@test': False}}))
            (plugins / 'installed_plugins.json').write_text(json.dumps({'plugins': {
                key: [{'scope': 'user', 'installPath': str(folder)}] for key in ['formatter@test', 'off@test']}}))
            (folder / 'hooks/hooks.json').write_text(json.dumps({'hooks': {'PostToolUse': [
                {'matcher': 'Edit', 'hooks': [{'type': 'command', 'command': 'node format.js'}]}]}}))
            with patch.dict('os.environ', {'CLAUDE_CONFIG_DIR': str(config), 'CODEX_HOME': str(home/'.codex')}):
                result = hook_inventory.inventory(home, home)
            item, = result['items']
            self.assertEqual((item['scope'], item['name'], item['events']), ('formatter@test', 'format.js', ['PostToolUse · Edit']))
