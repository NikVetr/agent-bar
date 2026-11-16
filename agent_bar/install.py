"""Install, remove or check agent-bar for this user: its background service and daily inventory scan, the provider
hooks and skill, the VS Code bridge and the GNOME Shell extension. Nothing here needs root or restarts the desktop."""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import bridge, hooks
from .state import ROOT

UUID = 'agent-bar@nikvetr.github.io'
EXTENSION = Path(__file__).with_name('data') / 'gnome-extension'
# The skills that teach agents to use agent-bar's messages and tickets.
SKILLS = Path(__file__).with_name('data') / 'skills'
MARK = '.installed-by-agent-bar'  # In a skill folder agent-bar copied, which it may replace or remove.
UNITS = Path.home() / '.config/systemd/user'
SERVICE, INVENTORY = 'agent-bar.service', 'agent-bar-inventory'
GNOME = ['42']  # Shell versions the extension supports.


def units():
    python = sys.executable
    return {SERVICE: f'''[Unit]
Description=Agent Bar: tracks open AI agent chats for the top bar
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart={python} -m agent_bar serve
Restart=on-failure
RestartSec=3
Nice=10
CPUQuota=20%
MemoryMax=256M
UMask=0077

[Install]
WantedBy=graphical-session.target
''',
            # The inventory rescans only appended transcript data, at idle priority.
            f'{INVENTORY}.service': f'''[Unit]
Description=Agent Bar: inventory saved Claude and Codex conversations

[Service]
Type=oneshot
ExecStart={python} -m agent_bar inventory
Nice=19
IOSchedulingClass=idle
CPUQuota=50%
MemoryMax=512M
UMask=0077
''',
            f'{INVENTORY}.timer': '''[Unit]
Description=Agent Bar: refresh the conversation inventory daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
'''}


def run(command, check=True):
    """A command's result; a missing program fails like a command that returned 127."""
    if not shutil.which(command[0]):
        if check: raise SystemExit(f'agent-bar needs {command[0]}, which is not installed here')
        return subprocess.CompletedProcess(command, 127, '', f'{command[0]} not found')
    return subprocess.run(command, check=check, capture_output=True, text=True)


def providers():
    """The agent tools this user has: hooks go only where their settings live."""
    return [name for name, folder in [('claude', '.claude'), ('codex', '.codex')] if (Path.home() / folder).is_dir()]


def skill_folders():
    """Where each agent tool this user has looks for the user's own skills."""
    return [Path.home() / {'claude': '.claude/skills', 'codex': '.agents/skills'}[provider] for provider in providers()]


def install_skills():
    """Copy agent-bar's skills where none of the same name is, and update the copies it made before."""
    for folder in skill_folders():
        for skill in sorted(SKILLS.iterdir()):
            target = folder / skill.name
            if target.exists() or target.is_symlink():
                if target.is_symlink() or not (target / MARK).exists():
                    print(f'Skill {skill.name}: kept the one already in {folder}')
                    continue
                shutil.rmtree(target)
            shutil.copytree(skill, target)
            (target / MARK).write_text('agent-bar install copied this skill; it replaces or removes only folders with this file\n')
            print(f'Skill {skill.name} installed in {folder}')


def remove_skills():
    for folder in skill_folders():
        for skill in SKILLS.iterdir():
            target = folder / skill.name
            if not target.is_symlink() and (target / MARK).exists(): shutil.rmtree(target)


def install():
    if not shutil.which('systemctl'):
        raise SystemExit('agent-bar runs as a systemd user service on Linux, and this system has no systemctl')
    UNITS.mkdir(parents=True, exist_ok=True)
    for name, text in units().items(): (UNITS / name).write_text(text)
    run(['systemctl', '--user', 'daemon-reload'])
    run(['systemctl', '--user', 'enable', '--now', SERVICE, f'{INVENTORY}.timer'])
    run(['systemctl', '--user', 'restart', SERVICE])
    run(['systemctl', '--user', 'start', '--no-block', f'{INVENTORY}.service'])
    print(f'Service: {SERVICE} running; inventory refreshed daily')
    for provider in providers(): hooks.install(provider)
    install_skills()
    if shutil.which('code'):
        run(['code', '--install-extension', str(bridge.build()), '--force'])
        print('VS Code bridge installed; open windows start a new bridge on their own, '
              'but run an updated one only once reloaded (Developer: Reload Window)')
    else:
        print('VS Code not found: skipped the bridge, so chats in VS Code will not be listed')
    if shutil.which('gnome-shell'):
        target = Path.home() / '.local/share/gnome-shell/extensions' / UUID
        if target.exists(): shutil.rmtree(target)
        shutil.copytree(EXTENSION, target)
        enabled = run(['gnome-extensions', 'enable', UUID], check=False).returncode == 0
        # A running copy rereads the installed files itself; one from before that method needs a new login.
        reloaded = enabled and shutil.which('gdbus') and run(
            ['gdbus', 'call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Extensions/AgentBar',
             '--method', 'io.github.nikvetr.AgentBar.Reload'], check=False).returncode == 0
        print(f'GNOME Shell extension installed in {target}' + ('; the running top bar reloaded it' if reloaded
              else '' if enabled else
              '; log out and back in (or press Alt+F2, type r, Enter on X11) so GNOME Shell finds it, then run agent-bar install again'))
    else:
        print('GNOME Shell not found: the service and CLI work, but there is no top bar on this desktop yet')


def uninstall(purge=False):
    run(['systemctl', '--user', 'disable', '--now', SERVICE, f'{INVENTORY}.timer'], check=False)
    for name in units(): (UNITS / name).unlink(missing_ok=True)
    run(['systemctl', '--user', 'daemon-reload'], check=False)
    for provider in ['claude', 'codex']: hooks.remove(provider)
    remove_skills()
    if shutil.which('code'): run(['code', '--uninstall-extension', bridge.ID], check=False)
    if shutil.which('gnome-extensions'): run(['gnome-extensions', 'uninstall', UUID], check=False)
    if purge:
        for folder in [ROOT, Path.home() / '.config/agent-bar', Path.home() / '.cache/agent-bar']:
            shutil.rmtree(folder, ignore_errors=True)
    print('Removed agent-bar' + ('' if purge else f'; its history and settings remain in {ROOT} and ~/.config/agent-bar'))


def doctor():
    """Each part's state, as JSON, with a hint for anything missing."""
    checks = []
    def check(name, ok, hint=''):
        checks.append({'check': name, 'ok': bool(ok), **({'hint': hint} if not ok and hint else {})})
    check('service running', run(['systemctl', '--user', 'is-active', SERVICE], check=False).stdout.strip() == 'active',
          'agent-bar install' if shutil.which('systemctl') else 'needs a systemd user session')
    try: snapshot_age = time.time() - json.loads((ROOT / 'snapshot.json').read_text())['updated']
    except (OSError, ValueError, KeyError): snapshot_age = None
    check('service updating', snapshot_age is not None and snapshot_age < 20, f'journalctl --user -u {SERVICE}')
    for provider in providers():
        found = hooks.installed(provider)
        check(f'{provider} hooks', found and all(found.values()), 'agent-bar install')
    missing = [str(folder / skill.name) for folder in skill_folders() for skill in SKILLS.iterdir() if not (folder / skill.name / 'SKILL.md').exists()]
    check('agent skills', not missing, f'agent-bar install (missing: {", ".join(missing)})')
    if shutil.which('code'):
        listed = run(['code', '--list-extensions'], check=False).stdout.lower().split()
        check('VS Code bridge', bridge.ID in listed, 'agent-bar install')
    if shutil.which('gnome-shell'):
        version = run(['gnome-shell', '--version'], check=False).stdout.split()[-1:]
        check('GNOME Shell version supported', version and version[0].split('.')[0] in GNOME,
              f'the extension supports GNOME {", ".join(GNOME)} so far')
        state = run(['gnome-extensions', 'info', UUID], check=False).stdout
        check('GNOME extension enabled', 'State: ENABLED' in state, 'agent-bar install, then log out and in')
    check('agent-bar on PATH', shutil.which('agent-bar'), 'install with pipx (or uv tool) so ~/.local/bin/agent-bar exists')
    return {'ok': all(c['ok'] for c in checks), 'checks': checks}
