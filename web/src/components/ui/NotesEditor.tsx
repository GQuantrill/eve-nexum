import { useRef, useState } from 'react';
import MDEditor from '@uiw/react-md-editor';
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

export function NotesEditor({ value, onChange, compact = false, readOnly = false }: Props) {
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
      className="notes-editor"
      data-color-mode="dark"
      onClick={enterEdit}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false);
      }}
    >
      <MDEditor
        value={value}
        onChange={(v) => { if (!readOnly) onChange(v ?? ''); }}
        preview={readOnly ? 'preview' : focused ? 'live' : 'preview'}
        hideToolbar={readOnly || !focused}
        height={compact ? 120 : 80}
        visibleDragbar={false}
        previewOptions={PREVIEW_OPTIONS}
      />
    </div>
  );
}
