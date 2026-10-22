import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { defineCollection, heyoCms } from "../src/config";
import { sqlite } from "../src/db/sqlite";

import { CmsConfigError } from "../src/errors";
import {
  boolean,
  date,
  defineField,
  json,
  media,
  multiselect,
  number,
  registeredFieldTypes,
  relation,
  richText,
  select,
  seoFields,
  text,
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

  // There is no `slug` type: a handle is a `text` field with the constraints
  // spelled out, and nothing in the engine derives one field from another.
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
