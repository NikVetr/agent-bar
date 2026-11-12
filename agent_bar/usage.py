"""Provider usage limits: what Claude Code and Codex last recorded on this computer, a history of those readings, and
what the history implies: the recent pace, when a limit would run out at that pace, and how much went each day.
Nothing here contacts a provider unless the user turns on Claude reads.

Claude Code caches its limits in ~/.claude.json when it fetches them (as /usage does), including weekly limits
scoped to a model such as Fable; with the panel's setting on, Agent Bar also reads them itself every 10 minutes.
Codex writes its limits into its session logs as it works, so its history is read back from them, a few new bytes
at a time."""
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from .state import ROOT, atomic_json

HISTORY = 'usage-history.json'
KEEP = 15 * 86400  # Seconds of readings kept: two weekly windows.
PACE = 24 * 3600  # Readings this recent set the pace a limit is projected at.
SAME_WINDOW = 3600  # Reset times this close are one window; Codex's drift by seconds.
# With the panel's Claude reads on, Agent Bar reads Claude's limits this often itself, waiting up to an hour after
# failures, from the endpoint Claude Code uses for /usage.
FETCH_EVERY = 600
USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
WEEK, FIVE_HOURS = 7 * 86400, 5 * 3600


def epoch(value):
    """Seconds since the epoch from a number or an ISO time; None for neither."""
    if isinstance(value, (int, float)): return float(value)
    try: return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except ValueError: return None


def claude_limits(utilization):
    """Limits from a Claude usage reading (Claude Code caches it as `utilization`): the 5-hour session, the weekly
    limit, and weekly limits scoped to a model, with the model's share of the weekly limit."""
    shares = {share['limit_index']: share for share in utilization.get('weekly_scoped_shares') or []
              if isinstance(share, dict) and isinstance(share.get('limit_index'), int)}
    limits = []
    for index, item in enumerate(utilization.get('limits') or []):
        if not isinstance(item, dict) or item.get('percent') is None: continue
        model = ((item.get('scope') or {}).get('model') or {}).get('display_name')
        session = item.get('kind') == 'session'
        limit = {'key': 'session' if session else f'weekly:{model}' if model else 'weekly',
                 'name': '5-hour' if session else f'Weekly · {model}' if model else 'Weekly',
                 'percent': float(item['percent']), 'resets_at': epoch(item.get('resets_at')),
                 'window': FIVE_HOURS if session else WEEK, 'limiting': bool(item.get('is_active'))}
        share = shares.get(index)
        if share and share.get('used_percent_of_weekly') is not None:
            limit['share'] = {'used': float(share['used_percent_of_weekly']), 'allowance': share.get('allowance_percent_of_weekly')}
        limits.append(limit)
    if not limits:
        # Older readings name only the two windows.
        for key, name, window, field in [('session', '5-hour', FIVE_HOURS, 'five_hour'), ('weekly', 'Weekly', WEEK, 'seven_day')]:
            item = utilization.get(field)
            if isinstance(item, dict) and item.get('utilization') is not None:
                limits.append({'key': key, 'name': name, 'percent': float(item['utilization']), 'resets_at': epoch(item.get('resets_at')),
                               'window': window, 'limiting': False})
    return limits


def claude(home):
    """Claude Code's cached limits in ~/.claude.json, or None when it has cached none."""
    try: cached = json.loads((home / '.claude.json').read_text()).get('cachedUsageUtilization') or {}
    except (OSError, ValueError): return None
    limits = claude_limits(cached.get('utilization') or {})
    return {'as_of': (cached.get('fetchedAtMs') or 0) / 1000, 'limits': limits} if limits else None


def fetch_claude(home, now):
    """Claude's limits read now from the usage endpoint Claude Code itself reads (undocumented), with Claude Code's
    sign-in, which this never renews. Raises ValueError saying why it could not."""
    try: sign_in = json.loads((home / '.claude/.credentials.json').read_text())['claudeAiOauth']
    except (OSError, ValueError, KeyError, TypeError): raise ValueError('Claude Code is not signed in on this computer') from None
    if (sign_in.get('expiresAt') or 0) / 1000 <= now:
        raise ValueError("Claude Code's sign-in has expired; it renews it the next time it runs")
    request = urllib.request.Request(USAGE_URL, headers={'Authorization': f'Bearer {sign_in["accessToken"]}',
                                                         'Content-Type': 'application/json', 'User-Agent': 'agent-bar'})
    try:
        with urllib.request.urlopen(request, timeout=10) as response: reading = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise ValueError({401: "Claude refused Claude Code's sign-in; it renews it the next time it runs",
                          429: 'Claude asked for fewer reads; trying again later'}.get(error.code, f'Claude answered HTTP {error.code}')) from None
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise ValueError(f'Claude could not be reached: {getattr(error, "reason", error)}') from None
    limits = claude_limits(reading if isinstance(reading, dict) else {})
    if not limits: raise ValueError('Claude answered without limits')
    return {'as_of': now, 'limits': limits}


def codex_windows(limits):
    """A Codex rate_limits object's windows as limits; Codex also writes entries with no windows (null)."""
    found = []
    for window in [limits.get(key) for key in ['primary', 'secondary']] if isinstance(limits, dict) else []:
        minutes = window.get('window_minutes') if isinstance(window, dict) else None
        if not isinstance(window, dict) or window.get('used_percent') is None or not isinstance(minutes, int) or minutes <= 0: continue
        key, name = {300: ('session', '5-hour'), 10080: ('weekly', 'Weekly')}.get(minutes, (f'{minutes}m', f'{minutes}-minute'))
        found.append({'key': key, 'name': name, 'percent': float(window['used_percent']), 'resets_at': epoch(window.get('resets_at')),
                      'window': minutes * 60, 'limiting': False})
    return found


def codex_readings(data, offset=0):
    """(time, limits) for each rate-limit reading in complete lines of a Codex rollout from `offset`, and the offset
    after the last complete line."""
    end = data.rfind(b'\n') + 1
    readings = []
    for line in data[offset:end].split(b'\n'):
        if b'"rate_limits"' not in line: continue
        try: entry = json.loads(line)
        except ValueError: continue
        limits = codex_windows((entry.get('payload') or {}).get('rate_limits'))
        at = epoch(entry.get('timestamp'))
        if limits and at: readings.append((at, limits))
    return readings, max(end, offset)


def load(root=ROOT):
    try: data = json.loads((Path(root) / HISTORY).read_text())
    except (OSError, ValueError): data = {}
    return {'current': data.get('current') or {}, 'series': data.get('series') or {}, 'offsets': data.get('offsets') or {},
            'fetch': data.get('fetch') or {}}


def record(series, key, at, limit):
    """Add a reading to a limit's series when it differs from the one before it, a reset time within SAME_WINDOW
    counting as the same: [time, percent, reset time, share used]."""
    entry = [at, limit['percent'], limit['resets_at'], (limit.get('share') or {}).get('used')]
    rows = series.setdefault(key, [])
    index = len(rows)
    while index and rows[index - 1][0] > at: index -= 1
    before = rows[index - 1] if index else None
    if before and before[1] == entry[1] and before[3] == entry[3] and (before[2] == entry[2] or (
            before[2] is not None and entry[2] is not None and abs(before[2] - entry[2]) < SAME_WINDOW)): return
    rows.insert(index, entry)


def refresh(home=None, root=ROOT, now=None, fetch=False):
    """Read new limit readings into the history file and return the summary. Run by the service once a minute; with
    `fetch`, also read Claude's limits from Claude every FETCH_EVERY seconds."""
    home, root, now = Path(home or Path.home()), Path(root), now or time.time()
    history = load(root)
    series, offsets = history['series'], history['offsets']
    readings = [found] if (found := claude(home)) else []
    state = history['fetch'] if fetch else {}
    if fetch and now >= state.get('next', 0):
        try:
            readings.append(fetch_claude(home, now))
            state = {'at': now, 'ok': True, 'error': None, 'next': now + FETCH_EVERY, 'wait': FETCH_EVERY}
        except ValueError as error:
            wait = min(3600, max(FETCH_EVERY, 2 * state.get('wait', FETCH_EVERY // 2)))
            state = {**state, 'ok': False, 'error': str(error), 'failed_at': now, 'next': now + wait, 'wait': wait}
    history['fetch'] = state
    for found in readings:
        for limit in found['limits']: record(series, f'claude:{limit["key"]}', found['as_of'], limit)
        if found['as_of'] >= (history['current'].get('claude') or {}).get('as_of', 0): history['current']['claude'] = found
    sessions = home / '.codex/sessions'
    latest = None
    seen = {}
    for path in sessions.glob('*/*/*/rollout-*.jsonl') if sessions.exists() else []:
        try: stat = path.stat()
        except OSError: continue
        if stat.st_mtime < now - KEEP: continue
        name, offset = str(path), offsets.get(str(path), 0)
        seen[name] = offset
        if stat.st_size <= offset: continue
        try:
            with path.open('rb') as stream:
                stream.seek(offset)
                readings, end = codex_readings(stream.read(), 0)
        except OSError:
            continue
        seen[name] = offset + end
        for at, limits in readings:
            for limit in limits: record(series, f'codex:{limit["key"]}', at, limit)
            if not latest or at > latest[0]: latest = (at, limits)
    history['offsets'] = seen
    if latest and latest[0] >= (history['current'].get('codex') or {}).get('as_of', 0):
        history['current']['codex'] = {'as_of': latest[0], 'limits': latest[1]}
    for key, rows in list(series.items()):
        kept = [row for row in rows if row[0] >= now - KEEP]
        series[key] = kept or rows[-1:]
    atomic_json(root / HISTORY, history)
    return summary(history, now)


def at_time(rows, when, resets_at):
    """A limit's reading in force at `when` within the window ending at `resets_at` (0 before its first reading
    there, as a window starts empty), from rows of [time, percent, reset time, share used]."""
    value = None
    for row in rows:
        if row[0] > when: break
        if row[2] is not None and resets_at is not None and abs(row[2] - resets_at) < SAME_WINDOW: value = row
    return value


def pace(rows, limit, as_of):
    """Percent per hour since the reading in force a day before `as_of` ('day'), or, without one, since the window
    began, as every window starts empty ('window')."""
    resets, window = limit['resets_at'], limit['window']
    if not resets or not window: return None
    start = resets - window
    since, used_then, basis = start, 0.0, 'window'
    if as_of - PACE > start:
        before = at_time(rows, as_of - PACE, resets)
        if before: since, used_then, basis = as_of - PACE, before[1], 'day'
    hours = (as_of - since) / 3600
    if hours < 0.5: return None
    return {'per_hour': max(0.0, (limit['percent'] - used_then) / hours), 'since': since, 'basis': basis}


def days(rows, limit, as_of, share=False):
    """Percent of a weekly limit used on each local day of its window so far, from the readings in force at each
    day's end; with `share`, a scoped model's use in points of the weekly limit."""
    resets, window = limit['resets_at'], limit['window']
    if not resets or window != WEEK: return []
    start, stop = resets - window, min(as_of, resets)
    result, previous = [], 0.0
    day = datetime.fromtimestamp(start).replace(hour=0, minute=0, second=0, microsecond=0)
    while day.timestamp() < stop:
        following = day + timedelta(days=1)
        row = at_time(rows, min(stop, following.timestamp()), resets)
        value = row[3] if row and share else row[1] if row else None
        value = previous if value is None else value
        result.append({'day': day.strftime('%a'), 'start': max(day.timestamp(), start), 'used': max(0.0, value - previous)})
        previous = max(previous, value)
        day = following
    return result


def summary(history, now=None):
    """Each provider's limits with what is left, when they reset, the recent pace, when that pace would use the rest
    and how that compares with the reset, and, for weekly limits, use by day (Claude's split into its scoped models'
    share and the rest)."""
    now = now or time.time()
    result = {}
    for provider, current in history['current'].items():
        as_of, limits = current['as_of'], []
        scoped = [limit for limit in current['limits'] if limit.get('share')]
        for limit in current['limits']:
            rows = history['series'].get(f'{provider}:{limit["key"]}', [])
            window = [row for row in rows if row[2] is not None and limit['resets_at'] and abs(row[2] - limit['resets_at']) < SAME_WINDOW]
            item = {**limit, 'left': max(0.0, 100 - limit['percent']), 'readings': len(window),
                    'expired': bool(limit['resets_at'] and limit['resets_at'] <= now)}
            speed = None if item['expired'] else pace(rows, limit, as_of)
            if speed:
                item['pace'] = speed
                if speed['per_hour'] > 0:
                    item['runs_out_at'] = as_of + item['left'] / speed['per_hour'] * 3600
                if limit['resets_at']:
                    item['at_reset'] = min(100.0, limit['percent'] + speed['per_hour'] * max(0, limit['resets_at'] - as_of) / 3600)
            if limit['key'] == 'weekly':
                total = days(rows, limit, as_of)
                parts = []
                for other in scoped:
                    model = other['name'].split(' · ', 1)[-1]
                    used = days(history['series'].get(f'{provider}:{other["key"]}', []), other, as_of, share=True)
                    parts.append((model, {entry['day']: entry['used'] for entry in used}))
                for entry in total:
                    split = [[model, min(entry['used'], by_day.get(entry['day'], 0.0))] for model, by_day in parts]
                    rest = max(0.0, entry['used'] - sum(value for _, value in split))
                    entry['parts'] = split + [['Other' if parts else 'All', rest]]
                item['days'] = total
            limits.append(item)
        result[provider] = {'as_of': as_of, 'limits': limits}
    if history.get('fetch') and 'claude' in result:
        fetch = history['fetch']
        result['claude']['fetch'] = {'ok': fetch.get('ok'), 'at': fetch.get('at'), 'error': fetch.get('error'), 'next': fetch.get('next')}
    return result


def report(root=ROOT, now=None):
    """The summary of what the service last recorded, for `agent-bar usage`."""
    return {'ok': True, 'usage': summary(load(root), now)}
