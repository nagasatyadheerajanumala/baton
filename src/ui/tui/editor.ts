import type { Key } from 'ink';

/** Single-line prompt editor with readline-style keys and history. Pure, for testing. */
export interface EditorState {
  value: string;
  cursor: number;
  history: string[];
  /** Index into history while browsing with ↑/↓; null when editing a fresh line. */
  histIdx: number | null;
  draft: string;
}

export const emptyEditor = (history: string[] = []): EditorState => ({ value: '', cursor: 0, history, histIdx: null, draft: '' });

const wordLeft = (v: string, c: number) => {
  let i = c;
  while (i > 0 && v[i - 1] === ' ') i--;
  while (i > 0 && v[i - 1] !== ' ') i--;
  return i;
};
const wordRight = (v: string, c: number) => {
  let i = c;
  while (i < v.length && v[i] === ' ') i++;
  while (i < v.length && v[i] !== ' ') i++;
  return i;
};

export function editKey(s: EditorState, input: string, key: Partial<Key>): { state: EditorState; submit?: string } {
  const set = (value: string, cursor: number): EditorState => ({ ...s, value, cursor, histIdx: s.histIdx === null ? null : s.histIdx });
  const { value: v, cursor: c } = s;

  if (key.return) {
    const text = v.trim();
    if (!text) return { state: s };
    const history = s.history[s.history.length - 1] === text ? s.history : [...s.history, text].slice(-200);
    return { state: emptyEditor(history), submit: text };
  }
  if (key.backspace || (key.delete && !key.meta)) {
    if (key.meta || (key.ctrl && input === 'w')) {
      const to = wordLeft(v, c);
      return { state: set(v.slice(0, to) + v.slice(c), to) };
    }
    return c > 0 ? { state: set(v.slice(0, c - 1) + v.slice(c), c - 1) } : { state: s };
  }
  if (key.leftArrow) return { state: set(v, key.meta || key.ctrl ? wordLeft(v, c) : Math.max(0, c - 1)) };
  if (key.rightArrow) return { state: set(v, key.meta || key.ctrl ? wordRight(v, c) : Math.min(v.length, c + 1)) };
  if (key.home || (key.ctrl && input === 'a')) return { state: set(v, 0) };
  if (key.end || (key.ctrl && input === 'e')) return { state: set(v, v.length) };
  if (key.ctrl && input === 'u') return { state: set(v.slice(c), 0) };
  if (key.ctrl && input === 'k') return { state: set(v.slice(0, c), c) };
  if (key.ctrl && input === 'w') {
    const to = wordLeft(v, c);
    return { state: set(v.slice(0, to) + v.slice(c), to) };
  }
  if (key.meta && input === 'b') return { state: set(v, wordLeft(v, c)) };
  if (key.meta && input === 'f') return { state: set(v, wordRight(v, c)) };

  if (key.upArrow) {
    if (!s.history.length) return { state: s };
    const idx = s.histIdx === null ? s.history.length - 1 : Math.max(0, s.histIdx - 1);
    const value = s.history[idx]!;
    return { state: { ...s, value, cursor: value.length, histIdx: idx, draft: s.histIdx === null ? v : s.draft } };
  }
  if (key.downArrow) {
    if (s.histIdx === null) return { state: s };
    const idx = s.histIdx + 1;
    if (idx >= s.history.length) return { state: { ...s, value: s.draft, cursor: s.draft.length, histIdx: null } };
    const value = s.history[idx]!;
    return { state: { ...s, value, cursor: value.length, histIdx: idx } };
  }

  if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) return { state: s };
  if (!input) return { state: s };
  // Typed or pasted text. Newlines become spaces until multi-line input lands.
  const text = input.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (!text) return { state: s };
  return { state: set(v.slice(0, c) + text + v.slice(c), c + text.length) };
}
