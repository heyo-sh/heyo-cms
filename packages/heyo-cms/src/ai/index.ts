/**
 * The AI runtime (section 8).
 *
 * Two things live here and they are deliberately separate. A **field action**
 * is one prompt about one field that produces a value a human approves —
 * `field.ai` is its only switch. The **assistant** is a panel-wide agent with
 * tools that read and write through the ordinary API; `ai.assistant` is its
 * only switch. Importing this module registers the built-in field actions, so
 * `generate`, `improve`, `summarize`, `translate`, `alt` and `tags` exist for
 * any field type that declares them — and `defineAiAction()` adds one on
 * exactly the same terms.
 */
export {
  aiActionsFor,
  altAction,
  customAiAction,
  defineAiAction,
  generateAction,
  getAiAction,
  improveAction,
  registeredAiActions,
  summarizeAction,
  tagsAction,
  translateAction,
} from "./registry";
export { decryptSecret, encryptSecret, keyHint } from "./crypto";
export {
  assertModelExists,
  authTypesForAiProvider,
  modelsForProvider,
  piCompletion,
} from "./pi";
export { aiCredentialsTable, createAi } from "./service";
// Schema description is intentionally a light leaf module. The assistant's
// agent/tools runtime stays lazy so projects without it do not resolve its
// optional dependencies merely by importing `@heyo-sh/heyo-cms/ai`.
export { describeCmsFor } from "./assistant/schema";
export type { AssistantSchema } from "./assistant/schema";
