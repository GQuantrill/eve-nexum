import { useRef, useState, useEffect, useCallback } from 'react';
import MDEditor, { getCommands } from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';

interface Props {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  readOnly?: boolean;
}

// Notes are shared across users on corp maps, so the markdown preview has to
// sanitize HTML before it lands in the DOM. Defining the plugin list once at
// module scope avoids re-allocating it on every render.
const PREVIEW_OPTIONS = { rehypePlugins: [rehypeSanitize] };

// Toolbar commands minus the image and link insert buttons. Built once at
// module scope so the prop reference is stable across renders (getCommands()
// returns a fresh array each call, which would otherwise re-init the toolbar
// every render).
const HIDDEN_COMMANDS = new Set(['image', 'link']);
const NOTES_COMMANDS = getCommands().filter((c) => !HIDDEN_COMMANDS.has(c.keyCommand ?? ''));

// Persisted height (px) for the full Notes pane, so a user's drag-resize
// survives reloads / panel remounts. Per-device (localStorage). MDEditor reads
// `height` only at mount, so using the stored value as the initial height and
// writing back on change is conflict-free.
const NOTES_HEIGHT_KEY = 'nexum.notesEditorHeight';
const DEFAULT_NOTES_HEIGHT = 80;
const MIN_NOTES_HEIGHT = 80;

// Notes save (the parent onChange) is debounced so we don't write to the
// server on every keystroke; pending edits are flushed immediately on blur
// and on unmount so nothing is lost.
const SAVE_DEBOUNCE_MS = 600;

function readNotesHeight(): number {
  try {
    const v = parseInt(localStorage.getItem(NOTES_HEIGHT_KEY) ?? '', 10);
    return Number.isFinite(v) ? Math.max(MIN_NOTES_HEIGHT, v) : DEFAULT_NOTES_HEIGHT;
  } catch { return DEFAULT_NOTES_HEIGHT; }
}

export function NotesEditor({ value, onChange, compact = false, readOnly = false }: Props) {
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Initial height for the full pane, read once from localStorage at mount.
  const [initialHeight] = useState(readNotesHeight);

  // Local draft so typing stays instant while the parent save is debounced.
  const [draft, setDraft] = useState(value);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending   = useRef<string | null>(null);
  // Keep the latest onChange in a ref so the debounced flush never goes stale.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const flush = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (pending.current !== null) {
      onChangeRef.current(pending.current);
      pending.current = null;
    }
  }, []);

  // Adopt external updates (e.g. a remote edit) when the value prop actually
  // changes — but never while the user is actively editing, which would clobber
  // their typing. Done during render (React's recommended "adjust state on prop
  // change" pattern) rather than in an effect, so there's no extra render pass
  // and no risk of reverting an in-flight edit on blur.
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    if (!focused) setDraft(value);
  }

  // Flush any pending save when the editor unmounts.
  useEffect(() => () => flush(), [flush]);

  const handleEditorChange = (v: string | undefined) => {
    if (readOnly) return;
    const next = v ?? '';
    setDraft(next);
    pending.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  const enterEdit = () => {
    if (readOnly || focused) return;
    setFocused(true);
    setTimeout(() => {
      containerRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }, 0);
  };

  if (compact && !focused) {
    if (!draft) {
      if (readOnly) return <div className="notes-editor notes-editor--empty" />;
      return (
        <div className="notes-editor notes-editor--empty" onClick={enterEdit}>
          <span className="notes-editor__placeholder">Add note…</span>
        </div>
      );
    }
    return (
      <div className="notes-editor notes-editor--preview" onClick={enterEdit} title={draft}>
        {draft}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`notes-editor${compact ? '' : ' notes-editor--full'}`}
      data-color-mode="dark"
      onClick={enterEdit}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) { flush(); setFocused(false); }
      }}
    >
      <MDEditor
        value={draft}
        onChange={handleEditorChange}
        // Compact notes (signature / structure rows) read as a plain text
        // field: no markdown toolbar and a bare textarea (no live preview
        // split). The full Notes pane keeps the toolbar + live preview.
        preview={readOnly ? 'preview' : focused ? (compact ? 'edit' : 'live') : 'preview'}
        hideToolbar={readOnly || !focused || compact}
        // Drop the image + link insert buttons (custom command list), and clear
        // the right-hand cluster (edit/live/preview toggles + fullscreen).
        commands={NOTES_COMMANDS}
        extraCommands={[]}
        height={compact ? 120 : initialHeight}
        // Full Notes pane gets MDEditor's drag handle so users can pull it
        // taller; compact row notes stay fixed-height. The dragged height is
        // persisted per-device so it survives reloads.
        visibleDragbar={!compact}
        onHeightChange={compact ? undefined : (h) => {
          const px = typeof h === 'number' ? h : parseInt(String(h ?? ''), 10);
          if (Number.isFinite(px) && px >= MIN_NOTES_HEIGHT) {
            try { localStorage.setItem(NOTES_HEIGHT_KEY, String(Math.round(px))); } catch { /* quota / private mode */ }
          }
        }}
        previewOptions={PREVIEW_OPTIONS}
      />
    </div>
  );
}
