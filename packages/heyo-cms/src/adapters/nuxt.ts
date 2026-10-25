import { CmsError } from "../errors";
import type { CmsHandler } from "../types/instance";

/**
 * Nuxt (h3).
 *
 * ```ts
 * // server/routes/api/heyo-cms/[...path].ts
 * import { cmsHandler } from "@heyo-sh/heyo-cms/nuxt";
 * import { cms } from "~/heyo-cms.config";
 *
 * export default defineEventHandler(cmsHandler(cms));
 * ```
 *
 * The one adapter that is more than a wrapper, because h3 is the one runtime
 * in this list that does not hand over a `Request`. Three shapes are accepted,
 * duck-typed rather than imported: `h3` is not a dependency of this package
 * and adding one so that a Nuxt project can mount a CMS would make every
 * other project pay for it.
 *
 * - **h3 v2** events carry `event.web.request` — used directly.
 * - **h3 v1** events carry `event.node.req` — converted, including a
 *   streaming body, with `node:stream` imported only on this path.
 * - A plain `Request`, which is what `toWebHandler()` passes.
 *
 * The generator has no Nuxt template in v1 (stage 10); the adapter is here
 * because the contract is the same one every other framework gets.
 */
export interface HandlerLike {
  handler: CmsHandler;
}

interface WebEvent {
  web: { request: Request };
}

interface NodeEvent {
  node: {
    req: {
      method?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
    };
  };
}

export type NuxtEvent = Request | WebEvent | NodeEvent;

export interface NuxtHandlerOptions {
  /**
   * Delivers a write's events before the runtime freezes. h3's own
   * `event.waitUntil` is used when the event has one.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function cmsHandler(
  cms: HandlerLike,
  options: NuxtHandlerOptions = {},
): (event: NuxtEvent) => Promise<Response> {
  return async (event: NuxtEvent) => {
    const own = (event as { waitUntil?: (promise: Promise<unknown>) => void })
      .waitUntil;
    const waitUntil =
      options.waitUntil ??
      (typeof own === "function" && !(event instanceof Request)
        ? own.bind(event)
        : undefined);
    return cms.handler(
      await toRequest(event),
      waitUntil ? { waitUntil } : undefined,
    );
  };
}

async function toRequest(event: NuxtEvent): Promise<Request> {
  if (event instanceof Request) return event;
  if (isWebEvent(event)) return event.web.request;
  if (isNodeEvent(event)) return fromNodeRequest(event);

  throw new CmsError(
    "This does not look like an h3 event or a Request. Pass the event from `defineEventHandler`, or use `toWebHandler`.",
    { status: 500, code: "unsupported_event" },
  );
}

function isWebEvent(event: NuxtEvent): event is WebEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "web" in event &&
    typeof (event as WebEvent).web?.request === "object"
  );
}

function isNodeEvent(event: NuxtEvent): event is NodeEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "node" in event &&
    typeof (event as NodeEvent).node?.req === "object"
  );
}

/**
 * An h3 v1 event, turned into a `Request`.
 *
 * The body is streamed rather than buffered, because this is the path an
 * upload takes and reading a 25 MB file into memory to hand it to a function
 * that will stream it anyway is the kind of detail that makes a framework
 * adapter the slowest part of a deployment.
 */
async function fromNodeRequest(event: NodeEvent): Promise<Request> {
  const request = event.node.req;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      headers.append(key, entry);
    }
  }

  const host = headers.get("host") ?? "localhost";
  const protocol = headers.get("x-forwarded-proto") ?? "http";
  const url = new URL(request.url ?? "/", `${protocol}://${host}`);
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  if (!hasBody) return new Request(url, { method, headers });

  const { Readable } = await import("node:stream");
  // `Readable.toWeb` is typed against Node's own stream declarations, which
  // model the chunk type more loosely than the DOM ones a `Request` body
  // wants; the bytes are the same bytes.
  const body = Readable.toWeb(
    request as unknown as import("node:stream").Readable,
  ) as unknown as ReadableStream<Uint8Array>;

  return new Request(url, {
    method,
    headers,
    body,
    // Required by undici whenever a body is a stream.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
