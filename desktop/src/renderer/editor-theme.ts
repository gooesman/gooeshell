import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { yamlLanguage } from '@codemirror/lang-yaml';
import { tags } from '@lezer/highlight';
import type { EditorPalette } from '../shared/types';

export const editorPalettes: { id: EditorPalette; name: string }[] = [
  { id: 'auto', name: '跟随应用' },
  { id: 'graphite', name: '石墨黑' },
  { id: 'midnight', name: '深空蓝' },
  { id: 'paper', name: '柔和浅色' },
];

const palettes = {
  graphite: {
    background: '#15171a', foreground: '#d6dbe1', muted: '#9ba5b2', gutter: '#818d9c',
    panel: '#1d2025', selected: '#292f38', border: '#303741', focus: '#7bb7ff',
    activeLine: '#ffffff08', selection: '#315071', selectionMatch: '#8db8e32b',
    search: '#b78b303b', searchBorder: '#b89955', searchSelected: '#9b742566',
    comment: '#8d97a5', keyword: '#c9a1ef', string: '#9bcf8d', number: '#e9b276',
    property: '#7bb7ff', function: '#e1c68f', type: '#83cec5', invalid: '#f28b91',
  },
  midnight: {
    background: '#101827', foreground: '#dce4f2', muted: '#9eaec5', gutter: '#8091ab',
    panel: '#172235', selected: '#25344c', border: '#2c3d57', focus: '#80bdff',
    activeLine: '#a5c5ff0a', selection: '#304d78', selectionMatch: '#86b9ef2b',
    search: '#b78b303b', searchBorder: '#b69b62', searchSelected: '#9c792c66',
    comment: '#8a9cb8', keyword: '#c4a7f7', string: '#8fd3ae', number: '#f3b878',
    property: '#80bdff', function: '#efd497', type: '#83d8d2', invalid: '#ff989e',
  },
  paper: {
    background: '#f7f8fa', foreground: '#293444', muted: '#5f6c7d', gutter: '#697688',
    panel: '#edf0f4', selected: '#e1e7ef', border: '#d2dae5', focus: '#245f9e',
    activeLine: '#31527708', selection: '#bcd5ef', selectionMatch: '#6e9ed02b',
    search: '#ebbd4b40', searchBorder: '#b89335', searchSelected: '#e5b13980',
    comment: '#66717e', keyword: '#74429c', string: '#347343', number: '#9b5817',
    property: '#245f9e', function: '#806418', type: '#236f76', invalid: '#b73043',
  },
};

export function editorAppearance(theme: 'dark' | 'light', palette: EditorPalette = 'auto'): Extension {
  const resolved = palette === 'auto' ? (theme === 'dark' ? 'graphite' : 'paper') : palette;
  const colors = palettes[resolved];
  const dark = resolved !== 'paper';
  return [EditorView.theme({
    '&': {
      height: '100%', color: colors.foreground, backgroundColor: colors.background, colorScheme: dark ? 'dark' : 'light',
      // Keep search inputs, buttons and scrollbars on this palette, independent of the application theme.
      '--text': colors.foreground, '--text-muted': colors.muted, '--text-subtle': colors.gutter,
      '--surface-sunken': colors.background, '--surface-raised': colors.panel, '--surface-selected': colors.selected,
      '--border': colors.border, '--border-strong': colors.focus, '--danger': colors.invalid,
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '13px', fontWeight: '400', lineHeight: '1.65', overflow: 'auto' },
    '.cm-content': { padding: '10px 0', caretColor: colors.foreground },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': { backgroundColor: colors.background, color: colors.gutter, borderRight: `1px solid ${colors.border}` },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 9px 0 12px', minWidth: '3em' },
    '.cm-activeLineGutter': { backgroundColor: colors.selected, color: colors.foreground },
    '.cm-activeLine': { backgroundColor: colors.activeLine },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: colors.foreground },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: colors.selection },
    '.cm-selectionMatch': { backgroundColor: colors.selectionMatch },
    '.cm-searchMatch': { backgroundColor: colors.search, outline: `1px solid ${colors.searchBorder}` },
    '.cm-searchMatch-selected': { backgroundColor: colors.searchSelected },
    '&.cm-focused .cm-matchingBracket': { color: 'inherit', backgroundColor: colors.selected, outline: `1px solid ${colors.focus}` },
    '.cm-foldPlaceholder': { color: colors.muted, backgroundColor: colors.selected, border: `1px solid ${colors.border}`, borderRadius: '4px' },
    '.cm-panels': { backgroundColor: colors.panel, color: colors.foreground },
    '.cm-panels-top': { borderBottom: `1px solid ${colors.border}` },
    '.cm-panels-bottom': { borderTop: `1px solid ${colors.border}` },
    '.cm-tooltip': { backgroundColor: colors.panel, color: colors.foreground, border: `1px solid ${colors.border}`, borderRadius: '6px' },
  }, { dark }), syntaxHighlighting(HighlightStyle.define([
    { tag: tags.comment, color: colors.comment, fontStyle: 'italic' },
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: colors.keyword },
    { tag: [tags.string, tags.special(tags.string)], color: colors.string },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: colors.number },
    { tag: [tags.function(tags.variableName), tags.labelName], color: colors.function },
    { tag: [tags.propertyName, tags.attributeName], color: colors.property },
    { tag: [tags.tagName, tags.typeName, tags.className], color: colors.type },
    { tag: tags.heading, color: colors.foreground, fontWeight: 'bold' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, color: colors.property, textDecoration: 'underline' },
    { tag: tags.invalid, color: colors.invalid },
  ])), syntaxHighlighting(HighlightStyle.define([
    { tag: tags.content, color: colors.string },
  ], { scope: yamlLanguage }))];
}
