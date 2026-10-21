import { CmsError } from "../errors";
import type { JsonObject } from "../types/json";

/**
 * Every response the handler produces, in one place.
 *
 * The shape matters more than it looks: a client written against this has to
 * be able to tell "the hook stopped it" from "the document is not there" from
 * "your filter is nonsense" without parsing prose, which is why errors carry
 * `code` and why a stopped write is a status rather than a body.
 */

export const jsonContentType = "application/json; charset=utf-8";

export function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "content-type": jsonContentType, ...headers },
  });
}

export function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function noContent(headers?: Record<string, string>): Response {
  return new Response(null, { status: 204, ...(headers ? { headers } : {}) });
}

/**
 * A write a `before` hook stopped.
 *
 * `null` is the local API's answer (section 5) and HTTP has no `null`, so this
 * is the translation: nothing happened, nothing to return, and a header that
 * says which of the two reasons for a 204 this is. The typed client turns it
 * back into `null`.
 */
export function stopped(): Response {
  return noContent({ "x-heyo-cms-stopped": "before-hook" });
}

/**
 * The one error shape.
 *
 * A `CmsError` already carries the status and the code — a hook that threw, a
 * refused access rule and a failed field validation all arrive here as one
 * type — so this function never has to guess. Anything else is a bug in the
 * CMS and is reported as a 500 whose message is not forwarded: an exception
 * from a database driver routinely contains a connection string.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof CmsError) {
    const body: JsonObject = {
      error: {
        message: error.message,
        code: error.code,
        status: error.status,
      },
    };
    if (error.details !== undefined) {
      (body.error as JsonObject).details = error.details as never;
    }
    return json(body, error.status);
  }

  // Logged rather than swallowed: the operator needs the stack, the caller
  // must not have it.
  console.error("[heyo-cms] unhandled error while serving a request", error);
  return json(
    {
      error: {
        message: "Internal server error.",
        code: "internal_error",
        status: 500,
      },
    },
    500,
  );
}

/**
 * The JSON body of a request.
 *
 * An empty body reads as `{}` because `PATCH /posts/:id` with nothing to say
 * is a legal, if pointless, request — and answering it with a parse error
 * would be a worse description of what happened.
 */
export async function readJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CmsError("The request body is not valid JSON.", {
      status: 400,
      code: "invalid_body",
    });
  }
}

/** The body as an object, which is what every write route wants. */
export async function readJsonObject(request: Request): Promise<JsonObject> {
  const parsed = await readJson(request);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CmsError("The request body has to be a JSON object.", {
      status: 400,
      code: "invalid_body",
    });
  }
  return parsed as JsonObject;
}

/** `data` out of a write body, refusing the shapes that cannot be a patch. */
export function requireData(body: JsonObject, key = "data"): JsonObject {
  const value = body[key];
  if (value === undefined) {
    throw CmsError.validation(`The request body needs a "${key}" object.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw CmsError.validation(`"${key}" has to be a JSON object.`);
  }
  return value as JsonObject;
}

export function requireString(body: JsonObject, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw CmsError.validation(`"${key}" is required.`);
  }
  return value;
}

export function optionalString(
  body: JsonObject,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw CmsError.validation(`"${key}" has to be a string.`);
  }
  return value;
}

export function optionalStringArray(
  body: JsonObject,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  const strings =
    Array.isArray(value) && value.every((entry) => typeof entry === "string");
  if (!strings) {
    throw CmsError.validation(`"${key}" has to be an array of strings.`);
  }
  return value as string[];
}
