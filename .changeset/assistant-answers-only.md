---
"@heyo-sh/heyo-cms": patch
"@heyo-sh/heyo-cms-admin": patch
---

**The assistant answers, instead of showing its work.** The reply used to
start with the editor's own message, followed by the raw JSON of the schema
and of every record the agent read: pi closes the prompt and each tool result
with `message_end` too, and the run streamed those into the answer whenever
the model had not written text of its own first. Together with the model's
running commentary ("let me look that up…") this made answers look like logs,
leaked whole records into the panel and made long answers look truncated.

Now only the model's final message is sent, whole, as `text-delta`, and the
panel shows "Thinking…" until it arrives rather than a list of tool steps. A
run that ends without text falls back to the model's last aside or a plain
sentence, never an empty bubble. The SSE stream sends a comment every 15
seconds so a long, silent step does not trip a proxy's idle timeout.

The limits wind a run down rather than cutting it off: once `maxTurns` or
`maxToolCalls` is spent, or the time left would not cover the answer (three
quarters of `timeoutMs`, or less than twice the slowest step so far), the
tools refuse and the model is told to answer from what it has. A model that
keeps calling tools anyway is stopped with `ai_budget_exhausted`. A run that
does reach the timeout ends with `ai_timeout` instead of "The request was
cancelled.", and shows the part of the answer it had written, marked as
incomplete.

Revisions are no longer shown to the model: reads record the version on the
server and writes are made against it, so answers stop reporting "saved,
revision 3", a write still fails if somebody saved in between, and a record
the agent has not read cannot be written.

An editor who closes the tab or presses Stop aborts the provider call, and no
further model call is made; the run is still recorded as `ai.agent.failed`
with its usage (it used to vanish from the accounts). A connection that drops
mid-run is reported in the panel instead of leaving an empty bubble.

New `ai.assistant.thinking` (`off` … `high`). By default a reasoning model
that cannot switch reasoning off (OpenAI's GPT-5 family) now runs at `low`
instead of its own `medium`, which roughly halves the wait.

The model is also given better material and clearer rules: relations name the
related record, empty fields are one line, untranslated fields say so (a read
in Polish of an English-only post no longer comes back as "translated"),
`find_documents` counts the whole collection, matches the words of a query
rather than only the exact phrase, and can return chosen fields for every
result. The system prompt asks for plain prose in the editor's language — no
JSON, ids, revisions or tool names — content written in the language of the
locale being written (an English field gets English text when the editor asks
in Polish), and the locale on screen being the one read.
