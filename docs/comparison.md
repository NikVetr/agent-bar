# How Agent Bar compares

Suppose Claude is working in one VS Code window and Codex in another. Can a tool find both chats where you opened
them? When one finishes, can it take you back to that particular tab? Some tools get you back to a chat only if you
launched it inside their workspace. The table distinguishes finding a chat from focusing it.

The comparison follows the projects’ documentation as of November 24, 2026.

## At a glance

✓ means the project documents the feature. ◐ marks partial support. A blank means the feature doesn’t apply or
the project’s documentation didn’t establish it.

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

If you already have agents open across windows on a GNOME desktop, Agent Bar can take you back to a specific
VS Code chat, show how much quota remains, and let Claude and Codex exchange notes. If the next piece of work has
to wait for a quota reset or a project’s queues to finish, you can leave it on a ticket.

Other tools suit different ways of working:

- To **launch isolated workspaces**, look at Claude Squad, Agent Deck, Conductor or Orca. They start agents in
  their own sessions or worktrees, and several include diff review and merge tools.
- To **track spending or quotas across more providers**, see CodexBar and the other usage meters.
- To **search or coordinate across machines**, see cass for semantic history search, Beads for shared task graphs,
  and MCP Agent Mail for file reservations and messages.

The README has a [diagram of these choices](../README.md#where-it-fits). The [project list](#projects-surveyed)
links to the sources for the comparison.

## Using Agent Bar with other tools

Status lines, usage reports and notifiers such as ccstatusline, Claude HUD, ccusage and peon-ping read the same
local files or run their own hooks. You can keep using them. Agent Bar preserves existing hooks when it installs
its own. History tools can likewise read the same saved conversations.

Claude Code’s built-in cross-session messages stay in their own channel. To leave a note for a Codex chat, use
Agent Bar’s channel.

Agents launched by an orchestrator still write transcripts and run their configured hooks. Integration with those
tools is untested. Agent Bar can focus a native window, but selecting a pane inside that window requires the
orchestrator’s own navigation.

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
