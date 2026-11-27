# Needs you

Needs you is one page with every chat that waits on the user, on every host, and the cards to
answer them without opening each chat. It opens from the button above **All** on the project rail,
or the first chip in the phone's chip row. Route: `/needs-you`
(`packages/app/src/needs-you/needs-you-screen.tsx`).

## What waits

A chat waits when its sidebar row is `needs_input`, the purple status: a pending permission or
question box, open ❓ questions ([docs/questions.md](questions.md)), or a reply that asks
something. The page reads the same `WorkspaceDescriptor.status` the sidebar dot reads, through
`deriveEffectiveWorkspaceStatus`, so the page and the dots never disagree.

- Hidden (`background`) and archiving workspaces are left out.
- The longest waiting chat comes first, by `statusEnteredAt`. A host that sends no time sorts last.
- Each chat shows every card its agents have: one `QuestionCard` per open ❓ question, and the same
  `PermissionRequestCard` the chat draws for each pending box. A chat with no card, one whose reply
  just ends in a question, says so and offers **Open chat**.

`listNeedsYouChats` in `packages/app/src/needs-you/model.ts` builds the list; it is pure, and
`model.test.ts` pins the order and the per-chat cards.

## One Send for many chats

The footer's Send goes to every chat at once. Each agent with at least one answered card gets one
message with only its own answer lines, the same message the composer's questions bar sends
(`sendQuestionAnswers` in `packages/app/src/questions/send-answers.ts`). Skipped cards stay open
on the page and in the chat. A chat that fails keeps its answers and the others still go.

Copy answers, left of Send, copies those lines without sending: each chat's lines under a header line with the chat's title, in page order, a blank line between chats (`buildCopyAnswersText`). Questions stay open. Details in [docs/questions.md](questions.md#the-questions-bar).

Half answers are the questions bar's: they save as you type and reach every device, so a card half
answered on the phone shows the same on the desktop page.

Permission boxes answer on their own buttons, at once, as in the chat.

## The number

The rail button and the phone chip carry a purple count, the color of a chat asking you. It counts
waiting chats plus what plugins count (`addNeedsYouItem`, see
[docs/plugins.md](plugins.md#contribute-needs-you-items)); the Tasks plugin adds late and
due-today tasks. `useNeedsYouCount` selects a number from the session store, so streaming in
other chats does not redraw the rail.

## Peek from the rail

A project with a waiting chat answers from the strip without leaving the open chat. On the
desktop, rest the pointer on its rail icon: a hover card replaces the name tooltip. On the phone,
hold its chip: the chip's sheet shows the peek above its menu rows. The peek shows the project's
oldest waiting chat and its first question, with the pick as one button that sends at once, a
field for your own words with Send, Open chat, and "N more waiting" to this page
(`packages/app/src/needs-you/project-peek.tsx`). A chat waiting on a permission box shows the box;
one that asks only in prose says to open the chat.

The peek sends one answer line, the same line Send writes here, so the question closes on the
host as usual. It filters `useNeedsYouChats` by the project's hosts and mounts only while open,
so the rail itself reads only the status counts it already had.

The rail and the chip show the peek only while the project waits, and sending ends the wait. So
from the first send until it closes, the peek keeps the chat it is answering and holds its own
gate open through `onHoldChange`; without that the hover card turns back into the tooltip
mid-send and "Sent" never shows.

## Check it again

`packages/app/e2e/browser/needs-you.spec.ts` seeds two mock chats that each end with ❓ questions,
opens Needs you by tapping, answers one card in each chat, sends once, and checks each chat got
only its own line while the skipped card stays. It runs at desktop width and at 390×844, tapping
the chip. Screenshots land in `test-results/`.

`packages/app/e2e/browser/project-peek.spec.ts` hovers a waiting project's rail icon and clicks
the pick, then at 390×844 holds the chip and sends typed words; both check the open chat stayed
put and the waiting chat got the answer line.
