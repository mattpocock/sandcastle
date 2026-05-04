import type { FormEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Play, X } from "lucide-react";
import { useCreateRun } from "../api/queries";
import styles from "./chrome.module.css";

interface DeployChordOverlayProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function DeployChordOverlay({
  open,
  onOpenChange,
}: DeployChordOverlayProps): JSX.Element | null {
  const [directive, setDirective] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const navigate = useNavigate();
  const createRun = useCreateRun();

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = directive.trim();
    if (!trimmed || createRun.isPending) return;
    createRun.mutate(
      { directive: trimmed },
      {
        onSuccess: ({ runId }) => {
          setDirective("");
          onOpenChange(false);
          navigate(`/runs/${runId}/cockpit`);
        },
      },
    );
  };

  return (
    <div
      className="chord-backdrop"
      onMouseDown={(event) =>
        event.currentTarget === event.target && onOpenChange(false)
      }
    >
      <form className={`deploy-chord ${styles.octaPanel}`} onSubmit={submit}>
        <header className="chord-head">
          <span>
            <Play size={16} fill="currentColor" /> Deploy chord
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title="Close deploy chord"
          >
            <X size={16} />
          </button>
        </header>
        <div className="chord-route">
          <span className="chord-verb">Deploy</span>
          <span className="chord-chip">π · default</span>
          <span>to</span>
          <span className="chord-chip target">local repo</span>
        </div>
        <label className="directive-field">
          <span>Directive</span>
          <textarea
            ref={inputRef}
            value={directive}
            onChange={(event) => setDirective(event.target.value)}
            placeholder="Fix one small issue and explain the verification path..."
            rows={5}
          />
        </label>
        {createRun.error ? (
          <p className="form-error">{createRun.error.message}</p>
        ) : null}
        <footer className="chord-footer">
          <span>
            <kbd>Esc</kbd> dismiss
          </span>
          <button
            type="submit"
            disabled={!directive.trim() || createRun.isPending}
          >
            {createRun.isPending ? "Deploying" : "Deploy"}
          </button>
        </footer>
      </form>
    </div>
  );
}
