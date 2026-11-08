"""Provider hook: a metadata-only lifecycle observer (`python -m agent_bar.hook [codex]`). Its only output is a note
about unread agent messages: at a turn start, and, run as `python -m agent_bar.hook wait` from a background
(asyncRewake) Claude Stop hook with waking on, by exiting 2 to wake an idle Claude chat once per new message.
It never blocks, approves or continues a turn."""
import json
import os
import sys
import time
import uuid
import re
from pathlib import Path

WAIT = 7200 - 60  # Inside the installed hook's two-hour timeout.


def state():
    return Path(os.environ.get('AGENT_BAR_STATE_DIR', str(Path.home() / '.local/state/agent-bar')))


def record(item):
    """Hand one lifecycle event to the tracker service."""
    root = state() / 'events'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    filename = root / (str(uuid.uuid4()) + '.json')
    temporary = filename.with_suffix('.next')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(item, stream)
    temporary.replace(filename)


def headless():
    """Whether this hook runs for a non-interactive Claude Code session (print mode or the Agent SDK). Such a
    session waits for its background hooks before it exits, so a waiter would hold it open for two hours."""
    if os.environ.get('CLAUDE_CODE_ENTRYPOINT', '').startswith('sdk'): return True
    pid = os.getppid()
    try:
        # The hook's shell, then Claude Code itself.
        for _ in range(3):
            if {b'-p', b'--print'} & set(Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')): return True
            pid = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return False


def wait(data, every=3):
    """Watch for a message to this idle chat after its turn ended; wake it once for each new one."""
    from agent_bar import messages
    if not data.get('session_id') or data.get('agent_id') or not messages.waking() or headless(): return
    key, root, parent = f'claude:{data["session_id"]}', state(), os.getppid()
    latest, woken, waiter, urgent = messages.wake_files(key, root)
    waiter.write_text(str(os.getpid()))
    deadline = time.time() + WAIT
    # A newer turn's waiter takes over; a closed session leaves this one orphaned.
    while time.time() < deadline and os.getppid() == parent and waiter.read_text() == str(os.getpid()):
        # A chat still in its turn (this waiter was started by an earlier one) may have to wait for its end,
        # when the next turn's waiter delivers the message at once.
        allowed = messages.midturn(key, root) if messages.number(latest) > messages.number(woken) else 'none'
        target = {'all': messages.number(latest), 'urgent': messages.number(urgent)}.get(allowed, 0)
        if target > messages.number(woken) and messages.waking():
            woken.write_text(str(messages.number(latest)))
            note = messages.notice(key, root)
            if note:
                # The wake is an automatic turn; without its start its reply looks like the last turn's again.
                now = time.time()
                record({'provider': 'claude', 'session': data['session_id'], 'kind': 'start', 'at': now,
                        'turn': f'wake:{now}', 'cwd': data.get('cwd'), 'transcript': data.get('transcript_path')})
                print(note, file=sys.stderr)
                sys.exit(2)
        time.sleep(every)


def main():
    data = json.load(sys.stdin)
    if sys.argv[1:] == ['wait']:
        wait(data)
        return
    provider = sys.argv[1] if len(sys.argv) > 1 else 'claude'
    if provider not in ['claude', 'codex']: raise ValueError('Unknown provider')
    event = data.get('hook_event_name')
    kinds = {'UserPromptSubmit': 'message', 'Stop': 'complete', 'StopFailure': 'failure',
             'PermissionRequest': 'approval', 'Elicitation': 'question',
             'ElicitationResult': 'resume', 'PostToolUse': 'resume', 'SessionEnd': 'interrupted',
             'Interrupt': 'interrupted'}
    kind = kinds.get(event)
    if event == 'UserPromptSubmit' and re.search(
            r'<(?:task-notification|subagent_notification|system-reminder|agent-notification|agent-message)\b'
            r'|^Continue from where you left off\.$', data.get('prompt', '')):
        kind = 'start'  # An automatic continuation is not a human acknowledgment.
    asks = data.get('tool_name') == 'AskUserQuestion' or 'request_user_input' in data.get('tool_name', '')
    # Claude Code also reports a question as a permission request; it is still only a question.
    if event in ['PreToolUse', 'PermissionRequest'] and asks:
        kind = 'question'
    if event == 'PostToolUse' and asks:
        kind = 'message'  # The user answered it, which acknowledges it like a prompt.
    if not kind or not data.get('session_id') or data.get('agent_id'):
        return
    state_root = state()
    record({'provider': provider, 'session': data['session_id'], 'kind': kind,
            'at': time.time(), 'turn': data.get('turn_id'), 'cwd': data.get('cwd'),
            'transcript': data.get('transcript_path')})
    # A turn the waiter woke, or a queued Codex note started, already carries the note.
    if event == 'UserPromptSubmit' and '[agent-bar]' in data.get('prompt', ''):
        from agent_bar import messages
        messages.queued_file(f'{provider}:{data["session_id"]}', state_root).unlink(missing_ok=True)
    elif event == 'UserPromptSubmit':
        from agent_bar import messages
        key = f'{provider}:{data["session_id"]}'
        note = messages.notice(key, state_root)
        if note:
            # Told now, so the background waiter does not wake it again for the same messages.
            latest, woken = messages.wake_files(key, state_root)[:2]
            woken.write_text(str(max(messages.number(latest), messages.number(woken))))
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': note}}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # An observer failure must not block a user's conversation. Log locally;
        # never return blocking exit code 2 or provider decision JSON.
        try:
            root = state()
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            with (root / 'hook-errors.log').open('a') as stream:
                stream.write(f'{time.time()}: {type(error).__name__}: {error}\n')
        except OSError:
            pass
