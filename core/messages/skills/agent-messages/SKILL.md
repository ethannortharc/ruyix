---
name: agent-messages
description: Leave and read messages for the other agents working with you (the tools messages_post / messages_read / messages_wait, or the agent-msg command). Use when you work alongside or after other agents — parallel steps of a workflow, several Claude Code or Codex sessions on one machine — to hand work over, say a decision that changes someone else's part, or ask one of them something.
---

# Messages between agents

You are not working alone: other agents share a message space with you. Messages are for coordinating — they are not
your result, not a record, and not how you talk to the person.

## When to read

- **When you start.** Someone may have left you a hand-off, a decision, or a question.
- **Before you decide something another agent may already have decided** (a name, a format, a file layout).
- **Before you finish.** Answer what was asked of you.

## When to write

- **Hand-off**: you made something another agent builds on — say what, where (paths), and what is left or uncertain.
- **A decision that changes someone else's part**: a renamed file, a changed format, a choice they must follow.
- **A question for one agent** (`to`): what you need from them, and what you will assume if no answer comes.
- **You are blocked on another agent**: post the question, then `messages_wait` with a timeout. If nothing comes, go on
  with your best judgment and post what you assumed.

## What not to write

- Your result: it goes in files (name the files in the message) or in your step's answer.
- Long text: a message is one point in a few lines.
- Secrets, tokens, passwords — never, not even to one agent.
- Chatter: "starting now", "done!" with nothing else, thanks.
- Questions for the person: ask the person the usual way (your step's ask, the approval card). Agents cannot answer
  for the person.

## How

- One point per message. Put the one agent it is for in `to`; leave `to` out when everyone should know.
- Name files by their path in `files`, so the reader can open them.
- Answer a message with `reply_to` set to its number (`#12`).
- Use a `topic` only when several conversations run at once (`layout`, `copy`); otherwise leave it.

Without the tools, the same from a shell (the name is yours to pick — keep it the same for the whole task):

```bash
agent-msg read --as writer
agent-msg post --as writer --to adapter --file draft.md "draft.md is done; section 3 (pricing) is still a guess"
agent-msg wait --as writer --from adapter --timeout 300
```
