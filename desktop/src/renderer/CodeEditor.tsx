import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { createEditorDocument } from './editor-document';
import { editorLanguage } from './editor-language';
import './code-editor.css';

export type CodeEditorHandle = {
  getText(): string;
  flushText(): Promise<string>;
  focus(): void;
  find(): void;
  replace(): void;
  gotoLine(): void;
  undo(): void;
  redo(): void;
  formatJson(): boolean;
};

export type CodeEditorProps = {
  initialText: string;
  path: string;
  theme: 'dark' | 'light';
  readOnly: boolean;
  wrap: boolean;
  language?: string;
  indent?: '2' | '4' | 'tab';
  onChange(text: string): void;
  onCursorChange(line: number, column: number): void;
  onSave(): void;
  onInputPending?(pending: boolean): void;
};

const phrases = {
  Find: '查找', Replace: '替换', next: '下一处', previous: '上一处', all: '全选匹配',
  'match case': '区分大小写', regexp: '正则表达式', 'by word': '全字匹配',
  replace: '替换', 'replace all': '全部替换', close: '关闭', 'Go to line': '跳转到行', go: '跳转',
  'current match': '当前匹配', 'on line': '所在行', 'replaced match on line $': '已替换第 $ 行的匹配',
  'replaced $ matches': '已替换 $ 处匹配', 'Fold line': '折叠此行', 'Unfold line': '展开此行',
  'Unfold': '展开', 'folded code': '已折叠的代码',
};

function editorAppearance(theme: 'dark' | 'light'): Extension {
  const dark = theme === 'dark';
  return [EditorView.theme({
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--surface-sunken)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '13px', lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { padding: '10px 0', caretColor: 'var(--text)' },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': { backgroundColor: 'var(--surface-sunken)', color: 'var(--text-subtle)', borderRight: '1px solid var(--border)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 9px 0 12px', minWidth: '3em' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-selected)', color: 'var(--text)' },
    '.cm-activeLine': { backgroundColor: dark ? '#ffffff06' : '#00000004' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: dark ? '#ffffff26' : '#00000020' },
    '.cm-selectionMatch': { backgroundColor: dark ? '#ffffff16' : '#00000010' },
    '.cm-searchMatch': { backgroundColor: dark ? '#bc986c35' : '#d6a96a45', outline: '1px solid #a8896550' },
    '.cm-searchMatch-selected': { backgroundColor: dark ? '#bc986c65' : '#c2945c65' },
    '&.cm-focused .cm-matchingBracket': { color: 'inherit', backgroundColor: dark ? '#ffffff26' : '#00000018', outline: '1px solid var(--border-strong)' },
    '.cm-foldPlaceholder': { color: 'var(--text-muted)', backgroundColor: 'var(--surface-selected)', border: '1px solid var(--border)', borderRadius: '4px' },
    '.cm-panels': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)' },
    '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '.cm-tooltip': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '6px' },
  }, { dark }), syntaxHighlighting(HighlightStyle.define([
    { tag: tags.comment, color: dark ? '#929292' : '#777777', fontStyle: 'italic' },
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: dark ? '#c5b5d6' : '#765587' },
    { tag: [tags.string, tags.special(tags.string)], color: dark ? '#b6c6a6' : '#4f7146' },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: dark ? '#d0b493' : '#8d6135' },
    { tag: [tags.function(tags.variableName), tags.labelName], color: dark ? '#b7c9da' : '#3f658a' },
    { tag: [tags.propertyName, tags.attributeName], color: dark ? '#c6c3b9' : '#665d48' },
    { tag: [tags.tagName, tags.typeName, tags.className], color: dark ? '#abc9c3' : '#3f7269' },
    { tag: tags.heading, color: dark ? '#e3e3e3' : '#202020', fontWeight: 'bold' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, textDecoration: 'underline' },
    { tag: tags.invalid, color: 'var(--danger)' },
  ]))];
}

function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  queueMicrotask(() => {
    const input = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
    input?.focus();
    input?.select();
  });
  return true;
}

function indentation(indent: CodeEditorProps['indent']): string {
  return indent === 'tab' ? '\t' : indent === '4' ? '    ' : '  ';
}

// The parent supplies a React key when loading/reloading a different document.
// Settings and callback updates reconfigure the existing view without losing undo.
const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(props);
  const getText = useRef<(() => string) | null>(null);
  const pendingFlushes = useRef(new Set<() => void>());
  const inputMeasureKey = useRef({});
  const config = useRef({ appearance: new Compartment(), wrapping: new Compartment(), writable: new Compartment(), language: new Compartment(), indentation: new Compartment() });
  current.current = props;

  useImperativeHandle(ref, () => ({
    getText: () => getText.current?.() ?? current.current.initialText,
    flushText: () => {
      const editor = view.current;
      const read = getText.current;
      if (!editor || !read) return Promise.resolve(current.current.initialText);
      return new Promise<string>(resolve => {
        let measured: string | undefined;
        const finish = () => { pendingFlushes.current.delete(finish); resolve(measured ?? read()); };
        pendingFlushes.current.add(finish);
        // The public measure cycle flushes pending DOM/IME changes before read.
        editor.requestMeasure({ read: () => { measured = read(); }, write: finish });
      });
    },
    focus: () => view.current?.focus(),
    find: () => { if (view.current) openSearchPanel(view.current); },
    replace: () => { if (view.current) openReplace(view.current); },
    gotoLine: () => { if (view.current) gotoLine(view.current); },
    undo: () => { if (view.current) { undo(view.current); view.current.focus(); } },
    redo: () => { if (view.current) { redo(view.current); view.current.focus(); } },
    formatJson: () => {
      const editor = view.current;
      if (!editor || current.current.readOnly || editor.state.readOnly) return false;
      const original = editor.state.doc.sliceString(0, editor.state.doc.length, '\n');
      const bom = original.startsWith('\ufeff') ? '\ufeff' : '';
      let formatted: string;
      try {
        formatted = bom + JSON.stringify(JSON.parse(original.slice(bom.length)), null, indentation(current.current.indent)) + (original.match(/\n+$/)?.[0] || '');
      } catch { return false; }
      if (formatted !== original) {
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: formatted }, userEvent: 'input.format', annotations: isolateHistory.of('full') });
      }
      editor.focus();
      return true;
    },
  }), []);

  useLayoutEffect(() => {
    if (!mount.current) return;
    const initial = current.current;
    const document = createEditorDocument(initial.initialText);
    const language = editorLanguage(initial.path, initial.language);
    const editor = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: initial.initialText,
        extensions: [
          document.extensions, lineNumbers(), highlightActiveLineGutter(), history(), foldGutter(),
          drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
          indentOnInput(), bracketMatching(), closeBrackets(),
          rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
          search({ top: true }), EditorState.phrases.of(phrases),
          EditorView.domEventHandlers({
            beforeinput: (_event, editor) => {
              current.current.onInputPending?.(true);
              editor.requestMeasure({ key: inputMeasureKey.current, read: () => null, write: () => current.current.onInputPending?.(false) });
              return false;
            },
            input: (_event, editor) => {
              current.current.onInputPending?.(true);
              editor.requestMeasure({ key: inputMeasureKey.current, read: () => null, write: () => current.current.onInputPending?.(false) });
              return false;
            },
          }),
          EditorView.contentAttributes.of({ 'aria-label': '文件内容', 'aria-multiline': 'true', spellcheck: 'false' }),
          config.current.appearance.of(editorAppearance(initial.theme)),
          config.current.language.of(language.extension),
          config.current.indentation.of([indentUnit.of(indentation(initial.indent)), EditorState.tabSize.of(initial.indent === '2' || !initial.indent ? 2 : 4)]),
          config.current.wrapping.of(initial.wrap ? EditorView.lineWrapping : []),
          config.current.writable.of([EditorState.readOnly.of(initial.readOnly), EditorView.editable.of(!initial.readOnly)]),
          Prec.highest(keymap.of([
            { key: 'Mod-s', run: () => { if (!current.current.readOnly) current.current.onSave(); return true; }, preventDefault: true, scope: 'editor search-panel' },
            { key: 'Mod-h', run: openReplace, preventDefault: true, scope: 'editor search-panel' },
            { key: 'Mod-g', run: gotoLine, preventDefault: true, scope: 'editor search-panel' },
          ])),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) current.current.onChange(document.getText(update.state));
            if (update.docChanged || update.selectionSet) {
              const position = update.state.selection.main.head;
              const line = update.state.doc.lineAt(position);
              current.current.onCursorChange(line.number, position - line.from + 1);
            }
          }),
        ],
      }),
    });
    view.current = editor;
    getText.current = () => document.getText(editor.state);
    initial.onCursorChange(1, 1);
    editor.focus();
    return () => {
      for (const finish of pendingFlushes.current) finish();
      current.current.onInputPending?.(false);
      getText.current = null;
      view.current = null;
      editor.destroy();
    };
  }, []);

  useEffect(() => { view.current?.dispatch({ effects: config.current.appearance.reconfigure(editorAppearance(props.theme)) }); }, [props.theme]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.wrapping.reconfigure(props.wrap ? EditorView.lineWrapping : []) }); }, [props.wrap]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.writable.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]) }); }, [props.readOnly]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.language.reconfigure(editorLanguage(props.path, props.language).extension) }); }, [props.path, props.language]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.indentation.reconfigure([indentUnit.of(indentation(props.indent)), EditorState.tabSize.of(props.indent === '2' || !props.indent ? 2 : 4)]) }); }, [props.indent]);

  return <div className="code-editor" ref={mount} />;
});

export default CodeEditor;
