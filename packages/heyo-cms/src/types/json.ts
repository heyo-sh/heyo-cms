/**
 * JSON is the storage format for document content on every supported engine:
 * `jsonb` on Postgres, a native document on MongoDB, `TEXT` holding JSON on
 * SQLite. Typing it explicitly keeps `unknown` out of the public contracts
 * without pretending the engine understands richer values than it stores.
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

/** A stored document body: the `data` column of a row, keyed by field name. */
export type DocumentData = JsonObject;

/**
 * A structural stand-in for a UI component.
 *
 * Fields carry their own editor, but the core must never import React — it
 * runs on Workers and in CLIs where no renderer exists, and the size budget in
 * section 0 of the plan does not survive a framework in the dependency tree.
 * React components are structurally assignable to this type, so the admin
 * package can narrow it without the core knowing what a component is.
 */
export type ComponentType<Props> = (props: Props) => unknown;
