# User guide

Agent Bar runs in the GNOME Shell 42 top bar on Linux; a macOS menu bar version is planned (see
[Platforms](../README.md#platforms)). For setup, see [Install](../README.md#install). For implementation details,
see [Architecture](architecture.md).

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

- **✳ 2 / 14** means two of your fourteen open Claude chats need review. Codex uses the same convention (⌘),
  as do Copilot (◆) and Antigravity (▲) while you have one of their chats open. A finished reply, failed turn,
  question, approval request or the last queue finishing in a project can all bring a chat up for review.
  Open it from Agent Bar, answer it or send it a message to clear the review.
- **✳ 12%  ⌘ 64%** shows the weekly quota each provider has left. The figure turns amber below 25% and red below
  10%. A dim figure is more than six hours old. Hover to see all limits or click to open Quota.
- **● 3** means three chats are working. **◌ 1** means one is waiting. It may still have a turn open that’s been
  quiet for five minutes (adjustable in **Settings › Dropdown › Mark inactive turns as waiting**), or its turn
  may have ended with work still running in the background.
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
Use the list button to see the project’s [task checklists](#task-checklists). Claude and Codex rows also have a clock
for [scheduling a message](#scheduled-messages) and an [export button](#history) that saves the conversation to
Downloads and opens the file.

- **Bringing a chat forward.** Clicking a chat selects it and shows its window maximized on your main display, with the
  chat's tab or sidebar revealed. Clicking the focused chat again sends the window back (**Settings › Windows › Click
  a focused chat again** can keep it in place instead). When several Codex chats share a window and the
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

The Queues tab shows each project’s ROTA queues with their progress, ETA and failed jobs. A finished queue counts until a chat in
that project starts a turn or you press **Clear** beside the project. Choose **Adjust** beside a queue, host or pool
to see which [scheduler settings](#the-rota-job-scheduler-optional) you can change.

- **Numbers.** Each project numbers its active queues from `1` in launch order. The numbers close up as queues finish.
  Search for `2` to see the second active queue in each project.
- **Related queues.** Below the status badge, the right end of the progress line shows related queues and the default
  priority. In `5 → 4, 2`, the current queue needs queue 5, and queues 4 and 2 need the current queue. A dash means
  that side is empty. Active queues use their project numbers. Other referenced queues share the next available numbers
  in their project for this menu visit. An asterisk beside a queue number marks another project.
- **Outcomes.** Failed or incomplete prerequisites appear in red, and unknown or unverified outcomes in amber.
- **Details.** Hover over a queue number for its name, project, status, and available progress details, including
  ETA. Hover over the arrow for both full lists, or over the priority for host overrides.
- **Resources.** The line beneath the progress bar reports GPU slots reserved per job and on each host. A reservation
  tells you how much capacity the scheduler set aside. It doesn’t measure how busy the GPU was. The same line shows
  any enforced memory limit per job and the CPU time spent on successful and failed jobs. If the shared drive is
  holding up a queue, you’ll see the scheduler’s reason. Fields appear only where they apply and the current readings support them.
- **Pool and hosts.** The pool's row notes when backfill is on. A host's row shows its GPU slots, and why the
  scheduler can't use it now, such as its owner being active.

### Git

Choose a repository to open Source Control for it in VS Code. Its row shows the branch, uncommitted files, and how
many commits the branch is ahead of or behind its upstream. Those last two counts are as of your last fetch.
Agent Bar reads the local repository without fetching or taking Git’s index lock.

- **Diff summary.** A repository with uncommitted changes to tracked files shows the lines added and removed since
  the last commit, staged or not. Hovering lists the files most changed.
- **Pull requests.** With **Settings › Integrations › Pull requests** on (off by default), a GitHub branch also shows
  its pull request: number, state, review decision and checks, in red when checks fail or changes were requested.
  Clicking it opens the pull request. Agent Bar asks GitHub through the `gh` command, signed in as `gh` is, at most
  every 5 minutes per branch.

### Messages

Notes between agents, as threads. See [Messages between agents](#messages-between-agents).

### Tickets

Ready tickets come first, followed by scheduled messages, waiting tickets, work in progress and recently closed
tickets. [Tickets and scheduled messages](#tickets-and-scheduled-messages) describes the wait conditions.

- **New ticket** lets you write the task, choose a project and set any conditions. The most recently active folders
  appear first. You can also choose a chat in that project to receive the ticket when it’s ready.
- **Start** puts the ticket’s prompt in a new Claude Code chat in its project folder, opening a VS Code window there
  if necessary. You get to read the prompt before sending it. For Codex or another chat, **Copy** gives you the same text.
- **Done** and **Drop** close a ticket. **Reopen** puts it back on the list.

### History

Search saved Claude and Codex chats by title, folder, or words in your messages and the agents' replies.

- Type `memory share` to search all projects or `repo:agent-bar memory share` to narrow the search. Use quotes around
  folder names with spaces. Every keyword must match the start of a word in the same message.
- A message match shows who wrote it and a wrapped excerpt with matching words in bold. A title, folder, or provider
  match is labeled when no indexed message matches.
- **Show context** expands the selected hit in place. Use **‹** and **›** to visit occurrences within a message and
  move between matching messages, newest message first. At a message boundary, the preview also shows a short excerpt
  of the adjacent message when available.
- Clicking **Open** or **Resume** has the same effect as clicking that conversation's row. The project header's
  maximize button brings its window to the main display with the current tab selected.

The index updates nightly. Click **⟳** to scan sooner.

Use the export button in Chats or History to save a Claude or Codex conversation to Downloads and open it. HTML is
the panel default. You can choose Markdown in **Settings › Dropdown › Export format**. The command-line export uses
Markdown by default and prints the path without opening the file. Use `agent-bar export <key> [--format html] [--output PATH]`
to choose the format or destination.

Both exports keep the messages History indexes (your words and the agent’s replies, with their times), omit tool
calls, tool results and reasoning, and preserve any existing file.

### Quota

Claude and Codex show their five-hour, weekly and model-specific limits when available. Each entry shows quota
remaining, the reset time and whether recent usage would exhaust it before the reset. The forecast uses the past
day’s rate, or the current quota window when less history is available. Weekly charts show daily usage by model.

Run `/usage` in Claude Code for a fresh reading, or enable **Settings › Integrations › Read Claude limits** for
automatic checks every 10 minutes. Codex records limits during turns. See [Privacy](../README.md#privacy).

**Cost at API prices** estimates what local usage would cost at API rates, including cache reads and writes.
It’s on by default in **Settings › Integrations**. Quota breaks the estimate down by day, week and model. Each
chat also shows its own estimate. Subscription billing is separate. For an unpriced
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
agent-bar inbox                   # read this chat's messages (--peek leaves them unread)
```

The `agent-messages` skill that `agent-bar install` adds tells Claude Code and Codex agents how to use these.

By default a note waits for the recipient’s next turn, when the chat sees its unread count. Turn on
**Settings › Integrations › Wake idle chats** to let a message start a turn. This works for an idle Claude Code
chat up to a week after its last turn and for a Codex chat open in VS Code. Copilot and Antigravity lack the hook
that delivers the note.

Suppose you’ve queued two prompts for Codex and another chat sends it a message. With waking on and a local `codex`
that supports the app-server queue API, the inbox notification goes first. The current turn finishes and your two
prompts keep their order. If the queue was empty, a busy chat can wake after the turn ends to read anything still unread.

In Messages, a sealed envelope means unread mail. Amber means delivery needs a prompt from you. The envelope
opens once the chat reads its mail.

Each chat can send 10 messages an hour and up to 10 to the same recipient between your prompts to the **sender**.
If a chat reaches a limit, its next send is refused; the agent is told to wait, and nothing is delivered later. Its desktop notification names the chat and the limit, with
**Allow another round** or **Allow 30 an hour, for an hour** to lift it.

Under **Sending limits**, each chat that sent a message in the past hour shows its count (for example, “6 of 10
this hour”) and, if it hit the limit, when it can send again. **Reset limit** gives a pair another round in both
directions and restarts both hourly counts. Once a sender has used half its hourly allowance, **Allow more for an
hour** raises its cap to 30 for one hour.

With waking on, **Settings › Integrations › Delivery to busy Claude chats** controls what can reach a chat mid-turn.
The default, **After its turn**, lets the chat finish. **Urgent only** admits messages marked `--urgent`, and
**All messages** admits any message. To turn off messaging altogether, use **Settings › Integrations › Agent messages**.

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

You can also wait for a particular time (`"date:2026-11-20 09:00"`, quoted for the space), a delay (`date:+3h`),
one queue (`queue:<id>`) or another ticket (`ticket:<number>`). Repeat `--after` to require all the conditions.

Agent Bar records what you’re waiting for when you create the ticket. For `queues`, that means the queues outstanding
in the project at that moment. For a provider reset, it uses the limit currently holding you up, or the weekly limit
if none is binding. To specify the five-hour window yourself, use `reset:claude:session`.

Tickets use the agent’s current folder unless you pass `--project`. **Start** prepares the prompt in a new Claude
Code chat. Use **Copy** to paste it into another chat. Agents use `take` to claim work and `done` to close it.
The list shows up to 20 recently closed tickets from the past 30 days.

### Scheduled messages

Add `--to` to deliver the ticket to an open Claude or Codex chat when it’s ready. This works for a one-off request
or a recurring one:

```
agent-bar ticket add "Draft this week's update" --to codex:<id> --after "date:2026-11-23 09:00" --repeat week
```

`--repeat` accepts `day`, `week`, `month`, `<N>h`, `<N>d` or `<N>w`, with an interval of at least an hour. Give it
one starting time. A monthly message scheduled for the 31st lands on the last day of a shorter month, then returns
to the 31st when it can. If your computer was off when deliveries were due, one overdue copy goes out when it comes back and the rest are
skipped.

A one-off ticket closes on delivery. A repeating one stays under **Scheduled** until you drop it. If the chat has
closed, the ticket shows why delivery failed and retries every 10 minutes.

Click the clock beside a Claude or Codex chat to set the message, delivery time and optional repeat interval, or to
inspect its schedule. With **Wake idle chats** off, the chat reads it on your next prompt.

A message you schedule arrives as your request. A ticket scheduled by an agent with `--to` identifies that agent as
the sender and counts toward its sending limits.

## Task checklists

Open the list beside a chat to see its project’s checklists in `tmp/agent/checklists/`. Files that chat edited
appear first, followed by files updated in the past 14 days, then older files with open items. Expand a file to see
progress, suggested next work and linked checklists. **Open** shows the file in VS Code.

**Checklist format**

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
`~/.local/state/rota`. Without it they stay out of the way; **Settings › Integrations › Job scheduler** turns them
off entirely.

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

Start with `agent-bar doctor`. It checks the installed components, hooks and service, and suggests fixes. It also
checks whether the `agent-bar` on your `PATH` is the copy the service runs. To see which copy your shell found,
use `agent-bar --version`.

- **The extension does not appear after the first install.** GNOME Shell finds new extensions at login. Log out and
  back in (or on X11 press Alt+F2, type `r`, press Enter), then run `agent-bar install` again to enable it.
- **A VS Code window's chats are missing, or bringing one forward lands on the wrong tab.** Reload that window
  (Developer: Reload Window) so it runs the current bridge.
- **Codex turns are not tracked.** Codex asks you to review new hooks once; run `/hooks` in Codex and accept Agent
  Bar's.
- **The counts stop changing.** `journalctl --user -u agent-bar.service` shows the service's log.
- **Wayland.** Agent Bar is tested on GNOME 42 under X11. Window matching and focusing rely on X11.
