/**
 * The narrow surface every SQL engine has to provide.
 *
 * Four methods, no driver bundled: `pg`, Neon, PGlite, `bun:sqlite`,
 * `node:sqlite` and a D1 binding all fit behind it, and the adapter never
 * learns which one it is talking to.
 */
export interface SqlDriver {
  readonly id: string;
  all(sql: string, values: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, values: unknown[]): Promise<{ rowsAffected: number }>;
  /** Multi-statement DDL. Migrations are the only caller. */
  exec(sql: string): Promise<void>;
  /**
   * Runs a function against a connection pinned for the transaction.
   *
   * Optional: a pooled client would otherwise send `BEGIN` on one connection
   * and the write on another. Engines without interactive transactions (D1)
   * leave it out and declare `transactions: false`.
   */
  transaction?<T>(run: (driver: SqlDriver) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/**
 * Splits a migration file into statements.
 *
 * Quote-aware rather than a plain `split(";")`: a default value or a backfill
 * literal can contain a semicolon, and cutting a statement in half there
 * would corrupt a migration in the one place nobody tests twice.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] as string;

    if (character === "'") {
      // `''` is an escaped quote inside a string, not the end of one.
      if (quoted && sql[index + 1] === "'") {
        current += "''";
        index += 1;
        continue;
      }
      quoted = !quoted;
      current += character;
      continue;
    }

    if (character === "-" && !quoted && sql[index + 1] === "-") {
      const lineEnd = sql.indexOf("\n", index);
      index = lineEnd === -1 ? sql.length : lineEnd;
      continue;
    }

    if (character === ";" && !quoted) {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
