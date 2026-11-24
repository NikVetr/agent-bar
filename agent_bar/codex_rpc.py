"""Short-lived local Codex app-server connection shared by queue and hook readers."""
import asyncio
import json
import shutil
from contextlib import asynccontextmanager


class RpcError(Exception):
    """The app server explicitly rejected a request."""


@asynccontextmanager
async def app_server():
    codex = shutil.which('codex')
    if not codex:
        raise FileNotFoundError('Codex CLI not found')
    server = await asyncio.create_subprocess_exec(
        codex, 'app-server', '--listen', 'stdio://', stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=16 * 1024 * 1024)
    serial = 0

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
                    raise RpcError(reply['error'].get('message', 'Codex rejected the request'))
                return reply['result']
        raise EOFError()

    try:
        await request('initialize', {'clientInfo': {'name': 'agent_bar', 'version': '1'},
                                     'capabilities': {'experimentalApi': True}})
        yield request
    finally:
        try:
            await asyncio.wait_for(server.communicate(), timeout=1)
        except (asyncio.TimeoutError, asyncio.CancelledError) as error:
            if server.returncode is None:
                try: server.kill()
                except ProcessLookupError: pass
            await server.communicate()
            if isinstance(error, asyncio.CancelledError): raise
