import { useRef, useState } from 'react';
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

  const enterEdit = () => {
    if (readOnly || focused) return;
    setFocused(true);
    setTimeout(() => {
      containerRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }, 0);
  };

  if (compact && !focused) {
    if (!value) {
      if (readOnly) return <div className="notes-editor notes-editor--empty" />;
      return (
        <div className="notes-editor notes-editor--empty" onClick={enterEdit}>
          <span className="notes-editor__placeholder">Add note…</span>
        </div>
      );
    }
    return (
      <div className="notes-editor notes-editor--preview" onClick={enterEdit} title={value}>
        {value}
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
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false);
      }}
    >
      <MDEditor
        value={value}
        onChange={(v) => { if (!readOnly) onChange(v ?? ''); }}
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
