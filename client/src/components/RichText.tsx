import DOMPurify from 'dompurify';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

// Links open in a new tab and can't reach back into the app.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function sanitize(html: string) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'div', 'span', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|gif|jpe?g|webp);)/i,
  });
}

export function RichView({ html, empty = '' }: { html: string; empty?: string }) {
  if (!html || !html.replace(/<[^>]*>|&nbsp;|\s/g, '')) return <div className="rich-view muted">{empty}</div>;
  return <div className="rich-view" dangerouslySetInnerHTML={{ __html: sanitize(html) }} />;
}

const TOOLS: { cmd: string; icon: string; title: string; arg?: string }[] = [
  { cmd: 'bold', icon: 'bold', title: 'Bold (Ctrl+B)' },
  { cmd: 'italic', icon: 'italic', title: 'Italic (Ctrl+I)' },
  { cmd: 'underline', icon: 'underline', title: 'Underline (Ctrl+U)' },
  { cmd: 'strikeThrough', icon: 'strike', title: 'Strikethrough' },
  { cmd: 'insertUnorderedList', icon: 'ul', title: 'Bulleted list' },
  { cmd: 'insertOrderedList', icon: 'ol', title: 'Numbered list' },
  { cmd: 'formatBlock', icon: 'code', title: 'Code block', arg: 'pre' },
  { cmd: 'createLink', icon: 'link', title: 'Insert link' },
  { cmd: 'removeFormat', icon: 'clear', title: 'Clear formatting' },
];

/**
 * Lightweight rich-text editor (contentEditable + execCommand). Content is sanitized
 * on paste and whenever it is rendered.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight = 90,
  autoFocus,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const lastEmitted = useRef<string | null>(null);

  // Only overwrite the DOM when the value changes from outside the editor.
  useEffect(() => {
    const el = ref.current;
    if (!el || value === lastEmitted.current) return;
    el.innerHTML = sanitize(value);
    lastEmitted.current = value;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const html = el.innerHTML === '<br>' ? '' : el.innerHTML;
    lastEmitted.current = html;
    onChange(html);
  };

  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    if (cmd === 'createLink') {
      const url = window.prompt('Link URL', 'https://');
      if (!url || !/^(https?:|mailto:)/i.test(url)) return;
      arg = url;
    }
    document.execCommand(cmd, false, arg);
    emit();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    const image = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
    e.preventDefault();
    if (image && !html) {
      const file = image.getAsFile();
      if (!file) return;
      if (file.size > 2_000_000) {
        window.alert('Pasted images must be smaller than 2 MB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        document.execCommand('insertHTML', false, sanitize(`<img src="${reader.result}" alt="Pasted image">`));
        emit();
      };
      reader.readAsDataURL(file);
      return;
    }
    if (html) document.execCommand('insertHTML', false, sanitize(html));
    else document.execCommand('insertText', false, text);
    emit();
  };

  const isEmpty = !value || !value.replace(/<[^>]*>|&nbsp;|\s/g, '');

  return (
    <div className={`rte ${focused ? 'focused' : ''}`}>
      <div className="rte-toolbar" onMouseDown={(e) => e.preventDefault()}>
        {TOOLS.map((t) => (
          <button key={t.cmd} type="button" className="icon-btn" title={t.title} onClick={() => exec(t.cmd, t.arg)}>
            <Icon name={t.icon} size={14} />
          </button>
        ))}
      </div>
      <div className="rte-wrap">
        {isEmpty && !focused && placeholder && <div className="rte-placeholder">{placeholder}</div>}
        <div
          ref={ref}
          className="rte-content rich-view"
          contentEditable
          suppressContentEditableWarning
          style={{ minHeight }}
          onInput={emit}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>
    </div>
  );
}
