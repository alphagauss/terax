/**
 * 本文件将主题文件内嵌的编辑器调色板转换为 CodeMirror 扩展。
 * 只负责表面和语法样式，不解析应用主题选择或用户覆盖偏好。
 */

import type { EditorPalette, ThemeMode } from "@/modules/theme/types";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";

/** 使用指定明暗模式构建 CodeMirror 主题扩展。 */
export function createEditorThemeExtension(
  palette: EditorPalette,
  mode: ThemeMode,
): Extension {
  return createTheme({
    theme: mode,
    settings: {
      background: palette.background,
      foreground: palette.foreground,
      caret: palette.caret,
      selection: palette.selection,
      selectionMatch: palette.selection,
      lineHighlight: palette.lineHighlight,
      gutterBackground: palette.background,
      gutterForeground: palette.gutterForeground,
    },
    styles: [
      {
        tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
        color: palette.comment,
        ...(palette.commentItalic === false ? {} : { fontStyle: "italic" }),
      },
      {
        tag: [
          t.keyword,
          t.modifier,
          t.controlKeyword,
          t.operatorKeyword,
          t.moduleKeyword,
          t.self,
        ],
        color: palette.keyword,
        ...(palette.boldKeyword ? { fontWeight: "bold" } : {}),
      },
      {
        tag: [t.string, t.special(t.string), t.regexp, t.character],
        color: palette.string,
      },
      { tag: [t.number], color: palette.number },
      {
        tag: [t.bool, t.null, t.atom, t.constant(t.name)],
        color: palette.constant ?? palette.number,
      },
      {
        tag: [
          t.function(t.variableName),
          t.function(t.propertyName),
          t.labelName,
          t.macroName,
        ],
        color: palette.function,
      },
      {
        tag: [
          t.definition(t.variableName),
          t.variableName,
          t.local(t.variableName),
        ],
        color: palette.variable,
      },
      {
        tag: [t.propertyName, t.special(t.propertyName)],
        color: palette.property,
      },
      {
        tag: [t.typeName, t.className, t.namespace, t.changed, t.annotation],
        color: palette.type,
      },
      {
        tag: [
          t.operator,
          t.arithmeticOperator,
          t.logicOperator,
          t.bitwiseOperator,
          t.compareOperator,
          t.definitionOperator,
          t.derefOperator,
        ],
        color: palette.operator,
      },
      { tag: [t.tagName], color: palette.tag },
      { tag: [t.angleBracket], color: palette.tagBracket ?? palette.tag },
      { tag: [t.attributeName], color: palette.attribute },
      {
        tag: [t.attributeValue],
        color: palette.attributeValue ?? palette.attribute,
      },
      { tag: [t.heading], color: palette.heading, fontWeight: "bold" },
      {
        tag: [t.link, t.url],
        color: palette.link,
        textDecoration: "underline",
      },
      { tag: [t.emphasis], fontStyle: "italic" },
      { tag: [t.strong], fontWeight: "bold" },
      { tag: [t.invalid], color: palette.invalid },
      { tag: [t.meta, t.processingInstruction], color: palette.comment },
    ],
  });
}
