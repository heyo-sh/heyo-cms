import { CmsConfigError } from "../../errors";
import { describeStep } from "../../schema/describe";
import type {
  ColumnSnapshot,
  IndexSnapshot,
  MigrationStep,
  SchemaSnapshot,
  TableSnapshot,
} from "../../types/schema";
import type { SqlDialect } from "./dialect";

/**
 * Turns neutral steps into the SQL that lands in the repository.
 *
 * The output is a file a reviewer reads in a pull request, so it carries the
 * step summaries as comments and keeps one statement per line. Nothing here
 * runs against a database: rendering and applying are separate on purpose, or
 * "review the migration" would mean "review what already happened".
 */
export class SqlDdlRenderer {
  constructor(
    private readonly dialect: SqlDialect,
    private readonly target: () => SchemaSnapshot,
  ) {}

  render(steps: MigrationStep[]): string {
    const statements = steps.flatMap((step) => {
      const sql = this.renderStep(step);
      return [`-- ${describeStep(step)}`, ...sql];
    });
    return `${statements.join("\n")}\n`;
  }

  private renderStep(step: MigrationStep): string[] {
    switch (step.kind) {
      case "create_table":
        return [this.createTable(step.table)];
      case "drop_table":
        return [`DROP TABLE IF EXISTS ${this.q(step.table)};`];
      case "add_column":
        return this.addColumn(step.table, step.column);
      case "drop_column":
        return [
          `ALTER TABLE ${this.q(step.table)} DROP COLUMN ${this.q(step.column)};`,
        ];
      case "alter_column":
        return this.alterColumn(step.table, step.column);
      case "create_index":
        return [this.createIndex(step.index)];
      case "drop_index":
        return [`DROP INDEX IF EXISTS ${this.q(step.index)};`];
      case "set_document_field":
        return [
          this.setDocumentField(
            step.table,
            step.collection,
            step.documentColumn,
            step.path,
            step.value,
          ),
        ];
      case "unset_document_field":
        return [
          this.unsetDocumentField(
            step.table,
            step.collection,
            step.documentColumn,
            step.path,
          ),
        ];
    }
  }

  private createTable(table: TableSnapshot): string {
    const columns = table.columns.map((column) => this.columnClause(column));
    if (table.primaryKey.length > 0) {
      columns.push(
        `PRIMARY KEY (${table.primaryKey.map((name) => this.q(name)).join(", ")})`,
      );
    }
    for (const column of table.columns) {
      if (!column.references) continue;
      columns.push(
        `FOREIGN KEY (${this.q(column.name)}) REFERENCES ${this.q(column.references.table)} (${this.q(column.references.column)})${onDelete(column.references.onDelete)}`,
      );
    }
    return `CREATE TABLE IF NOT EXISTS ${this.q(table.name)} (\n  ${columns.join(",\n  ")}\n);`;
  }

  private columnClause(column: ColumnSnapshot): string {
    const parts = [this.q(column.name), this.dialect.columnType(column)];
    if (!column.nullable) parts.push("NOT NULL");
    if (column.default !== undefined) {
      parts.push(`DEFAULT ${this.literal(column)}`);
    }
    return parts.join(" ");
  }

  private addColumn(table: string, column: ColumnSnapshot): string[] {
    if (!column.nullable && column.default === undefined) {
      // Every engine rejects this on a table with rows, and silently making
      // the column nullable would hide a decision the developer has to make.
      throw new CmsConfigError(
        `${table}.${column.name}`,
        "a required column needs a default before it can be added to an existing table",
      );
    }
    return [
      `ALTER TABLE ${this.q(table)} ADD COLUMN ${this.columnClause(column)};`,
    ];
  }

  /**
   * SQLite cannot alter a column, so the table is rebuilt.
   *
   * The twelve-step rebuild from the SQLite documentation, minus the steps
   * that only matter for legacy schemas: create the new shape, copy the
   * columns both shapes share, swap the names, recreate the indexes.
   */
  private alterColumn(table: string, column: ColumnSnapshot): string[] {
    if (this.dialect.supportsAlterColumn) {
      const name = this.q(column.name);
      const statements = [
        `ALTER TABLE ${this.q(table)} ALTER COLUMN ${name} TYPE ${this.dialect.columnType(column)} USING ${name}::${this.dialect.columnType(column)};`,
        `ALTER TABLE ${this.q(table)} ALTER COLUMN ${name} ${column.nullable ? "DROP NOT NULL" : "SET NOT NULL"};`,
      ];
      statements.push(
        column.default === undefined
          ? `ALTER TABLE ${this.q(table)} ALTER COLUMN ${name} DROP DEFAULT;`
          : `ALTER TABLE ${this.q(table)} ALTER COLUMN ${name} SET DEFAULT ${this.literal(column)};`,
      );
      return statements;
    }

    const definition = this.target().tables.find(
      (entry) => entry.name === table,
    );
    if (!definition) {
      throw new CmsConfigError(
        table,
        "cannot rebuild a table that is not in the target schema",
      );
    }

    const temporary = `${table}__rebuild`;
    const shared = definition.columns
      .map((entry) => this.q(entry.name))
      .join(", ");
    return [
      this.createTable({ ...definition, name: temporary }),
      `INSERT INTO ${this.q(temporary)} (${shared}) SELECT ${shared} FROM ${this.q(table)};`,
      `DROP TABLE ${this.q(table)};`,
      `ALTER TABLE ${this.q(temporary)} RENAME TO ${this.q(table)};`,
      ...definition.indexes.map((index) => this.createIndex(index)),
    ];
  }

  private createIndex(index: IndexSnapshot): string {
    const targets = index.targets
      .map((target) =>
        target.kind === "column"
          ? this.q(target.column)
          : `(${this.dialect.jsonExtract(target.column, target.path, target.type)})`,
      )
      .join(", ");
    const unique = index.unique ? "UNIQUE " : "";
    const where = index.where
      ? ` WHERE ${this.q(index.where.column)} = ${quoteString(index.where.equals)}`
      : "";
    return `CREATE ${unique}INDEX IF NOT EXISTS ${this.q(index.name)} ON ${this.q(index.table)} (${targets})${where};`;
  }

  private setDocumentField(
    table: string,
    collection: string,
    documentColumn: string,
    path: string[],
    value: unknown,
  ): string {
    const column = this.q(documentColumn);
    const literal = quoteString(JSON.stringify(value));
    const scope = `WHERE "collection" = ${quoteString(collection)}`;

    if (this.dialect.id === "postgres") {
      const pathLiteral = `'{${path.join(",")}}'`;
      return `UPDATE ${this.q(table)} SET ${column} = jsonb_set(${column}, ${pathLiteral}, ${literal}::jsonb, true) ${scope} AND ${column} #> ${pathLiteral} IS NULL;`;
    }
    const pathLiteral = quoteString(`$.${path.join(".")}`);
    return `UPDATE ${this.q(table)} SET ${column} = json_set(${column}, ${pathLiteral}, json(${literal})) ${scope} AND json_extract(${column}, ${pathLiteral}) IS NULL;`;
  }

  private unsetDocumentField(
    table: string,
    collection: string,
    documentColumn: string,
    path: string[],
  ): string {
    const column = this.q(documentColumn);
    const scope = `WHERE "collection" = ${quoteString(collection)}`;
    if (this.dialect.id === "postgres") {
      return `UPDATE ${this.q(table)} SET ${column} = ${column} #- '{${path.join(",")}}' ${scope};`;
    }
    return `UPDATE ${this.q(table)} SET ${column} = json_remove(${column}, ${quoteString(`$.${path.join(".")}`)}) ${scope};`;
  }

  private literal(column: ColumnSnapshot): string {
    const value = column.default;
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") {
      return this.dialect.id === "postgres" ? String(value) : value ? "1" : "0";
    }
    return quoteString(String(value));
  }

  private q(identifier: string): string {
    return this.dialect.quote(identifier);
  }
}

function onDelete(action: string | undefined): string {
  switch (action) {
    case "cascade":
      return " ON DELETE CASCADE";
    case "set-null":
      return " ON DELETE SET NULL";
    case "restrict":
      return " ON DELETE RESTRICT";
    default:
      return "";
  }
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
