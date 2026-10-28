import { useState, type ReactNode } from 'react';

export function ErrorNote({ message }: { message: string | null }) {
  return message ? (
    <div className="note error" role="alert">
      {message}
    </div>
  ) : null;
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <p className="muted">{what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** Colour a margin so a thin or negative one stands out. */
export function marginTone(pctValue: number | null | undefined): 'good' | 'warn' | 'bad' | 'muted' {
  if (pctValue === null || pctValue === undefined) return 'muted';
  if (pctValue < 0) return 'bad';
  if (pctValue < 20) return 'warn';
  return 'good';
}

/** A link to share (an invite or password reset), with a copy button. */
export function LinkBox({ url, what }: { url: string; what: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      /* the box below can still be selected by hand */
    }
  }
  return (
    <div className="note good">
      <strong>{what}</strong>
      <div className="linkbox">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={what} />
        <button type="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <span className="hint">Send this link yourself (chat or text). It works once and expires; it is not emailed automatically.</span>
    </div>
  );
}
