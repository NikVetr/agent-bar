"""One cluster node as the scheduler reports it: projects and queues holding its job slots, its state, and recent
events there, from the Rota collector's snapshot, the scheduler's per-host reservation report and Rota's event logs."""
import csv
import json
import time
from pathlib import Path

ROTA = Path.home() / '.local/state/rota'
EVENT_WINDOW = 24 * 3600  # How far back a node's failures, holds and outages are listed.
MEMORY_WINDOW = 3600  # How old the last memory-pressure sample may be and still be listed.
TAIL = 512 * 1024  # The end of each event log that is read; both are appended in time order.
HOLD_REASONS = {'rapid_job_failures': 'jobs failed in quick succession', 'infrastructure_failed': 'an infrastructure failure'}


def node(host_id, snapshot=None, rota=None, now=None):
    """The node's job slots by project and by queue, its state and its recent events. Allocations the scheduler cannot
    report now (the node unavailable, its report stale) leave `allocations_error`; the state and events remain."""
    rota = Path(rota or ROTA)
    if snapshot is None:
        snapshot = json.loads((rota / 'cluster-status.json').read_text())
    now = now or time.time()
    hosts = {host['id']: host for host in snapshot['hosts']}
    if host_id not in hosts or Path(host_id).name != host_id or host_id in ('.', '..'):
        raise ValueError('Unknown cluster host')
    if now - snapshot['updated'] > 60:
        raise ValueError('The cluster snapshot is stale')
    host = hosts[host_id]
    scheduler = snapshot.get('scheduler') or {}
    budget = next((h['cpu_units'] for h in scheduler.get('hosts', []) if h['id'] == host_id and h.get('cpu_units') is not None),
                  host.get('slots'))
    result = {'ok': True, 'host': host_id, 'updated': snapshot['updated'], 'cpu_slots': budget,
              'memory_bytes': (host.get('memory') or {}).get('total_bytes'), 'projects': [], 'queues': [],
              'incomplete_fixed_slots': False}
    daemon = None
    try:
        daemon, queues, incomplete = allocations(snapshot, host_id, now)
        result.update(queues=queues, incomplete_fixed_slots=incomplete, projects=by_project(queues))
    except (OSError, ValueError, KeyError) as error:
        result['allocations_error'] = str(error)
    result['state'] = node_state(snapshot, host_id, daemon)
    result['events'] = node_events(rota, host_id, now)
    return result


def allocations(snapshot, host_id, now):
    """The node's daemon row and the queues holding its slots, each with its jobs, CPU slots and sampled memory here."""
    scheduler = snapshot.get('scheduler') or {}
    pool = scheduler.get('pool') or {}
    if not scheduler.get('ok'):
        raise ValueError('No current adaptive scheduler snapshot')
    hosts = {host['id']: host for host in snapshot['hosts']}
    if not hosts[host_id].get('ok') or host_id in (pool.get('unavailable_hosts') or {}):
        raise ValueError('The scheduler has no current report from this node')
    queues, daemon = {}, None
    if pool.get('id'):
        daemon = read_reservations(snapshot, host_id, pool, queues, now)
    elif pool.get('state') != 'INACTIVE':
        raise ValueError('No current scheduler pool')
    # Fixed worker pools publish slot counts in host order, without per-job memory samples.
    fixed = [q for q in snapshot.get('queues', []) if q['group'] == 'active' and not q.get('control_id')
             and q.get('priority') is None and q.get('workers') is not None]
    incomplete = False
    index = list(hosts).index(host_id)
    refresh = snapshot.get('queue_refresh') or {}
    for queue in fixed:
        vector = queue['workers'].split('-')
        if (queue.get('state') == 'UNKNOWN' or not refresh.get('ok') or now - (refresh.get('updated') or 0) > 120
                or len(vector) != len(hosts) or not vector[index].isdigit()):
            incomplete = True
            continue
        if int(vector[index]):
            entry = queues.setdefault(queue['id'], {'queue_id': queue['id'], 'jobs': 0, 'cpu_slots': 0, 'memory_mib': None})
            entry['fixed_slots'] = entry.get('fixed_slots', 0) + int(vector[index])
            entry['cpu_slots'] += int(vector[index])
            entry['memory_mib'] = None
    return daemon, [describe(entry, snapshot) for entry in sorted(queues.values(), key=lambda q: -q['cpu_slots'])], incomplete


def read_reservations(snapshot, host_id, pool, queues, now):
    local = next((h for h in snapshot['hosts'] if h['id'] == snapshot['collector'].get('local_host')), {})
    mount = local.get('mount') or {}
    if not mount.get('ok') or not mount.get('root'):
        raise ValueError('The scheduler share is unavailable on this computer')
    table = Path(mount['root']) / '.rota/adaptive/last-known' / f'{host_id}.tsv'
    with table.open() as stream:
        rows = csv.DictReader(stream, delimiter='\t')
        # The host daemon's own row comes first, then one row per reservation.
        daemon = next(rows, None)
        if not daemon or (daemon.get('record_type'), daemon.get('pool_id'), daemon.get('host_id')) != ('daemon', pool['id'], host_id):
            raise ValueError('The node report does not match the current pool')
        updated = int(daemon.get('resource_sample_epoch') or 0)
        if not updated or abs(now - updated) > 60:
            raise ValueError('The node report is stale')
        for row in rows:
            if row['record_type'] != 'reservation':
                continue
            if row['pool_id'] != pool['id'] or row['host_id'] != host_id:
                raise ValueError('Mixed pool or host in the reservation report')
            entry = queues.setdefault(row['queue_id'], {'queue_id': row['queue_id'], 'jobs': 0, 'cpu_slots': 0, 'memory_mib': 0})
            entry['jobs'] += 1
            entry['cpu_slots'] += int(row['cpu_units'])
            memory = row.get('current_memory_mib')
            if daemon.get('telemetry_state') != 'ok' or row['state'] != 'running' or not memory or int(memory) < 0:
                entry['memory_mib'] = None
            elif entry['memory_mib'] is not None:
                entry['memory_mib'] += int(memory)
    return daemon


def describe(entry, snapshot):
    """A queue's use of the node with what the scheduler and the queue snapshot say of it: its project and name, when
    it started, its progress, and its workers across the pool."""
    scheduled = next((q for q in (snapshot.get('scheduler') or {}).get('queues', []) if q['queue_id'] == entry['queue_id']), {})
    tag = scheduled.get('tag') or entry['queue_id']
    progress = next((q for q in snapshot.get('queues', []) if q['id'] == tag), {})
    return {**entry, 'id': tag, 'project': scheduled.get('project') or progress.get('project'),
            'label': progress.get('label') or scheduled.get('run_name') or entry['queue_id'],
            'state': progress.get('state') or scheduled.get('lifecycle'),
            **{key: progress.get(key) for key in ['started', 'done', 'total', 'pct', 'eta', 'failed']},
            'workers': scheduled.get('running_workers', progress.get('running'))}


def by_project(queues):
    projects = {}
    for queue in queues:
        name = queue['project'] or f"Unknown project ({queue['queue_id']})"
        entry = projects.setdefault(name, {'project': name, 'jobs': 0, 'cpu_slots': 0, 'memory_mib': 0})
        entry['jobs'] += queue['jobs']
        entry['cpu_slots'] += queue['cpu_slots']
        if 'fixed_slots' in queue: entry['fixed_slots'] = entry.get('fixed_slots', 0) + queue['fixed_slots']
        entry['memory_mib'] = None if entry['memory_mib'] is None or queue['memory_mib'] is None else entry['memory_mib'] + queue['memory_mib']
    return sorted(projects.values(), key=lambda p: (-p['cpu_slots'], p['project']))


def node_state(snapshot, host_id, daemon):
    """What the scheduler and the collector say of the node now: why it is unavailable, its owner's activity, its
    budget against its base, an away window, and its shared-drive mount."""
    scheduler = snapshot.get('scheduler') or {}
    host = next(h for h in snapshot['hosts'] if h['id'] == host_id)
    planned = next((h for h in scheduler.get('hosts', []) if h['id'] == host_id), {})
    mount = host.get('mount') or {}
    return {'reachable': bool(host.get('ok')), 'error': host.get('error'),
            'unavailable': ((scheduler.get('pool') or {}).get('unavailable_hosts') or {}).get(host_id),
            'enabled': planned.get('enabled'), 'admission': (daemon or {}).get('admission') or None,
            'owner': (daemon or {}).get('owner_state') or None, 'owner_policy': planned.get('owner_active'),
            'cpu_units': planned.get('cpu_units'), 'base_cpu_units': planned.get('base_cpu_units'),
            'memory_mib': planned.get('memory_mib'), 'base_memory_mib': planned.get('base_memory_mib'),
            'gpu_units': planned.get('gpu_units'), 'away': planned.get('away') or host.get('away'),
            'away_window': planned.get('away_window'), 'load': host.get('load'),
            'swap_bytes': (host.get('memory') or {}).get('swap_used_bytes'),
            'mount': {'state': mount.get('state'), 'since': mount.get('since'), 'error': mount.get('error')} if mount else None}


def tail_records(path, now, window):
    """The JSON lines of an append-only log from the last `window` seconds, read from its end."""
    try:
        with path.open('rb') as stream:
            stream.seek(0, 2)
            size = stream.tell()
            stream.seek(max(0, size - TAIL))
            lines = stream.read().splitlines()[1 if size > TAIL else 0:]
    except FileNotFoundError:
        return []
    records = []
    for line in lines:
        try: record = json.loads(line)
        except ValueError: continue
        if now - (record.get('at') or record.get('time') or 0) <= window: records.append(record)
    return records


def node_events(rota, host_id, now):
    """The node's job failures, holds and outages of the last day, newest first, and its latest memory-pressure sample
    of the last hour (written while its swap is high) with the processes holding the most memory."""
    events, outages = [], {}
    for record in tail_records(rota / 'events.jsonl', now, EVENT_WINDOW):
        name = record.get('run_name') or record.get('project') or record.get('queue_id')
        jobs = [job for job in record.get('jobs') or [] if job.get('host_id') == host_id]
        if jobs:
            events.append({'at': record['at'], 'kind': 'failures', 'queue': name, 'project': record.get('project'),
                           'jobs': len(jobs), 'outage': sum(job.get('kind') == 'outage' for job in jobs),
                           'logs': [job['log'] for job in jobs if job.get('log')][:3]})
        for hold in record.get('holds') or []:
            if hold.get('host_id') == host_id:
                events.append({'at': record['at'], 'kind': 'hold', 'queue': name, 'project': record.get('project'),
                               'reason': HOLD_REASONS.get(hold.get('reason'), hold.get('reason')), 'reset_command': hold.get('reset_command')})
        for outage in record.get('outages') or []:
            if outage.get('host_id') == host_id and outage.get('started'):
                outages[outage['started']] = {'at': outage.get('ended') or record['at'], 'kind': 'outage',
                                              'started': outage['started'], 'ended': outage.get('ended')}
    events.extend(outages.values())
    memory = [record for record in tail_records(rota / 'memory-events.jsonl', now, MEMORY_WINDOW)
              if record.get('host') == host_id and not record.get('error')]
    if memory:
        last = memory[-1]
        events.append({'at': last['time'], 'kind': 'memory', 'swap_bytes': last.get('swap_used_bytes'), 'used_pct': last.get('used_pct'),
                       'processes': [{'command': p['command'], 'bytes': p['bytes']} for p in (last.get('processes') or [])[:5]]})
    return sorted(events, key=lambda event: -event['at'])
