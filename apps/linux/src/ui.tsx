import { useEffect, useRef, useState, type ReactNode } from "react";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      focused?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : ""}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button aria-label={`Close ${title}`} onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Action({
  children,
  run,
  className = "",
  disabled = false,
  onError,
  label,
}: {
  children: ReactNode;
  run: () => Promise<unknown>;
  className?: string;
  disabled?: boolean;
  onError?: (e: string) => void;
  /** The button's name for a screen reader, when its text alone is ambiguous outside its group. */
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  return (
    <>
      <button
        className={className}
        aria-label={label}
        disabled={busy || disabled}
        onClick={async () => {
          if (active.current) return;
          active.current = true;
          setBusy(true);
          setError("");
          try {
            await run();
          } catch (e) {
            const message = String(e);
            if (onError) onError(message);
            else setError(message);
          } finally {
            active.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : children}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}
export function HoldAction({
  run,
  label,
}: {
  run: () => Promise<void>;
  label: string;
}) {
  const [remaining, setRemaining] = useState(5);
  const [holding, setHolding] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!holding) return;
    const start = Date.now();
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, 5 - Math.floor((Date.now() - start) / 1000));
      setRemaining(seconds);
      if (seconds === 0) {
        setReady(true);
        setHolding(false);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [holding]);
  return (
    <>
      <button
        className="primary"
        onPointerDown={() => {
          setRemaining(5);
          setHolding(true);
        }}
        onPointerUp={() => setHolding(false)}
        onPointerLeave={() => setHolding(false)}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            setRemaining(5);
            setHolding(true);
          }
        }}
        onKeyUp={() => setHolding(false)}
        onBlur={() => setHolding(false)}
        disabled={ready}
      >
        Hold 5 seconds to {label}
        {holding ? ` · ${remaining}` : ""}
      </button>
      {ready && (
        <Action
          run={async () => {
            try {
              await run();
            } finally {
              setReady(false);
            }
          }}
          onError={setError}
          className="primary"
        >
          {label}
        </Action>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
