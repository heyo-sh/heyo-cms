/**
 * One error type for everything a caller can provoke.
 *
 * A hook that throws, an access rule that refuses and a field that fails
 * validation all end up in the same HTTP response builder, so they all carry
 * the status and a machine-readable code instead of leaving the transport
 * layer to guess from the message.
 */
export class CmsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      details?: unknown;
      /**
       * The error this one replaces, for the operator's log.
       *
       * `details` is part of the response and `cause` never is: when a
       * provider or a driver fails, the caller gets a sentence and a code
       * while the original stack stays where somebody debugging can reach it.
       */
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause }); // prettier-ignore
    this.name = "CmsError";
    this.status = options.status ?? 400;
    this.code = options.code ?? "cms_error";
    if (options.details !== undefined) this.details = options.details;
  }

  static notFound(message = "Not found"): CmsError {
    return new CmsError(message, { status: 404, code: "not_found" });
  }

  static forbidden(message = "Forbidden"): CmsError {
    return new CmsError(message, { status: 403, code: "forbidden" });
  }

  static unauthorized(message = "Unauthorized"): CmsError {
    return new CmsError(message, { status: 401, code: "unauthorized" });
  }

  static conflict(message: string): CmsError {
    return new CmsError(message, { status: 409, code: "conflict" });
  }

  static validation(message: string, details?: unknown): CmsError {
    return new CmsError(message, {
      status: 422,
      code: "validation_failed",
      ...(details === undefined ? {} : { details }),
    });
  }
}

/**
 * A mistake in the configuration, not in a request.
 *
 * These are thrown while `heyoCms()` is still building, so they must read like
 * a compiler diagnostic: what is wrong, where, and what to write instead.
 */
export class CmsConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "CmsConfigError";
    this.path = path;
  }
}
