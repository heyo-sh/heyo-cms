import type { MigrationStep } from "../types/schema";

/**
 * One line per step, in plain words.
 *
 * Printed by `heyo-cms generate`, written into the header of a `.sql` file and
 * used to name the migration. A developer should be able to tell what a
 * migration does without reading its SQL — that is the whole promise of
 * migrations as first-class citizens (section 0).
 */
export function describeStep(step: MigrationStep): string {
  switch (step.kind) {
    case "create_table":
      return `create table ${step.table.name}`;
    case "drop_table":
      return `drop table ${step.table}`;
    case "add_column":
      return `add ${step.table}.${step.column.name} (${columnType(step.column.type, step.column.array)})`;
    case "drop_column":
      return `drop ${step.table}.${step.column}`;
    case "alter_column":
      return `alter ${step.table}.${step.column.name} (${step.changes.join(", ")})`;
    case "create_index":
      return `create ${step.index.unique ? "unique " : ""}index ${step.index.name}`;
    case "drop_index":
      return `drop index ${step.index}`;
    case "set_document_field":
      return `backfill ${step.collection}.${step.path.join(".")} = ${JSON.stringify(step.value)}`;
    case "unset_document_field":
      return `remove ${step.collection}.${step.path.join(".")} from stored documents`;
  }
}

function columnType(type: string, array: boolean | undefined): string {
  return array === true ? `${type}[]` : type;
}

/**
 * Names a migration after what it does.
 *
 * Timestamps and random words both produce file names that say nothing in a
 * pull request. A name derived from the steps reads as a changelog in `ls`,
 * and ties are broken by the sequence number the file already carries.
 */
export function migrationName(steps: MigrationStep[]): string {
  if (steps.length === 0) return "empty";

  const first = steps[0] as MigrationStep;
  const summary = (() => {
    switch (first.kind) {
      case "create_table":
        return steps.filter((step) => step.kind === "create_table").length > 1
          ? "create_schema"
          : `create_${first.table.name}`;
      case "drop_table":
        return `drop_${first.table}`;
      case "add_column":
        return `add_${first.table}_${first.column.name}`;
      case "drop_column":
        return `drop_${first.table}_${first.column}`;
      case "alter_column":
        return `alter_${first.table}_${first.column.name}`;
      case "create_index":
        return `index_${first.index.name.replace(/^(idx|uniq)_/, "")}`;
      case "drop_index":
        return `drop_index_${first.index.replace(/^(idx|uniq)_/, "")}`;
      case "set_document_field":
        return `backfill_${first.collection}_${first.path.join("_")}`;
      case "unset_document_field":
        return `remove_${first.collection}_${first.path.join("_")}`;
    }
  })();

  return slugifyIdentifier(
    steps.length > 1 ? `${summary}_and_${steps.length - 1}_more` : summary,
  );
}

function slugifyIdentifier(value: string): string {
  // Underscores are trimmed with a scan rather than /^_+|_+$/, whose end
  // anchor backtracks quadratically on underscore-heavy input.
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === "_") start++;
  while (end > start && slug[end - 1] === "_") end--;
  return slug.slice(start, end).slice(0, 60);
}
