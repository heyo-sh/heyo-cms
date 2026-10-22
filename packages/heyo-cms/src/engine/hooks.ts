import type { ResolvedCmsConfig } from "../types/config";
import type {
  CollectionDatabaseHooks,
  CreateHookInput,
  HookContext,
  HookOperation,
  HookResult,
  MaybePromise,
  UpdateHookInput,
  UpdateHookOutput,
} from "../types/hooks";
import type { HookPipelineEntry } from "../types/instance";
import type { JsonObject } from "../types/json";

/** Where a hook came from and when it runs, carried so `inspect()` can say. */
interface Registered {
  source: string;
  priority: number;
}

export interface BeforeEntry<TInput> extends Registered {
  run: (
    input: TInput,
    context: HookContext,
  ) => MaybePromise<HookResult<JsonObject>>;
}

export interface AfterEntry<TOutput> extends Registered {
  run: (output: TOutput, context: HookContext) => MaybePromise<void>;
}

/**
 * Every hook that can run on one collection, already in execution order.
 *
 * Built once per collection at start-up rather than looked up per write: the
 * order is a property of the configuration, so computing it on every request
 * would be work that cannot change its own answer.
 */
export interface CollectionHookPipeline {
  createBefore: BeforeEntry<CreateHookInput<JsonObject>>[];
  createAfter: AfterEntry<JsonObject>[];
  updateBefore: BeforeEntry<UpdateHookInput<JsonObject>>[];
  updateAfter: AfterEntry<UpdateHookOutput<JsonObject>>[];
  deleteBefore: BeforeEntry<JsonObject>[];
  deleteAfter: AfterEntry<JsonObject>[];
}

/**
 * Assembles the pipeline for one collection.
 *
 * Plugin hooks run first in `priority` order, the configuration's own hooks
 * always run last. A user who installed a plugin can therefore always have
 * the final word over it, without the plugin having to anticipate that
 * (section 5).
 */
export function buildHookPipeline(
  config: ResolvedCmsConfig,
  collection: string,
): CollectionHookPipeline {
  const pipeline: CollectionHookPipeline = {
    createBefore: [],
    createAfter: [],
    updateBefore: [],
    updateAfter: [],
    deleteBefore: [],
    deleteAfter: [],
  };

  const plugins = config.plugins
    .flatMap((plugin) =>
      (plugin.hooks ?? [])
        .filter((hook) => hook.collection === collection)
        .map((hook) => ({ plugin: plugin.id, hook })),
    )
    .sort(
      (a, b) =>
        (a.hook.priority ?? 0) - (b.hook.priority ?? 0) ||
        a.plugin.localeCompare(b.plugin),
    );

  for (const { plugin, hook } of plugins) {
    const registered: Registered = { source: plugin, priority: hook.priority ?? 0 }; // prettier-ignore
    // A plugin hook is written against the document body, not against an
    // operation-shaped argument: one signature works on all three operations
    // and a plugin never has to branch on which one it was installed for.
    if (hook.timing === "before") {
      if (hook.operation === "create") {
        pipeline.createBefore.push({ ...registered, run: (input, context) => hook.handler(input.data, context) }); // prettier-ignore
      } else if (hook.operation === "update") {
        pipeline.updateBefore.push({ ...registered, run: (input, context) => hook.handler(input.data as JsonObject, context) }); // prettier-ignore
      } else {
        pipeline.deleteBefore.push({ ...registered, run: (doc, context) => hook.handler(doc, context) }); // prettier-ignore
      }
      continue;
    }
    const ignoreResult = async (
      input: JsonObject,
      context: HookContext,
    ): Promise<void> => {
      await hook.handler(input, context);
    };
    if (hook.operation === "create") {
      pipeline.createAfter.push({ ...registered, run: ignoreResult });
    } else if (hook.operation === "update") {
      pipeline.updateAfter.push({ ...registered, run: (output, context) => ignoreResult(output.doc, context) }); // prettier-ignore
    } else {
      pipeline.deleteAfter.push({ ...registered, run: ignoreResult });
    }
  }

  // Hooks a plugin installed through `extendCollections()`. They are written
  // against the same shapes the configuration's own hooks use — a plugin
  // that patches a collection is doing what the application would do — so
  // they are registered with the same adapters, just ahead of the user's.
  const patched = config.pluginHooks
    .filter((entry) => entry.collection === collection)
    .sort(
      (a, b) => a.priority - b.priority || a.plugin.localeCompare(b.plugin),
    );
  for (const entry of patched) {
    register(pipeline, entry.hooks, {
      source: entry.plugin,
      priority: entry.priority,
    });
  }

  register(pipeline, config.databaseHooks?.[collection], {
    source: "config",
    priority: userPriority,
  });

  return pipeline;
}

/** Hooks declared in the configuration always run last; this is that "last". */
const userPriority = 100;

/** Adds one set of collection hooks to the pipeline, in registration order. */
function register(
  pipeline: CollectionHookPipeline,
  own: CollectionDatabaseHooks | undefined,
  user: Registered,
): void {
  if (own?.create?.before) {
    const handler = own.create.before;
    pipeline.createBefore.push({ ...user, run: (input, context) => handler(input, context) }); // prettier-ignore
  }
  if (own?.create?.after) {
    const handler = own.create.after;
    pipeline.createAfter.push({ ...user, run: (doc, context) => handler(doc, context) }); // prettier-ignore
  }
  if (own?.update?.before) {
    const handler = own.update.before;
    pipeline.updateBefore.push({
      ...user,
      run: async (input, context) =>
        (await handler(input, context)) as HookResult<JsonObject>,
    });
  }
  if (own?.update?.after) {
    const handler = own.update.after;
    pipeline.updateAfter.push({ ...user, run: (output, context) => handler(output, context) }); // prettier-ignore
  }
  if (own?.delete?.before) {
    const handler = own.delete.before;
    pipeline.deleteBefore.push({ ...user, run: (doc, context) => handler(doc, context) }); // prettier-ignore
  }
  if (own?.delete?.after) {
    const handler = own.delete.after;
    pipeline.deleteAfter.push({ ...user, run: (doc, context) => handler(doc, context) }); // prettier-ignore
  }
}

/**
 * Runs the `before` chain and reports what the operation should do next.
 *
 * One return contract for every hook, which is the part Payload gets wrong:
 * `undefined` continue, `{ data }` continue with a replacement, `false` stop
 * silently, `throw` stop with a status. `apply` is how a replacement folds
 * back into an operation-shaped input.
 */
export async function runBeforeHooks<TInput>(
  entries: BeforeEntry<TInput>[],
  input: TInput,
  context: HookContext,
  apply: (input: TInput, data: JsonObject) => TInput,
): Promise<TInput | false> {
  let current = input;
  for (const entry of entries) {
    const result = await entry.run(current, context);
    if (result === false) return false;
    if (result && typeof result === "object" && "data" in result) {
      current = apply(current, result.data);
    }
  }
  return current;
}

export async function runAfterHooks<TOutput>(
  entries: AfterEntry<TOutput>[],
  output: TOutput,
  context: HookContext,
): Promise<void> {
  for (const entry of entries) await entry.run(output, context);
}

/**
 * The pipeline as `cms.inspect()` prints it.
 *
 * Derived from the same builder the engine runs, so the printed order cannot
 * drift from the executed one — which is the entire value of printing it.
 */
export function hookPipelineEntries(
  config: ResolvedCmsConfig,
): HookPipelineEntry[] {
  const collections = new Set<string>([
    ...Object.keys(config.collections),
    ...Object.keys(config.globals),
    ...config.plugins.flatMap((plugin) =>
      (plugin.hooks ?? []).map((hook) => hook.collection),
    ),
    ...config.pluginHooks.map((entry) => entry.collection),
  ]);

  const entries: HookPipelineEntry[] = [];
  for (const collection of [...collections].sort()) {
    const pipeline = buildHookPipeline(config, collection);
    const lists: [HookOperation, "before" | "after", Registered[]][] = [
      ["create", "before", pipeline.createBefore],
      ["create", "after", pipeline.createAfter],
      ["delete", "before", pipeline.deleteBefore],
      ["delete", "after", pipeline.deleteAfter],
      ["update", "before", pipeline.updateBefore],
      ["update", "after", pipeline.updateAfter],
    ];
    for (const [operation, timing, list] of lists) {
      for (const entry of list) {
        entries.push({
          collection,
          operation,
          timing,
          source: entry.source,
          priority: entry.priority,
        });
      }
    }
  }
  return entries;
}
