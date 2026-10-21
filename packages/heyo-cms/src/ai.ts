/**
 * `@heyo-sh/heyo-cms/ai`.
 *
 * `defineAiAction()` and the pieces an action needs. The configuration never
 * mentions pi; this entry point is where a deployment reaches past it — to
 * register an action, to check a model against the catalogue, or to replace
 * the completion function altogether.
 */
export {
  aiActionsFor,
  altAction,
  assertModelExists,
  authTypesForAiProvider,
  customAiAction,
  defineAiAction,
  describeCmsFor,
  generateAction,
  getAiAction,
  improveAction,
  modelsForProvider,
  piCompletion,
  registeredAiActions,
  summarizeAction,
  tagsAction,
  translateAction,
} from "./ai/index";
export type { AssistantSchema } from "./ai/index";
export type {
  AiActionContext,
  AiActionDefinition,
  AiActionOutcome,
  AiApprovePlanArgs,
  AiApprovePlanResult,
  AiAssistantArgs,
  AiAssistantEvent,
  AiAssistantTurn,
  AiCompletionFn,
  AiCompletionRequest,
  AiCompletionResult,
  AiImageInput,
  AiMutationTarget,
  AiPageContext,
  AiPageContextKind,
  AiPlanOperationSummary,
  AiPlanSummary,
  AiProviderStatus,
  AiRunArgs,
  AiRunResult,
  AiUsage,
  CmsAi,
} from "./types/ai";
