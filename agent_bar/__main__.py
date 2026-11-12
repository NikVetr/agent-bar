import argparse
import asyncio
import json
import os
import socket
import sqlite3
import sys

from .state import ROOT


def main():
    os.umask(0o077)  # Messages and state are the user's alone.
    parser = argparse.ArgumentParser(prog='agent-bar', description='Tracks open AI agent chats for the desktop top bar (JSON output)')
    subs = parser.add_subparsers(dest='command', required=True)
    for name in ['serve', 'status', 'queues', 'git']:
        subs.add_parser(name)
    nav = subs.add_parser('navigate')
    nav.add_argument('key'); nav.add_argument('window')
    nav.add_argument('--input', action='store_true', help="also put the cursor in a Claude chat's input box")
    go = subs.add_parser('continue', help='have an open VS Code chat a usage limit stopped go on')
    go.add_argument('key')
    ack = subs.add_parser('ack')
    ack.add_argument('key'); ack.add_argument('cutoff', type=float)
    save = subs.add_parser('save-return')
    save.add_argument('window'); save.add_argument('record')
    clear = subs.add_parser('clear-return')
    clear.add_argument('window')
    seen = subs.add_parser('clear-queues', help="mark a project's finished queues seen, as a turn there would")
    seen.add_argument('project')
    scm = subs.add_parser('show-scm', help="show a VS Code window's Source Control view")
    scm.add_argument('window')
    subs.add_parser('install', help='set up the service, provider hooks, VS Code bridge and GNOME extension')
    remove = subs.add_parser('uninstall', help='take all of that out again')
    remove.add_argument('--purge', action='store_true', help='also delete history, messages and settings')
    subs.add_parser('doctor', help='check each part and say how to fix what is missing (JSON)')
    subs.add_parser('inventory', help='rescan saved conversations into inventory.json')
    subs.add_parser('info', help='skills, Agent Bar health and instruction files (JSON)')
    subs.add_parser('usage', help='usage limits Claude Code and Codex recorded, with pace, run-out time and use by day (JSON)')
    resume = subs.add_parser('resume', help='reopen an inventoried conversation in VS Code')
    resume.add_argument('key')
    subs.add_parser('agents', help='open conversations a message can go to')
    send = subs.add_parser('send', help='message one open conversation; text from the argument or stdin')
    send.add_argument('to', help='recipient key, e.g. claude:<id> or codex:<id> (see agents)')
    send.add_argument('text', nargs='?')
    send.add_argument('--as', dest='sender', help='sender key when not run from a Claude Code or Codex tool')
    send.add_argument('--urgent', action='store_true', help='may reach a Claude chat during its turn, if the user allows')
    box = subs.add_parser('inbox', help="this conversation's unread messages, marked read")
    box.add_argument('--as', dest='sender')
    box.add_argument('--peek', action='store_true', help='leave them unread')
    reset = subs.add_parser('reset-limit', help='let two conversations exchange another round of messages')
    reset.add_argument('first'); reset.add_argument('second')
    args = vars(parser.parse_args())
    name = args.pop('command')
    if name in ['agents', 'send', 'inbox', 'reset-limit']:
        from . import messages
        try:
            if name == 'agents': result = {'ok': True, 'agents': messages.agents()}
            elif name == 'send':
                result = messages.send(messages.caller(args['sender']), args['to'],
                                       args['text'] if args['text'] is not None else sys.stdin.read(), urgent=args['urgent'])
            elif name == 'reset-limit':
                # The loop guard is the user's to lift. Agents' tools name their session; the panel's command does not.
                if os.environ.get('CLAUDE_CODE_SESSION_ID') or os.environ.get('CODEX_THREAD_ID'):
                    raise ValueError("Only the user resets the loop guard, from Agent Bar's Messages tab")
                result = messages.reset_limit(args['first'], args['second'])
            else: result = messages.inbox(messages.caller(args['sender']), peek=args['peek'])
        except (OSError, ValueError, KeyError, sqlite3.Error) as error: result = {'ok': False, 'error': str(error)}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result['ok'] else 1)
    if name == 'serve':
        from .service import Tracker
        asyncio.run(Tracker().run())
        return
    if name in ['install', 'uninstall']:
        from . import install
        install.install() if name == 'install' else install.uninstall(args['purge'])
        return
    if name == 'doctor':
        from . import install
        result = install.doctor()
        print(json.dumps(result, indent=1))
        sys.exit(0 if result['ok'] else 1)
    if name == 'info':
        from . import info
        print(json.dumps(info.collect(), ensure_ascii=False))
        return
    if name == 'usage':
        from . import usage
        print(json.dumps(usage.report(), ensure_ascii=False))
        return
    if name in ['inventory', 'resume']:
        from . import inventory
        try: result = inventory.refresh() if name == 'inventory' else inventory.resume(args['key'])
        except (OSError, ValueError, sqlite3.Error) as error: result = {'ok': False, 'error': str(error)}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result['ok'] else 1)
    command = {'op': 'snapshot' if name in ['status', 'queues', 'git'] else name, **args}
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(12)
            client.connect(str(ROOT / 'service.sock'))
            client.sendall((json.dumps(command) + '\n').encode())
            with client.makefile('r') as stream:
                result = json.loads(stream.readline())
        if name in ['queues', 'git'] and result.get('ok') is not False: result = result[name]
    except (OSError, ValueError) as error:
        result = {'ok': False, 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False))
    if isinstance(result, dict) and result.get('ok') is False:
        sys.exit(1)


if __name__ == '__main__': main()
