import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import type { EditorPalette } from '../shared/types';
import { createEditorDocument } from './editor-document';
import { editorLanguage } from './editor-language';
import { editorAppearance } from './editor-theme';
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
  palette?: EditorPalette;
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
          config.current.appearance.of(editorAppearance(initial.theme, initial.palette)),
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

  useEffect(() => { view.current?.dispatch({ effects: config.current.appearance.reconfigure(editorAppearance(props.theme, props.palette)) }); }, [props.theme, props.palette]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.wrapping.reconfigure(props.wrap ? EditorView.lineWrapping : []) }); }, [props.wrap]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.writable.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]) }); }, [props.readOnly]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.language.reconfigure(editorLanguage(props.path, props.language).extension) }); }, [props.path, props.language]);
  useEffect(() => { view.current?.dispatch({ effects: config.current.indentation.reconfigure([indentUnit.of(indentation(props.indent)), EditorState.tabSize.of(props.indent === '2' || !props.indent ? 2 : 4)]) }); }, [props.indent]);

  return <div className="code-editor" ref={mount} />;
});

export default CodeEditor;
