# Agente seguro de atendimento de pedidos

Agente de atendimento por mensagem de texto que consulta pedidos e ajuda o cliente a solicitar
cancelamentos **somente quando as regras de negócio permitem**. Um modelo de IA interpreta as
mensagens e conduz a conversa; as decisões e as ações ficam com código determinístico e com a
API principal de pedidos.

> **Princípio de projeto:** o modelo interpreta e conversa; o código decide e executa.

## Estrutura

| Caminho           | Responsabilidade                                                            |
| ----------------- | --------------------------------------------------------------------------- |
| `apps/orders-api` | API principal (Node.js, TypeScript, Express): pedidos e regras de negócio   |
| `apps/agent`      | Serviço do agente: canal de mensagens (mock), IA, guardrails, Fake Store    |
| `apps/simulator`  | Simulador web do canal de mensagens, com painel de rastreamento             |
| `packages/shared` | Logger estruturado com redação, correlação entre serviços e proteção de PII |
| `docs/`           | Regras de negócio, decisões, testes, segurança e operação                   |

## Requisitos

- Node.js 22.12+ e npm 10+
- Docker com Docker Compose

## Desenvolvimento

```bash
npm install
npm run check   # formatação, lint, tipos e testes
```

O andamento do desenvolvimento está em [`docs/roadmap.md`](docs/roadmap.md).
