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

Half answers are the questions bar's: they save as you type and reach every device, so a card half
answered on the phone shows the same on the desktop page.

Permission boxes answer on their own buttons, at once, as in the chat.

## The number

The rail button and the phone chip carry a purple count, the color of a chat asking you. It counts
waiting chats plus what plugins count (`addNeedsYouItem`, see
[docs/plugins.md](plugins.md#contribute-needs-you-items)); the Tasks plugin adds late and
due-today tasks. `useNeedsYouCount` selects a number from the session store, so streaming in
other chats does not redraw the rail.

## Check it again

`packages/app/e2e/browser/needs-you.spec.ts` seeds two mock chats that each end with ❓ questions,
opens Needs you by tapping, answers one card in each chat, sends once, and checks each chat got
only its own line while the skipped card stays. It runs at desktop width and at 390×844, tapping
the chip. Screenshots land in `test-results/`.
