"""Place an inbox notification ahead of pending VS Code prompts using the Codex queue API."""
import asyncio
import uuid

from .codex_rpc import RpcError, app_server


class QueueUnavailable(Exception):
    """No submission was made. The caller can use the older queue command."""


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
    adding = False
    added = False

    async def submit():
        nonlocal adding, added
        async with app_server() as request:
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
