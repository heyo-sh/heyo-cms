---
"@heyo-sh/heyo-cms": patch
"@heyo-sh/heyo-cms-admin": patch
---

**The Approve card is the question, and it arrives with the answer.**

The assistant used to ask "shall I delete it? (yes/no)" in the chat and only
call the approval tool after the editor said yes, who then confirmed a second
time on the card. On a live model, "delete the courier post" stopped to ask
instead of preparing the deletion, and a bulk request ("fill in the SEO
description on every post") saved posts one by one, ran out of steps and asked
whether to do the rest.

- The prompt and every approval tool (`create_document`, `trash_document`,
  `restore_document`, `create_mutation_plan`) now say: once you know the record
  and the change, call the tool. The card is how the editor confirms, so never
  ask in words. A single change the model wants reviewed is proposed as a plan,
  not asked about. A request to improve something is carried out, not answered
  with "which version should I save?".
- One record per request is saved directly. `update_document` refuses a second,
  different document in the same run and points the model to
  `create_mutation_plan` with the rest. The documented rule that "anything
  touching more than one record waits for a human" is now enforced in the tool
  layer, not only asked for in the prompt.
- A run that has run out of steps (not of time) may still make one proposal in
  its wrap-up turn. A proposal writes nothing, and it is the answer the editor
  asked for.
- The approval tool result no longer carries the plan id (models read it out:
  "plan aip_… awaits your confirmation"). It carries the records' titles
  instead, so a batch is described by title rather than as `doc_…` lines.

The card also used to appear before the explanation for it. The plan was
announced the moment the tool ran, and the answer then arrived _above_ a button
the editor was already reading. Now `approval-required` is sent after the
answer, right before `done` (or before `error`, if the run failed after making
the plan, which is stored and still approvable). The panel also draws a turn's
Saved and approval cards only once the turn is complete. Open screens are still
told about a write the moment it commits.
