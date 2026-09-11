import { EditorState, MapMode, StateEffect, StateField, type Extension } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';

type LineEnding = '\n' | '\r\n' | '\r';
type Separator = { position: number; value: LineEnding };
type DocumentEndings = { preferred: LineEnding; separators: Separator[] };

// CodeMirror stores a normalized document. Keep only the original line separators
// separately, including history effects, so editing never rewrites unrelated lines.
const restoreSeparators = StateEffect.define<Separator[]>({
  map: (value, changes) => value.flatMap(separator => {
    const position = changes.mapPos(separator.position, 1, MapMode.TrackDel);
    return position === null ? [] : [{ ...separator, position }];
  }),
});

function readEndings(text: string): DocumentEndings {
  const separators: Separator[] = [];
  const counts = new Map<LineEnding, number>();
  let removed = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const value = match[0] as LineEnding;
    separators.push({ position: match.index! - removed, value });
    counts.set(value, (counts.get(value) || 0) + 1);
    removed += value.length - 1;
  }
  const preferred = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '\n';
  return { preferred, separators };
}

export function createEditorDocument(initialText: string): { extensions: Extension; getText(state: EditorState): string } {
  const initial = readEndings(initialText);
  const endings = StateField.define<DocumentEndings>({
    create: () => initial,
    update(value, transaction) {
      if (!transaction.docChanged && !transaction.effects.some(effect => effect.is(restoreSeparators))) return value;
      const next = new Map<number, LineEnding>();
      let index = 0;
      transaction.changes.iterGaps((fromA, fromB, length) => {
        while (index < value.separators.length && value.separators[index].position < fromA) index++;
        while (index < value.separators.length && value.separators[index].position < fromA + length) {
          const separator = value.separators[index++];
          next.set(fromB + separator.position - fromA, separator.value);
        }
      });
      transaction.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
        const text = inserted.sliceString(0, inserted.length, '\n');
        for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
          next.set(fromB + at, value.preferred);
        }
      });
      for (const effect of transaction.effects) {
        if (!effect.is(restoreSeparators)) continue;
        for (const separator of effect.value) {
          if (next.has(separator.position)) next.set(separator.position, separator.value);
        }
      }
      return { preferred: value.preferred, separators: [...next].sort((a, b) => a[0] - b[0]).map(([position, value]) => ({ position, value })) };
    },
  });

  const invert = invertedEffects.of(transaction => {
    const previous = transaction.startState.field(endings).separators;
    const restored = new Map<number, LineEnding>();
    let index = 0;
    transaction.changes.iterChangedRanges((from, to) => {
      while (index < previous.length && previous[index].position < from) index++;
      while (index < previous.length && previous[index].position < to) {
        const separator = previous[index++];
        restored.set(separator.position, separator.value);
      }
    });
    return restored.size ? [restoreSeparators.of([...restored].map(([position, value]) => ({ position, value })))] : [];
  });

  return {
    extensions: [endings, invert],
    getText(state) {
      const normalized = state.doc.sliceString(0, state.doc.length, '\n');
      const pieces: string[] = [];
      let start = 0;
      for (const separator of state.field(endings).separators) {
        pieces.push(normalized.slice(start, separator.position), separator.value);
        start = separator.position + 1;
      }
      pieces.push(normalized.slice(start));
      return pieces.join('');
    },
  };
}
