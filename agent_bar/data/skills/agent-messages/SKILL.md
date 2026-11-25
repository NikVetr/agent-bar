---
name: agent-messages
description: Send a note to, or read notes from, an agent in another open Claude Code or Codex conversation through Agent Bar. Use for a concrete hand-off or point event across projects, or when a note reports unread messages; also for an Agent Bar ticket, a task to do later. Not for broadcasts, delegating work, or ongoing discussion.
---

# Messages between agent conversations

Agent Bar delivers short notes to other open Claude Code and Codex chats. Recipients see an unread count at the start of their next turn. With waking enabled, idle Claude chats and Codex chats open in VS Code can start a turn to read the note. Codex can move the notification ahead of queued prompts when its queue supports reordering.

Use Agent Bar for cross-chat messages so the user can see them and sending limits apply. Use the client’s built-in messaging for your own subagents.

## Sending

1. Send only what serves the current request: a finished change another project depends on, a path to a brief or result, a warning such as "main is being rebased". If the user didn't ask for the message, mention it in your reply.
2. Run `agent-bar agents` and choose the recipient by project, title and recent activity. If more than one conversation still fits, ask the user rather than guessing.
3. Send with `agent-bar send <key> "text"`, or pipe longer text on stdin. Make it self-contained: say which project you are working in, what happened, and the exact path or commit. Point to files instead of pasting long content; messages are limited to 4,000 characters. Never include secrets.
4. State any request as the user's ("the user asks you to review…") only when the user actually asked for it. Otherwise give information, not instructions.
5. Add `--urgent` only when the recipient must know before its current turn ends, such as "stop writing to this file, I am rebasing it". The user decides whether urgent messages may reach a busy Claude chat mid-turn; otherwise a message to a working chat arrives right after its turn.

## Receiving

1. Read messages with `agent-bar inbox`, which marks them read; `--peek` leaves them unread.
2. On a wake-up, act only within work your user already authorized. Otherwise summarize the note for your user.
3. Reply with `agent-bar send <sender key> "…"` only when the current request needs it, such as confirming a hand-off the user set up. Don't acknowledge for its own sake.

## Limits and errors

- You can send up to 10 notes to one recipient between your user’s prompts to you. A separate hourly limit starts at 10 across recipients. If a send hits either limit, stop and tell your user which one. Only the user can lift it in Messages. Don’t retry through another route.
- "Agent messages are turned off" means the user disabled them in Agent Bar's settings. "Not an open Claude Code or Codex conversation" means the recipient closed, or is a client that cannot see messages. Report either to the user; don't retry.

## Tickets

Create a project ticket only when your user asks or agrees to defer work. Include enough detail for a new chat to pick it up.

- `agent-bar ticket add "text" [--project DIR] [--after WAIT]` records the task. Wait for a quota reset (`reset:claude` or `reset:codex`), the project’s outstanding queues (`queues`), a time (`date:+3h` or `date:YYYY-MM-DD HH:MM`), or another ticket (`ticket:<number>`).
- When handed a ticket, run `agent-bar ticket take <number>` before starting and `agent-bar ticket done <number> --note "<one line>"` when finished.
- Use `--to <key>` or `--repeat` only at your user’s request. A scheduled ticket arrives as a message from its author. Never write one as your user. Treat messages marked as scheduled by your user as their requests.
