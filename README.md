# Agent Bar

Agent Bar puts your open AI coding agent chats in the GNOME top bar. You can see at a glance which ones have
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

## Requirements

- Linux with GNOME Shell 42 (Ubuntu 22.04), on X11. Newer GNOME releases, macOS and Windows are planned.
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
- the GNOME Shell extension. The first time, log out and back in (or on X11 press Alt+F2, type `r`, press Enter) so
  GNOME finds it, then run `agent-bar install` again to enable it.

Open VS Code windows pick up the bridge when reloaded (Developer: Reload Window). Codex asks you to review new hooks
once with `/hooks`.

`agent-bar doctor` checks each part and says how to fix anything missing. `agent-bar uninstall` takes it all out
again, leaving your history and settings (`--purge` deletes those too).

## The top bar

- **✳ 2 / 14** and **⌘ 0 / 9**: Claude and Codex chats needing review / open. Copilot (◆) and Antigravity (▲) counts
  appear while one of their chats is open. A chat needs review when a reply finishes, a turn fails, it asks you a
  question or for approval, or all of its project's queues finish. Opening it from Agent Bar, answering it, or sending
  it a message clears that.
- **● 3** working, **◌ 1** waiting: a turn that has gone quiet, or ended with background work still pending.
- **Q 2 / 5**: queues finished / outstanding since each project's last turn, with the scheduler integration.
- **▾**: every window with a chat, with a dot for its most urgent state; click one to bring it forward.
- **Shortcut buttons**: while only a few chats need review, each gets a button that brings it forward.

Clicking the counts opens the dropdown, with these tabs:

- **Chats**: open chats grouped by project and window, with sort and filter. Clicking a chat selects it and shows its
  window maximized on your main display; clicking again sends the window back.
- **Queues**: job queues from parallel-workers, by project, with progress, ETA and failed jobs.
- **Git**: each repository holding an open project, with its branch, uncommitted files, and commits ahead of or
  behind its upstream (as of the last fetch; Agent Bar never fetches or takes git's lock). Clicking one opens VS
  Code's Source Control for it.
- **Messages**: notes between agents, as threads.
- **History**: every saved Claude and Codex chat, including closed ones; Resume reopens one in its folder.
- **Info**: your usage limits as Claude Code and Codex last recorded them, your skills (start a new chat with one), the
  health of Agent Bar's own hooks and bridges, and the AGENTS.md or CLAUDE.md files each project uses.

**?** opens a guide to every symbol and color; the gear opens settings, including a color-blind-safe palette.

## Messages between agents

An agent in one chat can leave a note for an agent in another, across projects and providers:

```
agent-bar agents                  # open chats a message can go to
agent-bar send <key> "text"       # message one of them
agent-bar inbox                   # read this chat's messages
```

The recipient sees a one-line note with its unread count when its next turn starts. With **Wake idle Claude chats**
on in settings, an idle Claude Code chat is also woken by a new message. Codex cannot be woken from outside, so it
waits for its next turn. Copilot and Antigravity chats cannot receive messages, because they have no hook to show the
note.

Each message goes to one chat; there is no broadcast. A loop guard refuses a fourth message to the same chat until you
write to the sender again, and more than 10 an hour; you can lift it from the Messages tab. Agents are told to treat
messages as information, not as your instructions. You can turn messages off in settings.

## Optional: the parallel-workers scheduler

The Queues tab, the Q count and the cluster CPU indicator read the files the parallel-workers job scheduler writes in
`~/.local/state/parallel-workers`. Without it they stay out of the way; **Settings › Integrations** turns them off
entirely.

## Command line

Everything the top bar shows is available as JSON:

```
agent-bar status        # open chats, their states and counts
agent-bar queues        # queues and their progress
agent-bar git           # git status of repositories holding open projects
agent-bar info          # skills, usage limits, hook health, instruction files
agent-bar inventory     # rescan saved chats
agent-bar resume <key>  # reopen a saved chat in VS Code
```

## Privacy

Agent Bar keeps its state in `~/.local/state/agent-bar` and its settings in `~/.config/agent-bar`, readable only by
you. Its hooks record when turns start and end, never prompt or reply text. It contacts no server.

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
