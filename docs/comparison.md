# How Agent Bar compares

Many projects help people work with several AI coding agents at once. This page describes where Agent Bar fits among
them, what it offers that they do not, what they offer that it does not, and which of those gaps it could close.

Facts about other projects were checked on 2026-11-24 against each project's README, documentation or changelog.
Star counts come from GitHub on that date. This field changes quickly; corrections are welcome as issues.

## Where Agent Bar fits

Tools in this space fall into five groups:

1. **Orchestrators** launch agents for you, usually in tmux panes, their own terminal, or a desktop app that gives each
   task a git worktree. Examples are Claude Squad, Conductor, Orca, Agent Deck, Herdr and cmux. They see the sessions
   they start.
2. **First-party surfaces** come from the agent vendors: Claude Code's agent view, desktop app and cross-session
   messaging; the Codex app's scheduled tasks; the VS Code Agents window; Cursor's Agents Window. Each covers its own
   provider's agents.
3. **Usage and cost meters** show quota and spending: CodexBar, ccusage, Claude HUD, ccstatusline and CodeBurn, plus
   several GNOME Shell extensions for GNOME 45 and later.
4. **Session monitors** in the macOS menu bar or notch show each session's state, such as Open Island, Vibe Island and
   Lunavect.
5. **Coordination and memory tools** handle one job in depth: messaging between agents (MCP Agent Mail), task graphs
   (Beads, Backlog.md), or history search (Agent Sessions, cass, claude-history).

Agent Bar is an observer. It watches the chats you open where you already work: VS Code tabs and sidebars,
terminals, the ChatGPT desktop app, Copilot CLI and Antigravity. It covers several providers at once, in the desktop's
own menu bar, and adds coordination tied to that live state: messages between Claude and Codex chats, tickets that
wait for a usage-limit reset or for job queues to finish, and scheduled messages into open chats. It runs locally,
with no account, remote server or telemetry.

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

## What Agent Bar offers that the others do not

- **Chats where they already are, across providers.** Orchestrators see the sessions they launch, and first-party
  surfaces see their own provider's agents. Claude Code's agent view, for example, does not show interactive sessions
  open in other terminals until you background them. Agent Bar finds Claude Code, Codex, Copilot CLI and Antigravity
  chats in VS Code, terminals and desktop apps without changing how you start them.
- **Focus on the exact chat.** A click maximizes the right VS Code window and reveals the exact editor tab or sidebar
  conversation, and a second click sends it back. Menu-bar monitors that focus VS Code mostly stop at the window or
  workspace.
- **Messages across providers.** Claude Code's built-in cross-session messaging wakes idle sessions but only reaches
  other Claude sessions. MCP Agent Mail spans providers but delivers by polling. Agent Bar delivers between Claude
  Code and Codex chats, wakes idle ones, and keeps your own scheduled requests distinct from agents' information.
- **Tickets that wait for operating conditions.** A ticket can wait for a usage-limit reset, a project's job queues,
  a time or another ticket. Task trackers such as Beads handle dependencies and dates but not limits or queues.
- **Scheduled messages into open chats of both providers.** Claude Code's `/loop` schedules into its own session
  while it runs. The Codex app schedules into Codex chats from the ChatGPT app or web. Agent Bar schedules one-off or
  repeating messages into open Claude Code and Codex chats from one local list.
- **One picture of the workspace.** Git status of every repository holding an open chat, each project's active hooks,
  skills and instruction files, and progress on the task checklists agents keep in the repository. Optionally, job
  queues and cluster nodes from the ROTA job scheduler.
- **Linux desktop.** Session monitors in the menu bar are almost all for macOS, and the GNOME Shell extensions on
  extensions.gnome.org show usage only, for GNOME 45 and later.
- **Cost tied to each chat.** Like ccusage and CodexBar, Agent Bar prices recorded token use at API rates, by day
  and by model, and it also shows each open chat's own total beside its state.
- **Local by design.** No account, relay or telemetry. Many usage meters call provider endpoints with stored sign-in
  tokens or browser cookies. Agent Bar reads local files, plus one Claude endpoint if you turn that on.

## What others offer that Agent Bar does not

| Feature | Found in | Fit for Agent Bar |
| --- | --- | --- |
| macOS and Windows | nearly all of them | Planned. The service, CLI, hooks and VS Code bridge are shared; each platform needs a menu-bar front end and its own process and window lookup. |
| Quotas for more providers (Gemini, Cursor, Copilot and others) | CodexBar, Token Monitor, ClaudeBar | Partial fit. Many providers need browser cookies or API keys, which Agent Bar avoids; reading another tool's JSON output would avoid holding credentials. |
| Alerts on your phone | peon-ping, ClaudeBar, Nimbalyst, code-notify (through Slack or Discord) | Agent Bar has desktop notifications and an optional sound. Phone alerts send data off the computer and would need to be opt-in. |
| Approving permission requests or answering questions from the bar | Open Island, Vibe Island, Lunavect | Possible, but Agent Bar's hooks only record metadata and never block a turn; this would change that. |
| Continuing Claude chats after a usage-limit reset | Claude Code itself (v2.1.234 and later, on by default), Conductor, Lunavect | Claude Code now does this on its own. Agent Bar can continue Codex chats automatically (a setting) and Claude chats on request. |
| Launching agents in isolated worktrees or containers | Claude Squad, Conductor, Orca, Agent Deck, CCManager, Sculptor, Nimbalyst | Outside an observer's role. Starting a ticket in a fresh worktree would be an opt-in extension. |
| Diff review, merge and pull requests | Conductor, Orca, Sculptor, Vibe Kanban, Claude Code desktop | Poor fit for a menu bar. Agent Bar's Git tab shows a read-only diff summary and, optionally, each branch's pull request and checks. |
| Remote and mobile access | Herdr, Orca, T3 Code, cmux, Nimbalyst, the Claude and Codex apps | Conflicts with local-only, except within a local network or through a self-hosted service. |
| Task graphs with claiming and sync across machines | Beads, Backlog.md | Tickets wait on other tickets; reading a tracker's ready list into the Tickets tab would be straightforward. |
| File reservations between agents | MCP Agent Mail | Moderate. A hook could warn when an agent edits a path another chat has reserved. |
| Semantic search | cass, claude-history, claude-mem | Needs a local model and adds weight. Agent Bar's search matches words, and it exports conversations to HTML or Markdown. |
| Runs while the computer is off | Claude Code cloud scheduled tasks, Codex on the web | Conflicts with local-only. |

## Using Agent Bar with other tools

- **Status lines, usage reports and notifiers** (ccstatusline, Claude HUD, ccusage, peon-ping) read the same local
  files or run as separate hooks. They work alongside Agent Bar, which keeps existing hooks when it installs its own.
- **First-party features** stay available. Claude Code's cross-session messaging and Agent Bar's messages are separate
  channels; Agent Bar's also reaches Codex chats.
- **Orchestrators** start agents that still write their usual transcripts and run their configured hooks. Agent Bar
  has not been tested with them. It focuses native windows, so it cannot select a pane or tab inside an
  orchestrator.
- **History tools** read the same saved conversations and can run side by side.

## Choosing

Agent Bar suits you if you run several agents at once, across providers, in VS Code and terminals on a Linux GNOME
desktop, and want one place that shows which ones need you and takes you there, plus ways for those agents to hand
work to each other, without changing how you start them or sending anything off your computer.

Another tool suits you better if you want agents launched for you in isolated worktrees with a review and pull-request
workflow (an orchestrator), a quota and cost meter on macOS or Windows today (CodexBar, CodeBurn, ClaudeBar), or you
use a single provider and its built-in features are enough.

## Projects surveyed

Stars as of 2026-11-24.

### Orchestrators and session managers

- [Agent Deck](https://github.com/asheshgoplani/agent-deck): terminal UI on tmux for many agents, with status, usage
  limits, messaging, transcript search and cost. MIT, 1.3k stars. macOS, Linux, WSL.
- [Claude Squad](https://github.com/smtg-ai/claude-squad): terminal UI that runs agents in tmux and git worktrees.
  AGPL-3.0, 8.9k stars. macOS, Linux.
- [CCManager](https://github.com/kbwo/ccmanager): terminal session manager for about ten agent CLIs, with worktrees
  and busy, waiting and idle states. MIT, 1.3k stars.
- [cmux](https://github.com/manaflow-ai/cmux): Ghostty-based terminal for agents, with attention rings and branch
  status. GPL-3.0-or-later, 29k stars. macOS.
- [Conductor](https://conductor.build): desktop app running Claude Code and Codex in isolated workspaces, with usage
  limits, resume after reset, diffs and pull requests. Proprietary. macOS.
- [Emdash](https://github.com/generalaction/emdash): desktop app sending issues to agents in worktrees. Apache-2.0,
  6.3k stars. macOS, Windows, Linux.
- [Herdr](https://github.com/herdrdev/herdr): terminal multiplexer that owns agents' terminals, with states,
  notifications and agents prompting each other. Apache-2.0, 53k stars. macOS, Linux, Windows.
- [Nimbalyst](https://github.com/nimbalyst/nimbalyst) (formerly Crystal): desktop workspace with a session board,
  worktrees and session search. MIT, 2.1k stars. macOS, Windows, Linux, iOS.
- [opcode](https://github.com/winfunc/opcode) (formerly Claudia): desktop app for Claude Code with history, usage
  and cost analytics. AGPL-3.0, 22k stars.
- [Orca](https://github.com/stablyai/orca): desktop app for about 35 agent CLIs, with worktrees, status, usage limits,
  automations and mobile apps. MIT, 137k stars. macOS, Windows, Linux.
- [Paradev](https://github.com/ParadevAI/Paradev) (formerly Superset): desktop app running agents in worktrees, with
  automations on paid plans. MIT, 17k stars. macOS, Linux (experimental).
- [Sculptor](https://github.com/imbue-ai/sculptor): desktop app running agents in isolated worktrees, with diff review
  and merge. MIT, 286 stars. macOS, Linux.
- [T3 Code](https://github.com/pingdotgg/t3code): desktop, web and mobile client for several agents, with per-thread
  worktrees. MIT, 78k stars.
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban): kanban board that runs agents in worktrees; community
  maintained since its company closed. Apache-2.0, 29k stars.

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
  opt-in list of active sessions. MIT, 23k stars. Linux through a Qt app and CLI.
- [ccusage](https://github.com/ccusage/ccusage): command-line token and cost reports for many agents. MIT, 20k stars.
- [Claude HUD](https://github.com/jarrodwatts/claude-hud): Claude Code status line with context, usage and activity.
  MIT, 29k stars.
- [ccstatusline](https://github.com/sirmalloc/ccstatusline): configurable Claude Code status line with usage and cost
  widgets. MIT, 14k stars.
- [CodeBurn](https://github.com/getagentseal/codeburn): cost tracking for 42 tools, with a GNOME Shell extension for
  GNOME 45 and later. MIT, 12k stars.
- [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor): terminal dashboard for
  Claude usage with burn rate and forecasts. MIT, 8.8k stars.
- [Token Monitor](https://github.com/Javis603/token-monitor): desktop app for usage and quotas across many providers.
  MIT, 3.9k stars. macOS, Windows, Linux.
- [ClaudeBar](https://github.com/tddworks/ClaudeBar): macOS menu bar for quotas, with Claude Code session state in
  the notch. Apache-2.0, 1.6k stars.
- [Usage4Claude](https://github.com/f-is-h/Usage4Claude): macOS menu bar for Claude and Codex limits. MIT, 423 stars.
- [Open Island](https://github.com/Octane0411/open-vibe-island) and [Vibe Island](https://vibeisland.app): macOS notch
  apps showing session states, with approvals from the notch. Open Island is GPL-3.0 with 2.1k stars; Vibe Island is
  commercial.
- [Lunavect](https://github.com/lovach/Lunavect): macOS notch app for Claude Code and Codex states, with continue
  after reset. MIT, 47 stars.
- [peon-ping](https://github.com/PeonPing/peon-ping): sounds, banners and phone alerts when an agent needs attention.
  MIT, 5.1k stars.

### Coordination, tasks and history

- [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust): mail-like messaging and file
  reservations between agents, as an MCP server. MIT with a rider excluding OpenAI and Anthropic.
- [Beads](https://github.com/gastownhall/beads): git-synced task graph for agents. MIT, 29k stars.
- [Backlog.md](https://github.com/MrLesk/Backlog.md): Markdown task manager and kanban board. MIT, 7.5k stars.
- [Taskmaster](https://github.com/eyaltoledano/claude-task-master): turns requirements into task lists with an LLM.
  MIT with Commons Clause, 29k stars.
- [Gas Town](https://github.com/gastownhall/gastown) and [Ruflo](https://github.com/ruvnet/ruflo) (formerly
  claude-flow): multi-agent orchestration frameworks with messaging among the agents they launch. MIT; 19k and 82k
  stars.
- [Agent Sessions](https://github.com/jazzyalex/agent-sessions): macOS app for searching and resuming sessions from 16
  agents, with a quota meter. MIT, 953 stars.
- [cass](https://github.com/Dicklesworthstone/coding_agent_session_search): terminal search across 30 agents'
  transcripts, with optional semantic search. MIT with a rider excluding OpenAI and Anthropic.
- [claude-history](https://github.com/raine/claude-history): terminal search, resume and export for Claude Code and
  Codex. MIT, 547 stars.
- [Omnilogue](https://github.com/jhlee0409/omnilogue): desktop viewer for many assistants' histories. MIT, 2.3k stars.
- [claude-code-log](https://github.com/daaain/claude-code-log): converts transcripts to HTML and Markdown. MIT, 1.3k
  stars.
- [claude-mem](https://github.com/thedotmack/claude-mem): memory across sessions, built from model-written summaries.
  Apache-2.0, 120k stars.
