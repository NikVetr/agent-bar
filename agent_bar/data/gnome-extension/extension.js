/* exported init */
const {Clutter, Gio, GLib, Meta, Pango, St} = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ByteArray = imports.byteArray;
const ROOT = GLib.build_filenamev([GLib.get_home_dir(), '.local/state/agent-bar']);
// The agent-bar command; pipx and uv install it in ~/.local/bin, which a GNOME session's PATH may lack.
const CLI = GLib.find_program_in_path('agent-bar') || GLib.build_filenamev([GLib.get_home_dir(), '.local/bin/agent-bar']);
const INTERFACE = `<node><interface name="io.github.nikvetr.AgentBar">
<method name="Inspect"><arg type="s" direction="out"/></method>
<method name="Show"/><method name="Hide"/>
<method name="Activate"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
</interface></node>`;
const EMPTY = 'Empty window';  // The bridge's workspace name for a window without a folder.
const CONFIG = GLib.build_filenamev([GLib.get_home_dir(), '.config/agent-bar/settings.json']);
// Written by the parallel-workers collector; the panel never contacts cluster hosts itself.
const CLUSTER = GLib.build_filenamev([GLib.get_home_dir(), '.local/state/parallel-workers/cluster-status.json']);
const CLUSTER_STALE = 30;
// Seconds of shared-drive readings the panel keeps for its sparklines.
const SHARED_WINDOW = 600;
// Where the Queues tab sends someone without parallel-workers; it has no public home yet.
const SCHEDULER_URL = null;
// [section, key, label, description, default, [[value, caption]...]]; a list default makes the setting
// multiple-choice. The service reads quietMinutes.
const SETTINGS = [
    ['Top bar', 'quickLimit', 'Review buttons', 'At most this many shortcuts, as room allows; +N more lists the rest', 6,
        [[0, 'Off'], [3, '3'], [6, '6'], [10, '10']]],
    ['Top bar', 'quickChars', 'Button name length', 'Characters of the folder name on each shortcut', 16,
        [[12, '12'], [16, '16'], [24, '24']]],
    ['Top bar', 'quickReasons', 'Review buttons for', 'Reasons that give a chat a shortcut',
        ['Reply finished', 'Turn failed', 'Input needed', 'Approval needed', 'Queues finished'],
        [['Reply finished', 'Reply'], ['Turn failed', 'Failure'], ['Input needed', 'Question'], ['Approval needed', 'Approval'], ['Queues finished', 'Queues']]],
    ['Top bar', 'queueBar', 'Queue count', 'Q finished / outstanding since each project\'s last turn', true,
        [[true, 'Show'], [false, 'Hide']]],
    ['Cluster', 'clusterBar', 'Top-bar indicator', 'Pick any; with only Warnings it appears just when one fires', ['cpu', 'warnings'],
        [['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk'], ['warnings', 'Warnings']]],
    ['Cluster', 'clusterMemoryWarn', 'Memory warning', 'The memory pressure a host must reach', 'warn',
        [['warn', 'Elevated'], ['critical', 'Critical']]],
    ['Cluster', 'clusterDiskWarn', 'Disk warning', 'How full a host\'s drive or the shared drive must be', 90,
        [[90, '90%'], [95, '95%'], [98, '98%']]],
    ['Cluster', 'clusterHosts', 'Top-bar total', 'Hosts counted in the top-bar percentage', 'all',
        [['all', 'All hosts'], ['workers', 'Without this desktop']]],
    ['Cluster', 'clusterLayout', 'Dropdown layout', 'Compare hosts within each measure, or one card per host', 'measure',
        [['measure', 'By measure'], ['host', 'By host']]],
    ['Windows', 'windowOrder', 'Window menu order', 'Order of the ▾ window menu', 'recent',
        [['recent', 'Recent'], ['name', 'Name']]],
    ['Windows', 'windowClick', 'Window menu click', 'What clicking a window in ▾ does', 'place',
        [['place', 'Maximize on main'], ['raise', 'Raise in place']]],
    ['Windows', 'focusedClick', 'Clicking a focused chat again', 'Whether it sends the window back to its display', 'return',
        [['return', 'Send back'], ['stay', 'Keep']]],
    ['Dropdown', 'openTab', 'Opens on', 'The tab last used, or always Chats', 'last',
        [['last', 'Last tab'], ['conversations', 'Chats']]],
    ['Dropdown', 'projectOrder', 'Project order', 'Also set from Sort in Chats', 'activity',
        [['activity', 'Activity'], ['total', 'Total activity'], ['review', 'Review first'], ['completion', 'Latest reply'], ['name', 'Name']]],
    ['Dropdown', 'historyOrder', 'History order', 'Also set from Sort in History; total activity is from the last scan', 'activity',
        [['activity', 'Activity'], ['total', 'Total activity'], ['name', 'Name']]],
    ['Dropdown', 'queueOrder', 'Queue order', 'Also set from Sort in Queues', 'completion',
        [['completion', 'Completion since last turn'], ['activity', 'Recent activity'], ['name', 'Name']]],
    ['Dropdown', 'gitOrder', 'Git order', 'Also set from Sort in Git', 'changes',
        [['changes', 'Changes first'], ['recent', 'Last commit'], ['name', 'Name']]],
    ['Dropdown', 'quietMinutes', 'Waiting after', 'An open turn with no activity this long shows as waiting', 5,
        [[2, '2 min'], [5, '5 min'], [10, '10 min'], [0, 'Never']]],
    ['Integrations', 'scheduler', 'Job scheduler', 'parallel-workers: Queues tab, Q count, cluster indicator, queues-finished reviews', true,
        [[true, 'On'], [false, 'Off']]],
    ['Integrations', 'git', 'Git status', 'Git tab: branch, uncommitted changes and unpushed commits of open projects', true,
        [[true, 'On'], [false, 'Off']]],
    ['Integrations', 'messages', 'Agent messages', 'Chats can message one open chat; it sees an unread count at its next turn start', true,
        [[true, 'On'], [false, 'Off']]],
    ['Integrations', 'wake', 'Wake idle chats', 'A message starts a turn in an idle Claude Code chat (up to 2 h after its last turn), or in a Codex chat open in VS Code once any turn in progress ends', false,
        [[true, 'On'], [false, 'Off']]],
    ['Integrations', 'midturn', 'Messages to a busy Claude chat', 'With waking on, whether a message can arrive during its turn instead of right after it', 'after',
        [['after', 'After its turn'], ['urgent', 'Urgent mid-turn'], ['always', 'Mid-turn']]],
    ['Appearance', 'palette', 'State colors', 'Colors for review, working, waiting, failed and finished', 'default',
        [['default', 'Default'], ['colorblind', 'Color-blind safe']]],
];
const QUEUE_BAR = 180;
// How long the pointer must rest on another top-bar button before an open tracker dropdown gives way to it.
const MENU_SWITCH_DELAY = 500;
// History rows shown while searching; folders otherwise build rows only when expanded.
const HISTORY_SEARCH_LIMIT = 40;
// Symbol and name of each provider; .tracker-<provider> gives its color. Claude and Codex always have a
// top-bar count, the others only while one of their chats is open.
const PROVIDERS = {claude: ['✳', 'Claude'], codex: ['⌘', 'Codex'], copilot: ['◆', 'Copilot'], antigravity: ['▲', 'Antigravity']};
const PINNED = ['claude', 'codex'];
const FILTERS = [['all', 'All'], ...Object.entries(PROVIDERS).map(([key, [symbol, name]]) => [key, `${symbol} ${name}`]),
    ['review', 'Needs review'], ['active', 'Working or waiting']];
// 'counted' lists exactly the queues in each project's Q finished / outstanding badge.
const QUEUE_FILTERS = [['counted', 'Since last turn'], ['active', 'Running or queued'], ['finished', 'Finished'],
    ['all', 'All seen']];
const GIT_FILTERS = [['all', 'All'], ['changes', 'Uncommitted'], ['unpushed', 'Unpushed']];
const TERMINAL = new Set(['COMPLETED', 'FINISHED_INCOMPLETE', 'FAILED', 'KILLED', 'UNLISTED']);

function age(at) {
    if (!at) return 'not observed yet';
    const seconds = Math.max(0, Date.now() / 1000 - at);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function duration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
    return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

function queueDetail(queue) {
    const parts = [`${queue.done} / ${queue.total} jobs · ${queue.pct.toFixed(1)}%`];
    // Records from before the monitor reported failures have no count.
    if (queue.failed) parts.push(`${queue.failed} failed${queue.failed_at ? `, last ${queue.failed_at}` : ''}`);
    const known = queue.elapsed !== undefined;
    if (queue.state === 'UNLISTED') {
        parts.push(`no longer listed by the monitor since ${age(queue.finished_at)}`);
    } else if (TERMINAL.has(queue.state)) {
        // Records from before the monitor kept end times fall back to when the tracker saw it finish.
        const ended = queue.ended || queue.finished_at;
        parts.push(ended ? `finished ${age(ended)}` : 'finished');
        if (known) parts.push(`took ${duration(queue.elapsed)}`);
    } else {
        const workers = (queue.workers.split(' ')[0] || '').split('-').reduce((n, v) => n + (Number(v) || 0), 0);
        if (workers) parts.push(`${workers} worker${workers === 1 ? '' : 's'}`);
        if (known) parts.push(`${queue.state === 'PENDING' ? 'queued' : 'running'} ${duration(queue.elapsed)}`);
        if (queue.eta >= 0 && ['RUNNING', 'DRAINING'].includes(queue.state)) parts.push(`ETA ${duration(queue.eta)}`);
    }
    return parts.join(' · ');
}

function providerCounts(rows, provider) {
    const unique = new Map(rows.filter(row => row.provider === provider).map(row => [row.key, row]));
    return {open: unique.size, review: [...unique.values()].filter(row => row.unread.length).length};
}

function completionTime(row) {
    return row.completed_at || (row.state === 'finished' ? row.state_at : 0);
}

// Open chats needing review for one of `reasons` (any, when null), the longest waiting first.
function readyConversations(rows, reasons = null) {
    const unique = new Map();
    for (const row of rows)
        if (row.target && !unique.has(row.key) && row.unread.some(reason => !reasons || reasons.includes(reason)))
            unique.set(row.key, row);
    return [...unique.values()].sort((a, b) => completionTime(a) - completionTime(b));
}

function matchesFilter(row, filter) {
    if (filter in PROVIDERS) return row.provider === filter;
    if (filter === 'review') return row.unread.length > 0;
    if (filter === 'active') return ['working', 'waiting'].includes(row.state);
    return true;
}

// totals: conversation key → active seconds from the inventory, for the 'total' order.
function groupProjects(rows, order = 'activity', totals = new Map()) {
    const projects = new Map();
    for (const row of rows) {
        const key = JSON.stringify(row.roots?.length ? row.roots : [row.project]);
        if (!projects.has(key)) projects.set(key, {key, name: row.project, rows: [], windows: new Map()});
        const project = projects.get(key);
        project.rows.push(row);
        if (!project.windows.has(row.window)) project.windows.set(row.window, []);
        project.windows.get(row.window).push(row);
    }
    const recent = (a, b) => b.state_at - a.state_at || a.title.localeCompare(b.title);
    const active = row => totals.get(row.key) || 0;
    const sort = {activity: recent, total: (a, b) => active(b) - active(a) || recent(a, b)}[order]
        || ((a, b) => completionTime(b) - completionTime(a) || recent(a, b));
    for (const project of projects.values()) {
        for (const rows of project.windows.values()) rows.sort(sort);
        project.windows = new Map([...project.windows].sort(([, a], [, b]) => sort(a[0], b[0])));
        project.review = new Set(project.rows.filter(row => row.unread.length).map(row => row.key)).size;
        project.completed = Math.max(...project.rows.map(completionTime));
        project.active = Math.max(...project.rows.map(row => row.state_at));
        project.total = [...new Set(project.rows.map(row => row.key))].reduce((n, key) => n + (totals.get(key) || 0), 0);
    }
    const by = {
        activity: (a, b) => b.active - a.active,
        total: (a, b) => b.total - a.total,
        review: (a, b) => Number(b.review > 0) - Number(a.review > 0) || b.completed - a.completed,
        completion: (a, b) => b.completed - a.completed,
        name: () => 0,
    }[order];
    return [...projects.values()].sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
}

// Filter: Agent and Project then pick one from a second list, matching either end of a message.
const MESSAGE_FILTERS = [['all', 'All'], ['unread', 'Unread'], ['agent', 'Agent'], ['project', 'Project']];

// The agents (sender or recipient), or the projects, that the messages involve.
function messageFilterValues(messages, kind) {
    const values = new Map();
    for (const m of messages) {
        for (const [key, title, project] of [[m.sender, m.sender_title, m.sender_project], [m.recipient, m.recipient_title, m.recipient_project]]) {
            if (kind === 'agent') values.set(key, `${PROVIDERS[key.split(':')[0]]?.[0] || '•'} ${title || key}${project ? ` · ${project}` : ''}`);
            else if (project) values.set(project, project);
        }
    }
    // By name, not by the provider symbol that leads an agent's label.
    const name = label => (kind === 'agent' ? label.slice(label.indexOf(' ') + 1) : label);
    return [...values].sort((a, b) => name(a[1]).localeCompare(name(b[1])));
}

// Messages by conversation pair, the pair with the newest message first; each pair oldest first, like a mail thread.
function messageThreads(messages, filter = 'all', value = null) {
    const keep = {unread: m => !m.read_at, agent: m => m.sender === value || m.recipient === value,
        project: m => m.sender_project === value || m.recipient_project === value}[filter];
    const threads = new Map();
    for (const message of keep ? messages.filter(keep) : messages) {
        const key = [message.sender, message.recipient].sort().join(' ');
        if (!threads.has(key)) threads.set(key, []);
        threads.get(key).push(message);
    }
    for (const items of threads.values()) items.sort((a, b) => a.at - b.at);
    return [...threads.values()].sort((a, b) => b.at(-1).at - a.at(-1).at);
}

// Open folders a new chat can start in: VS Code folders and terminal sessions' directories, most recently active first.
function infoFolders(snapshot) {
    const folders = new Map();
    for (const {window} of windowSummaries(snapshot))
        for (const root of window.kind === 'app' ? [] : window.roots || [])
            if (!folders.has(root)) folders.set(root, root.split('/').pop() || root);
    return [...folders];
}

// When a usage limit resets: a time today, else a weekday and time.
function resetTime(value) {
    const at = typeof value === 'number' ? value : Date.parse(value) / 1000;
    if (!at) return '';
    if (at < Date.now() / 1000) return 'reset since';
    const date = new Date(at * 1000);
    const time = date.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
    return at - Date.now() / 1000 < 20 * 3600 ? `resets ${time}` : `resets ${date.toLocaleDateString('en-US', {weekday: 'short'})} ${time}`;
}

function gitChanges(repo) {
    return repo.staged + repo.modified + repo.untracked + repo.conflicts;
}

// Repositories after filtering: 'changes' puts conflicts and unfinished operations first, then
// uncommitted or unpushed work, each by latest commit; 'recent' by latest commit; 'name' alphabetical.
function gitRepos(repos, order = 'changes', filter = 'all') {
    const keep = {changes: repo => !repo.error && gitChanges(repo) > 0, unpushed: repo => repo.ahead > 0}[filter];
    const urgency = repo => (repo.error || repo.conflicts || repo.operation ? 2 : gitChanges(repo) || repo.ahead ? 1 : 0);
    const recent = (a, b) => (b.commit_at || 0) - (a.commit_at || 0);
    const sort = {changes: (a, b) => urgency(b) - urgency(a) || recent(a, b), recent, name: () => 0}[order];
    return (keep ? repos.filter(keep) : [...repos]).sort((a, b) => sort(a, b) || a.name.localeCompare(b.name));
}

function gitDetail(repo) {
    const tracking = repo.upstream ? [repo.ahead && `↑${repo.ahead}`, repo.behind && `↓${repo.behind}`]
        .filter(Boolean).join(' ') || `even with ${repo.upstream}` : repo.remotes ? 'no upstream' : 'local only';
    const changes = [[repo.conflicts, 'conflicted'], [repo.staged, 'staged'], [repo.modified, 'modified'], [repo.untracked, 'untracked']]
        .filter(([n]) => n).map(([n, name]) => `${n} ${name}`).join(', ') || 'nothing uncommitted';
    return `${repo.branch || 'detached HEAD'} · ${tracking} · ${changes}`;
}

// Saved conversations by folder: most recent first, most active time first, or by folder name.
function historyGroups(rows, order = 'activity') {
    const value = order === 'total' ? row => row.active : row => row.last;
    const groups = new Map();
    for (const row of [...rows].sort((a, b) => value(b) - value(a))) {
        if (!groups.has(row.folder)) groups.set(row.folder, []);
        groups.get(row.folder).push(row);
    }
    const score = items => (order === 'total' ? items.reduce((n, row) => n + row.active, 0) : items[0].last);
    return new Map([...groups].sort(([folderA, a], [folderB, b]) => (order === 'name'
        ? a[0].project.localeCompare(b[0].project) || folderA.localeCompare(folderB) : score(b) - score(a))));
}

function historyDetail(row) {
    const started = new Date(row.started * 1000).toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
    return `${age(row.last)} · ${row.prompts} prompt${row.prompts === 1 ? '' : 's'} · ${duration(row.active)} active · started ${started}`;
}

function stateStyle(state) {
    if (state === 'working' || state === 'RUNNING') return 'working';
    if (state === 'waiting') return 'waiting';
    if (state === 'finished' || state === 'COMPLETED') return 'finished';
    if (state === 'failed' || state === 'FAILED' || state === 'FINISHED_INCOMPLETE') return 'failed';
    if (state === 'input needed' || state === 'approval needed') return 'attention';
    return 'muted';
}

// One entry per window (VS Code, terminal session or Codex app): its most urgent conversation state and latest activity.
function windowSummaries(snapshot, order = 'recent') {
    const urgency = ['review', 'attention', 'working', 'waiting', 'failed', 'finished', 'muted'];
    return snapshot.windows.map(window => {
        const rows = snapshot.rows.filter(row => row.window === window.id);
        const states = rows.map(row => row.unread.length ? 'review' : stateStyle(row.state));
        return {window, state: urgency.find(state => states.includes(state)) || 'muted',
            active: Math.max(0, ...rows.map(row => row.state_at))};
    }).sort((a, b) => (order === 'recent' ? b.active - a.active : 0) || a.window.workspace.localeCompare(b.window.workspace));
}

// Queues by project after filtering. 'completion' orders projects by the share of their since-last-turn
// queues that finished (1/1 above 8/9; equal shares by more finished), then queues by progress;
// 'activity' puts the most recently active first (queued and running count as active now); 'name' is alphabetical.
function queueGroups(queues, counts, order = 'completion', filter = 'all', now = Date.now() / 1000) {
    const keep = {active: q => !TERMINAL.has(q.state), finished: q => TERMINAL.has(q.state), counted: q => q.counted}[filter];
    const activity = q => (TERMINAL.has(q.state) ? q.ended || q.finished_at || q.started : now);
    const groups = new Map();
    for (const queue of keep ? queues.filter(keep) : queues) {
        if (!groups.has(queue.project)) groups.set(queue.project, []);
        groups.get(queue.project).push(queue);
    }
    const share = project => {
        const count = counts[project];
        return count?.total ? count.done / count.total : -1;
    };
    const latest = items => Math.max(...items.map(activity));
    for (const items of groups.values()) {
        items.sort(order === 'completion' ? (a, b) => b.pct - a.pct || activity(b) - activity(a)
            : order === 'activity' ? (a, b) => activity(b) - activity(a)
                : (a, b) => Number(TERMINAL.has(a.state)) - Number(TERMINAL.has(b.state)) || b.started - a.started);
    }
    const done = project => counts[project]?.done || 0;
    return [...groups].sort(([a, x], [b, y]) => (order === 'completion' ? share(b) - share(a) || done(b) - done(a)
        : order === 'activity' ? latest(y) - latest(x) : 0) || a.localeCompare(b));
}

// The single open VS Code window for a queue's project: one whose folder is the project, else one whose
// path contains it (the queue-count rule). History folders need an exact root. Null when none or
// ambiguous. Terminal and app windows (with a `kind`) cannot open or resume a folder.
function projectWindow(windows, project) {
    const editors = windows.filter(w => !w.kind);
    const named = editors.filter(w => (w.roots || []).some(root => root.split('/').pop() === project));
    const nested = editors.filter(w => (w.roots || []).some(root => root.split('/').includes(project)));
    const matches = named.length ? named : nested;
    return matches.length === 1 ? matches[0] : null;
}

function folderWindow(windows, folder) {
    const matches = windows.filter(w => !w.kind && (w.roots || []).includes(folder));
    return matches.length === 1 ? matches[0] : null;
}

function bytes(value) {
    if (!Number.isFinite(value)) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    for (; value >= 1024 && i < units.length - 1; i++) value /= 1024;
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// Busy cores over the job slots parallel-workers allows each host (its cores when the snapshot
// gives none), and memory used over total, for reachable hosts in scope. A host counts at most its
// slots busy, so work outside the cluster cannot fill it past full. `slotted` says every counted
// host had slots; `down` names every host that is unreachable or has lost the shared mount.
function clusterTotals(snapshot, scope = 'all') {
    const hosts = snapshot.hosts.filter(host => host.ok && host.cpu && (scope === 'all' || !host.local));
    const sum = value => hosts.reduce((n, host) => n + (value(host) || 0), 0);
    const limit = host => (Number.isInteger(host.slots) ? host.slots : host.cpu.cores);
    const slots = sum(limit);
    const busy = sum(host => Math.min(limit(host), host.cpu.cores * host.cpu.busy_pct / 100));
    const memory = sum(host => host.memory?.total_bytes);
    return {slots, busy, cpu: slots ? 100 * busy / slots : null,
        slotted: hosts.length > 0 && hosts.every(host => Number.isInteger(host.slots)),
        memory: memory ? 100 * sum(host => host.memory?.used_bytes) / memory : null,
        down: snapshot.hosts.filter(host => !host.ok || host.mount?.ok === false).map(host => host.id)};
}

function loadStyle(pct) {
    return pct >= 90 ? 'attention' : pct >= 50 ? 'working' : 'muted';
}

function usedPct(free, total) {
    return total ? 100 * (1 - free / total) : null;
}

// The shared drive's space, when its sampler reported it.
function sharedSpace(snapshot) {
    return snapshot.shared?.ok && snapshot.shared.disk?.total_bytes ? snapshot.shared.disk : null;
}

// The top-bar measures picked in `show`, in a fixed order: CPU and memory as clusterTotals counts them,
// and the fullest drive among hosts in scope and the shared drive. A lone CPU needs no caption.
function clusterBarParts(snapshot, show, scope = 'all') {
    const totals = clusterTotals(snapshot, scope);
    const disks = snapshot.hosts.filter(host => host.ok && host.disk && (scope === 'all' || !host.local))
        .map(host => usedPct(host.disk.root_free_bytes, host.disk.root_total_bytes));
    const shared = sharedSpace(snapshot);
    if (shared) disks.push(usedPct(shared.free_bytes, shared.total_bytes));
    const known = disks.filter(Number.isFinite);
    const values = {cpu: totals.cpu, memory: totals.memory, disk: known.length ? Math.max(...known) : null};
    const measures = [['cpu', 'cpu'], ['memory', 'mem'], ['disk', 'disk']].filter(([key]) => show.includes(key));
    const captioned = measures.length > 1 || measures[0]?.[0] !== 'cpu';
    return measures.map(([key, caption]) => ({key, value: values[key], caption: captioned ? caption : ''}));
}

// What needs a look on every host, whatever the top bar counts: unreachable, the shared mount lost,
// memory pressure at `memoryLevel` or worse, or a drive at least `diskPct` full, the shared drive
// included. `kind` picks the glyph (a drive's also shows `used`, 0-1); `critical` ones show red.
function clusterWarnings(snapshot, memoryLevel = 'warn', diskPct = 90) {
    const warnings = [];
    const add = (host, kind, text, critical, used = null) => warnings.push({host, kind, text, critical, used});
    const disk = (host, free, total) => {
        const used = usedPct(free, total);
        if (used >= diskPct) add(host, 'disk', `disk ${Math.round(used)}% full, ${bytes(free)} free`, used >= 98, used / 100);
    };
    for (const host of snapshot.hosts) {
        if (!host.ok) {
            add(host.id, 'down', host.error || 'unreachable', true);
            continue;
        }
        if (host.mount?.ok === false)
            add(host.id, 'unmounted', `shared drive unmounted${host.mount.since ? ` ${age(host.mount.since)}` : ''}`, true);
        const pressure = host.memory?.pressure;
        if (pressure === 'critical' || (pressure === 'warn' && memoryLevel === 'warn'))
            add(host.id, 'memory', `memory pressure ${pressure === 'warn' ? 'elevated' : pressure}`, pressure === 'critical');
        if (host.disk) disk(host.id, host.disk.root_free_bytes, host.disk.root_total_bytes);
    }
    const shared = sharedSpace(snapshot);
    if (shared) disk('shared', shared.free_bytes, shared.total_bytes);
    return warnings;
}

// Seconds in a typed duration such as 90m, 120h, 5d, 2w or 1d12h; a bare number counts hours. Null
// for anything else, zero included.
function parseDuration(text) {
    const value = text.replace(/\s+/g, '').toLowerCase();
    const units = {m: 60, h: 3600, d: 86400, w: 604800};
    const seconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 3600 : /^(\d+(\.\d+)?[mhdw])+$/.test(value)
        ? [...value.matchAll(/(\d+(?:\.\d+)?)([mhdw])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * units[unit], 0) : 0;
    return seconds > 0 ? Math.round(seconds) : null;
}

// `warnings` with the snoozed ones marked, and `snoozes` (`host:kind` to the second a snooze ends at
// the latest, or null) without those that ended: their warning cleared, or their time passed.
function applySnoozes(warnings, snoozes, now) {
    const key = warning => `${warning.host}:${warning.kind}`;
    const kept = Object.fromEntries(Object.entries(snoozes || {}).filter(([name, until]) =>
        warnings.some(warning => key(warning) === name) && (until === null || until > now)));
    return {snoozes: kept, warnings: warnings.map(warning => key(warning) in kept
        ? {...warning, snoozed: true, until: kept[key(warning)]} : warning)};
}

// The shared-drive sampler's figures, one row each: its caption, the current reading, and a note: what
// the adaptive pool is holding back for (`held`), or a graph's peak over `history`. Text is empty for
// a figure this snapshot lacks.
function sharedRows(shared, history = []) {
    const rate = value => `${bytes(value)}/s`;
    const peak = (...keys) => {
        const values = history.flatMap(reading => keys.map(key => reading[key])).filter(Number.isFinite);
        return values.length > 1 ? `peak ${rate(Math.max(...values))}` : '';
    };
    const {pool, disk, network, smbd, registry} = shared;
    const held = pool ? [pool.resource_state && pool.resource_state !== 'ok' && `resources ${pool.resource_state}`,
        pool.io_state && pool.io_state !== 'ok' && `I/O ${pool.io_state}`,
        pool.quarantined && `${pool.quarantined} quarantined`].filter(Boolean) : [];
    const slots = pool && (!Number.isFinite(pool.capacity) ? pool.state
        : [Number.isFinite(pool.in_use) ? `${pool.in_use} running of ${pool.capacity}` : `${pool.capacity} allowed`,
            pool.state !== 'active' && pool.state].filter(Boolean).join(' · '));
    return [
        {key: 'pool', caption: 'Job slots', text: slots, note: held.length ? `holding back: ${held.join(', ')}` : '', held: held.length > 0},
        {key: 'disk', caption: 'Drive I/O', note: peak('disk'), text: disk && [Number.isFinite(disk.bytes_per_s) && rate(disk.bytes_per_s),
            Number.isFinite(disk.ops_per_s) && `${Math.round(disk.ops_per_s)} ops/s`].filter(Boolean).join(' · ')},
        {key: 'network', caption: 'Network', note: peak('rx', 'tx'),
            text: network && `in ${rate(network.rx_bytes_per_s)} · out ${rate(network.tx_bytes_per_s)}`},
        {key: 'smbd', caption: 'File server', text: smbd && `${Math.round(smbd.cpu_pct)}% CPU · ${smbd.sessions} session${smbd.sessions === 1 ? '' : 's'}`},
        {key: 'registry', caption: 'Queues', text: registry && Number.isFinite(registry.active_queues)
            && `${registry.active_queues} active · ${registry.claimed_per_min} claimed / min · ${registry.completed_per_min} done / min`},
    ].map(row => ({held: false, ...row, text: row.text || '', note: row.note || ''}));
}

// `history` with this snapshot's shared-drive reading added, once per sample, keeping SHARED_WINDOW seconds.
function recordShared(history, shared) {
    if (!shared?.ok || !Number.isFinite(shared.updated) || history[history.length - 1]?.at === shared.updated) return history;
    return [...history, {at: shared.updated, disk: shared.disk?.bytes_per_s, rx: shared.network?.rx_bytes_per_s,
        tx: shared.network?.tx_bytes_per_s}].filter(reading => reading.at > shared.updated - SHARED_WINDOW);
}

// The `keys` of `history` over the last SHARED_WINDOW seconds, ending at the newest reading, on one
// scale from zero to their peak: the first as a filled line, any second as a plain line.
function paintSpark(cr, width, height, history, keys) {
    cr.setSourceRGBA(1, 1, 1, 0.06);
    cr.rectangle(0, 0, width, height);
    cr.fill();
    const end = history[history.length - 1]?.at;
    const peak = Math.max(1, ...history.flatMap(reading => keys.map(key => reading[key])).filter(Number.isFinite));
    const x = at => width * (1 - (end - at) / SHARED_WINDOW);
    const y = value => height - 1 - (height - 2) * value / peak;
    keys.forEach((key, index) => {
        const points = history.filter(reading => Number.isFinite(reading[key]));
        if (points.length < 2) return;
        const trace = () => points.forEach((p, i) => (i ? cr.lineTo(x(p.at), y(p[key])) : cr.moveTo(x(p.at), y(p[key]))));
        if (!index) {
            trace();
            cr.lineTo(x(points[points.length - 1].at), height);
            cr.lineTo(x(points[0].at), height);
            cr.closePath();
            cr.setSourceRGBA(0.51, 0.73, 0.98, 0.3);
            cr.fill();
        }
        trace();
        cr.setSourceRGBA(...(index ? [0.88, 0.91, 0.95, 0.8] : [0.51, 0.73, 0.98, 0.95]));
        cr.setLineWidth(index ? 1 : 1.3);
        cr.stroke();
    });
}

// The pool's job slots, one cell each: running ones blue, free ones faint, and any running past what
// it allows now amber. Cells too narrow to tell apart become one bar.
function paintSlots(cr, width, height, inUse, capacity) {
    const total = Math.max(inUse, capacity);
    if (!(total > 0)) return;
    const running = Math.min(inUse, capacity);
    const colors = [[0.51, 0.73, 0.98, 0.95], [1, 1, 1, 0.08], [0.96, 0.76, 0.42, 0.95]];
    const cell = (width - (total - 1)) / total;
    const spans = cell >= 2
        ? [...Array(total).keys()].map(i => [i * (cell + 1), cell, i < running ? 0 : i < capacity ? 1 : 2])
        : [[0, running, 0], [running, capacity - running, 1], [capacity, inUse - capacity, 2]]
            .filter(([, n]) => n > 0).map(([from, n, color]) => [width * from / total, width * n / total, color]);
    for (const [x, w, color] of spans) {
        cr.setSourceRGBA(...colors[color]);
        cr.rectangle(x, 0, w, height);
        cr.fill();
    }
}

// A cluster warning's kind drawn in `rgba`, its widget's text color: a drive filled as far as it is full
// (`used`, 0-1), a memory module, a crossed-out circle for a host that is down, the eject sign for a lost shared
// mount, a clock for a host gone quiet, and a warning sign for anything else. Also a sealed envelope for agent
// mail not yet read (`mail`) and an opened one for mail read (`mail-open`).
function paintGlyph(cr, size, kind, used, rgba) {
    const c = size / 2, r = size / 2 - 1.5;
    cr.setSourceRGBA(...rgba);
    cr.setLineWidth(1.5);
    const circle = () => {
        cr.arc(c, c, r, 0, 2 * Math.PI);
        cr.stroke();
    };
    if (kind === 'disk') {
        // A drive, filled as far as it is full.
        const left = 1.5, right = size - 1.5, ry = size * 0.14, top = 1 + ry, bottom = size - 1 - ry;
        const ellipse = (y, to = 2 * Math.PI) => {
            cr.save();
            cr.translate(c, y);
            cr.scale((right - left) / 2, ry);
            cr.arc(0, 0, 1, 0, to);
            cr.restore();
        };
        const level = bottom - (bottom - top) * Math.min(1, Math.max(0, used || 0));
        cr.rectangle(left, level, right - left, bottom - level);
        cr.fill();
        ellipse(bottom);
        cr.fill();
        ellipse(level);
        cr.fill();
        ellipse(top);
        cr.stroke();
        cr.moveTo(left, top);
        cr.lineTo(left, bottom);
        cr.moveTo(right, top);
        cr.lineTo(right, bottom);
        cr.stroke();
        ellipse(bottom, Math.PI);
        cr.stroke();
    } else if (kind === 'memory') {
        // The board with two chips on it, and its contacts below.
        const top = size * 0.2, board = size * 0.48;
        cr.rectangle(0.75, top + 0.75, size - 1.5, board - 1.5);
        cr.stroke();
        for (const x of [0.22, 0.56]) cr.rectangle(size * x, top + 3, size * 0.22, board - 6);
        cr.fill();
        for (let x = 2; x < size - 2; x += 2.5) cr.rectangle(x, top + board + 1, 1.2, size * 0.18);
        cr.fill();
    } else if (kind === 'down') {
        circle();
        const d = r * Math.SQRT1_2;
        cr.moveTo(c - d, c - d);
        cr.lineTo(c + d, c + d);
        cr.stroke();
    } else if (kind === 'unmounted') {
        cr.moveTo(c, size * 0.1);
        cr.lineTo(size - 1, size * 0.6);
        cr.lineTo(1, size * 0.6);
        cr.closePath();
        cr.fill();
        cr.rectangle(1, size * 0.72, size - 2, size * 0.18);
        cr.fill();
    } else if (kind === 'stale') {
        circle();
        cr.moveTo(c, c - r * 0.65);
        cr.lineTo(c, c);
        cr.lineTo(c + r * 0.55, c);
        cr.stroke();
    } else if (kind === 'mail') {
        const top = size * 0.2, bottom = size * 0.82;
        cr.rectangle(0.5, top, size - 1, bottom - top);
        cr.fill();
        cr.setSourceRGBA(0, 0, 0, 0.85);
        cr.setLineWidth(1.3);
        cr.moveTo(1, top + 0.8);
        cr.lineTo(c, top + (bottom - top) * 0.6);
        cr.lineTo(size - 1, top + 0.8);
        cr.stroke();
    } else if (kind === 'mail-open') {
        const fold = size * 0.45, bottom = size - 1.5;
        cr.setLineJoin(1);  // round
        cr.moveTo(1, fold);
        cr.lineTo(c, 1.5);
        cr.lineTo(size - 1, fold);
        cr.lineTo(size - 1, bottom);
        cr.lineTo(1, bottom);
        cr.closePath();
        cr.moveTo(1, fold);
        cr.lineTo(c, fold + (bottom - fold) * 0.6);
        cr.lineTo(size - 1, fold);
        cr.stroke();
    } else {
        cr.moveTo(c, 1);
        cr.lineTo(size - 0.5, size - 1);
        cr.lineTo(0.5, size - 1);
        cr.closePath();
        cr.fill();
        cr.setSourceRGBA(0, 0, 0, 0.85);
        cr.rectangle(c - 0.8, size * 0.36, 1.6, size * 0.3);
        cr.rectangle(c - 0.8, size * 0.72, 1.6, 1.6);
        cr.fill();
    }
}

// One bar per core on a faint track, colored like loadStyle.
function paintCores(cr, width, height, values) {
    const gap = values.length > 16 ? 1 : 2;
    const bar = values.length ? Math.max(1, (width - gap * (values.length - 1)) / values.length) : 0;
    values.forEach((pct, i) => {
        const x = i * (bar + gap);
        cr.setSourceRGBA(1, 1, 1, 0.07);
        cr.rectangle(x, 0, bar, height);
        cr.fill();
        const [r, g, b] = pct >= 90 ? [0.96, 0.76, 0.42] : pct >= 50 ? [0.51, 0.73, 0.98] : [0.62, 0.67, 0.74];
        const filled = Math.max(1, height * Math.min(100, Math.max(0, pct)) / 100);
        cr.setSourceRGBA(r, g, b, 0.9);
        cr.rectangle(x, height - filled, bar, filled);
        cr.fill();
    });
}

// Memory used, then cache, as fractions of the width.
function paintMemory(cr, width, height, used, cache) {
    for (const [x, w, rgba] of [[0, width, [1, 1, 1, 0.08]], [0, width * used, [0.51, 0.73, 0.98, 0.95]],
        [width * used, width * cache, [0.51, 0.73, 0.98, 0.35]]]) {
        cr.setSourceRGBA(...rgba);
        cr.rectangle(x, 0, w, height);
        cr.fill();
    }
}

// Left edges for labels of the given widths, each centred on its anchor where room allows,
// kept in order, `gap` apart and inside [0, total].
function spread(anchors, widths, total, gap) {
    const lefts = [];
    anchors.forEach((anchor, i) => lefts.push(Math.max(anchor - widths[i] / 2, i ? lefts[i - 1] + widths[i - 1] + gap : 0)));
    for (let i = lefts.length - 1; i >= 0; i--)
        lefts[i] = Math.min(lefts[i], (i < lefts.length - 1 ? lefts[i + 1] - gap : total) - widths[i]);
    return lefts;
}

// Swaps a widget's state color class, keeping its other classes.
function setTone(actor, tone) {
    if (actor._tone === tone) return;
    if (actor._tone) actor.remove_style_class_name(`tracker-${actor._tone}`);
    actor.add_style_class_name(`tracker-${tone}`);
    actor._tone = tone;
}

// Queues with failed jobs not yet rerun, by project name, most failures first.
function failedQueues(queues) {
    const groups = new Map();
    for (const queue of (queues || []).filter(q => q.failed > 0).sort((a, b) => b.failed - a.failed || a.label.localeCompare(b.label))) {
        if (!groups.has(queue.project)) groups.set(queue.project, []);
        groups.get(queue.project).push(queue);
    }
    return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

function failureDetail(queue) {
    return `${queue.failed} failed${queue.failed_at ? `, last ${queue.failed_at}` : ''} · ${queue.done} / ${queue.total} done · ${queue.state}`;
}

// A note for a project's agent: which jobs failed, where their queues are, and what to do next.
function failureReport(project, queues, cluster) {
    // Queue paths are relative to the shared drive, which the Macs mount at the same root.
    const root = cluster.hosts.find(host => !host.local && host.mount?.root)?.mount.root || '';
    const at = new Date(cluster.updated * 1000).toLocaleString('en-US',
        {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    const lines = [`Cluster jobs failed in ${project} (cluster monitor, ${at}):`];
    for (const queue of queues) {
        lines.push(`- ${queue.label}, batch ${queue.batch}: ${queue.failed} job${queue.failed === 1 ? '' : 's'} failed`
            + `${queue.failed_at ? `, newest at ${queue.failed_at}` : ''}; ${queue.done} of ${queue.total} done; ${queue.state}`
            + `${queue.rerun ? `; ${queue.rerun} already rerun` : ''}.`);
        lines.push(`  Queue: ${queue.path.startsWith('/') ? queue.path : `${root}/${queue.path}`}`);
    }
    lines.push('Failed means claimed but ended without a done marker, and not yet rerun by a later batch.');
    const down = clusterTotals(cluster).down;
    if (down.length) lines.push(`Hosts unreachable or without the shared mount now: ${down.join(', ')}.`);
    lines.push('Please review those jobs, then submit the remaining work with reconcile_queue_batch.sh as the '
        + 'parallel-workers documentation describes, without resubmitting overlapping work.');
    return lines.join('\n');
}

class Tracker {
    enable() {
        this._enabled = true;
        // A screen lock disables and re-enables this same object; disable() destroyed these widgets.
        this._body = this._pickerList = this._clusterBody = this._clusterCards = this._clusterBarSignature = null;
        this._cancel = new Gio.Cancellable();
        this._borrowed = new Map();
        this._returnsLoaded = false;
        this._filter = 'all';
        this._historyFilter = 'all';
        this._queueFilter = 'counted';
        this._gitFilter = 'all';
        this._messageFilter = 'all';
        // Info: what `agent-bar info` last returned and when, unfolded skills, and where new chats start.
        this._info = null;
        this._infoAt = 0;
        this._openSkills = new Set();
        this._infoProject = null;
        this._messageValue = null;
        // Message id -> whether it is unfolded, where the user has chosen.
        this._openMessages = new Map();
        // History folders start collapsed the first time they appear.
        this._historySeen = new Set();
        this._view = 'conversations';
        this._collapsedProjects = new Set();
        this._busy = false;
        this._button = new PanelMenu.Button(0.0, 'Agents');
        this._bar = new St.BoxLayout({style_class: 'agent-bar'});
        this._labels = {};
        this._ratios = {};
        for (const [key, style, initial] of [
            ...Object.keys(PROVIDERS).map(provider => [provider, 'tracker-quiet', '… / …']),
            ['working', 'tracker-working', '● …'], ['waiting', 'tracker-waiting', ''],
            ['queues', 'tracker-muted', 'Q …'],
        ]) {
            const label = new St.Label({text: initial, style_class: style,
                y_align: Clutter.ActorAlign.CENTER});
            this._labels[key] = label;
            if (key in PROVIDERS) {
                const badge = new St.BoxLayout({style_class: 'tracker-provider-ratio', visible: PINNED.includes(key)});
                badge.add_child(new St.Label({text: PROVIDERS[key][0],
                    style_class: `tracker-${key}`, y_align: Clutter.ActorAlign.CENTER}));
                badge.add_child(label);
                this._ratios[key] = badge;
                this._bar.add_child(badge);
            } else {
                if (key === 'working') this._bar.add_child(new St.Label({text: '│',
                    style_class: 'tracker-bar-divider', y_align: Clutter.ActorAlign.CENTER}));
                this._bar.add_child(label);
            }
        }
        this._labels.waiting.visible = false;
        // Chats whose agent mail waits for you to start a turn there; clicking it opens the dropdown on Messages.
        this._mail = new St.BoxLayout({style_class: 'tracker-mail', reactive: true, visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._mail.add_child(this._glyph('mail'));
        this._mailCount = new St.Label({style_class: 'tracker-attention', y_align: Clutter.ActorAlign.CENTER});
        this._mail.add_child(this._mailCount);
        this._bar.insert_child_above(this._mail, this._labels.waiting);
        // The press reaches the envelope before the button that opens the menu. An open menu's grab takes the
        // press first and only closes it, as on any top-bar button.
        this._mail.connect('button-press-event', () => {
            this._openOn = 'messages';
            return Clutter.EVENT_PROPAGATE;
        });
        this._button.add_child(this._bar);
        Main.panel.addToStatusArea('agent-bar', this._button, 2, 'left');
        this._nav = new PanelMenu.Button(0.0, 'Project windows');
        this._nav.add_child(new St.Label({text: '▾', style_class: 'tracker-nav-arrow', y_align: Clutter.ActorAlign.CENTER}));
        Main.panel.addToStatusArea('agent-bar-nav', this._nav, 4, 'left');
        this._nav.menu.box.add_style_class_name('tracker-nav-menu');
        // GNOME opens only a non-empty menu; the real rows are built on open.
        this._nav.menu.addMenuItem(this._item('Loading windows…'));
        this._nav.menu.connect('open-state-changed', (_menu, open) => { if (open) this._buildNav(); });
        this._clusterPath = CLUSTER;
        this._clusterButton = new PanelMenu.Button(0.0, 'Cluster status');
        const clusterBar = new St.BoxLayout({style_class: 'tracker-cluster-bar'});
        clusterBar.add_child(new St.Icon({icon_name: 'utilities-system-monitor-symbolic', icon_size: 14,
            style_class: 'tracker-cluster-icon', y_align: Clutter.ActorAlign.CENTER}));
        this._clusterValues = new St.BoxLayout({style_class: 'tracker-cluster-values', y_align: Clutter.ActorAlign.CENTER});
        // The most serious warning's glyph, and how many more there are.
        this._clusterAlert = new St.BoxLayout({style_class: 'tracker-cluster-warning', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._clusterGlyph = this._glyph('alert');
        this._clusterMore = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._clusterAlert.add_child(this._clusterGlyph);
        this._clusterAlert.add_child(this._clusterMore);
        this._sharedHistory = [];
        clusterBar.add_child(this._clusterValues);
        clusterBar.add_child(this._clusterAlert);
        this._clusterButton.add_child(clusterBar);
        this._clusterButton.visible = false;
        Main.panel.addToStatusArea('agent-bar-cluster', this._clusterButton, 3, 'left');
        this._clusterButton.menu.box.add_style_class_name('tracker-menu');
        this._clusterButton.menu.addMenuItem(this._item('Loading cluster status…'));
        this._clusterButton.menu.connect('open-state-changed', (_menu, open) => { if (open) this._buildCluster(); });
        // Each dropdown hangs from its button's left edge rather than from its middle.
        for (const button of [this._button, this._nav, this._clusterButton]) button.menu.setSourceAlignment(0);
        this._holdHoverSwitch();
        this._quick = new St.BoxLayout({style_class: 'tracker-quick'});
        // Shortcuts without room on the left continue at the start of the right-hand box.
        this._quickRight = new St.BoxLayout({style_class: 'tracker-quick tracker-quick-right'});
        this._quickButtons = [];
        this._quickHidden = [];
        this._quickMore = new St.Button({style_class: 'tracker-quick-button tracker-quick-more', can_focus: true,
            visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._quick.add_child(this._quickMore);
        // +N more lists the chats without a shortcut, hanging from where it sits.
        this._quickMenu = new PopupMenu.PopupMenu(this._quickMore, 0.0, St.Side.TOP);
        Main.uiGroup.add_actor(this._quickMenu.actor);
        this._quickMenu.actor.hide();
        Main.panel.menuManager.addMenu(this._quickMenu);
        this._quickMore.connect('clicked', () => this._toggleQuickMenu());
        this._position();
        this._loadSettings();
        this._applySettings();
        this._button.menu.box.add_style_class_name('tracker-menu');
        this._button.menu.addMenuItem(this._item('Loading conversations…'));
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            const tab = this._openOn;
            this._openOn = null;
            if (open) {
                // Each opening starts on a list, the last tab used unless settings say Conversations.
                this._page = null;
                this._picker = null;
                if (this._setting('openTab') === 'conversations') this._view = 'conversations';
                if (tab) this._view = tab;
                this._menuFocus = global.display.focus_window;
                this._menuSnapshot = this._snapshot;
                this._buildMenu();
            }
        });
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._read();
            if (this._setting('scheduler')) this._readCluster();
            return GLib.SOURCE_CONTINUE;
        });
        this._read();
        if (this._setting('scheduler')) this._readCluster();
        this._dbus = Gio.DBusExportedObject.wrapJSObject(INTERFACE, {
            Inspect: () => JSON.stringify({busy: this._busy, error: this._error,
                quick: {parent: !!this._quick.get_parent(), mapped: this._quick.mapped, signature: this._quickSignature,
                    buttons: this._quick.get_children().map(b => ({label: b.label, visible: b.visible}))},
                windows: (this._snapshot?.windows || []).map(w => {
                    const native = this._findWindow(w, false);
                    const rect = native?.get_frame_rect();
                    return {id: w.id, project: w.workspace, native: native?.get_description(),
                        monitor: native?.get_monitor(), rect: rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null,
                        borrowed: this._borrowed.get(w.id)};
                })}),
            Show: () => this._button.menu.open(), Hide: () => this._button.menu.close(),
            ActivateAsync: ([key, window], invocation) => {
                const row = this._snapshot?.rows.find(r => r.key === key && r.window === window);
                const action = row ? this._activate(row, this._snapshot) : Promise.resolve({ok: false, error: 'Conversation is not open'});
                action.then(result => invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)])))
                    .catch(error => invocation.return_dbus_error('io.github.nikvetr.AgentBar.Error', error.message));
            },
        });
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/AgentBar');
    }

    _holdHoverSwitch() {
        // GNOME switches to any panel menu the pointer enters, so the way down from a tracker
        // button into its dropdown can open a neighbour. Hover switches away from a tracker
        // dropdown wait for the pointer to rest; keyboard switches stay immediate.
        const manager = Main.panel.menuManager, change = manager._changeMenu;
        const ours = [this._button.menu, this._nav.menu, this._clusterButton.menu];
        const hold = {timer: 0, menu: null, own: Object.prototype.hasOwnProperty.call(manager, '_changeMenu')};
        hold.wrapper = menu => {
            // A keyboard switch follows key focus onto the new button; a hover switch does not.
            const focus = global.stage.get_key_focus();
            const hover = ours.includes(manager.activeMenu) && !(focus && menu.sourceActor.contains(focus));
            if (hover && hold.timer && hold.menu === menu) return;
            if (hold.timer) GLib.source_remove(hold.timer);
            hold.timer = 0;
            if (!hover) {
                change.call(manager, menu);
                return;
            }
            hold.menu = menu;
            hold.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MENU_SWITCH_DELAY, () => {
                hold.timer = 0;
                const [x, y] = global.get_pointer();
                const under = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
                if (manager.activeMenu && manager.activeMenu !== menu && menu.sourceActor?.contains(under))
                    change.call(manager, menu);
                return GLib.SOURCE_REMOVE;
            });
        };
        hold.restore = () => {
            if (hold.timer) GLib.source_remove(hold.timer);
            if (manager._changeMenu !== hold.wrapper) return;
            if (hold.own) manager._changeMenu = change;
            else delete manager._changeMenu;
        };
        manager._changeMenu = hold.wrapper;
        this._menuSwitch = hold;
    }

    _position() {
        // The clock's right-hand box is already full of command buttons and
        // indicators. The left-hand box keeps their text from being squeezed.
        const parent = Main.panel._leftBox;
        const actor = this._button.container;
        if (actor.get_parent() !== parent) {
            actor.get_parent()?.remove_child(actor);
            parent.add_child(actor);
        }
        // The cluster indicator, the window menu's arrow, then the review shortcuts follow the tracker.
        let previous = actor;
        for (const child of [this._clusterButton.container, this._nav.container, this._quick]) {
            child.get_parent()?.remove_child(child);
            parent.insert_child_above(child, previous);
            previous = child;
        }
        if (this._quickRight.get_parent() !== Main.panel._rightBox) {
            this._quickRight.get_parent()?.remove_child(this._quickRight);
            Main.panel._rightBox.insert_child_at_index(this._quickRight, 0);
        }
    }

    _setting(key) {
        const [, , , , fallback] = SETTINGS.find(([, name]) => name === key);
        return this._settings?.[key] ?? fallback;
    }

    _loadSettings() {
        this._settings = {};
        this._settingsError = null;
        try {
            const [, bytes] = GLib.file_get_contents(CONFIG);
            const saved = JSON.parse(ByteArray.toString(bytes));
            for (const [, key, , , fallback, options] of SETTINGS) {
                const valid = value => options.some(([option]) => option === value);
                if (Array.isArray(fallback) ? Array.isArray(saved[key]) && saved[key].every(valid) : valid(saved[key]))
                    this._settings[key] = saved[key];
            }
            // Set from the cluster dropdown's Snooze buttons, not from Settings.
            const snoozes = saved.clusterSnoozed;
            if (snoozes && typeof snoozes === 'object' && Object.values(snoozes).every(until => until === null || Number.isFinite(until)))
                this._settings.clusterSnoozed = snoozes;
        } catch (error) {
            if (!error.matches?.(GLib.FileError, GLib.FileError.NOENT)) this._settingsError = `Settings unreadable: ${error.message}`;
        }
    }

    _applySettings() {
        for (const actor of [this._bar, this._quick, this._quickRight, this._quickMenu.box, this._button.menu.box, this._nav.menu.box,
            this._clusterButton?.menu.box].filter(Boolean)) {
            if (this._setting('palette') === 'colorblind') actor.add_style_class_name('tracker-colorblind');
            else actor.remove_style_class_name('tracker-colorblind');
        }
        this._labels.queues.visible = this._queuesShown(this._snapshot);
        if (this._clusterButton) this._renderClusterBar();
        this._quickSignature = null;
        if (this._snapshot && !this._error) this._renderQuick(this._snapshot.rows);
    }

    // Whether queue counts show: the scheduler integration is on and parallel-workers is set up here.
    _queuesShown(snapshot) {
        return this._setting('queueBar') && this._setting('scheduler') && (snapshot?.scheduler ?? 'on') === 'on';
    }

    _saveSetting(key, value) {
        this._settings[key] = value;
        GLib.mkdir_with_parents(GLib.path_get_dirname(CONFIG), 0o700);
        GLib.file_set_contents(CONFIG, JSON.stringify(this._settings, null, 1));
        this._applySettings();
    }

    _renderSettings() {
        if (this._settingsError) this._section.addMenuItem(this._item(this._settingsError, 'tracker-warning'));
        for (const section of [...new Set(SETTINGS.map(([name]) => name))]) {
            this._section.addMenuItem(this._item(section, 'tracker-settings-section'));
            const card = new PopupMenu.PopupMenuSection();
            card.actor.add_style_class_name('tracker-settings-card');
            this._section.addMenuItem(card);
            for (const [, key, label, description, fallback, options] of SETTINGS.filter(([name]) => name === section)) {
                const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tracker-setting'});
                item._ornamentLabel?.hide();
                const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                text.add_child(new St.Label({text: label, style_class: 'tracker-setting-label'}));
                const detail = new St.Label({text: description, style_class: 'tracker-detail'});
                detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                text.add_child(detail);
                item.add_child(text);
                const segments = new St.BoxLayout({style_class: 'tracker-segments', y_align: Clutter.ActorAlign.CENTER});
                const multiple = Array.isArray(fallback);
                for (const [value, caption] of options) {
                    const current = this._setting(key);
                    const button = new St.Button({label: caption, can_focus: true, toggle_mode: true,
                        checked: multiple ? current.includes(value) : value === current, style_class: 'tracker-segment'});
                    // A multiple-choice segment toggles its value, keeping the options' order.
                    button.connect('clicked', () => {
                        this._saveSetting(key, multiple ? options.map(([option]) => option)
                            .filter(option => (option === value) !== current.includes(option)) : value);
                        this._later(() => this._renderRows());
                    });
                    segments.add_child(button);
                }
                item.add_child(segments);
                card.addMenuItem(item);
            }
        }
    }

    // A labelled copy of the top bar, then what each state, color and control means, drawn with
    // the same styles as the real ones so a palette change applies here too.
    _renderHelp() {
        const card = title => {
            this._section.addMenuItem(this._item(title, 'tracker-settings-section'));
            const section = new PopupMenu.PopupMenuSection();
            section.actor.add_style_class_name('tracker-settings-card');
            this._section.addMenuItem(section);
            return section;
        };
        const text = (value, style) => new St.Label({text: value, style_class: style, y_align: Clutter.ActorAlign.CENTER});
        const chip = (value, style) => text(value, `tracker-chip tracker-chip-${style}`);
        const icon = name => new St.Icon({icon_name: name, icon_size: 16, style_class: 'tracker-help-icon',
            y_align: Clutter.ActorAlign.CENTER});
        const dots = styles => styles.map(style => text('●', `tracker-${style}`));
        const row = (section, samples, description) => {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tracker-setting'});
            item._ornamentLabel?.hide();
            const sample = new St.BoxLayout({style_class: 'tracker-help-sample', y_align: Clutter.ActorAlign.CENTER});
            for (const actor of samples) sample.add_child(actor);
            item.add_child(sample);
            const label = text(description, 'tracker-help-text');
            label.x_expand = true;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            label.clutter_text.line_wrap = true;
            item.add_child(label);
            section.addMenuItem(item);
        };
        const quiet = this._setting('quietMinutes'), limit = this._setting('quickLimit');
        // Without the job scheduler integration, its parts of the guide go too.
        const scheduler = this._setting('scheduler');

        const top = card('Top bar');
        const figure = new St.BoxLayout({style_class: 'tracker-help-figure', x_expand: true});
        top.actor.add_child(figure);
        this._helpDiagram(figure);
        row(top, [text('2 / 14', 'tracker-help-bright'), text('0 / 3', 'tracker-quiet')],
            `Bright and bold when something needs you: a reply to review${scheduler ? ', or a queue that finished' : ''}. Gray when nothing has.`);
        row(top, [text(scheduler ? 'Q 3 / 9 ?' : '? / ?', 'tracker-help-bright')], scheduler
            ? 'A ? means its source stopped updating: the parallel-workers queue snapshot (start its monitor), or the agent-bar service when every count shows ?.'
            : 'A ? means the agent-bar service stopped updating.');
        row(top, [text('✳ project…', 'tracker-quick-button tracker-claude')], limit
            ? `Up to ${limit} chats needing review get a shortcut, as many as fit, the longest waiting first; clicking one brings that `
                + 'chat forward and clears it. They continue right of the middle when the left half is full; +2 more lists the rest.'
            : 'Review shortcuts are off (Settings › Top bar).');
        if (scheduler) row(top, [text('23%', 'tracker-muted'), text('64%', 'tracker-working'), text('94%', 'tracker-attention')],
            'Cluster CPU: busy cores over the job slots each host allows, a host counting at most full. '
            + 'Gray under 50%, blue from 50%, amber from 90%. Settings › Cluster adds memory and the fullest disk.'
            + (this._cluster ? '' : ' Shown once the parallel-workers collector runs.'));
        if (scheduler) row(top, [this._glyph('disk', 0.92), this._glyph('memory'), this._glyph('down', null, 'failed'),
            this._glyph('unmounted', null, 'failed'), text('+1', 'tracker-failed')],
            'A cluster warning, by kind: a drive nearly full (filled as far as it is), memory pressure, a host unreachable, '
            + 'or the shared drive unmounted. Red when critical; +1 counts the others. The dropdown names the hosts.');
        if (this._setting('messages')) row(top, [this._glyph('mail', null, 'attention'), text('2', 'tracker-attention')],
            'Messages from other agents wait in 2 chats until you start a turn there, with no wake-up coming: waking off, '
            + 'a Claude chat idle over 2 h, or a Codex chat not open in VS Code. Clicking it opens Messages.');
        row(top, [text('▾', 'tracker-nav-arrow'), ...dots(['attention', 'working', 'waiting', 'failed', 'finished'])],
            'Every VS Code window, terminal session, Codex app and Antigravity window, with a dot for its most urgent chat: '
            + 'needs review, working, waiting, failed, finished.');

        const chats = card('Chats');
        row(chats, Object.entries(PROVIDERS).map(([key, [symbol]]) => text(symbol, `tracker-${key}`)),
            `The provider, in the same color everywhere: ${Object.values(PROVIDERS).map(([symbol, name]) => `${symbol} ${name}`).join(', ')}. `
            + 'Claude and Codex always have a top-bar count; the others appear while one of their chats is open.');
        row(chats, [text('· terminal', 'tracker-detail'), text('· Codex app', 'tracker-detail')],
            'Chats in VS Code tabs, plus Claude Code, Codex or Copilot in a terminal, the Codex app, and Antigravity\'s IDE, App or CLI. '
            + 'Clicking those brings their window '
            + 'forward; among terminal windows that share one terminal program, the one titled after the chat.');
        row(chats, [chip('Needs review', 'attention')],
            'A reply finished, a turn failed, or it needs your input. Its row gets an amber edge; opening the chat or sending it a message clears it.');
        if (scheduler) row(chats, [text('Queues finished', 'tracker-reason tracker-attention')],
            'Every queue its project launched since the last turn there has finished, with no turn since. It goes to the project\'s '
            + 'most recently active chat; any reason other than a finished reply is named like this under the chat\'s title.');
        row(chats, [chip('Working', 'working')], 'Replying or running tools. Counted by ● in the top bar.');
        row(chats, [chip('Waiting', 'waiting')], `${quiet ? `Open but quiet for ${quiet} min, or ended` : 'Ended'} with `
            + 'background commands, subagents, monitors or a wake-up still pending. Replies to those wake-ups need no review. Counted by ◌.');
        row(chats, [chip('Input needed', 'attention')], 'Asked you a question or for approval to run a tool.');
        row(chats, [chip('Finished', 'finished')], 'The turn ended and you have seen the reply.');
        row(chats, [chip('Failed', 'failed')], 'The turn ended in an error.');
        row(chats, [chip('Interrupted', 'muted'), chip('Unknown', 'muted')],
            'You stopped the turn, or no status has arrived yet (an older Claude chat may need /hooks).');

        const controls = card('Controls');
        row(controls, [icon('window-maximize-symbolic')], 'Show the window maximized and in front on the main display, without changing chats.');
        row(controls, [icon('window-restore-symbolic')], 'Return the window to its previous place, size, display and workspace.');
        row(controls, [icon('view-fullscreen-symbolic'), icon('view-restore-symbolic'), text('⌄ ›', 'tracker-muted')],
            'Expand or collapse every group; ⌄ and › show one group\'s state, and clicking its header toggles it.');
        const picker = new St.BoxLayout({style_class: 'tracker-picker tracker-picker-active tracker-picker-content', y_align: Clutter.ActorAlign.CENTER});
        for (const [value, style] of [['Filter:', 'tracker-picker-caption'], ['Review', 'tracker-picker-value'], ['▾', 'tracker-picker-caption']])
            picker.add_child(text(value, style));
        row(controls, [picker], 'Sort is saved for each tab. A tinted Filter means the list is narrowed.');
        row(controls, [text('click to return', 'tracker-detail')], this._setting('focusedClick') === 'return'
            ? 'Clicking a chat selects it and maximizes its window on the main display; clicking it again while focused sends the window back.'
            : 'Clicking a chat selects it and maximizes its window on the main display.');
        row(controls, [chip('Open', 'open'), chip('Resume', 'muted')],
            'History: Open brings an open chat forward; Resume reopens a closed one in VS Code on its folder.');
        row(controls, [icon('view-refresh-symbolic')], 'Rescan saved conversations now. History also rescans nightly.');

        if (this._setting('git')) {
            const git = card('Git');
            row(git, [chip('3 changed', 'working')], 'Each repository holding an open project, with its uncommitted files: '
                + 'staged, modified, untracked or conflicted.');
            row(git, [chip('Unpushed', 'waiting'), chip('Clean', 'finished')], 'Commits not yet pushed, or nothing to commit or push. '
                + '↑↓ count commits ahead of and behind its upstream as of the last fetch; Agent Bar never fetches.');
            row(git, [chip('Conflicts', 'failed'), chip('Rebasing', 'attention')], 'A merge conflict, or a rebase, merge or cherry-pick left unfinished.');
            row(git, [icon('external-link-symbolic')], 'Open the repository\'s page on its remote. Clicking the row shows its VS Code window\'s Source Control.');
        }

        if (this._setting('messages')) {
            const letters = card('Messages');
            row(letters, [text('✉ 2 unread', 'tracker-detail')], 'Messages from other chats wait for this one. It sees their count when '
                + 'its next turn starts, from you or an automatic wake-up, and reads them with `agent-bar inbox`.');
            row(letters, [this._glyph('mail', null, 'attention'), this._glyph('mail', null, 'help-bright'), this._glyph('mail-open', null, 'muted')],
                'On a thread\'s chats: messages to it unread, waiting for you to start a turn there (amber) or for a wake-up; '
                + 'opened once it has read them all.');
            row(letters, [chip('Unread', 'attention'), chip('Read', 'muted')], 'In Messages, by pair of chats. A chat can send at most 3 '
                + 'to another between your prompts to it, and 10 an hour; agents are told to treat them as information, not instructions.');
            const reset = new St.Label({text: 'Reset limit', style_class: 'tracker-filter tracker-reset-limit', y_align: Clutter.ActorAlign.CENTER});
            row(letters, [reset], 'When a pair reaches that limit, its header says so and how many sends were held back; the sending agent is told '
                + 'to ask you. Reset limit allows another round without writing to either chat.');
            row(letters, [text(this._setting('wake') ? 'Wake: on' : 'Wake: off', 'tracker-detail')], 'With Settings › Integrations › Wake idle '
                + 'chats on, a message starts a turn in an idle Claude Code chat (up to 2 h after its last turn), once per message, and in a Codex '
                + 'chat open in VS Code, once any turn in progress ends.');
        }

        // The rest describes the job scheduler integration.
        if (!scheduler) return;

        const queues = card('Queues');
        const track = new St.Widget({style_class: 'tracker-progress tracker-help-progress', y_align: Clutter.ActorAlign.CENTER});
        const fill = new St.Widget({style_class: 'tracker-progress-fill tracker-progress-working'});
        fill.set_width(72);
        track.add_child(fill);
        row(queues, [track], 'Jobs done of the total, colored by state; the line beside it adds workers, run time and ETA while active.');
        row(queues, [chip('RUNNING', 'working')], 'Workers are running its jobs.');
        row(queues, [chip('PENDING', 'muted')], 'Unfinished with no running workers: paused, blocked or waiting for capacity.');
        row(queues, [chip('DRAINING', 'muted')], 'Winding down: waiting on running jobs or reservations, or held during pool maintenance.');
        row(queues, [chip('COMPLETED', 'finished')], 'Every job succeeded.');
        row(queues, [chip('FINISHED_INCOMPLETE', 'failed')], 'Nothing left running, but some jobs have no success marker. FAILED is red too.');
        row(queues, [chip('KILLED', 'muted'), chip('UNLISTED', 'muted')],
            'Stopped, or an active queue the monitor no longer lists (outcome unknown). Both count as finished.');
        row(queues, [text('3 failed, last 12:19', 'tracker-detail')],
            'Jobs that ended without a done marker and are not yet rerun, with the time of the newest.');
        row(queues, [text('Q 2 / 5', 'tracker-attention tracker-project-total')],
            'A project\'s queues finished / outstanding since its last turn. A new turn there, from either provider, drops queues that already finished; other filters show those dimmed.');

        const cluster = card('Cluster dropdown');
        row(cluster, dots(['finished', 'attention', 'failed']),
            'A host is fine, has a warning, or is unreachable. Warnings are listed first, each with its sign from the top bar; '
            + 'a clock marks a host that stopped updating. Snooze keeps one off the top bar until it clears, or for at most '
            + 'a time you type (90m, 120h, 5d, 2w; a bare number is hours); snoozed ones follow, gray.');
        row(cluster, [this._drawing((cr, width, height) => paintCores(cr, width, height, [18, 42, 63, 78, 91, 97, 55, 30]),
            {width: 120, height: 24})], 'One bar per core, colored like the CPU percentage.');
        row(cluster, [this._drawing((cr, width, height) => paintMemory(cr, width, height, 0.55, 0.2), {width: 120, height: 6})],
            'Memory used (solid) and cache (faint); disk used in the same blue.');
        const sample = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ({at: i * SHARED_WINDOW / 9, rx: [2, 3, 9, 14, 8, 5, 6, 12, 7, 4][i],
            tx: [1, 1, 2, 3, 2, 1, 1, 2, 2, 1][i]}));
        row(cluster, [this._drawing((cr, width, height) => paintSlots(cr, width, height, 9, 8), {width: 120, height: 10})],
            'Shared drive: the adaptive pool\'s job slots, running (blue) of those it allows now. It lowers that while '
            + 'it holds back for resources or I/O, so running jobs can pass it (amber).');
        row(cluster, [this._drawing((cr, width, height) => paintSpark(cr, width, height, sample, ['rx', 'tx']), {width: 120, height: 20})],
            'The drive\'s throughput and its host\'s network over the last 10 minutes, each scaled to its peak: '
            + 'network in filled, out as a line. Kept while the panel runs.');
        row(cluster, [text('12 failed', 'tracker-failed'), icon('edit-copy-symbolic')],
            'Failed jobs not yet rerun, by project. Copy puts a note for that project\'s agent on the clipboard: queues, batches, paths, and hosts down. '
            + 'The window buttons bring the project\'s VS Code window forward or send it back.');
    }

    // The top bar built from its own styles, with a leader line from each part to a label alternately
    // above and below it. Measured as it is built, so `parent` must already be on the stage.
    _helpDiagram(parent) {
        const width = 616, rise = 26, callout = 128, pad = 14;
        const diagram = new St.Widget({layout_manager: new Clutter.FixedLayout(), x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        parent.add_child(diagram);
        const lines = new St.DrawingArea();
        const bar = new St.Widget({style_class: 'tracker-help-bar'});
        diagram.add_child(lines);
        diagram.add_child(bar);
        const text = (value, style) => new St.Label({text: value, style_class: style});
        const ratio = (symbol, provider, value, style) => {
            const box = new St.BoxLayout({style_class: 'tracker-provider-ratio'});
            box.add_child(text(symbol, `tracker-${provider}`));
            box.add_child(text(value, style));
            return box;
        };
        const cluster = new St.BoxLayout({style_class: 'tracker-cluster-bar'});
        cluster.add_child(new St.Icon({icon_name: 'utilities-system-monitor-symbolic', icon_size: 14, style_class: 'tracker-cluster-icon'}));
        cluster.add_child(text('58%', 'tracker-working'));
        cluster.add_child(this._glyph('disk', 0.92));
        const mail = new St.BoxLayout({style_class: 'tracker-mail'});
        mail.add_child(this._glyph('mail', null, 'attention'));
        mail.add_child(text('1', 'tracker-attention'));
        // [part, label title, title style, label detail]; a part without a title is not labelled.
        const parts = [
            [ratio('✳', 'claude', '2 / 14', 'tracker-help-bright'), 'Claude chats', 'tracker-claude', 'needing review / open'],
            [ratio('⌘', 'codex', '0 / 11', 'tracker-quiet'), 'Codex chats', 'tracker-codex', 'needing review / open'],
            [text('│', 'tracker-bar-divider')],
            [text('● 3', 'tracker-working'), '● Working', 'tracker-working', 'replying or running tools'],
            [text('◌ 1', 'tracker-waiting'), '◌ Waiting', 'tracker-waiting', 'quiet, or background work pending'],
            ...this._setting('messages') ? [[mail, 'Mail', 'tracker-attention', 'waits for you to start a turn']] : [],
            ...this._setting('scheduler') ? [
                [text('Q 4 / 9', 'tracker-help-bright'), 'Q Queues', 'tracker-help-bright', 'finished / outstanding since last turn'],
                [cluster, 'Cluster', 'tracker-working', 'with a sign when a host needs a look']] : [],
            [text('▾', 'tracker-nav-arrow'), '▾ Windows', 'tracker-help-bright', 'every chat window'],
            [text('✳ my-project…', 'tracker-quick-button tracker-claude'), 'Review shortcut', 'tracker-claude', 'jumps to a chat with a new reply'],
        ];
        // Callouts alternate above and below the bar; each row's narrow to sit side by side in the width.
        const across = Math.ceil(parts.filter(([, title]) => title).length / 2);
        const labelWidth = Math.min(callout, Math.floor((width - 10 * (across - 1)) / across));
        const sizes = parts.map(([actor]) => {
            actor.add_style_class_name('tracker-help-part');
            diagram.add_child(actor);
            return [actor.get_preferred_width(-1)[1], actor.get_preferred_height(-1)[1]];
        });
        const used = sizes.reduce((n, [w]) => n + w, 0);
        // Spreading the parts across the width leaves their labels less to fan out.
        const spacing = Math.min(26, Math.max(12, (width - 2 * pad - used) / (parts.length - 1)));
        const barWidth = Math.round(used + spacing * (parts.length - 1) + 2 * pad);
        const barHeight = Math.max(...sizes.map(([, h]) => h)) + 14;
        const labels = [];
        parts.forEach(([, title, style, detail], index) => {
            if (!title) return;
            const box = new St.BoxLayout({vertical: true, style_class: 'tracker-help-callout', width: labelWidth});
            for (const [value, classes] of [[title, `tracker-help-callout-title ${style}`], [detail, 'tracker-help-callout-detail']]) {
                // Centred as a whole: text alignment alone leaves a line that fits unwrapped at the left.
                const label = text(value, classes);
                label.x_align = Clutter.ActorAlign.CENTER;
                label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                label.clutter_text.line_wrap = true;
                box.add_child(label);
            }
            diagram.add_child(box);
            labels.push({box, index, above: labels.length % 2 === 0, height: box.get_preferred_height(labelWidth)[1]});
        });
        const tier = above => labels.filter(label => label.above === above);
        const tallest = above => Math.max(0, ...tier(above).map(label => label.height));
        const barX = Math.round((width - barWidth) / 2), barY = tallest(true) + rise;
        const belowY = barY + barHeight + rise;
        bar.set_position(barX, barY);
        bar.set_size(barWidth, barHeight);
        let x = barX + pad;
        const anchors = sizes.map(([w, h], i) => {
            parts[i][0].set_position(Math.round(x), barY + Math.round((barHeight - h) / 2));
            x += w + spacing;
            return x - spacing - w / 2;
        });
        for (const above of [true, false]) {
            const row = tier(above);
            spread(row.map(label => anchors[label.index]), row.map(() => labelWidth), width, 10).forEach((left, i) => {
                row[i].box.set_position(Math.round(left), above ? barY - rise - row[i].height : belowY);
                Object.assign(row[i], {from: anchors[row[i].index], to: left + labelWidth / 2});
            });
        }
        const height = belowY + tallest(false);
        diagram.set_size(width, height);
        lines.set_size(width, height);
        // Every curve has the same vertical profile and the labels keep the parts' order, so none cross.
        lines.connect('repaint', area => {
            const cr = area.get_context();
            cr.setLineWidth(1);
            cr.setSourceRGBA(0.62, 0.67, 0.74, 0.6);
            for (const label of labels) {
                const [start, end] = label.above ? [barY, barY - rise + 3] : [barY + barHeight, belowY - 3];
                const middle = (start + end) / 2;
                cr.moveTo(label.from, start);
                cr.curveTo(label.from, middle, label.to, middle, label.to, end);
                cr.stroke();
                cr.arc(label.from, start, 2.2, 0, 2 * Math.PI);
                cr.fill();
            }
            cr.$dispose();
        });
    }

    _buildNav() {
        this._releaseFocus(this._nav.menu);
        this._nav.menu.removeAll();
        const snapshot = this._snapshot;
        if (!snapshot || this._error) {
            this._nav.menu.addMenuItem(this._item(this._error || 'Waiting for the agent-bar service', 'tracker-warning'));
            return;
        }
        for (const {window, state, active} of windowSummaries(snapshot, this._setting('windowOrder'))) {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'tracker-nav-item'});
            item._ornamentLabel?.hide();
            item.add_child(new St.Label({text: '●', y_align: Clutter.ActorAlign.CENTER,
                style_class: `tracker-${state === 'review' ? 'attention' : state}`}));
            const name = new St.Label({text: window.kind === 'terminal' ? `${window.workspace} · terminal`
                : window.kind === 'ide' ? `${window.workspace} · ${window.label}` : window.workspace,
                x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            item.add_child(name);
            item.add_child(new St.Label({text: active ? age(active) : '', style_class: 'tracker-detail',
                y_align: Clutter.ActorAlign.CENTER}));
            item.connect('activate', () => {
                if (this._setting('windowClick') === 'place') {
                    this._activate({window: window.id, key: null}, snapshot, 'place');
                    return;
                }
                try { Main.activateWindow(this._findWindow(window)); }
                catch (error) { Main.notifyError('Agent Bar', error.message); }
            });
            this._nav.menu.addMenuItem(item);
        }
    }

    // A rebuild run from inside a click would destroy the widget still handling that click.
    _later(callback) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._enabled) callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Shell 42 crashed reading a freed keyboard-focus actor while switching top-bar menus. Before
    // destroying widgets under `container` (default: the menu's box), hand focus to the open menu itself.
    _releaseFocus(menu, container = menu.box) {
        const focus = global.stage?.get_key_focus();
        if (!focus || !container.contains(focus)) return;
        global.stage.set_key_focus(menu?.isOpen ? menu.actor : null);
    }

    _readCluster() {
        if (this._readingCluster) return;
        this._readingCluster = true;
        Gio.File.new_for_path(this._clusterPath).load_contents_async(this._cancel, (file, result) => {
            this._readingCluster = false;
            if (!this._enabled) return;
            try {
                const [, bytes] = file.load_contents_finish(result);
                const cluster = JSON.parse(ByteArray.toString(bytes));
                if (cluster.schema !== 1 || !Array.isArray(cluster.hosts)) throw new Error('Unsupported cluster snapshot');
                this._cluster = cluster;
                this._clusterError = null;
                this._sharedHistory = recordShared(this._sharedHistory, cluster.shared);
                // Forget ended snoozes, judging a cleared warning only from a current, populated snapshot.
                const saved = this._settings.clusterSnoozed || {};
                const {snoozes} = this._clusterAlerts(cluster);
                if (cluster.hosts.length && Date.now() / 1000 - cluster.updated <= CLUSTER_STALE
                    && Object.keys(snoozes).length < Object.keys(saved).length)
                    this._saveSetting('clusterSnoozed', snoozes);
            } catch (error) {
                // No snapshot means no collector yet: stay hidden rather than show an error.
                this._cluster = null;
                this._clusterError = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ? null : error.message;
            }
            this._renderClusterBar();
            if (this._clusterButton.menu.isOpen) this._updateCluster();
        });
    }

    // The cluster's warnings at the set thresholds, snoozed ones marked, and the snoozes still in force.
    _clusterAlerts(cluster) {
        const warnings = clusterWarnings(cluster, this._setting('clusterMemoryWarn'), this._setting('clusterDiskWarn'));
        return applySnoozes(warnings, this._settings.clusterSnoozed, Date.now() / 1000);
    }

    // Snoozes a `host:kind` warning until it clears or, sooner, `seconds` pass; null sets no time, and
    // undefined ends the snooze.
    _setSnooze(key, seconds) {
        const snoozes = {...this._settings.clusterSnoozed};
        if (seconds === undefined) delete snoozes[key];
        else snoozes[key] = seconds === null ? null : Math.round(Date.now() / 1000 + seconds);
        if (this._clusterCards) this._clusterCards.choosing = this._clusterCards.typed = null;
        this._saveSetting('clusterSnoozed', snoozes);
        if (this._clusterButton.menu.isOpen) this._updateCluster();
    }

    // The picked measures, each colored by its load, then the most serious warning and how many more.
    // An unreadable snapshot shows ? and a warning; a stale one shows its last values gray with a ?.
    _renderClusterBar() {
        const show = this._setting('clusterBar');
        const cluster = this._cluster;
        const parts = cluster ? clusterBarParts(cluster, show, this._setting('clusterHosts'))
            : show.length && this._clusterError ? [{key: 'cpu', value: null, caption: ''}] : [];
        const warnings = cluster && show.includes('warnings')
            ? this._clusterAlerts(cluster).warnings.filter(warning => !warning.snoozed)
                .sort((a, b) => Number(b.critical) - Number(a.critical)) : [];
        const stale = !!cluster && Date.now() / 1000 - cluster.updated > CLUSTER_STALE;
        this._clusterButton.visible = this._setting('scheduler') && (parts.length > 0 || warnings.length > 0);
        const pct = value => (value === null ? '?' : `${Math.round(value)}%`);
        const signature = JSON.stringify(parts.map(part => part.caption));
        if (signature !== this._clusterBarSignature) {
            this._clusterBarSignature = signature;
            this._clusterValues.destroy_all_children();
            this._clusterParts = parts.map(part => {
                const box = new St.BoxLayout({style_class: 'tracker-cluster-part', y_align: Clutter.ActorAlign.CENTER});
                const value = new St.Label({y_align: Clutter.ActorAlign.CENTER});
                box.add_child(value);
                if (part.caption) box.add_child(new St.Label({text: part.caption, style_class: 'tracker-cluster-caption',
                    y_align: Clutter.ActorAlign.CENTER}));
                this._clusterValues.add_child(box);
                return value;
            });
        }
        parts.forEach((part, index) => {
            const label = this._clusterParts[index];
            label.text = pct(part.value) + (stale && index === parts.length - 1 ? ' ?' : '');
            label.style_class = stale || part.value === null ? 'tracker-muted' : `tracker-${loadStyle(part.value)}`;
        });
        const [first] = warnings;
        this._clusterAlert.visible = warnings.length > 0 || (!cluster && !!this._clusterError);
        const tone = !first || first.critical ? 'failed' : 'attention';
        this._setGlyph(this._clusterGlyph, first ? first.kind : 'alert', first?.used, tone);
        setTone(this._clusterMore, tone);
        this._clusterMore.text = warnings.length > 1 ? `+${warnings.length - 1}` : '';
        this._clusterMore.visible = warnings.length > 1;
        this._clusterButton.accessible_name = ['Cluster', ...parts.map(part => `${part.caption || 'cpu'} ${pct(part.value)}`),
            ...warnings.map(warning => `${warning.host} ${warning.text}`), ...!cluster && this._clusterError ? [this._clusterError] : []].join(', ');
    }

    // Builds the cluster dropdown once per opening, and again only when its hosts, layout or failed
    // queues change; other snapshots update it in place.
    _buildCluster() {
        const menu = this._clusterButton.menu;
        this._releaseFocus(menu);
        // removeAll() only drops menu items; the scrolled body is a plain actor.
        this._clusterBody?.destroy();
        this._clusterBody = null;
        menu.removeAll();
        this._clusterCards = null;
        const cluster = this._cluster;
        if (!cluster) {
            menu.addMenuItem(this._item(this._clusterError || 'No cluster snapshot yet', 'tracker-warning'));
            return;
        }
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header._ornamentLabel?.hide();
        header.add_style_class_name('tracker-heading');
        const heading = new St.BoxLayout({vertical: true, x_expand: true});
        heading.add_child(new St.Label({text: 'Cluster', style_class: 'tracker-heading-title'}));
        const subtitle = new St.Label({style_class: 'tracker-detail'});
        heading.add_child(subtitle);
        header.add_child(heading);
        const stats = {}, captions = {};
        for (const [key, caption] of [['cpu', 'CPU'], ['cores', 'busy cores'], ['memory', 'memory']]) {
            const stat = new St.BoxLayout({vertical: true, style_class: 'tracker-summary'});
            stats[key] = new St.Label({style_class: 'tracker-summary-value'});
            captions[key] = new St.Label({text: caption, style_class: 'tracker-detail'});
            stat.add_child(stats[key]);
            stat.add_child(captions[key]);
            header.add_child(stat);
        }
        menu.addMenuItem(header);
        const columns = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-cluster-grid'});
        // Warnings and stale hosts come first.
        const problems = new St.BoxLayout({vertical: true, x_expand: true, visible: false, style_class: 'tracker-cluster-group'});
        problems.add_child(new St.Label({text: 'Warnings', style_class: 'tracker-cluster-section'}));
        const problemList = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-cluster-card'});
        problems.add_child(problemList);
        columns.add_child(problems);
        const failures = this._clusterFailures(columns, cluster);
        // The shared drive's storage bar sits with the hosts' disks by measure, and in its own card by host.
        const sharedDisk = {dots: [], diskParts: [0, 0]};
        const byHost = this._setting('clusterLayout') === 'host';
        const cards = byHost ? this._clusterHosts(columns, cluster) : this._clusterMeasures(columns, cluster, sharedDisk);
        const shared = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-cluster-card'});
        const sharedHead = new St.BoxLayout({style_class: 'tracker-cluster-measure-row'});
        sharedHead.add_child(new St.Label({text: 'Shared drive', style_class: 'tracker-cluster-host', y_align: Clutter.ActorAlign.CENTER}));
        // The host that serves the drive takes every reading below.
        const sharedFrom = new St.Label({style_class: 'tracker-detail', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        sharedHead.add_child(sharedFrom);
        shared.add_child(sharedHead);
        if (byHost) {
            sharedDisk.diskNote = new St.Label({style_class: 'tracker-detail', y_align: Clutter.ActorAlign.CENTER});
            sharedDisk.diskValue = new St.Label({style_class: 'tracker-cluster-value', y_align: Clutter.ActorAlign.CENTER});
            sharedHead.add_child(sharedDisk.diskNote);
            sharedHead.add_child(sharedDisk.diskValue);
            sharedDisk.disk = this._drawing((cr, width, height) => paintMemory(cr, width, height, ...sharedDisk.diskParts),
                {style_class: 'tracker-cluster-line', x_expand: true});
            shared.add_child(sharedDisk.disk);
        }
        // One line per figure; wrapped labels lose lines inside the scrolled body.
        const sharedDetail = new St.Label({style_class: 'tracker-detail'});
        sharedDetail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        shared.add_child(sharedDetail);
        // Caption, graph, reading and note; a figure without a graph reads across all three, and what the
        // pool holds back for takes its own line, too long to share one.
        const sharedGrid = new Clutter.GridLayout({column_spacing: 12, row_spacing: 6});
        const sharedFigures = new St.Widget({layout_manager: sharedGrid, x_expand: true});
        const graphs = {
            pool: [(cr, width, height) => {
                const pool = this._cluster?.shared?.pool;
                if (pool) paintSlots(cr, width, height, pool.in_use || 0, pool.capacity || 0);
            }, 'tracker-cluster-slots'],
            disk: [(cr, width, height) => paintSpark(cr, width, height, this._sharedHistory, ['disk']), 'tracker-cluster-spark'],
            network: [(cr, width, height) => paintSpark(cr, width, height, this._sharedHistory, ['rx', 'tx']), 'tracker-cluster-spark'],
        };
        let line = 0;
        const sharedStats = sharedRows({}).map(({key, caption}) => {
            const label = (style, expand = false) => {
                const actor = new St.Label({style_class: style, x_expand: expand, y_align: Clutter.ActorAlign.CENTER});
                actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                return actor;
            };
            const name = label('tracker-detail tracker-cluster-stat-name');
            name.text = caption;
            const value = label('tracker-cluster-stat tracker-cluster-figure', !graphs[key]);
            const note = label('tracker-detail', true);
            const graph = graphs[key] && this._drawing(graphs[key][0], {style_class: graphs[key][1]});
            sharedGrid.attach(name, 0, line, 1, 1);
            if (graph) {
                sharedGrid.attach(graph, 1, line, 1, 1);
                sharedGrid.attach(value, 2, line, 1, 1);
            } else {
                sharedGrid.attach(value, 1, line, 3, 1);
            }
            if (key === 'pool') sharedGrid.attach(note, 1, ++line, 3, 1);
            else if (graph) sharedGrid.attach(note, 3, line, 1, 1);
            line++;
            return {key, name, value, note, graph};
        });
        shared.add_child(sharedFigures);
        columns.add_child(shared);
        this._clusterBody = new St.ScrollView({style_class: 'tracker-scroll', overlay_scrollbars: true, x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this._clusterBody.set_style(`max-height: ${Main.layoutManager.primaryMonitor.height - 200}px;`);
        this._clusterBody.add_actor(columns);
        menu.box.add_child(this._clusterBody);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const footer = this._item('', 'tracker-footer');
        footer.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        footer.label.clutter_text.line_wrap = true;
        menu.addMenuItem(footer);
        this._clusterCards = {signature: this._clusterSignature(cluster), cards, failures, stats, captions, subtitle,
            problems, problemList, sharedDisk, sharedFrom, sharedDetail, sharedFigures, sharedStats, footer};
        this._updateCluster();
    }

    // Also the window each failed project's card opens, which changes as windows open and close.
    _clusterSignature(cluster) {
        const windows = this._snapshot?.windows || [];
        return JSON.stringify([this._setting('clusterLayout'), cluster.hosts.map(host => host.id),
            [...failedQueues(cluster.queues)].map(([project, queues]) => [project, queues.map(q => [q.id, q.failed]),
                projectWindow(windows, project)?.id])]);
    }

    // A warning's glyph (see paintGlyph), drawn in its tone's text color.
    _glyph(kind, used = null, tone = 'attention') {
        const area = new St.DrawingArea({width: 14, height: 14, y_align: Clutter.ActorAlign.CENTER});
        area.connect('repaint', () => {
            const cr = area.get_context();
            const color = area.get_theme_node().get_foreground_color();
            paintGlyph(cr, Math.min(...area.get_surface_size()), area._kind, area._used,
                [color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255]);
            cr.$dispose();
        });
        area.connect('style-changed', () => area.queue_repaint());
        this._setGlyph(area, kind, used, tone);
        return area;
    }

    _setGlyph(area, kind, used, tone) {
        if (area._kind !== kind || area._used !== used) {
            area._kind = kind;
            area._used = used;
            area.queue_repaint();
        }
        setTone(area, tone);
    }

    // A drawn bar or strip; paint(cr, width, height) reads its values whenever it repaints.
    _drawing(paint, props) {
        const area = new St.DrawingArea({y_align: Clutter.ActorAlign.CENTER, ...props});
        area.connect('repaint', () => {
            const cr = area.get_context();
            paint(cr, ...area.get_surface_size());
            cr.$dispose();
        });
        return area;
    }

    // Queues with failed jobs not yet rerun, by project, each project with a copy-ready note for its
    // agent and, when it has one VS Code window, the Queues tab's controls for it. Returns each queue's
    // detail label for in-place updates.
    _clusterFailures(columns, cluster) {
        const details = new Map();
        const groups = failedQueues(cluster.queues);
        if (!groups.size) return details;
        const total = [...groups.values()].flat().reduce((n, queue) => n + queue.failed, 0);
        columns.add_child(new St.Label({style_class: 'tracker-cluster-section',
            text: `Failed jobs · ${total} in ${groups.size} project${groups.size === 1 ? '' : 's'}`}));
        for (const [project, queues] of groups) {
            const card = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-cluster-card'});
            const head = new St.BoxLayout({style_class: 'tracker-cluster-measure-row'});
            head.add_child(new St.Label({text: project, x_expand: true, style_class: 'tracker-cluster-host', y_align: Clutter.ActorAlign.CENTER}));
            head.add_child(new St.Label({text: `${queues.reduce((n, queue) => n + queue.failed, 0)} failed`,
                style_class: 'tracker-failed', y_align: Clutter.ActorAlign.CENTER}));
            // The note uses the snapshot current when it is copied.
            head.add_child(this._copyButton(() => {
                const latest = this._cluster || cluster;
                return failureReport(project, failedQueues(latest.queues).get(project) || queues, latest);
            }));
            const window = this._snapshot && projectWindow(this._snapshot.windows, project);
            if (window) head.add_child(this._windowControls(window.id, this._snapshot));
            card.add_child(head);
            for (const queue of queues) {
                const line = new St.BoxLayout({style_class: 'tracker-cluster-measure-row'});
                const name = new St.Label({text: `${queue.label} · batch ${queue.batch}`, x_expand: true,
                    style_class: 'tracker-cluster-queue', y_align: Clutter.ActorAlign.CENTER});
                name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                line.add_child(name);
                const detail = new St.Label({style_class: 'tracker-detail', y_align: Clutter.ActorAlign.CENTER});
                details.set(queue.id, detail);
                line.add_child(detail);
                card.add_child(line);
            }
            columns.add_child(card);
        }
        return details;
    }

    // Copies text(), confirming briefly on the button.
    _copyButton(text) {
        const label = new St.Label({text: 'Copy', y_align: Clutter.ActorAlign.CENTER});
        const content = new St.BoxLayout({style_class: 'tracker-copy-content'});
        content.add_child(new St.Icon({icon_name: 'edit-copy-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
        content.add_child(label);
        const button = new St.Button({child: content, can_focus: true, style_class: 'tracker-copy',
            accessible_name: 'Copy a note about these failures for the project\'s agent', y_align: Clutter.ActorAlign.CENTER});
        let timer = 0;
        button.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text());
            label.text = 'Copied';
            if (timer) GLib.source_remove(timer);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                timer = 0;
                label.text = 'Copy';
                return GLib.SOURCE_REMOVE;
            });
        });
        button.connect('destroy', () => { if (timer) GLib.source_remove(timer); });
        return button;
    }

    // One card per host, three to a row.
    _clusterHosts(columns, cluster) {
        const cards = new Map();
        let row = null;
        cluster.hosts.forEach((host, index) => {
            if (index % 3 === 0) {
                row = new St.BoxLayout({x_expand: true, style_class: 'tracker-cluster-row'});
                columns.add_child(row);
            }
            cards.set(host.id, this._clusterCard(row));
        });
        return cards;
    }

    _clusterCard(row) {
        const card = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-cluster-card'});
        const line = new St.BoxLayout();
        const dot = new St.Label({text: '●', y_align: Clutter.ActorAlign.CENTER});
        const name = new St.Label({x_expand: true, style_class: 'tracker-cluster-host', y_align: Clutter.ActorAlign.CENTER});
        const cpu = new St.Label({style_class: 'tracker-cluster-cpu', y_align: Clutter.ActorAlign.CENTER});
        for (const actor of [dot, name, cpu]) line.add_child(actor);
        card.add_child(line);
        const view = {dots: [dot], name, cpu, perCore: [], memoryParts: [0, 0]};
        // One drawn strip per host instead of an actor per core.
        view.cores = this._drawing((cr, width, height) => paintCores(cr, width, height, view.perCore),
            {style_class: 'tracker-cluster-cores', x_expand: true});
        card.add_child(view.cores);
        view.memory = this._drawing((cr, width, height) => paintMemory(cr, width, height, ...view.memoryParts),
            {style_class: 'tracker-cluster-memory', x_expand: true});
        card.add_child(view.memory);
        [view.detail, view.status] = [0, 1].map(() => {
            const label = new St.Label({style_class: 'tracker-detail'});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            card.add_child(label);
            return label;
        });
        row.add_child(card);
        return view;
    }

    // One card per measure with a row per host, so hosts compare at a glance; the Disk card ends
    // with the shared drive, whose row parts go into `sharedDisk`.
    _clusterMeasures(columns, cluster, sharedDisk) {
        const cards = new Map(cluster.hosts.map(host => [host.id, {dots: [], perCore: [], memoryParts: [0, 0], diskParts: [0, 0]}]));
        const measures = [
            ['CPU', 'cpu', 'load', view => (cr, width, height) => paintCores(cr, width, height, view.perCore), 'tracker-cluster-strip'],
            ['Memory', 'memoryValue', 'memoryNote', view => (cr, width, height) => paintMemory(cr, width, height, ...view.memoryParts), 'tracker-cluster-line'],
            ['Disk', 'diskValue', 'diskNote', view => (cr, width, height) => paintMemory(cr, width, height, ...view.diskParts), 'tracker-cluster-line'],
        ];
        for (const [title, value, note, paint, style] of measures) {
            columns.add_child(new St.Label({text: title, style_class: 'tracker-cluster-section'}));
            // A grid makes the note column as wide as the card's longest note; the bars take the rest.
            const grid = new Clutter.GridLayout({column_spacing: 10, row_spacing: 7});
            const card = new St.Widget({layout_manager: grid, x_expand: true, style_class: 'tracker-cluster-card'});
            const rows = cluster.hosts.map(host => [host.id, cards.get(host.id)]);
            if (title === 'Disk') rows.push(['shared', sharedDisk]);
            rows.forEach(([name, view], index) => {
                const dot = new St.Label({text: '●', y_align: Clutter.ActorAlign.CENTER});
                view.dots.push(dot);
                const area = this._drawing(paint(view), {style_class: style, x_expand: true});
                view[{CPU: 'cores', Memory: 'memory', Disk: 'disk'}[title]] = area;
                view[value] = new St.Label({style_class: 'tracker-cluster-value', y_align: Clutter.ActorAlign.CENTER});
                view[note] = new St.Label({style_class: 'tracker-detail', y_align: Clutter.ActorAlign.CENTER});
                const cells = [dot, new St.Label({text: name, style_class: 'tracker-cluster-host tracker-cluster-measure-host',
                    y_align: Clutter.ActorAlign.CENTER}), area, view[value], view[note]];
                cells.forEach((cell, column) => grid.attach(cell, column, index, 1, 1));
            });
            columns.add_child(card);
        }
        return cards;
    }

    _updateCluster() {
        const cluster = this._cluster;
        const view = this._clusterCards;
        if (!cluster || !view || view.signature !== this._clusterSignature(cluster)) {
            this._buildCluster();
            return;
        }
        const now = Date.now() / 1000;
        const totals = clusterTotals(cluster, this._setting('clusterHosts'));
        const pct = value => (value === null || value === undefined ? '?' : `${Math.round(value)}%`);
        // Host cards state every warning; snoozed ones leave the call to check a host and sink in the list.
        const {warnings} = this._clusterAlerts(cluster);
        const check = totals.down.filter(id => warnings.some(warning => warning.host === id && !warning.snoozed
            && ['down', 'unmounted'].includes(warning.kind)));
        view.subtitle.text = `${cluster.hosts.length} hosts · updated ${age(cluster.updated)}`
            + (check.length ? ` · check ${check.join(', ')}` : '');
        view.stats.cpu.text = pct(totals.cpu);
        view.stats.cpu.style_class = `tracker-summary-value tracker-${loadStyle(totals.cpu)}`;
        view.stats.cores.text = `${Math.round(totals.busy)} / ${totals.slots}`;
        view.captions.cores.text = totals.slotted ? 'busy / job slots' : 'busy cores';
        view.stats.memory.text = pct(totals.memory);
        const issues = [];
        for (const host of cluster.hosts) {
            const card = view.cards.get(host.id);
            const problems = warnings.filter(warning => warning.host === host.id);
            if (host.ok && now - host.updated > CLUSTER_STALE)
                problems.push({host: host.id, kind: 'stale', text: `no update for ${duration(Math.round(now - host.updated))}`, critical: false});
            issues.push(...problems);
            const tone = !host.ok ? 'failed' : problems.length ? 'attention' : 'finished';
            for (const dot of card.dots) setTone(dot, tone);
            const busy = host.ok && host.cpu ? host.cpu.busy_pct : null;
            card.perCore = host.cpu?.per_core || [];
            card.cores.queue_repaint();
            const {memory, disk} = host;
            card.memoryParts = memory ? [memory.used_bytes / memory.total_bytes, (memory.cache_bytes || 0) / memory.total_bytes] : [0, 0];
            card.memory.queue_repaint();
            const memoryText = memory ? `${bytes(memory.used_bytes)} / ${bytes(memory.total_bytes)}`
                + (memory.pressure && memory.pressure !== 'normal' ? ` · pressure ${memory.pressure === 'warn' ? 'elevated' : memory.pressure}` : '') : '';
            const load = host.load ? `load ${host.load[0].toFixed(1)}` : '';
            const diskText = disk ? `${bytes(disk.root_free_bytes)} free of ${bytes(disk.root_total_bytes)}` : '';
            if (card.status) {
                card.name.text = host.id;
                card.cpu.text = pct(host.cpu?.busy_pct);
                setTone(card.cpu, busy === null ? 'muted' : loadStyle(busy));
                // The status line names any memory pressure that is a warning.
                card.detail.text = [memory && `${bytes(memory.used_bytes)} / ${bytes(memory.total_bytes)}`, load].filter(Boolean).join(' · ');
                // Problems replace the routine disk line so they are not truncated away.
                card.status.text = problems.length ? problems.map(problem => problem.text).join(' · ') : diskText && `disk ${diskText}`;
                card.status.style_class = problems.length
                    ? `tracker-detail tracker-${problems.some(problem => problem.critical) ? 'failed' : 'attention'}` : 'tracker-detail';
                continue;
            }
            const memoryUsed = memory ? 100 * memory.used_bytes / memory.total_bytes : null;
            const diskUsed = disk ? usedPct(disk.root_free_bytes, disk.root_total_bytes) : null;
            card.diskParts = disk ? [diskUsed / 100, 0] : [0, 0];
            card.disk.queue_repaint();
            for (const [label, value] of [[card.cpu, busy], [card.memoryValue, memoryUsed], [card.diskValue, diskUsed]]) {
                label.text = pct(value);
                setTone(label, value === null ? 'muted' : loadStyle(value));
            }
            card.load.text = [Number.isInteger(host.slots) && `${host.slots} slots`, load].filter(Boolean).join(' · ');
            card.memoryNote.text = memoryText;
            card.diskNote.text = diskText;
        }
        const sharedWarnings = warnings.filter(warning => warning.host === 'shared');
        issues.push(...sharedWarnings);
        this._clusterWarningList(view, issues);
        for (const queue of cluster.queues || [])
            view.failures.get(queue.id)?.set_text(failureDetail(queue));
        const shared = cluster.shared;
        const drive = view.sharedDisk;
        const space = sharedSpace(cluster);
        const spaceUsed = space ? usedPct(space.free_bytes, space.total_bytes) : null;
        drive.diskParts = space ? [spaceUsed / 100, 0] : [0, 0];
        drive.disk.queue_repaint();
        drive.diskValue.text = pct(spaceUsed);
        setTone(drive.diskValue, spaceUsed === null ? 'muted' : loadStyle(spaceUsed));
        drive.diskNote.text = space ? `${bytes(space.free_bytes)} free of ${bytes(space.total_bytes)}` : '';
        for (const dot of drive.dots) setTone(dot, !shared ? 'muted' : !shared.ok ? 'failed' : sharedWarnings.length ? 'attention' : 'finished');
        const sampled = shared?.updated && now - shared.updated > CLUSTER_STALE ? ` · last sample ${age(shared.updated)}` : '';
        view.sharedFrom.text = shared?.host ? `served by ${shared.host}${sampled}` : '';
        view.sharedDetail.text = !shared ? 'No shared-drive data in this snapshot' : shared.error || 'Shared-drive sampler unavailable';
        view.sharedDetail.visible = !shared?.ok;
        const figures = shared?.ok ? sharedRows(shared, this._sharedHistory) : [];
        for (const stat of view.sharedStats) {
            const row = figures.find(figure => figure.key === stat.key);
            stat.value.text = row?.text || '';
            stat.note.text = row?.note || '';
            stat.note.style_class = row?.held ? 'tracker-detail tracker-attention' : 'tracker-detail';
            for (const actor of [stat.name, stat.value, stat.graph]) if (actor) actor.visible = !!stat.value.text;
            stat.note.visible = !!stat.value.text && !!stat.note.text;
            stat.graph?.queue_repaint();
        }
        view.sharedFigures.visible = figures.some(row => row.text);
        view.footer.label.text = `From the parallel-workers collector · CPU over ${totals.slotted ? 'job slots'
            : 'job slots, or cores where none are set'}, ${this._setting('clusterHosts') === 'all' ? 'all hosts' : 'without this desktop'}`;
    }

    // The dropdown's warning list, rebuilt only when what it lists or the open Snooze choice changes.
    // Snooze keeps a warning off the top bar; snoozed ones follow the rest, muted, with when they return.
    _clusterWarningList(view, issues) {
        const ordered = [...issues.filter(issue => !issue.snoozed), ...issues.filter(issue => issue.snoozed)];
        const signature = JSON.stringify([view.choosing,
            ordered.map(issue => [issue.host, issue.kind, issue.text, issue.critical, issue.until])]);
        view.problems.visible = ordered.length > 0;
        if (signature === view.problemsSignature) return;
        view.problemsSignature = signature;
        this._releaseFocus(this._clusterButton.menu, view.problemList);
        view.problemList.destroy_all_children();
        const button = (label, name, action) => {
            const actor = new St.Button({label, can_focus: true, style_class: 'tracker-copy', accessible_name: name,
                y_align: Clutter.ActorAlign.CENTER});
            actor.connect('clicked', action);
            return actor;
        };
        for (const issue of ordered) {
            const key = `${issue.host}:${issue.kind}`;
            const tone = issue.snoozed ? 'muted' : issue.critical ? 'failed' : 'attention';
            const line = new St.BoxLayout({style_class: 'tracker-cluster-measure-row'});
            line.add_child(this._glyph(issue.kind, issue.used, tone));
            line.add_child(new St.Label({text: issue.host, style_class: 'tracker-cluster-host tracker-cluster-measure-host',
                y_align: Clutter.ActorAlign.CENTER}));
            const text = new St.Label({text: issue.text, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
                style_class: `tracker-cluster-stat tracker-${tone}`});
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            line.add_child(text);
            view.problemList.add_child(line);
            // A host that stopped updating is not on the top bar, so there is nothing to snooze.
            if (issue.kind === 'stale') continue;
            if (issue.snoozed) {
                const until = issue.until === null ? '' : ` or ${new Date(issue.until * 1000).toLocaleString('en-US',
                    {weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})}`;
                // The warning's own text gives way to when the snooze ends.
                const note = new St.Label({text: `snoozed until it clears${until}`, style_class: 'tracker-detail',
                    y_align: Clutter.ActorAlign.CENTER});
                note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                line.add_child(note);
                line.add_child(button('Unsnooze', `Show ${issue.host}'s warning on the top bar again`, () => this._setSnooze(key, undefined)));
                continue;
            }
            const choose = open => () => {
                view.choosing = open ? key : null;
                view.typed = null;
                this._updateCluster();
            };
            if (view.choosing !== key) {
                line.add_child(button('Snooze', `Keep ${issue.host}'s warning off the top bar until it clears`, choose(true)));
                continue;
            }
            // What was typed survives the list rebuilding under it as the warning's text changes.
            const choices = new St.BoxLayout({style_class: 'tracker-cluster-snooze', x_align: Clutter.ActorAlign.END});
            choices.add_child(new St.Label({text: 'Off the top bar until it clears, or at most', style_class: 'tracker-detail',
                y_align: Clutter.ActorAlign.CENTER}));
            const limit = new St.Entry({hint_text: 'e.g. 5d or 120h', text: view.typed || '', can_focus: true,
                style_class: 'tracker-search tracker-cluster-snooze-entry', y_align: Clutter.ActorAlign.CENTER});
            limit.clutter_text.connect('text-changed', () => {
                view.typed = limit.get_text();
                limit.remove_style_class_name('tracker-entry-invalid');
            });
            const snooze = () => {
                const typed = limit.get_text().trim();
                const seconds = typed ? parseDuration(typed) : null;
                if (typed && seconds === null) limit.add_style_class_name('tracker-entry-invalid');
                else this._setSnooze(key, seconds);
            };
            limit.clutter_text.connect('activate', snooze);
            choices.add_child(limit);
            choices.add_child(button('Snooze', `Snooze ${issue.host}'s warning`, snooze));
            choices.add_child(button('Cancel', 'Keep this warning on the top bar', choose(false)));
            view.problemList.add_child(choices);
            global.stage.set_key_focus(limit);
        }
    }

    _renderQuick(rows) {
        const ready = readyConversations(rows, this._setting('quickReasons'));
        const limit = this._setting('quickLimit'), chars = this._setting('quickChars');
        const shown = ready.slice(0, limit);
        const signature = JSON.stringify(shown.map(row => [row.key, row.window, row.project]));
        if (signature !== this._quickSignature) this._buildQuick(signature, shown, chars);
        this._fitQuick(limit ? ready : []);
    }

    // One shortcut per chat in `shown`, placed by _fitQuick.
    _buildQuick(signature, shown, chars) {
        this._quickSignature = signature;
        for (const box of [this._quick, this._quickRight]) this._releaseFocus(null, box);
        for (const button of this._quickButtons) button.destroy();
        this._quickButtons = shown.map(row => {
            const name = row.project.length > chars ? `${row.project.slice(0, chars - 1)}…` : row.project;
            const button = new St.Button({label: `${PROVIDERS[row.provider]?.[0] || '•'} ${name}`,
                style_class: `tracker-quick-button tracker-${row.provider}`, can_focus: true,
                y_align: Clutter.ActorAlign.CENTER, accessible_name: `Show ${row.project}: ${row.title}`});
            button.connect('clicked', () => {
                button.hide();
                // Rebuild on the next read so a failed activation restores the button.
                this._quickSignature = null;
                this._activate(row, this._snapshot, 'focus');
            });
            // _fitQuick puts it in its place.
            this._quick.add_child(button);
            return button;
        });
    }

    // Shortcuts as room allows, the longest waiting first: in the top bar's left half after its other buttons, then
    // at the start of the right half. +N more, after the last one shown, lists the rest of `ready`.
    _fitQuick(ready) {
        const panel = Main.panel, total = ready.length;
        // Each side's box gets at most half of what the centre box leaves.
        const side = Math.floor((panel.width - panel._centerBox.get_preferred_width(-1)[1]) / 2) - 8;
        const width = actor => actor.get_preferred_width(-1)[1];
        const room = (box, own) => side - own.get_theme_node().get_length('margin-left') - own.get_theme_node().get_length('margin-right')
            - box.get_children().filter(child => child !== own && child.visible).reduce((sum, child) => sum + width(child), 0);
        const leftRoom = room(panel._leftBox, this._quick), rightRoom = room(panel._rightBox, this._quickRight);
        const spacing = this._quick.get_theme_node().get_length('spacing');
        const buttons = this._quickButtons;
        buttons.forEach(button => button.show());
        const widths = buttons.map(width);
        this._quickMore.label = `+${total} more`;
        const more = width(this._quickMore) + spacing;
        // How many buttons from `start` fit in `space`, keeping room for +N more if `keep` and any are left over.
        const fill = (space, start, keep) => {
            let used = -spacing, count = 0;
            for (let i = start; i < buttons.length; i++) {
                const next = used + spacing + widths[i];
                if (next + (keep && total > i + 1 ? more : 0) > space) break;
                used = next;
                count++;
            }
            return [count, used];
        };
        let [left] = fill(leftRoom, 0, false);
        let [right, usedRight] = fill(rightRoom, left, true);
        let moreRight = true;
        if (total > left + right && (!right || usedRight + more > rightRoom)) {
            // +N more ends the left side instead, next to the shortcuts it continues.
            [left] = fill(leftRoom, 0, true);
            right = 0;
            moreRight = false;
        }
        const place = (box, actors) => actors.forEach((actor, index) => {
            if (actor.get_parent() !== box) {
                actor.get_parent()?.remove_child(actor);
                box.add_child(actor);
            }
            box.set_child_at_index(actor, index);
        });
        const unplaced = buttons.slice(left + right);
        place(this._quick, [...buttons.slice(0, left), ...moreRight ? [] : [this._quickMore], ...unplaced]);
        place(this._quickRight, [...buttons.slice(left, left + right), ...moreRight ? [this._quickMore] : []]);
        unplaced.forEach(button => button.hide());
        this._quickHidden = ready.slice(left + right);
        const hidden = this._quickHidden.length;
        this._quickMore.label = `+${hidden} more`;
        this._quickMore.visible = hidden > 0;
        this._quickMore.accessible_name = `${hidden} more chat${hidden === 1 ? '' : 's'} needing review without room for a shortcut; click to list them`;
    }

    // The chats needing review without a shortcut, under +N more; choosing one brings it forward.
    _toggleQuickMenu() {
        if (this._quickMenu.isOpen) {
            this._quickMenu.close();
            return;
        }
        this._quickMenu.removeAll();
        for (const row of this._quickHidden) {
            const title = row.title.length > 48 ? `${row.title.slice(0, 47)}…` : row.title;
            const item = new PopupMenu.PopupMenuItem(`${PROVIDERS[row.provider]?.[0] || '•'} ${row.project} · ${title}`);
            item.label.add_style_class_name(`tracker-${row.provider}`);
            item.connect('activate', () => this._activate(row, this._snapshot, 'focus'));
            this._quickMenu.addMenuItem(item);
        }
        this._quickMenu.open();
    }

    _read() {
        if (this._reading) return;
        this._reading = true;
        Gio.File.new_for_path(`${ROOT}/snapshot.json`).load_contents_async(this._cancel, (file, result) => {
            this._reading = false;
            if (!this._enabled) return;
            try {
                const [ok, bytes] = file.load_contents_finish(result);
                if (!ok) throw new Error('Could not read the agent-bar snapshot');
                const snapshot = JSON.parse(ByteArray.toString(bytes));
                if (snapshot.schema !== 1) throw new Error('Unsupported agent-bar snapshot');
                this._snapshot = snapshot;
                if (!this._returnsLoaded) {
                    this._borrowed = new Map(Object.entries(snapshot.returns || {}));
                    this._returnsLoaded = true;
                }
                if (Date.now() / 1000 - snapshot.updated > 20)
                    throw new Error('The agent-bar service is stale');
                const c = snapshot.counts;
                for (const provider of Object.keys(PROVIDERS)) {
                    const count = providerCounts(snapshot.rows, provider);
                    this._ratios[provider].visible = PINNED.includes(provider) || count.open > 0;
                    this._labels[provider].text = `${count.review} / ${count.open}`;
                    this._labels[provider].set_style(count.review ? 'color: #f1f3f5; font-weight: bold;' : 'color: #9ca3ad;');
                }
                this._labels.working.text = `● ${c.working}`;
                this._labels.waiting.text = `◌ ${c.waiting}`;
                this._labels.waiting.visible = c.waiting > 0;
                const stranded = snapshot.messages?.stranded || [];
                this._mail.visible = stranded.length > 0;
                this._mailCount.text = `${stranded.length}`;
                this._labels.queues.visible = this._queuesShown(snapshot);
                this._labels.queues.text = `Q ${c.done} / ${c.queues}${Date.now() / 1000 - snapshot.queue_updated > 120 ? ' ?' : ''}`;
                this._labels.queues.set_style(c.done ? 'color: #f1f3f5; font-weight: bold;' : 'color: #9ca3ad;');
                this._renderQuick(snapshot.rows);
                this._button.accessible_name = `${Object.entries(PROVIDERS).filter(([key]) => c[key])
                    .map(([key, [, name]]) => `${name} ${c[key]}`).join(', ') || 'No chats'}, ${c.working} working, ${c.waiting} waiting, ${c.review} need review, ${c.done} of ${c.queues} queues finished since the last turn`
                    + (stranded.length ? `, agent mail waits for your turn in ${stranded.length} chat${stranded.length === 1 ? '' : 's'}` : '');
                this._error = null;
            } catch (error) {
                this._error = error.message;
                this._labels.working.text = '● ?';
                this._labels.waiting.visible = false;
                this._mail.visible = false;
                for (const provider of PINNED) this._labels[provider].text = '? / ?';
                this._labels.queues.text = 'Q ?';
                this._renderQuick([]);
            }
        });
    }

    _item(text, style = null) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        if (style) item.label.add_style_class_name(style);
        return item;
    }

    _buildMenu() {
        this._releaseFocus(this._button.menu);
        // removeAll() only drops menu items; the list body is a plain actor.
        this._body?.destroy();
        this._pickerList = null;
        this._pickerButtons = {};
        this._button.menu.removeAll();
        const snapshot = this._menuSnapshot;
        // null for the lists, or 'settings' or 'help'.
        const page = this._page;
        this._historyNote = null;
        if (!page && this._usesInventory()) this._loadInventory();
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header._ornamentLabel?.hide();
        header.add_style_class_name('tracker-heading');
        const heading = new St.BoxLayout({vertical: true, x_expand: true});
        heading.add_child(new St.Label({text: {settings: 'Settings', help: 'Guide'}[page] || 'Agents',
            style_class: 'tracker-heading-title'}));
        heading.add_child(new St.Label({style_class: 'tracker-detail', text: page === 'settings' ? `Saved to ${CONFIG.replace(GLib.get_home_dir(), '~')}`
            : page === 'help' ? 'What the top bar and this menu show'
                : snapshot ? `${new Set(snapshot.rows.map(row => row.key)).size} chats open · ${snapshot.windows.length} windows` : 'Waiting for the agent-bar service'}));
        header.add_child(heading);
        if (snapshot && !page) {
            for (const [value, caption, style] of [[snapshot.counts.review, 'needs review', 'attention'],
                [snapshot.counts.working, 'working', 'working'], [snapshot.counts.waiting, 'waiting', 'waiting']]) {
                const stat = new St.BoxLayout({vertical: true, style_class: 'tracker-summary'});
                stat.add_child(new St.Label({text: String(value), style_class: `tracker-summary-value tracker-${style}`}));
                stat.add_child(new St.Label({text: caption, style_class: 'tracker-detail'}));
                header.add_child(stat);
            }
        }
        if (snapshot || page) {
            const actions = new St.BoxLayout({style_class: 'tracker-header-actions', y_align: Clutter.ActorAlign.START});
            // Drawn rather than themed: Yaru's help icons are a boxed or bubbled question mark.
            const mark = () => new St.Bin({style_class: 'tracker-help-mark',
                child: new St.Label({text: '?', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})});
            const gear = () => new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16});
            // An open page's own button becomes ◀, so going back is where the page was opened.
            for (const [child, target, name] of [[mark, 'help', 'What the symbols and colors mean'], [gear, 'settings', 'Settings']]) {
                const back = page === target;
                const button = new St.Button({can_focus: true, style_class: back ? 'tracker-gear tracker-back' : 'tracker-gear',
                    accessible_name: back ? 'Back to conversations' : name, ...back ? {label: '◀'} : {child: child()}});
                button.connect('clicked', () => { this._page = back ? null : target; this._later(() => this._buildMenu()); });
                actions.add_child(button);
            }
            header.add_child(actions);
        }
        this._button.menu.addMenuItem(header);
        const control = (...children) => {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            item._ornamentLabel?.hide();
            item.visible = !page;
            for (const child of children) item.add_child(child);
            this._button.menu.addMenuItem(item);
            return item;
        };
        this._search = new St.Entry({hint_text: 'Search conversations, projects, or queues…',
            can_focus: true, x_expand: true, style_class: 'tracker-search'});
        const tabs = new St.BoxLayout({style_class: 'tracker-filters'});
        // Integrations turned off in settings take their tabs with them.
        const shown = {queues: this._setting('scheduler'), git: this._setting('git'), messages: this._setting('messages')};
        if (shown[this._view] === false) this._view = 'conversations';
        for (const [value, label] of [['conversations', 'Chats'], ['queues', 'Queues'], ['git', 'Git'], ['messages', 'Messages'], ['history', 'History'], ['info', 'Info']]
            .filter(([value]) => shown[value] !== false)) {
            const button = new St.Button({label, toggle_mode: true, checked: this._view === value,
                can_focus: true, style_class: 'tracker-filter'});
            button.connect('clicked', () => { this._view = value; this._picker = null; this._later(() => this._buildMenu()); });
            tabs.add_child(button);
        }
        control(tabs);
        // The tab without parallel-workers has nothing to search, sort or filter.
        const bare = this._view === 'queues' && snapshot?.scheduler === 'missing';
        control(this._search).visible = !page && !bare;
        // Sort and filter each open a list under their button, over the rows.
        const toolbar = new St.BoxLayout({x_expand: true, style_class: 'tracker-toolbar'});
        {
            // Messages have one order, newest conversation pair first; an Agent or Project filter picks one of them.
            const pickers = this._view === 'info' ? ['project'] : this._view !== 'messages' ? ['sort', 'filter']
                : ['agent', 'project'].includes(this._messageFilter) ? ['filter', 'value'] : ['filter'];
            for (const picker of pickers) {
                const [options, current] = this._pickerOptions(picker);
                const caption = {sort: 'Sort', filter: 'Filter', project: 'New chats in'}[picker]
                    || (this._messageFilter === 'agent' ? 'Agent' : 'Project');
                const value = options.find(([v]) => v === current)[1];
                const content = new St.BoxLayout({style_class: 'tracker-picker-content'});
                for (const [text, style] of [[`${caption}:`, 'tracker-picker-caption'], [value, 'tracker-picker-value'], ['▾', 'tracker-picker-caption']])
                    content.add_child(new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER}));
                // A filter that hides conversations stays tinted so the narrowed list is obvious.
                const button = new St.Button({can_focus: true, toggle_mode: true,
                    child: content, accessible_name: `${caption}: ${value}`,
                    style_class: picker !== 'sort' && current !== 'all' ? 'tracker-picker tracker-picker-active' : 'tracker-picker'});
                button.connect('clicked', () => this._togglePicker(picker));
                this._pickerButtons[picker] = button;
                toolbar.add_child(button);
            }
            if (this._view === 'history') {
                this._historyNote = new St.Label({x_expand: true, x_align: Clutter.ActorAlign.END, text: this._historyNoteText(),
                    style_class: 'tracker-sort-note', y_align: Clutter.ActorAlign.CENTER});
                toolbar.add_child(this._historyNote);
                const refresh = new St.Button({child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 14}),
                    can_focus: true, accessible_name: 'Rescan saved conversations', style_class: 'tracker-bulk',
                    y_align: Clutter.ActorAlign.CENTER});
                refresh.connect('clicked', () => this._refreshInventory());
                toolbar.add_child(refresh);
            } else {
                toolbar.add_child(new St.Widget({x_expand: true}));
            }
        }
        // Git, Messages and Info have no groups to expand or collapse.
        for (const [icon, name, collapse] of ['git', 'messages', 'info'].includes(this._view) ? [] : [['view-fullscreen-symbolic', 'Expand all', false],
            ['view-restore-symbolic', 'Collapse all', true]]) {
            const button = new St.Button({child: new St.Icon({icon_name: icon, icon_size: 14}), can_focus: true,
                accessible_name: name, style_class: 'tracker-bulk', y_align: Clutter.ActorAlign.CENTER});
            button.connect('clicked', () => {
                if (collapse) for (const key of this._projectKeys) this._collapsedProjects.add(key);
                else this._collapsedProjects.clear();
                this._renderRows();
            });
            toolbar.add_child(button);
        }
        control(toolbar).visible = !page && !bare;
        // The rows and an open picker list share one cell, so the list overlays the rows.
        this._body = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._scroll = new St.ScrollView({style_class: 'tracker-scroll', overlay_scrollbars: true, x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this._scroll.set_style(`max-height: ${Math.min(650, Main.layoutManager.primaryMonitor.height - 270)}px;`);
        this._section = new PopupMenu.PopupMenuSection();
        this._scroll.add_actor(this._section.actor);
        this._body.add_child(this._scroll);
        this._button.menu.box.add_child(this._body);
        this._search.clutter_text.connect('text-changed', () => { this._togglePicker(null); this._renderRows(); });
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._footer = this._item('', 'tracker-footer');
        this._button.menu.addMenuItem(this._footer);
        this._renderRows();
    }

    // Opens the named picker's list just below its button, or closes any open list.
    _togglePicker(picker) {
        const reopen = picker && picker !== this._picker;
        if (this._pickerList) this._releaseFocus(this._button.menu, this._pickerList);
        this._pickerList?.destroy();
        this._pickerList = null;
        this._picker = null;
        for (const button of Object.values(this._pickerButtons)) button.checked = false;
        if (!reopen) return;
        this._picker = picker;
        const button = this._pickerButtons[picker];
        button.checked = true;
        // BinLayout honours a child's alignment only when the child expands; otherwise it centres it.
        const list = new St.BoxLayout({vertical: true, style_class: 'tracker-picker-list', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START});
        const [options, current, choose] = this._pickerOptions(picker);
        for (const [value, caption] of options) {
            const option = new St.Button({label: `${value === current ? '✓' : '  '}  ${caption}`, can_focus: true,
                x_align: Clutter.ActorAlign.START,
                style_class: value === current ? 'tracker-picker-option tracker-picker-current' : 'tracker-picker-option'});
            option.connect('clicked', () => {
                choose(value);
                this._picker = null;
                this._later(() => this._buildMenu());
            });
            list.add_child(option);
        }
        const [buttonX, buttonY] = button.get_transformed_position();
        const [, buttonHeight] = button.get_transformed_size();
        const [bodyX, bodyY] = this._body.get_transformed_position();
        list.translation_x = Math.round(buttonX - bodyX);
        list.translation_y = Math.round(buttonY + buttonHeight + 3 - bodyY);
        this._body.add_child(list);
        this._pickerList = list;
    }

    _pickerOptions(picker) {
        if (picker === 'sort') {
            const key = {history: 'historyOrder', queues: 'queueOrder', git: 'gitOrder'}[this._view] || 'projectOrder';
            return [SETTINGS.find(([, k]) => k === key)[5], this._setting(key), value => this._saveSetting(key, value)];
        }
        if (this._view === 'queues') return [QUEUE_FILTERS, this._queueFilter, value => { this._queueFilter = value; }];
        if (this._view === 'history') return [FILTERS.slice(0, 3), this._historyFilter, value => { this._historyFilter = value; }];
        if (this._view === 'git') return [GIT_FILTERS, this._gitFilter, value => { this._gitFilter = value; }];
        if (picker === 'project') {
            const options = infoFolders(this._menuSnapshot || {windows: [], rows: []});
            if (!options.some(([value]) => value === this._infoProject)) this._infoProject = options[0]?.[0] ?? null;
            return [options.length ? options : [[null, 'No open folder']], this._infoProject, value => { this._infoProject = value; }];
        }
        if (this._view === 'messages' && picker === 'value') {
            const options = messageFilterValues(this._menuSnapshot?.messages?.recent || [], this._messageFilter);
            // An agent or project whose messages have all expired leaves the list.
            if (!options.some(([value]) => value === this._messageValue)) this._messageValue = options[0]?.[0] ?? null;
            return [options.length ? options : [[null, 'None']], this._messageValue, value => { this._messageValue = value; }];
        }
        if (this._view === 'messages') return [MESSAGE_FILTERS, this._messageFilter, value => { this._messageFilter = value; }];
        return [FILTERS, this._filter, value => { this._filter = value; }];
    }

    _place(window) {
        const native = this._findWindow(window, false);
        if (!native) return 'Display unknown';
        return native.get_monitor() === Main.layoutManager.primaryIndex ? 'Main display' : `Display ${native.get_monitor() + 1}`;
    }

    // fill(body), when given, builds the rows on first expansion instead of up front.
    // below: a line under the heading that stays visible when the group is collapsed.
    _projectSection(key, title, context, summary, highlight = false, controls = null, fill = null, below = null) {
        this._projectKeys.push(key);
        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_style_class_name('tracker-project');
        this._section.addMenuItem(section);
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header._ornamentLabel?.hide();
        header.add_style_class_name('tracker-project-header-item');
        const button = new St.Button({x_expand: true, can_focus: true, style_class: 'tracker-project-header',
            accessible_name: `${title}, ${context}, ${summary}`});
        const line = new St.BoxLayout({style_class: 'tracker-project-heading'});
        const arrow = new St.Label({text: '⌄', style_class: 'tracker-muted'});
        line.add_child(arrow);
        const label = new St.Label({text: title, x_expand: true, style_class: 'tracker-project-name'});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        line.add_child(label);
        line.add_child(new St.Label({text: context, style_class: 'tracker-project-context'}));
        line.add_child(new St.Label({text: summary, style_class: highlight ? 'tracker-attention tracker-project-total' : 'tracker-project-total'}));
        button.set_child(line);
        if (below) {
            // The heading's hover highlight stays clear of the line under it.
            button.add_style_class_name('tracker-project-header-stacked');
            const stack = new St.BoxLayout({vertical: true, x_expand: true});
            stack.add_child(button);
            stack.add_child(below);
            header.add_child(stack);
        } else {
            header.add_child(button);
        }
        if (controls) header.add_child(controls);
        section.addMenuItem(header);
        const body = new PopupMenu.PopupMenuSection();
        section.addMenuItem(body);
        const apply = () => {
            const collapsed = this._collapsedProjects.has(key) && !this._search.text;
            body.actor.visible = !collapsed;
            arrow.text = collapsed ? '›' : '⌄';
            if (!collapsed && fill) {
                fill(body);
                fill = null;
            }
        };
        button.connect('clicked', () => {
            if (this._collapsedProjects.has(key)) this._collapsedProjects.delete(key);
            else this._collapsedProjects.add(key);
            apply();
        });
        apply();
        return body;
    }

    _renderRows() {
        this._releaseFocus(this._button.menu, this._section.actor);
        this._section.removeAll();
        this._projectKeys = [];
        const snapshot = this._menuSnapshot;
        if (this._error) this._section.addMenuItem(this._item(this._error, 'tracker-warning'));
        if (this._page === 'settings') {
            this._footer.label.text = 'Changes apply immediately';
            this._renderSettings();
            return;
        }
        if (this._page === 'help') {
            this._footer.label.text = 'Colors follow Settings › Appearance › State colors';
            this._renderHelp();
            return;
        }
        if (!snapshot) return;
        const query = this._search.text.toLowerCase();
        this._footer.label.text = {
            queues: `From parallel-workers · updated ${age(snapshot.queue_updated)} · counts reset at each turn in the project`,
            history: 'Saved conversations, rescanned daily · click one to resume it in its folder',
            messages: 'A chat sees its unread count at its next turn start · at most 3 to one chat between your prompts',
            info: 'Read from local files when this tab opens, and again after 30 s · nothing polls in the background',
            git: `Read-only git status of open projects${snapshot.git ? `, ${age(snapshot.git.updated)}` : ''} · ↑↓ as of the last fetch · click for Source Control`,
        }[this._view] || `Top bar: needs review / open chats${this._queuesShown(snapshot) ? '   ·   Q finished / outstanding since last turn' : ''}`;
        if (this._view === 'queues') {
            this._renderQueues(snapshot, query);
            return;
        }
        if (this._view === 'history') {
            this._renderHistory(snapshot, query);
            return;
        }
        if (this._view === 'git') {
            this._renderGit(snapshot, query);
            return;
        }
        if (this._view === 'messages') {
            this._renderMessages(snapshot, query);
            return;
        }
        if (this._view === 'info') {
            this._renderInfo(snapshot, query);
            return;
        }
        const rows = snapshot.rows.filter(row => matchesFilter(row, this._filter)
            && `${row.title} ${row.project} ${row.provider}`.toLowerCase().includes(query));
        const totals = new Map((this._inventory?.conversations || []).map(row => [row.key, row.active]));
        for (const project of groupProjects(rows, this._setting('projectOrder'), totals)) {
            const firstWindow = snapshot.windows.find(w => w.id === project.rows[0].window);
            const total = new Set(project.rows.map(row => row.key)).size;
            const queues = project.rows[0].queue_counts;
            const summary = (project.review ? `${project.review} review / ${total}` : `${total} open`)
                + (queues.total ? ` · Q ${queues.done}/${queues.total}` : '');
            const body = this._projectSection(project.key, project.name,
                project.windows.size === 1 ? this._place(firstWindow) : `${project.windows.size} windows`,
                summary, !!(project.review || queues.done),
                project.windows.size === 1 ? this._windowControls(firstWindow.id, snapshot) : null);
            let index = 0;
            for (const [windowId, conversations] of project.windows) {
                const window = snapshot.windows.find(w => w.id === windowId);
                if (project.windows.size > 1) {
                    const heading = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
                    heading._ornamentLabel?.hide();
                    const name = window?.kind ? window.label || 'Terminal' : `Window ${++index}`;
                    heading.add_child(new St.Label({text: `${name} · ${this._place(window)}`, x_expand: true,
                        style_class: 'tracker-window-heading', y_align: Clutter.ActorAlign.CENTER}));
                    heading.add_child(this._windowControls(windowId, snapshot));
                    body.addMenuItem(heading);
                }
                for (const row of conversations) this._conversationItem(row, snapshot, body);
            }
        }
        if (!rows.length) this._section.addMenuItem(this._item('No matching open conversations', 'tracker-empty'));
        for (const warning of snapshot.warnings)
            this._section.addMenuItem(this._item(warning, 'tracker-warning'));
        if (rows.some(row => row.provider === 'claude' && row.state === 'unknown'))
            this._section.addMenuItem(this._item('Claude status awaits its first lifecycle event; existing chats may need /hooks to load the observer.', 'tracker-warning'));
    }

    // The tab without parallel-workers: how to get it, or remove the tab (Settings › Integrations restores it).
    _renderSchedulerMissing() {
        this._footer.label.text = 'Settings › Integrations › Job scheduler turns this tab on or off';
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tracker-placeholder'});
        item._ornamentLabel?.hide();
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        box.add_child(new St.Label({text: 'Job scheduler not installed', style_class: 'tracker-title'}));
        const text = new St.Label({style_class: 'tracker-help-text',
            text: 'Queues, the Q count and the cluster indicator come from the parallel-workers job scheduler, '
                + 'which is not set up on this computer (no ~/.local/state/parallel-workers). Everything else works without it.'});
        text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        text.clutter_text.line_wrap = true;
        box.add_child(text);
        const actions = new St.BoxLayout({style_class: 'tracker-placeholder-actions'});
        const action = (label, callback) => {
            const button = new St.Button({label, can_focus: true, style_class: 'tracker-filter'});
            button.connect('clicked', callback);
            actions.add_child(button);
        };
        if (SCHEDULER_URL) action('How to install', () => {
            this._button.menu.close();
            Gio.AppInfo.launch_default_for_uri(SCHEDULER_URL, null);
        });
        action('Remove this tab', () => {
            this._saveSetting('scheduler', false);
            this._later(() => this._buildMenu());
        });
        box.add_child(actions);
        box.add_child(new St.Label({text: 'Settings › Integrations brings the tab back.', style_class: 'tracker-detail'}));
        item.add_child(box);
        this._section.addMenuItem(item);
    }

    _renderQueues(snapshot, query) {
        if (snapshot.scheduler === 'missing') {
            this._renderSchedulerMissing();
            return;
        }
        const queues = snapshot.queues.filter(q => `${q.project} ${q.label}`.toLowerCase().includes(query));
        const groups = queueGroups(queues, snapshot.queue_counts, this._setting('queueOrder'), this._queueFilter);
        if (Date.now() / 1000 - snapshot.queue_updated > 120)
            this._section.addMenuItem(this._item('Snapshot stale · start the parallel-workers monitor to refresh queue progress', 'tracker-warning'));
        for (const [project, items] of groups) {
            const count = snapshot.queue_counts[project] || {done: 0, total: 0};
            // Other filters can list queues that finished before the project's last turn.
            const earlier = items.filter(queue => !queue.counted).length;
            const window = projectWindow(snapshot.windows, project);
            const body = this._projectSection(`queue:${project}`, project, 'since last turn',
                `${count.done} / ${count.total} finished${earlier ? ` · ${earlier} earlier` : ''}`, !!count.done,
                window ? this._windowControls(window.id, snapshot) : null);
            for (const queue of items) {
                const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
                item._ornamentLabel?.hide();
                item.add_style_class_name('tracker-queue-row');
                if (!queue.counted) item.add_style_class_name('tracker-queue-earlier');
                const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-row'});
                const line = new St.BoxLayout({style_class: 'tracker-row-title'});
                const title = new St.Label({text: queue.label, x_expand: true, style_class: 'tracker-title'});
                title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                line.add_child(title);
                line.add_child(new St.Label({text: queue.state, style_class: `tracker-chip tracker-chip-${stateStyle(queue.state)}`}));
                box.add_child(line);
                const progress = new St.BoxLayout({style_class: 'tracker-progress-line'});
                const track = new St.Widget({style_class: 'tracker-progress', y_align: Clutter.ActorAlign.CENTER});
                const fill = new St.Widget({style_class: `tracker-progress-fill tracker-progress-${stateStyle(queue.state)}`});
                fill.set_width(Math.round(QUEUE_BAR * Math.min(100, Math.max(0, queue.pct)) / 100));
                track.add_child(fill);
                progress.add_child(track);
                const detail = new St.Label({text: queueDetail(queue) + (queue.counted ? '' : ' · before last turn'),
                    style_class: 'tracker-detail', y_align: Clutter.ActorAlign.CENTER});
                detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                progress.add_child(detail);
                box.add_child(progress);
                item.add_child(box);
                body.addMenuItem(item);
            }
        }
        if (!groups.length) this._section.addMenuItem(this._item('No matching watched queues', 'tracker-empty'));
    }

    // Each pair of conversations' messages as a thread, oldest first. The header names the projects and has a button
    // for each conversation; read messages fold to one line except the newest, and clicking a message folds or unfolds it.
    _renderMessages(snapshot, query) {
        const all = snapshot.messages?.recent || [];
        const symbol = key => PROVIDERS[key.split(':')[0]]?.[0] || '•';
        const threads = messageThreads(all.filter(m => `${m.body} ${m.sender_title} ${m.recipient_title} ${m.sender_project} ${m.recipient_project}`
            .toLowerCase().includes(query)), this._messageFilter, this._messageValue);
        if (!threads.length) this._section.addMenuItem(this._item(all.length ? 'No matching messages'
            : 'No messages yet. Agents send them with `agent-bar send`.', 'tracker-empty'));
        for (const items of threads) {
            const [first] = items;
            const unread = items.filter(m => !m.read_at).length;
            const pair = [first.sender, first.recipient];
            const titles = Object.fromEntries(items.flatMap(m => [[m.sender, m.sender_title], [m.recipient, m.recipient_title]]));
            const projects = Object.fromEntries(items.flatMap(m => [[m.sender, m.sender_project], [m.recipient, m.recipient_project]]));
            // The loop guard holds a pair until a sender's user writes to it, or until reset here.
            const held = (snapshot.messages?.held || []).filter(h => pair.includes(h.sender) && pair.includes(h.recipient));
            const agents = new St.BoxLayout({style_class: 'tracker-thread-agents', y_align: Clutter.ActorAlign.CENTER});
            pair.forEach((key, index) => {
                if (index) agents.add_child(new St.Label({text: '⇄', style_class: 'tracker-muted', y_align: Clutter.ActorAlign.CENTER}));
                const row = snapshot.rows.find(r => r.key === key && r.target);
                const title = titles[key] || key;
                // A chat sent messages here has an envelope: sealed while it has not read them (amber when they wait
                // for you to start a turn there, white when a wake-up will bring them), open once it has read them all.
                const sent = items.filter(m => m.recipient === key);
                const waiting = sent.filter(m => !m.read_at).length;
                const stranded = waiting > 0 && (snapshot.messages?.stranded || []).includes(key);
                const content = new St.BoxLayout({style_class: 'tracker-thread-agent-content'});
                content.add_child(new St.Label({text: `${symbol(key)} ${title.length > 34 ? `${title.slice(0, 33)}…` : title}`,
                    y_align: Clutter.ActorAlign.CENTER}));
                if (sent.length) content.add_child(this._glyph(waiting ? 'mail' : 'mail-open', null,
                    stranded ? 'attention' : waiting ? 'help-bright' : 'muted'));
                const mail = !sent.length ? '' : waiting ? `, ${waiting} unread${stranded ? ' until you start a turn there' : ''}` : ', read its messages';
                const button = new St.Button({child: content,
                    reactive: !!row, can_focus: !!row, accessible_name: (row ? `Open ${title}` : `${title} is closed`) + mail,
                    style_class: `tracker-thread-agent tracker-${key.split(':')[0]}${row ? '' : ' tracker-thread-closed'}`});
                if (row) button.connect('clicked', () => this._activate(row, snapshot));
                agents.add_child(button);
            });
            const [from, to] = pair.map(key => projects[key] || '?');
            const body = this._projectSection(`messages:${first.sender} ${first.recipient}`, from === to ? from : `${from} ⇄ ${to}`, '',
                `${items.length} message${items.length === 1 ? '' : 's'}${unread ? ` · ${unread} unread` : ''}${held.length ? ' · held' : ''}`,
                unread > 0 || held.length > 0, null, null, agents);
            if (held.length) {
                const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
                item._ornamentLabel?.hide();
                const text = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'tracker-reason tracker-attention',
                    text: held.map(h => `${symbol(h.sender)} ${titles[h.sender] || h.sender} reached its limit to ${titles[h.recipient] || h.recipient}`
                        + (h.refused ? ` (${h.refused} held back)` : '')).join(' · ') + '; it was told to ask you.'});
                text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                text.clutter_text.line_wrap = true;
                item.add_child(text);
                const reset = new St.Button({label: 'Reset limit', can_focus: true, style_class: 'tracker-filter tracker-reset-limit',
                    accessible_name: 'Allow these chats another round of messages', y_align: Clutter.ActorAlign.CENTER});
                reset.connect('clicked', () => this._resetLimit(pair));
                item.add_child(reset);
                body.addMenuItem(item);
            }
            for (const message of items) {
                // A button rather than an activatable item, which would close the menu.
                const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
                item._ornamentLabel?.hide();
                item.add_style_class_name('tracker-conversation');
                if (!message.read_at) item.add_style_class_name('tracker-unread');
                const button = new St.Button({x_expand: true, can_focus: true, style_class: 'tracker-message-button',
                    accessible_name: `Message from ${titles[message.sender] || message.sender}, click to fold or unfold`});
                const box = new St.BoxLayout({vertical: true, style_class: 'tracker-row', x_expand: true});
                const heading = new St.Label({style_class: 'tracker-detail', text: `${symbol(message.sender)} ${titles[message.sender] || message.sender}`
                    + ` → ${symbol(message.recipient)} ${titles[message.recipient] || message.recipient} · ${age(message.at)}${message.urgent ? ' · urgent' : ''}`});
                heading.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                box.add_child(heading);
                const text = new St.Label({style_class: 'tracker-help-text'});
                const fold = open => {
                    text.text = open ? (message.body.length > 1500 ? `${message.body.slice(0, 1499)}…` : message.body)
                        : message.body.split('\n')[0];
                    text.clutter_text.ellipsize = open ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
                    text.clutter_text.line_wrap = open;
                };
                fold(this._openMessages.get(message.id) ?? (!message.read_at || message === items.at(-1)));
                box.add_child(text);
                button.set_child(box);
                item.add_child(button);
                item.add_child(new St.Label({text: message.read_at ? 'Read' : 'Unread', y_align: Clutter.ActorAlign.CENTER,
                    style_class: `tracker-chip tracker-chip-${message.read_at ? 'muted' : 'attention'}`}));
                button.connect('clicked', () => {
                    const open = !(this._openMessages.get(message.id) ?? (!message.read_at || message === items.at(-1)));
                    this._openMessages.set(message.id, open);
                    fold(open);
                });
                body.addMenuItem(item);
            }
        }
    }

    async _resetLimit(pair) {
        try {
            await this._run(['reset-limit', ...pair]);
            this._read();
            // The service's next snapshot drops the hold.
            await this._delay(3500);
            if (this._enabled && this._button.menu.isOpen) {
                this._menuSnapshot = this._snapshot;
                this._buildMenu();
            }
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
        }
    }

    // Usage limits, skills, tracker health and instruction files, from `agent-bar info`, read when this tab
    // opens and again once 30 s old.
    _renderInfo(snapshot, query) {
        if (Date.now() - this._infoAt > 30000) this._loadInfo();
        const info = this._info;
        if (!info) {
            this._section.addMenuItem(this._item(this._infoError || 'Reading…', this._infoError ? 'tracker-warning' : 'tracker-empty'));
            return;
        }
        const card = title => {
            this._section.addMenuItem(this._item(title, 'tracker-settings-section'));
            const section = new PopupMenu.PopupMenuSection();
            section.actor.add_style_class_name('tracker-settings-card');
            this._section.addMenuItem(section);
            return section;
        };
        const line = (section, children) => {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tracker-setting'});
            item._ornamentLabel?.hide();
            for (const child of children) item.add_child(child);
            section.addMenuItem(item);
            return item;
        };
        const label = (text, style = 'tracker-detail', expand = false) => {
            const actor = new St.Label({text, style_class: style, x_expand: expand, y_align: Clutter.ActorAlign.CENTER});
            actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            return actor;
        };
        const button = (text, callback, style = 'tracker-thread-agent') => {
            const actor = new St.Button({label: text, can_focus: true, style_class: style, y_align: Clutter.ActorAlign.CENTER});
            actor.connect('clicked', callback);
            return actor;
        };
        // A summary line that shows or hides the rows under it; `key` remembers the choice while the panel runs.
        const group = (section, key, text) => {
            const head = new St.BoxLayout({x_expand: true, style_class: 'tracker-info-skill'});
            const arrow = label(this._openSkills.has(key) ? '⌄' : '›', 'tracker-muted');
            head.add_child(arrow);
            head.add_child(label(text, 'tracker-detail', true));
            const toggle = new St.Button({child: head, x_expand: true, can_focus: true, style_class: 'tracker-message-button'});
            line(section, [toggle]);
            const rows = [];
            toggle.connect('clicked', () => {
                if (this._openSkills.has(key)) this._openSkills.delete(key);
                else this._openSkills.add(key);
                arrow.text = this._openSkills.has(key) ? '⌄' : '›';
                for (const row of rows) row.visible = this._openSkills.has(key);
            });
            return row => { row.visible = this._openSkills.has(key); rows.push(row); };
        };

        const usage = card('Usage limits');
        for (const provider of ['claude', 'codex']) {
            const value = info.usage?.[provider];
            if (!value) continue;
            const children = [this._providerLabel(provider)];
            for (const limit of value.limits) {
                const box = new St.BoxLayout({vertical: true, style_class: 'tracker-info-limit'});
                box.add_child(label(`${limit.name} ${Math.round(limit.percent)}%`, `tracker-${loadStyle(limit.percent)} tracker-info-value`));
                const track = new St.Widget({style_class: 'tracker-progress tracker-info-bar'});
                const fill = new St.Widget({style_class: `tracker-progress-fill tracker-progress-${loadStyle(limit.percent)}`});
                fill.set_width(Math.round(90 * Math.min(100, limit.percent) / 100));
                track.add_child(fill);
                box.add_child(track);
                box.add_child(label(resetTime(limit.resets_at)));
                children.push(box);
            }
            const asOf = typeof value.as_of === 'number' ? value.as_of : Date.parse(value.as_of) / 1000;
            children.push(label(`as of ${age(asOf)}`, 'tracker-detail', true));
            line(usage, children);
        }
        if (!info.usage?.claude && !info.usage?.codex) line(usage, [label('Neither Claude Code nor Codex has recorded its limits yet')]);

        const skills = card('Skills');
        const shown = info.skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query));
        if (!shown.length) line(skills, [label('No matching skills')]);
        const synced = shown.filter(skill => skill.synced).length;
        let inSynced = null;
        for (const skill of shown) {
            // Skills claude.ai syncs to Claude Code are folded under one line unless searched for.
            if (skill.synced && !inSynced) inSynced = query ? row => row : group(skills, 'synced', `${synced} synced from claude.ai`);
            const head = new St.BoxLayout({style_class: 'tracker-info-skill', x_expand: true});
            head.add_child(label(skill.name, 'tracker-title', true));
            if (skill.synced) head.add_child(label('claude.ai', 'tracker-detail'));
            for (const provider of skill.synced ? [] : skill.providers)
                head.add_child(label(PROVIDERS[provider]?.[0] || provider, `tracker-${provider}`));
            if (skill.uses) head.add_child(label(`used ${skill.uses}×`, 'tracker-detail'));
            const toggle = new St.Button({child: head, x_expand: true, can_focus: true, style_class: 'tracker-message-button',
                accessible_name: `${skill.name}: show or hide its description`});
            const heading = line(skills, [toggle]);
            if (skill.synced) inSynced(heading);
            const detail = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-info-detail'});
            const description = label(skill.description || 'No description', 'tracker-help-text', true);
            description.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            description.clutter_text.line_wrap = true;
            detail.add_child(description);
            detail.add_child(label(skill.path.replace(GLib.get_home_dir(), '~')));
            if (!skill.synced && this._infoProject) {
                const start = new St.BoxLayout({style_class: 'tracker-thread-agents'});
                start.add_child(label(`Start a chat with it in ${this._infoProject.split('/').pop()}:`));
                for (const provider of skill.providers.filter(p => p in PROVIDERS))
                    start.add_child(button(`${PROVIDERS[provider][0]} ${PROVIDERS[provider][1]}`, () => this._startSkillChat(skill, provider, snapshot),
                        `tracker-thread-agent tracker-${provider}`));
                detail.add_child(start);
            }
            const item = line(skills, [detail]);
            item.visible = this._openSkills.has(skill.name) && heading.visible;
            toggle.connect('clicked', () => {
                if (this._openSkills.has(skill.name)) this._openSkills.delete(skill.name);
                else this._openSkills.add(skill.name);
                item.visible = this._openSkills.has(skill.name);
            });
            // Unfolding the synced group shows names; a skill's own details still wait for its click.
            if (skill.synced && !query) heading.connect('notify::visible', () => { if (!heading.visible) item.visible = false; });
        }

        const health = card('Agent Bar health');
        const mark = ok => label(ok ? '✓' : '✗', ok ? 'tracker-finished' : 'tracker-failed');
        const hooks = info.health.hooks, last = info.health.last_event;
        line(health, [this._providerLabel('claude'), label('lifecycle hook'), mark(hooks.claude.observer), label('message waiter'),
            mark(hooks.claude.waiter), label(last.claude ? `last event ${age(last.claude)}` : 'no events yet', 'tracker-detail', true)]);
        line(health, [this._providerLabel('codex'), label('lifecycle hook'), mark(hooks.codex.observer),
            label(last.codex ? `last event ${age(last.codex)}` : 'no events yet', 'tracker-detail', true)]);
        if (!hooks.claude.observer || !hooks.claude.waiter || !hooks.codex.observer)
            line(health, [label('Install missing hooks with agent-bar install', 'tracker-warning', true)]);
        const editors = snapshot.windows.filter(window => !window.kind);
        const stale = editors.filter(window => !window.scm).map(window => window.workspace);
        const bridges = label(stale.length ? `${stale.length} of ${editors.length} VS Code windows run an older Agent Bar bridge `
            + `(${stale.join(', ')}); Developer: Reload Window updates them` : `All ${editors.length} VS Code windows run the current Agent Bar bridge`,
            stale.length ? 'tracker-attention' : 'tracker-detail', true);
        bridges.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        bridges.clutter_text.line_wrap = true;
        line(health, [bridges]);
        line(health, [label(`The agent-bar service updated ${age(snapshot.updated)}`, 'tracker-detail', true)]);
        for (const error of info.health.errors) line(health, [label(`Hook error: ${error}`, 'tracker-failed', true)]);
        for (const warning of snapshot.warnings) line(health, [label(warning, 'tracker-warning', true)]);

        const files = card('Agent instructions');
        const open = (path, folder) => button(path.slice(path.lastIndexOf('/') + 1) + (folder && !path.startsWith(`${folder}/`) ? ' (above)' : ''),
            () => this._openFile(path, folder, snapshot), 'tracker-thread-agent');
        if (info.instructions.user.length)
            line(files, [label('Everywhere', 'tracker-title'), ...info.instructions.user.map(path => open(path, null)), label('', 'tracker-detail', true)]);
        const folders = Object.entries(info.instructions.folders);
        const without = folders.filter(([, paths]) => !paths.length).length;
        const inFolders = group(files, 'instructions', `${folders.length} open folders · ${folders.length - without} with instruction files`
            + (without ? `, ${without} without` : '') + ' · click a file to open it in that folder\'s window');
        for (const [folder, paths] of folders)
            inFolders(line(files, [label(folder.split('/').pop(), 'tracker-title'), ...(paths.length ? paths.map(path => open(path, folder))
                : [label('none', 'tracker-muted')]), label('', 'tracker-detail', true)]));
    }

    async _loadInfo() {
        if (this._infoLoading) return;
        this._infoLoading = true;
        try {
            this._info = await this._run(['info']);
            this._infoError = null;
            this._infoAt = Date.now();
        } catch (error) {
            this._infoError = `Info unavailable: ${error.message}`;
            this._infoAt = Date.now();
        } finally { this._infoLoading = false; }
        if (this._enabled && this._button.menu.isOpen && this._view === 'info' && !this._page) this._later(() => this._renderRows());
    }

    // A new chat with a skill as its first prompt. Claude in the folder's VS Code window gets the prompt filled in,
    // not sent; otherwise a terminal there runs the agent with it, and stays open after the agent exits.
    async _startSkillChat(skill, provider, snapshot) {
        const folder = this._infoProject;
        const window = snapshot.windows.find(w => !w.kind && (w.roots || []).includes(folder));
        try {
            if (provider === 'claude' && window) {
                const result = await this._activate({window: window.id, key: null}, snapshot, 'place');
                if (!result?.ok) return;
                Gio.AppInfo.launch_default_for_uri(`vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(`/${skill.name} `)}`, null);
                return;
            }
            this._button.menu.close();
            const prompt = provider === 'claude' ? `/${skill.name}` : `Use the ${skill.name} skill.`;
            Gio.Subprocess.new(['gnome-terminal', `--working-directory=${folder}`, '--', 'bash', '-lc', `${provider} "$1"; exec bash`,
                'agent-bar', prompt], Gio.SubprocessFlags.NONE);
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
        }
    }

    // An instruction file opens in VS Code, in the window on its folder when one is open.
    async _openFile(path, folder, snapshot) {
        const window = folder && snapshot.windows.find(w => !w.kind && (w.roots || []).includes(folder));
        try {
            if (window) {
                const result = await this._activate({window: window.id, key: null}, snapshot, 'place');
                if (!result?.ok) return;
            } else {
                this._button.menu.close();
            }
            Gio.Subprocess.new(['code', '--reuse-window', path], Gio.SubprocessFlags.NONE);
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
        }
    }

    // One row per repository holding an open project; VS Code's Source Control does the real work.
    _renderGit(snapshot, query) {
        if (!snapshot.git) {
            this._section.addMenuItem(this._item('Reading git status…', 'tracker-empty'));
            return;
        }
        const repos = gitRepos(snapshot.git.repos.filter(repo => `${repo.name} ${repo.branch}`.toLowerCase().includes(query)),
            this._setting('gitOrder'), this._gitFilter);
        if (!repos.length) this._section.addMenuItem(this._item('No matching repositories', 'tracker-empty'));
        for (const repo of repos) {
            // The VS Code window whose folder is this repository or inside it.
            const window = snapshot.windows.find(w => !w.kind && w.roots.some(root => repo.folders.includes(root)));
            const item = new PopupMenu.PopupBaseMenuItem({reactive: !!window, can_focus: !!window});
            item._ornamentLabel?.hide();
            item.add_style_class_name('tracker-conversation');
            const box = new St.BoxLayout({vertical: true, style_class: 'tracker-row', x_expand: true});
            const title = new St.Label({text: repo.name, style_class: 'tracker-title', x_expand: true});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(title);
            const lines = repo.error ? [[repo.error, 'tracker-failed']] : [[gitDetail(repo), 'tracker-detail'],
                [repo.commit_at ? `Last commit ${age(repo.commit_at)}: ${repo.subject}` : 'No commits yet', 'tracker-detail tracker-muted']];
            if (!window) lines.push(['Not open in a VS Code window', 'tracker-detail tracker-muted']);
            for (const [text, style] of lines) {
                const label = new St.Label({text, style_class: style});
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                box.add_child(label);
            }
            item.add_child(box);
            const [chip, style] = repo.error ? ['Unreadable', 'failed'] : repo.conflicts ? ['Conflicts', 'failed']
                : repo.operation ? [repo.operation.charAt(0).toUpperCase() + repo.operation.slice(1), 'attention']
                    : gitChanges(repo) ? [`${gitChanges(repo)} changed`, 'working']
                        : repo.ahead ? ['Unpushed', 'waiting'] : ['Clean', 'finished'];
            item.add_child(new St.Label({text: chip, style_class: `tracker-chip tracker-chip-${style}`, y_align: Clutter.ActorAlign.CENTER}));
            if (repo.web) {
                const web = new St.Button({child: new St.Icon({icon_name: 'external-link-symbolic', icon_size: 16}),
                    can_focus: true, accessible_name: `Open ${repo.web}`, style_class: 'tracker-window-control', y_align: Clutter.ActorAlign.CENTER});
                web.connect('clicked', () => {
                    this._button.menu.close();
                    Gio.AppInfo.launch_default_for_uri(repo.web, null);
                });
                item.add_child(web);
            }
            if (window) item.connect('activate', () => this._showScm(window, snapshot));
            this._section.addMenuItem(item);
        }
        for (const warning of snapshot.warnings.filter(text => /git/i.test(text)))
            this._section.addMenuItem(this._item(warning, 'tracker-warning'));
    }

    // Brings a VS Code window forward, then opens its Source Control view where the bridge can.
    async _showScm(window, snapshot) {
        const result = await this._activate({window: window.id, key: null}, snapshot, 'place');
        if (!result?.ok || !this._enabled) return;
        try {
            if (window.scm) await this._run(['show-scm', window.id]);
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
        }
    }

    _renderHistory(snapshot, query) {
        if (!this._inventory) {
            this._section.addMenuItem(this._item(this._inventoryError || 'Loading saved conversations…',
                this._inventoryError ? 'tracker-warning' : 'tracker-empty'));
            return;
        }
        const open = new Map(snapshot.rows.filter(row => row.target).map(row => [row.key, row]));
        const matches = this._inventory.conversations.filter(row => (this._historyFilter === 'all' || row.provider === this._historyFilter)
            && `${row.title} ${row.folder} ${row.provider}`.toLowerCase().includes(query));
        // A search expands every folder, so it shows only the most recent matches.
        const rows = query ? matches.slice(0, HISTORY_SEARCH_LIMIT) : matches;
        const order = this._setting('historyOrder');
        for (const [folder, items] of historyGroups(rows, order)) {
            const key = `history:${folder}`;
            if (!this._historySeen.has(key)) {
                this._historySeen.add(key);
                this._collapsedProjects.add(key);
            }
            const live = items.filter(row => open.has(row.key)).length;
            const parent = folder.replace(GLib.get_home_dir(), '~').replace(/\/[^/]*$/, '') || '/';
            const window = folderWindow(snapshot.windows, folder);
            const total = order === 'total' ? ` · ${duration(items.reduce((n, row) => n + row.active, 0))} active` : '';
            this._projectSection(key, items[0].project, parent,
                `${items.length} chat${items.length === 1 ? '' : 's'}${live ? ` · ${live} open` : ''}${total} · ${age(items[0].last)}`,
                false, window ? this._windowControls(window.id, snapshot) : null,
                body => { for (const row of items) this._historyItem(row, open.get(row.key), snapshot, body); });
        }
        if (matches.length > rows.length)
            this._section.addMenuItem(this._item(`${matches.length - rows.length} more matches · refine the search`, 'tracker-empty'));
        if (!rows.length) this._section.addMenuItem(this._item('No matching saved conversations', 'tracker-empty'));
    }

    _historyItem(row, live, snapshot, section) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: row.available, can_focus: row.available});
        item._ornamentLabel?.hide();
        item.add_style_class_name('tracker-conversation');
        item.add_child(this._providerLabel(row.provider));
        const box = new St.BoxLayout({vertical: true, style_class: 'tracker-row', x_expand: true});
        const title = new St.Label({text: row.title, style_class: 'tracker-title', x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(title);
        const detail = new St.Label({text: historyDetail(row), style_class: 'tracker-detail'});
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(detail);
        item.add_child(box);
        const [chip, style] = live ? ['Open', 'open'] : row.available ? ['Resume', 'muted'] : ['Folder missing', 'failed'];
        item.add_child(new St.Label({text: chip, style_class: `tracker-chip tracker-chip-${style}`, y_align: Clutter.ActorAlign.CENTER}));
        item.connect('activate', () => (live ? this._activate(live, snapshot) : this._resume(row)));
        section.addMenuItem(item);
    }

    // History, and the Conversations list when sorted by total activity, read the inventory.
    _usesInventory() {
        return this._view === 'history' || (this._view === 'conversations' && this._setting('projectOrder') === 'total');
    }

    _historyNoteText() {
        if (this._refreshing) return 'Scanning…';
        return this._inventory ? `Scanned ${age(this._inventory.updated)}` : 'Not scanned yet';
    }

    _loadInventory() {
        Gio.File.new_for_path(`${ROOT}/inventory.json`).load_contents_async(this._cancel, (file, result) => {
            if (!this._enabled) return;
            try {
                const [, bytes] = file.load_contents_finish(result);
                const inventory = JSON.parse(ByteArray.toString(bytes));
                if (inventory.schema !== 1) throw new Error('Unsupported conversation inventory');
                // Rebuilding the list replaces every row; skip it when nothing changed.
                if (this._inventory?.updated === inventory.updated && !this._inventoryError) return;
                this._inventory = inventory;
                this._inventoryError = null;
            } catch (error) {
                this._inventoryError = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
                    ? 'No inventory yet · press ⟳ to scan saved conversations' : error.message;
            }
            this._historyNote?.set_text(this._historyNoteText());
            if (this._button.menu.isOpen && this._usesInventory() && !this._page) this._renderRows();
        });
    }

    // The same oneshot unit as the daily timer, so a scan never runs twice at once.
    _refreshInventory() {
        if (this._refreshing) return;
        this._refreshing = true;
        this._historyNote?.set_text(this._historyNoteText());
        const done = error => {
            this._refreshing = false;
            if (!this._enabled) return;
            if (error) Main.notifyError('Agent Bar', error.message);
            this._loadInventory();
        };
        try {
            const process = Gio.Subprocess.new(['systemctl', '--user', 'start', 'agent-bar-inventory.service'],
                Gio.SubprocessFlags.STDERR_PIPE);
            process.communicate_utf8_async(null, this._cancel, (proc, result) => {
                try {
                    const [, , stderr] = proc.communicate_utf8_finish(result);
                    if (!proc.get_successful())
                        throw new Error(stderr.trim() || 'Inventory scan failed; see journalctl --user -u agent-bar-inventory');
                    done(null);
                } catch (error) { done(error); }
            });
        } catch (error) { done(error); }
    }

    // Opens the folder in VS Code and waits for its bridge to reopen the conversation,
    // then shows it like any other open conversation once the tracker sees it.
    async _resume(row) {
        if (this._resuming) return;
        this._resuming = true;
        this._button.menu.close();
        try {
            await this._run(['resume', row.key]);
            for (let i = 0; i < 40; i++) {
                await this._delay(250);
                if (!this._enabled) return;
                const live = this._snapshot?.rows.find(r => r.key === row.key && r.target);
                if (live) {
                    await this._activate(live, this._snapshot, 'focus');
                    return;
                }
            }
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
        } finally { this._resuming = false; }
    }

    _providerLabel(name) {
        const provider = new St.BoxLayout({style_class: 'tracker-row-provider'});
        provider.add_child(new St.Label({text: PROVIDERS[name]?.[0] || '•',
            style_class: `tracker-provider-symbol tracker-${name}`}));
        provider.add_child(new St.Label({text: PROVIDERS[name]?.[1] || name,
            style_class: `tracker-provider-name tracker-${name}`, y_align: Clutter.ActorAlign.CENTER}));
        return provider;
    }

    // Explicit window placement; a control whose result already holds changes nothing.
    _windowControls(id, snapshot) {
        const box = new St.BoxLayout({style_class: 'tracker-window-controls', y_align: Clutter.ActorAlign.CENTER});
        for (const [icon, mode, name] of [
            ['window-restore-symbolic', 'return', 'Return to its previous place'],
            ['window-maximize-symbolic', 'place', 'Show maximized on the main display']]) {
            const button = new St.Button({child: new St.Icon({icon_name: icon, icon_size: 16}),
                can_focus: true, accessible_name: name, style_class: 'tracker-window-control'});
            button.connect('clicked', () => this._activate({window: id, key: null}, snapshot, mode));
            box.add_child(button);
        }
        return box;
    }

    _conversationItem(row, snapshot, section) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: !!row.target, can_focus: !!row.target});
        item._ornamentLabel?.hide();
        item.add_style_class_name('tracker-conversation');
        if (row.unread.length) item.add_style_class_name('tracker-unread');
        item.add_child(this._providerLabel(row.provider));
        const box = new St.BoxLayout({vertical: true, style_class: 'tracker-row', x_expand: true});
        const title = new St.Label({text: row.title, style_class: 'tracker-title', x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(title);
        const native = this._findWindow(snapshot.windows.find(w => w.id === row.window), false);
        const borrowed = native && this._borrowed.get(row.window);
        const action = borrowed?.key === row.key && native === this._menuFocus ? ' · click to return' : '';
        const state = row.state.charAt(0).toUpperCase() + row.state.slice(1);
        const surface = row.surface ? ` · ${row.surface === 'terminal' ? 'terminal' : row.surface_label}` : '';
        const letters = snapshot.messages?.unread[row.key];
        const detail = new St.Label({text: `${state} · ${age(row.state_at)}${surface}${letters ? ` · ✉ ${letters} unread` : ''}${action}`,
            style_class: `tracker-detail tracker-${stateStyle(row.state)}`});
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(detail);
        // A finished reply is what "Needs review" means by default; any other reason is spelled out.
        if (row.unread.some(reason => reason !== 'Reply finished'))
            box.add_child(new St.Label({text: row.unread.join(' · '), style_class: 'tracker-reason tracker-attention'}));
        item.add_child(box);
        item.add_child(new St.Label({text: row.unread.length ? 'Needs review' : state,
            style_class: `tracker-chip tracker-chip-${row.unread.length ? 'attention' : stateStyle(row.state)}`,
            y_align: Clutter.ActorAlign.CENTER}));
        item.connect('activate', () => this._activate(row, snapshot));
        section.addMenuItem(item);
    }

    _findWindow(window, strict = true) {
        if (!window) return null;
        if (window.kind) return this._ownedWindow(window, strict);
        const candidates = global.get_window_actors().map(a => a.meta_window)
            .filter(w => /^(code|code_code)$/i.test(w.get_wm_class() || ''));
        const names = name => w => w.get_title().endsWith(` - ${name} - Visual Studio Code`)
            || w.get_title() === `${name} - Visual Studio Code`;
        // A window without a folder has no folder in its title: accept any title that
        // names none of the tracked folder windows.
        const folders = (this._snapshot?.windows || []).filter(b => !b.kind && b.workspace !== EMPTY).map(b => names(b.workspace));
        const titled = window.workspace === EMPTY ? w => !folders.some(test => test(w)) : names(window.workspace);
        if (window.nativeId) {
            // A focus race can record another VS Code window's ID; its title names a different project.
            const exact = candidates.filter(w => titled(w)
                && w.get_description().split(' ')[0].toLowerCase() === window.nativeId.toLowerCase());
            if (exact.length === 1) return exact[0];
        }
        // Only a unique workspace name among BOTH live bridges and native
        // windows is eligible. Duplicate project windows require a focus handshake.
        const bridges = this._snapshot?.windows.filter(w => !w.kind && w.workspace === window.workspace) || [];
        const matches = candidates.filter(titled);
        if (bridges.length === 1 && matches.length === 1) return matches[0];
        if (strict) throw new Error('Window identity is ambiguous. Focus that VS Code window once, then retry.');
        return null;
    }

    // The Codex app's own link selects the conversation, and reopens the app's window if it was closed.
    async _openAppThread(window, row) {
        Gio.AppInfo.launch_default_for_uri(`codex://threads/${row.id}`, null);
        for (let i = 0; i < 40 && this._enabled && !this._ownedWindow(window, false); i++) await this._delay(125);
    }

    // A terminal or app session's window: the one normal window its processes own, or among several
    // (one terminal server owns every terminal window) the one titled after its conversation.
    _ownedWindow(window, strict) {
        const pids = new Set(window.pids);
        const owned = global.get_window_actors().map(actor => actor.meta_window)
            .filter(win => win.get_window_type() === Meta.WindowType.NORMAL && pids.has(win.get_pid()));
        const titled = owned.filter(win => window.titles.some(title => win.get_title().includes(title)));
        const found = owned.length === 1 ? owned[0] : titled.length === 1 ? titled[0] : null;
        if (!found && strict) {
            const name = window.kind === 'terminal' ? 'terminal' : window.label;
            throw new Error(owned.length ? `${owned.length} windows belong to this ${name}`
                + ' and none is titled after this conversation; bring it forward yourself.'
                : window.kind === 'terminal' ? 'No window found for this terminal session (it may run inside tmux).'
                    : `The ${name} has no window open for this conversation.`);
        }
        return found;
    }

    _run(args) {
        return new Promise((resolve, reject) => {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
            try {
                const process = launcher.spawnv([CLI, ...args]);
                process.communicate_utf8_async(null, this._cancel, (proc, result) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                        const value = JSON.parse(stdout || '{}');
                        if (!proc.get_successful() || value.ok === false)
                            throw new Error(value.error || stderr || 'agent-bar command failed');
                        resolve(value);
                    } catch (error) { reject(error); }
                });
            } catch (error) { reject(error); }
        });
    }

    _placed(win) {
        return win.get_monitor() === Main.layoutManager.primaryIndex && !win.is_fullscreen()
            && win.maximized_horizontally && win.maximized_vertically
            && win.get_workspace().index() === global.workspace_manager.get_active_workspace_index();
    }

    // Moving a borrowed window manually takes precedence over its remembered destination.
    _returnable(win, saved) {
        return !!saved && win.get_description().split(' ')[0] === saved.nativeId
            && win.get_monitor() === Main.layoutManager.primaryIndex
            && win.get_workspace().index() === saved.placedWorkspace
            && win.maximized_horizontally && win.maximized_vertically;
    }

    _delay(ms) {
        return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve(); return GLib.SOURCE_REMOVE;
        }));
    }

    // mode: 'toggle' returns a borrowed window only while it has focus;
    // 'focus' always brings it forward; 'return' only sends it back;
    // 'place' shows the window maximized on the main display without selecting a chat.
    async _activate(row, snapshot, mode = 'toggle') {
        if (this._busy || this._error) return {ok: false, error: this._error || 'Navigation already in progress'};
        this._busy = true;
        const focused = this._button.menu.isOpen ? this._menuFocus : global.display.focus_window;
        const returnOnly = mode === 'return';
        this._button.menu.close();
        this._nav?.menu.close();
        this._clusterButton?.menu.close();
        try {
            const record = snapshot.windows.find(w => w.id === row.window);
            if (record?.kind === 'app' && row.provider === 'codex' && row.key) await this._openAppThread(record, row);
            if (!this._enabled) return;
            const win = this._findWindow(record);
            const id = row.window;
            const borrowed = this._borrowed.get(id);
            if (borrowed && !this._returnable(win, borrowed)) {
                this._borrowed.delete(id);
                await this._run(['clear-return', id]);
                if (returnOnly) return {ok: true, action: 'manual move preserved'};
            }
            const current = this._borrowed.get(id);
            if (returnOnly && !current) return {ok: true, action: 'nothing to return'};
            if (mode === 'place' && this._placed(win)) {
                Main.activateWindow(win);
                return {ok: true, action: 'raised'};
            }
            if (current && (returnOnly || (mode === 'toggle' && current.key === row.key && focused === win
                && this._setting('focusedClick') === 'return'))) {
                if (current.monitor >= Main.layoutManager.monitors.length)
                    throw new Error('The original display is no longer connected');
                const monitor = Main.layoutManager.monitors[current.monitor];
                if (monitor.x !== current.monitorRect.x || monitor.y !== current.monitorRect.y ||
                    monitor.width !== current.monitorRect.width || monitor.height !== current.monitorRect.height)
                    throw new Error('The display layout changed; move this window back manually');
                if (win.is_fullscreen()) win.unmake_fullscreen();
                win.unmaximize(Meta.MaximizeFlags.BOTH);
                await this._delay(100);
                if (!this._enabled) return;
                win.move_to_monitor(current.monitor);
                win.change_workspace_by_index(current.workspace, false);
                win.move_resize_frame(true, current.rect.x, current.rect.y, current.rect.width, current.rect.height);
                if (current.maximized) win.maximize(current.maximized);
                if (current.fullscreen) win.make_fullscreen();
                if (current.minimized) win.minimize();
                this._borrowed.delete(id);
                await this._run(['clear-return', id]);
                return {ok: true, action: 'returned'};
            }
            if (!current) {
                const rect = win.get_frame_rect();
                const monitor = Main.layoutManager.monitors[win.get_monitor()];
                this._borrowed.set(id, {key: null, monitor: win.get_monitor(),
                    workspace: win.get_workspace().index(), rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                    monitorRect: {x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height},
                    nativeId: win.get_description().split(' ')[0],
                    placedWorkspace: global.workspace_manager.get_active_workspace_index(),
                    maximized: win.get_maximized(), fullscreen: win.is_fullscreen(), minimized: win.minimized});
                await this._run(['save-return', id, JSON.stringify(this._borrowed.get(id))]);
            }
            if (!this._placed(win)) {
                if (win.is_fullscreen()) win.unmake_fullscreen();
                win.unmaximize(Meta.MaximizeFlags.BOTH);
                win.change_workspace(global.workspace_manager.get_active_workspace());
                // move_to_monitor() shifts by the window's position relative to a monitor
                // Mutter may not have updated yet after unmaximizing, which lands it on
                // another display. Place the frame inside the primary work area instead.
                const area = win.get_work_area_for_monitor(Main.layoutManager.primaryIndex);
                const rect = win.get_frame_rect();
                win.move_resize_frame(false, area.x, area.y,
                    Math.min(rect.width, area.width), Math.min(rect.height, area.height));
                win.maximize(Meta.MaximizeFlags.BOTH);
            }
            Main.activateWindow(win);
            for (let i = 0; i < 8 && !this._placed(win); i++) {
                await this._delay(125);
                if (!this._enabled) return;
            }
            if (!this._placed(win))
                throw new Error('The window did not maximize on the primary display');
            if (mode === 'place') return {ok: true, action: 'placed'};
            await this._run(['navigate', row.key, row.window]);
            this._borrowed.get(id).key = row.key;
            await this._run(['save-return', id, JSON.stringify(this._borrowed.get(id))]);
            // The captured cutoff ensures a newer completion remains unread.
            await this._run(['ack', row.key, String(snapshot.cutoff)]);
            this._read();
            return {ok: true, action: 'focused'};
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
            return {ok: false, error: error.message};
        } finally { this._busy = false; }
    }

    disable() {
        this._enabled = false;
        const focus = global.stage.get_key_focus();
        if (focus && [Main.panel, this._button.menu.actor, this._nav.menu.actor, this._clusterButton.menu.actor]
            .some(actor => actor.contains(focus))) global.stage.set_key_focus(null);
        this._cancel.cancel();
        if (this._timer) GLib.source_remove(this._timer);
        this._menuSwitch.restore();
        this._dbus?.unexport();
        this._quickMenu.destroy();
        this._quickRight.destroy();
        this._quick.destroy();
        this._nav.destroy();
        this._clusterButton.destroy();
        this._button.destroy();
        this._button = null;
    }
}

function init() { return new Tracker(); }
