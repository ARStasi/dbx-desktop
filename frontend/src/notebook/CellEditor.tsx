import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { sql, SQLDialect } from "@codemirror/lang-sql";
import { highlight, theme } from "../sql/Editor";
import { languageOf, type CellLanguage } from "./command";

export interface CellEditorHandle {
  focus(where?: "start" | "end"): void;
  /** Replaces the text without reporting it as an edit. */
  replace(text: string): void;
}

const dialect = SQLDialect.define({
  backslashEscapes: true,
  identifierQuotes: "`",
  doubleQuotedStrings: true,
  hashComments: false,
});

function languageExtension(lang: CellLanguage): Extension {
  switch (lang) {
    case "python":
      return python();
    case "sql":
      return sql({ dialect, upperCaseKeywords: true });
    default:
      return [];
  }
}

// Cells grow with their content instead of scrolling inside a fixed box.
const cellTheme = EditorView.theme({
  "&": { height: "auto" },
  ".cm-scroller": { overflow: "visible" },
  ".cm-content": { padding: "6px 0" },
  ".cm-gutters": { minWidth: "34px" },
});

/** One cell's code editor. */
export const CellEditor = forwardRef<
  CellEditorHandle,
  {
    initial: string;
    onChange: (text: string) => void;
    /** ⌘/Ctrl+Enter: run this cell. */
    onRun: () => void;
    /** Shift+Enter: run this cell and move to the next one. */
    onRunAdvance: () => void;
    /** Arrow keys past the first or last line move to the neighbouring cell. */
    onLeave: (dir: "up" | "down") => void;
    onFocus: () => void;
    /** Focus the editor as soon as it exists, for a cell just added. */
    autoFocus?: "start" | "end";
  }
>(function CellEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const shownLang = useRef<CellLanguage>(languageOf(props.initial));
  const external = useRef(false);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const atEdge = (v: EditorView, dir: "up" | "down") => {
      const sel = v.state.selection.main;
      if (!sel.empty) return false;
      const line = v.state.doc.lineAt(sel.head);
      if (dir === "up" ? line.number !== 1 : line.number !== v.state.doc.lines) return false;
      cb.current.onLeave(dir);
      return true;
    };
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (cb.current.onRun(), true) },
              { key: "Shift-Enter", run: () => (cb.current.onRunAdvance(), true) },
              { key: "ArrowUp", run: (v) => atEdge(v, "up") },
              { key: "ArrowDown", run: (v) => atEdge(v, "down") },
              { key: "Escape", run: (v) => (v.contentDOM.blur(), true) },
            ]),
          ),
          basicSetup,
          keymap.of([indentWithTab]),
          lang.current.of(languageExtension(shownLang.current)),
          syntaxHighlighting(highlight),
          theme,
          cellTheme,
          EditorView.lineWrapping,
          EditorView.domEventHandlers({ focus: () => cb.current.onFocus() }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            const next = languageOf(text);
            if (next !== shownLang.current) {
              shownLang.current = next;
              // Reconfigure after this update finishes.
              queueMicrotask(() => v.dispatch({ effects: lang.current.reconfigure(languageExtension(next)) }));
            }
            if (!external.current) cb.current.onChange(text);
          }),
        ],
      }),
    });
    view.current = v;
    if (props.autoFocus) {
      v.dispatch({ selection: { anchor: props.autoFocus === "start" ? 0 : v.state.doc.length } });
      v.focus();
    }
    return () => {
      v.destroy();
      view.current = null;
    };
    // The view is created once per cell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    focus(where) {
      const v = view.current;
      if (!v) return;
      if (where) {
        const pos = where === "start" ? 0 : v.state.doc.length;
        v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      }
      v.focus();
    },
    replace(text) {
      const v = view.current;
      if (!v || v.state.doc.toString() === text) return;
      external.current = true;
      try {
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      } finally {
        external.current = false;
      }
    },
  }));

  return <div className="cell-editor" ref={host} />;
});
