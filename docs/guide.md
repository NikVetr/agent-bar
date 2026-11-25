# User guide

For setup, see [Install](../README.md#install). For implementation details, see [Architecture](architecture.md).

- [The top bar](#the-top-bar)
- [The dropdown](#the-dropdown): [Chats](#chats), [Queues](#queues), [Cluster](#cluster), [Git](#git), [Messages](#messages),
  [Tickets](#tickets), [History](#history), [Quota](#quota), [Info](#info)
- [Messages between agents](#messages-between-agents)
- [Tickets and scheduled messages](#tickets-and-scheduled-messages)
- [Task checklists](#task-checklists)
- [The ROTA job scheduler (optional)](#the-rota-job-scheduler-optional)
- [Command line](#command-line)
- [Troubleshooting](#troubleshooting)

## The top bar

- **✳ 2 / 14** and **⌘ 0 / 9**: Claude and Codex chats needing review / open. Copilot (◆) and Antigravity (▲) counts
  appear while one of their chats is open. A chat needs review when a reply finishes, a turn fails, it asks you a
  question or for approval, or all of its project's queues finish. Opening it from Agent Bar, answering it, or sending
  it a message clears that.
- **✳ 12%  ⌘ 64%**: what is left of each provider's weekly usage limit, amber under 25% and red under 10%, dimmed when
  the reading is over 6 hours old. Hovering lists every limit; clicking opens the Quota tab.
- **● 3** working, **◌ 1** waiting: a turn that has gone quiet, or ended with background work still pending.
- **✉ 2** means two chats have unread agent messages and need a prompt from you to read them.
- **🎫 2** opens Tickets. By default it counts ready tickets that had a wait condition. **All ready** includes
  tickets ready from the start. Both include failed scheduled deliveries.
- **Q 2 / 5** means two of five tracked queues have finished. A new turn clears finished queues from that project’s count.
- **▾** opens the window list. Each dot shows the most urgent chat status in that window. **Saved chats** opens History.

Click a top-bar indicator to open its tab. Click another indicator to switch tabs or the same one to close.

### Review shortcut buttons

Each project gets one review button, with the longest-waiting review first. Click the project name for that chat
or a numbered badge for a specific chat. **+N more** lists chats that do not fit.

**Settings › Top bar › Review events** controls which events trigger buttons and desktop alerts. Replies, failures,
questions, approvals and finished queues are selected by default. Usage-limit stops are optional. A Codex approval
request must remain pending for 10 seconds before it appears.

### Notifications

Click a review notification to open its chat. Agent Bar skips review alerts for the focused window. Sending-limit
alerts identify the sender and how to resume sending. **Settings › Notifications** controls both kinds of alert.
The optional review sound respects Do Not Disturb.

## The dropdown

Select **?** for help with the current tab or the gear for settings, including the color-blind-safe palette.

### Chats

Sort and filter open chats by project and window. **Copy** copies the chat’s name, ID, folder and resume command.
The list button opens the project’s [task checklists](#task-checklists). On Claude and Codex rows, a clock button schedules a message to that
chat (see [Scheduled messages](#scheduled-messages)), and an export button writes the chat's messages to your
Downloads folder and opens the file (see [History](#history)).

- **Bringing a chat forward.** Clicking a chat selects it and shows its window maximized on your main display, with the
  chat's tab or sidebar revealed. Clicking again sends the window back. When several Codex chats share a window and the
  sidebar could show any of them, the row and review shortcut open the selected chat by ID in an editor tab.
- **Search.** Chats and History share a search box, including `repo:` scopes, highlighted message excerpts and
  **Show context** (see [History](#history)). Switching tabs keeps your search. Chats shows open conversations and
  History includes closed ones. Message text comes from the saved History index.
- **Usage-limit stops.** Select **Continue** to resume affected VS Code chats. Codex queues the prompt. Claude Code
  opens with the prompt after your draft, ready for you to send. If Agent Bar cannot focus the input box, it copies
  the prompt for you to paste.
- **Automatic continuation.** With **Settings › Integrations › Resume Codex after reset** on, an open VS Code Codex
  thread continues automatically when its recorded five-hour limit resets. Starting another turn clears the pending
  continuation. Weekly limits, depleted workspace credits, and stops with an unknown reset still use the manual
  **Continue**.

### Queues

Job queues from ROTA, by project, with progress, ETA and failed jobs (see
[the scheduler integration](#the-rota-job-scheduler-optional)). A project's finished queues count until a
chat there starts a turn, or until you press Clear beside the project. **Adjust** on a queue, and under **Pool and
hosts**, changes what the scheduler offers there.

- **Numbers.** Each project numbers its active queues from `1` in launch order. The numbers close up as queues finish.
  Search for `2` to see the second active queue in each project.
- **Related queues.** Below the status badge, the right end of the progress line shows related queues and the default
  priority. In `5 → 4, 2`, the current queue needs queue 5, and queues 4 and 2 need the current queue. A dash means
  that side is empty. Active queues use their project numbers. Other referenced queues share the next available numbers
  in their project for this menu visit. An asterisk beside a queue number marks another project.
- **Outcomes.** Failed or incomplete prerequisites appear in red, and unknown or unverified outcomes in amber.
- **Details.** Hover over a queue number for its name, project, status, and available progress details, including
  ETA. Hover over the arrow for both full lists, or over the priority for host overrides.
- **Resources.** A line under the progress shows what the scheduler reports for the queue, when it applies: GPU slots
  per job and those reserved on each host (reservations, not measured GPU use), an enforced memory limit per job,
  and the CPU time its finished jobs used, split into succeeded and failed. A queue the shared drive holds back says
  so, with the scheduler's reason. Parts the queue doesn't use, or that a stale snapshot can't confirm, are left out.
- **Pool and hosts.** The pool's row notes when backfill is on. A host's row shows its GPU slots, and why the
  scheduler can't use it now, such as its owner being active.

### Git

Each repository holding an open project, with its branch, uncommitted files, and commits ahead of or behind its
upstream (as of the last fetch; Agent Bar never fetches or takes git's lock). Clicking one opens VS Code's Source
Control for it.

- **Diff summary.** A repository with uncommitted changes to tracked files shows the lines added and removed since
  the last commit, staged or not. Hovering lists the files most changed.
- **Pull requests.** With **Settings › Integrations › Pull requests** on (off by default), a GitHub branch also shows
  its pull request: number, state, review decision and checks, in red when checks fail or changes were requested.
  Clicking it opens the pull request. Agent Bar asks GitHub through the `gh` command, signed in as `gh` is, at most
  every 5 minutes per branch.

### Messages

Notes between agents, as threads. See [Messages between agents](#messages-between-agents).

### Tickets

Tasks to do later (see [Tickets and scheduled messages](#tickets-and-scheduled-messages)): ready ones first, then
those scheduled to be sent to a chat, those waiting, started, and recently closed.

- **New ticket** writes one: its text, its project (the most recently active open folders first), and what it waits
  for. It can also send the ticket to one of its project's chats.
- **Start** opens a new Claude Code chat in the ticket's folder, in VS Code (opening a window there if none is), with
  the ticket as its prompt in the input box, unsent, for you to read and send. A copy button copies the same prompt,
  for a Codex chat or any other.
- **Done**, **Drop** and **Reopen** close or reopen a ticket.

### History

Search saved Claude and Codex chats by title, folder, or words in your messages and the agents' replies.

- Type `memory share` to search all projects or `repo:agent-bar memory share` to narrow the search. Use quotes around
  folder names with spaces. Each keyword can match the start of a word in the same message.
- A message match shows who wrote it and a wrapped excerpt with matching words in bold. A title, folder, or provider
  match is labeled when no indexed message matches.
- **Show context** expands the selected hit in place. Use **‹** and **›** to visit occurrences within a message and
  move between matching messages, newest message first. At a message boundary, the preview also shows a short excerpt
  of the adjacent message when available.
- Clicking **Open** or **Resume** has the same effect as clicking that conversation's row. The project header's
  maximize button brings its window to the main display with the current tab selected.

The index updates nightly and with **⟳**.

The export button on a Claude or Codex row, here or in Chats, writes that conversation's messages to your Downloads
folder as HTML (or Markdown, under **Settings › Dropdown › Export format**) and opens it. The export holds what History
indexes: your messages and the agent's replies with their times, without tool calls, tool results or reasoning. An
existing file is never replaced; `agent-bar export` does the same from the command line.

### Quota

Claude and Codex show their five-hour, weekly and model-specific limits when available. Each entry shows quota
remaining, the reset time and whether recent usage would exhaust it before the reset. The forecast uses the past
day’s rate, or the current quota window when less history is available. Weekly charts show daily usage by model.

Run `/usage` in Claude Code for a fresh reading, or enable **Settings › Integrations › Read Claude limits** for
automatic checks every 10 minutes. Codex records limits during turns. See [Privacy](../README.md#privacy).

**Cost at API prices** estimates the cost of local token usage, including cache reads and writes. Quota shows daily,
weekly and per-model totals. Each chat shows its own estimate. Subscription billing is separate. For an unpriced
model or a price correction, use `~/.config/agent-bar/prices.json` with the format of `agent_bar/data/prices.json`.
Agent Bar recalculates estimates when prices change.

### Info

Choose a project to inspect its hooks or start a chat with a skill. Expand a hook to see when it runs, which action it
calls, and where it was configured. Agent Bar's own hooks also describe their effects. Codex reports enablement and
trust for the selected folder. Claude entries reflect local settings and enabled installed plugins. An individual
session can have different settings.

Info also shows Agent Bar hook and bridge health and the instruction files each project uses.

## Messages between agents

An agent in one chat can leave a note for an agent in another, across projects and providers:

```
agent-bar agents                  # open chats a message can go to
agent-bar send <key> "text"       # message one of them
agent-bar inbox                   # read this chat's messages
```

The `agent-messages` skill that `agent-bar install` adds tells Claude Code and Codex agents how to use these.

The recipient sees a one-line note with its unread count when its next turn starts. With **Wake idle chats** on in
settings, a new message also starts a turn in an idle Claude Code chat (up to a week after its last turn) and in a
Codex chat open in VS Code. Other chats wait for their next turn. Copilot and Antigravity chats cannot receive
messages, because they have no hook to show the note.

If you already have prompts queued in a Codex chat, Agent Bar moves its inbox notification to the front. Your current
turn finishes normally and your prompts keep their order. With an empty queue, a busy chat gets a wake-up after its
turn if messages are still unread. Priority requires a local `codex` with the app-server queue API.

In the Messages tab, each chat's badge shows a sealed envelope while it has unread messages, amber when they wait for
you to start a turn there, and an open one once it has read them.

Each chat can send up to 10 messages per hour and up to 10 to the same recipient between your prompts to the
**sender**. In Messages, **Reset limit** allows another round for that pair. **Allow more for an hour** raises the
sender’s hourly limit to 30 for one hour. It appears once the sender has used half its hourly allowance.

Agents treat messages from other agents as information. Your scheduled messages arrive as requests.

## Tickets and scheduled messages

Create a project ticket for work you want to start later:

```
agent-bar ticket add "Fable audit of this repo" --after reset:claude   # wait for Claude's limit to reset
agent-bar ticket add "Compare the fits" --after queues                 # wait for this project's queues to finish
agent-bar ticket list                                                  # open tickets, then recently closed ones
agent-bar ticket start 3                                               # a new Claude chat in its folder, prompt unsent
agent-bar ticket take 3                                                # this chat starts it
agent-bar ticket done 3 --note "findings in tmp/audit.md"              # or drop, or reopen
```

`--after` can also be `date:2026-11-20 09:00`, `date:+3h`, `queue:<id>` or `ticket:<number>`; repeat it to wait for
several. A wait is fixed when the ticket is written: the reset then due (by default the limit binding now, else the
weekly one; `reset:claude:session` picks the 5-hour one), or the queues outstanding then. A ticket is ready once all
its waits have passed.

Tickets use the agent’s current folder unless you pass `--project`. **Start** prepares the prompt in a new Claude
Code chat. Use **Copy** to paste it into another chat. Agents use `take` to claim work and `done` to close it.
Closed tickets remain visible for 30 days.

### Scheduled messages

A ticket can instead be sent to an open Claude Code or Codex chat once it is ready, as a message: a one-off reminder or
request, or one that repeats.

```
agent-bar ticket add "Draft this week's update" --to codex:<id> --after "date:2026-11-23 09:00" --repeat week
```

`--repeat` takes `day`, `week`, `month`, or `<N>h`, `<N>d` or `<N>w` (at least hourly), and needs one time to start
from. Repeats count from that first time (a monthly send on the 31st comes back to the 31st, or the month's last day);
sends missed while the computer was off are skipped, not sent late. A one-off ticket closes once sent; a repeating one
stays under **Scheduled** in Tickets until you drop it. If the chat has closed, the ticket shows the reason and tries
again every 10 minutes.

Click the clock beside a Claude or Codex chat to set the message, delivery time and optional repeat interval, or to
inspect its schedule. With **Wake idle chats** off, the chat reads it on your next prompt.

A message you schedule arrives as your request. A ticket scheduled by an agent with `--to` identifies that agent as
the sender and counts toward its sending limits.

## Task checklists

Open the list beside a chat to see its project’s checklists in `tmp/agent/checklists/`. Files that chat edited
appear first, followed by files updated in the past 14 days, then older files with open items. Expand a file to see
progress, suggested next work and linked checklists. **Open** shows the file in VS Code.

Checklist format

- Only checkbox lines count, outside fenced code: `[ ]` open, `[x]` or `[X]` done, `[-]` dropped (left out of the
  total). Any other marker counts as unrecognized, never as done. Indentation and numbered items are fine.
- An open item starting `User:` needs you, `Waiting:` waits on something else, `Deferred:` was postponed. The first
  open item without a prefix is the suggested next task.
- A file with nothing open says "no open items recorded", not "done".
- Links to other checklists are listed with their own counts; counts are never added up from links.
- **Last edited by** names the open chats whose transcripts (the last 2 MB, then what they append) show them writing
  the file: Claude's Edit and Write, Codex's apply_patch, or a shell command that writes to it. It is evidence, not
  ownership, and a chat that edited it before Agent Bar was watching is not named.

The service scans the open projects every 30 seconds and writes the result to `checklists.json`, which the panel reads
when the column opens; files are reread only when they change.

## The ROTA job scheduler (optional)

The Queues tab, the Q count and the cluster indicator read the files the ROTA job scheduler writes in
`~/.local/state/rota`. Without it they stay out of the way; **Settings › Integrations** turns them off
entirely.

### Cluster

Choose CPU, memory, fullest disk or warnings in **Settings › Cluster**. CPU estimates the share of job slots in
use after reserved cores absorb load. Warnings identify high memory pressure, low disk space, unreachable hosts
and missing shared mounts. Select only **Warnings** to show the indicator only while a warning is active.

Open **Cluster** to see the affected host. **Snooze** hides its top-bar warning until it clears or the duration
expires (for example, `5d` or `120h`). Monitoring continues. The tab also shows:

- each host's cores, memory and disks. Hover a node name for a second to list the projects using its job slots.
  Click it to open a side dropdown for the node:
  - one pair of bars per project. CPU shows reserved slots as a share of the node's job-slot budget. Memory shows the
    sampled footprint of the project's jobs as a share of the node's physical RAM. Fixed-worker queues report slots
    only.
  - each queue running there: its jobs, CPU slots and memory on the node, how long it has run, its progress, its
    workers across the pool and its ETA.
  - the node's state: why it is unavailable, its owner's activity, its budget (against its base when lowered), load,
    swap and the shared-drive mount.
  - its last day: job failures, holds (with a button that copies the command that lifts one, to run once the cause
    is fixed) and times out of reach, from ROTA's `events.jsonl`, and the latest memory-pressure sample of the last
    hour with the processes holding the most memory, from `memory-events.jsonl`.

  The dropdown refreshes about every 15 seconds while open.
- failed jobs by project, with a note to copy for that project's agent and buttons that bring its VS Code window
  forward.
- the shared drive, naming the host serving it, with the scheduler's job slots in use, the drive's throughput and
  that host's network over the last 10 minutes.

### Scheduler controls

**Adjust** opens the controls ROTA offers for a queue, host or pool. Hover over a control for its effect or
the reason it is unavailable. **Apply** submits edited values together. If another operator changed a value, ROTA
rejects the outdated edit. Actions such as draining the pool require confirmation. Changes usually appear within
30 seconds. The `rota` command must be on `PATH` or in `~/.local/bin`.

## Command line

Common commands for inspecting state and acting on chats:

```
agent-bar status        # open chats, their states and counts
agent-bar queues        # numbered queues and their progress
agent-bar queue-dependencies  # prerequisite numbers and outcomes
agent-bar queue-dependencies --project example 1 2  # two active queues in one project
agent-bar node HOST     # one node's job slots by project and queue, its state and its last day's events
agent-bar git           # git status of repositories holding open projects
agent-bar info --project .  # project hooks, skills, tracker health, instruction files
agent-bar usage         # usage limits, with pace, run-out time and use by day
agent-bar cost          # cost at API prices by day, by model and per chat
agent-bar ticket list   # tickets and what each waits for
agent-bar inventory     # rescan saved chats
agent-bar search-history --repo agent-bar "memory share"  # matching messages as JSON; omit --repo for all folders
agent-bar search-history --conversation <key> --message 2 --hit 1 "memory share"  # context for one occurrence
agent-bar export <key> --format html  # a saved chat's messages as HTML or Markdown, in Downloads by default
agent-bar resume <key>  # reopen a saved chat in VS Code
agent-bar doctor        # check each part and say how to fix anything missing
```

`agent-bar --help` lists every command, and `agent-bar <command> --help` describes one.

## Troubleshooting

Run `agent-bar doctor` first. It checks the installed components, hooks, service and executable paths and suggests
fixes. Use `agent-bar --version` to locate the copy your shell runs.

- **The extension does not appear after the first install.** GNOME Shell finds new extensions at login. Log out and
  back in (or on X11 press Alt+F2, type `r`, press Enter), then run `agent-bar install` again to enable it.
- **A VS Code window's chats are missing, or bringing one forward lands on the wrong tab.** Reload that window
  (Developer: Reload Window) so it runs the current bridge.
- **Codex turns are not tracked.** Codex asks you to review new hooks once; run `/hooks` in Codex and accept Agent
  Bar's.
- **The counts stop changing.** `journalctl --user -u agent-bar.service` shows the service's log.
- **Wayland.** Agent Bar is tested on GNOME 42 under X11. Window matching and focusing rely on X11.
