import unittest
from unittest.mock import AsyncMock

from agent_bar.codex_wake import RpcError, prioritize


def page(*ids, cursor=None):
    return {'data': [{'id': item} for item in ids], 'nextCursor': cursor}


class WakePriorityTests(unittest.IsolatedAsyncioTestCase):
    async def test_paginated_queue_changes_between_list_and_reorder(self):
        request = AsyncMock(side_effect=[
            page('first', cursor='next'), page('second', 'wake'), RpcError(),
            page('second', 'wake', 'new'), {},
        ])
        delivery = await prioritize(request, 'thread', 'wake')
        self.assertIn('ahead', delivery)
        self.assertEqual(request.await_args_list[1].args[1]['cursor'], 'next')
        reorders = [call.args[1]['queuedSubmissionIds'] for call in request.await_args_list
                    if call.args[0] == 'thread/queue/reorder']
        self.assertEqual(reorders, [['wake', 'first', 'second'], ['wake', 'second', 'new']])

    async def test_started_notification_is_never_requeued(self):
        request = AsyncMock(side_effect=[page('first', 'wake'), RpcError(), page('first')])
        await prioritize(request, 'thread', 'wake')
        self.assertEqual([call.args[0] for call in request.await_args_list],
                         ['thread/queue/list', 'thread/queue/reorder', 'thread/queue/list'])

    async def test_repeated_reorder_rejection_stops_after_one_retry(self):
        request = AsyncMock(side_effect=[page('first', 'wake'), RpcError()] * 2)
        with self.assertRaises(RpcError):
            await prioritize(request, 'thread', 'wake')
        self.assertEqual(request.await_count, 4)
