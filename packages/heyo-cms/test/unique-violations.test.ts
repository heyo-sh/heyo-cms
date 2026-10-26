import { describe, expect, test } from "bun:test";

import {
  mongoUniqueViolation,
  postgresUniqueViolation,
  sqliteUniqueViolation,
} from "../src/db/unique";

/**
 * The shapes a unique violation arrives in from drivers the contract suite
 * does not run: postgres.js and a real D1 binding name things differently
 * from PGlite and `bun:sqlite`, and a 409 that only works for the test
 * drivers would be a 500 again in production.
 */
describe("unique violations, as each driver reports them", () => {
  test("Postgres: SQLSTATE 23505, the constraint wherever the driver put it", () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "uniq_documents_posts_handle"'), { code: "23505", constraint: "uniq_documents_posts_handle" }); // prettier-ignore
    expect(postgresUniqueViolation(pg)).toEqual({ index: "uniq_documents_posts_handle" }); // prettier-ignore

    // postgres.js
    const porsager = Object.assign(new Error("duplicate key"), { code: "23505", constraint_name: "documents_pkey" }); // prettier-ignore
    expect(postgresUniqueViolation(porsager)).toEqual({ index: "documents_pkey" }); // prettier-ignore

    // Anything else that keeps the code and the message.
    const bare = Object.assign(new Error('duplicate key value violates unique constraint "uniq_x"'), { code: "23505" }); // prettier-ignore
    expect(postgresUniqueViolation(bare)).toEqual({ index: "uniq_x" });

    // Another integrity error is not a duplicate.
    const nullViolation = Object.assign(new Error("null value"), { code: "23502" }); // prettier-ignore
    expect(postgresUniqueViolation(nullViolation)).toBeNull();
    expect(postgresUniqueViolation(new Error("connection refused"))).toBeNull();
  });

  test("SQLite and D1: by the message, with or without D1's wrapping", () => {
    expect(
      sqliteUniqueViolation(new Error("UNIQUE constraint failed: index 'uniq_documents_posts_handle'")), // prettier-ignore
    ).toEqual({ index: "uniq_documents_posts_handle" });
    expect(
      sqliteUniqueViolation(new Error("D1_ERROR: UNIQUE constraint failed: index 'uniq_documents_posts_handle': SQLITE_CONSTRAINT")), // prettier-ignore
    ).toEqual({ index: "uniq_documents_posts_handle" });
    expect(
      sqliteUniqueViolation(new Error("D1_ERROR: UNIQUE constraint failed: documents.id: SQLITE_CONSTRAINT")), // prettier-ignore
    ).toEqual({ columns: ["id"] });
    expect(
      sqliteUniqueViolation(new Error("UNIQUE constraint failed: media_usages.media_id, media_usages.collection")), // prettier-ignore
    ).toEqual({ columns: ["media_id", "collection"] });

    expect(sqliteUniqueViolation(new Error("NOT NULL constraint failed: documents.collection"))).toBeNull(); // prettier-ignore
    expect(sqliteUniqueViolation(new Error("malformed JSON"))).toBeNull();
  });

  test("MongoDB: code 11000, or E11000 in the message", () => {
    const server = Object.assign(new Error("E11000 duplicate key error collection: app.documents index: uniq_documents_posts_handle dup key: { data.handle: \"shared\" }"), { code: 11000 }); // prettier-ignore
    expect(mongoUniqueViolation(server)).toEqual({ index: "uniq_documents_posts_handle" }); // prettier-ignore
    expect(mongoUniqueViolation(new Error("E11000 duplicate key error collection: app.documents index: _id_ dup key: { _id: \"doc_1\" }"))).toEqual({ index: "_id_" }); // prettier-ignore
    expect(mongoUniqueViolation(Object.assign(new Error("write conflict"), { code: 112 }))).toBeNull(); // prettier-ignore
  });
});
