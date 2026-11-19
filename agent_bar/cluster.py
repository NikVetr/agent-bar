"""Project allocations from the scheduler's per-host reservation report."""
import csv
import json
import time
from pathlib import Path


def host_projects(host_id, snapshot=None):
    if snapshot is None:
        snapshot = json.loads((Path.home() / '.local/state/parallel-workers/cluster-status.json').read_text())
    hosts = {host['id']: host for host in snapshot['hosts']}
    if host_id not in hosts or Path(host_id).name != host_id or host_id in ('.', '..'):
        raise ValueError('Unknown cluster host')
    host = hosts[host_id]
    scheduler = snapshot.get('scheduler') or {}
    pool = scheduler.get('pool') or {}
    if time.time() - snapshot['updated'] > 60:
        raise ValueError('The cluster snapshot is stale')
    if not scheduler.get('ok'):
        raise ValueError('No current adaptive scheduler snapshot')
    if not host.get('ok') or host_id in (pool.get('unavailable_hosts') or {}):
        raise ValueError('The scheduler has no current report from this node')
    projects = {}
    updated = snapshot['updated']
    if pool.get('id'):
        updated = read_reservations(snapshot, host_id, pool, projects)
    elif pool.get('state') != 'INACTIVE':
        raise ValueError('No current scheduler pool')

    # Fixed worker pools publish slot counts in host order, without per-job memory samples.
    fixed = [q for q in snapshot.get('queues', []) if q['group'] == 'active' and not q.get('control_id')
             and q.get('priority') is None and q.get('workers') is not None]
    incomplete = False
    index = list(hosts).index(host_id)
    for queue in fixed:
        vector = queue['workers'].split('-')
        refresh = snapshot.get('queue_refresh') or {}
        if (queue.get('state') == 'UNKNOWN' or not refresh.get('ok') or time.time() - (refresh.get('updated') or 0) > 120
                or len(vector) != len(hosts) or not vector[index].isdigit()):
            incomplete = True
            continue
        slots = int(vector[index])
        if slots:
            project = queue.get('project') or f"Unknown project ({queue['id']})"
            entry = projects.setdefault(project, {'project': project, 'jobs': 0, 'cpu_slots': 0, 'memory_mib': None})
            entry['fixed_slots'] = entry.get('fixed_slots', 0) + slots
            entry['cpu_slots'] += slots
            entry['memory_mib'] = None
    budget = next((h['cpu_units'] for h in scheduler.get('hosts', []) if h['id'] == host_id and h.get('cpu_units') is not None),
                  host.get('slots'))
    return {'ok': True, 'host': host_id, 'updated': updated, 'cpu_slots': budget,
            'memory_bytes': (host.get('memory') or {}).get('total_bytes'),
            'incomplete_fixed_slots': incomplete,
            'projects': sorted(projects.values(), key=lambda p: (-p['cpu_slots'], p['project']))}


def read_reservations(snapshot, host_id, pool, projects):
    local = next((h for h in snapshot['hosts'] if h['id'] == snapshot['collector'].get('local_host')), {})
    mount = local.get('mount') or {}
    if not mount.get('ok') or not mount.get('root'):
        raise ValueError('The scheduler share is unavailable on this computer')
    table = Path(mount['root']) / '.parallel-workers/adaptive/last-known' / f'{host_id}.tsv'
    with table.open() as stream:
        rows = csv.DictReader(stream, delimiter='\t')
        agent = next(rows, None)
        if not agent or (agent.get('record_type'), agent.get('pool_id'), agent.get('host_id')) != ('agent', pool['id'], host_id):
            raise ValueError('The node report does not match the current pool')
        updated = int(agent.get('resource_sample_epoch') or 0)
        now = time.time()
        if not updated or abs(now - updated) > 60:
            raise ValueError('The node report is stale')
        names = {queue['queue_id']: queue.get('project') for queue in snapshot['scheduler']['queues']}
        for row in rows:
            if row['record_type'] != 'reservation':
                continue
            if row['pool_id'] != pool['id'] or row['host_id'] != host_id:
                raise ValueError('Mixed pool or host in the reservation report')
            project = names.get(row['queue_id']) or f"Unknown project ({row['queue_id']})"
            entry = projects.setdefault(project, {'project': project, 'jobs': 0, 'cpu_slots': 0, 'memory_mib': 0})
            entry['jobs'] += 1
            entry['cpu_slots'] += int(row['cpu_units'])
            memory = row.get('current_memory_mib')
            if agent.get('telemetry_state') != 'ok' or row['state'] != 'running' or not memory or int(memory) < 0:
                entry['memory_mib'] = None
            elif entry['memory_mib'] is not None:
                entry['memory_mib'] += int(memory)
    return updated
