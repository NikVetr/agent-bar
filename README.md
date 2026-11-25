<p align="center"><img src="docs/images/header.webp" alt="Agent Bar: AI coding agents trading notes at a bar" width="820"></p>

# Agent Bar

Agent Bar puts your open AI coding agent chats in your desktop's menu bar. You can see at a glance which ones have
finished and need your review, which are still working, and which are waiting on you, and one click brings a chat's
window forward. It also shows your projects' git status and usage limits, lets agents in different chats leave each
other notes and tickets for later, and can follow job queues from the optional parallel-workers scheduler.

It reads only local files that the agent tools already write, plus small hooks that record when a turn starts and
ends. Nothing leaves your computer unless you turn on reading Claude's usage limits (see [Privacy](#privacy)).

<!-- Placeholder: a short screen recording (GIF or MP4, under 10 MB) of the top bar: a reply finishes, its review
     button appears, a click brings the chat forward. -->

## A tour

<!-- Placeholders: one screenshot per item, 1000-1400 px wide, taken in the disposable test shell
     (tmp/scripts/session-shot.sh) with fixture data rather than real projects. -->

- **The top bar.** Chats needing review / open per provider, weekly limit left, working and waiting counts, agent
  mail, ready tickets, queue progress, and a button for each chat that needs you.
  *(screenshot: top bar)*
- **Chats.** Every open chat by project and window, with its state, why it needs review, and a copy button for its
  name, id and resume command. *(screenshot: Chats tab)*
- **Messages and tickets.** Agents in different chats leave each other notes, or tickets for work to do later,
  waiting for a usage limit to reset, queues to finish, or a time. *(screenshots: Messages tab, Tickets tab)*
- **Quota.** Each provider's 5-hour, weekly and per-model limits, the pace, and when you would run out compared with
  the reset. *(screenshot: Quota tab)*
- **Git and History.** Uncommitted and unpushed work in every open repository; every saved chat, resumable in its
  folder. *(screenshots: Git tab, History tab)*
- **Queues and Cluster** (with parallel-workers). Job queues per project, adjustable from the bar, and each host's
  CPU, memory and disk. *(screenshots: Queues tab, Cluster tab)*

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
| Linux, GNOME Shell 45 and later | the top bar | planned |
| macOS | the menu bar | planned |
| Windows | the system tray | planned |

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
- the `agent-messages` skill, which tells Claude Code and Codex agents how to use messages and tickets, unless you
  already have a skill of that name;
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
- **🎫 2**: tickets that came due, having waited for something that has now passed, while there are any (**Settings ›
  Top bar › Ticket count** can count every ticket ready to start instead). Clicking it opens the Tickets tab.
- **Q 2 / 5**: queues finished / outstanding since each project's last turn, with the scheduler integration.
- Each part lights on its own and opens the dropdown on its tab: the chat counts on Chats, Q on Queues, ✉ on Messages,
  the ticket count on Tickets, the limits on Quota, the cluster indicator on Cluster. With the dropdown open, clicking another part switches tabs;
  clicking the open tab's part, or anywhere else, closes it.
- **▾**: every window with a chat, with a dot for its most urgent state; click one to bring it forward. Below
  them, **New VS Code window** opens one maximized on your main display, and **Saved chats** opens History.
- **Shortcut buttons**: chats needing review get a button that brings them forward, the longest waiting first, as
  many as fit, continuing right of the middle when the left half is full; **+2 more** lists the rest. Spare room shows
  more of each name. Several chats in one project share a button: the project's name, then a numbered bubble per chat
  in its provider's color; a bubble brings that chat forward, the name the longest-waiting one, and the others
  renumber from 1. **Settings › Top bar** sets the most buttons and,
  with checkboxes, which reasons give one: a finished reply, a failed turn, a question, an approval, finished queues
  (all on by default), and a stop at a 5-hour or weekly usage limit (off by default; the Chats tab shows those chats).
  Codex permission requests must stay pending for 10 seconds to raise a review button. Finished replies and questions
  appear on the next refresh.

Clicking the counts opens the dropdown, with these tabs:

- **Chats**: open chats grouped by project and window, with sort and filter, each with its whole name and a copy button
  for its name, id, folder and resume command. Chats and History share a search box, including `repo:` scopes,
  highlighted message excerpts and **Show context**. Switching tabs keeps your search. Chats shows open conversations
  and History includes closed ones. Message text comes from the saved History index.
  Clicking a chat selects it and brings its window forward. When several Codex
  chats share a window and the sidebar could show any of them, the row and review shortcut open the selected chat
  by ID in an editor tab. Clicking again sends the window back. When a usage limit stops chats open in VS Code, a line above
  them names them and when Claude's limit resets; **Continue** queues "Please continue where you left off." in the
  Codex ones, which start it on their own, and brings each Claude one forward with that text at the end of its input
  box, after any draft, for you to send. If Agent Bar cannot be sure the cursor is in that box (several Claude chats on
  show in the window, or a bridge from before this feature), it leaves the text on the clipboard instead.
  Enable **Settings › Integrations › Resume Codex after reset** to continue an open VS Code thread automatically
  when its recorded five-hour limit resets. Starting another turn clears the pending continuation.
  Weekly limits, depleted workspace credits, and stops with an unknown reset still have the manual **Continue** action.
- **Queues**: job queues from parallel-workers, by project, with progress, ETA and failed jobs. A project's finished
  queues count until a chat there starts a turn, or until you press Clear beside the project. **Adjust** on a queue,
  and under **Pool and hosts**, changes what the scheduler offers there (see below). Each project numbers its active queues from `1` in
  launch order. The numbers close up as queues finish. Search for `2` to see the second active queue in each project.
  Below the status badge, the right end of the progress line shows related queues and the default priority.
  On queue 2, **Needs 4 · Needed by 3** means queue 4 must finish before queue 2 can run, and queue 3 waits for queue 2.
  Active queues use their project numbers. Other referenced queues share the next available numbers in their project
  for this menu visit. A number with ↗ refers to another project.
  Failed or incomplete prerequisites appear in red with **!**, and **?** marks unknown or unverified outcomes.
  Hover over a queue number for its name, project, status, and available progress details, including ETA.
  Hover over **Needs** or **Needed by** for its full list, or over the priority for host overrides.
- **Git**: each repository holding an open project, with its branch, uncommitted files, and commits ahead of or
  behind its upstream (as of the last fetch; Agent Bar never fetches or takes git's lock). Clicking one opens VS
  Code's Source Control for it.
- **Messages**: notes between agents, as threads.
- **Tickets**: tasks to do later (see below), ready ones first, then those scheduled to be sent to a chat, those
  waiting, started, and recently closed. **New
  ticket** writes one: its text, its project (the most recently active open folders first), and what it waits for.
  **Start** opens a new Claude Code chat in the ticket's folder, in VS Code (opening a window there if none is), with
  the ticket as its prompt in the input box, unsent, for you to read and send. A copy button copies the same prompt,
  for a Codex chat or any other; **Done**, **Drop** and **Reopen** close or reopen a ticket.
- **History**: search saved Claude and Codex chats by title, folder, or words in your messages and the agents’ replies.
  Type `memory share` to search all projects or `repo:agent-bar memory share` to narrow the search. Use quotes around
  folder names with spaces. A message match shows who wrote it and a wrapped excerpt with matching words in bold. Each
  keyword can match the start of a word in the same message. **Show context** expands the selected hit in place.
  Use **‹** and **›** to visit occurrences within a message and move between matching messages, newest message first.
  At a message boundary, the preview also shows a short excerpt of the adjacent message when available.
  A title, folder, or provider match is labeled when
  no indexed message matches. Clicking **Open** or **Resume** has the same effect as clicking that conversation’s row.
  The project header’s maximize button brings its window to the main display with the current tab selected. The index updates nightly and with **⟳**.
- **Quota**: each provider's usage limits as Claude Code and Codex record them on this computer: the weekly limit, the
  5-hour one, and a weekly limit for one model such as Fable, with that model's share. Each shows what is left, when it
  resets, its pace over the last day (or this window's average), when that pace would use the rest and how that compares
  with the reset, and, for the weekly limit, the points used each day, split by model where Claude Code reports a share.
  Claude Code refreshes its figures only when it fetches them, as `/usage` does, so they can be hours old; with
  **Settings › Integrations › Read Claude limits** on, Agent Bar reads them itself every 10 minutes. Codex records its
  own as it works. Copilot and Antigravity record none on this computer.
- **Info**: choose a project to inspect its hooks or start a chat with a skill. Expand a hook to see when it runs,
  which action it calls, and where it was configured. Agent Bar’s own hooks also describe their effects.
  Codex reports enablement and trust for the selected folder. Claude entries reflect local settings and enabled
  installed plugins. An individual session can have different settings.
  Info also shows Agent Bar hook and bridge health and the instruction files each project uses.

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
Codex chat open in VS Code. If you already have prompts queued there, Agent Bar moves its inbox notification to
the front. Your current turn finishes normally and your prompts keep their order. With an empty queue, a busy chat
gets a wake-up after its turn if messages are still unread. Priority requires a local `codex` with the app-server
queue API. Older versions with `codex queue` support ordinary wake-ups.
Other chats wait for their next turn. Copilot and Antigravity chats cannot receive messages, because they have no
hook to show the note. In the Messages tab, each chat's badge shows a sealed envelope while it has unread messages,
amber when they wait for you to start a turn there, and an open one once it has read them.

Each message goes to one chat; there is no broadcast. A loop guard refuses an eleventh message to the same chat until
you write to the sender again, and more than 10 an hour; the sender is told which, and for the hourly cap when it can
send again; you can lift it from the Messages tab. Agents are told to treat
messages as information, not as your instructions. You can turn messages off in settings.

## Tickets

A ticket is a task you or an agent wants done later, in one project, for work that cannot or need not happen now:

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
weekly one; `reset:claude:session` picks the 5-hour one), or the queues outstanding then. A ticket is ready once all its
waits have passed. An agent's ticket goes in its own folder unless `--project` names another, and is marked as
coming from that chat; agents cannot write tickets as you. A ticket's prompt asks the chat to run `take` and `done`.
Codex's VS Code extension offers no way to open a new chat with a prompt, so Start makes Claude chats only. Closed tickets are kept 30 days.

### Scheduled messages

A ticket can instead be sent to an open Claude Code or Codex chat once it is ready, as a message: a one-off
reminder or request, or one that repeats.

```
agent-bar ticket add "Draft this week's update" --to codex:<id> --after "date:2026-11-23 09:00" --repeat week
```

`--repeat` takes `day`, `week`, `month`, or `<N>h`, `<N>d` or `<N>w` (at least hourly), and needs one time to start
from. Repeats count from that first time (a monthly send on the 31st comes back to the 31st, or the month's last day);
sends missed while the computer was off are skipped, not sent late. A one-off ticket closes once sent; a repeating one
stays under **Scheduled** in Tickets until you drop it. If the chat has closed, the ticket shows the reason and tries
again every 10 minutes.

The **Schedule** button (a clock) on each Claude or Codex chat in the Chats tab opens a second dropdown beside the main one: the
message, when to send it (in an hour, tomorrow at 9, next Monday at 9, or a typed time), how often to repeat it, and
what is already scheduled for that chat. The **New ticket** form can also send a ticket to one of its project's chats.

Your scheduled messages arrive as your own requests: the chat's note says so, unlike messages from other agents,
which are information only. So only you can schedule them. A ticket an agent writes with `--to` arrives from that
agent, under the loop guard, and Agent Bar refuses a ticket from a command an agent started without its session id.
With **Wake idle chats** off, a scheduled message waits for your next prompt in that chat.

## Task checklists

Agents keep task checklists in each project's `tmp/agent/checklists/` (the format the `task-checklists` skill
describes). The **list** button on a chat in the Chats tab shows its project's checklists in a second dropdown beside the main one: those the
chat was seen editing, then others updated in the last 14 days, then older ones that still have open items (folded,
with any items that need you kept in view). For each: a progress bar, a suggested next item, what needs you, what
waits or was deferred, the checklists it links to, and which open chats last edited it. **Open** shows it in VS Code.

What Agent Bar reads, and how:

- Only checkbox lines count, outside fenced code: `[ ]` open, `[x]` or `[X]` done, `[-]` dropped (left out of the
  total). Any other marker counts as unrecognized, never as done. Indentation and numbered items are fine.
- An open item starting `User:` needs you, `Waiting:` waits on something else, `Deferred:` was postponed. The first
  open item without one is the **suggested next**, an ordering guess, not a priority.
- A file with nothing open says "no open items recorded", not "done".
- Links to other checklists are listed with their own counts; counts are never added up from links.
- **Last edited by** names the open chats whose transcripts (the last 2 MB, then what they append) show them writing
  the file: Claude's Edit and Write, Codex's apply_patch, or a shell command that writes to it. It is evidence, not
  ownership, and a chat that edited it before Agent Bar was watching is not named.

The service scans the open projects every 30 seconds and writes the result to `checklists.json`, which the panel reads
when the column opens; files are reread only when they change.

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
disks. Click a node name to open a side dropdown with one pair of bars per project using job slots there.
CPU shows reserved slots as a share of the node's job-slot budget. Memory shows the sampled footprint of the
project's jobs as a share of the node's physical RAM. Fixed-worker queues report slots only. The dropdown
refreshes about every 15 seconds while open.
The tab also lists failed jobs by project, with a note to copy for that project's agent and buttons that bring its VS Code
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
agent-bar queues        # numbered queues and their progress
agent-bar queue-dependencies  # prerequisite numbers and outcomes
agent-bar queue-dependencies --project example 1 2  # two active queues in one project
agent-bar host-projects HOST  # projects, jobs, reserved CPU slots and sampled memory on one node
agent-bar git           # git status of repositories holding open projects
agent-bar info --project .  # project hooks, skills, tracker health, instruction files
agent-bar usage         # usage limits, with pace, run-out time and use by day
agent-bar ticket list   # tickets and what each waits for
agent-bar inventory     # rescan saved chats
agent-bar search-history --repo agent-bar "memory share"  # matching messages as JSON; omit --repo for all folders
agent-bar search-history --conversation <key> --message 2 --hit 1 "memory share"  # context for one occurrence
agent-bar resume <key>  # reopen a saved chat in VS Code
```

## Privacy

On Linux, Agent Bar keeps its state in `~/.local/state/agent-bar` and its settings in `~/.config/agent-bar`, readable
only by you. The History scan stores searchable message text in a local SQLite index. It skips tool calls, tool
results, reasoning, and client-supplied context. Its hooks record when turns start and end, never prompt or reply text. It contacts no server, unless you
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

<p align="center"><img src="docs/images/footer.webp" alt="" width="640"></p>
