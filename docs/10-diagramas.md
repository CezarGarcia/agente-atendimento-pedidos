# Diagramas: como o sistema funciona

Nove figuras que explicam os fluxos principais. Cada uma aponta para o código que ela descreve; os
detalhes e o porquê de cada decisão estão nos outros documentos.

Cores usadas em todas as figuras: **azul** = código determinístico do agente, **laranja** = modelo
de IA, **verde** = API de pedidos, **vermelho** = bloqueio ou erro, **branco** = resposta fixa.

0. [Arquitetura da solução](#0-arquitetura-da-solução)
1. [Um turno do agente, da mensagem à resposta](#1-um-turno-do-agente)
2. [Defesa em camadas](#2-defesa-em-camadas)
3. [Cancelamento em dois turnos](#3-cancelamento-em-dois-turnos)
4. [Estados da confirmação](#4-estados-da-confirmação)
5. [Cancelamento dentro da API](#5-cancelamento-dentro-da-api)
6. [Integração com a Fake Store](#6-integração-com-a-fake-store)
7. [Guardrail de saída](#7-guardrail-de-saída)
8. [Avaliação com o modelo real](#8-avaliação-com-o-modelo-real)

## 0. Arquitetura da solução

![Arquitetura da solução](assets/diagramas/00-arquitetura.svg)

As peças e como elas se ligam: o canal simulado, o serviço do agente com o modelo, a API de
pedidos, a Fake Store e o PostgreSQL com um banco para cada serviço.

## 1. Um turno do agente

![Um turno do agente, da mensagem à resposta](assets/diagramas/01-turno-do-agente.svg)

Tudo o que acontece entre o webhook e a resposta. O modelo só entra no passo 6, e uma confirmação
pendente é resolvida pelo caminho da direita, sem IA. Código:
[`agent-service.ts`](../apps/agent/src/agent/agent-service.ts) (`process`, `decide`, `runModel`) e
[`agent-app.ts`](../apps/agent/src/http/agent-app.ts) (webhook).

## 2. Defesa em camadas

![Defesa em camadas: o que um ataque teria de furar](assets/diagramas/02-defesa-em-camadas.svg)

Cada ameaça precisa atravessar várias barreiras em série, e a última de cada linha não depende do
modelo. Mais detalhes no modelo de ameaças de
[`03-seguranca-e-guardrails.md`](03-seguranca-e-guardrails.md).

## 3. Cancelamento em dois turnos

![Cancelamento em dois turnos](assets/diagramas/03-sequencia-do-cancelamento.svg)

No primeiro turno o modelo só inicia o processo (`solicitar_cancelamento`) e o sistema envia a
pergunta fixa. No segundo, o modelo nem é chamado. Se a API não responder, o agente diz que não
conseguiu confirmar e a nova tentativa usa a mesma `Idempotency-Key`. Código:
[`tools.ts`](../apps/agent/src/agent/tools.ts) e `resolvePending` em
[`agent-service.ts`](../apps/agent/src/agent/agent-service.ts).

## 4. Estados da confirmação

![Estados da confirmação](assets/diagramas/04-estados-da-confirmacao.svg)

A ação pendente é o que liga a pergunta ao "sim". Só o estado `executing` chama a API, e um índice
único no PostgreSQL garante uma ação aberta por conversa. Código:
[`confirmation.ts`](../apps/agent/src/agent/confirmation.ts),
[`types.ts`](../apps/agent/src/agent/types.ts) e a migração
[`0004-executing-is-open.ts`](../apps/agent/src/conversation/migrations/0004-executing-is-open.ts).

## 5. Cancelamento dentro da API

![Cancelamento na API de pedidos](assets/diagramas/05-cancelamento-na-api.svg)

A regra de negócio é aplicada de novo na API, dentro de uma transação, com o pedido travado
(`SELECT … FOR UPDATE`) e a chave de idempotência registrada antes da decisão. Código:
[`orders-service.ts`](../apps/orders-api/src/application/orders-service.ts),
[`order.ts`](../apps/orders-api/src/domain/order.ts) e
[`orders.ts`](../apps/orders-api/src/http/routes/orders.ts).

## 6. Integração com a Fake Store

![Integração com a Fake Store](assets/diagramas/06-integracao-fake-store.svg)

O catálogo externo só dá nome aos itens. O texto passa por contrato, limpeza e descarte de campos
suspeitos antes de chegar ao modelo, e o preço da Fake Store é descartado. Código:
[`fakestore-client.ts`](../apps/agent/src/integrations/fakestore/fakestore-client.ts) e
`presentOrder` em [`tools.ts`](../apps/agent/src/agent/tools.ts). Mais em
[`05-integracao-fake-store.md`](05-integracao-fake-store.md).

## 7. Guardrail de saída

![Guardrail de saída](assets/diagramas/07-guardrail-de-saida.svg)

As verificações aplicadas ao texto do modelo antes do envio. É a última camada: a mensagem de
cancelamento concluído é um texto fixo e não depende dela. Código:
[`output-guard.ts`](../apps/agent/src/guardrails/output-guard.ts) (`guardOutput`).

## 8. Avaliação com o modelo real

![Avaliação com o modelo real: Haiku e Sonnet](assets/diagramas/08-evals-haiku-sonnet.svg)

Resultado da rodada final de comparação entre o Haiku 5.5 e o Sonnet 5.5. Os relatórios completos,
com as conversas e as respostas barradas, estão em [`evals/README.md`](evals/README.md).
