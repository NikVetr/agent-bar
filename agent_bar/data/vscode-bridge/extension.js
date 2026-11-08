const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');

const CLAUDE_PANEL = 'mainThreadWebview-claudeVSCodePanel';

// Owner-only files are the transport. No TCP listener, credentials, transcript
// contents, or arbitrary command execution crosses this interface.
async function activate(context) {
    const root = path.join(os.homedir(), '.local/state/agent-bar');
    for (const dir of ['windows', 'requests', 'responses', 'resume'])
        await fs.mkdir(path.join(root, dir), {recursive: true, mode: 0o700});
    const id = crypto.randomUUID();
    const file = path.join(root, 'windows', `${id}.json`);
    const requestFile = path.join(root, 'requests', `${id}.json`);
    let busy = false, resuming = false, publishing = false, nativeId = null, disposed = false;
    const tabs = () => vscode.window.tabGroups.all.flatMap(group =>
        group.tabs.map((tab, index) => ({
            column: group.viewColumn, index, label: tab.label, active: tab.isActive,
            viewType: tab.input?.viewType || null,
            uri: tab.input?.uri?.toString() || null,
        })));
    async function atomic(filename, value) {
        await fs.writeFile(`${filename}.next`, JSON.stringify(value), {mode: 0o600});
        await fs.rename(`${filename}.next`, filename);
    }
    async function publish() {
        if (publishing || disposed) return;
        publishing = true;
        try {
            await atomic(file, {
                schema: 1, id, pid: process.pid, updated: Date.now() / 1000,
                workspace: vscode.workspace.name || 'Empty window',
                roots: (vscode.workspace.workspaceFolders || []).map(x => x.uri.fsPath),
                storage: context.storageUri?.fsPath || null,
                log: context.logUri.fsPath, focused: vscode.window.state.focused,
                nativeId, tabs: tabs(), resume: true, scm: true,
                providers: Object.fromEntries(['openai.chatgpt', 'Anthropic.claude-code']
                    .map(key => [key, vscode.extensions.getExtension(key)?.packageJSON.version || null])),
            });
        } finally { publishing = false; }
    }
    function captureNativeWindow() {
        if (!vscode.window.state.focused) return;
        execFile('/usr/bin/xprop', ['-root', '_NET_ACTIVE_WINDOW'], {timeout: 1000}, (err, text) => {
            if (err || !vscode.window.state.focused) return;
            const xid = text.match(/0x[0-9a-f]+/i)?.[0];
            if (!xid || xid === '0x0') return;
            execFile('/usr/bin/xprop', ['-id', xid, 'WM_CLASS', '_NET_WM_NAME'], {timeout: 1000}, (error, value) => {
                // During a focus switch the active window can still be another VS Code
                // window; its title names a different workspace.
                // A window without a folder is titled by its active editor alone.
                const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
                const titled = vscode.workspace.name
                    ? value?.includes(` - ${vscode.workspace.name} - Visual Studio Code"`)
                        || value?.includes(`"${vscode.workspace.name} - Visual Studio Code"`)
                    : value?.includes(label ? `${label} - Visual Studio Code"` : '"Visual Studio Code"');
                if (!error && titled && /code_code|"Code"/.test(value) && vscode.window.state.focused) {
                    nativeId = xid;
                    publish().catch(report);
                }
            });
        });
    }
    const log = vscode.window.createOutputChannel('Agent Bar');
    const report = error => log.appendLine(String(error));
    async function navigate(action) {
        const target = action.target;
        if (target.kind === 'tab') {
            const group = vscode.window.tabGroups.all.find(g => g.viewColumn === target.column);
            const tab = group?.tabs[target.index];
            if (!tab || tab.label !== target.label || tab.input?.viewType !== target.viewType)
                throw new Error('The tab changed. Refresh Agent Bar and try again.');
            if (target.uri && tab.input?.uri?.toString() !== target.uri)
                throw new Error('The conversation URI changed.');
            if (target.uri) {
                await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(target.uri),
                    target.viewType, {viewColumn: target.column, preserveFocus: false, preview: false});
            } else {
                // Reveal an existing webview without opening another conversation.
                const commands = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
                if (target.column < 1 || target.column > commands.length)
                    throw new Error('This editor group is not supported for exact navigation.');
                await vscode.commands.executeCommand(`workbench.action.focus${commands[target.column - 1]}EditorGroup`);
                await vscode.commands.executeCommand('workbench.action.firstEditorInGroup');
                for (let i = 0; i < target.index; i++)
                    await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
            }
            if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab)
                throw new Error('VS Code did not select the requested tab.');
            // Claude Code's Focus Input focuses every Claude chat on show, so only with this one alone on show
            // is its input box surely the one with the cursor.
            if (action.input && target.viewType === CLAUDE_PANEL && vscode.window.tabGroups.all
                .filter(g => g.activeTab?.input?.viewType === CLAUDE_PANEL).length === 1) {
                await vscode.commands.executeCommand('claude-vscode.focus');
                return {input: true};
            }
        } else if (target.kind === 'codex-sidebar') {
            // The service only supplies this target for the single known sidebar
            // conversation; it never opens a historical chat in another surface.
            await vscode.commands.executeCommand('chatgpt.openSidebar');
        } else {
            throw new Error('Conversation has no verified navigation target.');
        }
    }
    async function poll() {
        if (busy || disposed) return;
        busy = true;
        try {
            let action;
            try { action = JSON.parse(await fs.readFile(requestFile, 'utf8')); }
            catch (error) { if (error.code === 'ENOENT') return; throw error; }
            await fs.unlink(requestFile);
            if (!/^[a-f0-9-]{36}$/.test(action.id)) throw new Error('Invalid action ID');
            let result;
            try {
                if (action.expires < Date.now() / 1000) throw new Error('Navigation expired');
                if (action.type === 'navigate') result = {ok: true, ...await navigate(action)};
                else if (action.type === 'scm') await vscode.commands.executeCommand('workbench.view.scm');
                else throw new Error('Unsupported action');
                result ??= {ok: true};
            } catch (error) { result = {ok: false, error: String(error.message || error)}; }
            await atomic(path.join(root, 'responses', `${action.id}.json`), result);
            await publish();
        } catch (error) { report(error); }
        finally { busy = false; }
    }
    // `agent-bar resume` leaves a request naming a folder; the first
    // window on that folder to delete the file reopens the conversation.
    async function reopen(request) {
        if (!/^[a-f0-9-]{36}$/.test(request.conversation)) throw new Error('Invalid conversation ID');
        if (request.provider === 'claude') {
            await vscode.commands.executeCommand('claude-vscode.editor.open', request.conversation);
        } else if (request.provider === 'codex') {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.from({scheme: 'openai-codex',
                authority: 'route', path: `/local/${request.conversation}`}), 'chatgpt.conversationEditor', {preview: false});
        } else {
            throw new Error('Unsupported provider');
        }
    }
    async function pollResume() {
        const roots = (vscode.workspace.workspaceFolders || []).map(x => x.uri.fsPath);
        if (resuming || disposed || !roots.length) return;
        resuming = true;
        try {
            for (const name of await fs.readdir(path.join(root, 'resume'))) {
                if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
                const file = path.join(root, 'resume', name);
                let request;
                try { request = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
                if (!roots.includes(request.folder) || `${request.id}.json` !== name) continue;
                try { await fs.unlink(file); } catch { continue; }
                let result;
                try {
                    if (request.expires < Date.now() / 1000) throw new Error('Resume request expired');
                    await reopen(request);
                    result = {ok: true};
                } catch (error) { result = {ok: false, error: String(error.message || error)}; }
                await atomic(path.join(root, 'responses', `${request.id}.json`), result);
            }
        } catch (error) { report(error); }
        finally { resuming = false; }
    }
    const heartbeat = setInterval(() => publish().catch(report), 4000);
    const requests = setInterval(poll, 300);
    const resumes = setInterval(pollResume, 1000);
    context.subscriptions.push(log,
        vscode.window.tabGroups.onDidChangeTabs(() => publish().catch(report)),
        vscode.window.tabGroups.onDidChangeTabGroups(() => publish().catch(report)),
        vscode.window.onDidChangeWindowState(() => { captureNativeWindow(); publish().catch(report); }),
        {dispose() { disposed = true; clearInterval(heartbeat); clearInterval(requests); clearInterval(resumes); fs.unlink(file).catch(() => {}); }});
    captureNativeWindow();
    await publish();
}
exports.activate = activate;
