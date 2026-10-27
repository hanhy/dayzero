import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';

export default function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initial = useRef(value);
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown 正文' }),
          EditorView.theme(
            {
              '&': {
                backgroundColor: '#0b151c',
                color: '#c9dcd5',
                minHeight: '270px',
                fontSize: '13px',
              },
              '.cm-content': {
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                padding: '16px 4px',
                minHeight: '270px',
                caretColor: '#b6e4d5',
              },
              '.cm-gutters': {
                backgroundColor: '#0b151c',
                color: '#4b626c',
                border: 'none',
              },
              '&.cm-focused': { outline: 'none' },
              '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
                backgroundColor: '#294b4c !important',
              },
              '.cm-activeLine, .cm-activeLineGutter': {
                backgroundColor: '#13252b',
              },
              '.cm-cursor': { borderLeftColor: '#b6e4d5' },
            },
            { dark: true },
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [readOnly]);
  useEffect(() => {
    initial.current = value;
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  }, [value]);
  return <div className="markdown-code" ref={host} />;
}
