const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

function fixture() {
    const calls = [], errors = [];
    const win = {
        monitor: 1, workspace: 0, maximized_horizontally: false, maximized_vertically: false,
        get_description: () => '0x123 Code', get_wm_class: () => 'code_code',
        get_title: () => 'Chat - project - Visual Studio Code',
        get_monitor() { return this.monitor; },
        get_workspace() { return {index: () => this.workspace}; },
        get_frame_rect: () => ({x: 1300, y: 100, width: 800, height: 600}),
        get_maximized: () => 0, is_fullscreen: () => false,
        move_to_monitor(m) { calls.push(['move', m]); this.monitor = m; },
        maximize() { this.maximized_horizontally = this.maximized_vertically = true; },
        unmaximize() { this.maximized_horizontally = this.maximized_vertically = false; },
        change_workspace() { this.workspace = 0; },
        change_workspace_by_index(i) { this.workspace = i; },
        get_work_area_for_monitor: m => ({x: m * 1280, y: 0, width: 1280, height: 800}),
        move_resize_frame(...args) { calls.push(['restore', ...args]); this.monitor = args[1] >= 1280 ? 1 : 0; },
    };
    const ctx = vm.createContext({
        imports: {
            gi: {GLib: {get_home_dir: () => '/home/test', build_filenamev: a => a.join('/'), find_program_in_path: () => null},
                Meta: {MaximizeFlags: {BOTH: 3}}},
            ui: {main: {layoutManager: {primaryIndex: 0,
                monitors: [{x: 0, y: 0, width: 1280, height: 800}, {x: 1280, y: 0, width: 1280, height: 800}]},
                activateWindow: () => calls.push(['focus']), notifyError: (_title, error) => errors.push(error)},
                panelMenu: {}, popupMenu: {}, checkBox: {},
                messageTray: {Notification: class {
                    constructor(_source, title, body) { Object.assign(this, {title, body, actions: []}); }
                    addAction(label) { this.actions.push(label); }
                    connect() {}
                }}},
            byteArray: {toString: value => value},
        },
        logError: () => {},
        global: {get_window_actors: () => [{meta_window: win}], display: {focus_window: null},
            workspace_manager: {get_active_workspace: () => ({}), get_active_workspace_index: () => 0}},
    });
    vm.runInContext(fs.readFileSync('agent_bar/data/gnome-extension/extension.js', 'utf8'), ctx);
    const tracker = vm.runInContext('init()', ctx);
    const window = {id: 'window-a', workspace: 'project', nativeId: '0x123'};
    const snapshot = {windows: [window], cutoff: 200};
    Object.assign(tracker, {_enabled: true, _borrowed: new Map(), _snapshot: snapshot,
        _button: {menu: {close() {}}}, _delay: async () => {}, _read() {},
        _run: async args => { calls.push(Array.from(args)); return {ok: true}; }});
    return {tracker, win, calls, errors, snapshot, context: ctx, row: {key: 'codex:one', window: window.id}};
}

test('bring selects the exact chat and acknowledges only after success; second click returns', async () => {
    const f = fixture();
    await f.tracker._activate(f.row, f.snapshot);
    assert.equal(f.win.monitor, 0);
    assert.deepEqual(f.calls.filter(c => c[0] === 'navigate'), [['navigate', 'codex:one', 'window-a']]);
    assert.deepEqual(f.calls.find(c => c[0] === 'ack'), ['ack', 'codex:one', '200']);
    f.calls.length = 0;
    f.context.global.display.focus_window = f.win;
    await f.tracker._activate(f.row, f.snapshot);
    assert.equal(f.win.monitor, 1);
    assert.equal(f.calls.some(c => ['ack', 'navigate'].includes(c[0])), false);
    assert.equal(f.errors.length, 0);
});

test('a borrowed window without focus comes forward instead of returning', async () => {
    const f = fixture();
    await f.tracker._activate(f.row, f.snapshot);
    f.calls.length = 0;
    await f.tracker._activate(f.row, f.snapshot);
    assert.equal(f.win.monitor, 0);
    assert.deepEqual(f.calls.map(c => c[0]), ['focus', 'navigate', 'save-return', 'ack']);
    f.context.global.display.focus_window = f.win;
    await f.tracker._activate(f.row, f.snapshot, 'focus');
    assert.equal(f.win.monitor, 0);
    assert.equal(f.errors.length, 0);
});

test('window controls place without selecting a chat; placing a placed window only raises it', async () => {
    const f = fixture();
    const win = {window: 'window-a', key: null};
    await f.tracker._activate(win, f.snapshot, 'return');
    assert.equal(f.calls.length, 0);
    await f.tracker._activate(win, f.snapshot, 'place');
    assert.equal(f.win.monitor, 0);
    assert.equal(f.tracker._borrowed.get('window-a').monitor, 1);
    assert.equal(f.calls.some(c => ['navigate', 'ack'].includes(c[0])), false);
    f.calls.length = 0;
    await f.tracker._activate(win, f.snapshot, 'place');
    assert.deepEqual(f.calls, [['focus']]);
    await f.tracker._activate(win, f.snapshot, 'return');
    assert.equal(f.win.monitor, 1);
    assert.equal(f.tracker._borrowed.size, 0);
    assert.equal(f.errors.length, 0);
});

test('top-bar shortcuts list distinct conversations awaiting review, oldest first', () => {
    const f = fixture();
    const rows = [{key: 'b', target: {}, unread: ['Reply finished'], completed_at: 20},
        {key: 'a', target: {}, unread: ['Input needed'], completed_at: 10},
        {key: 'b', target: {}, unread: ['Reply finished'], completed_at: 20},
        {key: 'c', target: {}, unread: [], completed_at: 30},
        {key: 'd', target: null, unread: ['Reply finished'], completed_at: 5}];
    assert.equal(f.context.readyConversations(rows).map(r => r.key).join(','), 'a,b');
    // Only the reasons picked in settings give a shortcut.
    assert.equal(f.context.readyConversations(rows, ['Input needed']).map(r => r.key).join(','), 'a');
    assert.equal(f.context.readyConversations(rows, []).length, 0);
    // A question that came after an older reply waits since it asked, not since that reply; only the reasons that
    // give shortcuts count.
    rows[1].unread_at = {'Input needed': 25, 'Queues finished': 1};
    assert.equal(f.context.readyConversations(rows, ['Reply finished', 'Input needed']).map(r => r.key).join(','), 'b,a');
    assert.equal(f.context.readyConversations(rows).map(r => r.key).join(','), 'a,b');
});

test('a clicked shortcut stays away until a snapshot after its acknowledgment, or returns if that failed', async () => {
    const f = fixture();
    const row = {key: 'k', window: 'w', target: {}, unread: ['Reply finished'], project: 'p'};
    const shown = [];
    f.tracker._setting = key => ({quickReasons: null, quickLimit: 6, quickChars: 16})[key];
    f.tracker._buildQuick = (signature, groups) => {
        f.tracker._quickSignature = signature;
        shown.push(groups.flat().map(r => r.key).join(','));
    };
    f.tracker._fitQuick = () => {};
    f.tracker._quickPending = new Map();
    let finish;
    f.tracker._activate = () => new Promise(resolve => { finish = resolve; });
    f.tracker._snapshot = {updated: 100, rows: [row]};
    f.tracker._openShortcut(row);
    f.tracker._renderQuick([row]);  // A read while it is brought forward.
    finish({ok: true});
    await new Promise(resolve => setImmediate(resolve));
    f.tracker._renderQuick([row]);  // The snapshot written with the acknowledgment predates the answer.
    f.tracker._snapshot = {updated: Date.now() / 1000 + 1, rows: [row]};
    f.tracker._renderQuick([row]);  // Still unread after that: a new reason, so it shows again.
    assert.deepEqual(shown, ['', 'k']);
    f.tracker._activate = async () => ({ok: false});
    f.tracker._openShortcut(row);
    await new Promise(resolve => setImmediate(resolve));
    f.tracker._quickSignature = null;
    f.tracker._renderQuick([row]);
    assert.equal(shown.at(-1), 'k');
});

test('continue lists open VS Code chats a usage limit stopped, Codex first, and asks for the input box only then', async () => {
    const f = fixture();
    const limited = {at: 1, resets: null};
    const rows = [{key: 'claude:a', provider: 'claude', target: {kind: 'tab'}, limited},
        {key: 'codex:b', provider: 'codex', target: {kind: 'codex-sidebar'}, limited},
        {key: 'codex:e', provider: 'codex', target: {kind: 'codex-editor'}, limited},
        {key: 'claude:a', provider: 'claude', target: {kind: 'tab'}, limited},
        {key: 'claude:c', provider: 'claude', target: {kind: 'window'}, limited},
        {key: 'codex:d', provider: 'codex', target: {kind: 'tab'}, limited: null}];
    assert.equal(f.context.limitedConversations(rows).map(r => r.key).join(','), 'codex:b,codex:e,claude:a');
    f.tracker._run = async args => { f.calls.push(Array.from(args)); return {ok: true, input: args.includes('--input')}; };
    const result = await f.tracker._activate(f.row, f.snapshot, 'focus', true);
    assert.deepEqual(f.calls.find(c => c[0] === 'navigate'), ['navigate', 'codex:one', 'window-a', '--input']);
    assert.equal(result.input, true);
});

test('another conversation in the same window switches without returning', async () => {
    const f = fixture();
    await f.tracker._activate(f.row, f.snapshot);
    f.calls.length = 0;
    await f.tracker._activate({...f.row, key: 'claude:two'}, f.snapshot);
    assert.equal(f.win.monitor, 0);
    assert.equal(f.tracker._borrowed.get('window-a').monitor, 1);
    assert.equal(f.calls.some(c => c[0] === 'restore'), false);
    assert.equal(f.errors.length, 0);
});

test('failed chat selection never clears attention and retains a return destination', async () => {
    const f = fixture();
    f.tracker._run = async args => { f.calls.push(args); if (args[0] === 'navigate') throw new Error('tab changed'); };
    await f.tracker._activate(f.row, f.snapshot);
    assert.equal(f.calls.some(c => c[0] === 'ack'), false);
    assert.equal(f.tracker._borrowed.get('window-a').key, null);
    assert.deepEqual(f.errors, ['tab changed']);
});

test('manual movement overrides the old return record', async () => {
    const f = fixture();
    await f.tracker._activate(f.row, f.snapshot);
    f.win.monitor = 1;
    f.win.maximized_horizontally = false;
    f.calls.length = 0;
    await f.tracker._activate(f.row, f.snapshot, 'return');
    assert.equal(f.win.monitor, 1);
    assert.equal(f.tracker._borrowed.size, 0);
    assert.equal(f.calls.some(c => c[0] === 'restore'), false);
});

test('duplicate workspace names never select a native window by title', () => {
    const f = fixture();
    f.snapshot.windows.push({id: 'window-b', workspace: 'project'});
    assert.throws(() => f.tracker._findWindow({id: 'window-b', workspace: 'project'}), /ambiguous/);
});

test('a recorded native ID whose window names another project is ignored', () => {
    const f = fixture();
    assert.equal(f.tracker._findWindow({id: 'window-a', workspace: 'project', nativeId: '0x123'}), f.win);
    f.snapshot.windows.push({id: 'window-b', workspace: 'other', nativeId: '0x123'});
    assert.equal(f.tracker._findWindow({id: 'window-b', workspace: 'other', nativeId: '0x123'}, false), null);
});

test('a window without a folder matches the one native window naming no tracked folder', () => {
    const f = fixture();
    f.win.get_title = () => 'Visual Studio Code';
    f.snapshot.windows.push({id: 'empty', workspace: 'Empty window'});
    assert.equal(f.tracker._findWindow({id: 'empty', workspace: 'Empty window'}), f.win);
    f.win.get_title = () => 'Chat - project - Visual Studio Code';
    assert.equal(f.tracker._findWindow({id: 'empty', workspace: 'Empty window'}, false), null);
});

test('provider ratios count distinct open conversations and unread completions', () => {
    const f = fixture();
    const rows = [{provider: 'claude', key: 'a', unread: []},
        {provider: 'codex', key: 'b', unread: ['Reply finished']},
        {provider: 'codex', key: 'b', unread: ['Reply finished']}];
    const claude = f.context.providerCounts(rows, 'claude');
    const codex = f.context.providerCounts(rows, 'codex');
    assert.equal(claude.review, 0);
    assert.equal(claude.open, 1);
    assert.equal(codex.review, 1);
    assert.equal(codex.open, 1);
});

test('projects stay together; review-first order sorts conversations by latest completion', () => {
    const f = fixture();
    const make = (key, project, completed, unread = []) => ({key, project, roots: [project],
        window: project, title: key, completed_at: completed, state_at: 900, state: 'working', unread});
    const rows = [make('old', 'A', 100), make('recent', 'A', 200, ['Reply finished']),
        make('newest', 'B', 300), make('never', 'A', 0)];
    const projects = f.context.groupProjects(rows, 'review');
    assert.equal(projects.length, 2);
    assert.equal(projects[0].name, 'A');
    assert.equal(projects[0].rows.length, 3);
    assert.equal(projects[0].windows.get('A').map(r => r.key).join(','), 'recent,old,never');
    assert.equal(rows.map(r => r.key).join(','), 'old,recent,newest,never');
});

test('queue details show workers and timing from the monitor, or when a queue finished', () => {
    const f = fixture();
    const now = Date.now() / 1000;
    assert.equal(f.context.queueDetail({state: 'RUNNING', done: 397, total: 693, pct: 57.3,
        workers: '1-1-0-1-0-0 P50 WAIT', elapsed: 16000, eta: 90000}),
    '397 / 693 jobs · 57.3% · 3 workers · running 4h 26m · ETA 1d 1h');
    assert.match(f.context.queueDetail({state: 'RUNNING', done: 1, total: 3, pct: 33.3,
        workers: '1', eta: 3600, eta_warning: 'recent_slower'}), /ETA 1h 0m \(recent jobs slower\)/);
    assert.match(f.context.queueDetail({state: 'PENDING', done: 12, total: 20, pct: 60,
        workers: '0', elapsed: 1000, eta: 900}), /queued 16m · ETA 15m/);
    assert.doesNotMatch(f.context.queueDetail({state: 'PENDING', done: 0, total: 20, pct: 0,
        workers: '0', elapsed: 1000, eta: -1}), /ETA/);
    assert.equal(f.context.queueDetail({state: 'DRAINING', done: 490, total: 693, pct: 70.7,
        workers: '0-0 P50 DRAIN', failed: 3, failed_at: '12:19'}),
    '490 / 693 jobs · 70.7% · 3 failed, last 12:19');
    assert.equal(f.context.queueDetail({state: 'COMPLETED', done: 9, total: 9, pct: 100,
        workers: '0-0 P100 EMPTY', elapsed: 600, ended: now - 7200}),
    '9 / 9 jobs · 100.0% · finished 2h ago · took 10m');
    assert.equal(f.context.queueDetail({state: 'UNLISTED', done: 0, total: 1, pct: 0, workers: '', finished_at: now - 120}),
        '0 / 1 jobs · 0.0% · no longer listed by the monitor since 2m ago');
    assert.equal(f.context.queueDetail({state: 'FAILED', done: 1, total: 2, pct: 50, workers: '', finished_at: 0}),
        '1 / 2 jobs · 50.0% · finished');
});

test('queue priority prefers the scheduler setting and reads signed monitor priorities without controls', () => {
    const {queuePriority} = fixture().context;
    const live = queuePriority('2 run P50*', {default: 0, hosts: {mba: 'off', desktop: 60}});
    assert.equal(live.value, 0);
    assert.match(live.tip, /mba off, desktop 60/);
    const reported = queuePriority('1-0 P-1000* WAIT');
    assert.equal(reported.value, -1000);
    assert.match(reported.tip, /per-host priority overrides/);
    assert.equal(queuePriority('1-1 P50').value, 50);
    assert.equal(queuePriority('1-1'), null);
    assert.equal(queuePriority('adaptive:n/a'), null);
});

test('prerequisite indices follow active numbers and reuse a project-local index for completed or unavailable targets', () => {
    const {queueReferenceIndex} = fixture().context;
    const rows = new Map([['active', {project: 'A', number: 1}], ['done', {project: 'A', number: null}],
        ['other', {project: 'B', number: 1}]]);
    const known = new Map([['pool/1', {tag: 'done', project: 'A'}], ['pool/2', {tag: 'other', project: 'B'}],
        ['pool/3', {project: 'A'}], ['pool/4', {tag: 'done', project: 'A'}], ['pool/5', {project: 'B'}]]);
    const index = queueReferenceIndex(rows, known);
    assert.deepEqual(Array.from(index.references.values(), ref => ref.number), [2, 1, 3, 2, 2]);
    assert.equal(index.numbers.get('done'), 2);
    assert.equal(index.references.get('pool/2').project, 'B');
    rows.set('new', {project: 'A', number: 2});
    assert.equal(queueReferenceIndex(rows, known).references.get('pool/1').number, 3);
});

test('window menu shows every window with its most urgent state, most recent first or by name', () => {
    const f = fixture();
    const snapshot = {windows: [{id: 'b', workspace: 'zeta'}, {id: 'a', workspace: 'alpha'}, {id: 'c', workspace: 'empty'}],
        rows: [{window: 'a', state: 'working', state_at: 50, unread: []},
            {window: 'a', state: 'finished', state_at: 80, unread: ['Reply finished']},
            {window: 'b', state: 'waiting', state_at: 20, unread: []}]};
    const result = f.context.windowSummaries(snapshot).map(s => [s.window.workspace, s.state, s.active]);
    assert.deepEqual(result, [['alpha', 'review', 80], ['zeta', 'waiting', 20], ['empty', 'muted', 0]]);
    assert.deepEqual(f.context.windowSummaries(snapshot, 'name').map(s => s.window.workspace), ['alpha', 'empty', 'zeta']);
});

test('settings default when unset; a focused window can be kept in place', async () => {
    const f = fixture();
    assert.equal(f.tracker._setting('quickLimit'), 6);
    f.tracker._settings = {focusedClick: 'stay'};
    await f.tracker._activate(f.row, f.snapshot);
    f.context.global.display.focus_window = f.win;
    await f.tracker._activate(f.row, f.snapshot);
    assert.equal(f.win.monitor, 0);
    assert.equal(f.errors.length, 0);
});

test('projects sort by latest activity by default and filters select providers or states', () => {
    const f = fixture();
    const make = (key, project, at, extra = {}) => ({key, project, roots: [project], window: project, title: key,
        completed_at: 0, state_at: at, state: 'finished', unread: [], provider: 'claude', ...extra});
    const rows = [make('a', 'A', 100), make('b', 'B', 300), make('c', 'C', 200, {unread: ['Reply finished']})];
    const names = order => f.context.groupProjects(rows, order).map(p => p.name).join(',');
    assert.equal(names(), 'B,C,A');
    assert.equal(names('name'), 'A,B,C');
    assert.equal(rows.filter(r => f.context.matchesFilter(r, 'review')).map(r => r.key).join(','), 'c');
    assert.equal(rows.filter(r => f.context.matchesFilter(r, 'codex')).length, 0);
});

test('history groups saved conversations by folder, latest first, and resumes only closed ones', async () => {
    const f = fixture();
    const rows = [{key: 'claude:a', folder: '/r/x', last: 100}, {key: 'codex:b', folder: '/r/y', last: 300},
        {key: 'claude:c', folder: '/r/x', last: 200}];
    const groups = [...f.context.historyGroups(rows)].map(([folder, items]) => `${folder}:${items.map(r => r.key)}`);
    assert.equal(groups.join(' '), '/r/y:codex:b /r/x:claude:c,claude:a');
    const now = Date.now() / 1000;
    assert.match(f.context.historyDetail({last: now - 7200, prompts: 1, active: 5400, started: now - 86400 * 3}),
        /^2h ago · 1 prompt · 1h 30m active · started [A-Z][a-z]{2} \d+$/);
    f.tracker._snapshot = {...f.snapshot, rows: [{...f.row, target: {kind: 'tab'}}]};
    f.tracker._activate = async row => f.calls.push(['activate', row.key]);
    await f.tracker._resume({key: 'codex:one'});
    assert.deepEqual(f.calls, [['resume', 'codex:one'], ['activate', 'codex:one']]);
});

test('total activity orders projects and history folders by summed active time', () => {
    const f = fixture();
    const make = (key, project, at) => ({key, project, roots: [project], window: project, title: key,
        completed_at: 0, state_at: at, state: 'finished', unread: [], provider: 'claude'});
    const rows = [make('a', 'A', 300), make('b', 'B', 100), make('c', 'B', 200)];
    const totals = new Map([['a', 60], ['b', 50], ['c', 40]]);
    const projects = f.context.groupProjects(rows, 'total', totals);
    assert.equal(projects.map(p => `${p.name}:${p.total}`).join(','), 'B:90,A:60');
    assert.equal([...projects[0].windows.get('B')].map(r => r.key).join(','), 'b,c');
    const saved = [{key: 'x1', folder: '/r/x', project: 'x', last: 300, active: 10},
        {key: 'y1', folder: '/r/y', project: 'y', last: 100, active: 50}, {key: 'y2', folder: '/r/y', project: 'y', last: 200, active: 5}];
    const order = o => [...f.context.historyGroups(saved, o)].map(([, items]) => items.map(r => r.key).join('+')).join(' ');
    assert.equal(order('activity'), 'x1 y2+y1');
    assert.equal(order('total'), 'y1+y2 x1');
    assert.equal(order('name'), 'x1 y2+y1');
});

test('queue groups filter by state or since-last-turn and sort by activity, completion share or name', () => {
    const f = fixture();
    const q = (id, project, state, extra = {}) => ({id, project, state, pct: 0, started: 100, counted: true, ...extra});
    const queues = [q('a1', 'A', 'COMPLETED', {ended: 500, pct: 100}), q('a2', 'A', 'COMPLETED', {ended: 200, pct: 100, counted: false}),
        q('b1', 'B', 'RUNNING', {pct: 40}), q('c1', 'C', 'COMPLETED', {ended: 900, pct: 100}), q('c2', 'C', 'RUNNING', {pct: 70})];
    const counts = {A: {done: 1, total: 1}, B: {done: 0, total: 1}, C: {done: 1, total: 2}};
    const order = (o, filter = 'all') => f.context.queueGroups(queues, counts, o, filter, 1000)
        .map(([project, items]) => `${project}:${items.map(x => x.id).join('+')}`).join(' ');
    assert.equal(order('activity'), 'B:b1 C:c2+c1 A:a1+a2');
    assert.equal(order('completion'), 'A:a1+a2 C:c1+c2 B:b1');
    // Share first (1/1 above 8/9), then more finished; completion is the default order.
    const shares = f.context.queueGroups([q('x', 'X', 'RUNNING'), q('y', 'Y', 'RUNNING'), q('z', 'Z', 'RUNNING')],
        {X: {done: 8, total: 9}, Y: {done: 1, total: 1}, Z: {done: 2, total: 2}}).map(([project]) => project).join(',');
    assert.equal(shares, 'Z,Y,X');
    assert.equal(order('name'), 'A:a1+a2 B:b1 C:c2+c1');
    assert.equal(order('activity', 'active'), 'B:b1 C:c2');
    assert.equal(order('name', 'counted'), 'A:a1 B:b1 C:c2+c1');
});

test('cluster totals count busy cores over cores for hosts in scope and flag unreachable or unmounted hosts', () => {
    const f = fixture();
    const host = (id, cores, busy, extra = {}) => ({id, ok: true, local: false, cpu: {cores, busy_pct: busy},
        memory: {total_bytes: 100, used_bytes: 50}, mount: {ok: true}, ...extra});
    const snapshot = {hosts: [host('a', 10, 100), host('b', 10, 0, {mount: {ok: false}}),
        host('desk', 20, 50, {local: true}), host('down', 8, 90, {ok: false})]};
    const all = f.context.clusterTotals(snapshot);
    assert.equal(`${all.slots} ${all.busy} ${all.cpu} ${all.memory} ${all.slotted} ${all.down.join(',')}`, '40 20 50 50 false b,down');
    assert.equal(f.context.clusterTotals(snapshot, 'workers').cpu, 50);
    assert.equal(f.context.clusterTotals({hosts: [host('x', 4, 25, {local: true})]}, 'workers').cpu, null);
    // Job slots replace cores; the reserved cores take a host's load first, and a host past its slots counts only as full.
    const slotted = f.context.clusterTotals({hosts: [host('a', 10, 70, {slots: 6}), host('desk', 32, 100, {local: true, slots: 8})]});
    assert.equal(`${slotted.slots} ${slotted.busy} ${slotted.cpu} ${slotted.slotted}`, '14 11 78.57142857142857 true');
    assert.equal(f.context.clusterTotals({hosts: [host('desk', 32, 50, {local: true, slots: 8})]}).busy, 0);
    assert.equal([0, 1536, 5 * 1024 ** 3].map(f.context.bytes).join(','), '0 B,1.5 KB,5.0 GB');
});

test('the cluster indicator shows the picked measures, captioned unless only CPU, with the fullest disk in scope', () => {
    const {clusterBarParts} = fixture().context;
    const host = (id, free, extra = {}) => ({id, ok: true, local: false, cpu: {cores: 10, busy_pct: 40},
        memory: {total_bytes: 100, used_bytes: 25}, disk: {root_free_bytes: free, root_total_bytes: 100}, ...extra});
    const snapshot = {hosts: [host('a', 30), host('desk', 5, {local: true})],
        shared: {ok: true, disk: {free_bytes: 20, total_bytes: 100}}};
    const text = parts => parts.map(part => `${part.caption}=${Math.round(part.value)}`).join(' ');
    assert.equal(text(clusterBarParts(snapshot, ['cpu', 'warnings'])), '=40');
    assert.equal(text(clusterBarParts(snapshot, ['disk', 'cpu', 'memory'])), 'cpu=40 mem=25 disk=95');
    // Without this desktop, the fullest drive is the shared one.
    assert.equal(text(clusterBarParts(snapshot, ['disk'], 'workers')), 'disk=80');
    assert.equal(clusterBarParts(snapshot, ['warnings']).length, 0);
});

test('cluster warnings name down hosts, lost mounts, memory pressure and nearly full drives, critical ones marked', () => {
    const {clusterWarnings} = fixture().context;
    const host = (id, extra = {}) => ({id, ok: true, memory: {pressure: 'normal'}, mount: {ok: true},
        disk: {root_free_bytes: 50, root_total_bytes: 100}, ...extra});
    const snapshot = {hosts: [host('fine'), host('off', {ok: false, error: 'timed out'}), host('lost', {mount: {ok: false}}),
        host('tight', {memory: {pressure: 'warn'}}), host('swap', {memory: {pressure: 'critical'}}),
        host('full', {disk: {root_free_bytes: 6, root_total_bytes: 100}})],
    shared: {ok: true, disk: {free_bytes: 1, total_bytes: 100}}};
    const text = warnings => warnings.map(w => `${w.host}:${w.kind}${w.used ? Math.round(100 * w.used) : ''}${w.critical ? '!' : ''}`).join(' ');
    assert.equal(text(clusterWarnings(snapshot)), 'off:down! lost:unmounted! tight:memory swap:memory! full:disk94 shared:disk99!');
    assert.equal(text(clusterWarnings(snapshot, 'critical', 95)), 'off:down! lost:unmounted! swap:memory! shared:disk99!');
    assert.equal(clusterWarnings({hosts: [host('fine')]}).length, 0);
});

test('a snooze marks its warning until the warning clears or its time passes', () => {
    const {applySnoozes} = fixture().context;
    const warnings = [{host: 'off', kind: 'down'}, {host: 'full', kind: 'disk'}, {host: 'tight', kind: 'memory'}];
    const snoozes = {'off:down': 200, 'full:disk': null, 'tight:memory': 50, 'gone:down': null, 'gone:disk': 900};
    const result = applySnoozes(warnings, snoozes, 100);
    assert.equal(result.warnings.map(w => `${w.host}${w.snoozed ? `@${w.until}` : ''}`).join(), 'off@200,full@null,tight');
    // The passed time and the cleared warnings, timed or not, are dropped; the rest stay saved.
    assert.equal(Object.entries(result.snoozes).join(' '), 'off:down,200 full:disk,');
    assert.equal(Object.keys(applySnoozes([], snoozes, 0).snoozes).length, 0);
    assert.equal(applySnoozes(warnings, undefined, 100).warnings.filter(w => w.snoozed).length, 0);
});

test('a typed snooze limit reads minutes, hours, days and weeks, a bare number as hours', () => {
    const {parseDuration} = fixture().context;
    assert.equal(['90m', '120h', '5d', '2w', '1d 12h', '1.5h', '120', ' 5D '].map(parseDuration).join(),
        '5400,432000,432000,1209600,129600,5400,432000,432000');
    for (const bad of ['', '0', '0h', 'soon', '5x', 'h5', '5d-2h']) assert.equal(parseDuration(bad), null, bad);
});

test('shared-drive figures name what the pool holds back for, give graph peaks, and leave out what the snapshot lacks', () => {
    const {sharedRows} = fixture().context;
    const shared = {pool: {state: 'active', capacity: 44, in_use: 46, resource_state: 'degraded', io_state: 'ok', quarantined: 0},
        disk: {bytes_per_s: 1536, ops_per_s: 36.6}, network: {rx_bytes_per_s: 2048, tx_bytes_per_s: 0}, smbd: {cpu_pct: 387.2, sessions: 1},
        registry: {active_queues: 28, claimed_per_min: 2.1, completed_per_min: 0}};
    const text = rows => rows.map(row => `${row.caption}: ${row.text}${row.note ? ` (${row.note}${row.held ? '!' : ''})` : ''}`).join(' | ');
    assert.equal(text(sharedRows(shared)), 'Job slots: 46 running of 44 (holding back: resources degraded!) | Drive I/O: 1.5 KB/s · 37 ops/s'
        + ' | Network: in 2.0 KB/s · out 0 B/s | File server: 387% CPU · 1 session | Queues: 28 active · 2.1 claimed / min · 0 done / min');
    const history = [{at: 1, disk: 4096, rx: 100, tx: 3072}, {at: 2, disk: 1024, rx: 0, tx: 0}];
    assert.equal(sharedRows(shared, history).map(row => row.note).slice(1, 3).join(), 'peak 4.0 KB/s,peak 3.0 KB/s');
    // A pool that is not running has no slot counts to show.
    assert.equal(sharedRows({pool: {state: 'off'}})[0].text, 'off');
    assert.equal(sharedRows({}).map(row => row.text + row.note).join(''), '');
});

test('shared-drive history adds each sample once and keeps the sparkline window', () => {
    const {context} = fixture();
    const {recordShared} = context, SHARED_WINDOW = vm.runInContext('SHARED_WINDOW', context);
    const sample = at => ({ok: true, updated: at, disk: {bytes_per_s: at}, network: {rx_bytes_per_s: 1, tx_bytes_per_s: 2}});
    let history = [];
    for (const at of [100, 100, 105]) history = recordShared(history, sample(at));
    assert.equal(history.map(reading => reading.at).join(), '100,105');
    assert.equal(recordShared(history, {ok: false, updated: 110}), history);
    history = recordShared(history, sample(100 + SHARED_WINDOW));
    assert.equal(history.map(reading => `${reading.at}:${reading.disk}`).join(), `105:105,${100 + SHARED_WINDOW}:${100 + SHARED_WINDOW}`);
});

test('a multiple-choice setting keeps only a saved list of known values', () => {
    const f = fixture();
    assert.equal(f.tracker._setting('clusterBar').join(), 'cpu,warnings');
    const load = saved => {
        f.context.imports.gi.GLib.file_get_contents = () => [true, JSON.stringify({clusterBar: saved})];
        f.tracker._loadSettings();
        return f.tracker._setting('clusterBar').join();
    };
    assert.equal(load(['memory', 'disk']), 'memory,disk');
    assert.equal(load([]), '');
    assert.equal(load(['cpu', 'swap']), 'cpu,warnings');
    assert.equal(load('cpu-mem'), 'cpu,warnings');
});

test('queue and history headers find the one open window for a project or folder', () => {
    const f = fixture();
    // A terminal session's window cannot open or resume a folder, so it never makes a match ambiguous.
    const windows = [{id: 'root', roots: ['/h/repos/omics']}, {id: 'sub', roots: ['/h/repos/omics/tmp/audit']},
        {id: 'p1', roots: ['/h/repos/predict']}, {id: 'p2', roots: ['/h/repos/predict']}, {id: 'x', roots: ['/h/repos/x/tmp']},
        {id: 'terminal:9', kind: 'terminal', roots: ['/h/repos/omics']}, {id: 'terminal:8', kind: 'terminal', roots: ['/h/repos/omics/tmp/audit']}];
    assert.equal(f.context.projectWindow(windows, 'omics')?.id, 'root');
    assert.equal(f.context.projectWindow(windows, 'audit')?.id, 'sub');
    assert.equal(f.context.projectWindow(windows, 'x')?.id, 'x');
    assert.equal(f.context.projectWindow(windows, 'predict'), null);
    assert.equal(f.context.projectWindow(windows, 'missing'), null);
    assert.equal(f.context.folderWindow(windows, '/h/repos/omics/tmp/audit')?.id, 'sub');
    assert.equal(f.context.folderWindow(windows, '/h/repos/omics/tmp'), null);
});

test('guide labels centre on their anchors when there is room, else keep order and stay inside', () => {
    const {spread} = fixture().context;
    assert.deepEqual(Array.from(spread([100, 300], [50, 50], 400, 10)), [75, 275]);
    // Crowded: pushed apart in order, then back inside the right edge.
    assert.deepEqual(Array.from(spread([100, 110, 390], [50, 50, 50], 400, 10)), [75, 135, 350]);
    assert.deepEqual(Array.from(spread([380, 390], [50, 50], 400, 10)), [290, 350]);
    assert.deepEqual(Array.from(spread([5], [50], 400, 10)), [0]);
});

test('failed queues group by project with most failures first, and the copied note names queues, paths and hosts down', () => {
    const {failedQueues, failureReport, failureDetail} = fixture().context;
    const queues = [
        {id: 'a', project: 'omics', label: 'shuffle', batch: 2, failed: 12, failed_at: '13:51', done: 480, total: 1644,
            state: 'FINISHED_INCOMPLETE', rerun: 0, path: 'tmp/shuffle/queues/main.txt'},
        {id: 'b', project: 'omics', label: 'tail', batch: 1, failed: 1, failed_at: '11-02', done: 21, total: 216,
            state: 'DRAINING', rerun: 2, path: '/abs/tail.txt'},
        {id: 'c', project: 'sum', label: 'fits', batch: 3, failed: 0, done: 9, total: 9, state: 'COMPLETED', path: 'x'},
    ];
    const groups = failedQueues(queues);
    assert.deepEqual([...groups.keys()], ['omics']);
    assert.deepEqual(Array.from(groups.get('omics'), q => q.id), ['a', 'b']);
    assert.equal(failureDetail(queues[0]), '12 failed, last 13:51 · 480 / 1644 done · FINISHED_INCOMPLETE');
    const cluster = {updated: 1793751700, hosts: [
        {id: 'local', local: true, ok: true, mount: {root: '/srv/shared', ok: true}},
        {id: 'worker-1', local: false, ok: false, mount: {root: '/Volumes/shared', ok: true}}]};
    const note = failureReport('omics', groups.get('omics'), cluster);
    assert.match(note, /^Cluster jobs failed in omics \(cluster monitor, /);
    assert.match(note, /- shuffle, batch 2: 12 jobs failed, newest at 13:51; 480 of 1644 done; FINISHED_INCOMPLETE\.\n {2}Queue: \/Volumes\/shared\/tmp\/shuffle\/queues\/main\.txt/);
    assert.match(note, /- tail, batch 1: 1 job failed, newest at 11-02; 21 of 216 done; DRAINING; 2 already rerun\.\n {2}Queue: \/abs\/tail\.txt/);
    assert.match(note, /Hosts unreachable or without the shared mount now: worker-1\./);
    assert.match(note, /reconcile_queue_batch\.sh/);
});

test('git repositories sort conflicts first, then uncommitted or unpushed work by latest commit, and filter', () => {
    const f = fixture();
    const repo = (name, extra = {}) => ({name, branch: 'main', upstream: 'origin/main', remotes: 1, ahead: 0, behind: 0,
        staged: 0, modified: 0, untracked: 0, conflicts: 0, operation: null, commit_at: 100, ...extra});
    const repos = [repo('clean', {commit_at: 900}), repo('dirty', {modified: 2, commit_at: 300}),
        repo('ahead', {ahead: 3, commit_at: 500}), repo('merge', {conflicts: 1, commit_at: 50})];
    const names = (order, filter) => f.context.gitRepos(repos, order, filter).map(r => r.name).join(',');
    assert.equal(names('changes', 'all'), 'merge,ahead,dirty,clean');
    assert.equal(names('recent', 'all'), 'clean,ahead,dirty,merge');
    assert.equal(names('name', 'changes'), 'dirty,merge');
    assert.equal(names('name', 'unpushed'), 'ahead');
    assert.equal(f.context.gitDetail(repos[2]), 'main · ↑3 · nothing uncommitted');
    assert.equal(f.context.gitDetail(repo('x', {upstream: null, staged: 1, untracked: 4})), 'main · no upstream · 1 staged, 4 untracked');
    assert.equal(f.context.gitDetail(repo('x', {upstream: null, remotes: 0, branch: null})), 'detached HEAD · local only · nothing uncommitted');
    assert.equal(f.context.gitDetail(repo('x')), 'main · even with origin/main · nothing uncommitted');
});

test('a git row brings its VS Code window forward, then asks a capable bridge for Source Control', async () => {
    const f = fixture();
    await f.tracker._showScm({...f.snapshot.windows[0]}, f.snapshot);
    assert.ok(!f.calls.some(call => call[0] === 'show-scm'));
    f.win.maximized_horizontally = f.win.maximized_vertically = true;
    f.win.monitor = 0;
    await f.tracker._showScm({...f.snapshot.windows[0], scm: true}, f.snapshot);
    assert.deepEqual(f.calls.at(-1), ['show-scm', 'window-a']);
});

test('messages group by pair of chats, newest pair first, each oldest first, and filter to unread', () => {
    const f = fixture();
    const m = (id, sender, recipient, at, read_at = null) => ({id, sender, recipient, at, read_at});
    const messages = [m(1, 'claude:a', 'codex:b', 100, 150), m(2, 'codex:b', 'claude:a', 200), m(3, 'claude:a', 'claude:c', 150)];
    const ids = filter => f.context.messageThreads(messages, filter).map(items => items.map(x => x.id).join('+')).join(' ');
    assert.equal(ids('all'), '1+2 3');
    assert.equal(ids('unread'), '2 3');
});

test('message filters pick an agent or a project at either end of a message', () => {
    const f = fixture();
    const m = (id, sender, recipient, sender_project, recipient_project) => ({id, sender, recipient, at: id, read_at: 1,
        sender_title: sender.slice(-1).toUpperCase(), recipient_title: recipient.slice(-1).toUpperCase(), sender_project, recipient_project});
    const messages = [m(1, 'claude:a', 'codex:b', 'alpha', 'beta'), m(2, 'codex:b', 'claude:a', 'beta', 'alpha'),
        m(3, 'claude:c', 'claude:a', 'gamma', 'alpha')];
    assert.equal(f.context.messageFilterValues(messages, 'agent').map(([key, label]) => `${key}=${label}`).join(' | '),
        'claude:a=✳ A · alpha | codex:b=⌘ B · beta | claude:c=✳ C · gamma');
    assert.equal(f.context.messageFilterValues(messages, 'project').map(([value]) => value).join(' '), 'alpha beta gamma');
    const ids = (filter, value) => f.context.messageThreads(messages, filter, value).flat().map(x => x.id).sort().join(',');
    assert.equal(ids('agent', 'codex:b'), '1,2');
    assert.equal(ids('project', 'gamma'), '3');
    assert.equal(ids('project', 'alpha'), '1,2,3');
    assert.equal(ids('unread'), '');
});

test('scheduler control inputs give the values rota control apply takes, or say what to fix', () => {
    const f = fixture();
    const {controlTyped, controlValue, controlSummary, controlRequest} = f.context;
    const integer = (name, extra = {}) => ({name, label: name, kind: 'integer', min: 0, max: 50, value: 4, enabled: true, ...extra});
    const priority = {name: 'priority', label: 'Priority', kind: 'group', value: {default: 90, hosts: {mba: 'off', mm1: 70}},
        fields: [integer('default', {min: -1000, max: 1000, value: 90}),
            {name: 'hosts', label: 'Per host', kind: 'host-map', hosts: ['mba', 'mm1', 'mm2'], min: -1000, max: 1000,
                value: {mba: 'off', mm1: 70}, enabled: true}]};
    const typed = controlTyped(priority);
    assert.deepEqual(JSON.parse(JSON.stringify(typed)), {default: '90', hosts: {mba: 'off', mm1: '70', mm2: ''}});
    assert.deepEqual(JSON.parse(JSON.stringify(controlValue(priority, typed))), {value: priority.value});
    typed.hosts.mm1 = '';
    typed.hosts.mm2 = ' OFF ';
    assert.deepEqual(JSON.parse(JSON.stringify(controlValue(priority, typed).value)), {default: 90, hosts: {mba: 'off', mm2: 'off'}});
    typed.hosts.mm2 = 'lots';
    assert.match(controlValue(priority, typed).error, /Per host on mm2 takes a whole number from -1000 to 1000, or off/);
    assert.match(controlValue(integer('cap'), '51').error, /from 0 to 50/);
    assert.match(controlValue(integer('cap', {max: null}), '1.5').error, /cap takes a whole number of at least 0$/);
    assert.equal(controlValue(integer('cap', {optional: true}), ' ').value, null);
    assert.match(controlValue(integer('cap'), '').error, /needs a whole number/);
    const text = {name: 'reason', label: 'Reason', kind: 'text', value: null};
    assert.match(controlValue(text, '').error, /Reason is required/);
    assert.equal(controlValue({...text, optional: true}, '').value, null);
    const choice = {name: 'state', label: 'State', kind: 'choice', value: 'present', choices: [{value: 'present', label: 'Present'}, {value: 'away', label: 'Away'}]};
    assert.equal(controlValue(choice, 'away').value, 'away');
    assert.match(controlValue(choice, 'gone').error, /Choose State/);
    assert.match(controlValue({label: 'Odd', kind: 'boolean'}, 'x').error, /cannot edit/);
    assert.equal(controlSummary(priority), 'default 90 · Per host mba off, mm1 70');
    assert.equal(controlSummary({...choice, value: 'away'}), 'Away');
    assert.equal(controlSummary(integer('cap', {unit: 'jobs', value: null})), 'none');
    assert.deepEqual(JSON.parse(JSON.stringify(controlRequest({kind: 'queue', id: 'q1'}, integer('max_workers'), 6, 'pool-1', 'r1'))),
        {protocol: 1, request_id: 'r1', source: 'agent-bar', target: {kind: 'queue', id: 'q1'}, control: 'max_workers', value: 6,
            expect: {pool_id: 'pool-1', value: 4}});
});

test('a redescription redraws the Queues tab only when controls or reachability change', () => {
    const f = fixture();
    const {controlsSignature} = f.context;
    const described = facts => ({coordinator: {reachable: true}, pool: {id: 'p', state: 'ACTIVE', facts, controls: []}, hosts: [],
        queues: [{id: 'q', snapshot_id: 's', state: 'RUNNING', facts, controls: [{name: 'pause', enabled: true}]}]});
    assert.equal(controlsSignature(described([{label: 'Running jobs', value: '3'}])), controlsSignature(described([{label: 'Running jobs', value: '4'}])));
    const paused = described([]);
    paused.queues[0].controls[0].enabled = false;
    assert.notEqual(controlsSignature(paused), controlsSignature(described([])));
    assert.equal(controlsSignature(null), '');
});

test('an applied control sends what was shown as expected, and a refusal comes back as the scheduler worded it', async () => {
    const f = fixture();
    const sent = [];
    f.context.imports.gi.GLib.uuid_string_random = () => 'r1';
    f.tracker._controls = {pool: {id: 'pool-1'}};
    f.tracker._control = async (args, input) => {
        sent.push([Array.from(args), JSON.parse(input)]);
        return {protocol: 1, ok: false, request_id: 'r1', error: {code: 'conflict', message: 'the current value is 2, not 4'}};
    };
    const control = {name: 'max_workers', label: 'Worker cap', kind: 'integer', value: 4};
    const answer = await f.tracker._applyControl({kind: 'queue', id: 'q1'}, control, 6);
    assert.equal(answer.error.code, 'conflict');
    assert.deepEqual(sent[0][0], ['apply']);
    assert.deepEqual(sent[0][1].expect, {pool_id: 'pool-1', value: 4});
    f.tracker._control = async () => { throw new Error('The rota command is not installed'); };
    assert.deepEqual(JSON.parse(JSON.stringify(await f.tracker._applyControl({kind: 'pool', id: 'pool-1'}, control, null))),
        {ok: false, error: {code: 'failed', message: 'The rota command is not installed'}});
});

test('scheduler controls lay out as actions or settings, and only a real change counts as one', () => {
    const f = fixture();
    const {controlIsAction, groupFields, controlChange} = f.context;
    const integer = name => ({name, label: name, kind: 'integer', min: 0, max: null, value: 1, enabled: true});
    const text = name => ({name, label: name, kind: 'text', value: null, enabled: true});
    assert.equal(controlIsAction({kind: 'action'}), true);
    assert.equal(controlIsAction({kind: 'group', fields: [text('reason')]}), true);
    assert.equal(controlIsAction({kind: 'group', fields: [integer('a'), text('b')]}), false);
    const names = control => groupFields(control).map(part => part.map(field => field.name).join(',')).join(' | ');
    assert.equal(names({kind: 'group', fields: [integer('cpu'), integer('memory')]}), 'cpu,memory | ');
    assert.equal(names({kind: 'group', fields: [integer('floor'), integer('jobs'), integer('seconds')]}), 'floor | jobs,seconds');
    assert.equal(names({kind: 'group', fields: [integer('default'), {name: 'hosts', kind: 'host-map'}]}), 'default | hosts');
    assert.equal(names(integer('cap')), 'cap | ');
    // Host overrides typed in another order than the scheduler lists them are the same value.
    const priority = {name: 'priority', label: 'Priority', kind: 'group', value: {default: 90, hosts: {desktop: 'off', mba: 'off'}},
        fields: [{...integer('default'), value: 90}, {name: 'hosts', label: 'Per host', kind: 'host-map', hosts: ['mba', 'mm1', 'desktop'],
            min: null, max: null, value: {desktop: 'off', mba: 'off'}}]};
    assert.equal(controlChange(priority, {default: '90', hosts: {mba: 'off', mm1: '', desktop: 'off'}}).changed, false);
    assert.equal(controlChange(priority, {default: '91', hosts: {mba: 'off', mm1: '', desktop: 'off'}}).changed, true);
    assert.match(controlChange(priority, {default: 'x', hosts: {}}).error, /whole number/);
});

test('fact chips wrap into lines that fit the panel', () => {
    const f = fixture();
    const lines = f.context.chipLines(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'], 70);
    assert.equal(lines.map(line => line.map(t => t[0]).join('')).join(' '), 'ab cd');
});

test('the top bar shows what is left of each weekly limit, dimmed when the reading is old or past its reset', () => {
    const f = fixture();
    const {quotaLeft, quotaStyle, quotaTooltip} = f.context;
    const now = Math.floor(Date.now() / 1000);
    const usage = {claude: {as_of: now - 3600, limits: [
        {key: 'weekly', name: 'Weekly', left: 12, percent: 88, resets_at: now + 86400, expired: false, limiting: false},
        {key: 'weekly:Fable', name: 'Weekly · Fable', left: 0, percent: 100, resets_at: now + 86400, expired: false, limiting: true}]},
        codex: {as_of: now - 7 * 3600, limits: [{key: 'weekly', name: 'Weekly', left: 64, percent: 36, resets_at: now + 3600, expired: false}]}};
    const claude = quotaLeft(usage, 'claude', now);
    assert.equal(claude.left, 12);
    assert.equal(claude.stale, false);
    assert.equal(claude.limiting.length, 1);
    assert.equal(quotaLeft(usage, 'codex', now).stale, true);
    assert.equal(quotaLeft(usage, 'copilot', now), null);
    assert.deepEqual([5, 12, 40].map(quotaStyle).join(' '), 'failed attention muted');
    assert.match(quotaTooltip(usage), /^Usage limits left\nClaude, reading .+\n  Weekly: 12% left, resets .+\n  Weekly · Fable: 0% left/);
    assert.equal(quotaTooltip({}), null);
});

test('a limit\'s projection says when its pace would use the rest, against the reset', () => {
    const f = fixture();
    const {quotaProjection} = f.context;
    const now = 1_000_000, hour = 3600;
    const limit = extra => ({left: 20, percent: 80, resets_at: now + 48 * hour, expired: false,
        pace: {per_hour: 0.5, basis: 'day'}, runs_out_at: now + 40 * hour, at_reset: 100, ...extra});
    assert.match(quotaProjection(limit(), now, now), /^At the last day's pace \(0\.50%\/h\), it runs out .+, in 1d 16h, 8h 0m before the reset\.$/);
    assert.match(quotaProjection(limit({runs_out_at: now + 60 * hour, at_reset: 84}), now, now), /lasts to the reset, about 84% used by then\.$/);
    assert.match(quotaProjection(limit({runs_out_at: now - hour, pace: {per_hour: 2, basis: 'window'}}), now - 20 * hour, now),
        /^At this window's average pace \(2\.0%\/h\), it would have run out by .+; this reading is/);
    assert.match(quotaProjection(limit({left: 0}), now, now), /^Used up until it resets, in 2d 0h\.$/);
    assert.equal(quotaProjection(limit({pace: undefined}), now, now), null);
    assert.equal(quotaProjection(limit({expired: true}), now, now), null);
});

test('a chat copies as its whole name, key, project, folders and how to resume it', () => {
    const f = fixture();
    const row = {provider: 'claude', id: 'abc', key: 'claude:abc', title: 'A long chat name that the tab shortens', project: 'p', roots: ['/r/p']};
    assert.equal(f.context.chatIdentity(row),
        'A long chat name that the tab shortens\nChat: claude:abc\nProject: p\nFolder: /r/p\nResume: claude --resume abc');
    assert.match(f.context.chatIdentity({...row, provider: 'codex', key: 'codex:abc'}), /Resume: codex resume abc$/);
    assert.doesNotMatch(f.context.chatIdentity({...row, provider: 'copilot', roots: []}), /Resume|Folder/);
});

test('a chat a usage limit stopped gets a review button only when its own reason is picked', () => {
    const f = fixture();
    const rows = [{key: 'stopped', target: {}, unread: ['Turn failed'], limited: {at: 5}, completed_at: 5},
        {key: 'failed', target: {}, unread: ['Turn failed'], completed_at: 6},
        {key: 'both', target: {}, unread: ['Turn failed', 'Queues finished'], limited: {at: 7}, completed_at: 7}];
    const keys = reasons => f.context.readyConversations(rows, reasons).map(r => r.key).join(',');
    assert.equal(keys(['Turn failed', 'Queues finished']), 'failed,both');
    assert.equal(keys(['Turn failed', 'Usage limit']), 'stopped,failed,both');
    assert.equal(keys(['Usage limit']), 'stopped,both');
    // The default picks everything but usage-limit stops.
    const [, , , , fallback, options] = vm.runInContext('SETTINGS', f.context).find(([, key]) => key === 'quickReasons');
    assert.equal(options.map(([value]) => value).filter(value => !fallback.includes(value)).join(), 'Usage limit');
});

test('tickets group as ready, waiting, started and closed, and say what they wait for', () => {
    const f = fixture();
    const now = Date.now() / 1000;
    const base = {project: 'p', author: 'user', at: now, status_at: now, waiting: []};
    const listing = {open: [{...base, id: 1, body: 'Audit', status: 'open', ready: false, waiting: ['Claude weekly limit resets', 'fits finishes']},
        {...base, id: 2, body: 'Tidy', status: 'open', ready: true},
        {...base, id: 3, body: 'Port', status: 'started', ready: false, taken_by: 'codex:x', taken_title: 'Porter'}],
    closed: [{...base, id: 4, body: 'Old', status: 'done', note: 'merged', author: 'claude:y', author_title: 'Helper'}]};
    const groups = f.context.ticketGroups(listing);
    assert.equal(groups.map(([name, tickets]) => `${name}:${tickets.map(t => t.id)}`).join(' '), 'Ready:2 Waiting:1 Started:3 Closed:4');
    assert.equal(f.context.ticketGroups(listing, 'audit').map(([name]) => name).join(), 'Waiting');
    assert.equal(f.context.ticketGroups(listing, '#4').map(([name]) => name).join(), 'Closed');
    assert.equal(f.context.ticketMeta(listing.closed[0]), '#4 · p · by ✳ Helper · just now');
    assert.equal(f.context.ticketNote(listing.open[0]), 'Waits until Claude weekly limit resets and fits finishes');
    assert.equal(f.context.ticketNote(listing.open[1]), '');
    assert.equal(f.context.ticketNote(listing.open[2]), 'Taken by ⌘ Porter just now');
    assert.equal(f.context.ticketNote(listing.closed[0]), 'Done just now: merged');
    assert.equal([...listing.open, ...listing.closed].map(t => f.context.ticketStatus(t)[0]).join(), 'Waiting,Ready,Started,Done');
});

test('a new ticket can go in any open folder, the most recently active chat\'s first', () => {
    const f = fixture();
    const snapshot = {rows: [{roots: ['/r/old'], state_at: 1}, {roots: ['/r/new', '/r/old'], state_at: 5}],
        windows: [{kind: 'vscode', roots: ['/r/idle']}, {kind: 'app', roots: ['/r/app']}]};
    assert.equal(f.context.ticketFolders(snapshot).map(([folder, name]) => `${name}=${folder}`).join(), 'new=/r/new,old=/r/old,idle=/r/idle');
});

test('the top-bar ticket count shows the ones that came due, every ready one, or none', () => {
    const f = fixture();
    const listing = {open: [{ready: true, after: [{kind: 'date'}]}, {ready: true, after: []}, {ready: false, after: [{kind: 'reset'}]}]};
    assert.equal(f.context.countedTickets(listing, 'due').length, 1);
    assert.equal(f.context.countedTickets(listing, 'ready').length, 2);
    assert.equal(f.context.countedTickets(listing, 'off').length, 0);
});

test('tickets sent to a chat group as scheduled, say where they go, and count in the top bar only when sending failed', () => {
    const f = fixture();
    const now = Date.now() / 1000;
    const sent = {id: 5, body: 'Weekly draft', project: 'p', author: 'user', at: now, status: 'open', ready: false, after: [{kind: 'date'}],
        waiting: ['Mon Nov 23, 09:00, then every week'], deliver_to: 'codex:b', deliver_title: 'Reports', sent_count: 2};
    const failed = {...sent, id: 6, ready: true, waiting: [], delivery_error: 'codex:b is not an open chat', sent_count: 0};
    const listing = {open: [sent, failed, {id: 7, body: 'x', project: 'p', status: 'open', ready: true, after: [], waiting: []}], closed: []};
    assert.equal(f.context.ticketGroups(listing).map(([name, t]) => `${name}:${t.map(x => x.id)}`).join(' '), 'Ready:7 Scheduled:5,6');
    assert.equal(f.context.ticketNote(sent), 'Sends to ⌘ Reports when Mon Nov 23, 09:00, then every week · sent 2 times');
    assert.match(f.context.ticketNote(failed), /^Not sent to ⌘ Reports yet: codex:b is not an open chat/);
    assert.equal([sent, failed].map(t => f.context.ticketStatus(t)[0]).join(), 'Scheduled,Not sent');
    assert.equal(f.context.countedTickets(listing, 'ready').map(t => t.id).join(), '6,7');
    assert.equal(f.context.scheduledFor(listing, 'codex:b').length, 2);
});

test('quick send times are an hour from now, tomorrow at 9 and the next Monday at 9', () => {
    const f = fixture();
    // A Wednesday afternoon.
    const choices = f.context.whenChoices(new Date(2026, 10, 18, 14, 30));
    assert.equal(choices.map(([value]) => value).join(' | '), '+1h | 2026-11-19 09:00 | 2026-11-23 09:00');
    // On a Monday, "Monday" is the next one.
    assert.equal(f.context.whenChoices(new Date(2026, 10, 16, 8))[2][0], '2026-11-23 09:00');
});

test('review shortcuts group chats by project, longest waiting first, and spare room goes to names, never past whole', () => {
    const f = fixture();
    const rows = [{key: 'a', project: 'p'}, {key: 'b', project: 'q'}, {key: 'c', project: 'p'}];
    assert.equal(f.context.quickGroups(rows).map(group => group.map(row => row.key).join('+')).join(' '), 'a+c b');
    // 30 to share: the first can take only 5 more, so the other two split the rest.
    assert.equal(f.context.shareWidth([100, 100, 100], [105, 200, 200], 30).join(), '105,112,112');
    assert.equal(f.context.shareWidth([100, 100], [100, 100], 50).join(), '100,100');
    assert.equal(f.context.shareWidth([100], [300], -10).join(), '100');
});

test('checklist progress leaves dropped items out and never calls a file with nothing open done', () => {
    const f = fixture();
    const base = {done: 0, open: 0, dropped: 0, unknown: 0};
    assert.deepEqual(JSON.parse(JSON.stringify(f.context.checklistProgress({...base, done: 7, open: 2, dropped: 1}))),
        {fraction: 7 / 9, text: '7 of 9 done · 1 dropped'});
    assert.equal(f.context.checklistProgress({...base, done: 3}).text, 'No open items recorded · 3 done');
    assert.equal(f.context.checklistProgress({...base, dropped: 2}).text, 'No open items recorded · 2 dropped');
    assert.equal(f.context.checklistProgress({...base, open: 1, unknown: 1}).text, '0 of 1 done · 1 with an unrecognized marker');
});

test('a chat\'s checklists: the ones it edited, then recent ones, then older ones with open items', () => {
    const f = fixture();
    const files = [{path: 'a', recent: true, editors: [['claude:x', 5]]}, {path: 'b', recent: true, editors: []},
        {path: 'c', recent: false, editors: [['codex:y', 1]]}, {path: 'd', recent: false}];
    assert.equal(f.context.checklistSections(files, 'claude:x').map(([name, list]) => `${name}:${list.map(x => x.path)}`).join(' | '),
        'Edited by this chat:a | Recently updated:b | Older, with open items:c,d');
});

test('history highlights literal title matches and escapes markup in message excerpts', () => {
    const {context} = fixture();
    context.imports.gi.GLib.markup_escape_text = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let markup;
    const label = {text: 'Review [A+B] & <notes>', clutter_text: {set_markup: value => { markup = value; }}};
    context.highlightHistoryText(label, '[a+b]');
    assert.equal(markup, 'Review <b><u>[A+B]</u></b> &amp; &lt;notes&gt;');
    context.highlightHistoryParts(label, ['Agent · <', 'Démultiplexing', '> & ', 'demux', '']);
    assert.equal(markup, 'Agent · &lt;<b><u>Démultiplexing</u></b>&gt; &amp; <b><u>demux</u></b>');
});

test('a history context request respects repo scope and cannot reopen a collapsed result', async () => {
    const {tracker} = fixture();
    const lookup = {query: 'oak', repo: 'garden', details: new Map()};
    let finish, args, renders = 0;
    Object.assign(tracker, {_historyLookup: lookup, _view: 'history', _button: {menu: {isOpen: true}},
        _renderRows() { renders++; }, _run(command) { args = Array.from(command); return new Promise(resolve => { finish = resolve; }); }});
    const pending = tracker._loadHistoryContext(lookup, 'codex:a', 2, -1);
    assert.equal(lookup.details.get('codex:a').loading, true);
    assert.deepEqual(args, ['search-history', '--conversation', 'codex:a', '--message', '2', '--hit', '-1', '--repo', 'garden', '--', 'oak']);
    lookup.details.delete('codex:a');
    finish({context: {message: 2, hit: 5}});
    await pending;
    assert.equal(lookup.details.size, 0);
    assert.equal(renders, 1);
});

test('Chats and History share message matches and repo scope while keeping unindexed open chats searchable', () => {
    const {context, tracker} = fixture();
    const row = {key: 'codex:a', title: 'Open questions', project: 'tools', provider: 'codex', roots: ['/repos/tools']};
    const lookup = {repo: 'tools', query: 'sample', hits: new Map()};
    assert.equal(context.matchesChatSearch(row, lookup), false);
    lookup.hits.set(row.key, {});
    assert.equal(context.matchesChatSearch(row, lookup), true);
    lookup.hits.clear();
    lookup.query = 'questions';
    assert.equal(context.matchesChatSearch(row, lookup), true);
    assert.equal(context.matchesChatSearch({...row, folder: '/repos/other'}, lookup), false);
    const scope = tracker._chatSearch('repo:"my repo"');
    assert.equal(scope.repo, 'my repo');
    assert.equal(scope.query, '');
    assert.equal(tracker._chatSearch('repo:"my repo"'), scope);
});

test('Chats needs the saved inventory only for a query or total activity order', () => {
    const {tracker} = fixture();
    tracker._view = 'conversations';
    tracker._chatQuery = '';
    tracker._setting = () => 'activity';
    assert.equal(tracker._needsInventory(), false);
    tracker._chatQuery = 'keyword';
    assert.equal(tracker._needsInventory(), true);
    tracker._chatQuery = '';
    tracker._setting = () => 'total';
    assert.equal(tracker._needsInventory(), true);
    tracker._setting = () => 'activity';
    tracker._view = 'history';
    assert.equal(tracker._needsInventory(), true);
});

test('review notifications announce only reasons that arrive after the first snapshot, once each', () => {
    const f = fixture();
    const shown = [];
    Object.assign(f.tracker, {_notify: (row, reasons) => shown.push([row.key, [...reasons]]), _findWindow: () => null,
        _settings: {quickReasons: ['Reply finished', 'Input needed']}});
    const row = (key, unread, at = {}) => ({key, target: true, window: 'w', provider: 'claude', project: 'p', title: key,
        unread, unread_at: at, state: 'finished', state_at: 1});
    f.tracker._notifyReviews([row('claude:a', ['Reply finished'], {'Reply finished': 10})]);
    assert.deepEqual(shown, []);
    f.tracker._notifyReviews([row('claude:a', ['Reply finished'], {'Reply finished': 10}),
        row('claude:b', ['Reply finished', 'Input needed', 'Turn failed'], {'Reply finished': 11, 'Input needed': 12, 'Turn failed': 12})]);
    assert.deepEqual(shown, [['claude:b', ['Reply finished', 'Input needed']]]);
    f.tracker._notifyReviews([row('claude:a', ['Reply finished'], {'Reply finished': 20})]);
    assert.deepEqual(shown.at(-1), ['claude:a', ['Reply finished']]);
    assert.equal(shown.length, 2);
    f.tracker._settings.notify = false;
    f.tracker._notifyReviews([row('claude:a', ['Reply finished'], {'Reply finished': 30})]);
    assert.equal(shown.length, 2);
});

test('a chat whose window has focus is not announced', () => {
    const f = fixture();
    const shown = [];
    const focused = {};
    f.context.global.display.focus_window = focused;
    Object.assign(f.tracker, {_notify: row => shown.push(row.key), _findWindow: () => focused});
    const row = at => ({key: 'claude:a', target: true, window: 'w', provider: 'claude', project: 'p', title: 't',
        unread: ['Reply finished'], unread_at: {'Reply finished': at}, state: 'finished', state_at: 1});
    f.tracker._notifyReviews([]);
    f.tracker._notifyReviews([row(5)]);
    assert.deepEqual(shown, []);
});

test('costs read as dollars and token counts', () => {
    const f = fixture();
    const {dollars, tokenCount} = f.context;
    assert.equal(dollars(0), '$0');
    assert.equal(dollars(0.004), '<$0.01');
    assert.equal(dollars(37.2), '$37.20');
    assert.equal(dollars(2249.74), '$2,250');
    assert.equal(tokenCount(2_964_089_923), '3.0B');
    assert.equal(tokenCount(408_013_714), '408.0M');
    assert.equal(tokenCount(260_774), '261k');
});

test('git rows summarize the diff and a pull request', () => {
    const f = fixture();
    const {gitDiff, gitPull} = f.context;
    assert.equal(gitDiff({diff: null}), null);
    const [text, tip] = gitDiff({diff: {files: 10, added: 120, removed: 30, top: [['a.py', 100, 10], ['b.py', 20, 20]]}});
    assert.equal(text, '+120 −30 in 10 files since the last commit');
    assert.match(tip, /^\+100 −10  a\.py\n\+20 −20  b\.py\n…and 8 more$/);
    assert.equal(gitPull({number: 7, state: 'open', draft: false, review: 'approved', checks: 'passing', title: 'Fix it'}),
        'PR #7 · open · approved · checks passing: Fix it');
    assert.equal(gitPull({number: 8, state: 'open', draft: true, review: null, checks: null, title: 'WIP'}), 'PR #8 · draft: WIP');
});

test('queue rows show what the scheduler reports: GPU reservations, memory limits, CPU time and shared-drive holds', () => {
    const f = fixture();
    const {queueResources, schedulerExtras} = f.context;
    const now = 1000;
    const cluster = {updated: 995, scheduler: {ok: true,
        pool: {backfill: true, unavailable_hosts: {'mac-1': 'owner_active'}},
        hosts: [{id: 'gpu-1', gpu_units: 2}, {id: 'mac-1', gpu_units: 0}],
        queues: [{tag: 'q1', gpu_units_per_job: 1, running_by_host: {'gpu-1': 2, 'mac-1': 0}, memory_limit_mib: 8192, blocking_reason: 'smb_high'},
            {tag: 'q2', gpu_units_per_job: 0, running_by_host: null, memory_limit_mib: null, blocking_reason: 'none'}]},
        queues: [{id: 'q1', usage: {state: 'ok', jobs: 120, cpu_hours_succeeded: 12.44, cpu_hours_failed: 0.6}},
            {id: 'q2', usage: {state: 'unknown', jobs: 0, cpu_hours_succeeded: 0, cpu_hours_failed: 0}}]};
    const q1 = queueResources({id: 'q1'}, cluster, now);
    assert.deepEqual([...q1.facts], ['GPU 1 per job · reserved gpu-1 2', 'memory limit 8 GiB per job', 'CPU 12.4 h succeeded, 0.6 h failed · 120 jobs measured']);
    assert.equal(q1.hold, 'Held: the shared drive is busy (smb_high)');
    // Nothing for a queue that uses none of it, or whose usage is unknown.
    const q2 = queueResources({id: 'q2'}, cluster, now);
    assert.equal(q2.facts.length, 0);
    assert.equal(q2.hold, null);
    // A stale snapshot keeps the queue's own settings and drops what it reported.
    const stale = queueResources({id: 'q1'}, cluster, now + 600);
    assert.deepEqual([...stale.facts], ['GPU 1 per job · reserved unknown', 'memory limit 8 GiB per job']);
    assert.equal(stale.hold, null);
    assert.deepEqual([...schedulerExtras(cluster, 'pool', 'p', now).facts], ['Backfill on']);
    assert.deepEqual([...schedulerExtras(cluster, 'host', 'gpu-1', now).facts], ['GPU 2 slots']);
    assert.equal(schedulerExtras(cluster, 'host', 'mac-1', now).warning, 'Unavailable: its owner is active');
    assert.equal(schedulerExtras(cluster, 'host', 'mac-1', now + 600).warning, null);
});

test('a refused send tells the user which chat, which limit, when it resumes, and what lifts it', () => {
    const f = fixture();
    const limits = {per_chat: 10, hourly: 10, raised: 30, raise_seconds: 3600};
    const titles = {'codex:a': 'Migrate the pool', 'claude:b': 'Update the panel'};
    const hourly = f.context.refusalNotice({kind: 'hourly', sender: 'codex:a', recipient: 'claude:b', resumes_at: null}, titles, limits);
    assert.equal(hourly.title, 'Message held');
    assert.equal(hourly.body, '⌘ Migrate the pool reached its limit of 10 messages an hour.');
    assert.equal(hourly.action, 'Allow 30 an hour, for an hour');
    const peer = f.context.refusalNotice({kind: 'peer', sender: 'codex:a', recipient: 'claude:b'}, titles, limits);
    assert.equal(peer.title, 'Message held · until you write to it');
    assert.equal(peer.body, '⌘ Migrate the pool has sent ✳ Update the panel 10 messages since you last wrote to it.');
    assert.equal(peer.action, 'Allow another round');
});

test('refusals notify once each, and none from before the panel started', () => {
    const f = fixture();
    const shown = [];
    Object.assign(f.tracker, {_ensureSource() { this._source = {showNotification: n => shown.push(n)}; }});
    const snap = refusals => ({rows: [], messages: {refusals, recent: [], limits: {per_chat: 10, hourly: 10, raised: 30}}});
    f.tracker._notifyRefusals(snap([{id: 1, kind: 'hourly', sender: 'codex:a', recipient: 'claude:b'}]));
    assert.equal(shown.length, 0);
    f.tracker._notifyRefusals(snap([{id: 2, kind: 'peer', sender: 'codex:a', recipient: 'claude:b'}, {id: 1, kind: 'hourly', sender: 'codex:a', recipient: 'claude:b'}]));
    assert.deepEqual(shown.map(n => [n.body, [...n.actions]]), [['⌘ codex:a has sent ✳ claude:b 10 messages since you last wrote to it.', ['Allow another round']]]);
});

test("a node's tooltip lists its job slots by project, and its dropdown its queues, state and events", () => {
    const f = fixture();
    const {nodeSummary, nodeQueueLines, nodeStateLines, nodeEventLine} = f.context;
    const now = Date.parse('2026-11-25T15:00:00') / 1000;
    const data = {host: 'mba', cpu_slots: 8, memory_bytes: 24 * 1024 ** 3, incomplete_fixed_slots: false,
        projects: [{project: 'omics', jobs: 6, cpu_slots: 6, memory_mib: 3072}, {project: 'fits', jobs: 0, fixed_slots: 2, cpu_slots: 2, memory_mib: null}]};
    assert.equal(nodeSummary(data), 'mba · 8 CPU slots · 24 GiB\nomics · 6 jobs · CPU 6 of 8 · memory 3 GiB\n'
        + 'fits · 2 fixed slots · CPU 2 of 8\nClick for its queues, state and recent events');
    assert.equal(nodeSummary({...data, allocations_error: 'The node report is stale'}).split('\n')[0], 'mba: The node report is stale');
    assert.deepEqual([...nodeQueueLines({jobs: 6, cpu_slots: 6, memory_mib: 3072, project: 'omics', started: now - 7500,
        done: 40, total: 120, failed: 0, workers: 18, eta: null}, now)],
        ['6 jobs here · CPU 6 · memory 3 GiB', 'omics · running 2h 5m · 40 / 120 done · 18 workers in the pool']);
    const state = {reachable: true, unavailable: null, enabled: true, admission: 'enabled', owner: 'active', cpu_units: 6, base_cpu_units: 8,
        memory_mib: 14336, base_memory_mib: 14336, gpu_units: 0, away: false, load: [7.25, 6, 5.5], swap_bytes: 5 * 1024 ** 3,
        mount: {state: 'mounted', since: now - 3600}};
    assert.deepEqual([...nodeStateLines(state, now)].map(([text, attention]) => [text, attention]), [
        ['Its owner is active: no new jobs start here', true], ['Budget 6 of 8 CPU slots · 14 GiB', false],
        ['Load 7.3 / 6.0 / 5.5 over 1, 5 and 15 min', false], ['Swap 5 GiB in use', true], ['Shared drive mounted since 2:00 PM', false]]);
    assert.equal(nodeEventLine({kind: 'failures', at: now - 600, queue: 'fits', jobs: 3, outage: 3}, now),
        '2:50 PM · 3 jobs of fits failed here (all while it was out of reach)');
    assert.equal(nodeEventLine({kind: 'outage', at: now - 600, started: now - 8100, ended: now - 600}, now),
        '12:45 PM–2:50 PM · out of reach for 2h 5m');
    assert.equal(nodeEventLine({kind: 'hold', at: now - 86400, queue: 'scans', reason: 'jobs failed in quick succession'}, now),
        'Tue 3:00 PM · scans held here: jobs failed in quick succession');
    assert.equal(nodeEventLine({kind: 'memory', at: now - 120, swap_bytes: 15.5 * 1024 ** 3, used_pct: 89,
        processes: [{command: 'Excel', bytes: 5.4 * 1024 ** 3}, {command: 'Chrome', bytes: 1.5 * 1024 ** 3}]}, now),
        '2:58 PM · swap 15.5 GiB, memory 89% used; most memory: Excel 5.4 GiB, Chrome 1.5 GiB');
});

test('the tooltip and the side dropdown share one node reading for 15 s', async () => {
    const f = fixture();
    const data = {host: 'mba', projects: []};
    f.tracker._run = async args => { f.calls.push(Array.from(args)); return data; };
    const [first, second] = await Promise.all([f.tracker._readNode('mba'), f.tracker._readNode('mba')]);
    assert.equal(first, second);
    assert.equal((await f.tracker._readNode('mba')).data, data);
    assert.deepEqual(f.calls.filter(c => c[0] === 'node'), [['node', 'mba']]);
    f.tracker._nodes.get('mba').at -= 16000;
    await f.tracker._readNode('mba');
    assert.equal(f.calls.filter(c => c[0] === 'node').length, 2);
});
