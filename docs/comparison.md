# How Agent Bar compares

Agent Bar follows chats opened in VS Code, terminals and desktop apps across providers. This comparison focuses
on session discovery, opening an existing chat, and coordination across chats. The survey reflects project
documentation reviewed on November 24, 2026.

## At a glance

✓ has it · ◐ partly · blank: not found in the project's documentation, or not applicable.

| | Watches chats opened elsewhere | Live status | Focus the exact chat | Usage limits | Agent messages | Deferred tasks | Scheduled prompts | History search | Linux |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Agent Bar** | ✓ | ✓ | ✓ | ✓ with forecast | ✓ Claude and Codex | ✓ | ✓ Claude and Codex | ✓ | ✓ GNOME 42 |
| Claude Code (built in) | | ◐ background sessions | | ◐ | ✓ Claude only | ◐ | ✓ | ◐ resume picker | ✓ |
| Codex app (built in) | | ◐ | | ◐ | | | ✓ Codex only | ◐ resume picker | ✓ |
| Agent Deck | | ✓ | ✓ its sessions | ◐ | ✓ its sessions | | ◐ | ✓ | ✓ |
| Orca | | ✓ | ✓ its sessions | ◐ | ◐ | ◐ | ✓ | | ✓ |
| Herdr | | ✓ | ◐ | | ✓ its sessions | | | | ✓ |
| Claude Squad | | | ◐ | | | | | | ✓ |
| cmux | | ✓ | ✓ its sessions | | | | | | |
| Conductor | | ◐ | ◐ | ✓ | | | | | |
| CodexBar | ◐ opt-in | ◐ active or idle | ◐ | ✓ with forecast | | | | | ◐ Qt app |
| Open Island / Vibe Island | ✓ | ✓ | ◐ | ◐ | | | | | |
| Agent Sessions | ✓ | ◐ | | ◐ | | | | ✓ | |
| GNOME usage extensions | | | | ◐ | | | | | ✓ GNOME 45+ |
| MCP Agent Mail | | ◐ | | | ✓ by polling | | | | ✓ |
| Beads | | | | | | ✓ | | | ✓ |
| cass | | | | | | | | ✓ | ✓ |

## Choosing a tool

- **Monitor existing chats on Linux GNOME.** Agent Bar focuses a specific VS Code chat, tracks quotas and job
  queues, and lets Claude and Codex exchange messages. Tickets can wait for a quota reset or a project’s queues.
- **Launch isolated workspaces.** Claude Squad, Agent Deck, Conductor and Orca start agents in their own sessions
  or worktrees. Several include diff review and merge tools.
- **Monitor quotas across more providers.** CodexBar and other usage meters focus on limits and spending.
- **Search or coordinate across machines.** See cass for semantic history search, Beads for shared task graphs,
  and MCP Agent Mail for file reservations and messaging.

The [project list](#projects-surveyed) links to the sources, including tools for other desktops and vendor-specific features.

## Using Agent Bar with other tools

- **Status lines, usage reports and notifiers** (ccstatusline, Claude HUD, ccusage, peon-ping) read the same local
  files or run as separate hooks. They work alongside Agent Bar, which keeps existing hooks when it installs its own.
- **First-party features** stay available. Claude Code's cross-session messaging and Agent Bar's messages are separate
  channels; Agent Bar's also reaches Codex chats.
- **Orchestrators** start agents that still write their usual transcripts and run their configured hooks. Agent Bar
  has not been tested with them. It focuses native windows, so it cannot select a pane or tab inside an
  orchestrator.
- **History tools** read the same saved conversations and can run side by side.

## Projects surveyed

### Orchestrators and session managers

- [Agent Deck](https://github.com/asheshgoplani/agent-deck): terminal UI on tmux for many agents, with status, usage
  limits, messaging, transcript search and cost. MIT. macOS, Linux, WSL.
- [Claude Squad](https://github.com/smtg-ai/claude-squad): terminal UI that runs agents in tmux and git worktrees.
  AGPL-3.0. macOS, Linux.
- [CCManager](https://github.com/kbwo/ccmanager): terminal session manager for about ten agent CLIs, with worktrees
  and busy, waiting and idle states. MIT.
- [cmux](https://github.com/manaflow-ai/cmux): Ghostty-based terminal for agents, with attention rings and branch
  status. GPL-3.0-or-later. macOS.
- [Conductor](https://conductor.build): desktop app running Claude Code and Codex in isolated workspaces, with usage
  limits, resume after reset, diffs and pull requests. Proprietary. macOS.
- [Emdash](https://github.com/generalaction/emdash): desktop app sending issues to agents in worktrees. Apache-2.0. macOS, Windows, Linux.
- [Herdr](https://github.com/herdrdev/herdr): terminal multiplexer that owns agents' terminals, with states,
  notifications and agents prompting each other. Apache-2.0. macOS, Linux, Windows.
- [Nimbalyst](https://github.com/nimbalyst/nimbalyst): desktop workspace with a session board,
  worktrees and session search. MIT. macOS, Windows, Linux, iOS.
- [opcode](https://github.com/winfunc/opcode): desktop app for Claude Code with history, usage
  and cost analytics. AGPL-3.0.
- [Orca](https://github.com/stablyai/orca): desktop app for about 35 agent CLIs, with worktrees, status, usage limits,
  automations and mobile apps. MIT. macOS, Windows, Linux.
- [Paradev](https://github.com/ParadevAI/Paradev): desktop app running agents in worktrees, with
  automations on paid plans. MIT. macOS, Linux (experimental).
- [Sculptor](https://github.com/imbue-ai/sculptor): desktop app running agents in isolated worktrees, with diff review
  and merge. MIT. macOS, Linux.
- [T3 Code](https://github.com/pingdotgg/t3code): desktop, web and mobile client for several agents, with per-thread
  worktrees. MIT.
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban): kanban board that runs agents in worktrees; community
  maintained since its company closed. Apache-2.0.

### First-party surfaces

- [Claude Code](https://code.claude.com/docs/en/agent-view): agent view for background sessions,
  [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) between Claude sessions,
  [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks), and automatic continuation after a usage-limit
  reset.
- [Codex app](https://learn.chatgpt.com/docs/automations): scheduled tasks, including ones that return to an existing
  chat, managed from the ChatGPT desktop app or web.
- [VS Code Agents window](https://code.visualstudio.com/updates/v1_144): manages agents across workspaces inside VS
  Code.
- [Cursor Agents Window](https://cursor.com/docs/agent/agents-window): local, worktree and cloud agents inside Cursor.

### Usage meters, status lines and notifiers

- [CodexBar](https://github.com/steipete/CodexBar): macOS menu bar for about 115 providers' quotas and costs, with an
  opt-in list of active sessions. MIT. Linux through a Qt app and CLI.
- [ccusage](https://github.com/ccusage/ccusage): command-line token and cost reports for many agents. MIT.
- [Claude HUD](https://github.com/jarrodwatts/claude-hud): Claude Code status line with context, usage and activity.
  MIT.
- [ccstatusline](https://github.com/sirmalloc/ccstatusline): configurable Claude Code status line with usage and cost
  widgets. MIT.
- [CodeBurn](https://github.com/getagentseal/codeburn): cost tracking for 42 tools, with a GNOME Shell extension for
  GNOME 45 and later. MIT.
- [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor): terminal dashboard for
  Claude usage with burn rate and forecasts. MIT.
- [Token Monitor](https://github.com/Javis603/token-monitor): desktop app for usage and quotas across many providers.
  MIT. macOS, Windows, Linux.
- [ClaudeBar](https://github.com/tddworks/ClaudeBar): macOS menu bar for quotas, with Claude Code session state in
  the notch. Apache-2.0.
- [Usage4Claude](https://github.com/f-is-h/Usage4Claude): macOS menu bar for Claude and Codex limits. MIT.
- [Open Island](https://github.com/Octane0411/open-vibe-island) and [Vibe Island](https://vibeisland.app): macOS notch
  apps showing session states, with approvals from the notch. Open Island is GPL-3.0; Vibe Island is
  commercial.
- [Lunavect](https://github.com/lovach/Lunavect): macOS notch app for Claude Code and Codex states, with continue
  after reset. MIT.
- [peon-ping](https://github.com/PeonPing/peon-ping): sounds, banners and phone alerts when an agent needs attention.
  MIT.

### Coordination, tasks and history

- [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust): mail-like messaging and file
  reservations between agents, as an MCP server. MIT with a rider excluding OpenAI and Anthropic.
- [Beads](https://github.com/gastownhall/beads): git-synced task graph for agents. MIT.
- [Backlog.md](https://github.com/MrLesk/Backlog.md): Markdown task manager and kanban board. MIT.
- [Taskmaster](https://github.com/eyaltoledano/claude-task-master): turns requirements into task lists with an LLM.
  MIT with Commons Clause.
- [Gas Town](https://github.com/gastownhall/gastown) and [Ruflo](https://github.com/ruvnet/ruflo): multi-agent orchestration frameworks with messaging among the agents they launch. MIT.
- [Agent Sessions](https://github.com/jazzyalex/agent-sessions): macOS app for searching and resuming sessions from 16
  agents, with a quota meter. MIT.
- [cass](https://github.com/Dicklesworthstone/coding_agent_session_search): terminal search across 30 agents'
  transcripts, with optional semantic search. MIT with a rider excluding OpenAI and Anthropic.
- [claude-history](https://github.com/raine/claude-history): terminal search, resume and export for Claude Code and
  Codex. MIT.
- [Omnilogue](https://github.com/jhlee0409/omnilogue): desktop viewer for many assistants' histories. MIT.
- [claude-code-log](https://github.com/daaain/claude-code-log): converts transcripts to HTML and Markdown. MIT.
- [claude-mem](https://github.com/thedotmack/claude-mem): memory across sessions, built from model-written summaries.
  Apache-2.0.
