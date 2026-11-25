"""What local agent use would cost at API prices, from the token counts Claude Code and Codex already record.

Claude Code writes each reply's usage (uncached input, cache writes by lifetime, cache reads, output, speed) into
its transcripts; Codex writes a token_count event after each model response, with the thread's running total and
the last response's share. Each file is read once and afterwards only from where the previous pass stopped. The
prices are a dated table in data/prices.json, which ~/.config/agent-bar/prices.json can extend or override; a
model missing from both is counted as unpriced tokens rather than guessed. Subscription plans are not billed this
way, so for them the figures say what the same use would cost through the API."""
import hashlib
import json
import re
import time
from datetime import datetime
from pathlib import Path

from .state import ROOT, atomic_json
from .usage import KEEP, epoch

BUNDLED = Path(__file__).parent / 'data/prices.json'
OVERRIDE = Path.home() / '.config/agent-bar/prices.json'
STATE = 'costs.json'
DATED = re.compile(r'-\d{8}$')
# Codex rollout names end in the thread id, optionally followed by a continuation's own id.
THREAD = re.compile(r'rollout-[\dT-]+-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl$')


def load_prices(override=None):
    """The bundled table with the user's additions and replacements."""
    table = json.loads(BUNDLED.read_text())
    path = OVERRIDE if override is None else Path(override)
    try: extra = json.loads(path.read_text())
    except FileNotFoundError: extra = {}
    except (OSError, ValueError) as error: raise ValueError(f'{path} is unreadable: {error}') from None
    table['models'] = {**table['models'], **(extra.get('models') or {})}
    if 'web_search' in extra: table['web_search'] = extra['web_search']
    return table


def model_rates(prices, model):
    """A model's rates, accepting dated IDs (claude-sonnet-4-5-20250929); None when unpriced."""
    models = prices['models']
    return models.get(model) or models.get(DATED.sub('', model or ''))


def claude_cost(rates, usage, web_search=0.0):
    """Dollars for one Claude reply's usage block."""
    written = usage.get('cache_creation') or {}
    long_lived = written.get('ephemeral_1h_input_tokens') or 0
    short_lived = written.get('ephemeral_5m_input_tokens')
    if short_lived is None: short_lived = max(0, (usage.get('cache_creation_input_tokens') or 0) - long_lived)
    tokens = {'input': usage.get('input_tokens') or 0, 'cache_write_5m': short_lived, 'cache_write_1h': long_lived,
              'cache_read': usage.get('cache_read_input_tokens') or 0, 'output': usage.get('output_tokens') or 0}
    long_context = rates.get('long_context')
    if long_context and tokens['input'] + short_lived + long_lived + tokens['cache_read'] > long_context['above']:
        rates = {**rates, **long_context}
    factor = 1.0
    if usage.get('speed') == 'fast': factor *= rates.get('fast', 1)
    if usage.get('inference_geo') == 'us': factor *= rates.get('geo_us', 1)
    dollars = sum(tokens[kind] * rates[kind] for kind in tokens) / 1e6 * factor
    searches = (usage.get('server_tool_use') or {}).get('web_search_requests') or 0
    return dollars + searches * web_search, sum(tokens.values())


def codex_cost(rates, usage):
    """Dollars for one Codex response's usage; its input count includes cached and cache-written tokens."""
    cached = usage.get('cached_input_tokens') or 0
    written = usage.get('cache_write_input_tokens') or 0
    fresh = max(0, (usage.get('input_tokens') or 0) - cached - written)
    output = usage.get('output_tokens') or 0
    dollars = (fresh * rates['input'] + cached * rates['cache_read'] + written * rates.get('cache_write', rates['input'])
               + output * rates['output']) / 1e6
    return dollars, fresh + cached + written + output


def load(root=ROOT):
    try: data = json.loads((Path(root) / STATE).read_text())
    except (OSError, ValueError): data = {}
    return {'files': data.get('files') or {}, 'days': data.get('days') or {}, 'chats': data.get('chats') or {},
            'unpriced': data.get('unpriced') or {}, 'checked': data.get('checked'), 'prices': data.get('prices')}


class Tally:
    """Adds costs into per-day, per-provider, per-model buckets and per-chat totals."""

    def __init__(self, data, now):
        self.data, self.since = data, now - KEEP

    def add(self, provider, chat, model, at, dollars, tokens):
        key = f'{provider}:{chat}' if chat else None
        if key:
            total = self.data['chats'].setdefault(key, {'cost': 0.0, 'tokens': 0, 'last': 0})
            total['cost'] += dollars
            total['tokens'] += tokens
            total['last'] = max(total['last'], at)
        if at < self.since: return
        day = datetime.fromtimestamp(at).strftime('%Y-%m-%d')
        bucket = self.data['days'].setdefault(day, {}).setdefault(provider, {}).setdefault(model, [0.0, 0])
        bucket[0] += dollars
        bucket[1] += tokens

    def unpriced(self, provider, model, tokens):
        name = f'{provider}:{model}'
        self.data['unpriced'][name] = self.data['unpriced'].get(name, 0) + tokens


def read_new(path, state):
    """Complete lines appended since the saved offset; resets the file's state when it was replaced or truncated."""
    stat = path.stat()
    if state.get('inode') != stat.st_ino or stat.st_size < state.get('offset', 0):
        state.clear()
        state.update(inode=stat.st_ino, offset=0)
    if stat.st_size == state['offset']: return []
    with path.open('rb') as stream:
        stream.seek(state['offset'])
        data = stream.read()
    end = data.rfind(b'\n') + 1
    state['offset'] += end
    return data[:end].split(b'\n')


def claude_lines(lines, tally, prices, seen):
    for line in lines:
        if b'"usage"' not in line or b'"assistant"' not in line: continue
        try: entry = json.loads(line)
        except ValueError: continue
        message = entry.get('message') or {}
        usage = message.get('usage') if isinstance(message, dict) else None
        model = message.get('model') if usage else None
        if not usage or not model or model.startswith('<'): continue
        # A reply with several content blocks is written once per block, each with the same usage.
        mark = f'{message.get("id")}:{entry.get("requestId")}'
        at = epoch(entry.get('timestamp')) or 0
        if mark in seen: continue
        seen[mark] = at
        rates = model_rates(prices, model)
        if rates:
            dollars, tokens = claude_cost(rates, usage, prices.get('web_search', 0))
            tally.add('claude', entry.get('sessionId'), model, at, dollars, tokens)
        else:
            tally.unpriced('claude', model, sum(usage.get(k) or 0 for k in
                           ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']))


def codex_lines(lines, state, thread, tally, prices):
    for line in lines:
        if b'"turn_context"' in line[:120]:
            try: state['model'] = json.loads(line)['payload'].get('model')
            except (ValueError, KeyError, TypeError, AttributeError): pass
            continue
        if b'"token_count"' not in line: continue
        try: entry = json.loads(line)
        except ValueError: continue
        info = (entry.get('payload') or {}).get('info')
        if not isinstance(info, dict): continue
        total = (info.get('total_token_usage') or {}).get('total_tokens')
        last = info.get('last_token_usage') or {}
        # Codex repeats a reading when only its rate limits change: count a response once, when the total moves.
        if total is None or total == state.get('total'): continue
        state['total'] = total
        model = state.get('model') or 'unknown'
        rates = model_rates(prices, model)
        if rates:
            dollars, tokens = codex_cost(rates, last)
            tally.add('codex', thread, model, epoch(entry.get('timestamp')) or 0, dollars, tokens)
        else:
            tally.unpriced('codex', model, last.get('total_tokens') or 0)


class Costs:
    """Kept by the service between passes, for the Claude replies already counted."""

    def __init__(self):
        self.seen = {}

    def refresh(self, home=None, root=ROOT, now=None, override=None):
        home, root, now = Path(home or Path.home()), Path(root), now or time.time()
        prices = load_prices(override)
        fingerprint = hashlib.sha256(json.dumps(prices, sort_keys=True).encode()).hexdigest()[:16]
        data = load(root)
        if data['prices'] != fingerprint:
            # Changed prices apply to everything still on record: count again from the start.
            data = {'files': {}, 'days': {}, 'chats': {}, 'unpriced': {}, 'checked': prices['checked']}
            self.seen = {}
        files, tally, kept = data['files'], Tally(data, now), {}
        projects = home / '.claude/projects'
        for path in projects.glob('**/*.jsonl') if projects.exists() else []:
            name = str(path)
            try:
                if path.stat().st_mtime < now - KEEP and name not in files: continue
                state = files.get(name, {})
                claude_lines(read_new(path, state), tally, prices, self.seen)
            except OSError: continue
            kept[name] = state
        sessions = home / '.codex/sessions'
        for path in sessions.glob('*/*/*/rollout-*.jsonl') if sessions.exists() else []:
            name, match = str(path), THREAD.search(path.name)
            if not match: continue
            try:
                if path.stat().st_mtime < now - KEEP and name not in files: continue
                state = files.get(name, {})
                codex_lines(read_new(path, state), state, match[1], tally, prices)
            except OSError: continue
            kept[name] = state
        data['files'] = {name: state for name, state in kept.items()}
        cutoff = datetime.fromtimestamp(now - KEEP).strftime('%Y-%m-%d')
        data['days'] = {day: value for day, value in data['days'].items() if day >= cutoff}
        data['chats'] = {key: value for key, value in data['chats'].items() if value['last'] >= now - KEEP}
        self.seen = {mark: at for mark, at in self.seen.items() if at >= now - KEEP}
        data['checked'], data['prices'] = prices['checked'], fingerprint
        atomic_json(root / STATE, data)
        return summary(data, now)


def summary(data, now=None):
    """Cost per local day and provider for the days on record, the last 7 days by model, unpriced tokens, and each
    recent chat's total."""
    now = now or time.time()
    today = datetime.fromtimestamp(now).strftime('%Y-%m-%d')
    week = datetime.fromtimestamp(now - 6 * 86400).strftime('%Y-%m-%d')
    days, models = [], {}
    for day in sorted(data['days']):
        providers = data['days'][day]
        days.append({'day': day, **{provider: round(sum(v[0] for v in by_model.values()), 4)
                                    for provider, by_model in providers.items()}})
        if day >= week:
            for provider, by_model in providers.items():
                for model, (dollars, tokens) in by_model.items():
                    entry = models.setdefault(model, {'provider': provider, 'cost': 0.0, 'tokens': 0})
                    entry['cost'] += dollars
                    entry['tokens'] += tokens
    total = lambda rows: round(sum(v for row in rows for k, v in row.items() if k != 'day'), 2)
    return {'checked': data['checked'], 'today': total([d for d in days if d['day'] == today]),
            'week': total([d for d in days if d['day'] >= week]), 'days': days,
            'models': sorted(({'model': model, **entry, 'cost': round(entry['cost'], 2)} for model, entry in models.items()),
                             key=lambda entry: -entry['cost']),
            'unpriced': data['unpriced'],
            'chats': {key: round(value['cost'], 4) for key, value in data['chats'].items()}}


def report(root=ROOT, now=None):
    """The summary of what the service last counted, for `agent-bar cost`."""
    data = load(root)
    if not data['checked']: raise ValueError('No costs counted yet; the service counts them once a minute')
    return {'ok': True, 'cost': summary(data, now)}
