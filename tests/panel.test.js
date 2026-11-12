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
                panelMenu: {}, popupMenu: {}},
            byteArray: {toString: value => value},
        },
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
    f.tracker._buildQuick = (signature, rows) => {
        f.tracker._quickSignature = signature;
        shown.push(rows.map(r => r.key).join(','));
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
        {key: 'claude:a', provider: 'claude', target: {kind: 'tab'}, limited},
        {key: 'claude:c', provider: 'claude', target: {kind: 'window'}, limited},
        {key: 'codex:d', provider: 'codex', target: {kind: 'tab'}, limited: null}];
    assert.equal(f.context.limitedConversations(rows).map(r => r.key).join(','), 'codex:b,claude:a');
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

test('scheduler control inputs give the values pw-control apply takes, or say what to fix', () => {
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
    f.tracker._control = async () => { throw new Error('pw-control is not installed'); };
    assert.deepEqual(JSON.parse(JSON.stringify(await f.tracker._applyControl({kind: 'pool', id: 'pool-1'}, control, null))),
        {ok: false, error: {code: 'failed', message: 'pw-control is not installed'}});
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
