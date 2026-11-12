import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { basicSetup } from "codemirror";
import { Annotation, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { sql, SQLDialect } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";
import { statementAt } from "../sqlsplit";
import { formatSql, mapOffset } from "./format";

export interface EditorHandle {
  /** Inserts text at the cursor, replacing any selection. */
  insert(text: string): void;
  /** The selected text, or the statement under the cursor when nothing is selected. */
  runTarget(): string;
  focus(): void;
  /** Formats the selection, or the whole document when nothing is selected. Throws if the SQL cannot be parsed. */
  format(): void;
  /** Moves a document's undo history to a new key after its file is renamed. */
  rename(oldKey: string, newKey: string): void;
  /** Drops a closed document's saved state. */
  forget(key: string): void;
  /**
   * Replaces a document's text without reporting it as an edit, for example
   * after loading a newer version. The shown document keeps its undo history.
   */
  replace(key: string, text: string): void;
}

// Marks changes that come from outside the editor, which are not edits.
const external = Annotation.define<boolean>();

const dialect = SQLDialect.define({
  backslashEscapes: true,
  identifierQuotes: "`",
  doubleQuotedStrings: true,
  hashComments: false,
});

// Colors come from CSS variables so the editor follows light and dark mode.
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--surface)", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--text)", padding: "8px 0" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--text-2)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--focus) 7%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--focus) 28%, transparent)",
  },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--focus) 25%, transparent)", outline: "none" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword], color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--syn-type)" },
]);

export const Editor = forwardRef<
  EditorHandle,
  {
    /** Identifies the open document. Each key keeps its own undo history. */
    docKey: string;
    /** The document's text, used only the first time a key is shown. */
    initial: string;
    onChange: (docKey: string, text: string) => void;
    onRun: () => void;
    onFormat: () => void;
  }
>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const shown = useRef<string | null>(null);
  // The latest callbacks, so the editor never calls stale ones.
  const cb = useRef(props);
  cb.current = props;

  const newState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                cb.current.onRun();
                return true;
              },
            },
          ]),
        ),
        // Shift+Alt+F formats. Matched on the physical key because on macOS Alt
        // turns F into a typed character, which CodeMirror's keymap won't bind.
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(e) {
              if (e.code !== "KeyF" || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return false;
              e.preventDefault();
              cb.current.onFormat();
              return true;
            },
          }),
        ),
        basicSetup,
        sql({ dialect, upperCaseKeywords: true }),
        syntaxHighlighting(highlight),
        theme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && shown.current !== null && !u.transactions.some((tr) => tr.annotation(external))) {
            cb.current.onChange(shown.current, u.state.doc.toString());
          }
        }),
      ],
    });

  useEffect(() => {
    const v = new EditorView({ parent: host.current!, state: newState(props.initial) });
    view.current = v;
    shown.current = props.docKey;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The view is created once; document switches are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || shown.current === props.docKey) return;
    if (shown.current !== null) states.current.set(shown.current, v.state);
    shown.current = props.docKey;
    v.setState(states.current.get(props.docKey) ?? newState(props.initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey]);

  useImperativeHandle(ref, () => ({
    insert(text) {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    runTarget() {
      const v = view.current;
      if (!v) return "";
      const sel = v.state.selection.main;
      if (!sel.empty) return v.state.sliceDoc(sel.from, sel.to).trim();
      return statementAt(v.state.doc.toString(), sel.head);
    },
    focus() {
      view.current?.focus();
    },
    format() {
      const v = view.current;
      if (!v) return;
      const sel = v.state.selection.main;
      const from = sel.empty ? 0 : sel.from;
      const to = sel.empty ? v.state.doc.length : sel.to;
      const before = v.state.sliceDoc(from, to);
      const after = formatSql(before);
      if (after !== before) {
        v.dispatch({
          changes: { from, to, insert: after },
          // Keep a formatted selection selected; otherwise keep the cursor on the same code.
          selection: sel.empty
            ? { anchor: mapOffset(before, after, sel.head) }
            : { anchor: from, head: from + after.length },
          scrollIntoView: true,
          userEvent: "input.format",
        });
      }
      v.focus();
    },
    rename(oldKey, newKey) {
      const st = states.current.get(oldKey);
      if (st) {
        states.current.delete(oldKey);
        states.current.set(newKey, st);
      }
      if (shown.current === oldKey) shown.current = newKey;
    },
    forget(key) {
      states.current.delete(key);
    },
    replace(key, text) {
      const v = view.current;
      if (v && shown.current === key) {
        if (v.state.doc.toString() !== text) {
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, annotations: external.of(true) });
        }
      } else {
        states.current.delete(key);
      }
    },
  }));

  return <div className="editor-host" ref={host} />;
});
