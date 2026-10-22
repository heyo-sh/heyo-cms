import { describe, expect, test } from "bun:test";
import type {
  PanelCollection,
  PanelField,
  PanelLocale,
} from "@heyo-sh/heyo-cms/types";

import {
  buildCollectionFilterFieldGroups,
  createCollectionFilterFieldMap,
  isCollectionFilterValueReady,
  serializeAppliedCollectionFilters,
  type AppliedCollectionFilter,
} from "../src/app/lib/collection-filters";

function field(
  name: string,
  type: string,
  options: Record<string, unknown> = {},
): PanelField {
  return {
    name,
    type,
    label: name[0]?.toUpperCase() + name.slice(1),
    required: false,
    localized: false,
    readOnly: false,
    unique: false,
    generate: false,
    options: options as PanelField["options"],
    admin: { hidden: false },
    ai: [],
    access: { read: true, update: true },
  };
}

const collection: PanelCollection = {
  name: "posts",
  slug: "posts",
  label: "Posts",
  kind: "collection",
  useAsTitle: "title",
  defaultColumns: ["title", "state"],
  can: { read: true, create: true, update: true, delete: true },
  fields: [
    field("title", "text"),
    field("summary", "textarea"),
    field("email", "email"),
    field("website", "url"),
    field("score", "number", { integer: true }),
    field("active", "boolean"),
    field("publishDate", "date", { mode: "date" }),
    field("publishedAt", "date", { mode: "datetime" }),
    field("state", "select", {
      options: ["draft", { value: "live", label: "Live" }],
    }),
    field("tags", "multiselect", { options: ["news", "featured"] }),
    field("hero", "media"),
    field("author", "relation", { relationTo: "authors" }),
    field("body", "richText"),
    field("metadata", "json"),
  ],
};

const map = createCollectionFilterFieldMap(
  buildCollectionFilterFieldGroups(collection),
);

const locales: PanelLocale[] = [
  { code: "en", name: "English", rtl: false, isDefault: true },
  { code: "de", name: "German", rtl: false, isDefault: false },
];

const localizedCollection: PanelCollection = {
  ...collection,
  fields: collection.fields.map((entry) =>
    entry.name === "title" ? { ...entry, localized: true } : entry,
  ),
};

function applied(
  fieldId: string,
  operator: AppliedCollectionFilter["operator"],
  value: AppliedCollectionFilter["value"],
): AppliedCollectionFilter {
  return { id: fieldId, fieldId, operator, value };
}

describe("collection filters", () => {
  test("offers filter controls only for supported collection fields", () => {
    const groups = buildCollectionFilterFieldGroups(collection);
    expect(groups.map((group) => group.label)).toEqual(["Document", "Posts"]);
    expect(groups[0]?.fields.map((item) => item.path)).toEqual([
      "id",
      "createdAt",
      "updatedAt",
      "scheduledAt",
    ]);

    expect(map.get("field:title")).toMatchObject({
      inputKind: "text",
      operators: ["is", "is-not", "contains", "does-not-contain"],
    });
    expect(map.get("field:score")).toMatchObject({
      inputKind: "number",
      integer: true,
      operators: [
        "is",
        "is-not",
        "greater-than",
        "greater-than-or-equal",
        "less-than",
        "less-than-or-equal",
      ],
    });
    expect(map.get("field:active")).toMatchObject({
      inputKind: "boolean",
      options: [
        { label: "True", value: true },
        { label: "False", value: false },
      ],
    });
    expect(map.get("field:publishDate")).toMatchObject({
      inputKind: "date",
      operators: [
        "is",
        "is-not",
        "after",
        "on-or-after",
        "before",
        "on-or-before",
      ],
    });
    expect(map.get("field:publishedAt")).toMatchObject({
      inputKind: "datetime",
    });
    expect(map.get("field:state")).toMatchObject({
      inputKind: "select",
      options: [
        { label: "draft", value: "draft" },
        { label: "Live", value: "live" },
      ],
    });
    expect(map.get("field:tags")).toMatchObject({
      inputKind: "multiselect",
      operators: ["contains", "does-not-contain"],
    });
    expect(map.has("field:hero")).toBe(false);
    expect(map.get("field:author")?.inputKind).toBe("text");
    expect(map.has("field:body")).toBe(false);
    expect(map.has("field:metadata")).toBe(false);
  });

  test("filters documents by whether they contain a translation", () => {
    const groups = buildCollectionFilterFieldGroups(
      localizedCollection,
      locales,
    );
    const localizedMap = createCollectionFilterFieldMap(groups);

    expect(groups.map((group) => group.label)).toEqual([
      "Document",
      "i18n",
      "Posts",
    ]);
    expect(localizedMap.get("system:locale")).toMatchObject({
      label: "Language",
      inputKind: "select",
      operators: ["is", "is-not"],
      options: [
        { label: "English", value: "en" },
        { label: "German", value: "de" },
      ],
    });

    const matches = serializeAppliedCollectionFilters(
      [applied("system:locale", "is", "de")],
      localizedMap,
    );
    expect(JSON.parse(matches!)).toEqual({
      kind: "compare",
      path: "title.de",
      operator: "exists",
      value: true,
    });

    const missing = serializeAppliedCollectionFilters(
      [applied("system:locale", "is-not", ["en", "de"])],
      localizedMap,
    );
    expect(JSON.parse(missing!)).toEqual({
      kind: "not",
      condition: {
        kind: "or",
        conditions: [
          {
            kind: "compare",
            path: "title.en",
            operator: "exists",
            value: true,
          },
          {
            kind: "compare",
            path: "title.de",
            operator: "exists",
            value: true,
          },
        ],
      },
    });
  });

  test("accepts zero and false but never applies an incomplete value", () => {
    const score = map.get("field:score")!;
    const active = map.get("field:active")!;
    const title = map.get("field:title")!;
    const state = map.get("field:state")!;

    expect(isCollectionFilterValueReady(score, 0)).toBe(true);
    expect(isCollectionFilterValueReady(active, false)).toBe(true);
    expect(isCollectionFilterValueReady(title, "  ")).toBe(false);
    expect(isCollectionFilterValueReady(state, [])).toBe(false);
    expect(isCollectionFilterValueReady(state, ["draft", ""])).toBe(false);
  });

  test("serializes every operator family into an ANDed, server-validated where tree", () => {
    const raw = serializeAppliedCollectionFilters(
      [
        applied("field:title", "does-not-contain", "spam"),
        applied("field:score", "greater-than-or-equal", 10),
        applied("field:active", "is-not", false),
        applied("field:publishDate", "on-or-after", "2025-01-02"),
        applied("field:state", "is", ["draft", "live"]),
        applied("field:tags", "does-not-contain", ["news", "featured"]),
      ],
      map,
    );

    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      kind: "and",
      conditions: [
        {
          kind: "or",
          conditions: [
            {
              kind: "compare",
              path: "title",
              operator: "exists",
              value: false,
            },
            {
              kind: "not",
              condition: {
                kind: "compare",
                path: "title",
                operator: "ilike",
                value: "%spam%",
              },
            },
          ],
        },
        {
          kind: "compare",
          path: "score",
          operator: "gte",
          value: 10,
        },
        {
          kind: "or",
          conditions: [
            {
              kind: "compare",
              path: "active",
              operator: "exists",
              value: false,
            },
            {
              kind: "not",
              condition: {
                kind: "compare",
                path: "active",
                operator: "eq",
                value: false,
              },
            },
          ],
        },
        {
          kind: "compare",
          path: "publishDate",
          operator: "gte",
          value: "2025-01-02T00:00:00.000Z",
        },
        {
          kind: "or",
          conditions: [
            {
              kind: "compare",
              path: "state",
              operator: "ilike",
              value: "draft",
            },
            {
              kind: "compare",
              path: "state",
              operator: "ilike",
              value: "live",
            },
          ],
        },
        {
          kind: "not",
          condition: {
            kind: "or",
            conditions: [
              {
                kind: "compare",
                path: "tags",
                operator: "contains",
                value: "news",
              },
              {
                kind: "compare",
                path: "tags",
                operator: "contains",
                value: "featured",
              },
            ],
          },
        },
      ],
    });
  });

  test("maps every named operator to its API comparator and negative semantics", () => {
    const cases = [
      ["field:title", "is", "exact", "direct", "ilike"],
      ["field:title", "is-not", "exact", "missing-or-not", "ilike"],
      ["field:title", "contains", "part", "direct", "ilike"],
      ["field:title", "does-not-contain", "part", "missing-or-not", "ilike"],
      ["field:score", "is", 4, "direct", "eq"],
      ["field:score", "is-not", 4, "missing-or-not", "eq"],
      ["field:score", "greater-than", 4, "direct", "gt"],
      ["field:score", "greater-than-or-equal", 4, "direct", "gte"],
      ["field:score", "less-than", 4, "direct", "lt"],
      ["field:score", "less-than-or-equal", 4, "direct", "lte"],
      ["field:publishDate", "is", "2025-01-01", "direct", "eq"],
      ["field:publishDate", "is-not", "2025-01-01", "missing-or-not", "eq"],
      ["field:publishDate", "after", "2025-01-01", "direct", "gt"],
      ["field:publishDate", "on-or-after", "2025-01-01", "direct", "gte"],
      ["field:publishDate", "before", "2025-01-01", "direct", "lt"],
      ["field:publishDate", "on-or-before", "2025-01-01", "direct", "lte"],
      ["field:active", "is", false, "direct", "eq"],
      ["field:active", "is-not", false, "missing-or-not", "eq"],
      ["field:state", "is", "draft", "direct", "ilike"],
      ["field:state", "is-not", "draft", "missing-or-not", "ilike"],
      ["field:tags", "contains", "news", "direct", "contains"],
      ["field:tags", "does-not-contain", "news", "not", "contains"],
    ] as const;

    for (const [fieldId, operator, value, shape, comparator] of cases) {
      const raw = serializeAppliedCollectionFilters(
        [applied(fieldId, operator, value)],
        map,
      );
      const condition = JSON.parse(raw!);

      if (shape === "direct") {
        expect(condition).toMatchObject({
          kind: "compare",
          operator: comparator,
        });
      } else if (shape === "not") {
        expect(condition).toMatchObject({
          kind: "not",
          condition: { kind: "compare", operator: comparator },
        });
      } else {
        expect(condition).toMatchObject({
          kind: "or",
          conditions: [
            { kind: "compare", operator: "exists", value: false },
            {
              kind: "not",
              condition: { kind: "compare", operator: comparator },
            },
          ],
        });
      }
    }
  });

  test("drops media and stale fields instead of emitting an unavailable query", () => {
    for (const fieldId of ["field:hero", "field:removed"]) {
      expect(
        serializeAppliedCollectionFilters(
          [applied(fieldId, "is", "value")],
          map,
        ),
      ).toBeUndefined();
    }
  });
});
