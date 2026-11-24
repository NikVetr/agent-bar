/* exported init */
const {Clutter, Gio, GLib, Meta, Pango, St} = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const CheckBox = imports.ui.checkBox;
const ByteArray = imports.byteArray;
const ROOT = GLib.build_filenamev([GLib.get_home_dir(), '.local/state/agent-bar']);
// The agent-bar command; pipx and uv install it in ~/.local/bin, which a GNOME session's PATH may lack.
const CLI = GLib.find_program_in_path('agent-bar') || GLib.build_filenamev([GLib.get_home_dir(), '.local/bin/agent-bar']);
const INTERFACE = `<node><interface name="io.github.nikvetr.AgentBar">
<method name="Inspect"><arg type="s" direction="out"/></method>
<method name="Show"/><method name="Hide"/>
<method name="Activate"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<method name="Reload"/>
</interface></node>`;
const UUID = 'agent-bar@nikvetr.github.io';
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
    ['Top bar', 'quickLimit', 'Review buttons', 'At most this many shortcuts, one per project, as room allows; +N more lists the rest', 6,
        [[0, 'Off'], [3, '3'], [6, '6'], [10, '10']]],
    ['Top bar', 'quickChars', 'Button name length', 'Characters of the folder name on each shortcut', 16,
        [[12, '12'], [16, '16'], [24, '24']]],
    ['Top bar', 'quickReasons', 'Review buttons for', 'What gives a chat a shortcut; the Chats tab shows every chat needing review either way',
        ['Reply finished', 'Turn failed', 'Input needed', 'Approval needed', 'Queues finished'],
        [['Reply finished', 'Reply finished'], ['Turn failed', 'Turn failed'], ['Input needed', 'Question'], ['Approval needed', 'Approval'],
            ['Queues finished', 'Queues finished'], ['Usage limit', 'Stopped at a usage limit']]],
    ['Top bar', 'quotaBar', 'Limits left', 'Each provider\'s weekly usage limit left, after the chat counts', true,
        [[true, 'Show'], [false, 'Hide']]],
    ['Top bar', 'ticketBar', 'Ticket count', 'Tickets that came due (waited for something that has passed), or every ticket ready to start', 'due',
        [['due', 'Came due'], ['ready', 'All ready'], ['off', 'Hide']]],
    ['Top bar', 'queueBar', 'Queue count', 'Q finished / outstanding since each project\'s last turn', true,
        [[true, 'Show'], [false, 'Hide']]],
    ['Cluster', 'clusterBar', 'Top-bar indicator', 'What it shows; with only Warnings it appears just when one fires', ['cpu', 'warnings'],
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
    ['Integrations', 'wake', 'Wake idle chats', 'A message starts a turn in an idle Claude Code chat (up to a week after its last turn), or in a Codex chat open in VS Code once any turn in progress ends', false,
        [[true, 'On'], [false, 'Off']]],
    ['Integrations', 'resumeCodex', 'Resume Codex after reset', 'Continue open VS Code threads after their five-hour usage limit resets', false,
        [[true, 'On'], [false, 'Off']]],
    ['Integrations', 'claudeUsage', 'Read Claude limits', 'Every 10 minutes, ask Claude for your usage limits with Claude Code\'s sign-in, '
        + 'as /usage does (an undocumented endpoint); otherwise they update only when Claude Code fetches them', false,
        [[true, 'On'], [false, 'Off']]],
    ['Integrations', 'midturn', 'Messages to a busy Claude chat', 'With waking on, whether a message can arrive during its turn instead of right after it', 'after',
        [['after', 'After its turn'], ['urgent', 'Urgent mid-turn'], ['always', 'Mid-turn']]],
    ['Appearance', 'palette', 'State colors', 'Colors for review, working, waiting, failed and finished', 'default',
        [['default', 'Default'], ['colorblind', 'Color-blind safe']]],
];
const QUEUE_BAR = 180;
// The most room the focused app's name, left of the tracker, keeps once it has needed it.
const APP_MENU_MAX = 300;
// How long the pointer must rest on another top-bar button before an open tracker dropdown gives way to it.
const MENU_SWITCH_DELAY = 500;
// History rows shown while searching; folders otherwise build rows only when expanded.
const HISTORY_SEARCH_LIMIT = 40;
// Recently active folders a new ticket offers before All lists the rest.
const TICKET_FOLDERS = 6;
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

/** @param {string} workers @param {{default: number, hosts?: Record<string, number|string>} | undefined} setting */
function queuePriority(workers, setting) {
    // The monitor's worker column carries P50 or P50* even for queues without editable controls.
    const monitored = /(?:^|\s)P(-?\d+)(\*)?(?=\s|$)/.exec(workers);
    const value = setting?.default ?? (monitored ? Number(monitored[1]) : null);
    if (value === null) return null;
    let tip = `Default queue priority: ${value}. Higher numbers get available slots first.`;
    const hosts = Object.entries(setting?.hosts || {});
    if (hosts.length) tip += '\nHost overrides: ' + hosts.map(([host, priority]) => `${host} ${priority}`).join(', ');
    else if (!setting && monitored?.[2]) tip += '\nThis queue has per-host priority overrides.';
    return {value, tip};
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

// What identifies a chat, open (with its roots) or saved (with its folder), for the clipboard: its name, key, project
// and folders, and how to resume it in a terminal.
function chatIdentity(row) {
    const resume = {claude: `claude --resume ${row.id}`, codex: `codex resume ${row.id}`}[row.provider];
    return [row.title, `Chat: ${row.key}`, `Project: ${row.project}`, ...(row.roots || [row.folder].filter(Boolean)).map(root => `Folder: ${root}`),
        ...resume ? [`Resume: ${resume}`] : []].join('\n');
}

function completionTime(row) {
    return row.completed_at || (row.state === 'finished' ? row.state_at : 0);
}

// Open chats needing review for one of `reasons` (any, when null), the longest waiting first: since the oldest of
// those reasons arrived. A turn a usage limit stopped counts as 'Usage limit', not 'Turn failed': nothing in it needs
// the user until the limit resets.
function readyConversations(rows, reasons = null) {
    const unique = new Map();
    const counts = (reason, row) => !reasons || reasons.includes(row.limited && reason === 'Turn failed' ? 'Usage limit' : reason);
    for (const row of rows)
        if (row.target && !unique.has(row.key) && row.unread.some(reason => counts(reason, row)))
            unique.set(row.key, row);
    const since = row => {
        const times = Object.entries(row.unread_at || {}).filter(([reason]) => counts(reason, row)).map(([, at]) => at);
        return times.length ? Math.min(...times) : completionTime(row);
    };
    return [...unique.values()].sort((a, b) => since(a) - since(b));
}

// Chats needing review by project, one shortcut each, in the order of each project's longest-waiting chat.
function quickGroups(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (!groups.has(row.project)) groups.set(row.project, []);
        groups.get(row.project).push(row);
    }
    return [...groups.values()];
}

// Grow `widths` by up to `extra` in total, none past its `limits`, sharing it evenly (what one cannot use goes to the
// others).
function shareWidth(widths, limits, extra) {
    const result = [...widths];
    let left = Math.max(0, extra);
    for (let open = result.map((_, i) => i).filter(i => limits[i] > result[i]); left > 0.5 && open.length;
        open = open.filter(i => limits[i] > result[i])) {
        const each = left / open.length;
        for (const i of open) {
            const add = Math.min(each, limits[i] - result[i]);
            result[i] += add;
            left -= add;
        }
    }
    return result.map(Math.floor);
}

// Open VS Code chats a usage limit stopped, which Continue can have go on; Codex ones first, as they need no window.
function limitedConversations(rows) {
    const unique = new Map();
    for (const row of rows)
        if (row.limited && ['tab', 'codex-sidebar', 'codex-editor'].includes(row.target?.kind) && !unique.has(row.key)) unique.set(row.key, row);
    return [...unique.values()].sort((a, b) => (a.provider !== 'codex') - (b.provider !== 'codex'));
}

// The Tickets tab's groups, each non-empty: ready to start, scheduled to be sent to a chat, waiting, started, then
// recently closed.
function ticketGroups(listing, query = '') {
    const match = ticket => `#${ticket.id} ${ticket.body} ${ticket.project} ${ticket.author_title || ''} ${ticket.deliver_title || ''}`
        .toLowerCase().includes(query);
    const open = (listing?.open || []).filter(match);
    const kept = open.filter(ticket => !ticket.deliver_to);
    return [['Ready', kept.filter(ticket => ticket.ready)], ['Scheduled', open.filter(ticket => ticket.deliver_to && ticket.status === 'open')],
        ['Waiting', kept.filter(ticket => ticket.status === 'open' && !ticket.ready)],
        ['Started', open.filter(ticket => ticket.status === 'started')], ['Closed', (listing?.closed || []).filter(match)]]
        .filter(([, tickets]) => tickets.length);
}

// A checklist's progress: done over done and open ([-] dropped items left out), and how to say it; with nothing open,
// "no open items recorded", never "done", since an empty or dropped-only file is not finished work.
function checklistProgress(file) {
    const total = file.done + file.open;
    const text = file.open ? `${file.done} of ${total} done` : `No open items recorded${file.done ? ` · ${file.done} done` : ''}`;
    return {fraction: total ? file.done / total : 0,
        text: text + (file.dropped ? ` · ${file.dropped} dropped` : '') + (file.unknown ? ` · ${file.unknown} with an unrecognized marker` : '')};
}

// A chat's project checklists in three groups: those it was seen editing, others updated recently, and older ones that
// still have open items.
function checklistSections(files, key) {
    const mine = files.filter(file => (file.editors || []).some(([editor]) => editor === key));
    const others = files.filter(file => !mine.includes(file));
    return [['Edited by this chat', mine], ['Recently updated', others.filter(file => file.recent)],
        ['Older, with open items', others.filter(file => !file.recent)]].filter(([, list]) => list.length);
}

// The open tickets to be sent to one chat.
function scheduledFor(listing, key) {
    return (listing?.open || []).filter(ticket => ticket.deliver_to === key && ticket.status === 'open');
}

// A local time as a ticket's date wait reads it: YYYY-MM-DD HH:MM.
function localStamp(date) {
    const two = n => `${n}`.padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

// Quick choices of when to send: in an hour, tomorrow at 9, and next Monday at 9.
function whenChoices(now = new Date()) {
    const at = (days, hour) => {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0);
        return localStamp(date);
    };
    const monday = (8 - now.getDay()) % 7 || 7;
    return [['+1h', 'In an hour'], [at(1, 9), 'Tomorrow 9:00'], [at(monday, 9), 'Monday 9:00']];
}

// Who wrote or took a ticket: you, or a chat by its provider's symbol and title.
function ticketWho(key, title) {
    return key === 'user' ? 'you' : `${PROVIDERS[key.split(':')[0]]?.[0] || '•'} ${title || key}`;
}

// A ticket's number, project, author and age.
function ticketMeta(ticket) {
    return [`#${ticket.id}`, ticket.project, `by ${ticketWho(ticket.author, ticket.author_title)}`, age(ticket.at)].join(' · ');
}

// What an open ticket waits for, who took a started one, or how a closed one ended.
function ticketNote(ticket) {
    if (ticket.status === 'open' && ticket.deliver_to) {
        const to = `${PROVIDERS[ticket.deliver_to.split(':')[0]]?.[0] || '•'} ${ticket.deliver_title || ticket.deliver_to}`;
        if (ticket.delivery_error) return `Not sent to ${to} yet: ${ticket.delivery_error}. Tries again every 10 minutes.`;
        return `Sends to ${to} ${ticket.waiting?.length ? `when ${ticket.waiting.join(' and ')}` : 'now'}`
            + (ticket.sent_count ? ` · sent ${ticket.sent_count} time${ticket.sent_count === 1 ? '' : 's'}` : '');
    }
    if (ticket.status === 'open') return ticket.waiting?.length ? `Waits until ${ticket.waiting.join(' and ')}` : '';
    if (ticket.status === 'started') return `Taken by ${ticketWho(ticket.taken_by, ticket.taken_title)} ${age(ticket.status_at)}`;
    return `${ticket.status === 'done' ? 'Done' : 'Dropped'} ${age(ticket.status_at)}${ticket.note ? `: ${ticket.note}` : ''}`;
}

// A ticket's status chip and its tone.
function ticketStatus(ticket) {
    if (ticket.status === 'open' && ticket.deliver_to) return ticket.delivery_error ? ['Not sent', 'failed'] : ['Scheduled', 'working'];
    if (ticket.status !== 'open') return {started: ['Started', 'working'], done: ['Done', 'finished'], dropped: ['Dropped', 'muted']}[ticket.status];
    return ticket.ready ? ['Ready', 'attention'] : ['Waiting', 'waiting'];
}

// The tickets the top-bar count shows: ready ones that waited for something ('due'), every ready one ('ready'), or none.
function countedTickets(listing, which) {
    // A ticket to be sent counts only when sending it failed: otherwise it goes on its own.
    return (listing?.open || []).filter(ticket => ticket.deliver_to ? !!ticket.delivery_error
        : ticket.ready && (which === 'ready' || which === 'due' && ticket.after?.length > 0));
}

// Folders a new ticket can go in: open chats' folders, most recently active first, then other open windows'.
function ticketFolders(snapshot) {
    const folders = new Map();
    const rows = [...(snapshot?.rows || [])].sort((a, b) => (b.state_at || 0) - (a.state_at || 0));
    for (const folder of [...rows.flatMap(row => row.roots || []),
        ...(snapshot?.windows || []).flatMap(window => window.kind === 'app' ? [] : window.roots || [])])
        if (!folders.has(folder)) folders.set(folder, folder.split('/').filter(Boolean).at(-1) || folder);
    return [...folders];
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

/** @typedef {{role: string, text: string}} HistoryNeighbor */
/** @typedef {{role: string, message: number, messages: number, hit: number, hits: number,
 * parts: string[], before?: HistoryNeighbor, after?: HistoryNeighbor}} HistoryContext */
/** @typedef {{query: string, repo: string, hits: Map<string, {role: string, excerpt: string, parts?: string[]}>,
 * details: Map<string, {context?: HistoryContext, loading: boolean, error: string}>,
 * loading: boolean, error: string, updated?: number, timer: number}} HistoryLookup */

/** @param {{key: string, folder?: string, roots?: string[], title: string, project: string, provider: string}} row
 * @param {HistoryLookup} lookup */
function matchesChatSearch(row, lookup) {
    const {repo, query} = lookup;
    if ((!repo && !query) || lookup.hits.has(row.key)) return true;  // Message hits already respect the repo scope.
    const folders = (row.folder ? [row.folder] : row.roots?.length ? row.roots : [row.project]).map(path => path.toLowerCase());
    return (!repo || folders.some(folder => folder.split('/').includes(repo) || folder === repo ||
        folder.startsWith(repo === '/' ? '/' : repo + '/'))) &&
        [row.title, row.project, row.provider, ...folders].some(text => text.toLowerCase().includes(query));
}

// Odd parts are matches. Escape conversation text before giving it to Pango.
/** @param {{clutter_text: {set_markup(text: string): void}}} label @param {string[]} parts */
function highlightHistoryParts(label, parts) {
    label.clutter_text.set_markup(parts.map((part, i) => {
        const text = GLib.markup_escape_text(part, -1);
        return i % 2 ? `<b><u>${text}</u></b>` : text;
    }).join(''));
}

/** @param {{text: string, clutter_text: {set_markup(text: string): void}}} label @param {string} query */
function highlightHistoryText(label, query) {
    if (!query) return;
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = label.text.split(new RegExp(`(${literal})`, 'giu'));
    if (parts.length > 1) highlightHistoryParts(label, parts);
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

// Busy allotted cores over allotted cores, and memory used over total, for reachable hosts in scope. A host's
// allotted cores are the job slots parallel-workers allows it (its cores when the snapshot gives none); the rest are
// reserved, and take the host's load first, so only load beyond them keeps allotted cores busy, up to all of them.
// `slotted` says every counted host had slots; `down` names every host that is unreachable or has lost the shared
// mount.
function clusterTotals(snapshot, scope = 'all') {
    const hosts = snapshot.hosts.filter(host => host.ok && host.cpu && (scope === 'all' || !host.local));
    const sum = value => hosts.reduce((n, host) => n + (value(host) || 0), 0);
    const limit = host => (Number.isInteger(host.slots) ? host.slots : host.cpu.cores);
    const slots = sum(limit);
    const busy = sum(host => Math.min(limit(host),
        Math.max(0, host.cpu.cores * host.cpu.busy_pct / 100 - (host.cpu.cores - limit(host)))));
    const memory = sum(host => host.memory?.total_bytes);
    return {slots, busy, cpu: slots ? 100 * busy / slots : null,
        slotted: hosts.length > 0 && hosts.every(host => Number.isInteger(host.slots)),
        memory: memory ? 100 * sum(host => host.memory?.used_bytes) / memory : null,
        down: snapshot.hosts.filter(host => !host.ok || host.mount?.ok === false).map(host => host.id)};
}

// Keeps a top-bar widget at the widest it has been, so a number changing does not shift what follows it. The
// width goes in its style, where St raises the natural width with it; a minimum above the natural width set on
// the actor itself is a fatal error in Clutter's box layout.
function holdWidth(actor, most = Infinity) {
    const width = Math.min(most, actor.get_preferred_width(-1)[1]);
    if (width > (actor._held || 0)) {
        actor._held = width;
        restyle(actor, actor._style);
    }
}

// Sets an inline style that keeps any held width.
function restyle(actor, style = '') {
    actor._style = style;
    actor.set_style(style + (actor._held ? ` min-width: ${actor._held}px;` : '') || null);
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
    if (kind === 'gear') {
        // A plain gear: a ring with six short teeth.
        cr.setLineWidth(2);
        cr.arc(c, c, r * 0.58, 0, 2 * Math.PI);
        cr.stroke();
        cr.setLineWidth(2.6);
        for (let i = 0; i < 6; i++) {
            const angle = i * Math.PI / 3;
            cr.moveTo(c + Math.cos(angle) * r * 0.72, c + Math.sin(angle) * r * 0.72);
            cr.lineTo(c + Math.cos(angle) * (r + 0.5), c + Math.sin(angle) * (r + 0.5));
        }
        cr.stroke();
        return;
    }
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
    } else if (kind === 'ticket') {
        // A ticket stub: a card with a notch in each side.
        const top = size * 0.24, bottom = size * 0.76, notch = size * 0.14;
        cr.moveTo(1, top);
        cr.lineTo(size - 1, top);
        cr.arcNegative(size - 1, c, notch, -Math.PI / 2, Math.PI / 2);
        cr.lineTo(size - 1, bottom);
        cr.lineTo(1, bottom);
        cr.arcNegative(1, c, notch, Math.PI / 2, -Math.PI / 2);
        cr.closePath();
        cr.fill();
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

// Usage limits, as the service summarizes what Claude Code and Codex record (usage.py). A reading this old is shown
// dimmed: Claude Code refreshes its figures only when it fetches them, as /usage does.
const QUOTA_STALE = 6 * 3600;
// Stacked day bars: the first part (a scoped model, such as Fable) violet, the rest blue.
const QUOTA_COLORS = [[0.77, 0.65, 0.95, 0.95], [0.51, 0.73, 0.98, 0.95]];

// A provider's weekly limit for the top bar: what is left, and whether the reading is old or past its reset.
function quotaLeft(usage, provider, now = Date.now() / 1000) {
    const value = usage?.[provider];
    const weekly = value?.limits?.find(limit => limit.key === 'weekly');
    if (!weekly) return null;
    return {left: weekly.left, stale: now - value.as_of > QUOTA_STALE || weekly.expired, as_of: value.as_of, limit: weekly,
        limiting: value.limits.filter(limit => limit.limiting && !limit.expired)};
}

// The top-bar section's tooltip: each provider's limits, what is left of each and when it resets.
function quotaTooltip(usage) {
    const lines = [];
    for (const provider of Object.keys(PROVIDERS)) {
        const value = usage?.[provider];
        if (!value?.limits?.length) continue;
        lines.push(`${PROVIDERS[provider][1]}, reading ${age(value.as_of)}`);
        for (const limit of value.limits)
            lines.push(`  ${limit.name}: ${limit.expired ? 'reset since this reading' : `${Math.floor(limit.left)}% left, ${resetTime(limit.resets_at)}`}`);
    }
    return lines.length ? `Usage limits left\n${lines.join('\n')}\nClick for the Quota tab` : null;
}

// The style of what is left of a limit: amber under a quarter, red under a tenth.
function quotaStyle(left) {
    return left < 10 ? 'failed' : left < 25 ? 'attention' : 'muted';
}

// What a limit's pace implies, in a sentence, or null without a pace.
function quotaProjection(limit, asOf, now = Date.now() / 1000) {
    if (limit.expired) return null;
    const resets = limit.resets_at;
    if (limit.left <= 0) return resets ? `Used up until it resets, in ${duration(Math.round(resets - now))}.` : 'Used up.';
    if (!limit.pace) return null;
    const pace = `${limit.pace.per_hour.toFixed(limit.pace.per_hour < 1 ? 2 : 1)}%/h`;
    const basis = limit.pace.basis === 'day' ? `At the last day's pace (${pace})` : `At this window's average pace (${pace})`;
    if (!(limit.pace.per_hour > 0)) return `${basis}, it lasts to the reset.`;
    const out = limit.runs_out_at;
    if (resets && out >= resets) return `${basis}, it lasts to the reset, about ${Math.round(limit.at_reset)}% used by then.`;
    const when = new Date(out * 1000).toLocaleString('en-US', {weekday: 'short', hour: 'numeric', minute: '2-digit'});
    const early = resets ? `, ${duration(Math.round(resets - out))} before the reset` : '';
    return out < now ? `${basis}, it would have run out by ${when}${early}; this reading is ${age(asOf)}.`
        : `${basis}, it runs out ${when}, in ${duration(Math.round(out - now))}${early}.`;
}

// Bars of a weekly limit's use by day, each stacked by its parts, scaled to the busiest day (or 20 points), with
// room under them for day names drawn by the caller.
function paintDays(cr, width, height, days) {
    if (!days.length) return;
    const most = Math.max(20, ...days.map(day => day.used));
    const slot = width / days.length, bar = Math.min(28, slot * 0.6);
    days.forEach((day, index) => {
        let top = height;
        day.parts.forEach(([, value], part) => {
            const tall = height * value / most;
            if (tall <= 0) return;
            cr.setSourceRGBA(...QUOTA_COLORS[day.parts.length > 1 && part === 0 ? 0 : 1]);
            cr.rectangle(index * slot + (slot - bar) / 2, top - tall, bar, tall);
            cr.fill();
            top -= tall;
        });
        if (!(day.used > 0)) {
            cr.setSourceRGBA(1, 1, 1, 0.12);
            cr.rectangle(index * slot + (slot - bar) / 2, height - 1, bar, 1);
            cr.fill();
        }
    });
}

// Scheduler controls come from the scheduler's control command (parallel-workers' pw-control), which describes
// them and applies one change at a time; the panel renders what it describes and holds no scheduler logic.
const CONTROL_PROTOCOL = 1;

function controlProgram() {
    return [GLib.find_program_in_path('pw-control'), GLib.build_filenamev([GLib.get_home_dir(), '.local/bin/pw-control'])]
        .find(path => path && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) || null;
}

// What a control's inputs start with: its value as text, by field for a group and by host for a host map.
function controlTyped(control) {
    if (control.kind === 'group') return Object.fromEntries(control.fields.map(field => [field.name, controlTyped(field)]));
    if (control.kind === 'host-map')
        return Object.fromEntries(control.hosts.map(host => [host, control.value?.[host] === undefined ? '' : String(control.value[host])]));
    if (control.kind === 'choice') return control.value;
    return control.value === null || control.value === undefined ? '' : String(control.value);
}

// The value `typed` gives a control, as apply takes it, or {error} saying what to fix. Whole numbers are checked
// against the control's bounds here; the scheduler checks everything else.
function controlValue(control, typed) {
    const text = String(typed ?? '').trim();
    switch (control.kind) {
    case 'action':
        return {value: null};
    case 'integer': {
        if (!text) return control.optional ? {value: null} : {error: `${control.label} needs a whole number`};
        const value = /^-?\d+$/.test(text) ? Number(text) : NaN;
        const low = control.min ?? -Infinity, high = control.max ?? Infinity;
        if (Number.isNaN(value) || value < low || value > high)
            return {error: `${control.label} takes a whole number${control.min !== null && control.max !== null ? ` from ${control.min} to ${control.max}`
                : control.min !== null ? ` of at least ${control.min}` : control.max !== null ? ` of at most ${control.max}` : ''}`};
        return {value};
    }
    case 'text':
        return text ? {value: text} : control.optional ? {value: null} : {error: `${control.label} is required`};
    case 'choice':
        return control.choices.some(choice => choice.value === typed) ? {value: typed} : {error: `Choose ${control.label}`};
    case 'host-map': {
        // A blank host has no override.
        const value = {};
        for (const host of control.hosts) {
            const entry = String(typed?.[host] ?? '').trim().toLowerCase();
            if (!entry) continue;
            if (entry === 'off') {
                value[host] = 'off';
                continue;
            }
            const one = controlValue({kind: 'integer', label: `${control.label} on ${host}`, min: control.min, max: control.max}, entry);
            if (one.error) return {error: `${one.error}, or off`};
            value[host] = one.value;
        }
        return {value};
    }
    case 'group': {
        const value = {};
        for (const field of control.fields) {
            const one = controlValue(field, typed?.[field.name]);
            if (one.error) return one;
            value[field.name] = one.value;
        }
        return {value};
    }
    }
    return {error: `${control.label} is a ${control.kind} control, which this Agent Bar cannot edit`};
}

// A control's current value in a few words, for a control shown without inputs.
function controlSummary(control) {
    const one = (value, field = control) => value === null || value === undefined ? 'none'
        : field.kind === 'host-map' ? Object.entries(value).map(([host, v]) => `${host} ${v}`).join(', ') || 'none'
            : field.kind === 'choice' ? field.choices.find(choice => choice.value === value)?.label ?? String(value)
                : `${value}${field.unit ? ` ${field.unit}` : ''}`;
    if (control.kind === 'action') return '';
    if (control.kind === 'group') return control.fields.map(field => `${field.label} ${one(control.value?.[field.name], field)}`).join(' · ');
    return one(control.value);
}

// A control laid out as an action (a button, perhaps asking for a note first) rather than a row of inputs: an action,
// or a group of text fields only, such as a reason to record.
function controlIsAction(control) {
    return control.kind === 'action' || control.kind === 'group' && control.fields.every(field => field.kind === 'text');
}

// A setting's fields shown on its row, and the ones folded under it: all of one or two whole numbers or choices,
// otherwise the first.
function groupFields(control) {
    if (control.kind !== 'group') return [[control], []];
    const short = control.fields.length <= 2 && control.fields.every(field => ['integer', 'choice'].includes(field.kind));
    const shown = short ? control.fields.length : 1;
    return [control.fields.slice(0, shown), control.fields.slice(shown)];
}

// Facts split into lines of chips that fit a control panel, judged by their length in characters.
function chipLines(texts, room = 96) {
    const lines = [];
    for (const text of texts) {
        const line = lines.at(-1);
        if (line && line.reduce((n, t) => n + t.length + 4, 0) + text.length <= room) line.push(text);
        else lines.push([text]);
    }
    return lines;
}

// A value as text with object keys sorted, so equal values compare equal.
function controlKey(value) {
    const sorted = v => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])])) : v;
    return JSON.stringify(sorted(value ?? null));
}

// What `typed` would send for a control: {value, changed}, or {error}.
function controlChange(control, typed) {
    const result = controlValue(control, typed);
    return result.error ? result : {value: result.value, changed: controlKey(result.value) !== controlKey(control.value)};
}

// The apply request for one change. `expect` carries what the user saw, so a change made meanwhile is refused.
function controlRequest(target, control, value, poolId, requestId) {
    return {protocol: CONTROL_PROTOCOL, request_id: requestId, source: 'agent-bar', target, control: control.name, value,
        expect: {pool_id: poolId, value: control.value}};
}

// What decides whether the Queues tab redraws for a new description: controls and reachability, not facts.
function controlsSignature(described) {
    if (!described) return '';
    const controls = entity => [entity.id, entity.state, entity.enabled, entity.controls];
    return JSON.stringify([described.coordinator, controls(described.pool || {}), (described.hosts || []).map(controls),
        (described.queues || []).map(queue => [queue.snapshot_id, ...controls(queue)])]);
}

class Tracker {
    enable() {
        this._enabled = true;
        // A screen lock disables and re-enables this same object; disable() destroyed these widgets.
        this._side = this._sidePanel = this._schedule = this._checklistView = this._hostView = null;
        this._body = this._scroll = this._pickerList = this._clusterCards = this._clusterBarSignature = this._quotaSignature = null;
        this._cancel = new Gio.Cancellable();
        this._borrowed = new Map();
        this._returnsLoaded = false;
        this._filter = 'all';
        this._historyFilter = 'all';
        this._chatQuery = '';
        /** @type {HistoryLookup | null} */
        this._historyLookup = null;
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
        // Scheduler controls: the last description and when it was read, which entities have their controls open,
        // what was typed into them (with the value it was typed over), and changes applied that the description
        // does not show yet, by control.
        this._controls = null;
        this._controlsAt = 0;
        this._dependenciesAt = 0;
        /** @type {Set<number>} */
        this._coveredNumbers = new Set();
        this._dependencies = null;
        this._controlsError = null;
        this._openControls = new Set();
        this._controlInputs = new Map();
        this._controlApplied = new Map();
        // Refusals shown beside their control, and settings whose other fields are unfolded.
        this._controlErrors = new Map();
        this._controlFolds = new Set();
        // History folders start collapsed the first time they appear.
        this._historySeen = new Set();
        this._view = 'conversations';
        this._collapsedProjects = new Set();
        this._busy = false;
        this._button = new PanelMenu.Button(0.0, 'Agents');
        this._bar = new St.BoxLayout({style_class: 'agent-bar'});
        this._labels = {};
        this._ratios = {};
        // The top bar is a row of parts, each highlighted on its own and opening the dropdown on its tab, as separate
        // top-bar buttons would: the chat counts, the limits left, working and waiting, agent mail, and queues.
        this._parts = [];
        const part = (actor, tab) => {
            actor.add_style_class_name('agent-bar-part');
            actor.reactive = true;
            actor.track_hover = true;
            // The press reaches the part before the button that opens the menu; an open menu's grab takes the press
            // first and only closes it, as on any top-bar button.
            actor.connect('button-press-event', () => {
                this._openOn = tab;
                return Clutter.EVENT_PROPAGATE;
            });
            this._parts.push([actor, tab]);
            this._bar.add_child(actor);
            return actor;
        };
        const label = (key, style, initial) => {
            this._labels[key] = new St.Label({text: initial, style_class: style, y_align: Clutter.ActorAlign.CENTER});
            return this._labels[key];
        };
        const chats = part(new St.BoxLayout({style_class: 'tracker-bar-chats', y_align: Clutter.ActorAlign.CENTER}), 'conversations');
        for (const provider of Object.keys(PROVIDERS)) {
            const badge = new St.BoxLayout({style_class: 'tracker-provider-ratio', visible: PINNED.includes(provider)});
            const symbol = new St.Label({text: PROVIDERS[provider][0], style_class: `tracker-${provider}`, y_align: Clutter.ActorAlign.CENTER});
            // Never shortened to an ellipsis when the top bar is crowded.
            symbol.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            badge.add_child(symbol);
            badge.add_child(label(provider, 'tracker-quiet', '… / …'));
            this._ratios[provider] = badge;
            chats.add_child(badge);
        }
        // What is left of each provider's weekly limit, after the chat counts.
        this._quota = part(new St.BoxLayout({style_class: 'tracker-quota-bar', visible: false, y_align: Clutter.ActorAlign.CENTER}), 'quota');
        this._tooltip(this._quota, () => quotaTooltip(this._snapshot?.usage));
        this._bar.add_child(new St.Label({text: '│', style_class: 'tracker-bar-divider', y_align: Clutter.ActorAlign.CENTER}));
        const states = part(new St.BoxLayout({style_class: 'tracker-bar-states', y_align: Clutter.ActorAlign.CENTER}), 'conversations');
        states.add_child(label('working', 'tracker-working', '● …'));
        states.add_child(label('waiting', 'tracker-waiting', ''));
        this._labels.waiting.visible = false;
        // Chats whose agent mail waits for you to start a turn there.
        this._mail = part(new St.BoxLayout({style_class: 'tracker-mail', visible: false, y_align: Clutter.ActorAlign.CENTER}), 'messages');
        this._mail.add_child(this._glyph('mail'));
        this._mailCount = new St.Label({style_class: 'tracker-attention', y_align: Clutter.ActorAlign.CENTER});
        this._mail.add_child(this._mailCount);
        // Tickets ready to start.
        this._ticketPart = part(new St.BoxLayout({style_class: 'tracker-mail', visible: false, y_align: Clutter.ActorAlign.CENTER}), 'tickets');
        this._ticketPart.add_child(this._glyph('ticket', null, 'help-bright'));
        this._ticketCount = new St.Label({style_class: 'tracker-help-bright', y_align: Clutter.ActorAlign.CENTER});
        this._ticketPart.add_child(this._ticketCount);
        this._tooltip(this._ticketPart, () => {
            const count = countedTickets(this._snapshot?.tickets, this._setting('ticketBar')).length;
            return `${count} ticket${count === 1 ? '' : 's'} ${this._setting('ticketBar') === 'due' ? 'whose waits have passed' : 'ready to start'}`;
        });
        // Each part is a box around its labels: the labels keep the widths they have needed, and the part's padding
        // must stay out of those.
        this._queuePart = part(new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER}), 'queues');
        this._queuePart.add_child(label('queues', 'tracker-muted', 'Q …'));
        // The button's own highlight gives way to its parts'.
        this._button.add_style_class_name('agent-bar-button');
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
        this._clusterButton = new PanelMenu.Button(0.0, 'Cluster status', true);
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
        // A button without a menu still gets a placeholder one, which the panel would switch to when the pointer crosses
        // the indicator with the dropdown open, closing it.
        Main.panel.menuManager.removeMenu(this._clusterButton.menu);
        // The cluster indicator opens the dropdown on its Cluster tab; while the dropdown is open, the stage's handler
        // below switches to it.
        this._clusterButton.connect('button-press-event', () => {
            if (!this._button.menu.isOpen) {
                this._openOn = 'cluster';
                this._button.menu.open();
            }
            return Clutter.EVENT_STOP;
        });
        // While the dropdown is open, a press on another top-bar part switches to that part's tab instead of closing it;
        // a press on the open tab's own part, or anywhere else, still closes it. GNOME 42 routes every event during the
        // dropdown's grab through the menu's actor, where the panel's menu manager closes the menu on any press outside
        // it. That handler was connected first, so it is moved behind this one.
        const manager = Main.panel.menuManager, dropdown = this._button.menu.actor;
        if (typeof manager._onCapturedEvent === 'function') {
            dropdown.disconnectObject(manager);
            this._tabPress = dropdown.connect('captured-event', (_actor, event) => {
                const type = event.type();
                if (type === Clutter.EventType.BUTTON_RELEASE && this._pressTaken) {
                    this._pressTaken = false;
                    return Clutter.EVENT_STOP;
                }
                if (type !== Clutter.EventType.BUTTON_PRESS || !this._button.menu.isOpen) return Clutter.EVENT_PROPAGATE;
                const source = global.stage.get_event_actor(event);
                const hit = [...this._parts, [this._clusterButton, 'cluster']].find(([actor]) => actor.visible && source && actor.contains(source));
                if (!hit || hit[1] === this._view && !this._page) return Clutter.EVENT_PROPAGATE;
                this._pressTaken = true;
                this._showTab(hit[1]);
                return Clutter.EVENT_STOP;
            });
            dropdown.connectObject('captured-event', manager._onCapturedEvent.bind(manager), manager);
        }
        // Each dropdown hangs from its button's left edge rather than from its middle.
        for (const button of [this._button, this._nav]) button.menu.setSourceAlignment(0);
        this._holdHoverSwitch();
        this._quick = new St.BoxLayout({style_class: 'tracker-quick'});
        // Shortcuts without room on the left continue at the start of the right-hand box.
        this._quickRight = new St.BoxLayout({style_class: 'tracker-quick tracker-quick-right'});
        this._quickButtons = [];
        this._quickHidden = [];
        // Chat key -> after what snapshot time its clicked shortcut may show again (Infinity while it is brought forward).
        this._quickPending = new Map();
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
        this._holdAppMenu();
        this._loadSettings();
        this._applySettings();
        this._button.menu.box.add_style_class_name('tracker-menu');
        this._button.menu.addMenuItem(this._item('Loading conversations…'));
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            const tab = this._openOn;
            this._openOn = null;
            if (!open) {
                this._markPart();
                this._schedule = this._checklistView = this._hostView = null;
            }
            if (open) {
                // Each opening starts on a list, the last tab used unless settings say Conversations.
                this._page = null;
                this._picker = null;
                if (this._setting('openTab') === 'conversations') this._view = 'conversations';
                if (tab) this._view = tab;
                this._menuFocus = global.display.focus_window;
                this._menuSnapshot = this._snapshot;
                this._renderedPlace = null;
                this._buildMenu();
            }
        });
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._read();
            if (this._setting('scheduler')) this._readCluster();
            if (this._button.menu.isOpen && this._view === 'git' && !this._page) this._watchGit();
            // The scheduler's controls are described again every 10 s while the Queues tab shows them.
            if (this._button.menu.isOpen && this._view === 'queues' && !this._page) {
                if (Date.now() - this._controlsAt > 10000) this._loadControls();
                this._loadQueueDependencies();
            }
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
            // After `agent-bar install`: the installed code and stylesheet replace these, once this call has answered.
            Reload: () => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    reloadInstalled();
                    return GLib.SOURCE_REMOVE;
                });
            },
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
        const ours = [this._button.menu, this._nav.menu];
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
            // Set from the Cluster tab's Snooze buttons, not from Settings.
            const snoozes = saved.clusterSnoozed;
            if (snoozes && typeof snoozes === 'object' && Object.values(snoozes).every(until => until === null || Number.isFinite(until)))
                this._settings.clusterSnoozed = snoozes;
        } catch (error) {
            if (!error.matches?.(GLib.FileError, GLib.FileError.NOENT)) this._settingsError = `Settings unreadable: ${error.message}`;
        }
    }

    _applySettings() {
        for (const actor of [this._bar, this._quick, this._quickRight, this._quickMenu.box, this._button.menu.box, this._nav.menu.box]) {
            if (this._setting('palette') === 'colorblind') actor.add_style_class_name('tracker-colorblind');
            else actor.remove_style_class_name('tracker-colorblind');
        }
        this._queuePart.visible = this._labels.queues.visible = this._queuesShown(this._snapshot);
        if (this._snapshot && !this._error) this._showTicketCount(this._snapshot);
        if (this._clusterButton) this._renderClusterBar();
        this._quickSignature = null;
        if (this._snapshot && !this._error) this._renderQuick(this._snapshot.rows);
    }

    _showTicketCount(snapshot) {
        const count = countedTickets(snapshot.tickets, this._setting('ticketBar')).length;
        this._ticketPart.visible = count > 0;
        this._ticketCount.text = `${count}`;
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
                detail.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                detail.clutter_text.line_wrap = true;
                text.add_child(detail);
                item.add_child(text);
                if (Array.isArray(fallback)) {
                    // Pick any: one checkbox per option, on lines under the description.
                    const current = this._setting(key);
                    const captions = new Map(options.map(([value, caption]) => [caption, value]));
                    for (const line of chipLines(options.map(([, caption]) => caption), 54)) {
                        const boxes = new St.BoxLayout({style_class: 'tracker-checks'});
                        for (const caption of line) {
                            const value = captions.get(caption);
                            const box = new CheckBox.CheckBox(caption);
                            box.add_style_class_name('tracker-check');
                            box.checked = current.includes(value);
                            box.connect('clicked', () => {
                                this._saveSetting(key, options.map(([option]) => option)
                                    .filter(option => (option === value) !== current.includes(option)));
                                this._later(() => this._renderRows());
                            });
                            boxes.add_child(box);
                        }
                        text.add_child(boxes);
                    }
                    card.addMenuItem(item);
                    continue;
                }
                const segments = new St.BoxLayout({style_class: 'tracker-segments', y_align: Clutter.ActorAlign.CENTER});
                for (const [value, caption] of options) {
                    const current = this._setting(key);
                    const button = new St.Button({label: caption, can_focus: true, toggle_mode: true,
                        checked: value === current, style_class: 'tracker-segment'});
                    button.connect('clicked', () => {
                        this._saveSetting(key, value);
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
        // Opened from a tab, the Guide starts at the part about it.
        const cards = {};
        const from = {conversations: 'Chats', queues: 'Queues', cluster: 'Cluster', git: 'Git', messages: 'Messages', tickets: 'Tickets', quota: 'Quota'}[this._helpFrom];
        this._helpFrom = null;
        if (from) this._scrollTo(() => {
            const heading = cards[from];
            return heading ? heading.actor.get_transformed_position()[1] - this._section.actor.get_transformed_position()[1] : 0;
        });
        const card = title => {
            cards[title] = this._item(title, 'tracker-settings-section');
            this._section.addMenuItem(cards[title]);
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
        row(top, [text('✳', 'tracker-claude'), text('12%', 'tracker-quota-attention'), text('⌘', 'tracker-codex'), text('64%', 'tracker-quota-muted')],
            'What is left of each provider\'s weekly usage limit: amber under 25%, red under 10%, dimmed when the reading is over '
            + '6 h old (Claude Code refreshes its figures only when it fetches them, as /usage does). Hover for every limit; '
            + 'clicking opens Quota, with the 5-hour and model limits, the pace, when it would run out, and use by day.');
        row(top, [text('Click a part', 'tracker-help-bright')],
            'Each part lights on its own and opens the dropdown on its tab: the chat counts on Chats, Q on Queues, the envelope on Messages, '
            + 'the limits on Quota, the cluster indicator on Cluster. With the dropdown open, clicking another part switches tabs; '
            + 'clicking the open tab\'s part, or anywhere else, closes it. ? opens this guide at the part about the tab you were on.');
        row(top, [text('✳ project…', 'tracker-quick-button tracker-claude')], limit
            ? `Up to ${limit} projects with chats needing review get a shortcut, as many as fit, the longest waiting first; clicking one brings that `
                + 'chat forward and clears it. Several chats in one project share one, with a numbered bubble per chat in its provider\'s color.  They continue right of the middle when the left half is full; +2 more lists the rest. '
                + 'Settings › Top bar › Review buttons for picks the reasons; by default a chat stopped only by a usage limit gets none, and the Chats tab shows it.'
            : 'Review shortcuts are off (Settings › Top bar).');
        if (scheduler) row(top, [text('23%', 'tracker-muted'), text('64%', 'tracker-working'), text('94%', 'tracker-attention')],
            'Cluster CPU: busy cores over the cores allotted to jobs (each host\'s job slots). A host\'s other cores are '
            + 'reserved and take its load first; only load beyond them counts, up to full. '
            + 'Gray under 50%, blue from 50%, amber from 90%. Settings › Cluster adds memory and the fullest disk.'
            + (this._cluster ? '' : ' Shown once the parallel-workers collector runs.'));
        if (scheduler) row(top, [this._glyph('disk', 0.92), this._glyph('memory'), this._glyph('down', null, 'failed'),
            this._glyph('unmounted', null, 'failed'), text('+1', 'tracker-failed')],
            'A cluster warning, by kind: a drive nearly full (filled as far as it is), memory pressure, a host unreachable, '
            + 'or the shared drive unmounted. Red when critical; +1 counts the others. Clicking it opens the Cluster tab, which names the hosts.');
        if (this._setting('messages')) row(top, [this._glyph('mail', null, 'attention'), text('2', 'tracker-attention')],
            'Messages from other agents wait in 2 chats until you start a turn there, with no wake-up coming: waking off, '
            + 'a Claude chat idle over a week, or a Codex chat not open in VS Code. Clicking it opens Messages.');
        row(top, [text('▾', 'tracker-nav-arrow'), ...dots(['attention', 'working', 'waiting', 'failed', 'finished'])],
            'Every VS Code window, terminal session, Codex app and Antigravity window, with a dot for its most urgent chat: '
            + 'needs review, working, waiting, failed, finished. Below them, a new VS Code window on the main display, and '
            + 'Saved chats, which opens History.');

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
        row(chats, [text('Continue', 'tracker-filter')],
            'Above the chats when a usage limit stopped some open in VS Code. Codex ones get "Please continue where you left off." '
            + 'queued and start it on their own; each Claude one comes forward with it at the end of its input box, for you to send. '
            + 'When the cursor cannot surely be put in that box, the text is left on the clipboard to paste.');
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
            row(letters, [chip('Unread', 'attention'), chip('Read', 'muted')], 'In Messages, by pair of chats. A chat can send at most 10 '
                + 'to another between your prompts to it, and 10 an hour; agents are told to treat them as information, not instructions.');
            const reset = new St.Label({text: 'Reset limit', style_class: 'tracker-filter tracker-reset-limit', y_align: Clutter.ActorAlign.CENTER});
            row(letters, [reset], 'When a pair reaches that limit, its header says so and how many sends were held back; the sending agent is told '
                + 'to ask you. Reset limit allows another round without writing to either chat.');
            row(letters, [text(this._setting('wake') ? 'Wake: on' : 'Wake: off', 'tracker-detail')], 'With Settings › Integrations › Wake idle '
                + 'chats on, a message starts a turn in an idle Claude Code chat (up to a week after its last turn), once per message, and in a Codex '
                + 'chat open in VS Code, after any turn in progress ends, if the message is still unread then.');
        }

        const tickets = card('Tickets');
        row(tickets, [this._glyph('ticket', null, 'help-bright'), text('2', 'tracker-help-bright')], 'In the top bar: tickets that waited for something '
            + 'that has now passed (Settings › Top bar › Ticket count can count every ready one). A ticket is a task you or an agent wants done '
            + 'later, in one project; write one with New ticket, or an agent runs `agent-bar ticket add`.');
        row(tickets, [text('waits until', 'tracker-detail')], 'A ticket can wait for a usage limit to reset, the project\'s queues to finish, a time, '
            + 'or another ticket to close; each is fixed when it is written (that reset, the queues outstanding then), and it is ready once all have passed.');
        row(tickets, [new St.Icon({icon_name: 'alarm-symbolic', icon_size: 14, style_class: 'tracker-help-icon'})], 'On a chat in Chats: '
            + 'schedule a message to it, once or repeating, in a second dropdown beside this one. It is a ticket sent to that chat when its time '
            + 'comes, listed under Scheduled in Tickets; it arrives as your request, and waits for your next prompt there if Wake idle '
            + 'chats is off. The number beside the clock counts what is scheduled for that chat.');
        row(tickets, [new St.Icon({icon_name: 'view-list-symbolic', icon_size: 14, style_class: 'tracker-help-icon'})], 'On a chat in Chats: '
            + 'the task checklists (tmp/agent/checklists) of its project, in a second dropdown beside this one: the ones it edited first, then recent ones, then older '
            + 'ones with open items. Each shows its progress (dropped items left out), a suggested next item, what needs you, and who last edited '
            + 'it; Open shows it in VS Code. An amber number counts items that need you.');
        row(tickets, [text('Start', 'tracker-filter')], 'Opens a new Claude Code chat in the ticket\'s folder, in VS Code (opening a window there if '
            + 'none is), with the ticket as its prompt in the input box, unsent. The prompt asks the chat to run `agent-bar ticket take` before starting '
            + 'and `agent-bar ticket done` after, which move it to Started and Closed.');
        row(tickets, [this._copyButton(() => '', 'Copy', true)], 'Copies the same prompt, to paste into any chat, such as a Codex one. Done and Drop '
            + 'close a ticket here; Reopen undoes either.');

        const quota = card('Quota');
        const bar = new St.Widget({style_class: 'tracker-progress tracker-help-progress', y_align: Clutter.ActorAlign.CENTER});
        const used = new St.Widget({style_class: 'tracker-progress-fill tracker-progress-attention'});
        used.set_width(64);
        bar.add_child(used);
        row(quota, [bar], 'How much of a limit is used, amber once under 25% is left and red under 10%, with when it resets.');
        row(quota, [chip('Limiting now', 'failed')], 'A limit that is holding you back now, such as a model\'s own weekly limit once it is used up.');
        row(quota, [text('0.54%/h', 'tracker-detail')], 'The pace since the reading a day earlier, or this window\'s average when there is none, '
            + 'and when that pace would use the rest: before the reset, by how much, or what will be used by then.');
        row(quota, [this._drawing((cr, width, height) => paintDays(cr, width, height, [[30, 8], [12, 4], [0, 0], [20, 10]]
            .map(([total, model]) => ({used: total, parts: [['Model', model], ['Other', total - model]]}))), {width: 72, height: 24})],
            'Points of a weekly limit used each day, a scoped model\'s share (such as Fable) in violet; hover for the figures.');
        row(quota, [text(this._setting('claudeUsage') ? 'Reads: on' : 'Reads: off', 'tracker-detail')],
            'Claude Code refreshes its limits only when it fetches them, as /usage does. Settings › Integrations › Read Claude limits '
            + 'has Agent Bar read them every 10 minutes with Claude Code\'s sign-in. Codex records its own as it works.');

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
        row(queues, [text('Clear', 'tracker-filter')],
            'Beside a project with finished queues: drops them as a new turn there would; running ones stay.');
        row(queues, [text('Adjust', 'tracker-filter')],
            'On a queue, the pool or a host the scheduler can still change: what parallel-workers\' pw-control offers there, '
            + 'such as pausing, priority, worker cap, memory, host budgets and drain. Hover a name\'s ⓘ or a button for what it does, '
            + 'or why it is unavailable now. Edited settings turn blue and go together with Apply, each with the value shown, '
            + 'so one changed meanwhile is refused; irreversible actions ask first. Applied changes show within about 30 s.');

        const cluster = card('Cluster');
        row(cluster, dots(['finished', 'attention', 'failed']),
            'A host is fine, has a warning, or is unreachable. Warnings are listed first, each with its sign from the top bar; '
            + 'a clock marks a host that stopped updating. Snooze keeps one off the top bar until it clears, or for at most '
            + 'a time you type (90m, 120h, 5d, 2w; a bare number is hours); snoozed ones follow, gray.');
        row(cluster, [this._drawing((cr, width, height) => paintCores(cr, width, height, [18, 42, 63, 78, 91, 97, 55, 30]),
            {width: 120, height: 24})], 'One bar per core, as tall as the core is busy, colored like the CPU percentage: gray under '
            + '50%, blue from 50%, amber from 90%.');
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
        if (!snapshot || this._error)
            this._nav.menu.addMenuItem(this._item(this._error || 'Waiting for the agent-bar service', 'tracker-warning'));
        for (const {window, state, active} of snapshot && !this._error ? windowSummaries(snapshot, this._setting('windowOrder')) : []) {
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
        if (this._nav.menu.numMenuItems) this._nav.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const fresh = new PopupMenu.PopupImageMenuItem('New VS Code window', 'window-new-symbolic');
        fresh.connect('activate', () => this._openVSCode());
        this._nav.menu.addMenuItem(fresh);
        const saved = new PopupMenu.PopupImageMenuItem('Saved chats', 'document-open-recent-symbolic');
        saved.connect('activate', () => this._later(() => {
            this._openOn = 'history';
            this._button.menu.open();
        }));
        this._nav.menu.addMenuItem(saved);
    }

    // A fresh VS Code window, maximized on the main display once it has drawn.
    _openVSCode() {
        this._stopWatchingNew();
        const stop = () => this._stopWatchingNew();
        this._newWindow = {
            created: global.display.connect('window-created', (_display, win) => {
                if (!/^code$/i.test(win.get_wm_class() || '')) return;
                stop();
                const place = () => {
                    const area = win.get_work_area_for_monitor(Main.layoutManager.primaryIndex);
                    win.move_resize_frame(false, area.x, area.y, area.width, area.height);
                    win.maximize(Meta.MaximizeFlags.BOTH);
                    Main.activateWindow(win);
                };
                const actor = win.get_compositor_private();
                if (!actor) return place();
                const drawn = actor.connect('first-frame', () => {
                    actor.disconnect(drawn);
                    place();
                });
            }),
            timeout: GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
                this._newWindow.timeout = 0;
                stop();
                return GLib.SOURCE_REMOVE;
            }),
        };
        try { Gio.Subprocess.new(['code', '--new-window'], Gio.SubprocessFlags.NONE); }
        catch (error) {
            stop();
            Main.notifyError('Agent Bar', `Could not start VS Code: ${error.message}`);
        }
    }

    _stopWatchingNew() {
        if (!this._newWindow) return;
        global.display.disconnect(this._newWindow.created);
        if (this._newWindow.timeout) GLib.source_remove(this._newWindow.timeout);
        this._newWindow = null;
    }

    // The focused app's name, left of the tracker, keeps the widest it has been (to APP_MENU_MAX), and a spacer
    // keeps that room while no app has focus, so the tracker always starts in the same place.
    _holdAppMenu() {
        const menu = Main.panel.statusArea.appMenu?.container;
        if (!menu) return;
        this._appSpacer = new St.Widget({visible: false});
        menu.get_parent().insert_child_above(this._appSpacer, menu);
        const hold = () => {
            if (menu.visible) holdWidth(menu, APP_MENU_MAX);
            const spacer = !menu.visible && !!menu._held;
            if (this._appSpacer.visible !== spacer) this._appSpacer.visible = spacer;
            if (spacer && this._appSpacer._held !== menu._held) {
                this._appSpacer._held = menu._held;
                restyle(this._appSpacer);
            }
        };
        this._appMenu = {menu, signals: ['notify::visible', 'notify::allocation'].map(name => menu.connect(name, hold))};
        hold();
    }

    _releaseAppMenu() {
        if (!this._appMenu) return;
        for (const id of this._appMenu.signals) this._appMenu.menu.disconnect(id);
        this._appMenu.menu._held = 0;
        restyle(this._appMenu.menu);
        this._appSpacer.destroy();
        this._appMenu = this._appSpacer = null;
    }

    // A rebuild run from inside a click would destroy the widget still handling that click.
    // Scrolls the dropdown's list to `value` once it has been laid out with its new rows.
    _scrollTo(value) {
        const scroll = this._scroll;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 30, () => {
            if (this._enabled && this._scroll === scroll) scroll.vscroll.adjustment.value = typeof value === 'function' ? value() : value;
            return GLib.SOURCE_REMOVE;
        });
    }

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
            if (this._clusterShown()) {
                if (this._hostView && !this._cluster?.hosts.some(host => host.id === this._hostView.id))
                    this._toggleHost(this._hostView.id);
                this._updateCluster();
                this._loadHostProjects();
            }
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
        if (this._clusterShown()) this._updateCluster();
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
        for (const label of [...this._clusterParts, this._clusterMore]) if (label.visible) holdWidth(label);
        this._clusterButton.accessible_name = ['Cluster', ...parts.map(part => `${part.caption || 'cpu'} ${pct(part.value)}`),
            ...warnings.map(warning => `${warning.host} ${warning.text}`), ...!cluster && this._clusterError ? [this._clusterError] : []].join(', ');
    }

    // Whether the dropdown shows the Cluster tab now, so the cluster's figures update in place.
    _clusterShown() {
        return this._button.menu.isOpen && this._view === 'cluster' && !this._page;
    }

    // Switches the open dropdown to `tab`.
    _showTab(tab) {
        this._page = null;
        this._picker = this._schedule = this._checklistView = this._hostView = null;
        this._view = tab;
        this._buildMenu();
    }

    // The Cluster tab: warnings, failed jobs, each measure or host, and the shared drive. Its totals sit in the dropdown's
    // header, and the figures update in place as the collector writes (_updateCluster).
    _renderCluster() {
        this._clusterCards = null;
        const cluster = this._cluster;
        const header = this._clusterHeader;
        if (!cluster || !header) {
            this._section.addMenuItem(this._item(this._clusterError || 'No cluster snapshot yet', 'tracker-warning'));
            return;
        }
        const {stats, captions, subtitle} = header;
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
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tracker-cluster-tab'});
        item._ornamentLabel?.hide();
        item.add_child(columns);
        this._section.addMenuItem(item);
        const footer = this._footer;
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

    // Copies text(), confirming briefly on the button; `compact` shows the icon alone, with `name` as its tooltip.
    _copyButton(text, name = 'Copy a note about these failures for the project\'s agent', compact = false) {
        const label = new St.Label({text: compact ? '' : 'Copy', y_align: Clutter.ActorAlign.CENTER, visible: !compact});
        const content = new St.BoxLayout({style_class: 'tracker-copy-content'});
        const icon = new St.Icon({icon_name: 'edit-copy-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER});
        content.add_child(icon);
        content.add_child(label);
        const button = new St.Button({child: content, can_focus: true, style_class: compact ? 'tracker-copy tracker-copy-compact' : 'tracker-copy',
            accessible_name: name, y_align: Clutter.ActorAlign.CENTER});
        if (compact) this._tooltip(button, name);
        let timer = 0;
        button.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text());
            if (compact) icon.icon_name = 'object-select-symbolic';
            else label.text = 'Copied';
            if (timer) GLib.source_remove(timer);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                timer = 0;
                if (compact) icon.icon_name = 'edit-copy-symbolic';
                else label.text = 'Copy';
                return GLib.SOURCE_REMOVE;
            });
        });
        button.connect('destroy', () => { if (timer) GLib.source_remove(timer); });
        return button;
    }

    _hostButton(id) {
        const button = new St.Button({label: id, can_focus: true, x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'tracker-cluster-host tracker-host-button',
            accessible_name: `Show projects using job slots on ${id}`});
        this._tooltip(button, button.accessible_name);
        button.connect('clicked', () => this._toggleHost(id));
        return button;
    }

    _toggleHost(id) {
        this._hostView = this._hostView?.id === id ? null : {id};
        this._renderSide();
    }

    async _loadHostProjects() {
        const host = this._hostView;
        if (!host || host.loading || Date.now() < (host.nextRead || 0)) return;
        host.loading = true;
        try {
            host.data = await this._run(['host-projects', host.id]);
            host.error = null;
        } catch (error) {
            host.data = null;
            host.error = error.message;
        } finally {
            host.loading = false;
            host.nextRead = Date.now() + 15000;
        }
        if (this._enabled && this._hostView === host && this._clusterShown()) this._renderHostProjects(host);
    }

    _renderHostProjects(host) {
        const box = host.body;
        box.destroy_all_children();
        const label = (text, style) => {
            const actor = new St.Label({text, style_class: style});
            actor.clutter_text.line_wrap = true;
            actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            box.add_child(actor);
        };
        if (!host.data) {
            label(host.error || 'Reading job allocations…', host.error ? 'tracker-warning' : 'tracker-detail');
            return;
        }
        const {projects, cpu_slots, memory_bytes, incomplete_fixed_slots} = host.data;
        if (incomplete_fixed_slots) label('Some fixed-worker slot counts are unavailable.', 'tracker-warning');
        if (!projects.length) {
            if (!incomplete_fixed_slots) label('No job slots in use on this node.', 'tracker-detail');
            return;
        }
        const gib = value => `${(value / 1024 ** 3).toFixed(1)} GiB`;
        const measure = (name, value, total, format) => {
            const ratio = value !== null && total > 0 ? value / total : null;
            const amount = value === null ? 'unavailable' : format(value);
            const share = ratio === null ? '' : ` / ${format(total)} · ${Math.round(100 * ratio)}%`;
            label(`${name}   ${amount}${share}`, 'tracker-detail');
            if (ratio !== null)
                box.add_child(this._drawing((cr, w, h) => paintMemory(cr, w, h, Math.min(1, ratio), 0),
                    {style_class: 'tracker-cluster-line', x_expand: true}));
        };
        for (const project of projects) {
            const counts = [project.jobs && `${project.jobs} ${project.jobs === 1 ? 'job' : 'jobs'}`,
                project.fixed_slots && `${project.fixed_slots} fixed ${project.fixed_slots === 1 ? 'slot' : 'slots'}`];
            label([project.project, ...counts.filter(Boolean)].join(' · '), 'tracker-host-project');
            measure('CPU slots reserved', project.cpu_slots, cpu_slots, String);
            measure('Job memory', project.memory_mib === null ? null : project.memory_mib * 1024 ** 2, memory_bytes, gib);
        }
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
            cards.set(host.id, this._clusterCard(row, host.id));
        });
        return cards;
    }

    _clusterCard(row, id) {
        const card = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-cluster-card'});
        const line = new St.BoxLayout();
        const dot = new St.Label({text: '●', y_align: Clutter.ActorAlign.CENTER});
        const name = this._hostButton(id);
        name.x_expand = true;
        const cpu = new St.Label({style_class: 'tracker-cluster-cpu', y_align: Clutter.ActorAlign.CENTER});
        for (const actor of [dot, name, cpu]) line.add_child(actor);
        card.add_child(line);
        const view = {dots: [dot], cpu, perCore: [], memoryParts: [0, 0]};
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
                const hostName = view === sharedDisk ? new St.Label({text: name, style_class: 'tracker-cluster-host'})
                    : this._hostButton(name);
                hostName.add_style_class_name('tracker-cluster-measure-host');
                const cells = [dot, hostName, area, view[value], view[note]];
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
            // Redrawn whole: a host, a failed project or its window came or went.
            if (this._clusterShown()) this._renderRows();
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
            // An unreachable host's last readings are old, or gone after a collector restart: none are shown.
            const off = !host.ok;
            card.perCore = off ? [] : host.cpu?.per_core || [];
            card.cores.queue_repaint();
            const {memory, disk} = host;
            card.memoryParts = memory && !off ? [memory.used_bytes / memory.total_bytes, (memory.cache_bytes || 0) / memory.total_bytes] : [0, 0];
            card.memory.queue_repaint();
            const memoryText = memory ? `${bytes(memory.used_bytes)} / ${bytes(memory.total_bytes)}`
                + (memory.pressure && memory.pressure !== 'normal' ? ` · pressure ${memory.pressure === 'warn' ? 'elevated' : memory.pressure}` : '') : '';
            const load = host.load ? `load ${host.load[0].toFixed(1)}` : '';
            const diskText = disk ? `${bytes(disk.root_free_bytes)} free of ${bytes(disk.root_total_bytes)}` : '';
            if (card.status) {
                card.cpu.text = off ? '—' : pct(host.cpu?.busy_pct);
                setTone(card.cpu, busy === null ? 'muted' : loadStyle(busy));
                // The status line names any memory pressure that is a warning.
                card.detail.text = off ? 'unreachable' : [memory && `${bytes(memory.used_bytes)} / ${bytes(memory.total_bytes)}`, load].filter(Boolean).join(' · ');
                // Problems replace the routine disk line so they are not truncated away.
                card.status.text = problems.length ? problems.map(problem => problem.text).join(' · ') : diskText && `disk ${diskText}`;
                card.status.style_class = problems.length
                    ? `tracker-detail tracker-${problems.some(problem => problem.critical) ? 'failed' : 'attention'}` : 'tracker-detail';
                continue;
            }
            const memoryUsed = memory && !off ? 100 * memory.used_bytes / memory.total_bytes : null;
            const diskUsed = disk && !off ? usedPct(disk.root_free_bytes, disk.root_total_bytes) : null;
            card.diskParts = diskUsed !== null ? [diskUsed / 100, 0] : [0, 0];
            card.disk.queue_repaint();
            for (const [label, value] of [[card.cpu, busy], [card.memoryValue, memoryUsed], [card.diskValue, diskUsed]]) {
                label.text = off ? '—' : pct(value);
                setTone(label, value === null ? 'muted' : loadStyle(value));
            }
            card.load.text = off ? 'unreachable' : [Number.isInteger(host.slots) && `${host.slots} slots`, load].filter(Boolean).join(' · ');
            card.memoryNote.text = off ? 'unreachable' : memoryText;
            card.diskNote.text = off ? 'unreachable' : diskText;
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
        this._releaseFocus(this._button.menu, view.problemList);
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
            const hostName = view.cards.has(issue.host) ? this._hostButton(issue.host)
                : new St.Label({text: issue.host, style_class: 'tracker-cluster-host'});
            hostName.add_style_class_name('tracker-cluster-measure-host');
            line.add_child(hostName);
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
        for (const [key, after] of this._quickPending) if ((this._snapshot?.updated ?? 0) > after) this._quickPending.delete(key);
        const ready = readyConversations(rows, this._setting('quickReasons'))
            .filter(row => !this._quickPending.has(row.key));
        const groups = quickGroups(ready);
        const limit = this._setting('quickLimit'), chars = this._setting('quickChars');
        const shown = groups.slice(0, limit);
        const signature = JSON.stringify(shown.map(group => group.map(row => [row.key, row.window, row.provider])));
        if (signature !== this._quickSignature) this._buildQuick(signature, shown, chars);
        this._fitQuick(limit ? groups : []);
    }

    // One shortcut per project in `shown`, placed by _fitQuick: a chat alone is a button in its provider's color; several
    // share a neutral button with the project's name and a numbered bubble per chat, in its provider's color, the
    // longest waiting first. Each keeps its name's short (`chars`) and full forms, for _fitQuick to show as room allows.
    _buildQuick(signature, shown, chars) {
        this._quickSignature = signature;
        for (const box of [this._quick, this._quickRight]) this._releaseFocus(null, box);
        for (const button of this._quickButtons) button.destroy();
        this._quickButtons = shown.map(group => {
            const [first] = group;
            const short = first.project.length > chars ? `${first.project.slice(0, chars - 1)}…` : first.project;
            const open = row => {
                // The snapshot after it drops this chat; until then its bubble goes and the rest renumber.
                this._openShortcut(row);
                this._later(() => this._renderQuick(this._snapshot?.rows || []));
            };
            let item, name;
            if (group.length === 1) {
                const symbol = PROVIDERS[first.provider]?.[0] || '•';
                item = new St.Button({label: `${symbol} ${short}`, style_class: `tracker-quick-button tracker-${first.provider}`, can_focus: true,
                    y_align: Clutter.ActorAlign.CENTER, accessible_name: `Show ${first.project}: ${first.title}`});
                name = item;
                item._names = [`${symbol} ${short}`, `${symbol} ${first.project}`];
                item.connect('clicked', () => {
                    item.hide();
                    open(first);
                });
            } else {
                item = new St.BoxLayout({style_class: 'tracker-quick-button tracker-quick-group', y_align: Clutter.ActorAlign.CENTER,
                    reactive: true, track_hover: true});
                name = new St.Button({label: short, style_class: 'tracker-quick-group-name', can_focus: true, x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER, accessible_name: `Show ${first.project}'s longest-waiting chat: ${first.title}`});
                name.connect('clicked', () => open(first));
                item.add_child(name);
                group.forEach((row, index) => {
                    const bubble = new St.Button({label: `${index + 1}`, can_focus: true, y_align: Clutter.ActorAlign.CENTER,
                        style_class: `tracker-quick-bubble tracker-quick-bubble-${row.provider}`,
                        accessible_name: `Show ${PROVIDERS[row.provider]?.[1] || row.provider} chat ${row.title}`});
                    this._tooltip(bubble, `${PROVIDERS[row.provider]?.[0] || '•'} ${row.title}`);
                    bubble.connect('clicked', () => open(row));
                    item.add_child(bubble);
                });
                item._names = [short, first.project];
            }
            item._name = name;
            // _fitQuick puts it in its place.
            this._quick.add_child(item);
            return item;
        });
    }

    // Shortcuts as room allows, the longest waiting first: in the top bar's left half after its other buttons, then
    // at the start of the right half. +N more, after the last one shown, lists the rest of `ready`.
    _fitQuick(groups) {
        const panel = Main.panel, total = groups.length;
        // Each side's box gets at most half of what the centre box leaves.
        const side = Math.floor((panel.width - panel._centerBox.get_preferred_width(-1)[1]) / 2) - 2;
        const width = actor => actor.get_preferred_width(-1)[1];
        const room = (box, own) => side - own.get_theme_node().get_length('margin-left') - own.get_theme_node().get_length('margin-right')
            - box.get_children().filter(child => child !== own && child.visible).reduce((sum, child) => sum + width(child), 0);
        const leftRoom = room(panel._leftBox, this._quick), rightRoom = room(panel._rightBox, this._quickRight);
        const spacing = this._quick.get_theme_node().get_length('spacing');
        const buttons = this._quickButtons;
        buttons.forEach(button => {
            button.show();
            button.set_width(-1);
            button._name.label = button._names[1];
        });
        // As wide as the full name would make it, and as wide as the short one does.
        const full = buttons.map(width);
        buttons.forEach(button => { button._name.label = button._names[0]; });
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
        let [left, usedLeft] = fill(leftRoom, 0, false);
        // The next shortcut, its name cut short, takes what the left half has left, so the row runs on unbroken.
        let squeezed = leftRoom - usedLeft - spacing;
        // Enough of it to show a few letters: its narrowest (an ellipsis and any bubbles) and room for them.
        if (left < buttons.length && squeezed >= Math.max(60, buttons[left].get_preferred_width(-1)[0] + 30)) left++;
        else squeezed = 0;
        let [right, usedRight] = fill(rightRoom, left, true);
        let moreRight = true;
        if (total > left + right && (!right || usedRight + more > rightRoom)) {
            // +N more ends the left side instead, next to the shortcuts it continues.
            [left, usedLeft] = fill(leftRoom, 0, true);
            usedLeft += more;
            right = squeezed = 0;
            moreRight = false;
        }
        const grow = (start, end, extra) => shareWidth(widths.slice(start, end), full.slice(start, end), extra).forEach((value, i) => {
            if (value <= widths[start + i]) return;
            buttons[start + i]._name.label = buttons[start + i]._names[1];
            buttons[start + i].set_width(value);
        });
        if (squeezed) buttons[left - 1].set_width(squeezed);
        else {
            // Room the left half's shortcuts leave goes to more of their names, never to padding, so a row that
            // continues in the right half meets the middle without a gap unless every name is already whole.
            grow(0, left, leftRoom - usedLeft);
        }
        // The right half's too, with what it has left after them and +N more.
        if (right) grow(left, left + right, rightRoom - usedRight - (moreRight && total > left + right ? more : 0));
        // Taking all the room it has, the right half's box starts at the middle, against the left half's shortcuts.
        this._quickRight.visible = right > 0;
        this._quickRight.set_width(right > 0 ? Math.max(0, rightRoom) : -1);
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
        this._quickHidden = groups.slice(left + right).flat();
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
            item.connect('activate', () => this._openShortcut(row));
            this._quickMenu.addMenuItem(item);
        }
        this._quickMenu.open();
    }

    // Brings a shortcut's chat forward. A snapshot from before its acknowledgment still lists it, so its shortcut
    // stays away until a later one, or returns on the next read if bringing it forward failed.
    _openShortcut(row) {
        this._quickPending.set(row.key, Infinity);
        this._quickSignature = null;
        this._activate(row, this._snapshot, 'focus').then(result => {
            if (result?.ok) this._quickPending.set(row.key, Date.now() / 1000);
            else this._quickPending.delete(row.key);
        });
    }

    _read() {
        if (this._reading) return;
        this._reading = true;
        Gio.File.new_for_path(`${ROOT}/snapshot.json`).load_contents_async(this._cancel, (file, result) => {
            this._reading = false;
            if (!this._enabled) return;
            try {
                const [ok, bytes, etag] = file.load_contents_finish(result);
                if (!ok) throw new Error('Could not read the agent-bar snapshot');
                // The service rewrites the snapshot only when it changes, and every 10 s regardless; the same file
                // again needs no parsing or redrawing, only the check that the service still runs.
                if (etag && etag === this._snapshotEtag && this._snapshot && !this._error) {
                    if (Date.now() / 1000 - this._snapshot.updated > 20) throw new Error('The agent-bar service is stale');
                    return;
                }
                const snapshot = JSON.parse(ByteArray.toString(bytes));
                if (snapshot.schema !== 1) throw new Error('Unsupported agent-bar snapshot');
                this._snapshotEtag = etag;
                this._snapshot = snapshot;
                // An open Git tab shows each new reading, which the service takes every 20 s while it is open.
                if (this._button.menu.isOpen && this._view === 'git' && !this._page
                    && snapshot.git?.updated !== this._menuSnapshot?.git?.updated) {
                    this._menuSnapshot = snapshot;
                    this._later(() => this._renderRows());
                }
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
                    restyle(this._labels[provider], count.review ? 'color: #f1f3f5; font-weight: bold;' : 'color: #9ca3ad;');
                }
                this._labels.working.text = `● ${c.working}`;
                this._labels.waiting.text = `◌ ${c.waiting}`;
                this._labels.waiting.visible = c.waiting > 0;
                const stranded = snapshot.messages?.stranded || [];
                this._mail.visible = stranded.length > 0;
                this._mailCount.text = `${stranded.length}`;
                this._showTicketCount(snapshot);
                this._queuePart.visible = this._labels.queues.visible = this._queuesShown(snapshot);
                this._labels.queues.text = `Q ${c.done} / ${c.queues}${Date.now() / 1000 - snapshot.queue_updated > 120 ? ' ?' : ''}`;
                this._renderQuotaBar(snapshot.usage);
                restyle(this._labels.queues, c.done ? 'color: #f1f3f5; font-weight: bold;' : 'color: #9ca3ad;');
                for (const label of [...Object.values(this._labels), this._mailCount, this._ticketCount]) if (label.visible) holdWidth(label);
                this._renderQuick(snapshot.rows);
                this._button.accessible_name = `${Object.entries(PROVIDERS).filter(([key]) => c[key])
                    .map(([key, [, name]]) => `${name} ${c[key]}`).join(', ') || 'No chats'}, ${c.working} working, ${c.waiting} waiting, ${c.review} need review, ${c.done} of ${c.queues} queues finished since the last turn`
                    + (stranded.length ? `, agent mail waits for your turn in ${stranded.length} chat${stranded.length === 1 ? '' : 's'}` : '');
                this._error = null;
            } catch (error) {
                this._error = error.message;
                this._labels.working.text = '● ?';
                this._labels.waiting.visible = false;
                this._mail.visible = this._ticketPart.visible = false;
                for (const provider of PINNED) this._labels[provider].text = '? / ?';
                this._labels.queues.text = 'Q ?';
                this._quota.visible = false;
                this._renderQuick([]);
            }
        });
    }

    // One part per provider with a weekly limit: its symbol and the percent left, dimmed when the reading is old.
    _renderQuotaBar(usage) {
        const shown = this._setting('quotaBar') ? Object.keys(PROVIDERS).map(provider => [provider, quotaLeft(usage, provider)])
            .filter(([, quota]) => quota) : [];
        this._quota.visible = shown.length > 0;
        const signature = JSON.stringify(shown.map(([provider, quota]) => [provider, Math.floor(quota.left), quota.stale]));
        if (signature === this._quotaSignature) return;
        this._quotaSignature = signature;
        this._quota.destroy_all_children();
        for (const [provider, quota] of shown) {
            const part = new St.BoxLayout({style_class: 'tracker-quota-part', y_align: Clutter.ActorAlign.CENTER});
            for (const label of [new St.Label({text: PROVIDERS[provider][0], style_class: `tracker-${provider}`, y_align: Clutter.ActorAlign.CENTER}),
                new St.Label({text: `${Math.floor(quota.left)}%`, y_align: Clutter.ActorAlign.CENTER,
                    style_class: quota.stale ? 'tracker-quota-stale' : `tracker-quota-${quotaStyle(quota.left)}`})]) {
                // Never shortened to an ellipsis when the top bar is crowded.
                label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                part.add_child(label);
            }
            this._quota.add_child(part);
        }
    }

    /** @param {string | null} style */
    _item(text, style = null) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        if (style) item.label.add_style_class_name(style);
        return item;
    }

    // While the dropdown is open, the top-bar part for the tab it shows stays highlighted.
    _markPart() {
        const open = this._button.menu.isOpen && !this._page;
        for (const [actor, tab] of this._parts) {
            if (open && tab === this._view && actor.visible) actor.add_style_class_name('agent-bar-part-open');
            else actor.remove_style_class_name('agent-bar-part-open');
        }
        // The cluster indicator is a top-bar button of its own, lit as the theme lights an open one.
        if (open && this._view === 'cluster') this._clusterButton.add_style_pseudo_class('checked');
        else this._clusterButton.remove_style_pseudo_class('checked');
    }

    _buildMenu() {
        this._markPart();
        // A rebuild of the same tab, as after Clear, keeps the list's place (see _renderRows).
        this._keptScroll = this._scroll?.vscroll.adjustment.value ?? 0;
        this._releaseFocus(this._button.menu);
        // removeAll() only drops menu items; the list body and the side dropdown are plain actors.
        this._body?.destroy();
        this._sideHolder?.destroy();
        this._sideHolder = this._side = this._sidePanel = null;
        this._pickerList = null;
        this._pickerButtons = {};
        this._button.menu.removeAll();
        const snapshot = this._menuSnapshot;
        // null for the lists, or 'settings' or 'help'.
        const page = this._page;
        this._historyNote = null;
        if (!page && this._needsInventory()) this._loadInventory();
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header._ornamentLabel?.hide();
        header.add_style_class_name('tracker-heading');
        const heading = new St.BoxLayout({vertical: true, x_expand: true});
        // The Cluster tab heads the dropdown with the cluster's own totals, which _updateCluster fills in.
        const clusterView = !page && this._view === 'cluster';
        this._clusterHeader = null;
        heading.add_child(new St.Label({text: {settings: 'Settings', help: 'Guide'}[page] || (clusterView ? 'Cluster' : 'Agents'),
            style_class: 'tracker-heading-title'}));
        const subtitle = new St.Label({style_class: 'tracker-detail', text: page === 'settings' ? `Saved to ${CONFIG.replace(GLib.get_home_dir(), '~')}`
            : page === 'help' ? 'What the top bar and this menu show'
                : snapshot ? `${new Set(snapshot.rows.map(row => row.key)).size} chats open · ${snapshot.windows.length} windows` : 'Waiting for the agent-bar service'});
        heading.add_child(subtitle);
        header.add_child(heading);
        if (clusterView) {
            const stats = {}, captions = {};
            for (const [key, caption] of [['cpu', 'CPU'], ['cores', 'busy cores'], ['memory', 'memory']]) {
                const stat = new St.BoxLayout({vertical: true, style_class: 'tracker-summary'});
                stats[key] = new St.Label({style_class: 'tracker-summary-value'});
                captions[key] = new St.Label({text: caption, style_class: 'tracker-detail'});
                stat.add_child(stats[key]);
                stat.add_child(captions[key]);
                header.add_child(stat);
            }
            this._clusterHeader = {stats, captions, subtitle};
        } else if (snapshot && !page) {
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
            // Plain marks in the button's own color, rather than the theme's busier help and settings icons.
            const mark = () => new St.Label({text: '?', style_class: 'tracker-help-mark', x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER});
            const gear = () => {
                const area = new St.DrawingArea({width: 16, height: 16, y_align: Clutter.ActorAlign.CENTER});
                area.connect('repaint', () => {
                    const cr = area.get_context();
                    const color = area.get_theme_node().get_foreground_color();
                    paintGlyph(cr, 16, 'gear', null, [color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255]);
                    cr.$dispose();
                });
                area.connect('style-changed', () => area.queue_repaint());
                return area;
            };
            // An open page's own button becomes ◀, so going back is where the page was opened.
            for (const [child, target, name] of [[mark, 'help', 'What the symbols and colors mean'], [gear, 'settings', 'Settings']]) {
                const back = page === target;
                const button = new St.Button({can_focus: true, style_class: back ? 'tracker-gear tracker-back' : 'tracker-gear',
                    accessible_name: back ? 'Back to conversations' : name, ...back ? {label: '◀'} : {child: child()}});
                button.connect('clicked', () => {
                    if (!back && target === 'help') this._helpFrom = this._view;
                    this._page = back ? null : target;
                    this._later(() => this._buildMenu());
                });
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
        this._search = new St.Entry({hint_text: this._isChatList() ? 'Search messages and titles · repo:name to narrow' : this._view === 'info' ? 'Search hooks and skills…' : 'Search conversations, projects, or queues…',
            can_focus: true, x_expand: true, style_class: 'tracker-search'});
        if (this._isChatList()) this._search.set_text(this._chatQuery);
        const tabs = new St.BoxLayout({style_class: 'tracker-filters tracker-tabs'});
        // Integrations turned off in settings take their tabs with them.
        const shown = {queues: this._setting('scheduler'), cluster: this._setting('scheduler') && !!this._cluster,
            git: this._setting('git'), messages: this._setting('messages')};
        if (shown[this._view] === false) this._view = 'conversations';
        for (const [value, label] of [['conversations', 'Chats'], ['queues', 'Queues'], ['cluster', 'Cluster'], ['git', 'Git'], ['messages', 'Messages'], ['tickets', 'Tickets'], ['history', 'History'], ['quota', 'Quota'], ['info', 'Info']]
            .filter(([value]) => shown[value] !== false)) {
            const button = new St.Button({label, toggle_mode: true, checked: this._view === value,
                can_focus: true, style_class: 'tracker-filter'});
            button.connect('clicked', () => {
                // The side dropdown belongs to the tab it was opened from.
                this._view = value;
                this._picker = this._schedule = this._checklistView = this._hostView = null;
                this._later(() => this._buildMenu());
            });
            tabs.add_child(button);
        }
        control(tabs);
        // Quota and Cluster have nothing to search, sort or filter, nor the Queues tab without parallel-workers.
        const bare = ['quota', 'cluster'].includes(this._view) || this._view === 'queues' && snapshot?.scheduler === 'missing';
        control(this._search).visible = !page && !bare;
        // Sort and filter each open a list under their button, over the rows.
        const toolbar = new St.BoxLayout({x_expand: true, style_class: 'tracker-toolbar'});
        {
            // Messages have one order, newest conversation pair first; an Agent or Project filter picks one of them.
            const pickers = this._view === 'info' ? ['project'] : this._view === 'tickets' ? [] : this._view !== 'messages' ? ['sort', 'filter']
                : ['agent', 'project'].includes(this._messageFilter) ? ['filter', 'value'] : ['filter'];
            for (const picker of pickers) {
                const [options, current] = this._pickerOptions(picker);
                const caption = {sort: 'Sort', filter: 'Filter', project: 'Project'}[picker]
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
        // One button expands every group when any is collapsed, and collapses them all otherwise; Git, Messages and
        // Info have no groups.
        this._bulk = null;
        if (!['git', 'messages', 'info', 'quota', 'cluster'].includes(this._view)) {
            this._bulk = new St.Button({label: 'Collapse all', can_focus: true, style_class: 'tracker-filter tracker-bulk-toggle',
                y_align: Clutter.ActorAlign.CENTER});
            this._bulk.connect('clicked', () => {
                if (this._projectKeys.some(key => this._collapsedProjects.has(key))) this._collapsedProjects.clear();
                else for (const key of this._projectKeys) this._collapsedProjects.add(key);
                this._renderRows();
            });
            toolbar.add_child(this._bulk);
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
        // The side dropdown shares the menu's input grab. Keep its heading outside the scrolled body
        // so the close button stays reachable even when the side panel extends past the menu's edge.
        this._sideHolder = new St.Widget({layout_manager: new Clutter.FixedLayout(), width: 0, height: 0});
        this._side = new St.BoxLayout({vertical: true, style_class: 'tracker-side'});
        this._sidePanel = new St.BoxLayout({vertical: true, style_class: 'tracker-side-scroll', visible: false});
        this._sideHeading = new St.BoxLayout({style_class: 'tracker-side-heading tracker-side-title'});
        this._sidePanel.add_child(this._sideHeading);
        const scroll = new St.ScrollView({overlay_scrollbars: true, hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC});
        scroll.set_style(`max-height: ${Main.layoutManager.primaryMonitor.height - 160}px;`);
        scroll.add_actor(this._side);
        this._sidePanel.add_child(scroll);
        this._sideHolder.add_child(this._sidePanel);
        this._button.menu.box.insert_child_at_index(this._sideHolder, 0);
        this._renderSide();
        this._search.clutter_text.connect('text-changed', () => {
            if (this._isChatList()) {
                const needed = this._needsInventory();
                this._chatQuery = String(this._search.text);
                if (!needed && this._needsInventory()) this._loadInventory();
            }
            this._togglePicker(null);
            this._renderRows();
        });
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
    /** @param {((body: any) => void) | null} [fill] */
    _projectSection(key, title, context, summary, highlight = false, controls = null, fill = null, below = null, search = '') {
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
        highlightHistoryText(label, search);
        line.add_child(label);
        const location = new St.Label({text: context, style_class: 'tracker-project-context'});
        highlightHistoryText(location, search);
        line.add_child(location);
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
            if (this._bulk) this._bulk.label = this._projectKeys.some(other => this._collapsedProjects.has(other)) ? 'Expand all' : 'Collapse all';
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
        // Redrawing the same list, as after a setting or an action, keeps where it was scrolled to; a new tab, page
        // or opening starts at the top (or, for the Guide, at the part about the tab it was opened from).
        const place = `${this._page}:${this._view}`;
        const kept = place === this._renderedPlace ? this._keptScroll ?? this._scroll.vscroll.adjustment.value : 0;
        this._keptScroll = null;
        if (kept > 0) this._scrollTo(kept);
        this._renderedPlace = place;
        this._releaseFocus(this._button.menu, this._section.actor);
        this._gateRows = null;
        this._gateWarning = null;
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
            messages: 'A chat sees its unread count at its next turn start · at most 10 to one chat between your prompts',
            tickets: 'Agents write them with `agent-bar ticket add` · ready once what each waits for has passed',
            info: 'Read from local files when this tab opens, and again after 30 s · nothing polls in the background',
            cluster: '',
            cluster: 'From the parallel-workers collector',
            quota: `As Claude Code and Codex record them here, read each minute${this._setting('claudeUsage') ? ', and from Claude every 10 min' : ''} · Copilot and Antigravity record none here`,
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
        if (this._view === 'tickets') {
            this._renderTickets(snapshot, query);
            return;
        }
        if (this._view === 'info') {
            this._renderInfo(snapshot, query);
            return;
        }
        if (this._view === 'quota') {
            this._renderQuota(snapshot);
            return;
        }
        if (this._view === 'cluster') {
            this._renderCluster();
            return;
        }
        const limited = limitedConversations(snapshot.rows);
        if (limited.length) this._section.addMenuItem(this._limitBanner(limited));
        const lookup = this._chatSearch(query);
        const rows = snapshot.rows.filter(row => matchesFilter(row, this._filter) && matchesChatSearch(row, lookup));
        const order = this._setting('projectOrder');
        const totals = new Map(order === 'total' ? this._inventory?.conversations.map(row => [row.key, row.active]) : []);
        for (const project of groupProjects(rows, order, totals)) {
            const firstWindow = snapshot.windows.find(w => w.id === project.rows[0].window);
            const total = new Set(project.rows.map(row => row.key)).size;
            const queues = project.rows[0].queue_counts;
            const summary = (project.review ? `${project.review} review / ${total}` : `${total} open`)
                + (queues.total ? ` · Q ${queues.done}/${queues.total}` : '');
            /** @param {any} body */
            const fill = body => {
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
                    for (const row of conversations) this._conversationItem(row, snapshot, body, lookup);
                }
            };
            this._projectSection(project.key, project.name,
                project.windows.size === 1 ? this._place(firstWindow) : `${project.windows.size} windows`,
                summary, !!(project.review || queues.done),
                project.windows.size === 1 ? this._windowControls(firstWindow.id, snapshot) : null, fill, null, lookup.query);
        }
        this._chatSearchFeedback(lookup, rows.length, 'No matching open conversations');
        for (const warning of snapshot.warnings)
            this._section.addMenuItem(this._item(warning, 'tracker-warning'));
        if (rows.some(row => row.provider === 'claude' && row.state === 'unknown'))
            this._section.addMenuItem(this._item('Claude status awaits its first lifecycle event; existing chats may need /hooks to load the observer.', 'tracker-warning'));
    }

    // Above the chats: how many a usage limit stopped, and a button to have them go on.
    _limitBanner(rows) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item._ornamentLabel?.hide();
        const resets = Math.max(0, ...rows.map(row => row.limited.resets || 0));
        const names = [...new Set(rows.map(row => row.project))].join(', ');
        const label = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'tracker-detail',
            text: `${rows.length} chat${rows.length === 1 ? '' : 's'} stopped at a usage limit · ${names}${resets ? ` · ${resetTime(resets)}` : ''}`});
        item.add_child(label);
        const button = new St.Button({label: 'Continue', can_focus: true, style_class: 'tracker-filter', y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Queue a note to go on in the Codex chats, and put one at the end of each Claude chat\'s input box'});
        button.connect('clicked', () => this._continueLimited(rows));
        item.add_child(button);
        return item;
    }

    // Codex chats get the note queued and start it themselves; each Claude chat comes forward with the note at the end
    // of its input box, for the user to send.
    async _continueLimited(rows) {
        if (this._continuing) return;
        this._continuing = true;
        this._button.menu.close();
        const problems = [];
        try {
            for (const row of rows) {
                if (!this._enabled) return;
                try {
                    const result = await this._run(['continue', row.key]);
                    if (!result.paste) continue;
                    // _activate reports its own failures.
                    const shown = await this._activate(row, this._snapshot, 'focus', true);
                    if (shown?.ok) await this._appendToInput(row, result.paste, shown.input);
                } catch (error) { problems.push(`${row.project}: ${error.message}`); }
            }
        } finally { this._continuing = false; }
        if (problems.length && this._enabled) Main.notifyError('Agent Bar', problems.join('\n'));
    }

    // Puts `text` at the end of the chat's input box, after any draft, by pasting it. The keys reach whichever window
    // has focus, so they go only while the chat's window, just brought forward with the cursor in its input box, still
    // has it and nobody is typing; otherwise the text is left on the clipboard to paste.
    async _appendToInput(row, text, focused) {
        const clipboard = St.Clipboard.get_default(), CLIPBOARD = St.ClipboardType.CLIPBOARD;
        const read = () => new Promise(resolve => clipboard.get_text(CLIPBOARD, (_, value) => resolve(value)));
        const win = this._findWindow(this._snapshot.windows.find(w => w.id === row.window), false);
        const idle = global.backend.get_core_idle_monitor();
        for (let i = 0; i < 30 && idle.get_idletime() < 600; i++) await this._delay(100);
        // Idle for half a second, or, after our own keys, since the last of them.
        const ready = () => this._enabled && focused && win && global.display.focus_window === win
            && idle.get_idletime() >= Math.min(500, (GLib.get_monotonic_time() - (this._keysAt || 0)) / 1000 - 30);
        const leave = () => {
            clipboard.set_text(CLIPBOARD, text);
            if (this._enabled) Main.notify('Agent Bar', `${row.project}: "${text}" is on the clipboard; paste it into the chat's input box`);
        };
        if (!ready()) return leave();
        const saved = await read();
        const marker = `agent-bar:${GLib.uuid_string_random()}`;
        clipboard.set_text(CLIPBOARD, marker);
        // Copy the draft, if any, then put the cursor back at its end at once, so it is never left selected.
        const {KEY_Control_L: CTRL, KEY_Shift_L: SHIFT, KEY_End: END, KEY_Home: HOME} = Clutter;
        await this._keys([CTRL, END], [CTRL, SHIFT, HOME], [CTRL, Clutter.KEY_c], [CTRL, END]);
        await this._delay(250);
        const copied = await read();
        const draft = copied === marker ? '' : copied || '';
        if (!ready()) {
            clipboard.set_text(CLIPBOARD, saved ?? '');
            return leave();
        }
        clipboard.set_text(CLIPBOARD, (!draft.trim() ? '' : draft.endsWith('\n') ? '\n' : '\n\n') + text);
        await this._delay(50);
        await this._keys([CTRL, END], [CTRL, Clutter.KEY_v]);
        await this._delay(300);
        // Text the clipboard held comes back; anything else it held is gone.
        clipboard.set_text(CLIPBOARD, saved ?? '');
    }

    // Key chords pressed as on a keyboard, for the window with focus.
    async _keys(...chords) {
        this._keyboard ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        for (const chord of chords) {
            for (const key of chord) this._keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
            for (const key of [...chord].reverse()) this._keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
            await this._delay(40);
        }
        this._keysAt = GLib.get_monotonic_time();
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

    async _loadQueueDependencies() {
        const numbers = this._dependencyNumbers;
        if (this._dependenciesLoading || !numbers?.length || this._menuSnapshot?.scheduler !== 'on') return;
        if (Date.now() - (this._dependenciesAt || 0) < 30000 && numbers.every(n => this._coveredNumbers?.has(n))) return;
        this._dependenciesLoading = true;
        try {
            this._dependencies = await this._run(['queue-dependencies', ...numbers.map(String)]);
        } catch (error) {
            this._dependencies = {error: error instanceof Error ? error.message : String(error)};
        } finally {
            this._dependenciesLoading = false;
            this._dependenciesAt = Date.now();
            this._coveredNumbers = new Set(numbers);
        }
        if (!this._enabled || this._view !== 'queues' || this._page || !this._button.menu.isOpen) return;
        this._updateQueueGates();
        if (numbers !== this._dependencyNumbers) this._loadQueueDependencies();
    }

    _updateQueueGates() {
        if (this._gateWarning) {
            const loading = this._dependenciesLoading && this._dependencyNumbers?.some(n => !this._coveredNumbers?.has(n));
            const error = this._dependencies?.error;
            this._gateWarning.visible = !!(error || loading);
            this._gateWarning.label.text = error ? `Queue dependencies unavailable · ${error}` : loading ? 'Reading queue dependencies…' : '';
        }
        for (const [id, box] of this._gateRows || []) {
            const deps = this._dependencies?.links?.[id] || [];
            const error = this._dependencies?.errors?.[id];
            const tip = error ? `Prerequisites unavailable · ${error}` : !deps.length ? '' : 'Prerequisite queues\n' +
                deps.map(/** @param {{number:number, name:string, detail:string, project?:string}} d */ d =>
                    `#${d.number} · ${d.name}${d.project ? ' (' + d.project + ')' : ''} · ${d.detail}`).join('\n');
            box.visible = !!tip;
            if (box.accessible_name === tip) continue;
            box.destroy_all_children();
            box.accessible_name = tip;
            if (!tip) continue;
            const label = (/** @type {string} */ text, style = 'tracker-detail') =>
                box.add_child(new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER}));
            label('←');
            if (error) { label('?', 'tracker-attention'); continue; }
            // Keep the row narrow and show failed prerequisites first. The tooltip includes the entire list.
            const ordered = [...deps].sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed'));
            for (const dep of ordered.slice(0, 3)) {
                const failed = dep.state === 'failed', uncertain = ['unknown', 'verify'].includes(dep.state);
                const style = failed ? 'tracker-failed' : uncertain ? 'tracker-attention' : dep.state === 'complete' ? 'tracker-finished' : 'tracker-detail';
                label(`#${dep.number}${failed ? '!' : uncertain ? '?' : ''}`, style);
            }
            if (ordered.length > 3) label(`+${ordered.length - 3}`);
        }
    }

    _renderQueues(snapshot, query) {
        if (snapshot.scheduler === 'missing') {
            this._renderSchedulerMissing();
            return;
        }
        const queues = snapshot.queues.filter(q => /^#\d+$/.test(query) ? `#${q.number}` === query :
            `${q.project} ${q.label}`.toLowerCase().includes(query));
        const groups = queueGroups(queues, snapshot.queue_counts, this._setting('queueOrder'), this._queueFilter);
        if (Date.now() / 1000 - snapshot.queue_updated > 120)
            this._section.addMenuItem(this._item('Snapshot stale · start the parallel-workers monitor to refresh queue progress', 'tracker-warning'));
        if (Date.now() - this._controlsAt > 10000) this._loadControls();
        /** @type {number[]} */
        this._dependencyNumbers = groups.flatMap(([, items]) => items.map(/** @param {{number:number}} q */ q => q.number)).filter(Number.isInteger);
        this._loadQueueDependencies();
        this._gateRows = new Map();
        this._gateWarning = this._item('', 'tracker-warning');
        this._section.addMenuItem(this._gateWarning);
        const described = this._controls;
        // Queues the scheduler can still change, by their id in the queue snapshot.
        const controlled = new Map((described?.queues || []).filter(queue => queue.controls?.length).map(queue => [queue.snapshot_id, queue]));
        if (this._controlsError) this._section.addMenuItem(this._item(this._controlsError, 'tracker-warning'));
        else if (described && !described.coordinator?.reachable)
            this._section.addMenuItem(this._item(`Scheduler controls unavailable: ${described.coordinator?.error || 'its coordinator is unreachable'}`,
                'tracker-warning'));
        for (const [project, items] of groups) {
            const count = snapshot.queue_counts[project] || {done: 0, total: 0};
            // Other filters can list queues that finished before the project's last turn.
            const earlier = items.filter(queue => !queue.counted).length;
            const window = projectWindow(snapshot.windows, project);
            const controls = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
            if (count.done) {
                const clear = new St.Button({label: 'Clear', can_focus: true, style_class: 'tracker-filter',
                    y_align: Clutter.ActorAlign.CENTER, accessible_name: `Clear ${project}'s finished queues`});
                clear.connect('clicked', () => this._clearQueues(project));
                controls.add_child(clear);
            }
            if (window) controls.add_child(this._windowControls(window.id, snapshot));
            const body = this._projectSection(`queue:${project}`, project, 'since last turn',
                `${count.done} / ${count.total} finished${earlier ? ` · ${earlier} earlier` : ''}`, !!count.done,
                controls.get_n_children() ? controls : null);
            for (const queue of items) {
                const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
                item._ornamentLabel?.hide();
                item.add_style_class_name('tracker-queue-row');
                if (!queue.counted) item.add_style_class_name('tracker-queue-earlier');
                const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-row'});
                const line = new St.BoxLayout({style_class: 'tracker-row-title'});
                if (queue.number) line.add_child(new St.Label({text: `#${queue.number}`,
                    style_class: ['FAILED', 'FINISHED_INCOMPLETE', 'KILLED'].includes(queue.state) ? 'tracker-failed' : 'tracker-detail',
                    y_align: Clutter.ActorAlign.CENTER}));
                const title = new St.Label({text: queue.label, x_expand: true, style_class: 'tracker-title'});
                title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                line.add_child(title);
                const entity = controlled.get(queue.id);
                const editor = new PopupMenu.PopupMenuSection();
                if (entity) {
                    line.add_child(this._controlsToggle(`queue:${entity.id}`, queue.label, entity, editor,
                        section => this._fillControls(section, {kind: 'queue', id: entity.id}, entity, true)));
                }
                const gates = new St.BoxLayout({style_class: 'tracker-queue-gates', can_focus: true,
                    y_align: Clutter.ActorAlign.CENTER, visible: false});
                this._gateRows.set(queue.id, gates);
                line.add_child(this._tooltip(gates, () => gates.accessible_name));
                const setting = entity?.controls.find(/** @param {{name: string}} control */ control => control.name === 'priority');
                const priority = queuePriority(queue.workers, setting?.value);
                if (priority) {
                    const badge = new St.Bin({style_class: 'tracker-queue-priority', can_focus: true, accessible_name: priority.tip,
                        y_align: Clutter.ActorAlign.CENTER, child: new St.Label({text: String(priority.value),
                            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})});
                    line.add_child(this._tooltip(badge, priority.tip));
                }
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
                if (entity) body.addMenuItem(editor);
            }
        }
        this._updateQueueGates();
        if (!groups.length) this._section.addMenuItem(this._item('No matching watched queues', 'tracker-empty'));
        const pool = described?.pool;
        const hosts = (described?.hosts || []).filter(host => !query || `pool ${host.label}`.toLowerCase().includes(query));
        if (pool && (!query || hosts.length)) {
            const name = pool.facts?.find(fact => fact.label === 'Name')?.value || pool.id;
            const body = this._projectSection('scheduler:pool', 'Pool and hosts', name,
                `${pool.state} · ${described.hosts.length} host${described.hosts.length === 1 ? '' : 's'}`);
            this._controlledRow(body, {kind: 'pool', id: pool.id}, 'Pool', pool);
            for (const host of hosts) this._controlledRow(body, {kind: 'host', id: host.id}, host.label, host);
        }
    }

    // One pool or host: its facts on one line, and its controls under it once opened.
    _controlledRow(body, target, title, entity) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item._ornamentLabel?.hide();
        item.add_style_class_name('tracker-queue-row');
        const line = new St.BoxLayout({style_class: 'tracker-row-title', x_expand: true});
        line.add_child(new St.Label({text: title, style_class: 'tracker-title', y_align: Clutter.ActorAlign.CENTER}));
        const facts = new St.Label({text: (entity.facts || []).filter(fact => fact.label !== 'Name').map(fact => `${fact.label} ${fact.value}`).join(' · '),
            x_expand: true, style_class: 'tracker-detail', y_align: Clutter.ActorAlign.CENTER});
        facts.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        line.add_child(facts);
        const editor = new PopupMenu.PopupMenuSection();
        if (entity.controls?.length)
            line.add_child(this._controlsToggle(`${target.kind}:${target.id}`, title, entity, editor, section => this._fillControls(section, target, entity, false)));
        item.add_child(line);
        body.addMenuItem(item);
        if (entity.controls?.length) body.addMenuItem(editor);
    }

    // A button that opens or closes an entity's controls in `editor`, filled the first time it opens.
    _controlsToggle(key, name, entity, editor, fill) {
        const button = new St.Button({label: 'Adjust', can_focus: true, toggle_mode: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'tracker-filter tracker-control-toggle', accessible_name: `Adjust ${name} in the scheduler`});
        this._tooltip(button, `Change in the scheduler: ${entity.controls.map(control => control.label).join(', ')}`);
        const show = () => {
            const open = this._openControls.has(key);
            button.set_checked(open);
            editor.actor.visible = open;
            if (open && fill) {
                fill(editor);
                fill = null;
            }
        };
        button.connect('clicked', () => {
            if (this._openControls.has(key)) this._openControls.delete(key);
            else this._openControls.add(key);
            show();
        });
        show();
        return button;
    }

    // Hovering or focusing `actor` shows `text` (or what a function `text` returns then) in a small box under it
    // after a moment.
    _tooltip(actor, text) {
        if (!text) return actor;
        actor.reactive = true;
        actor.track_hover = true;
        let tip = null, timer = 0;
        const hide = () => {
            if (timer) GLib.source_remove(timer);
            timer = 0;
            tip?.destroy();
            tip = null;
        };
        const show = () => {
            if (tip || timer) return;
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                timer = 0;
                if (!actor.mapped || !(actor.hover || actor.has_key_focus())) return GLib.SOURCE_REMOVE;
                const content = typeof text === 'function' ? text() : text;
                if (!content) return GLib.SOURCE_REMOVE;
                tip = new St.Label({text: content, style_class: 'tracker-tooltip'});
                tip.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                tip.clutter_text.line_wrap = true;
                Main.layoutManager.uiGroup.add_child(tip);
                const [x, y] = actor.get_transformed_position();
                const [, height] = actor.get_transformed_size();
                const [, tipWidth] = tip.get_preferred_width(-1);
                const [, tipHeight] = tip.get_preferred_height(tipWidth);
                const monitor = Main.layoutManager.findMonitorForActor(actor) || Main.layoutManager.primaryMonitor;
                const left = Math.min(Math.max(x, monitor.x + 8), monitor.x + monitor.width - tipWidth - 8);
                const top = y + height + tipHeight + 6 > monitor.y + monitor.height ? y - tipHeight - 6 : y + height + 6;
                tip.set_position(Math.round(left), Math.round(top));
                return GLib.SOURCE_REMOVE;
            });
        };
        actor.connect('notify::hover', () => (actor.hover ? show() : hide()));
        actor.connect('key-focus-in', show);
        actor.connect('key-focus-out', hide);
        actor.connect('notify::mapped', () => actor.mapped || hide());
        actor.connect('destroy', hide);
        return actor;
    }

    // A small circled i, drawn like the header's ?, whose tooltip is `text`.
    _helpIcon(text) {
        const mark = new St.Bin({style_class: 'tracker-control-info', y_align: Clutter.ActorAlign.CENTER, can_focus: true,
            accessible_name: text, child: new St.Label({text: 'i', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})});
        return this._tooltip(mark, text);
    }

    // An entity's controls, opened under its row: its facts as chips, its actions as a row of buttons, and its settings
    // one to a row with their help behind ⓘ. Edited settings collect into one Apply; irreversible actions ask first.
    _fillControls(editor, target, entity, facts) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item._ornamentLabel?.hide();
        item.add_style_class_name('tracker-control');
        const panel = new St.BoxLayout({vertical: true, style_class: 'tracker-control-panel'});
        item.add_child(panel);
        editor.addMenuItem(item);
        // Redrawn in place after a change or Revert; what was typed is kept by control.
        const rebuild = () => {
            this._releaseFocus(this._button.menu, editor.actor);
            editor.removeAll();
            this._fillControls(editor, target, entity, facts);
        };
        if (facts && entity.facts?.length) {
            const chips = new St.BoxLayout({vertical: true, style_class: 'tracker-control-facts'});
            for (const line of chipLines(entity.facts.map(fact => `${fact.label}: ${fact.value}`))) {
                const row = new St.BoxLayout({style_class: 'tracker-control-actions'});
                for (const text of line) row.add_child(new St.Label({text, style_class: 'tracker-control-fact'}));
                chips.add_child(row);
            }
            panel.add_child(chips);
        }
        const actions = entity.controls.filter(controlIsAction);
        if (actions.length) panel.add_child(this._controlActions(target, actions, rebuild));
        let update = () => {};
        const rows = entity.controls.filter(control => !controlIsAction(control))
            .map(control => this._settingRow(target, control, () => update()));
        for (const row of rows) panel.add_child(row.actor);
        if (!rows.some(row => row.editable)) return;
        const footer = new St.BoxLayout({style_class: 'tracker-control-footer'});
        const summary = new St.Label({x_expand: true, style_class: 'tracker-detail', y_align: Clutter.ActorAlign.CENTER});
        summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const button = (label, style, name) => new St.Button({label, can_focus: true, style_class: style, accessible_name: name,
            y_align: Clutter.ActorAlign.CENTER});
        const revert = button('Revert', 'tracker-control-action', 'Put back the values the scheduler shows');
        const apply = button('Apply', 'tracker-control-primary', 'Send the changed settings to the scheduler');
        footer.add_child(summary);
        footer.add_child(revert);
        footer.add_child(apply);
        panel.add_child(footer);
        const enable = (actor, on) => {
            actor.reactive = on;
            actor.opacity = on ? 255 : 110;
        };
        update = () => {
            const states = rows.map(row => row.state());
            const changed = states.filter(state => state.changed).length;
            const invalid = states.find(state => state.error);
            footer.visible = changed > 0 || !!invalid;
            summary.text = invalid ? invalid.error : `${changed} setting${changed === 1 ? '' : 's'} changed`;
            summary.style_class = invalid ? 'tracker-warning' : 'tracker-detail';
            apply.label = changed > 1 ? `Apply ${changed} changes` : 'Apply';
            enable(apply, !invalid && changed > 0);
        };
        revert.connect('clicked', () => {
            for (const control of entity.controls) this._controlInputs.delete(`${target.kind}:${target.id}:${control.name}`);
            rebuild();
        });
        apply.connect('clicked', async () => {
            enable(apply, false);
            enable(revert, false);
            summary.text = 'Applying…';
            // One request per setting, in order; each keeps its own result.
            for (const row of rows) if (row.state().changed) await row.apply();
            if (this._enabled) rebuild();
        });
        update();
    }

    // The values a change is sent with, and whether it went: success holds the control until the scheduler shows it;
    // a refusal stays beside the control until it is edited or sent again.
    async _sendControl(target, control, value) {
        const key = `${target.kind}:${target.id}:${control.name}`;
        const answer = await this._applyControl(target, control, value);
        if (answer.ok) {
            this._controlApplied.set(key, {at: Date.now() / 1000, message: answer.message});
            this._controlInputs.delete(key);
            this._controlErrors.delete(key);
        } else {
            const error = answer.error || {};
            const message = error.message || 'The scheduler refused the change';
            this._controlErrors.set(key, message[0].toUpperCase() + message.slice(1)
                + (error.code === 'conflict' ? '. It changed since this was shown; the values here update within about 30 s.'
                    : error.retryable ? '. Try again shortly.' : ''));
        }
        return answer;
    }

    // Whether a change to this control was applied and the description read since does not show it yet.
    _controlWaiting(key) {
        const applied = this._controlApplied.get(key);
        if (applied && (this._controls?.as_of ?? 0) >= applied.at) this._controlApplied.delete(key);
        return this._controlApplied.get(key) || null;
    }

    // Action buttons in one row; one that is irreversible, or needs a note, opens a confirmation under the row first.
    _controlActions(target, controls, rebuild) {
        const box = new St.BoxLayout({vertical: true, style_class: 'tracker-control-setting'});
        const line = new St.BoxLayout({style_class: 'tracker-control-actions'});
        box.add_child(line);
        const confirm = new St.BoxLayout({vertical: true, style_class: 'tracker-control-confirm', visible: false});
        box.add_child(confirm);
        const notes = new St.BoxLayout({vertical: true});
        box.add_child(notes);
        const note = (text, style) => {
            const label = new St.Label({text, style_class: `${style} tracker-control-wrap`});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            label.clutter_text.line_wrap = true;
            notes.add_child(label);
            return label;
        };
        const run = async (control, value) => {
            notes.destroy_all_children();
            note(`${control.label}: applying…`, 'tracker-control-note');
            await this._sendControl(target, control, value);
            if (this._enabled) rebuild();
        };
        for (const control of controls) {
            const key = `${target.kind}:${target.id}:${control.name}`;
            const waiting = this._controlWaiting(key);
            const usable = control.enabled && !waiting;
            const danger = control.danger === 'irreversible';
            const button = new St.Button({label: control.label, can_focus: true, accessible_name: control.label,
                style_class: `tracker-control-action${danger ? ' tracker-control-risky' : ''}${usable ? '' : ' tracker-control-disabled'}`});
            this._tooltip(button, !control.enabled ? `Not now: ${control.disabled_reason || 'unavailable'}`
                : waiting ? 'Applied; shown here once the scheduler next reports, within about 30 s' : control.help);
            line.add_child(button);
            if (waiting) this._tooltip(note(`✓ ${control.label} applied; shown here once the scheduler next reports, within about 30 s.`,
                'tracker-control-note'), waiting.message);
            const error = this._controlErrors.get(key);
            if (error) note(`${control.label}: ${error}`, 'tracker-warning');
            if (!usable) continue;
            button.connect('clicked', () => {
                if (control.kind === 'action' && !danger) {
                    run(control, null);
                    return;
                }
                // Ask: the scheduler's question, any note it records, then Cancel or go ahead.
                confirm.destroy_all_children();
                confirm.show();
                const question = new St.Label({text: control.confirm || control.help || `${control.label}?`,
                    style_class: `tracker-control-question tracker-control-wrap${danger ? ' tracker-attention' : ''}`});
                question.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                question.clutter_text.line_wrap = true;
                confirm.add_child(question);
                const typed = {value: controlTyped(control)};
                for (const field of control.kind === 'group' ? control.fields : []) {
                    const row = new St.BoxLayout({style_class: 'tracker-control-line'});
                    row.add_child(new St.Label({text: field.label, style_class: 'tracker-control-sub', y_align: Clutter.ActorAlign.CENTER}));
                    row.add_child(this._controlInput(field, typed.value, field.name, () => {}));
                    confirm.add_child(row);
                }
                const buttons = new St.BoxLayout({style_class: 'tracker-control-actions', x_align: Clutter.ActorAlign.END});
                const cancel = new St.Button({label: 'Cancel', can_focus: true, style_class: 'tracker-control-action'});
                const go = new St.Button({label: control.label, can_focus: true, accessible_name: `${control.label}, confirmed`,
                    style_class: danger ? 'tracker-control-danger' : 'tracker-control-primary'});
                buttons.add_child(cancel);
                buttons.add_child(go);
                confirm.add_child(buttons);
                cancel.connect('clicked', () => {
                    this._releaseFocus(this._button.menu, confirm);
                    confirm.destroy_all_children();
                    confirm.hide();
                });
                go.connect('clicked', () => {
                    const result = controlValue(control, typed.value);
                    if (result.error) {
                        notes.destroy_all_children();
                        note(result.error, 'tracker-warning');
                        return;
                    }
                    run(control, result.value);
                });
                global.stage.set_key_focus(cancel);
            });
        }
        return box;
    }

    // One setting: its name (help behind ⓘ), its first inputs on the row, any others folded under it. Returns its
    // actor, whether it can be edited now, its state ({changed, value} or {error}) and how to send it.
    _settingRow(target, control, onChange) {
        const key = `${target.kind}:${target.id}:${control.name}`;
        const actor = new St.BoxLayout({vertical: true, style_class: 'tracker-control-setting'});
        const line = new St.BoxLayout({style_class: 'tracker-control-line'});
        actor.add_child(line);
        const name = new St.BoxLayout({style_class: 'tracker-control-name', y_align: Clutter.ActorAlign.CENTER});
        const title = new St.Label({text: control.label, style_class: 'tracker-control-label', y_align: Clutter.ActorAlign.CENTER});
        name.add_child(title);
        const help = [control.help, control.effect === 'next-job' ? 'Applies to jobs that start afterwards.' : null].filter(Boolean).join(' ');
        if (help) name.add_child(this._helpIcon(help));
        line.add_child(name);
        const label = (text, style) => {
            const result = new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER});
            result.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            return result;
        };
        const note = (text, style) => {
            const result = new St.Label({text, style_class: `${style} tracker-control-wrap`});
            result.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            result.clutter_text.line_wrap = true;
            actor.add_child(result);
            return result;
        };
        const waiting = this._controlWaiting(key);
        const fixed = {actor, editable: false, state: () => ({changed: false}), apply: async () => {}};
        if (!control.enabled || waiting) {
            title.add_style_class_name('tracker-control-label-off');
            const value = label(controlSummary(control), 'tracker-detail tracker-control-value');
            value.x_expand = true;
            line.add_child(value);
            if (waiting) this._tooltip(note(`✓ Applied; shown here once the scheduler next reports, within about 30 s.`, 'tracker-control-note'),
                waiting.message);
            else line.add_child(this._tooltip(label(`Not now: ${control.disabled_reason || 'unavailable'}`, 'tracker-control-reason'),
                control.disabled_reason));
            return fixed;
        }
        // What was typed survives the list redrawing, until the value it was typed over changes.
        const base = controlKey(control.value);
        let saved = this._controlInputs.get(key);
        if (!saved || saved.base !== base) {
            saved = {base, typed: {value: controlTyped(control)}};
            this._controlInputs.set(key, saved);
        }
        const typed = saved.typed;
        const state = () => controlChange(control, typed.value);
        const changed = () => {
            this._controlErrors.delete(key);
            if (state().changed) title.add_style_class_name('tracker-control-edited');
            else title.remove_style_class_name('tracker-control-edited');
            onChange();
        };
        const [shown, more] = groupFields(control);
        const field = (part, into) => {
            const [holder, name] = control.kind === 'group' ? [typed.value, part.name] : [typed, 'value'];
            if (!part.enabled) {
                into.add_child(label(`${controlSummary(part)} · ${part.disabled_reason || 'unavailable'}`, 'tracker-detail'));
                return;
            }
            into.add_child(this._controlInput(part, holder, name, changed));
            if (part.unit && part.kind !== 'host-map') into.add_child(label(part.unit, 'tracker-control-sub'));
        };
        shown.forEach(part => {
            if (control.kind === 'group' && shown.length > 1) line.add_child(label(part.label, 'tracker-control-sub'));
            field(part, line);
        });
        if (more.length) {
            // The other fields fold under a line that summarizes them.
            const open = this._controlFolds.has(key);
            const body = new St.BoxLayout({vertical: true, style_class: 'tracker-control-more', visible: open});
            const fold = new St.Button({can_focus: true, x_expand: true, style_class: 'tracker-control-expander',
                accessible_name: `More ${control.label} settings`});
            const text = label('', 'tracker-control-sub');
            const describe = () => {
                text.text = `${this._controlFolds.has(key) ? '⌄' : '›'}  ${more.map(part => `${part.label} ${controlSummary(part)}`).join(' · ')}`;
            };
            describe();
            fold.set_child(text);
            fold.connect('clicked', () => {
                if (this._controlFolds.has(key)) this._controlFolds.delete(key);
                else this._controlFolds.add(key);
                body.visible = this._controlFolds.has(key);
                describe();
            });
            line.add_child(fold);
            for (const part of more) {
                // A host map's grid is as wide as the row, and its name is on the line that unfolds it.
                const row = new St.BoxLayout({style_class: 'tracker-control-line'});
                if (part.kind !== 'host-map') row.add_child(label(part.label, 'tracker-control-sub tracker-control-field'));
                field(part, row);
                body.add_child(row);
            }
            actor.add_child(body);
        } else {
            line.add_child(new St.Widget({x_expand: true}));
        }
        const error = this._controlErrors.get(key);
        if (error) note(error, 'tracker-warning');
        if (state().changed) title.add_style_class_name('tracker-control-edited');
        return {actor, editable: true, state, apply: async () => {
            const result = state();
            if (result.changed) await this._sendControl(target, control, result.value);
        }};
    }

    // An input for one control or group field, writing what is typed into holder[key] and calling onChange.
    _controlInput(control, holder, key, onChange) {
        if (control.kind === 'choice') {
            const box = new St.BoxLayout({style_class: 'tracker-control-choices'});
            const buttons = control.choices.map(choice => {
                const button = new St.Button({label: choice.label, can_focus: true, toggle_mode: true, style_class: 'tracker-control-choice',
                    accessible_name: `${control.label} ${choice.label}`});
                button.connect('clicked', () => {
                    holder[key] = choice.value;
                    buttons.forEach((other, index) => other.set_checked(control.choices[index].value === choice.value));
                    onChange();
                });
                box.add_child(button);
                return button;
            });
            buttons.forEach((button, index) => button.set_checked(control.choices[index].value === holder[key]));
            return box;
        }
        if (control.kind === 'host-map') {
            // Three hosts to a line; a blank one has no override.
            const box = new St.BoxLayout({vertical: true, style_class: 'tracker-control-hosts'});
            let line = null;
            control.hosts.forEach((host, index) => {
                if (index % 3 === 0) box.add_child(line = new St.BoxLayout({style_class: 'tracker-control-line'}));
                line.add_child(new St.Label({text: host, style_class: 'tracker-control-sub tracker-control-host', y_align: Clutter.ActorAlign.CENTER}));
                line.add_child(this._controlEntry(holder[key], host, 'default', `${control.label} on ${host}: a number, off, or blank for the default`,
                    onChange));
            });
            return box;
        }
        return this._controlEntry(holder, key, control.optional ? 'none' : '', control.label, onChange,
            control.kind === 'text' ? 'tracker-control-text' : '');
    }

    _controlEntry(holder, key, hint, name, onChange, style = '') {
        const entry = new St.Entry({text: holder[key] ?? '', hint_text: hint, can_focus: true, accessible_name: name,
            style_class: `tracker-search tracker-control-entry ${style}`.trim(), y_align: Clutter.ActorAlign.CENTER});
        entry.clutter_text.connect('text-changed', () => {
            holder[key] = entry.get_text();
            onChange();
        });
        return entry;
    }

    async _applyControl(target, control, value) {
        const request = controlRequest(target, control, value, this._controls?.pool?.id ?? null, GLib.uuid_string_random());
        try {
            return await this._control(['apply'], JSON.stringify(request));
        } catch (error) {
            return {ok: false, error: {code: 'failed', message: error.message}};
        }
    }

    // Reads what the scheduler's controls are now; the Queues tab redraws when they or its reachability change.
    async _loadControls() {
        if (this._controlsLoading) return;
        this._controlsAt = Date.now();
        if (!controlProgram()) {
            this._controls = this._controlsError = null;
            return;
        }
        this._controlsLoading = true;
        const before = [controlsSignature(this._controls), this._controlsError];
        try {
            this._controls = await this._control(['describe']);
            this._controlsError = null;
        } catch (error) {
            this._controls = null;
            this._controlsError = `Scheduler controls unavailable: ${error.message}`;
        } finally {
            this._controlsLoading = false;
            this._controlsAt = Date.now();
        }
        if (this._enabled && this._button.menu.isOpen && this._view === 'queues' && !this._page
            && (controlsSignature(this._controls) !== before[0] || this._controlsError !== before[1]))
            this._later(() => this._renderRows());
    }

    // Runs the scheduler's control command with `input` on stdin, resolving with its JSON answer whatever its exit
    // status, since it answers refusals in JSON too.
    _control(args, input = '') {
        return new Promise((resolve, reject) => {
            const program = controlProgram();
            if (!program) {
                reject(new Error('pw-control is not installed'));
                return;
            }
            try {
                const process = Gio.Subprocess.new([program, ...args],
                    Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
                process.communicate_utf8_async(input, this._cancel, (proc, result) => {
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                        let value;
                        try {
                            value = JSON.parse(stdout);
                        } catch (_) {
                            throw new Error((stderr || stdout || 'no answer').trim().split('\n').pop());
                        }
                        if (value?.protocol !== CONTROL_PROTOCOL)
                            throw new Error(`pw-control speaks protocol ${value?.protocol}; this Agent Bar knows ${CONTROL_PROTOCOL}`);
                        resolve(value);
                    } catch (error) { reject(error); }
                });
            } catch (error) { reject(error); }
        });
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

    // New ticket (or its form), then the tickets ready to start, waiting, started and recently closed.
    _renderTickets(snapshot, query) {
        const listing = snapshot.tickets || {open: [], closed: []};
        const groups = ticketGroups(listing, query);
        if (this._ticketDraft?.open) this._section.addMenuItem(this._ticketForm(snapshot));
        else {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tracker-ticket-bar'});
            item._ornamentLabel?.hide();
            const button = new St.Button({label: '+  New ticket', can_focus: true, style_class: 'tracker-control-primary',
                y_align: Clutter.ActorAlign.CENTER});
            button.connect('clicked', () => {
                (this._ticketDraft ||= {text: '', folder: null, waits: [], date: ''}).open = true;
                this._renderRows();
                this._later(() => this._ticketEntry && global.stage.set_key_focus(this._ticketEntry.clutter_text));
            });
            item.add_child(button);
            const counts = groups.filter(([name]) => name !== 'Closed').map(([name, tickets]) => `${tickets.length} ${name.toLowerCase()}`);
            const note = new St.Label({text: this._ticketError || counts.join(' · '), x_expand: true, x_align: Clutter.ActorAlign.END,
                style_class: this._ticketError ? 'tracker-warning' : 'tracker-detail', y_align: Clutter.ActorAlign.CENTER});
            note.clutter_text.line_wrap = true;
            item.add_child(note);
            this._section.addMenuItem(item);
        }
        if (!groups.length) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tracker-ticket-empty'});
            item._ornamentLabel?.hide();
            const box = new St.BoxLayout({vertical: true, x_expand: true});
            const searching = listing.open.length || listing.closed.length;
            for (const [text, style] of searching ? [['No matching tickets', 'tracker-ticket-empty-title']] : [
                ['No tickets yet', 'tracker-ticket-empty-title'],
                ['A ticket is a task to do later in one project. It can wait for a usage limit to reset, the project\'s queues to '
                    + 'finish, or a time, and then shows here as ready. Agents write them with agent-bar ticket add.', 'tracker-detail']]) {
                const label = new St.Label({text, style_class: style, x_align: Clutter.ActorAlign.CENTER});
                label.clutter_text.line_wrap = true;
                label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                box.add_child(label);
            }
            item.add_child(box);
            this._section.addMenuItem(item);
        }
        if (!this._ticketsShown) {
            this._ticketsShown = true;
            this._collapsedProjects.add('tickets:Closed');
        }
        for (const [name, tickets] of groups)
            this._projectSection(`tickets:${name}`, name, '', `${tickets.length}`, name === 'Ready', null,
                body => { for (const ticket of tickets) body.addMenuItem(this._ticketItem(ticket)); });
    }

    _ticketForm(snapshot) {
        const draft = this._ticketDraft;
        const every = ticketFolders(snapshot);
        if (!every.some(([folder]) => folder === draft.folder)) draft.folder = every[0]?.[0] ?? null;
        // The most recently active few, and the chosen one, until More lists every open folder.
        const folders = draft.allFolders ? every : every.filter(([folder], index) => index < TICKET_FOLDERS || folder === draft.folder);
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'tracker-ticket-form'});
        item._ornamentLabel?.hide();
        const card = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-ticket-card'});
        card.add_child(new St.Label({text: 'New ticket', style_class: 'tracker-ticket-heading'}));
        const entry = new St.Entry({text: draft.text, hint_text: 'What should be done later, and anything a chat needs to know to do it',
            can_focus: true, x_expand: true, accessible_name: 'New ticket', style_class: 'tracker-search tracker-ticket-entry'});
        entry.clutter_text.single_line_mode = false;
        entry.clutter_text.activatable = false;
        entry.clutter_text.line_wrap = true;
        entry.clutter_text.connect('text-changed', () => { draft.text = entry.get_text(); });
        // A press anywhere in the box, not only on the line of text, puts the cursor there.
        entry.connect('button-press-event', () => {
            global.stage.set_key_focus(entry.clutter_text);
            return Clutter.EVENT_PROPAGATE;
        });
        this._ticketEntry = entry;
        card.add_child(entry);
        const field = (caption, children) => {
            card.add_child(new St.Label({text: caption, style_class: 'tracker-ticket-caption'}));
            for (const child of children) card.add_child(child);
        };
        // Chips on lines of at most `room` characters.
        const chipRows = (chips, room) => chipLines(chips.map(chip => chip.label), room).map(line => {
            const row = new St.BoxLayout({style_class: 'tracker-ticket-chips'});
            for (const _ of line) row.add_child(chips.shift());
            return row;
        });
        const chip = (label, checked, name, onClick) => {
            const button = new St.Button({label, can_focus: true, toggle_mode: true, checked, accessible_name: name,
                style_class: 'tracker-ticket-chip'});
            button.connect('clicked', () => onClick(button));
            return button;
        };
        const projects = folders.map(([folder, name]) => {
            const button = chip(name, folder === draft.folder, folder, () => {
                draft.folder = folder;
                for (const other of projects) other.checked = other === button;
            });
            this._tooltip(button, folder);
            return button;
        });
        const chips = [...projects];
        if (every.length > TICKET_FOLDERS) chips.push(chip(draft.allFolders ? 'Fewer' : `${every.length - folders.length} more…`, false,
            'Show every open folder', () => {
                draft.allFolders = !draft.allFolders;
                this._renderRows();
            }));
        field('Project', chips.length ? chipRows(chips, 62)
            : [new St.Label({text: 'No open folders; agent-bar ticket add --project DIR writes one anywhere', style_class: 'tracker-detail'})]);
        // What it waits for: any limit recorded here with a reset, the project's queues, a time.
        const waits = [...Object.keys(snapshot.usage || {}).filter(provider => snapshot.usage[provider]?.limits?.some(limit => limit.resets_at))
            .map(provider => [`reset:${provider}`, `${PROVIDERS[provider]?.[1] || provider} limit resets`,
                'The limit binding now, or else the weekly one: its reset as it stands now']),
            ...this._setting('scheduler') ? [['queues', 'Its queues finish', 'The project\'s queues outstanding now']] : []]
            .map(([value, label, tip]) => {
                const button = chip(label, draft.waits.includes(value), tip, () => {
                    draft.waits = button.checked ? [...draft.waits, value] : draft.waits.filter(other => other !== value);
                });
                this._tooltip(button, tip);
                return button;
            });
        const line = new St.BoxLayout({style_class: 'tracker-ticket-chips'});
        for (const button of waits) line.add_child(button);
        const when = this._controlEntry(draft, 'date', 'or a time: +3h, 2026-11-20 09:00', 'Wait until a time', () => {}, 'tracker-ticket-date');
        when.x_expand = false;
        when.x_align = Clutter.ActorAlign.START;
        field('Ready when', [line, when]);
        // Once ready: kept here to start by hand, or sent as a message to one of the project's open chats.
        const chats = [...new Map((snapshot.rows || []).filter(row => ['claude', 'codex'].includes(row.provider)
            && (row.roots || []).includes(draft.folder)).map(row => [row.key, row])).values()];
        if (!chats.some(row => row.key === draft.to)) draft.to = null;
        if (chats.length && this._setting('messages')) {
            const targets = [[null, 'Keep it here'], ...chats.map(row => [row.key,
                `${PROVIDERS[row.provider][0]} ${row.title.length > 30 ? `${row.title.slice(0, 29)}…` : row.title}`])];
            const sends = targets.map(([key, label]) => this._chip(label, draft.to === key, key ? `Send it to ${label}` : label, button => {
                draft.to = key;
                for (const other of sends) other.checked = other === button;
                repeat.visible = !!key;
            }));
            field('Then', this._chipRows(sends, 62));
            const repeat = new St.BoxLayout({style_class: 'tracker-ticket-chips'});
            const choices = [['', 'Once'], ['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']];
            const repeats = choices.map(([value, label]) => this._chip(label, (draft.repeat || '') === value, `Send it ${label.toLowerCase()}`, button => {
                draft.repeat = value;
                for (const other of repeats) other.checked = other === button;
            }));
            for (const chip of repeats) repeat.add_child(chip);
            repeat.visible = !!draft.to;
            card.add_child(repeat);
        }
        const footer = new St.BoxLayout({style_class: 'tracker-ticket-footer'});
        const note = new St.Label({text: this._ticketError || 'Ready at once if nothing is picked; with several, when all have passed',
            x_expand: true, style_class: this._ticketError ? 'tracker-warning' : 'tracker-detail', y_align: Clutter.ActorAlign.CENTER});
        note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        note.clutter_text.line_wrap = true;
        footer.add_child(note);
        const cancel = new St.Button({label: 'Cancel', can_focus: true, style_class: 'tracker-control-action', y_align: Clutter.ActorAlign.CENTER});
        cancel.connect('clicked', () => {
            this._ticketDraft = this._ticketError = null;
            this._renderRows();
        });
        footer.add_child(cancel);
        const add = new St.Button({label: 'Add ticket', can_focus: true, style_class: 'tracker-control-primary', y_align: Clutter.ActorAlign.CENTER});
        add.connect('clicked', () => {
            if (!draft.text.trim()) {
                note.text = 'Write what the ticket is for first';
                note.style_class = 'tracker-warning';
                global.stage.set_key_focus(entry.clutter_text);
                return;
            }
            const args = ['add', ...draft.folder ? ['--project', draft.folder] : [], ...draft.waits.flatMap(wait => ['--after', wait]),
                ...draft.date.trim() ? ['--after', `date:${draft.date.trim()}`] : [], ...draft.to ? ['--to', draft.to] : [],
                ...draft.to && draft.repeat ? ['--repeat', draft.repeat] : [], '--', draft.text];
            this._ticketAction(args, () => { this._ticketDraft = null; });
        });
        footer.add_child(add);
        card.add_child(footer);
        item.add_child(card);
        return item;
    }

    _ticketItem(ticket) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item._ornamentLabel?.hide();
        item.add_style_class_name('tracker-conversation');
        if (ticket.ready) item.add_style_class_name('tracker-unread');
        const box = new St.BoxLayout({vertical: true, style_class: 'tracker-ticket-row', x_expand: true});
        const wrapped = (text, style) => {
            const label = new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            label.clutter_text.line_wrap = true;
            return label;
        };
        box.add_child(wrapped(ticket.body.length > 1500 ? `${ticket.body.slice(0, 1499)}…` : ticket.body, 'tracker-ticket-body'));
        const [status, tone] = ticketStatus(ticket);
        const meta = new St.BoxLayout({style_class: 'tracker-ticket-meta'});
        meta.add_child(new St.Label({text: status, style_class: `tracker-chip tracker-chip-${tone}`, y_align: Clutter.ActorAlign.CENTER}));
        meta.add_child(wrapped(ticketMeta(ticket), 'tracker-detail'));
        box.add_child(meta);
        const note = ticketNote(ticket);
        if (note) box.add_child(wrapped(note, ticket.status === 'open' ? 'tracker-ticket-wait' : 'tracker-detail'));
        const actions = new St.BoxLayout({style_class: 'tracker-ticket-actions', x_align: Clutter.ActorAlign.END});
        const button = (label, style, name, onClick) => {
            const widget = new St.Button({label, can_focus: true, accessible_name: name, style_class: style, y_align: Clutter.ActorAlign.CENTER});
            this._tooltip(widget, name);
            widget.connect('clicked', () => onClick(widget));
            actions.add_child(widget);
        };
        const closed = ticket.status === 'done' || ticket.status === 'dropped';
        if (ticket.status === 'open' && !ticket.deliver_to)
            button('Start', 'tracker-control-primary', 'A new Claude Code chat in its folder, in VS Code, with the ticket as its prompt for you to send',
                widget => {
                    widget.label = 'Opening…';
                    widget.reactive = false;
                    this._ticketAction(['start', `${ticket.id}`], () => this._button.menu.close());
                });
        if (!closed) actions.add_child(this._copyButton(() => ticket.prompt, 'Copy the prompt, for a Codex chat or any other'));
        for (const [label, action, name] of closed ? [['Reopen', 'reopen', 'Open this ticket again']]
            : ticket.deliver_to ? [['Drop', 'drop', 'Cancel sending it']]
                : [['Done', 'done', 'Close it as done'], ['Drop', 'drop', 'Close it without doing it']])
            button(label, 'tracker-control-action', name, () => this._ticketAction([action, `${ticket.id}`]));
        box.add_child(actions);
        item.add_child(box);
        return item;
    }

    // The schedule column for one open chat, from the Schedule button on its row; again on the same chat closes it.
    _openSchedule(row) {
        this._checklistView = null;
        this._schedule = this._schedule?.key === row.key ? null : {key: row.key, title: row.title, provider: row.provider,
            folder: row.roots?.[0] || null, text: '', when: '', repeat: 'never', every: '', error: null};
        this._renderRows();
        this._renderSide();
        if (this._schedule) this._later(() => this._scheduleEntry && global.stage.set_key_focus(this._scheduleEntry.clutter_text));
    }

    _renderSide() {
        if (!this._side) return;
        this._releaseFocus(this._button.menu, this._sidePanel);
        this._sideHeading.destroy_all_children();
        this._side.destroy_all_children();
        const draft = this._schedule;
        const host = this._hostView && this._view === 'cluster' ? this._hostView : null;
        const shown = (!!draft || !!this._checklistView || !!host) && !this._page;
        this._sidePanel.visible = shown;
        if (!shown) return;
        this._later(() => this._placeSide());
        const title = host ? `Jobs on ${host.id}` : this._checklistView ? 'Checklists' : 'Schedule a message';
        this._sideHeading.add_child(new St.Label({text: title, x_expand: true, style_class: 'tracker-ticket-heading'}));
        const close = new St.Button({label: '×', can_focus: true, accessible_name: 'Close', style_class: 'tracker-side-close'});
        close.connect('clicked', () => {
            if (host) this._toggleHost(host.id);
            else if (this._checklistView) this._openChecklists({key: this._checklistView.key});
            else this._openSchedule({key: draft.key});
        });
        this._sideHeading.add_child(close);
        if (host) {
            host.body = new St.BoxLayout({vertical: true, style_class: 'tracker-host-projects'});
            this._side.add_child(host.body);
            this._renderHostProjects(host);
            this._loadHostProjects();
            return;
        }
        if (this._checklistView) {
            this._renderChecklists();
            return;
        }
        const to = new St.Label({text: `to ${PROVIDERS[draft.provider]?.[0] || '•'} ${draft.title}`, style_class: 'tracker-detail'});
        to.clutter_text.line_wrap = true;
        this._side.add_child(to);
        const entry = this._noteEntry(draft, 'text', 'What to send; it arrives as your request');
        this._scheduleEntry = entry;
        this._side.add_child(entry);
        const caption = text => this._side.add_child(new St.Label({text, style_class: 'tracker-ticket-caption'}));
        caption('When');
        const times = whenChoices();
        const whenChips = times.map(([value, label]) => this._chip(label, draft.when === value, label, button => {
            draft.when = button.checked ? value : '';
            for (const other of whenChips) if (other !== button) other.checked = false;
            typed.set_text(draft.when);
        }));
        for (const row of this._chipRows(whenChips, 40)) this._side.add_child(row);
        const typed = this._controlEntry(draft, 'when', 'or at YYYY-MM-DD HH:MM, +3h', 'When to send it',
            () => { for (const chip of whenChips) chip.checked = chip.label === times.find(([value]) => value === draft.when)?.[1]; },
            'tracker-ticket-date');
        typed.x_expand = false;
        typed.x_align = Clutter.ActorAlign.START;
        this._side.add_child(typed);
        caption('Repeat');
        const repeats = [['never', 'Never'], ['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['every', 'Every…']];
        const repeatChips = repeats.map(([value, label]) => this._chip(label, draft.repeat === value, label, button => {
            draft.repeat = value;
            for (const other of repeatChips) other.checked = other === button;
            every.visible = value === 'every';
        }));
        for (const row of this._chipRows(repeatChips, 40)) this._side.add_child(row);
        const every = this._controlEntry(draft, 'every', 'every 3d, 12h or 2w (at least 1h)', 'How often to send it', () => {},
            'tracker-ticket-date');
        every.x_expand = false;
        every.x_align = Clutter.ActorAlign.START;
        every.visible = draft.repeat === 'every';
        this._side.add_child(every);
        const note = new St.Label({style_class: draft.error ? 'tracker-warning' : 'tracker-detail',
            text: draft.error || (this._setting('wake') ? 'At that time, an idle chat is woken to read it; a busy one reads it when its turn ends.'
                : 'Wake idle chats is off (Settings › Integrations), so it waits for your next prompt in that chat.')});
        note.clutter_text.line_wrap = true;
        note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._side.add_child(note);
        const footer = new St.BoxLayout({style_class: 'tracker-ticket-footer', x_align: Clutter.ActorAlign.END});
        const send = new St.Button({label: 'Schedule', can_focus: true, style_class: 'tracker-control-primary'});
        send.connect('clicked', () => {
            const repeat = draft.repeat === 'every' ? draft.every.trim() : draft.repeat;
            const problem = !draft.text.trim() ? 'Write the message first' : !draft.when.trim() ? 'Pick when to send it'
                : draft.repeat === 'every' && !repeat ? 'Say how often to repeat it' : null;
            if (problem) {
                draft.error = problem;
                this._renderSide();
                return;
            }
            const args = ['add', ...draft.folder ? ['--project', draft.folder] : [], '--to', draft.key, '--after', `date:${draft.when.trim()}`,
                ...repeat !== 'never' ? ['--repeat', repeat] : [], '--', draft.text];
            send.label = 'Scheduling…';
            send.reactive = false;
            this._ticketAction(args, () => Object.assign(draft, {text: '', when: '', repeat: 'never', every: '', error: null}),
                error => { draft.error = error; });
        });
        footer.add_child(send);
        this._side.add_child(footer);
        const pending = scheduledFor(this._menuSnapshot?.tickets, draft.key);
        if (pending.length) caption('Scheduled for this chat');
        for (const ticket of pending) {
            const item = new St.BoxLayout({style_class: 'tracker-side-ticket'});
            const text = new St.BoxLayout({vertical: true, x_expand: true});
            for (const [value, style] of [[ticket.body.split('\n')[0], 'tracker-side-ticket-body'], [ticketNote(ticket), 'tracker-detail']]) {
                const label = new St.Label({text: value, style_class: style});
                label.clutter_text.line_wrap = true;
                label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                text.add_child(label);
            }
            item.add_child(text);
            const drop = new St.Button({label: 'Drop', can_focus: true, style_class: 'tracker-control-action', y_align: Clutter.ActorAlign.CENTER,
                accessible_name: `Drop ticket #${ticket.id}`});
            drop.connect('clicked', () => this._ticketAction(['drop', `${ticket.id}`]));
            item.add_child(drop);
            this._side.add_child(item);
        }
    }

    // Puts the side dropdown just right of the menu, level with its top.
    _placeSide() {
        if (!this._sidePanel?.visible) return;
        const frame = this._button.menu.actor.bin || this._button.menu.actor;
        const [x, y] = frame.get_transformed_position();
        const [width] = frame.get_transformed_size();
        const [holderX, holderY] = this._sideHolder.get_transformed_position();
        const gap = 8;
        // Never past the screen's right edge: then it overlaps the menu's right side instead.
        const monitor = Main.layoutManager.primaryMonitor;
        const sideWidth = this._sidePanel.get_preferred_width(-1)[1];
        const left = Math.min(x + width + gap, monitor.x + monitor.width - sideWidth - gap);
        this._sidePanel.set_position(Math.round(left - holderX), Math.round(y - holderY));
    }

    // The checklists column for one open chat's project, from the list button on its row; again on the same chat closes it.
    _openChecklists(row) {
        this._schedule = null;
        this._checklistView = this._checklistView?.key === row.key ? null
            : {key: row.key, title: row.title, provider: row.provider, folders: row.roots || [], older: false};
        this._renderRows();
        this._renderSide();
        if (!this._checklistView) return;
        // Written by the service when the checklists change; read only while this column shows them.
        Gio.File.new_for_path(`${ROOT}/checklists.json`).load_contents_async(this._cancel, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                this._checklistData = JSON.parse(ByteArray.toString(bytes));
                this._checklistError = null;
            } catch (error) {
                this._checklistData = null;
                this._checklistError = `Checklists unreadable: ${error.message}`;
            }
            if (this._enabled && this._checklistView) this._renderSide();
        });
    }

    _renderChecklists() {
        const view = this._checklistView;
        const add = (text, style, parent = this._side) => {
            const label = new St.Label({text, style_class: style});
            label.clutter_text.line_wrap = true;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            parent.add_child(label);
            return label;
        };
        add(`${view.folders.map(folder => folder.split('/').at(-1)).join(', ')} · for ${PROVIDERS[view.provider]?.[0] || '•'} ${view.title}`, 'tracker-detail');
        if (this._checklistError) add(this._checklistError, 'tracker-warning');
        if (!this._checklistData) {
            if (!this._checklistError) add('Reading…', 'tracker-detail');
            return;
        }
        const entries = view.folders.map(folder => [folder, this._checklistData.folders?.[folder]]).filter(([, entry]) => entry);
        const files = entries.flatMap(([folder, entry]) => entry.files.map(file => ({...file, folder})));
        const byPath = new Map(files.map(file => [file.path, file]));
        const titles = new Map((this._menuSnapshot?.rows || []).map(row => [row.key, `${PROVIDERS[row.provider]?.[0] || '•'} ${row.title}`]));
        if (!files.length) add('No checklists with open items or recent changes in tmp/agent/checklists here.', 'tracker-detail');
        for (const [name, list] of checklistSections(files, view.key)) {
            const older = name.startsWith('Older');
            add(older ? `${name} (${list.length})` : name, 'tracker-ticket-caption');
            // Older ones fold away, but their items that need the user stay in view.
            if (older && !view.older) {
                for (const file of list.filter(entry => entry.user.length))
                    for (const item of file.user) add(`Needs you (${file.title || file.name}): ${item}`, 'tracker-checklist-user');
                const more = new St.Button({label: `Show ${list.length} older`, can_focus: true, style_class: 'tracker-ticket-chip',
                    x_align: Clutter.ActorAlign.START});
                more.connect('clicked', () => {
                    view.older = true;
                    this._renderSide();
                });
                this._side.add_child(more);
                continue;
            }
            for (const file of list) {
                const card = new St.BoxLayout({vertical: true, style_class: 'tracker-checklist'});
                const top = new St.BoxLayout({style_class: 'tracker-side-heading'});
                const title = new St.Label({text: file.title || file.name, x_expand: true, style_class: 'tracker-side-ticket-body',
                    y_align: Clutter.ActorAlign.CENTER});
                title.clutter_text.line_wrap = true;
                title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                top.add_child(title);
                const open = new St.Button({label: 'Open', can_focus: true, style_class: 'tracker-control-action', y_align: Clutter.ActorAlign.START,
                    accessible_name: `Open ${file.name} in VS Code`});
                open.connect('clicked', () => this._openInCode(file.folder, file.path));
                top.add_child(open);
                card.add_child(top);
                add(`${file.name} · updated ${age(file.modified)}`, 'tracker-detail', card);
                const progress = checklistProgress(file);
                const bar = new St.Widget({style_class: 'tracker-progress tracker-checklist-progress'});
                const fill = new St.Widget({style_class: `tracker-progress-fill tracker-progress-${file.open ? 'working' : 'finished'}`});
                fill.set_width(Math.round(280 * progress.fraction));
                bar.add_child(fill);
                card.add_child(bar);
                add(progress.text, 'tracker-detail', card);
                if (file.next) add(`Suggested next: ${file.next}`, 'tracker-checklist-next', card);
                for (const item of file.user) add(`Needs you: ${item}`, 'tracker-checklist-user', card);
                for (const [kind, label] of [['waiting', 'Waiting'], ['deferred', 'Deferred']])
                    if (file[kind].length) add(`${label}: ${file[kind].slice(0, 3).join(' · ')}${file[kind].length > 3 ? ` · +${file[kind].length - 3}` : ''}`,
                        'tracker-detail', card);
                for (const link of file.links || []) {
                    const linked = byPath.get(link.path);
                    const button = new St.Button({can_focus: true, style_class: 'tracker-checklist-link', x_align: Clutter.ActorAlign.START,
                        label: `↳ ${link.path.split('/').at(-1)}${!link.exists ? ' (missing)' : linked ? ` · ${checklistProgress(linked).text}` : ''}`,
                        reactive: link.exists});
                    if (link.exists) button.connect('clicked', () => this._openInCode(file.folder, link.path));
                    card.add_child(button);
                }
                const editors = (file.editors || []).map(([key, at]) => `${titles.get(key) || (key === view.key ? 'this chat' : 'a closed chat')} ${age(at)}`);
                add(editors.length ? `Last edited by ${editors.slice(0, 3).join(', ')}` : 'Last edited by: not seen in an open chat', 'tracker-detail', card);
                this._side.add_child(card);
            }
        }
        const closed = entries.reduce((sum, [, entry]) => sum + entry.older_closed, 0);
        if (closed) add(`${closed} older checklist${closed === 1 ? '' : 's'} with no open items recorded`, 'tracker-detail');
    }

    // Opens a file in the VS Code window on its folder (`code` focuses that window, or opens one).
    _openInCode(folder, path) {
        const code = GLib.find_program_in_path('code');
        if (!code) {
            Main.notifyError('Agent Bar', 'The VS Code `code` command is not on PATH');
            return;
        }
        try {
            new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE}).spawnv([code, folder, path]);
            this._button.menu.close();
        } catch (error) {
            Main.notifyError('Agent Bar', error.message);
        }
    }

    // A multi-line text box editing draft[key]; a press anywhere in it, not only on its line of text, types there.
    _noteEntry(draft, key, hint) {
        const entry = new St.Entry({text: draft[key], hint_text: hint, can_focus: true, x_expand: true, accessible_name: hint,
            style_class: 'tracker-search tracker-ticket-entry'});
        entry.clutter_text.single_line_mode = false;
        entry.clutter_text.activatable = false;
        entry.clutter_text.line_wrap = true;
        entry.clutter_text.connect('text-changed', () => { draft[key] = entry.get_text(); });
        entry.connect('button-press-event', () => {
            global.stage.set_key_focus(entry.clutter_text);
            return Clutter.EVENT_PROPAGATE;
        });
        return entry;
    }

    // A rounded choice; onClick gets the button, already toggled.
    _chip(label, checked, name, onClick) {
        const button = new St.Button({label, can_focus: true, toggle_mode: true, checked, accessible_name: name, style_class: 'tracker-ticket-chip'});
        button.connect('clicked', () => onClick(button));
        return button;
    }

    // Chips on lines of at most `room` characters.
    _chipRows(chips, room) {
        const queue = [...chips];
        return chipLines(chips.map(chip => chip.label), room).map(line => {
            const row = new St.BoxLayout({style_class: 'tracker-ticket-chips'});
            for (const _ of line) row.add_child(queue.shift());
            return row;
        });
    }

    // Runs `agent-bar ticket …`, then redraws from a snapshot taken after it, with any error in the form.
    async _ticketAction(args, done = null, failed = null) {
        try {
            const asked = Date.now() / 1000;
            await this._run(['ticket', ...args]);
            this._ticketError = null;
            done?.();
            await this._snapshotAfter(asked);
        } catch (error) {
            if (failed) failed(error.message);
            else this._ticketError = error.message;
        }
        if (this._enabled && this._button.menu.isOpen && !this._page) {
            this._menuSnapshot = this._snapshot;
            this._buildMenu();
        }
    }

    // Reads snapshots until one taken after `since` (seconds) arrives, for at most `seconds`.
    async _snapshotAfter(since, seconds = 5) {
        for (let i = 0; i < seconds * 5 && this._enabled && !(this._snapshot?.updated > since); i++) {
            this._read();
            await this._delay(200);
        }
    }

    async _clearQueues(project) {
        try {
            const asked = Date.now() / 1000;
            await this._run(['clear-queues', project]);
            // The service writes a snapshot with the change before it answers.
            await this._snapshotAfter(asked);
            if (this._enabled && this._button.menu.isOpen) {
                this._menuSnapshot = this._snapshot;
                this._buildMenu();
            }
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
        }
    }

    async _resetLimit(pair) {
        try {
            await this._run(['reset-limit', ...pair]);
            // The service's next snapshot drops the hold.
            await this._snapshotAfter(Date.now() / 1000);
            if (this._enabled && this._button.menu.isOpen) {
                this._menuSnapshot = this._snapshot;
                this._buildMenu();
            }
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
        }
    }

    // Each provider's usage limits as it records them here: what is left and when it resets, the recent pace and when
    // that pace would use the rest, and a weekly limit's use by day.
    _renderQuota(snapshot) {
        const usage = snapshot.usage || {};
        if (snapshot.usage_error) this._section.addMenuItem(this._item(`Usage limits unreadable: ${snapshot.usage_error}`, 'tracker-warning'));
        const providers = Object.keys(PROVIDERS).filter(provider => usage[provider]?.limits?.length);
        if (!providers.length) {
            this._section.addMenuItem(this._item('Neither Claude Code nor Codex has recorded its limits on this computer yet', 'tracker-empty'));
            return;
        }
        const now = Date.now() / 1000;
        const order = limit => limit.key === 'weekly' ? 0 : limit.key.startsWith('weekly:') ? 1 : limit.key === 'session' ? 2 : 3;
        for (const provider of providers) {
            const value = usage[provider];
            const weekly = quotaLeft(usage, provider, now);
            const body = this._projectSection(`quota:${provider}`, PROVIDERS[provider][1], `reading ${age(value.as_of)}`,
                weekly ? `${Math.floor(weekly.left)}% of the week left` : '', !!weekly && weekly.left < 25);
            if (value.fetch?.error) {
                const next = value.fetch.next ? `; trying again in ${duration(Math.max(60, Math.round(value.fetch.next - now)))}` : '';
                body.addMenuItem(this._quotaNote(`Agent Bar's last read of Claude's limits failed: ${value.fetch.error}${next}.`,
                    'tracker-detail tracker-attention'));
            } else if (now - value.as_of > QUOTA_STALE) {
                body.addMenuItem(this._quotaNote(provider === 'claude'
                    ? 'Claude Code updates these figures only when it fetches them, as /usage does. Settings › Integrations › '
                        + 'Read Claude limits has Agent Bar read them every 10 minutes.'
                    : 'Codex records these as it works; they update with its next turn.', 'tracker-detail tracker-attention'));
            }
            for (const limit of [...value.limits].sort((a, b) => order(a) - order(b))) body.addMenuItem(this._quotaLimit(limit, value.as_of, now));
        }
    }

    _quotaNote(text, style = 'tracker-detail') {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item._ornamentLabel?.hide();
        item.add_style_class_name('tracker-quota-note');
        const label = new St.Label({text, x_expand: true, style_class: `${style} tracker-quota-wrap`});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.line_wrap = true;
        item.add_child(label);
        return item;
    }

    // One limit: its bar of what is used, what is left and when it resets, what its pace implies, a scoped model's share
    // of the weekly limit, and for a weekly limit its use by day.
    _quotaLimit(limit, asOf, now) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item._ornamentLabel?.hide();
        item.add_style_class_name('tracker-queue-row');
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-quota-limit'});
        item.add_child(box);
        const label = (text, style, wrap = false) => {
            const result = new St.Label({text, style_class: wrap ? `${style} tracker-quota-wrap` : style, y_align: Clutter.ActorAlign.CENTER});
            result.clutter_text.ellipsize = wrap ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
            result.clutter_text.line_wrap = wrap;
            return result;
        };
        const style = limit.expired ? 'muted' : quotaStyle(limit.left);
        const head = new St.BoxLayout({style_class: 'tracker-row-title'});
        head.add_child(label(limit.name, 'tracker-title'));
        if (limit.limiting && !limit.expired) head.add_child(label('Limiting now', 'tracker-chip tracker-chip-failed'));
        head.add_child(new St.Widget({x_expand: true}));
        head.add_child(label(limit.expired ? 'reset since this reading' : `${Math.round(limit.percent)}% used · ${Math.floor(limit.left)}% left`,
            `tracker-quota-figure tracker-quota-${style}`));
        box.add_child(head);
        const line = new St.BoxLayout({style_class: 'tracker-progress-line'});
        const track = new St.Widget({style_class: 'tracker-progress tracker-quota-track', y_align: Clutter.ActorAlign.CENTER});
        const fill = new St.Widget({style_class: `tracker-progress-fill tracker-progress-${{failed: 'failed', attention: 'attention'}[style] || 'working'}`});
        fill.set_width(Math.round(300 * Math.min(100, Math.max(0, limit.expired ? 0 : limit.percent)) / 100));
        track.add_child(fill);
        line.add_child(track);
        const resets = limit.resets_at;
        line.add_child(label(!resets ? '' : limit.expired ? `reset ${new Date(resets * 1000).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'})}; no reading since`
            : `${resetTime(resets)}, in ${duration(Math.round(resets - now))}`, 'tracker-detail'));
        box.add_child(line);
        const projection = quotaProjection(limit, asOf, now);
        if (projection) box.add_child(label(projection, 'tracker-detail', true));
        if (limit.share) {
            const model = limit.name.split(' · ').pop();
            box.add_child(label(`${model} has ${limit.share.allowance ?? '?'}% of the weekly limit to itself and has used ${Math.round(limit.share.used)} points of it.`,
                'tracker-detail', true));
        }
        if (limit.days?.length) {
            if (limit.readings < 3) {
                box.add_child(label(`Use by day shows once there are more readings this week (${limit.readings} so far).`, 'tracker-muted tracker-quota-small', true));
            } else {
                const width = 420, height = 64;
                const chart = this._drawing((cr, w, h) => paintDays(cr, w, h, limit.days),
                    {width, height, style_class: 'tracker-quota-chart', x_align: Clutter.ActorAlign.START});
                this._tooltip(chart, limit.days.map(day => `${day.day}: ${day.used.toFixed(1)} points`
                    + (day.parts.length > 1 ? ` (${day.parts.map(([name, v]) => `${name} ${v.toFixed(1)}`).join(', ')})` : '')).join('\n'));
                box.add_child(chart);
                const names = new St.BoxLayout({style_class: 'tracker-quota-days', x_align: Clutter.ActorAlign.START});
                for (const day of limit.days) names.add_child(new St.Label({text: day.day, style_class: 'tracker-quota-day',
                    style: `width: ${Math.floor(width / limit.days.length)}px;`}));
                box.add_child(names);
                const parts = limit.days[0].parts.map(([name]) => name);
                const legend = new St.BoxLayout({style_class: 'tracker-quota-legend'});
                legend.add_child(label('Points of the weekly limit used each day', 'tracker-muted tracker-quota-small'));
                if (parts.length > 1) parts.forEach((name, index) => {
                    const [r, g, b] = QUOTA_COLORS[index === 0 ? 0 : 1].map(c => Math.round(c * 255));
                    legend.add_child(new St.Label({text: '■', style: `color: rgb(${r}, ${g}, ${b});`, y_align: Clutter.ActorAlign.CENTER}));
                    legend.add_child(label(name, 'tracker-quota-small'));
                });
                box.add_child(legend);
            }
        }
        return item;
    }

    // Usage limits, skills, tracker health and instruction files, from `agent-bar info`, read when this tab
    // opens and again once 30 s old.
    _renderInfo(snapshot, query) {
        const sameProject = this._infoFor === this._infoProject;
        if (!sameProject || Date.now() - this._infoAt > 30000) this._loadInfo();
        const info = sameProject ? this._info : null;
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
        /** @param {(() => void) | null} [fill] */
        const group = (section, key, text, fill = null) => {
            const head = new St.BoxLayout({x_expand: true, style_class: 'tracker-info-skill'});
            const arrow = label(this._openSkills.has(key) ? '⌄' : '›', 'tracker-muted');
            head.add_child(arrow);
            head.add_child(label(text, 'tracker-detail', true));
            const toggle = new St.Button({child: head, x_expand: true, can_focus: true, accessible_name: text, style_class: 'tracker-message-button'});
            line(section, [toggle]);
            const rows = [];
            const apply = () => {
                const open = this._openSkills.has(key);
                arrow.text = open ? '⌄' : '›';
                if (open && fill) { fill(); fill = null; }
                for (const row of rows) row.visible = open;
            };
            toggle.connect('clicked', () => {
                if (this._openSkills.has(key)) this._openSkills.delete(key);
                else this._openSkills.add(key);
                apply();
            });
            apply();
            return row => { row.visible = this._openSkills.has(key); rows.push(row); };
        };

        /** @type {{items: {provider: 'claude'|'codex', scope: string, name: string, path: string,
         * status: string, type: string, description: string, action: string, mode: string, timeout: number|null,
         * triggers: {event: string, matcher: string, condition: string}[]}[], warnings: string[]}} */
        const inventory = info.hook_inventory;
        if (inventory) {
            const section = card('Hooks');
            const shown = inventory.items.filter(h => [h.name, h.provider, h.scope, h.status, h.type, h.path, h.description, h.action, h.mode,
                ...h.triggers.flatMap(t => [t.event, t.matcher, t.condition])].some(value => value.toLowerCase().includes(query)));
            if (!shown.length) line(section, [label(query ? 'No matching hooks' : 'No hooks found for this project')]);
            for (const hook of shown) {
                const key = JSON.stringify(['hook', this._infoProject, hook.provider, hook.path, hook.name, hook.status, inventory.items.indexOf(hook)]);
                const detail = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tracker-info-detail'});
                /** @param {string} caption @param {string} value */
                const field = (caption, value) => {
                    if (!value) return;
                    const row = new St.BoxLayout({x_expand: true, style_class: 'tracker-info-skill'});
                    row.add_child(new St.Label({text: caption, style_class: 'tracker-hook-caption tracker-detail', y_align: Clutter.ActorAlign.START}));
                    const content = label(value, 'tracker-help-text', true);
                    content.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                    content.clutter_text.line_wrap = true;
                    content.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                    row.add_child(content);
                    detail.add_child(row);
                };
                const toggle = group(section, key, `${PROVIDERS[hook.provider][1]} · ${hook.name} · ${hook.status}`, () => {
                    const events = hook.triggers.filter(t => (!t.matcher || t.matcher === '*') && !t.condition).map(t => t.event);
                    const when = hook.triggers.filter(t => (t.matcher && t.matcher !== '*') || t.condition)
                        .map(t => [t.event, t.matcher && t.matcher !== '*' ? `matches ${t.matcher}` : '', t.condition && `if ${t.condition}`].filter(Boolean).join(' · '));
                    field('When', [events.join(', '), ...when].filter(Boolean).join('\n'));
                    field('Action', hook.action);
                    field('Effect', hook.description);
                    field('Execution', [hook.mode, hook.timeout != null && `timeout set to ${hook.timeout}s`].filter(Boolean).join(' · '));
                    field('Source', `${hook.scope} · ${hook.path.replace(GLib.get_home_dir(), '~')}`);
                });
                toggle(line(section, [detail]));
            }
            for (const warning of inventory.warnings) line(section, [label(warning, 'tracker-warning', true)]);
        }

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
        const project = this._infoProject;
        try {
            this._info = await this._run(project ? ['info', '--project', project] : ['info']);
            this._infoError = null;
            this._infoAt = Date.now();
        } catch (error) {
            this._info = null;
            this._infoError = `Info unavailable: ${error.message}`;
            this._infoAt = Date.now();
        } finally { this._infoLoading = false; this._infoFor = project; }
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
    // Tells the service the Git tab is open, so it reads git status every 20 s, not every 5 minutes; at most every 10 s.
    _watchGit() {
        if (Date.now() - (this._gitWatchedAt || 0) < 10000) return;
        this._gitWatchedAt = Date.now();
        try { GLib.file_set_contents(`${ROOT}/git-watched`, ''); } catch (error) { log(`agent-bar: ${error.message}`); }
    }

    _renderGit(snapshot, query) {
        this._watchGit();
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

    /** @param {string} input @returns {HistoryLookup} */
    _chatSearch(input) {
        const scope = /^repo:(?:"([^"]+)"|(\S+))(?:\s+|$)/.exec(input.trim());
        const repo = scope ? (scope[1] || scope[2]).replace(/\/+$/, '') || '/' : '';
        const query = input.trim().slice(scope?.[0].length || 0).trim();
        const updated = this._inventory?.updated;
        const previous = this._historyLookup;
        if (previous && previous.query === query && previous.repo === repo && previous.updated === updated) return previous;
        if (previous?.timer) GLib.source_remove(previous.timer);
        /** @type {HistoryLookup} */
        const lookup = {query, repo, updated, hits: new Map(), details: new Map(), loading: !!query, timer: 0, error: ''};
        this._historyLookup = lookup;
        if (query) lookup.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            lookup.timer = 0;
            this._run(['search-history', ...(repo ? ['--repo', repo] : []), '--', query]).then(data => {
                for (const hit of data.results) lookup.hits.set(hit.key, hit);
            }).catch(error => { lookup.error = error.message; }).finally(() => {
                lookup.loading = false;
                if (this._enabled && this._historyLookup === lookup && this._button.menu.isOpen &&
                    this._isChatList() && !this._page) this._renderRows();
            });
            return GLib.SOURCE_REMOVE;
        });
        return lookup;
    }

    _renderHistory(snapshot, query) {
        if (!this._inventory) {
            this._section.addMenuItem(this._item(this._inventoryError || 'Loading saved conversations…',
                this._inventoryError ? 'tracker-warning' : 'tracker-empty'));
            return;
        }
        const lookup = this._chatSearch(query);
        const words = lookup.query;
        const open = new Map(snapshot.rows.filter(row => row.target).map(row => [row.key, row]));
        const matches = this._inventory.conversations.filter(row => (this._historyFilter === 'all' || row.provider === this._historyFilter)
            && matchesChatSearch(row, lookup));
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
                body => { for (const row of items) this._historyItem(row, open.get(row.key), snapshot, body,
                    lookup, words); }, null, words);
        }
        if (matches.length > rows.length)
            this._section.addMenuItem(this._item(`${matches.length - rows.length} more matches · refine the search`, 'tracker-empty'));
        this._chatSearchFeedback(lookup, rows.length, 'No matching saved conversations');
    }

    /** @param {HistoryLookup} lookup @param {number} count @param {string} empty */
    _chatSearchFeedback(lookup, count, empty) {
        if (lookup.error) this._section.addMenuItem(this._item(lookup.error, 'tracker-warning'));
        else if (lookup.loading) this._section.addMenuItem(this._item('Searching messages…', 'tracker-empty'));
        else if (!count) this._section.addMenuItem(this._item(empty, 'tracker-empty'));
    }

    /** @param {HistoryLookup} lookup
     * @param {string} words */
    _historyItem(row, live, snapshot, section, lookup, words) {
        const hit = lookup.hits.get(row.key);
        const activate = live ? () => this._activate(live, snapshot) : row.available ? () => this._resume(row) : null;
        const {box, actions} = this._chatRow(row, section, activate, words);
        let description = historyDetail(row);
        if (words && !hit && !lookup.loading && !lookup.error) {
            const field = row.title.toLowerCase().includes(words) ? 'Title'
                : row.folder.toLowerCase().includes(words) ? 'Folder' : 'Provider';
            description = `${field} match · ${description}`;
        }
        const detail = new St.Label({text: description, style_class: 'tracker-detail'});
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(detail);
        if (hit) this._historyExcerpt(box, actions, row.key, lookup);
        if (activate) {
            const caption = live ? 'Open' : 'Resume';
            const button = new St.Button({label: caption, can_focus: true, accessible_name: `${caption} conversation`,
                style_class: 'tracker-copy tracker-row-action tracker-open-slot'});
            button.connect('clicked', activate);
            actions.add_child(button);
        } else {
            actions.add_child(new St.Label({text: 'Folder missing', style_class: 'tracker-chip tracker-chip-failed'}));
        }
    }

    /** @param {any} box @param {any} actions @param {string} key @param {HistoryLookup} lookup */
    _historyExcerpt(box, actions, key, lookup) {
        const hit = lookup.hits.get(key);
        if (!hit) return;
        const detail = lookup.details.get(key);
        const context = detail?.context;
        /** @param {string} role @param {string[]} parts @param {boolean} muted */
        const passage = (role, parts, muted) => {
            const author = role === 'user' ? 'You' : 'Agent';
            const text = [`${author} · ${parts[0]}`, ...parts.slice(1)];
            const label = new St.Label({text: text.join(''), style_class: muted ? 'tracker-detail tracker-muted' : 'tracker-detail'});
            if (parts.length > 1) highlightHistoryParts(label, text);
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            box.add_child(label);
        };
        if (!context) passage(hit.role, hit.parts ?? [hit.excerpt], false);

        const toggle = new St.Button({label: detail ? 'Hide context' : 'Show context', can_focus: true,
            accessible_name: detail ? 'Hide context' : 'Show context and browse matching snippets',
            style_class: 'tracker-copy tracker-row-action tracker-context-slot'});
        toggle.connect('clicked', () => {
            if (detail) {
                lookup.details.delete(key);
                this._renderRows();
            } else this._loadHistoryContext(lookup, key);
        });
        actions.insert_child_below(toggle, actions.get_last_child());
        if (!detail) return;
        const controls = new St.BoxLayout({style_class: 'tracker-row-heading', x_align: Clutter.ActorAlign.END});
        /** @param {string} caption @param {string} name @param {Function} action */
        const button = (caption, name, action, enabled = true) => {
            const actor = new St.Button({label: caption, accessible_name: name, reactive: enabled, can_focus: enabled,
                opacity: enabled ? 255 : 90, style_class: 'tracker-ticket-chip'});
            actor.connect('clicked', action);
            controls.add_child(actor);
        };
        if (context) {
            const {message, messages, hit: n, hits} = context;
            const multiple = messages > 1 || hits > 1;
            if (multiple) button('‹', 'Previous hit', () => this._loadHistoryContext(lookup, key,
                n > 1 ? message : message - 1, n > 1 ? n - 1 : -1), !detail?.loading && (n > 1 || message > 1));
            controls.add_child(new St.Label({text: `Message ${message} of ${messages} · Hit ${n} of ${hits}`,
                style_class: 'tracker-detail', y_align: Clutter.ActorAlign.CENTER}));
            if (multiple) button('›', 'Next hit', () => this._loadHistoryContext(lookup, key,
                n < hits ? message : message + 1, n < hits ? n + 1 : 1), !detail?.loading && (n < hits || message < messages));
        }
        if (detail?.loading) controls.add_child(new St.Label({text: 'Loading…', style_class: 'tracker-detail'}));
        if (context || detail?.loading) box.add_child(controls);
        if (context) {
            if (context.before) passage(context.before.role, [context.before.text], true);
            passage(context.role, context.parts, false);
            if (context.after) passage(context.after.role, [context.after.text], true);
        }
        if (detail?.error) box.add_child(new St.Label({text: detail.error, style_class: 'tracker-warning'}));
    }

    /** @param {HistoryLookup} lookup @param {string} key @param {number} message @param {number | null} occurrence */
    async _loadHistoryContext(lookup, key, message = 1, occurrence = null) {
        const state = {context: lookup.details.get(key)?.context, loading: true, error: ''};
        lookup.details.set(key, state);
        this._renderRows();
        try {
            const args = ['search-history', '--conversation', key, '--message', String(message)];
            if (occurrence !== null) args.push('--hit', String(occurrence));
            if (lookup.repo) args.push('--repo', lookup.repo);
            const data = await this._run([...args, '--', lookup.query]);
            state.context = data.context;
        } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
        state.loading = false;
        if (this._enabled && this._historyLookup === lookup && lookup.details.get(key) === state &&
            this._button.menu.isOpen && this._isChatList() && !this._page) this._renderRows();
    }

    _isChatList() {
        return this._view === 'history' || this._view === 'conversations';
    }

    _needsInventory() {
        return this._view === 'history' || (this._view === 'conversations' &&
            (this._setting('projectOrder') === 'total' || !!this._chatQuery.trim()));
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
            if (this._button.menu.isOpen && this._needsInventory() && !this._page) this._renderRows();
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

    _providerLabel(name, search = '') {
        const provider = new St.BoxLayout({style_class: 'tracker-row-provider', y_align: Clutter.ActorAlign.CENTER});
        provider.add_child(new St.Label({text: PROVIDERS[name]?.[0] || '•',
            style_class: `tracker-provider-symbol tracker-${name}`, y_align: Clutter.ActorAlign.CENTER}));
        const label = new St.Label({text: PROVIDERS[name]?.[1] || name,
            style_class: `tracker-provider-name tracker-${name}`, y_align: Clutter.ActorAlign.CENTER});
        highlightHistoryText(label, search);
        provider.add_child(label);
        return provider;
    }

    // Explicit window placement; a control whose result already holds changes nothing.
    _windowControls(id, snapshot) {
        const box = new St.BoxLayout({style_class: 'tracker-window-controls', y_align: Clutter.ActorAlign.CENTER});
        for (const [icon, mode, name] of [
            ['window-restore-symbolic', 'return', 'Return the window to its previous place'],
            ['window-maximize-symbolic', 'place', 'Maximize the window on the main display']]) {
            const button = new St.Button({child: new St.Icon({icon_name: icon, icon_size: 16}),
                can_focus: true, accessible_name: name, style_class: 'tracker-window-control'});
            this._tooltip(button, name);
            button.connect('clicked', () => this._activate({window: id, key: null}, snapshot, mode));
            box.add_child(button);
        }
        return box;
    }

    /** @param {any} row @param {any} section @param {Function | null} activate @param {string} search */
    _chatRow(row, section, activate, search, schedule = false) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: !!activate, can_focus: !!activate});
        item._ornamentLabel?.hide();
        item.add_style_class_name('tracker-conversation');
        item.add_child(this._providerLabel(row.provider, search));
        const box = new St.BoxLayout({vertical: true, style_class: 'tracker-row', x_expand: true});
        const heading = new St.BoxLayout({style_class: 'tracker-row-heading'});
        const title = new St.Label({text: row.title, style_class: 'tracker-title tracker-title-full', x_expand: true,
            y_align: Clutter.ActorAlign.START});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        title.clutter_text.line_wrap = true;
        title.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        highlightHistoryText(title, search);
        heading.add_child(title);
        const actions = new St.BoxLayout({style_class: 'tracker-row-actions', y_align: Clutter.ActorAlign.START});
        heading.add_child(actions);
        box.add_child(heading);
        item.add_child(box);
        if (activate) item.connect('activate', activate);
        section.addMenuItem(item);
        const lists = schedule ? (row.roots || []).map(root => this._menuSnapshot?.checklists?.[root]).filter(Boolean) : [];
        if (lists.length) {
            const total = key => lists.reduce((sum, counts) => sum + counts[key], 0);
            const files = total('files'), open = total('open'), user = total('user');
            const name = `${files} checklist${files === 1 ? '' : 's'} in this project · ${open} open item${open === 1 ? '' : 's'}`
                + (user ? ` · ${user} need${user === 1 ? 's' : ''} you` : '');
            const content = new St.BoxLayout({style_class: 'tracker-copy-content'});
            content.add_child(new St.Icon({icon_name: 'view-list-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
            if (user) content.add_child(new St.Label({text: `${user}`, style_class: 'tracker-attention', y_align: Clutter.ActorAlign.CENTER}));
            const button = new St.Button({child: content, can_focus: true, accessible_name: name, toggle_mode: true,
                checked: this._checklistView?.key === row.key, style_class: 'tracker-copy tracker-copy-compact tracker-schedule-button',
                y_align: Clutter.ActorAlign.CENTER});
            this._tooltip(button, name);
            button.connect('clicked', () => this._openChecklists(row));
            actions.add_child(button);
        }
        if (schedule && ['claude', 'codex'].includes(row.provider) && this._setting('messages')) {
            const count = scheduledFor(this._menuSnapshot?.tickets, row.key).length;
            const name = count ? `${count} message${count === 1 ? '' : 's'} scheduled; schedule another` : 'Schedule a message to this chat';
            const content = new St.BoxLayout({style_class: 'tracker-copy-content'});
            content.add_child(new St.Icon({icon_name: 'alarm-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
            if (count) content.add_child(new St.Label({text: `${count}`, y_align: Clutter.ActorAlign.CENTER}));
            const button = new St.Button({child: content, can_focus: true, accessible_name: name, toggle_mode: true,
                checked: this._schedule?.key === row.key, style_class: 'tracker-copy tracker-copy-compact tracker-schedule-button',
                y_align: Clutter.ActorAlign.CENTER});
            this._tooltip(button, name);
            button.connect('clicked', () => this._openSchedule(row));
            actions.add_child(button);
        }
        actions.add_child(this._copyButton(() => chatIdentity(row), 'Copy the chat\'s name, id and folder', true));
        return {item, box, actions};
    }

    /** @param {HistoryLookup} lookup */
    _conversationItem(row, snapshot, section, lookup) {
        const {item, box, actions} = this._chatRow(row, section, row.target ? () => this._activate(row, snapshot) : null, lookup.query, true);
        if (row.unread.length) item.add_style_class_name('tracker-unread');
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
        if (lookup.hits.has(row.key)) this._historyExcerpt(box, actions, row.key, lookup);
        actions.add_child(new St.Label({text: row.unread.length ? 'Needs review' : state,
            style_class: `tracker-chip tracker-chat-state tracker-chip-${row.unread.length ? 'attention' : stateStyle(row.state)}`,
            y_align: Clutter.ActorAlign.CENTER}));
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
    // input: also put the cursor in a Claude chat's input box when that can be done surely, saying so as `input`.
    async _activate(row, snapshot, mode = 'toggle', input = false) {
        if (this._busy || this._error) return {ok: false, error: this._error || 'Navigation already in progress'};
        this._busy = true;
        const focused = this._button.menu.isOpen ? this._menuFocus : global.display.focus_window;
        const returnOnly = mode === 'return';
        this._button.menu.close();
        this._nav?.menu.close();
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
            const shown = await this._run(['navigate', row.key, row.window, ...input ? ['--input'] : []]);
            this._borrowed.get(id).key = row.key;
            await this._run(['save-return', id, JSON.stringify(this._borrowed.get(id))]);
            // The captured cutoff ensures a newer completion remains unread.
            await this._run(['ack', row.key, String(snapshot.cutoff)]);
            this._read();
            return {ok: true, action: 'focused', input: !!shown.input};
        } catch (error) {
            if (this._enabled) Main.notifyError('Agent Bar', error.message);
            return {ok: false, error: error.message};
        } finally { this._busy = false; }
    }

    disable() {
        this._enabled = false;
        if (this._historyLookup?.timer) GLib.source_remove(this._historyLookup.timer);
        this._historyLookup = null;
        const focus = global.stage.get_key_focus();
        if (focus && [Main.panel, this._button.menu.actor, this._nav.menu.actor]
            .some(actor => actor.contains(focus))) global.stage.set_key_focus(null);
        this._cancel.cancel();
        if (this._timer) GLib.source_remove(this._timer);
        this._menuSwitch.restore();
        this._dbus?.unexport();
        this._stopWatchingNew();
        this._releaseAppMenu();
        this._quickMenu.destroy();
        this._quickRight.destroy();
        this._quick.destroy();
        this._nav.destroy();
        this._clusterButton.destroy();
        this._button.destroy();
        this._button = null;
        this._keyboard = null;
    }
}

// Rereads the installed extension.js and stylesheet into the running GNOME Shell 42, which otherwise keeps an
// extension's first code until the next login. Code that fails to load or enable leaves the running one in place.
function reloadInstalled() {
    const extension = Main.extensionManager.lookup(UUID);
    const old = extension.stateObj;
    let fresh;
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([extension.path, 'extension.js']));
        fresh = new Function(`${ByteArray.toString(bytes)}\nreturn init();`)();
    } catch (error) {
        logError(error, 'Agent Bar: the installed code did not load; keeping the running one');
        return;
    }
    old.disable();
    try {
        extension.stateObj = fresh;
        fresh.enable();
    } catch (error) {
        logError(error, 'Agent Bar: the installed code did not start; restoring the running one');
        try { fresh.disable(); } catch (_) {}
        extension.stateObj = old;
        old.enable();
        return;
    }
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    if (extension.stylesheet) theme.unload_stylesheet(extension.stylesheet);
    extension.stylesheet = Gio.File.new_for_path(GLib.build_filenamev([extension.path, 'stylesheet.css']));
    theme.load_stylesheet(extension.stylesheet);
}

function init() { return new Tracker(); }
