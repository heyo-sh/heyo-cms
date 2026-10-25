---
"@heyo-sh/heyo-cms": minor
"@heyo-sh/heyo-cms-admin": minor
---

**`list()`: rows of the same few fields, as a field.** An FAQ, the sources of
an article, a change log — data with a structure that used to be either a
`json` field nobody wanted to edit or a `textarea` with a format the editor
had to remember and the site had to parse.

```ts
faq: list({
  localized: true,
  fields: {
    question: text({ required: true }),
    answer: textarea({ required: true }),
  },
}),
```

The value is an array of row objects, stored as JSON in the document, typed
from the row's fields (`{ question: string; answer: string }[]`, optional
fields as optional keys) and validated row by row with the fields' own
schemas; an undeclared key is an error. `minItems` and `maxItems` bound the
list. The list carries `localized`, `required`, `access`, `label` and
`description`; a row holds `text`, `textarea`, `email`, `url`, `number`,
`boolean`, `date`, `select` and `multiselect` fields, and anything else — or
`localized`, `unique`, `index`, `access` on a row's field — is refused when
the configuration loads.

The panel edits a list in place: each row is a small form with the row's
fields, with buttons to move and remove it and one to add a row, at full
width in the property pane; the list view shows the number of rows. `GET
/panel` describes the row as `fields` on the list's `PanelField`, the OpenAPI
document describes it as an object with its required keys, and the AI
assistant is told a row's fields (`rowFields`).

A refused write now says where the problem is when a field's value has
structure: `faq #2 question: is required` rather than the first message of
the array's schema. Messages for fields without structure are unchanged.
