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

/**
 * Where an operation entered the engine. Carried through to hooks and events.
 *
 * `ai` is the global assistant writing on an editor's behalf. It is a source
 * and not an actor: the person who asked for the change is still the actor,
 * because "who is accountable" and "what typed it" are different questions and
 * an audit trail that confuses them cannot answer either.
 */
export type OperationSource = "rest" | "admin" | "local" | "cli" | "job" | "ai";
