import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

import { RiCheckDoubleLine, RiRobot2Line, RiSendPlane2Fill } from '@remixicon/react';

import { Avatar } from '@/components/base/avatar/avatar';
import { StatusDot } from '@/components/base/badges/status-dot';
import { Button } from '@/components/base/buttons/button';
import { cx } from '@/utils/cx';

import type { ChatEntry, Persona, QuickReply } from '../../types';
import { FormattedText } from './formatted-text';

interface ChatPanelProps {
  persona: Persona;
  entries: ChatEntry[];
  waiting: boolean;
  selectedTrace: number | null;
  onSelectTrace: (index: number) => void;
  onSendText: (text: string) => void;
  onQuickReply: (reply: QuickReply) => void;
}

const time = (date: Date) =>
  date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function ChatPanel(props: ChatPanelProps) {
  const { persona, entries, waiting } = props;
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastAgentIndex = entries.findLastIndex((entry) => entry.author === 'agent');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length, waiting]);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || waiting) return;
    props.onSendText(text);
    setDraft('');
  };

  return (
    <section className="flex min-h-0 flex-col bg-background-secondary-default">
      <header className="flex items-center gap-3 border-b border-border-button-default bg-background-primary-default px-5 py-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-accent-400 text-white">
          <RiRobot2Line className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body-semibold text-text-primary">Assistente virtual da loja</p>
          <p className="flex items-center gap-1.5 text-caption-1-medium text-text-tertiary">
            <StatusDot color="green" /> online · atendendo {persona.name} ({persona.phone})
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        {entries.length === 0 && (
          <div className="mx-auto mt-10 max-w-md rounded-2xl border border-dashed border-border-button-default bg-background-primary-default p-6 text-center">
            <p className="text-body-semibold text-text-primary">Comece uma conversa</p>
            <p className="mt-1 text-body-regular text-text-secondary">
              Você está no lugar de {persona.name}. Escreva como um cliente escreveria no WhatsApp
              ou use uma das sugestões abaixo.
            </p>
          </div>
        )}

        <ol className="flex flex-col gap-3">
          {entries.map((entry, index) => {
            const isAgent = entry.author === 'agent';
            const selectable = isAgent && entry.traceIndex !== undefined;
            return (
              <li
                key={entry.id}
                className={cx('flex flex-col', isAgent ? 'items-start' : 'items-end')}
              >
                <button
                  type="button"
                  disabled={!selectable}
                  onClick={() => {
                    if (entry.traceIndex !== undefined) props.onSelectTrace(entry.traceIndex);
                  }}
                  className={cx(
                    'max-w-[78%] rounded-2xl px-3.5 py-2 text-left text-body-regular text-text-primary shadow-xs transition',
                    isAgent
                      ? 'rounded-tl-sm bg-background-primary-default'
                      : 'rounded-tr-sm bg-status-lime-background',
                    selectable && 'cursor-pointer hover:ring-2 hover:ring-accent-200',
                    selectable &&
                      props.selectedTrace === entry.traceIndex &&
                      'ring-2 ring-accent-300',
                  )}
                  title={selectable ? 'Ver os bastidores deste turno' : undefined}
                >
                  <FormattedText text={entry.text} />
                  <span className="mt-1 flex items-center justify-end gap-1 text-caption-2-medium text-text-tertiary">
                    {time(entry.at)}
                    {!isAgent && (
                      <RiCheckDoubleLine className="size-3.5 text-accent-400" aria-hidden />
                    )}
                  </span>
                </button>
                {isAgent && entry.quickReplies && entry.quickReplies.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {entry.quickReplies.map((reply) => (
                      <Button
                        key={reply.payload}
                        size="small"
                        variant="secondary"
                        disabled={waiting || index !== lastAgentIndex}
                        onClick={() => {
                          props.onQuickReply(reply);
                        }}
                      >
                        {reply.title}
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
          {waiting && (
            <li className="flex items-center gap-2" aria-live="polite">
              <Avatar size="xs" initials="IA" color="neutral" />
              <span className="flex gap-1 rounded-2xl rounded-tl-sm bg-background-primary-default px-4 py-3 shadow-xs">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="size-1.5 animate-bounce rounded-full bg-text-tertiary"
                    style={{ animationDelay: `${dot * 150}ms` }}
                  />
                ))}
                <span className="sr-only">Assistente digitando</span>
              </span>
            </li>
          )}
        </ol>
        <div ref={bottomRef} />
      </div>

      <footer className="border-t border-border-button-default bg-background-primary-default px-5 pt-3 pb-4">
        <div className="mb-3 flex flex-wrap gap-2">
          {persona.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={waiting}
              onClick={() => {
                props.onSendText(suggestion);
              }}
              className="rounded-full border border-border-button-default px-3 py-1 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-secondary-default disabled:opacity-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex items-center gap-2">
          <label htmlFor="composer" className="sr-only">
            Mensagem
          </label>
          <input
            id="composer"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder="Digite uma mensagem"
            autoComplete="off"
            maxLength={1500}
            className="h-11 flex-1 rounded-full border border-border-button-default bg-background-secondary-default px-4 text-body-regular text-text-primary outline-none placeholder:text-text-placeholder focus:border-accent-300"
          />
          <Button
            type="submit"
            iconOnly
            leadingIcon={RiSendPlane2Fill}
            aria-label="Enviar"
            disabled={waiting || !draft.trim()}
          />
        </form>
      </footer>
    </section>
  );
}
