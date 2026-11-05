import {
  RiDatabase2Line,
  RiRefreshLine,
  RiRestartLine,
  RiRobot2Line,
  RiStore2Line,
  RiTruckLine,
} from '@remixicon/react';

import { Avatar } from '@/components/base/avatar/avatar';
import { Button } from '@/components/base/buttons/button';
import { Switch } from '@/components/base/switch/switch';
import { cx } from '@/utils/cx';

import type { ChaosFlags, Persona } from '../../types';

interface PersonaSidebarProps {
  personas: Persona[];
  selectedId: string;
  onSelect: (persona: Persona) => void;
  chaos: ChaosFlags;
  onChaosChange: (flags: Partial<ChaosFlags>) => void;
  onNewConversation: () => void;
  onShipOrder: () => void;
  onResetDemo: () => void;
  busy: boolean;
}

const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('');

const AVATAR_COLORS = ['lime', 'blue', 'pink', 'neutral'] as const;

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="px-1 pb-2 text-caption-1-semibold tracking-wide text-text-tertiary uppercase">
      {children}
    </h2>
  );
}

export function PersonaSidebar(props: PersonaSidebarProps) {
  const { personas, selectedId, onSelect, chaos, onChaosChange, busy } = props;
  return (
    <aside className="flex min-h-0 flex-col gap-6 overflow-y-auto border-r border-border-button-default bg-background-primary-default p-4">
      <section>
        <SectionTitle>Cliente simulado</SectionTitle>
        <ul className="flex flex-col gap-1.5">
          {personas.map((persona, index) => {
            const selected = persona.id === selectedId;
            return (
              <li key={persona.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(persona);
                  }}
                  className={cx(
                    'flex w-full items-start gap-3 rounded-xl border p-2.5 text-left transition-colors',
                    selected
                      ? 'border-accent-300 bg-accent-50'
                      : 'border-transparent hover:bg-background-secondary-default',
                  )}
                  aria-pressed={selected}
                >
                  <Avatar
                    size="md"
                    initials={initials(persona.name)}
                    color={AVATAR_COLORS[index % AVATAR_COLORS.length]}
                  />
                  <span className="min-w-0">
                    <span className="block text-body-semibold text-text-primary">
                      {persona.name}
                    </span>
                    <span className="block text-caption-1-medium text-text-tertiary">
                      {persona.phone}
                    </span>
                    <span className="mt-1 block text-caption-1-regular text-text-secondary">
                      {persona.description}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <SectionTitle>Simular falhas</SectionTitle>
        <div className="flex flex-col gap-3 rounded-xl border border-border-button-default p-3">
          <Switch
            size="sm"
            isSelected={chaos.ordersApiDown}
            onChange={(value) => {
              onChaosChange({ ordersApiDown: value });
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <RiDatabase2Line className="size-4 text-text-tertiary" aria-hidden />
              API de pedidos fora do ar
            </span>
          </Switch>
          <Switch
            size="sm"
            isSelected={chaos.catalogDown}
            onChange={(value) => {
              onChaosChange({ catalogDown: value });
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <RiStore2Line className="size-4 text-text-tertiary" aria-hidden />
              Fake Store fora do ar
            </span>
          </Switch>
          <Switch
            size="sm"
            isSelected={chaos.llmDown}
            onChange={(value) => {
              onChaosChange({ llmDown: value });
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <RiRobot2Line className="size-4 text-text-tertiary" aria-hidden />
              Modelo de IA indisponível
            </span>
          </Switch>
        </div>
      </section>

      <section>
        <SectionTitle>Demonstração</SectionTitle>
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            size="small"
            leadingIcon={RiRefreshLine}
            onClick={props.onNewConversation}
            disabled={busy}
          >
            Nova conversa
          </Button>
          <Button
            variant="secondary"
            size="small"
            leadingIcon={RiTruckLine}
            onClick={props.onShipOrder}
            disabled={busy}
          >
            Despachar pedido 100101 agora
          </Button>
          <Button
            variant="ghost"
            size="small"
            leadingIcon={RiRestartLine}
            onClick={props.onResetDemo}
            disabled={busy}
          >
            Recriar dados de demonstração
          </Button>
          <p className="px-1 text-caption-1-regular text-text-tertiary">
            Despachar o pedido entre a pergunta de confirmação e o “sim” mostra a API recusando o
            cancelamento na hora da execução.
          </p>
        </div>
      </section>
    </aside>
  );
}
