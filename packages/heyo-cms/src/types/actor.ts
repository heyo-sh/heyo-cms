/**
 * Who is performing an operation.
 *
 * Both authentication methods (editor session, machine API key) collapse into
 * the same shape on purpose: every access rule, hook and activity-log entry
 * then has one thing to read, and a rule written against sessions cannot
 * silently stop applying to API keys.
 */
export interface Actor {
  id: string;
  source: ActorSource;
  roles: string[];
  /** Flattened `collection:action` grants, wildcards already expanded. */
  permissions: string[];
}

export type ActorSource = "session" | "api-key";

/** Where an operation entered the engine. Carried through to hooks and events. */
export type OperationSource = "rest" | "admin" | "local" | "cli" | "job";
