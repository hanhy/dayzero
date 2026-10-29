import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import {
  explanationPrompt,
  readSseEvents,
  type ModelProfile,
} from '@dayzero/contracts';
import { api } from './api.ts';
import './word-explanation.css';

type SelectionInfo = { text: string; x: number; y: number; bottom: number };
type Status = 'idle' | 'loading' | 'streaming' | 'done' | 'stopped' | 'error';
const PREFERENCE = 'dayzero.explanation.chatProfileId';
function Sparkles() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m11 3 2.5 6.5L20 12l-6.5 2.5L11 21l-2.5-6.5L2 12l6.5-2.5L11 3Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="m20 2 .8 2.2L23 5l-2.2.8L20 8l-.8-2.2L17 5l2.2-.8L20 2Z"
        fill="currentColor"
      />
    </svg>
  );
}
export default function WordExplanation() {
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [selection, setSelection] = useState<SelectionInfo | null>(null),
    [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelProfile[]>([]),
    [profileId, setProfileId] = useState('');
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [status, setStatus] = useState<Status>('idle');
  const selectionRef = useRef<SelectionInfo | null>(null),
    dismissed = useRef<string | null>(null),
    openRef = useRef(false),
    abort = useRef<AbortController | null>(null),
    requestId = useRef(0);
  const responseBox = useRef<HTMLDivElement>(null),
    closeButton = useRef<HTMLButtonElement>(null),
    stick = useRef(true),
    returnFocus = useRef<HTMLElement | null>(null);
  openRef.current = open;
  const stop = () => {
    requestId.current++;
    abort.current?.abort();
    abort.current = null;
  };
  const close = () => {
    const wasOpen = openRef.current;
    dismissed.current = selectionRef.current?.text ?? null;
    stop();
    openRef.current = false;
    setOpen(false);
    setSelection(null);
    selectionRef.current = null;
    if (wasOpen) returnFocus.current?.focus({ preventScroll: true });
    returnFocus.current = null;
  };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined,
      dragging = false;
    const inside = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest('[data-word-explanation]'));
    const read = () => {
      if (openRef.current || dragging) return;
      const active = document.activeElement;
      let text = '',
        bounds: DOMRect | undefined;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement
      ) {
        if (
          active instanceof HTMLInputElement &&
          !['text', 'search', 'url', 'email', 'tel'].includes(active.type)
        ) {
          selectionRef.current = null;
          setSelection(null);
          return;
        }
        const start = active.selectionStart,
          end = active.selectionEnd;
        if (start !== null && end !== null && end > start) {
          text = active.value.slice(start, end);
          bounds = active.getBoundingClientRect();
        }
      } else {
        const selected = window.getSelection();
        if (selected && !selected.isCollapsed && selected.rangeCount) {
          const node = selected.anchorNode?.parentElement;
          if (node?.closest('[data-word-explanation],button,select')) return;
          text = selected.toString();
          bounds = selected.getRangeAt(0).getBoundingClientRect();
        }
      }
      text = text.trim();
      if (text === dismissed.current) return;
      if (
        !text ||
        text.length > 500 ||
        !bounds ||
        bounds.bottom < 0 ||
        bounds.top > window.innerHeight
      ) {
        selectionRef.current = null;
        setSelection(null);
        return;
      }
      const next = {
        text,
        x: Math.max(12, Math.min(bounds.left, window.innerWidth - 108)),
        y: Math.max(8, bounds.top),
        bottom: bounds.bottom,
      };
      selectionRef.current = next;
      setSelection(next);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 100);
    };
    const down = (event: PointerEvent) => {
      if (inside(event.target)) return;
      dragging = true;
      if (openRef.current) close();
      dismissed.current = null;
    };
    const up = (event: PointerEvent) => {
      dragging = false;
      if (!inside(event.target)) schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearTimeout(timer);
        close();
      } else if (!inside(event.target)) schedule();
    };
    const change = () => {
      if (!openRef.current) schedule();
    };
    const scroll = (event: Event) => {
      if (inside(event.target)) return;
      if (!openRef.current) {
        setSelection(null);
        selectionRef.current = null;
      }
    };
    const resize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    document.addEventListener('selectionchange', change);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('keyup', key);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      clearTimeout(timer);
      openRef.current = false;
      requestId.current++;
      abort.current?.abort();
      document.removeEventListener('selectionchange', change);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('keyup', key);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, []);
  useEffect(() => {
    if (open) closeButton.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (stick.current && responseBox.current)
      responseBox.current.scrollTop = responseBox.current.scrollHeight;
  }, [text, status]);
  const generate = async (id: string, selected: SelectionInfo) => {
    stop();
    const controller = new AbortController();
    abort.current = controller;
    const current = ++requestId.current;
    stick.current = true;
    setText('');
    setError('');
    setStatus('loading');
    try {
      const response = await fetch('/api/explanations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: selected.text, profileId: id }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `请求失败（${response.status}）`);
      }
      if (!response.body) throw new Error('模型响应为空');
      let completed = false;
      for await (const event of readSseEvents(response.body)) {
        if (current !== requestId.current || controller.signal.aborted) return;
        const data = JSON.parse(event.data);
        if (event.event === 'delta' && typeof data.text === 'string') {
          setStatus('streaming');
          setText((value) => value + data.text);
        } else if (event.event === 'error')
          throw new Error(
            typeof data.error === 'string' ? data.error : '解释失败，请重试',
          );
        else if (event.event === 'done') {
          completed = true;
          setStatus('done');
          break;
        }
      }
      if (!completed) throw new Error('连接已中断，点击重新解释再试一次');
    } catch (e) {
      if (current !== requestId.current || controller.signal.aborted) return;
      setError((e as Error).message);
      setStatus('error');
    }
  };
  const explain = async () => {
    const selected = selectionRef.current;
    if (!selected) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    openRef.current = true;
    setOpen(true);
    setText('');
    setError('');
    setStatus('loading');
    // Opening a popup loads only model metadata. Keys stay on the server.
    stop();
    const current = requestId.current;
    try {
      const result = await api<{ profiles: ModelProfile[] }>('/api/models');
      if (!openRef.current) return;
      const available = result.profiles.filter(
        (model) => model.purpose === 'chat',
      );
      setModels(available);
      if (!available.length)
        throw new Error('请先在「模型设置」中添加一个对话模型');
      let preferred = '';
      try {
        preferred = localStorage.getItem(PREFERENCE) ?? '';
      } catch {}
      const chosen =
        available.find((model) => model.id === preferred) ?? available[0]!;
      setProfileId(chosen.id);
      if (current !== requestId.current) return;
      await generate(chosen.id, selected);
    } catch (e) {
      if (current === requestId.current && openRef.current) {
        setError((e as Error).message);
        setStatus('error');
      }
    }
  };
  if (!selection) return null;
  const top = selection.bottom + 12;
  const popupTop =
    top + 340 < viewport.height
      ? top
      : Math.max(12, Math.min(selection.y - 360, viewport.height - 380));
  const left = Math.max(12, Math.min(selection.x, viewport.width - 396));
  const generating = status === 'loading' || status === 'streaming';
  return createPortal(
    <div data-word-explanation>
      {!open ? (
        <div
          className="word-explain-toolbar"
          role="toolbar"
          aria-label="划词操作"
          style={{
            left: Math.max(12, Math.min(selection.x, viewport.width - 108)),
            top: selection.y > 48 ? selection.y - 42 : selection.bottom + 8,
          }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            aria-label="用 AI 解释选中文字"
            title="用大模型解释这个词"
            onClick={() => void explain()}
          >
            <Sparkles />
            <span>解释</span>
          </button>
        </div>
      ) : (
        <section
          className="word-explain-popup"
          role="dialog"
          aria-modal="false"
          aria-label="划词解释"
          style={{
            left,
            top: popupTop,
            maxHeight: `${Math.max(160, viewport.height - popupTop - 12)}px`,
          }}
        >
          <header>
            <div>
              <span className="word-explain-caption">
                <Sparkles />
                概念解释
              </span>
              <h3 title={selection.text}>{selection.text}</h3>
            </div>
            <button
              ref={closeButton}
              type="button"
              className="word-explain-close"
              aria-label="关闭划词解释"
              onClick={close}
            >
              ×
            </button>
          </header>
          <div className="word-explain-prompt">
            {explanationPrompt(selection.text)}
          </div>
          <div
            className="word-explain-answer"
            ref={responseBox}
            aria-label="词语解释内容"
            aria-busy={generating}
            onScroll={(event) => {
              const box = event.currentTarget;
              stick.current =
                box.scrollHeight - box.scrollTop - box.clientHeight < 32;
            }}
          >
            {text && (
              <div className="word-explain-text">
                <ReactMarkdown
                  rehypePlugins={[rehypeSanitize]}
                  components={{
                    a: (props) => (
                      <a {...props} target="_blank" rel="noopener noreferrer" />
                    ),
                  }}
                >
                  {text}
                </ReactMarkdown>
              </div>
            )}
            {status === 'loading' && (
              <p className="word-explain-waiting">
                正在等待模型回应<span>…</span>
              </p>
            )}
            {status === 'streaming' && (
              <span className="word-explain-cursor" aria-hidden="true" />
            )}
            {error && (
              <p className="word-explain-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer>
            <select
              aria-label="划词解释模型"
              value={profileId}
              disabled={!models.length}
              onChange={(event) => {
                stop();
                setProfileId(event.target.value);
                setStatus('idle');
                setText('');
                setError('');
                try {
                  localStorage.setItem(PREFERENCE, event.target.value);
                } catch {}
              }}
            >
              {!models.length && <option value="">未配置对话模型</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            {generating ? (
              <button
                type="button"
                onClick={() => {
                  stop();
                  setStatus('stopped');
                }}
              >
                停止生成
              </button>
            ) : (
              <button
                type="button"
                disabled={!profileId || !models.length}
                onClick={() => void generate(profileId, selection)}
              >
                重新解释
              </button>
            )}
          </footer>
          <div className="word-explain-status" role="status">
            {
              {
                idle: '点击重新解释开始生成',
                loading: '连接模型中',
                streaming: '正在生成…',
                done: '解释完成',
                stopped: '已停止生成',
                error: '解释未完成',
              }[status]
            }
          </div>
        </section>
      )}
    </div>,
    document.body,
  );
}
