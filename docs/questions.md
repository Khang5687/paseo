# Questions agents ask in chat text

Agents ask the user questions in plain reply text, in the grilling format:

```
❓ **Q12** - **Strip icons**: round or square?

➡️ square icons with the project letter
```

The daemon turns each one into an open question on the agent, so every client counts the same questions and a question stays findable after the reply scrolls away or the chat is compacted. Code: `packages/server/src/server/agent/text-questions.ts`; wire shape `AgentOpenQuestion` on `AgentSnapshotPayload.openQuestions`.

## Finding questions

- Only a line that starts with `❓` opens a question, the same rule as the needs-you icon (`awaiting-answer.ts`). A `❓` after a bullet, indent or quote is prose.
- The label (`Q12`), the bold title and the `➡️` pick are each optional. Without bold, the title runs to the first colon. A question without a label gets an id from its title.
- The body runs to the `➡️` line. Without a pick nothing marks the end, so the body is the first paragraph only; the rest of a reply (Goal, Left to do) is not part of the question.
- The pick runs to the next blank line, rule (`---`) or question, and keeps the agent's words. A leading "My pick:" is dropped.
- The daemon parses the reply that ends a turn, and only when no user message came after it. A turn that ends without text would otherwise re-read an older reply and reopen questions the user has answered.
- A question asked again replaces its earlier copy. An agent keeps at most 50 open questions; the oldest go first.
- Internal and background agents raise no attention and track no questions: they report to their creator.

## What answers a question

A user message answers:

- every open question whose label it names (`Q12 yes`, `Q1 a Q2 b`);
- with no label named, a short blanket answer (`gwr`, `yes`, `ok go`, 120 characters at most) answers the questions from the latest reply that asked any. `gwr for all` answers all of them. These are the owner's answer words (agent-home `GLOSSARY.md`: gwr, "a plain yes takes your pick");
- a question without a label, whatever the message says, since nothing can name it.

Anything else leaves labelled questions open. Messages from other agents arrive as user messages too; only the user's own words answer.

## Status

An idle agent with open questions is `needs_input` (`deriveAgentStateBucket`, `openQuestionCount`) even after its chat is read, unlike the `awaitingAnswer` flag, which clears with the attention. A running agent shows as running. For a read chat the workspace's `statusEnteredAt` is when the newest open question was asked.

To check it again: `npx vitest run src/server/agent/text-questions.test.ts` and `npx vitest run src/server/agent/agent-manager.test.ts -t "open questions"` from `packages/server`.
