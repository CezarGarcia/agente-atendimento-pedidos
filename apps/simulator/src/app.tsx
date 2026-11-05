import { useCallback, useEffect, useState } from 'react';

import { RiAlertLine, RiCpuLine, RiFileCodeLine } from '@remixicon/react';

import { Chip } from '@/components/base/badges/chip';
import { Spinner } from '@/components/base/spinner/spinner';

import { api } from './api';
import { ChatPanel } from './components/simulator/chat-panel';
import { PersonaSidebar } from './components/simulator/persona-sidebar';
import { TracePanel } from './components/simulator/trace-panel';
import type {
  ChaosFlags,
  ChatEntry,
  Persona,
  QuickReply,
  SimulatorState,
  TurnTrace,
} from './types';

interface Session {
  entries: ChatEntry[];
  traces: TurnTrace[];
  selectedTrace: number | null;
}

const emptySession = (): Session => ({ entries: [], traces: [], selectedTrace: null });
let entrySequence = 0;
const entryId = () => `entry-${String(++entrySequence)}`;

export function App() {
  const [state, setState] = useState<SimulatorState | null>(null);
  const [personaId, setPersonaId] = useState('ana');
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .state()
      .then(setState)
      .catch((error: unknown) => {
        setNotice(
          error instanceof Error ? error.message : 'Não foi possível carregar o simulador.',
        );
      });
  }, []);

  const persona = state?.personas.find((item) => item.id === personaId) ?? state?.personas[0];
  const session = sessions[personaId] ?? emptySession();

  const updateSession = useCallback((id: string, update: (current: Session) => Session) => {
    setSessions((all) => ({ ...all, [id]: update(all[id] ?? emptySession()) }));
  }, []);

  const send = useCallback(
    async (target: Persona, message: { text?: string; button?: QuickReply }) => {
      const display = message.text ?? message.button?.title ?? '';
      updateSession(target.id, (current) => ({
        ...current,
        entries: [
          ...current.entries,
          { id: entryId(), author: 'customer', text: display, at: new Date() },
        ],
      }));
      setWaiting(true);
      setNotice(null);
      try {
        const { reply, trace } = await api.send(target.phone, message);
        updateSession(target.id, (current) => {
          const traces = trace ? [...current.traces, trace] : current.traces;
          const traceIndex = trace ? traces.length - 1 : undefined;
          const agentEntries: ChatEntry[] = reply.messages.map((outgoing) => ({
            id: entryId(),
            author: 'agent',
            text: outgoing.text,
            ...(outgoing.quickReplies ? { quickReplies: outgoing.quickReplies } : {}),
            at: new Date(),
            ...(traceIndex === undefined ? {} : { traceIndex }),
          }));
          return {
            entries: [...current.entries, ...agentEntries],
            traces,
            selectedTrace: traceIndex ?? current.selectedTrace,
          };
        });
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : 'Falha ao contatar o serviço do agente.',
        );
      } finally {
        setWaiting(false);
      }
    },
    [updateSession],
  );

  const changeChaos = async (flags: Partial<ChaosFlags>) => {
    const { chaos } = await api.setChaos(flags);
    setState((current) => (current ? { ...current, chaos } : current));
  };

  const newConversation = async () => {
    if (!persona) return;
    await api.endConversation(persona.phone);
    updateSession(persona.id, emptySession);
  };

  const shipOrder = async () => {
    const result = await api.shipOrder('100101');
    setNotice(
      result.shipped
        ? 'Pedido 100101 despachado: agora ele está "enviado" na API de pedidos.'
        : 'O pedido 100101 não está mais em processamento, então não foi despachado.',
    );
  };

  const resetDemo = async () => {
    setWaiting(true);
    try {
      await api.resetDemo();
      setSessions({});
      setState((current) =>
        current
          ? { ...current, chaos: { ordersApiDown: false, catalogDown: false, llmDown: false } }
          : current,
      );
      setNotice('Dados de demonstração recriados e conversas encerradas.');
    } finally {
      setWaiting(false);
    }
  };

  if (!state || !persona) {
    return (
      <main className="flex h-dvh items-center justify-center gap-3 bg-background-secondary-default text-text-secondary">
        {notice ? (
          <p className="text-body-medium text-text-error-primary">{notice}</p>
        ) : (
          <>
            <Spinner size="sm" /> Carregando simulador…
          </>
        )}
      </main>
    );
  }

  return (
    <div className="grid h-dvh grid-rows-[auto_auto_minmax(0,1fr)] bg-background-secondary-default font-sans">
      <header className="flex flex-wrap items-center gap-3 border-b border-border-button-default bg-background-primary-default px-5 py-3">
        <div className="mr-auto">
          <h1 className="text-title-3-semibold text-text-primary">Simulador de atendimento</h1>
          <p className="text-caption-1-regular text-text-tertiary">
            Mock do canal de mensagens · o modelo interpreta e conversa; o código decide e executa
          </p>
        </div>
        <Chip
          color={!state.llmConfigured ? 'orange' : state.llmSimulated ? 'soft' : 'purple'}
          variant="caption"
        >
          <RiCpuLine className="mr-1 size-3.5" aria-hidden />
          {state.llmSimulated ? 'modelo simulado (stub)' : state.model}
        </Chip>
        <Chip color="soft" variant="caption">
          <RiFileCodeLine className="mr-1 size-3.5" aria-hidden />
          {state.promptVersion}
        </Chip>
        <a
          href="/docs"
          onClick={(event) => {
            event.preventDefault();
            window.open('http://localhost:3001/docs', '_blank', 'noopener');
          }}
          className="text-caption-1-semibold text-accent-500 hover:underline"
        >
          API de pedidos (Swagger) ↗
        </a>
      </header>

      <div>
        {!state.llmConfigured && (
          <p className="flex items-center gap-2 border-b border-border-button-default bg-status-orange-background px-5 py-2 text-caption-1-medium text-status-orange-text">
            <RiAlertLine className="size-4" aria-hidden />
            ANTHROPIC_API_KEY não configurada: respostas que dependem do modelo usam a mensagem de
            indisponibilidade.
          </p>
        )}
        {notice && (
          <p className="border-b border-border-button-default bg-status-blue-background px-5 py-2 text-caption-1-medium text-status-blue-text">
            {notice}
          </p>
        )}
      </div>

      <main className="grid min-h-0 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_400px]">
        <PersonaSidebar
          personas={state.personas}
          selectedId={persona.id}
          onSelect={(next) => {
            setPersonaId(next.id);
          }}
          chaos={state.chaos}
          onChaosChange={(flags) => void changeChaos(flags)}
          onNewConversation={() => void newConversation()}
          onShipOrder={() => void shipOrder()}
          onResetDemo={() => void resetDemo()}
          busy={waiting}
        />
        <ChatPanel
          persona={persona}
          entries={session.entries}
          waiting={waiting}
          selectedTrace={session.selectedTrace}
          onSelectTrace={(index) => {
            updateSession(persona.id, (current) => ({ ...current, selectedTrace: index }));
          }}
          onSendText={(text) => void send(persona, { text })}
          onQuickReply={(reply) => void send(persona, { button: reply })}
        />
        <TracePanel
          traces={session.traces}
          selected={session.selectedTrace}
          onSelect={(index) => {
            updateSession(persona.id, (current) => ({ ...current, selectedTrace: index }));
          }}
        />
      </main>
    </div>
  );
}
