// Editing a server document (layout, library): changes show at once and save in order,
// each based on the revision the last save returned. A refused save falls back to the
// server's copy. Slider drags save after a short pause instead of on every step.
import { useEffect, useRef, useState } from 'react';

const DEBOUNCE_MS = 250;

export function useDraft<T extends { rev: number }>(doc: T, url: string) {
  const [draft, setDraftState] = useState(doc);
  const [error, setError] = useState<string>();
  const draftRef = useRef(doc);
  const server = useRef(doc);
  const rev = useRef(doc.rev);
  const pending = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const chain = useRef(Promise.resolve());
  const setDraft = (next: T) => {
    draftRef.current = next;
    setDraftState(next);
  };
  useEffect(() => {
    server.current = doc;
    if (pending.current === 0 && !timer.current) {
      rev.current = doc.rev;
      setDraft(doc);
    }
  }, [doc]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = (next: T) => {
    pending.current++;
    chain.current = chain.current.then(async () => {
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...next, rev: rev.current }),
        }).catch(() => undefined);
        const data = ((await res?.json().catch(() => undefined)) ?? {}) as { rev?: number; error?: string };
        if (res?.ok && data.rev !== undefined) {
          rev.current = data.rev;
        } else {
          setError(data.error ?? 'Can’t reach the server: the change wasn’t saved.');
          rev.current = server.current.rev;
          setDraft(server.current);
        }
      } finally {
        pending.current--;
        // The server's copy of our own save may have arrived while saves were pending.
        if (pending.current === 0 && !timer.current && server.current.rev === rev.current) setDraft(server.current);
      }
    });
  };

  /** Shows `next` and saves it; `soon` waits for a pause first (for sliders). */
  const save = (next: T = draftRef.current, soon = false) => {
    setDraft(next);
    setError(undefined);
    clearTimeout(timer.current);
    if (soon) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        send(draftRef.current);
      }, DEBOUNCE_MS);
    } else {
      timer.current = undefined;
      send(next);
    }
  };
  const update = (fn: (d: T) => T, soon = false) => save(fn(draftRef.current), soon);
  return { draft, draftRef, setDraft, save, update, error };
}
