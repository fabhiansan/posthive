"use client";

import { useId, useRef, useState } from "react";
import { SendIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/lib/cn";

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface AiChatPanelProps {
  messages?: AiMessage[];
  /**
   * The seam for a future provider. While it is missing the assistant is "coming soon": nothing can
   * be sent and nothing leaves the browser. Whatever a provider changes in a design must go through
   * the same server-side field-permission checks as a manual edit.
   */
  onSend?: (text: string) => void | Promise<void>;
  /** A reply is on its way: input and Send are disabled. */
  pending?: boolean;
}

const SUGGESTIONS = [
  "Make the headline shorter",
  "Try a bolder colour palette",
  "Suggest a caption for this design",
  "Resize this for a Story",
];

export function AiChatPanel({ messages = [], onSend, pending = false }: AiChatPanelProps) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const canSend = !!onSend && !pending && draft.trim().length > 0;

  async function send() {
    if (!canSend || !onSend) return;
    const text = draft.trim();
    setDraft("");
    await onSend(text);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-800">
          <SparklesIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="type-body-sb-s text-fg">Posthive Assistant</p>
          <p className="type-body-r-xs text-muted">Edit designs by describing the change</p>
        </div>
        <span className="shrink-0 rounded-full border border-brand-400 bg-brand-100 px-2 py-0.5 type-body-sb-xs text-brand-800">
          Coming soon
        </span>
      </div>

      <div role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-4">
            <div>
              <p className="type-body-sb-s text-fg">The assistant isn&apos;t available yet</p>
              <p className="mt-1 type-body-r-s text-muted">
                Soon you&apos;ll describe a change and it will make it for you, within the parts of the design your role can edit.
              </p>
            </div>
            <div>
              <p className="mb-2 type-body-sb-xs text-muted">Things you&apos;ll be able to ask</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setDraft(s);
                      input.current?.focus();
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "max-w-[85%] rounded-2xl px-3 py-2 type-body-r-s",
                  m.role === "user" ? "self-end bg-brand-100 text-fg" : "self-start border border-border bg-surface text-fg",
                )}
              >
                {m.text}
              </li>
            ))}
            {pending && (
              <li className="flex items-center gap-2 self-start type-body-r-xs text-muted">
                <Spinner size="sm" label="Waiting for a reply" /> Thinking
              </li>
            )}
          </ul>
        )}
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={pending}
            placeholder="Describe a change…"
            aria-label="Message to the assistant"
            aria-describedby={onSend ? undefined : noteId}
            className="field min-h-0 flex-1 resize-none"
          />
          <Button type="submit" size="icon" disabled={!canSend} aria-label="Send message">
            {pending ? <Spinner size="sm" label="Sending" /> : <SendIcon />}
          </Button>
        </div>
        {!onSend && (
          <p id={noteId} className="mt-2 type-body-r-xs text-muted">
            Sending is switched off until the assistant launches. Nothing you type here leaves your browser.
          </p>
        )}
      </form>
    </div>
  );
}
