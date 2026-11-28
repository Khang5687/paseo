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
- A line that starts with `✖️` withdraws one of the agent's own open questions: `✖️ Q630 → Q653: folded into "When the pause ends"` or `✖️ Q640: dropped, no longer needed`. The same parse rules apply: line start only, only the reply that ends a turn, and only when no user message came after it. A reply may hold several. An unknown label is ignored, and a label the same reply asks again with `❓` stays open. The parser is shared with the app: `packages/protocol/src/question-withdraw.ts`.
- Internal and background agents raise no attention and track no questions: they report to their creator.

## What closes a question

A question closes when a user message answers it or when the agent withdraws it. Either way it leaves `openQuestions`, so the purple count, Needs you, the questions bar and the rail peek drop it on every device at once, and the stored record keeps it closed through a restart.

A user message answers:

- every open question whose label it names (`Q12 yes`, `Q1 a Q2 b`);
- with no label named, a short blanket answer (`gwr`, `yes`, `ok go`, 120 characters at most) answers the questions from the latest reply that asked any. `gwr for all` answers all of them. These are the owner's answer words (agent-home `GLOSSARY.md`: gwr, "a plain yes takes your pick");
- a question without a label, whatever the message says, since nothing can name it.

Anything else leaves labelled questions open. Messages from other agents arrive as user messages too; only the user's own words answer.

## Status

An idle agent with open questions is `needs_input` (`deriveAgentStateBucket`, `openQuestionCount`) even after its chat is read, unlike the `awaitingAnswer` flag, which clears with the attention. A running agent shows as running. For a read chat the workspace's `statusEnteredAt` is when the newest open question was asked.

## Withdrawn questions

A `✖️` line shows in the chat as one small gray line, "Q630 withdrawn → Q653", without the agent's reason; the old `❓` question keeps its words. Tapping a line that names a replacement jumps to the newest loaded reply that asks it: on web to the question's own line, which flashes once; on native to the top of that reply. A replacement that is not in the loaded chat shows a toast. Hosts without `features.questionWithdraw` do not close withdrawn questions, so the app shows their `✖️` lines as plain Markdown.

A withdrawn question's half answer goes with it. The host refuses `agent.question.answer.set` for a question that is not open, so a late write from another device cannot reopen it, and each device drops its own copy once the question leaves `openQuestions` (`packages/app/src/questions/answer-store.ts`), so the same label asked again starts empty.

## The questions bar

A chat with open questions shows a pill in the composer track, "2 open questions · Q100 · Q104" (`packages/app/src/questions/questions-track.tsx`). Tapping it opens every card in one panel: a popover on wide screens, a sheet on the phone, like every track pill. A card has "Go with pick", a field for your own answer, and a paperclip for up to 100 files. An answered card folds to one green line with Change.

Send writes one message with one line per answered card, in the order the agent asked them, and leaves the skipped cards open:

```
Q100 (Strip icons) round, like the avatars
Q104 (Sidebar order) yes: newest first [files: order.png]
```

The line names the title and carries the pick's own words, because a bare "yes" means nothing once the reply that asked has left the agent's context. The words are English on every locale: agents read them and the daemon matches the label.

Copy answers sits left of Send and puts that same text on the clipboard without sending anything, so every question stays open. It is disabled at 0 answered and reads "Copied" for 1.5 s after a tap. It calls `buildAnswerMessage`, the builder Send uses, never a second formatter; the Needs you page copies the same lines per chat ([docs/needs-you.md](needs-you.md#one-send-for-many-chats)).

### Half answers on every device

A half-answered set of cards shows the same answers on every device. The app writes each answer to the host with `agent.question.answer.set` once typing pauses, and the host keeps it on the question (`AgentOpenQuestion.answer`) and sends it with the agent. The newer copy wins on `updatedAt`, this device's or the host's (`resolveAnswer`); a cleared answer keeps its time so an older write cannot bring it back. Files are uploaded to the host when you pick them, so the answer carries only their upload record. Hosts without `features.questionAnswers` never see half answers: they stay on the device until sent.

To check it again: `npx vitest run src/server/agent/text-questions.test.ts` and `npx vitest run src/server/agent/agent-manager.test.ts -t "open questions"` from `packages/server`; `npx vitest run src/questions/answer-message.test.ts` and `npx playwright test --project=browser e2e/browser/open-questions-bar.spec.ts` from `packages/app` (it seeds a mock agent whose reply asks Q100, Q101 and Q104, and saves phone and desktop screenshots under `test-results/`).

## Question boxes

A provider's own multi-question box (`AskUserQuestion`, a pending permission with `kind: "question"`, `packages/app/src/components/question-form-card.tsx`) follows the same rules where they fit:

- **Picks on every device.** The box writes its picks, typed words and files to the host with `agent.permission.draft.set` once typing pauses. The host keeps them on the pending permission (`AgentPermissionRequest.draftAnswers`) and sends them with the agent's state, so a box opened on another device starts from them, and an open box takes a newer copy as it arrives. The newer `updatedAt` wins. The draft lives only as long as the box is pending: the daemon does not persist it, so a daemon restart, which ends the box anyway, drops it. Hosts without `features.questionBoxDrafts` keep the picks on the device.
- **Send what I have.** With more than one question, at least one answered and not all, the box offers "Send what I have". It answers the box with every open question set to `No answer yet: use your pick or ask me again` (`NO_ANSWER_YET`), so the agent goes on with what it has. Unlike the questions bar, the provider's tool call needs an answer for every question to return, which is why the box fills them in instead of leaving them open.
- **Files.** Each question takes up to 100 files through the same paperclip as the questions bar (`packages/app/src/questions/answer-files.tsx`). Its answer ends with `Files: <path>, <path>`, the host paths of the uploads.

To check it again: `npx vitest run src/server/agent/agent-manager.test.ts -t "question box"` from `packages/server`; `npx vitest run src/components/question-form-card-core.test.ts` from `packages/app`.
