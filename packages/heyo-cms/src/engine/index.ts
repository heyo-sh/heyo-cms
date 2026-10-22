/**
 * The engine: the local API, the hook pipeline and the transactional outbox.
 *
 * Nothing here is HTTP-aware. The router in stage 7 calls exactly the same
 * functions the local API does, which is the only way `cms.api.posts.find()`
 * and `GET /api/heyo-cms/posts` can be guaranteed to behave identically
 * (section 10).
 */
export {
  CmsEngine,
  globalRowId,
  type EngineOptions,
  type WriteIntent,
} from "./engine";
export { JobRunner, type JobDefinition, type JobHost } from "./jobs";
export { listTrashed, type ListTrashedOptions } from "./trash";
export { EventBuffer, Outbox, type EventDispatch } from "./outbox";
export {
  buildHookPipeline,
  hookPipelineEntries,
  runAfterHooks,
  runBeforeHooks,
  type CollectionHookPipeline,
} from "./hooks";
export { localeContext, resolveLocalized, type LocaleContext } from "./locales";
export {
  rowToDocument,
  scheduledPatch,
  toStoredData,
  validateFields,
  type ScheduledPatch,
} from "./documents";
export {
  applyFieldReadAccess,
  assertFieldWriteAccess,
  hasFieldAccessRules,
} from "./field-access";
export { RelationLoader, relationTarget } from "./relations";
export { scopedDb } from "./scoped-db";
export { cursorWhere, encodeCursor } from "./cursor";
