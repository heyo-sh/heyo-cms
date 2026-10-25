import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { defineCollection, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";

import { CmsConfigError } from "../src/errors";
import type { FieldDefinition } from "../src/types/fields";
import {
  boolean,
  date,
  defineField,
  json,
  list,
  media,
  multiselect,
  number,
  registeredFieldTypes,
  relation,
  richText,
  select,
  seoFields,
  slug,
  text,
  textarea,
  url,
} from "../src/fields";

describe("field builders", () => {
  test("an optional field holds null, a required one does not", () => {
    expect(text({}).schema.safeParse(null).success).toBe(true);
    expect(text({ required: true }).schema.safeParse(null).success).toBe(false);
    expect(text({ required: true }).required).toBe(true);
  });

  test("validation is zod in the definition, not a hook", () => {
    const field = text({ required: true, minLength: 3, maxLength: 5 });
    expect(field.schema.safeParse("abcd").success).toBe(true);
    expect(field.schema.safeParse("ab").success).toBe(false);
    expect(field.schema.safeParse("abcdef").success).toBe(false);
  });

  test("a list validates every row with its fields' own schemas", () => {
    const sources = list({
      fields: {
        title: text({ required: true }),
        url: url(),
        year: number({ integer: true }),
      },
      maxItems: 3,
    });
    expect(sources.type).toBe("list");
    expect(sources.column).toMatchObject({ type: "json", array: true });

    const ok = (value: unknown) => sources.schema.safeParse(value).success;
    expect(ok([{ title: "A", url: "https://a.example", year: 2024 }])).toBe(
      true,
    );
    // An optional field may be null or left out; the list may be empty or null.
    expect(ok([{ title: "A", url: null }, { title: "B" }])).toBe(true);
    expect(ok([])).toBe(true);
    expect(ok(null)).toBe(true);
    // A row is checked by its fields, and a misspelt key is not dropped.
    expect(ok([{ url: "https://a.example" }])).toBe(false);
    expect(ok([{ title: "A", url: "not a url" }])).toBe(false);
    expect(ok([{ title: "A", year: 1.5 }])).toBe(false);
    expect(ok([{ title: "A", tilte: "typo" }])).toBe(false);
    expect(ok([{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }])).toBe(false); // prettier-ignore
    expect(ok({ title: "A" })).toBe(false);

    // The static type is the row, required keys and optional ones (checked by `tsc`).
    type Value<F> = F extends FieldDefinition<infer T> ? T : never;
    const rows: Value<typeof sources> = [{ title: "A" }, { title: "B", url: null, year: 2024 }]; // prettier-ignore
    // @ts-expect-error `title` is required in every row
    const missing: Value<typeof sources> = [{ url: "https://a.example" }];
    expect([rows, missing]).toHaveLength(2);
  });

  test("a list is localized as a whole, and refuses what cannot live in a row", () => {
    const faq = list({
      localized: true,
      required: true,
      fields: { question: text({ required: true }), answer: textarea() },
    });
    expect(faq.localized).toBe(true);
    expect(faq.schema.safeParse(null).success).toBe(false);

    const refused = (build: () => unknown) => {
      try {
        build();
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(CmsConfigError);
        return (error as Error).message;
      }
    };
    expect(refused(() => list({ fields: {} }))).toContain("at least one field"); // prettier-ignore
    expect(refused(() => list({ fields: { who: relation("authors") } }))).toContain("cannot hold a relation field"); // prettier-ignore
    expect(refused(() => list({ fields: { body: richText() } }))).toContain("cannot hold a richText field"); // prettier-ignore
    expect(refused(() => list({ fields: { q: text({ localized: true }) } }))).toContain("set localized on the list"); // prettier-ignore
    expect(refused(() => list({ fields: { q: text({ unique: true }) } }))).toContain("not supported inside a list row"); // prettier-ignore
    expect(refused(() => list({ fields: { "two words": text() } }))).toContain("identifier"); // prettier-ignore
    expect(refused(() => list({ fields: { q: text() }, index: true }))).toContain("cannot be unique or indexed"); // prettier-ignore
    expect(refused(() => list({ fields: { q: text() }, minItems: 3, maxItems: 1 }))).toContain("maxItems"); // prettier-ignore
  });

  test("select accepts only its options", () => {
    const status = select({
      options: ["draft", "review", "published"],
      default: "draft",
      required: true,
    });
    expect(status.schema.safeParse("review").success).toBe(true);
    expect(status.schema.safeParse("archived").success).toBe(false);
    expect(status.defaultValue).toBe("draft");
    // The engine attaches no meaning to it: it is a text column with a default.
    expect(status.column.type).toBe("text");
  });

  test("multiselect stores a JSON array", () => {
    const tags = multiselect({ options: ["a", "b"], required: true });
    expect(tags.column).toMatchObject({ type: "json", array: true });
    expect(tags.schema.safeParse(["a", "b"]).success).toBe(true);
    expect(tags.schema.safeParse(["c"]).success).toBe(false);
  });

  test("a many relation validates the list of ids it stores", () => {
    const one = relation("authors");
    expect(one.column.type).toBe("text");
    expect(one.schema.safeParse("aut_1").success).toBe(true);
    expect(one.schema.safeParse(["aut_1"]).success).toBe(false);

    const many = relation("authors", { many: true });
    expect(many.column).toMatchObject({ type: "json", array: true });
    expect(many.schema.safeParse(["aut_1", "aut_2"]).success).toBe(true);
    expect(many.schema.safeParse([]).success).toBe(true);
    expect(many.schema.safeParse(null).success).toBe(true);
    // A single id is not a list, and a list holds ids.
    expect(many.schema.safeParse("aut_1").success).toBe(false);
    expect(many.schema.safeParse([""]).success).toBe(false);
    expect(many.schema.safeParse([1]).success).toBe(false);

    const required = relation("authors", { many: true, required: true });
    expect(required.schema.safeParse(null).success).toBe(false);
    expect(required.schema.safeParse(["aut_1"]).success).toBe(true);

    // The static type says the same as the schema (checked by `tsc`).
    type Value<F> = F extends FieldDefinition<infer T> ? T : never;
    const ids: Value<typeof many> = ["aut_1", "aut_2"];
    // @ts-expect-error a many relation holds a list, not one id
    const single: Value<typeof many> = "aut_1";
    const id: Value<typeof one> = "aut_1";
    expect([ids, single, id]).toHaveLength(3);
  });

  test("slug is unique and indexed, per language when localized", () => {
    const handle = slug({ from: "title" });
    expect(handle.type).toBe("slug");
    expect(handle.column).toMatchObject({ type: "text", unique: true, index: true }); // prettier-ignore
    expect(handle.schema.safeParse("hello-world").success).toBe(true);
    expect(handle.schema.safeParse("Hello World").success).toBe(false);
    expect(handle.schema.safeParse("double--dash").success).toBe(false);
    expect(handle.generate).toBeDefined();
    // No index can cover languages that do not exist yet; the engine checks
    // uniqueness per language instead, so this is not the v1 refusal below.
    const localized = slug({ localized: true, history: true });
    expect(localized.column.unique).toBeUndefined();
    expect(localized.options.history).toBe(true);
    expect(slug({ unique: false }).column.unique).toBe(false);
    expect(slug({ maxLength: 10 }).schema.safeParse("a-b-c-d-e-f").success).toBe(false); // prettier-ignore
  });

  // A plain handle without the engine's help is still a `text` field with
  // the constraints spelled out.
  test("a handle is text with unique, index and a pattern", () => {
    const handle = text({
      required: true,
      unique: true,
      index: true,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    });
    expect(handle.column).toMatchObject({ unique: true, index: true });
    expect(handle.schema.safeParse("hello-world").success).toBe(true);
    expect(handle.schema.safeParse("Hello World").success).toBe(false);
  });

  test("relation records what it points at", () => {
    const author = relation("cms_users");
    expect(author.relationTo).toBe("cms_users");
    expect(author.column.type).toBe("text");
  });

  test("the remaining built-ins map onto portable column types", () => {
    expect(number({ integer: true }).column.type).toBe("integer");
    expect(number({}).column.type).toBe("real");
    expect(boolean({ default: false }).column).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(date({}).column.type).toBe("timestamp");
    expect(json({}).column.type).toBe("json");
    expect(richText({}).column.type).toBe("json");
    expect(media({}).column.type).toBe("text");
  });

  test("a localized field cannot be unique in v1", () => {
    // Uniqueness would have to be enforced per locale, and locales are rows.
    expect(() => text({ localized: true, unique: true })).toThrow(
      CmsConfigError,
    );
  });

  test("a hidden field cannot be required, even when it has a default", () => {
    expect(() => text({ required: true, admin: { hidden: true } })).toThrow(
      /fields.text.admin.hidden.*hidden field cannot be required/,
    );
    expect(() =>
      boolean({ required: true, default: false, admin: { hidden: true } }),
    ).toThrow(/hidden field cannot be required/);
    expect(text({ admin: { hidden: true } }).required).toBe(false);
    expect(text({ required: true, admin: { hidden: false } }).required).toBe(
      true,
    );

    // Startup validation also covers definitions contributed without builders.
    const supplied = { ...text({ required: true }), admin: { hidden: true } };
    expect(() =>
      heyoCms({
        database: () => sqlite(new Database(":memory:")),
        collections: {
          posts: defineCollection({ fields: { secret: supplied } }),
        },
      }),
    ).toThrow(
      /collections.posts.fields.secret.admin.hidden.*hidden field cannot be required/,
    );
  });

  test("an unknown AI action on a field is a typo, not a feature", () => {
    expect(() => text({ ai: { translte: true } })).toThrow(/unknown AI action/);
    // A custom action brings its own prompt, so it is accepted.
    expect(() =>
      text({ ai: { "tone-of-voice": { prompt: "Make it warmer." } } }),
    ).not.toThrow();
  });

  test("invalid options fail at build time with the field in the message", () => {
    expect(() => select({ options: [] })).toThrow(/fields.select/);
    for (const key of ["width", "position", "condition"]) {
      expect(() => text({ admin: { [key]: true } })).toThrow(
        `fields.text.admin.${key}`,
      );
    }
  });

  test("seoFields is a preset, not a plugin", () => {
    const fields = seoFields();
    expect(Object.keys(fields)).toEqual([
      "seoTitle",
      "seoDescription",
      "ogImage",
      "canonical",
    ]);
    expect(fields.seoTitle.aiGenerate).toMatchObject({
      label: "Suggest an SEO title",
    });
    // A preset cannot assume every collection has title and body fields.
    expect(fields.seoTitle.aiGenerate?.context).toBeUndefined();
  });
});

describe("defineField", () => {
  test("a third-party field uses the same API as the built-ins", () => {
    const rating = defineField<number, { max?: number; required?: boolean }>({
      name: "rating",
      schema: (options) => ({ ...numberSchema(options.max ?? 5) }) as never,
      column: () => ({ type: "integer" }),
    });

    const field = rating({ max: 10, required: true });
    expect(field.type).toBe("rating");
    expect(field.column.type).toBe("integer");
    expect(registeredFieldTypes()).toContain("rating");
  });

  test("two different types cannot claim one name", () => {
    const declare = () =>
      defineField<string, Record<string, never>>({
        name: "text",
        schema: () => ({}) as never,
        column: () => ({ type: "text" }),
      });
    expect(declare).toThrow(/already registered/);
  });
});

function numberSchema(max: number) {
  // A stand-in for a zod schema: the registry only ever calls safeParse.
  return {
    safeParse: (value: unknown) => ({
      success: typeof value === "number" && value <= max,
    }),
    nullable() {
      return this;
    },
  };
}
