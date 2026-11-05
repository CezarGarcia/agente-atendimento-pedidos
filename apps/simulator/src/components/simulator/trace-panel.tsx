import type { ReactNode } from 'react';

import {
  RiCpuLine,
  RiErrorWarningLine,
  RiGitBranchLine,
  RiShieldCheckLine,
  RiShieldKeyholeLine,
  RiToolsLine,
} from '@remixicon/react';

import { Chip, type ChipColor } from '@/components/base/badges/chip';
import { cx } from '@/utils/cx';

import {
  GUARD_REASON_LABEL,
  PATH_LABEL,
  PII_LABEL,
  SIGNAL_LABEL,
  TOOL_LABEL,
  formatMs,
  formatUsd,
  sourceLabel,
} from '../../labels';
import type { TurnTrace } from '../../types';

interface TracePanelProps {
  traces: TurnTrace[];
  selected: number | null;
  onSelect: (index: number) => void;
}

const PATH_COLOR: Record<TurnTrace['path'], ChipColor> = {
  llm: 'purple',
  confirmation: 'lime',
  deterministic: 'gray',
};

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof RiCpuLine;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border-button-default bg-background-primary-default p-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-caption-1-semibold text-text-secondary">
        <Icon className="size-4 text-text-tertiary" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-caption-1-regular text-text-tertiary">{children}</p>;
}

function outcomeColor(outcome: string): ChipColor {
  if (outcome.startsWith('erro')) return 'rose';
  if (outcome.startsWith('nao_')) return 'orange';
  if (outcome.startsWith('confirmacao') || outcome.startsWith('transferido')) return 'cyan';
  return 'lime';
}

export function TracePanel({ traces, selected, onSelect }: TracePanelProps) {
  const trace = selected === null ? undefined : traces[selected];
  const totalCost = trace?.llmCalls.reduce((sum, call) => sum + call.costUsd, 0) ?? 0;

  return (
    <aside className="flex min-h-0 flex-col border-l border-border-button-default bg-background-secondary-default">
      <header className="border-b border-border-button-default bg-background-primary-default px-4 py-3">
        <p className="text-body-semibold text-text-primary">Bastidores do turno</p>
        <p className="text-caption-1-regular text-text-tertiary">
          Clique numa resposta do assistente para ver como ela foi decidida.
        </p>
        {traces.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Turnos">
            {traces.map((item, index) => (
              <button
                key={item.correlationId}
                type="button"
                role="tab"
                aria-selected={index === selected}
                onClick={() => {
                  onSelect(index);
                }}
                className={cx(
                  'rounded-md px-2 py-0.5 text-caption-1-medium transition-colors',
                  index === selected
                    ? 'bg-accent-400 text-white'
                    : 'bg-background-secondary-default text-text-secondary hover:bg-background-tertiary-default',
                )}
              >
                Turno {index + 1}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {!trace && (
          <Muted>
            Cada mensagem passa por guardrails de entrada, pela confirmação determinística ou pelo
            modelo com ferramentas e, por fim, pelo guardrail de saída. Os detalhes aparecem aqui.
          </Muted>
        )}

        {trace && (
          <>
            <Section icon={RiGitBranchLine} title="Caminho da decisão">
              <div className="flex flex-wrap items-center gap-2">
                <Chip color={PATH_COLOR[trace.path]}>{PATH_LABEL[trace.path]}</Chip>
                <span className="text-caption-1-medium text-text-tertiary">
                  {formatMs(trace.durationMs)}
                </span>
              </div>
              <p className="mt-2 text-caption-1-regular text-text-secondary">
                {sourceLabel(trace.responseSource)}
              </p>
              {trace.confirmation && (
                <p className="mt-1 text-caption-1-regular text-text-secondary">
                  Confirmação do pedido {trace.confirmation.orderId}:{' '}
                  <strong>{trace.confirmation.decision}</strong>
                  {trace.confirmation.outcome ? ` → ${trace.confirmation.outcome}` : ''}
                </p>
              )}
            </Section>

            <Section icon={RiShieldKeyholeLine} title="Guardrail de entrada">
              <div className="flex flex-wrap gap-1.5">
                {trace.inputGuard.piiDetected.map((kind) => (
                  <Chip key={kind} color="yellow" variant="caption">
                    {PII_LABEL[kind] ?? kind} mascarado
                  </Chip>
                ))}
                {trace.inputGuard.injectionSignals.map((signal) => (
                  <Chip key={signal} color="rose" variant="caption">
                    {SIGNAL_LABEL[signal] ?? signal}
                  </Chip>
                ))}
                {trace.inputGuard.truncated && (
                  <Chip color="orange" variant="caption">
                    Mensagem longa
                  </Chip>
                )}
              </div>
              {trace.inputGuard.piiDetected.length === 0 &&
                trace.inputGuard.injectionSignals.length === 0 &&
                !trace.inputGuard.truncated && (
                  <Muted>Nenhum dado pessoal ou sinal de manipulação.</Muted>
                )}
            </Section>

            <Section icon={RiToolsLine} title="Ferramentas">
              {trace.toolCalls.length === 0 ? (
                <Muted>Nenhuma ferramenta chamada neste turno.</Muted>
              ) : (
                <ol className="flex flex-col gap-2">
                  {trace.toolCalls.map((call, index) => (
                    <li key={index} className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block text-caption-1-semibold text-text-primary">
                          {TOOL_LABEL[call.name] ?? call.name}
                        </span>
                        <span className="block font-mono text-caption-2-regular text-text-tertiary">
                          {JSON.stringify(call.input)} · {formatMs(call.durationMs)}
                        </span>
                      </span>
                      <Chip color={outcomeColor(call.outcome)} variant="caption">
                        {call.outcome}
                      </Chip>
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            <Section icon={RiCpuLine} title="Chamadas ao modelo">
              {trace.llmCalls.length === 0 ? (
                <Muted>Turno resolvido sem chamar o modelo.</Muted>
              ) : (
                <>
                  <table className="w-full text-caption-2-medium text-text-secondary">
                    <thead className="text-text-tertiary">
                      <tr className="text-left">
                        <th className="pb-1 font-medium">#</th>
                        <th className="pb-1 font-medium">Parada</th>
                        <th className="pb-1 font-medium">Tempo</th>
                        <th className="pb-1 font-medium">Tokens</th>
                        <th className="pb-1 font-medium">Cache</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trace.llmCalls.map((call) => (
                        <tr key={call.iteration}>
                          <td>{call.iteration}</td>
                          <td className="font-mono">{call.stopReason}</td>
                          <td>{formatMs(call.latencyMs)}</td>
                          <td>
                            {call.inputTokens}→{call.outputTokens}
                          </td>
                          <td>{call.cacheReadTokens}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-caption-1-medium text-text-secondary">
                    {trace.llmCalls[0]?.model} · custo estimado {formatUsd(totalCost)}
                  </p>
                </>
              )}
            </Section>

            <Section
              icon={
                trace.outputGuard?.action === 'blocked' ? RiErrorWarningLine : RiShieldCheckLine
              }
              title="Guardrail de saída"
            >
              {!trace.outputGuard ? (
                <Muted>Resposta determinística: não depende do modelo.</Muted>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <Chip
                    color={
                      trace.outputGuard.action === 'blocked'
                        ? 'rose'
                        : trace.outputGuard.action === 'modified'
                          ? 'yellow'
                          : 'lime'
                    }
                  >
                    {trace.outputGuard.action === 'blocked'
                      ? 'Bloqueada'
                      : trace.outputGuard.action === 'modified'
                        ? 'Ajustada'
                        : 'Aprovada'}
                  </Chip>
                  {trace.outputGuard.reasons.map((reason) => (
                    <Chip key={reason} color="soft" variant="caption">
                      {GUARD_REASON_LABEL[reason] ?? reason}
                    </Chip>
                  ))}
                </div>
              )}
            </Section>

            <p className="px-1 font-mono text-caption-2-regular break-all text-text-tertiary">
              correlationId {trace.correlationId}
              <br />
              {trace.promptVersion}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
