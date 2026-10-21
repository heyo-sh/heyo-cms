/**
 * The rich-text schema: nodes, marks and the serialisers they are required to
 * carry.
 *
 * Importing this module registers the built-in nodes, which is why the
 * serialisers in `renderRichText()` work without any configuration. A plugin
 * that adds a node imports `defineEditorNode` from here and gets exactly the
 * same treatment.
 */
export {
  blockquoteNode,
  boldMark,
  bulletListNode,
  codeBlockNode,
  codeMark,
  docNode,
  hardBreakNode,
  headingNode,
  horizontalRuleNode,
  imageNode,
  italicMark,
  linkMark,
  listItemNode,
  orderedListNode,
  paragraphNode,
  strikeMark,
  tableCellNode,
  tableHeaderNode,
  tableNode,
  tableRowNode,
  taskItemNode,
  taskListNode,
  underlineMark,
} from "./builtin";
export { richTextFromMarkdown, richTextFromText } from "./markdown";
export {
  defineEditorMark,
  defineEditorNode,
  describeEditorSchema,
  getEditorMark,
  getEditorNode,
  registeredEditorMarks,
  registeredEditorNodes,
} from "./registry";
export {
  escapeHtml,
  escapeMarkdown,
  htmlAttributes,
  indentContinuation,
  renderRichText,
  richTextToHtml,
  richTextToMarkdown,
  richTextToPlainText,
  stringAttr,
} from "./serialize";
