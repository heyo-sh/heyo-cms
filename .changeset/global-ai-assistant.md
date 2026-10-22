---
"@heyo-sh/heyo-cms": minor
"@heyo-sh/heyo-cms-admin": minor
---

Replace the document chat with a panel-wide AI assistant, and give every
document a revision.

**The assistant.** One agent, running in the CMS process, reachable from every
signed-in screen. It calls typed tools that go through the ordinary public API
with the signed-in actor and `source: "ai"`, so a change it makes runs exactly
the same access control, field access, validation, hooks, media accounting,
events and activity log as somebody typing into the form. There is no SQL tool,
no database adapter, no `fetch`, no file read and no credential tool.

- `ai.assistant` configures a model, one standing instruction and the budgets.
  Nothing else: what the agent may read and write is derived at runtime from
  the live configuration and the actor, so there is no second access-control
  system to drift from the real one.
- `POST /ai/assistant` streams server-sent events with the CMS's own contract,
  independent of the agent library's internals. `POST /ai/assistant/plans/:id/approve`
  applies a stored plan.
- A single unambiguous edit to an existing record saves immediately. Creating,
  deleting, restoring and anything touching more than one record become a plan
  with an expiry that a human approves; approving replays the stored row rather
  than asking the model again.
- `@mariozechner/pi-agent-core` is a new optional peer dependency, imported
  lazily alongside `@mariozechner/pi-ai`. Without it the endpoint answers
  `ai_assistant_runtime_missing` by name.
- New events `ai.agent.completed`, `ai.agent.failed` and
  `ai.agent.mutation.applied` carry run id, model, usage, duration, tool names
  and changed field names — never the prompt, the answer or the record.

**Revisions (all writers, not only AI).** `documents` gains a `revision` column
starting at `1` and incremented by every write, exposed on every read.
`expectedRevision` on `update`/`delete`/`restore` — `If-Match` or `revision` in
the body over HTTP — makes a write conditional and answers `409
revision_conflict` instead of overwriting. The panel sends it on every save and
shows a conflict rather than silently winning. `CreateArgs`/`UpdateArgs` also
accept `idempotencyKey`, recorded inside the write transaction so a retried
request does not run the hooks and the outbox twice.

The activity log gains a `source` column (`admin`, `rest`, `job`, `ai`, …),
filterable through `GET /activity?source=ai`, and carries `runId` in `changes`
for agent writes. The actor stays the human who asked.

**Breaking.** The document chat is removed rather than deprecated:

- `ai.chat` and `collection.ai.chat` are start-up errors with a migration
  message, including from untyped JavaScript. Ignoring a deployment's stated
  opinion about what AI may read, while shipping an agent that writes, would be
  the worst possible upgrade.
- `POST /:collection/:id/chat` is gone and 404s; it is not redirected, because
  the replacement is not drop-in compatible.
- `cms.ai.chat()` → `cms.ai.runAssistant()`; `PanelAi.chat` → `PanelAi.assistant`;
  `PanelCollection.chat` and `PanelChat` are removed, as is the panel's `AiDock`.

Field actions (`field.ai`) are unchanged.

Also fixes a latent bug in the MongoDB adapter: a conditional update re-read its
rows through the original filter, so any update whose `WHERE` matched on a
column it was about to change reported that it had modified zero rows.
