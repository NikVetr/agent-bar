import argparse
import asyncio
import json
import os
import socket
import sqlite3
import sys

from .state import ROOT, agent_ancestor


def main():
    os.umask(0o077)  # Messages and state are the user's alone.
    parser = argparse.ArgumentParser(prog='agent-bar', description='Tracks open AI agent chats for the desktop top bar (JSON output)')
    subs = parser.add_subparsers(dest='command', required=True)
    for name in ['serve', 'status', 'queues', 'git']:
        subs.add_parser(name)
    workflows = subs.add_parser('queue-dependencies', help='numbered prerequisite queues and their reported outcomes')
    workflows.add_argument('numbers', type=int, nargs='*', help='active queue numbers within each selected project')
    workflows.add_argument('--project', help='limit to one queue project')
    workflows.add_argument('--ids', nargs='+', help='limit to these monitor queue IDs')
    hosts = subs.add_parser('host-projects', help='jobs, reserved CPU slots and sampled memory by project on a node')
    hosts.add_argument('host')
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
    search = subs.add_parser('search-history', help='search saved user and assistant messages for keywords (JSON)')
    search.add_argument('query')
    search.add_argument('--repo', help='project name or full folder path')
    search.add_argument('--conversation', help='show context for a hit in this saved conversation')
    search.add_argument('--message', type=int, default=1, help='matching message number, newest first')
    search.add_argument('--hit', type=int, help='occurrence in the message (1-based, or -1 for the last)')
    info = subs.add_parser('info', help='skills, hooks, Agent Bar health and instruction files (JSON)')
    info.add_argument('--project', help='inspect hooks for this folder (default: user scope)')
    subs.add_parser('usage', help='usage limits Claude Code and Codex recorded, with pace, run-out time and use by day (JSON)')
    subs.add_parser('cost', help='what recorded use would cost at API prices: by day, by model, and per chat (JSON)')
    export = subs.add_parser('export', help="write a saved conversation's messages to Markdown or HTML (JSON result)")
    export.add_argument('key', help='conversation key, e.g. claude:<id> or codex:<id>')
    export.add_argument('--format', choices=['markdown', 'html'], default='markdown')
    export.add_argument('--output', help='a .md or .html file to write, or a folder for a generated name (default: your Downloads folder)')
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
    ticket = subs.add_parser('ticket', help='tasks to do later, each in a project, that can wait for a limit reset, queues, a time or another ticket')
    actions = ticket.add_subparsers(dest='action', required=True)
    new = actions.add_parser('add', help='write a ticket; text from the argument or stdin')
    new.add_argument('text', nargs='?')
    new.add_argument('--project', help="its project folder (default: the writing chat's folder, or the current one)")
    new.add_argument('--after', action='append', default=[], metavar='WAIT',
                     help='wait for reset:<claude|codex>[:<limit>], queues (the project\'s outstanding ones), queue:<id>, '
                          'date:<YYYY-MM-DD[ HH:MM]>, date:+<N>h|d, or ticket:<number>; repeat to wait for several')
    new.add_argument('--to', metavar='KEY', help='once ready, send it as a message to this open chat (see agents), then close it')
    new.add_argument('--repeat', metavar='EVERY', help='with --to and a date wait: send it again every day, week, month, or <N>h|d|w')
    new.add_argument('--as', dest='sender', help='author when not run from a Claude Code or Codex tool (default: user)')
    actions.add_parser('list', help='open tickets with what each waits for, then recently closed ones')
    begin = actions.add_parser('start', help="open a new Claude Code chat in the ticket's folder with its prompt, unsent")
    begin.add_argument('number', type=int)
    for action, words in [('take', 'mark a ticket started by this chat'), ('done', 'close a ticket as done'),
                          ('drop', 'close a ticket without doing it'), ('reopen', 'open a closed or started ticket again')]:
        one = actions.add_parser(action, help=words)
        one.add_argument('number', type=int)
        if action in ['done', 'drop']: one.add_argument('--note', help='one line on the outcome')
        one.add_argument('--as', dest='sender')
    args = vars(parser.parse_args())
    name = args.pop('command')
    if name == 'host-projects':
        from .cluster import host_projects
        try: result = host_projects(args['host'])
        except (OSError, ValueError, KeyError, TypeError) as error: result = {'ok': False, 'error': str(error)}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result['ok'] else 1)
    if name in ['agents', 'send', 'inbox', 'reset-limit']:
        from . import messages
        try:
            if name == 'agents': result = {'ok': True, 'agents': messages.agents()}
            elif name == 'send':
                result = messages.send(messages.caller(args['sender']), args['to'],
                                       args['text'] if args['text'] is not None else sys.stdin.read(), urgent=args['urgent'])
            elif name == 'reset-limit':
                # The loop guard is the user's to lift. Agents' tools name their session; the panel's command does not.
                if os.environ.get('CLAUDE_CODE_SESSION_ID') or os.environ.get('CODEX_THREAD_ID') or agent_ancestor():
                    raise ValueError("Only the user resets the loop guard, from Agent Bar's Messages tab")
                result = messages.reset_limit(args['first'], args['second'])
            else: result = messages.inbox(messages.caller(args['sender']), peek=args['peek'])
        except (OSError, ValueError, KeyError, sqlite3.Error) as error: result = {'ok': False, 'error': str(error)}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result['ok'] else 1)
    if name == 'ticket':
        from . import tickets
        action = args['action']
        try:
            if action == 'add':
                result = tickets.add(args['text'] if args['text'] is not None else sys.stdin.read(), args['project'], args['after'],
                                     args['sender'], to=args['to'], repeat=args['repeat'])
            elif action == 'list': result = tickets.listing()
            elif action == 'start': result = tickets.start(args['number'])
            else:
                status = {'take': 'started', 'done': 'done', 'drop': 'dropped', 'reopen': 'open'}[action]
                result = tickets.change(args['number'], status, args.get('note'), args['sender'])
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
        print(json.dumps(info.collect(project=args['project']), ensure_ascii=False))
        return
    if name == 'usage':
        from . import usage
        print(json.dumps(usage.report(), ensure_ascii=False))
        return
    if name == 'cost':
        from . import costs
        try: result = costs.report()
        except ValueError as error: result = {'ok': False, 'error': str(error)}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result['ok'] else 1)
    if name in ['inventory', 'resume']:
        from . import inventory
        try: result = inventory.refresh() if name == 'inventory' else inventory.resume(args['key'])
        except (OSError, ValueError, sqlite3.Error) as error: result = {'ok': False, 'error': str(error)}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result['ok'] else 1)
    if name == 'export':
        from .export import export
        try: result = export(args['key'], args['format'], args['output'])
        except (OSError, ValueError, sqlite3.Error) as error: result = {'ok': False, 'error': str(error)}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result['ok'] else 1)
    if name == 'search-history':
        from .history_search import search
        try: result = search(args['query'], args['repo'], conversation=args['conversation'], message=args['message'], hit=args['hit'])
        except (OSError, ValueError, sqlite3.Error) as error: result = {'ok': False, 'error': str(error)}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result['ok'] else 1)
    command = {'op': 'snapshot' if name in ['status', 'queues', 'git'] else name, **args}
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(60 if name == 'queue-dependencies' else 12)
            client.connect(str(ROOT / 'service.sock'))
            client.sendall((json.dumps(command, ensure_ascii=False, separators=(',', ':')) + '\n').encode())
            with client.makefile('r') as stream:
                result = json.loads(stream.readline())
        if name in ['queues', 'git'] and result.get('ok') is not False: result = result[name]
    except (OSError, ValueError) as error:
        result = {'ok': False, 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False))
    if isinstance(result, dict) and result.get('ok') is False:
        sys.exit(1)


if __name__ == '__main__': main()
