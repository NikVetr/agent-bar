<p align="center"><img src="docs/images/header.webp" alt="Agent Bar: AI coding agents trading notes at a bar" width="820"></p>

# Agent Bar

If you have a Claude chat open in one VS Code window and Codex working in another, which one just finished?
Agent Bar puts the answer in the GNOME top bar, with a macOS menu bar version planned. Click the project to go straight to the chat, even when it shares a
window with several others. It also follows agents in terminals and desktop apps. You can add GitHub pull requests,
Claude quota checks, and ROTA job queues to the same bar.

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/click-to-chat-dark.webp">
  <img src="docs/images/click-to-chat-light.webp" alt="Clicking a chat's review button brings its VS Code window forward, maximized, with that chat showing; clicking the chat again in the dropdown sends the window back" width="820">
</picture></p>

## Overview

**The top bar.** Read each provider’s count as *chats needing review / chats open*. Beside it you can see how much
weekly quota remains. You can also see how many chats are working, waiting, or need a prompt to read their mail,
how many tickets are ready, and how many queues have finished. Project buttons take you to chats that need review.

<p><img src="docs/images/topbar.webp" alt="The top bar: counts per provider, limits left, working and waiting, mail, tickets, queues, and review buttons" width="100%"></p>
<p><img src="docs/images/notification.webp" alt="A desktop notification: Codex · sampler-study, Reply finished" width="420"></p>

**Chats and History.** Chats groups open conversations by project and window. Each row tells you what the agent
is doing, why it needs review, and its estimated cost at API prices where available. History also includes saved
Claude Code and Codex chats you’ve closed. You can resume one or export its messages.

<p><img src="docs/images/chats.webp" alt="The Chats tab" width="49%"> <img src="docs/images/history.webp" alt="History search with context" width="49%"></p>

Remember what you discussed but not which chat it was in? Search for words you or the agent wrote.
**Show context** opens the conversation around a match. Use the arrows to read the next one.

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/history-search-dark.webp">
  <img src="docs/images/history-search-light.webp" alt="Searching History for words in saved conversations, then showing a hit's context" width="820">
</picture></p>

**Messages and tickets.** Claude and Codex chats can leave each other notes, even across projects. You can also schedule
a message yourself, or write a ticket for work that has to wait for a quota reset, a project’s queues, or a particular time.

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/agent-messages-dark.webp">
  <img src="docs/images/agent-messages-light.webp" alt="A Codex chat sends a Claude Code chat a message with agent-bar send; the Claude chat sees it at its next turn" width="820">
</picture></p>
<p><img src="docs/images/messages.webp" alt="The Messages tab" width="49%"> <img src="docs/images/tickets.webp" alt="The Tickets tab" width="49%"></p>

**Quota, Git, and Info.** Quota shows the five-hour, weekly, and model-specific limits each provider reports.
The forecast tells you whether you’re on course to run out before the reset. You can also see what your usage would
cost at API prices. Git shows what you’ve changed locally, what you still need to push, and (if you enable it) the
branch’s pull request and checks. Info lists the hooks, skills, and instruction files for each project.

<p><img src="docs/images/quota.webp" alt="The Quota tab" width="32%"> <img src="docs/images/git.webp" alt="The Git tab" width="32%"> <img src="docs/images/info.webp" alt="The Info tab" width="32%"></p>

**Queues and Cluster.** If you run jobs with ROTA, you can check or adjust a project’s queues from the top bar.
Open Cluster to see how busy each host is and how much memory and disk space it has left.

<p><img src="docs/images/queues.webp" alt="The Queues tab" width="49%"> <img src="docs/images/cluster.webp" alt="The Cluster tab" width="49%"></p>

The [user guide](docs/guide.md) describes every part in detail.

## Supported agents

| | Claude Code | Codex | GitHub Copilot CLI | Antigravity |
| --- | --- | --- | --- | --- |
| Where | VS Code, terminal | VS Code (tabs and sidebar), terminal, ChatGPT desktop app | terminal | IDE, App, CLI (`agy`) |
| Status and review | yes | yes | yes | yes |
| Usage limits and cost | yes | yes | | |
| Messages and scheduled messages | yes; can wake idle chats (opt-in) | yes; can wake chats open in VS Code (opt-in) | | |
| History search, resume, and export | yes | yes | | |

## Where it fits

```mermaid
flowchart TD
    start(["How do you run your coding agents?"])
    start -->|"A tool starts and runs them"| orch["Orchestrators and session managers<br/>Agent Deck, Claude Squad, Conductor, Orca"]
    start -->|"Inside one vendor's app"| first["First-party views<br/>Claude Code agent view, Codex app,<br/>VS Code Agents window"]
    start -->|"In the VS Code windows, terminals<br/>and apps you already use"| need{"What do you need most?"}
    need -->|"Limits and spending"| meters["Usage meters<br/>CodexBar, ccusage, Claude HUD"]
    need -->|"Search saved chats"| search["History tools<br/>cass, Agent Sessions,<br/>Agent Bar's History tab"]
    need -->|"Which chats need you, one click to each,<br/>and agents messaging each other"| desk{"Which desktop?"}
    desk -->|"Linux, GNOME"| ab(["Agent Bar"])
    desk -->|"macOS"| mac["Open Island, Vibe Island<br/>(Agent Bar's menu bar planned)"]
    classDef ours fill:#1f6feb,stroke:#1f6feb,color:#ffffff
    class ab ours
```

[How Agent Bar compares](docs/comparison.md) has the feature table and the projects behind each box.

## Platforms

| Platform | Where it appears | Status |
| --- | --- | --- |
| Linux, GNOME Shell 42 (Ubuntu 22.04), X11 | the top bar | available |
| Linux, GNOME Shell 45 and later | the top bar | planned |
| macOS | the menu bar | planned |
| Windows | the system tray | planned |

## Install

You’ll need Python 3.10 or later and either [pipx](https://pipx.pypa.io) or [uv](https://docs.astral.sh/uv/).
If your agents run in terminals, you can leave VS Code out of the installation.

```
pipx install git+https://github.com/NikVetr/agent-bar
agent-bar install
```

The installer sets these up for your user account:

- A background service (`agent-bar.service`) and a daily scan of saved chats.
- Hooks for Claude Code and Codex, if you use them. The installer backs up the settings file and keeps your existing hooks.
- The `agent-messages` skill, which teaches agents to use messages and tickets. An existing skill of the same name takes precedence.
- A small VS Code extension (the bridge) that reports which chats each window has open.
- The GNOME Shell extension that draws the top bar and dropdown.

On the first install, log out and back in so GNOME finds the extension (on X11 you can also press Alt+F2, type `r`,
and press Enter). Run `agent-bar install` again to enable it. Open VS Code windows start the bridge on their own.
After an update, use **Developer: Reload Window** in each one to pick up the new bridge. Codex asks you to review
new hooks once with `/hooks`.

If something is missing, `agent-bar doctor` will tell you which part and suggest a fix. To remove Agent Bar, run
`agent-bar uninstall`. This keeps your settings and history unless you add `--purge`.

## Documentation

- [User guide](docs/guide.md): the top bar, every tab, messages, tickets, scheduled messages, task checklists, the
  scheduler integration, the command line, and troubleshooting.
- [How Agent Bar compares](docs/comparison.md): related projects, what each offers, and where Agent Bar fits.
- [Architecture](docs/architecture.md): how the service, hooks, VS Code bridge, and menu-bar front end fit together.

## Privacy

The History index contains the words you and the agents wrote. It leaves out tool calls and results, reasoning,
and client context. Hooks record turn events (starts, finishes, questions, approvals, failures) without what
you or the agent wrote. State lives in
`~/.local/state/agent-bar`, settings in `~/.config/agent-bar`, and the VS Code bridge build in `~/.cache/agent-bar`.

Two optional settings contact a service outside your machine:

- **Read Claude limits** checks `api.anthropic.com` every 10 minutes, using Claude Code’s token from
  `~/.claude/.credentials.json`. Claude Code handles token renewal.
- **Pull requests** uses your signed-in `gh` command to read pull request reviews and check results at most once every five
  minutes per branch.

## Development

```
git clone https://github.com/NikVetr/agent-bar && cd agent-bar
pipx install --editable .
python3 -m unittest discover tests
node --test tests/panel.test.js
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

<p align="center"><img src="docs/images/footer.webp" alt="" width="640"></p>
