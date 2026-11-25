"""Read declared adaptive queue prerequisites when the Queues tab requests them."""
import json
import os
import re
import time
from pathlib import Path


def env_file(path):
    if path.is_symlink() or not path.is_file(): raise ValueError(f'Metadata unavailable: {path}')
    values = {}
    for line in path.read_text().splitlines():
        key, sep, value = line.partition('=')
        if not sep or not key or key in values: raise ValueError(f'Invalid scheduler metadata: {path}')
        values[key] = value
    return values


def batch_path(value, root):
    path = Path(value)
    if root not in path.parents or '..' in path.parts:
        raise ValueError('Batch is outside the mounted scheduler share')
    return path


def prerequisite(ref, root):
    queue_id = ref['queue_id']
    result = {'id': queue_id, 'pool': ref['pool_id'], 'name': queue_id, 'state': 'unknown'}
    try:
        batch = batch_path(ref['batch_dir'], root)
        meta = env_file(batch / 'run_meta.env')
        if (meta.get('execution_mode'), meta.get('run_token'), meta.get('pool_id')) != (
                'adaptive-shared-queue', queue_id, ref['pool_id']):
            raise ValueError('Batch identity changed')
        result.update(tag=meta['tag_clean'], name=meta.get('run_name') or queue_id, project=meta.get('project_name', ''))
        status = env_file(batch / 'adaptive/status.env')
        if status.get('queue_id') != queue_id: raise ValueError('Queue status identity changed')
        life = status['lifecycle']
        if life in ('FINISHED_INCOMPLETE', 'FAILED', 'KILLED'):
            result.update(state='failed', detail=life)
        elif life == 'COMPLETED' and status.get('propagation') == 'complete' and (
                status.get('running_workers') == status.get('target_workers') == '0'):
            # Confirmed interruption markers move into a subdirectory, including for retired queues.
            try:
                with os.scandir(batch / 'share-interrupted') as entries:
                    verify = any(e.name.startswith('job_') and e.is_file(follow_symlinks=False) for e in entries)
            except FileNotFoundError: verify = False
            result.update(state='verify' if verify else 'complete',
                          detail='Outputs need verification' if verify else 'Completed successfully')
        else:
            result.update(state='waiting', detail='Finishing propagation' if life == 'COMPLETED' else life)
    except (OSError, KeyError, ValueError) as error:
        result['detail'] = f'Prerequisite status unavailable: {error}'
    return result


def archived_registrations(root, tracked, missing):
    """Match retired registrations by batch, launch epoch and queue fingerprint, then verify the full monitor tag."""
    wanted = {}
    for tag in missing:
        match = re.search(r'__h([0-9a-f]+)__b(\d+)$', tag)
        if match: wanted[(match[2], str(tracked[tag]), match[1])] = tag
    if not wanted: return
    index = root / '.parallel-workers/adaptive/queue-index'
    try: entries = os.scandir(index)
    except FileNotFoundError: return  # Older schedulers only published active registrations.
    with entries:
        for entry in entries:
            match = re.fullmatch(r'batch_(\d+)_\d{4}-\d{2}-\d{2}_(\d+)_([0-9a-f]+)\.env', entry.name)
            tag = wanted.get(match.groups()) if match else None
            if tag: yield tag, Path(entry.path)


def read(snapshot_path, tracked, cached, selected):
    """Cache immutable resource declarations. Read each referenced batch's outcome once per refresh."""
    snapshot = json.loads(snapshot_path.read_text())
    scheduler = snapshot.get('scheduler') or {}
    if not scheduler.get('ok') or time.time() - (scheduler.get('updated') or 0) > 120:
        raise ValueError('Current scheduler metadata unavailable')
    local = next((h for h in snapshot['hosts'] if h['id'] == snapshot['collector']['local_host']), {})
    mount = local.get('mount') or {}
    if not mount.get('ok'): raise ValueError('Scheduler share is unavailable')
    root = Path(mount['root'])
    # Keep retired queues' declarations as long as Agent Bar still lists the queue.
    declarations = {tag: record for tag, record in cached.items() if tag in tracked}
    errors = {}
    if not selected: return declarations, {'links': {}, 'dependents': {}, 'errors': {}}
    # A hidden queue can depend on a visible one. Index the immutable declarations for all tracked queues,
    # but read mutable prerequisite status only for the requested rows.
    indexed = {tag for tag, record in declarations.items() if 'batch_dir' in record}
    pool = (scheduler.get('pool') or {}).get('id')
    registered = {q['tag']: {'pool_id': pool, **q} for q in scheduler.get('queues', []) if q.get('tag') in tracked}
    for tag, path in archived_registrations(root, tracked, tracked.keys() - indexed - registered.keys()):
        try:
            reg = env_file(path)
            if reg['tag_clean'] != tag or reg['queue_id'] != path.stem: raise ValueError('Registration identity changed')
            registered[tag] = reg
        except (OSError, ValueError, KeyError) as error: errors[tag] = str(error)
    for tag, queue in registered.items():
        token = queue['queue_id']
        try:
            batch = batch_path(queue['batch_dir'], root)
            identity = {'id': token, 'pool': queue.get('pool_id'), 'batch_dir': str(batch)}
            existing = declarations.get(tag)
            if existing and existing['id'] == token and all(existing.get(k, v) == v for k, v in identity.items()):
                declarations[tag] = {**existing, **identity}
                continue
            resources = env_file(batch / 'adaptive/resources.env')
            if resources['queue_id'] != token: raise ValueError('Queue resource identity changed')
            if resources['schema_version'] == '1':
                refs = []
            elif resources['schema_version'] == '2':
                refs = json.loads(resources['dependencies'])
                if not isinstance(refs, list) or not all(isinstance(ref, dict) and
                        all(isinstance(ref.get(k), str) for k in ('pool_id', 'queue_id', 'batch_dir')) for ref in refs):
                    raise ValueError('Invalid prerequisite list')
            else: raise ValueError('Unsupported queue resource schema')
            declarations[tag] = {**identity, 'refs': refs}
        except (OSError, KeyError, ValueError) as error:
            declarations.pop(tag, None)
            errors[tag] = str(error)
    targets = {(record['pool'], record['id'], record['batch_dir']): tag for tag, record in declarations.items()
               if tag in selected and record.get('pool') and record.get('batch_dir')}
    outcomes, links, dependents = {}, {}, {}
    for tag, record in declarations.items():
        for ref in record['refs']:
            key = (ref['pool_id'], ref['queue_id'], ref['batch_dir'])
            target = targets.get(key)
            if target: dependents.setdefault(target, []).append(tag)
            if tag in selected:
                if key not in outcomes: outcomes[key] = prerequisite(ref, root)
                links.setdefault(tag, []).append(outcomes[key])
    return declarations, {'links': links, 'dependents': dependents, 'errors': errors}
