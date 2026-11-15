# Agent Bar

Agent Bar puts your open AI coding agent chats in your desktop's menu bar. You can see at a glance which ones have
finished and need your review, which are still working, and which are waiting on you, and one click brings a chat's
window forward. It also shows your projects' git status, lets agents in different chats leave each other notes, and
can follow job queues from the optional parallel-workers scheduler.

It reads only local files that the agent tools already write, plus small hooks that record when a turn starts and
ends. Nothing leaves your computer.

## What it tracks

| Agent | Where |
| --- | --- |
| Claude Code | VS Code tabs and the terminal CLI |
| Codex | VS Code (tabs and sidebar), the terminal CLI, and the ChatGPT desktop app's Codex tab |
| GitHub Copilot CLI | the terminal |
| Antigravity | its IDE, App and CLI (`agy`) |

## Platforms

| Platform | Where it appears | Status |
| --- | --- | --- |
| Linux, GNOME Shell 42 (Ubuntu 22.04), X11 | the top bar | available |
| Linux, GNOME Shell 45 and later | the top bar | in progress |
| macOS | the menu bar | in progress |
| Windows | the system tray | in progress |

The service, command line, hooks and VS Code bridge are shared by every platform; each platform has its own small
menu-bar front end.

## Requirements

- Python 3.10 or later, and [pipx](https://pipx.pypa.io) or [uv](https://docs.astral.sh/uv/) to install it.
- VS Code, for chats in VS Code. The CLI and app surfaces work without it.

## Install

```
pipx install git+https://github.com/NikVetr/agent-bar
agent-bar install
```

`agent-bar install` sets up, for your user only:

- a background service (`agent-bar.service`) and a daily inventory scan of saved chats;
- hooks in Claude Code's and Codex's settings, if you use them (your existing hooks are kept, and the old settings
  file is backed up first);
- the VS Code bridge, a small extension that tells Agent Bar which chats each window has open;
- the menu-bar front end: on Linux, the GNOME Shell extension. The first time, log out and back in (or on X11 press
  Alt+F2, type `r`, press Enter) so GNOME finds it, then run `agent-bar install` again to enable it.

Open VS Code windows start the bridge on their own; after an update, reload each one (Developer: Reload Window) to
run the new version. Codex asks you to review new hooks once with `/hooks`.

`agent-bar doctor` checks each part and says how to fix anything missing. `agent-bar uninstall` takes it all out
again, leaving your history and settings (`--purge` deletes those too).

## The menu bar

- **✳ 2 / 14** and **⌘ 0 / 9**: Claude and Codex chats needing review / open. Copilot (◆) and Antigravity (▲) counts
  appear while one of their chats is open. A chat needs review when a reply finishes, a turn fails, it asks you a
  question or for approval, or all of its project's queues finish. Opening it from Agent Bar, answering it, or sending
  it a message clears that.
- **✳ 12%  ⌘ 64%**: what is left of each provider's weekly usage limit, amber under 25% and red under 10%, dimmed when
  the reading is over 6 hours old. Hovering lists every limit; clicking opens the Quota tab.
- **● 3** working, **◌ 1** waiting: a turn that has gone quiet, or ended with background work still pending.
- **✉ 2**: chats where messages from other agents wait for you to start a turn, with no wake-up coming: waking off,
  a Claude chat idle over a week, or a Codex chat not open in VS Code. Clicking it opens the Messages tab.
- **Q 2 / 5**: queues finished / outstanding since each project's last turn, with the scheduler integration.
- Each part lights on its own and opens the dropdown on its tab: the chat counts on Chats, Q on Queues, ✉ on Messages,
  the limits on Quota, the cluster indicator on Cluster. With the dropdown open, clicking another part switches tabs;
  clicking the open tab's part, or anywhere else, closes it.
- **▾**: every window with a chat, with a dot for its most urgent state; click one to bring it forward. Below
  them, **New VS Code window** opens one maximized on your main display, and **Saved chats** opens History.
- **Shortcut buttons**: chats needing review get a button that brings them forward, the longest waiting first, as
  many as fit, continuing right of the middle when the left half is full; **+2 more** lists the rest. **Settings › Top bar** sets the most buttons and
  which reasons give one: a finished or failed reply, a question or approval, finished queues.

Clicking the counts opens the dropdown, with these tabs:

- **Chats**: open chats grouped by project and window, with sort and filter, each with its whole name and a copy button
  for its name, id, folder and resume command. Clicking a chat selects it and brings its window forward; clicking again sends the window back. When a usage limit stops chats open in VS Code, a line above
  them names them and when Claude's limit resets; **Continue** queues "Please continue where you left off." in the
  Codex ones, which start it on their own, and brings each Claude one forward with that text at the end of its input
  box, after any draft, for you to send. If Agent Bar cannot be sure the cursor is in that box (several Claude chats on
  show in the window, or a bridge from before this feature), it leaves the text on the clipboard instead.
- **Queues**: job queues from parallel-workers, by project, with progress, ETA and failed jobs. A project's finished
  queues count until a chat there starts a turn, or until you press Clear beside the project. **Adjust** on a queue,
  and under **Pool and hosts**, changes what the scheduler offers there (see below).
- **Git**: each repository holding an open project, with its branch, uncommitted files, and commits ahead of or
  behind its upstream (as of the last fetch; Agent Bar never fetches or takes git's lock). Clicking one opens VS
  Code's Source Control for it.
- **Messages**: notes between agents, as threads.
- **History**: every saved Claude and Codex chat, including closed ones, with the same copy button; Resume reopens one
  in its folder.
- **Quota**: each provider's usage limits as Claude Code and Codex record them on this computer: the weekly limit, the
  5-hour one, and a weekly limit for one model such as Fable, with that model's share. Each shows what is left, when it
  resets, its pace over the last day (or this window's average), when that pace would use the rest and how that compares
  with the reset, and, for the weekly limit, the points used each day, split by model where Claude Code reports a share.
  Claude Code refreshes its figures only when it fetches them, as `/usage` does, so they can be hours old; with
  **Settings › Integrations › Read Claude limits** on, Agent Bar reads them itself every 10 minutes. Codex records its
  own as it works. Copilot and Antigravity record none on this computer.
- **Info**: your skills (start a new chat with one), the health of Agent Bar's own hooks and bridges, and the AGENTS.md
  or CLAUDE.md files each project uses.

**?** opens a guide to every symbol and color, at the part about the tab you were on; the gear opens settings,
including a color-blind-safe palette.
Clicking a chat shows its window maximized on your main display.

## Messages between agents

An agent in one chat can leave a note for an agent in another, across projects and providers:

```
agent-bar agents                  # open chats a message can go to
agent-bar send <key> "text"       # message one of them
agent-bar inbox                   # read this chat's messages
```

The recipient sees a one-line note with its unread count when its next turn starts. With **Wake idle chats** on in
settings, a new message also starts a turn in an idle Claude Code chat (up to a week after its last turn) and in a
Codex chat open in VS Code (after any turn in progress ends, and only if the message is still unread then; this
needs the `codex` command with `codex queue`).
Other chats wait for their next turn. Copilot and Antigravity chats cannot receive messages, because they have no
hook to show the note. In the Messages tab, each chat's badge shows a sealed envelope while it has unread messages,
amber when they wait for you to start a turn there, and an open one once it has read them.

Each message goes to one chat; there is no broadcast. A loop guard refuses a fourth message to the same chat until you
write to the sender again, and more than 10 an hour; you can lift it from the Messages tab. Agents are told to treat
messages as information, not as your instructions. You can turn messages off in settings.

## Optional: the parallel-workers scheduler

The Queues tab, the Q count and the cluster indicator read the files the parallel-workers job scheduler writes in
`~/.local/state/parallel-workers`. Without it they stay out of the way; **Settings › Integrations** turns them off
entirely.

The cluster indicator shows any of the cluster's CPU, memory and fullest disk. CPU counts the cores each host
allots to jobs (its job slots); its other cores are reserved and take its load first. When a host is under memory pressure,
has a drive nearly full, or is unreachable or without the shared mount, it adds a small sign for that kind of
warning, amber or red when critical, with a count of any others. **Settings › Cluster** picks what it shows and the
warning thresholds; with only warnings picked, it appears just when one fires. Clicking it opens the **Cluster** tab,
headed by the cluster's CPU, busy cores and memory, which names each warning's host; **Snooze** keeps a warning off the top bar until it clears, or for at most a time you type (such as 5d or
120h); parallel-workers keeps checking the host meanwhile. The tab also lists each host's cores, memory and
disks, and failed jobs by project, with a note to copy for that project's agent and buttons that bring its VS Code
window forward. The shared drive's card names the host serving it and shows the scheduler's job slots in use, and
the drive's throughput and that host's network over the last 10 minutes.

When parallel-workers' `pw-control` command is installed (on `PATH` or in `~/.local/bin`), the Queues tab also changes
the scheduler. **Adjust** opens what `pw-control describe` offers for a queue, the pool or a host: actions such as
pausing a queue or draining the pool as buttons, and settings such as priority, worker cap, memory and a host's budget
one to a row. Hovering a setting's ⓘ or a button says what it does, or why it is unavailable now. Edited settings go
together with **Apply**, each through `pw-control apply` with the value shown, so one changed meanwhile is refused.
Irreversible actions, such as Drain, ask first. A change shows once the collector next reads the scheduler, within
about 30 s.

## Command line

Everything the menu bar shows is available as JSON:

```
agent-bar status        # open chats, their states and counts
agent-bar queues        # queues and their progress
agent-bar git           # git status of repositories holding open projects
agent-bar info          # skills, hook health, instruction files
agent-bar usage         # usage limits, with pace, run-out time and use by day
agent-bar inventory     # rescan saved chats
agent-bar resume <key>  # reopen a saved chat in VS Code
```

## Privacy

On Linux, Agent Bar keeps its state in `~/.local/state/agent-bar` and its settings in `~/.config/agent-bar`, readable
only by you. Its hooks record when turns start and end, never prompt or reply text. It contacts no server, unless you
turn on **Read Claude limits**: then every 10 minutes it asks Anthropic's usage endpoint (`api.anthropic.com`, the one
Claude Code's `/usage` reads, which is undocumented) for your limits, sending Claude Code's sign-in token from
`~/.claude/.credentials.json`. It never renews or changes that sign-in; when it has expired, Agent Bar waits for Claude
Code to renew it.

## Development

```
git clone https://github.com/NikVetr/agent-bar && cd agent-bar
pipx install --editable .
python3 -m unittest discover tests
node --test tests/panel.test.js
```

[docs/architecture.md](docs/architecture.md) describes how the parts fit together.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
