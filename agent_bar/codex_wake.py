"""Place an inbox notification ahead of pending VS Code prompts using the Codex queue API."""
import asyncio
import json
import shutil
import uuid


class QueueUnavailable(Exception):
    """No submission was made. The caller can use the older queue command."""


class RpcError(Exception):
    """The app server explicitly rejected a request."""


async def prioritize(request, thread, submission):
    """Reorder by ID only. Codex requires every currently queued ID exactly once."""
    retried = False
    while True:
        ids = []
        params = {'threadId': thread, 'limit': 16}
        while True:
            page = await request('thread/queue/list', params)
            ids.extend(item['id'] for item in page['data'])
            if not page.get('nextCursor'):
                break
            params = {**params, 'cursor': page['nextCursor']}
        if submission not in ids or ids == [submission]:
            return 'by a queued wake-up turn'
        if ids[0] != submission:
            try:
                await request('thread/queue/reorder', {
                    'threadId': thread,
                    'queuedSubmissionIds': [submission, *(item for item in ids if item != submission)],
                })
            except RpcError:
                if retried: raise
                retried = True
                continue  # A draft may have been added, started, or removed. Read the order again.
        return 'by a wake-up ahead of the queued prompts'


async def queue_wake(thread, text, busy):
    """Return a delivery description, or None to defer a busy chat with an empty queue."""
    codex = shutil.which('codex')
    if not codex:
        raise QueueUnavailable()
    try:
        server = await asyncio.create_subprocess_exec(
            codex, 'app-server', '--listen', 'stdio://', stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=16 * 1024 * 1024)
    except OSError as error:
        raise QueueUnavailable() from error
    serial = 0
    adding = False
    added = False

    async def request(method, params):
        nonlocal serial
        serial += 1
        assert server.stdin and server.stdout
        server.stdin.write(json.dumps({'id': serial, 'method': method, 'params': params}).encode() + b'\n')
        await server.stdin.drain()
        while line := await server.stdout.readline():
            reply = json.loads(line)
            if reply.get('id') == serial and 'method' not in reply:
                if 'error' in reply:
                    raise RpcError()
                return reply['result']
        raise EOFError()

    async def submit():
        nonlocal adding, added
        await request('initialize', {'clientInfo': {'name': 'agent_bar', 'version': '1'},
                                     'capabilities': {'experimentalApi': True}})
        # Probe even for an idle chat so old clients can fall back before attempting a write.
        first = await request('thread/queue/list', {'threadId': thread, 'limit': 1})
        if busy and not first['data']:
            return None
        adding = True
        try:
            result = await request('thread/queue/add', {
                'threadId': thread, 'clientUserMessageId': str(uuid.uuid4()),
                'input': [{'type': 'text', 'text': text, 'text_elements': []}],
            })
        except RpcError:
            adding = False
            raise
        added = True
        return await prioritize(request, thread, result['queuedSubmission']['id'])

    try:
        return await asyncio.wait_for(submit(), timeout=8)
    except (RpcError, EOFError, OSError, asyncio.TimeoutError, KeyError, ValueError, TypeError) as error:
        if added:
            return 'by a queued wake-up turn (queue priority could not be confirmed)'
        if adding:
            return 'at its next turn (Codex did not confirm the wake-up)'
        raise QueueUnavailable() from error
    finally:
        try:
            await asyncio.wait_for(server.communicate(), timeout=1)
        except asyncio.TimeoutError:
            if server.returncode is None:
                try: server.kill()
                except ProcessLookupError: pass
            await server.communicate()
