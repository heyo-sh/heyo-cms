/**
 * The schema layer: system tables, the snapshot a configuration implies, and
 * the deterministic diff between two snapshots. No SQL lives here — steps are
 * neutral and every engine renders them itself (section 12).
 */
export * from "./schema/index";
