# Observabilidade e logs

## Formato

Todos os serviços emitem **uma linha JSON por evento** (pino), em `stdout`, prontas para qualquer
coletor (Loki, CloudWatch, Datadog, ELK).

| Campo            | Descrição                                                                          |
| ---------------- | ---------------------------------------------------------------------------------- |
| `time`           | ISO 8601 (UTC)                                                                     |
| `level`          | `info`, `warn`, `error`, `fatal`                                                   |
| `service`        | `orders-api` ou `agent`                                                            |
| `event`          | Nome estável do evento (catálogo abaixo): é por ele que se filtra e se cria alerta |
| `correlationId`  | Id que acompanha a mensagem do cliente pelo agente **e** pela API de pedidos       |
| `conversationId` | Conversa no agente (id aleatório, sem relação com o telefone)                      |
| `customerRef`    | HMAC do id do cliente: correlaciona eventos sem expor o identificador real         |
| `msg`            | Descrição curta em português                                                       |
| demais           | Campos explícitos do evento (`orderId`, `reason`, `durationMs`, tokens…)           |

## O que nunca vai para os logs

Texto das mensagens do cliente e do agente, telefone, nome, e-mail, CPF, endereço, motivo do
cancelamento, chaves de API, conteúdo vindo do catálogo, prompt e `customerId` real. A regra
principal é **montar cada evento com campos explícitos e seguros**. A redação automática de
caminhos sensíveis e o serializador que remove `detail`/`where`/parâmetros dos erros do Postgres
são defesa em profundidade, para o caso de alguém logar um objeto inteiro por engano. Requisições
HTTP são logadas pelo **padrão da rota** (`/v1/customers/:customerId/orders/:orderId`), não pela
URL real. Há testes que conferem a ausência de PII nos logs (API-25, AG-30, SH-04).

## Catálogo de eventos

| Serviço    | Evento                                                                                      | Nível        | Quando                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| orders-api | `http.request`                                                                              | info         | Toda requisição (método, rota, status, duração, cliente da API)                                      |
| orders-api | `customer.lookup`                                                                           | info         | Identificação pelo telefone (só o resultado)                                                         |
| orders-api | `order.lookup` / `order.list`                                                               | info         | Consulta e listagem                                                                                  |
| orders-api | `order.cancellation.requested`                                                              | info         | Solicitação recebida                                                                                 |
| orders-api | `order.cancellation.succeeded`                                                              | info         | Pedido cancelado (`replayed` indica idempotência)                                                    |
| orders-api | `order.cancellation.rejected`                                                               | info         | Regra de negócio recusou (`reason`, `currentStatus`)                                                 |
| orders-api | `order.cancellation.not_found`                                                              | info         | Pedido inexistente ou de outro cliente                                                               |
| orders-api | `order.cancellation.idempotency_mismatch`                                                   | warn         | Chave reutilizada com outro corpo                                                                    |
| orders-api | `http.client_error`                                                                         | warn         | Requisição malformada (sem a mensagem, que pode conter a URL)                                        |
| orders-api | `http.error`                                                                                | error        | Erro técnico (`SERVICE_UNAVAILABLE` / `INTERNAL_ERROR`) com stack                                    |
| ambos      | `db.pool.idle_client_error`                                                                 | warn         | Banco derrubou uma conexão ociosa (recriada automaticamente)                                         |
| agent      | `agent.conversation_started` / `agent.conversation_rotated`                                 | info         | Nova conversa (com o status da identificação); conversa reiniciada após troca de prompt/modelo       |
| agent      | `agent.turn_completed`                                                                      | info         | Resumo do turno: caminho, origem da resposta, ferramentas, guardrails, custo, versão do prompt       |
| agent      | `llm.call`                                                                                  | info         | Cada chamada ao modelo: modelo, versão do prompt, parada, latência, tokens (inclusive cache)         |
| agent      | `agent.tool_call`                                                                           | info         | Ferramenta executada e resultado resumido                                                            |
| agent      | `agent.cancellation.confirmed` / `.completed` / `.rejected` / `.declined`                   | info         | Ciclo da confirmação                                                                                 |
| agent      | `agent.cancellation.outcome_unknown`                                                        | warn         | API falhou na execução: resultado incerto                                                            |
| agent      | `agent.handoff`                                                                             | info         | Encaminhamento (motivo e protocolo)                                                                  |
| agent      | `guardrail.input.injection_signals`                                                         | warn         | Padrões de manipulação na mensagem (só as categorias)                                                |
| agent      | `guardrail.output.blocked` / `.modified`                                                    | warn / info  | Resposta do modelo bloqueada ou ajustada, com os motivos                                             |
| agent      | `external.orders_api.request`                                                               | info         | Chamada à API de pedidos (operação, status, tentativas, duração)                                     |
| agent      | `external.fakestore.request`                                                                | info         | Chamada ao catálogo (resultado, tentativas, estado do circuito)                                      |
| agent      | `external.fakestore.retry` / `.circuit_state` / `.invalid_response` / `.suspicious_content` | warn         | Resiliência e conteúdo suspeito do catálogo                                                          |
| agent      | `agent.llm_unavailable` / `agent.llm_unexpected_stop` / `agent.max_iterations`              | error / warn | Falhas do modelo                                                                                     |
| agent      | `agent.llm_refusal`                                                                         | warn         | O modelo recusou a mensagem (`stop_reason: refusal`); o cliente recebe uma recusa educada            |
| agent      | `agent.turn_not_saved`                                                                      | error        | Falha ao gravar o turno: a confirmação criada nele é invalidada e a mensagem liberada para reentrega |
| agent      | `agent.conversation_too_long`                                                               | warn         | Histórico no limite (200 mensagens): a conversa é encerrada e recomeça                               |
| agent      | `channel.webhook.invalid_signature`                                                         | warn         | Webhook com assinatura inválida                                                                      |
| agent      | `agent.duplicate_message` / `agent.rate_limited`                                            | info / warn  | Reentrega de webhook; excesso de mensagens                                                           |

## Exemplos reais

Linhas extraídas da stack em execução (`docker compose logs`). As quatro primeiras têm o
**mesmo `correlationId`** (`ddd92117…`): uma mensagem do cliente acompanhada do modelo até a API
de pedidos.

```json
{"level":"info","time":"2026-11-05T21:43:29.311Z","service":"agent","correlationId":"ddd92117-5c3b-4a89-8aad-5faca8d8b4f0","conversationId":"69f284a4-0964-43e7-914b-dde8e0df86d5","event":"llm.call","model":"claude-haiku-5-5","promptVersion":"system-prompt@9e7a32bd8f","iteration":1,"stopReason":"tool_use","latencyMs":2,"inputTokens":667,"outputTokens":40,"cacheReadTokens":2400,"cacheWriteTokens":0,"msg":"chamada ao modelo"}
{"level":"info","time":"2026-11-05T21:43:29.314Z","service":"agent","correlationId":"ddd92117-5c3b-4a89-8aad-5faca8d8b4f0","conversationId":"69f284a4-0964-43e7-914b-dde8e0df86d5","event":"external.orders_api.request","operation":"order.get","method":"GET","status":200,"outcome":"response","attempts":1,"durationMs":3,"msg":"chamada à API de pedidos"}
{"level":"info","time":"2026-11-05T21:43:29.314Z","service":"orders-api","correlationId":"ddd92117-5c3b-4a89-8aad-5faca8d8b4f0","event":"http.request","method":"GET","route":"/v1/customers/:customerId/orders/:orderId","status":200,"durationMs":2,"client":"agent-service","msg":"requisição concluída"}
{"level":"info","time":"2026-11-05T21:43:29.316Z","service":"agent","correlationId":"ddd92117-5c3b-4a89-8aad-5faca8d8b4f0","conversationId":"69f284a4-0964-43e7-914b-dde8e0df86d5","event":"agent.tool_call","tool":"solicitar_cancelamento","outcome":"confirmacao_solicitada","durationMs":5,"msg":"ferramenta executada"}
{"level":"info","time":"2026-11-05T21:43:29.319Z","service":"agent","correlationId":"ddd92117-5c3b-4a89-8aad-5faca8d8b4f0","conversationId":"69f284a4-0964-43e7-914b-dde8e0df86d5","event":"agent.turn_completed","path":"llm","responseSource":"template:confirmCancellation","durationMs":13,"llmCalls":1,"toolCalls":["solicitar_cancelamento:confirmacao_solicitada"],"piiDetected":[],"injectionSignals":[],"costUsd":0.000111,"promptVersion":"system-prompt@9e7a32bd8f","msg":"turno concluído"}
```

Cancelamento confirmado e recusado na API de pedidos:

```json
{"level":"info","time":"2026-11-05T21:43:29.258Z","service":"orders-api","correlationId":"d2d26cb7-8292-4d41-b03b-c3c3d85db41e","event":"order.cancellation.requested","orderId":"100101","customerRef":"cus_4656362de736c4f7","actor":"agent-service","msg":"solicitação de cancelamento recebida"}
{"level":"info","time":"2026-11-05T21:43:29.264Z","service":"orders-api","correlationId":"d2d26cb7-8292-4d41-b03b-c3c3d85db41e","event":"order.cancellation.succeeded","orderId":"100101","customerRef":"cus_4656362de736c4f7","actor":"agent-service","replayed":false,"msg":"pedido cancelado"}
{"level":"info","time":"2026-11-05T21:43:28.748Z","service":"orders-api","correlationId":"51e899fc-1ca6-4660-86cc-bc3b98bfc439","event":"order.cancellation.rejected","orderId":"100201","customerRef":"cus_f0a915056e30ba63","actor":"agent-service","reason":"ALREADY_SHIPPED","currentStatus":"SHIPPED","replayed":false,"msg":"cancelamento recusado pela regra de negócio"}
```

Guardrails, resultado incerto, catálogo e canal:

```json
{"level":"warn","time":"2026-11-05T21:43:26.317Z","service":"agent","correlationId":"f64050b2-a9e4-4d84-98e2-c305b259cbdf","conversationId":"7d4c6638-0620-4ac7-8cb5-70b8b79f9b31","event":"guardrail.output.blocked","reasons":["prompt_leak"],"msg":"resposta do modelo bloqueada"}
{"level":"warn","time":"2026-11-05T21:43:29.109Z","service":"agent","correlationId":"2d62cc01-00e7-4e56-bb2d-0bbdfaccda92","conversationId":"6574de08-85ae-4302-9fa8-aba73b3e6bcc","event":"agent.cancellation.outcome_unknown","orderId":"100101","reason":"unavailable","msg":"resultado do cancelamento desconhecido"}
{"level":"warn","time":"2026-11-05T21:43:26.369Z","service":"agent","correlationId":"e0aa07e4-d0de-4965-9f16-37a6ddb66994","conversationId":"2be8c9d8-c81b-4b79-a851-6d9be101fbe3","event":"external.fakestore.suspicious_content","productId":7,"signals":["instruction_override","action_coercion"],"msg":"conteúdo do catálogo parece conter instruções; campos suspeitos foram descartados"}
{"level":"info","time":"2026-11-05T21:43:28.726Z","service":"agent","correlationId":"2f53768a-e43f-4e99-a6db-f8c303a5809c","conversationId":"21ff3a81-ad75-41db-8ff7-459d83888dbe","event":"external.fakestore.request","productId":14,"circuit":"closed","outcome":"found","attempts":1,"durationMs":1,"msg":"consulta ao catálogo externo"}
{"level":"warn","time":"2026-11-05T21:43:26.035Z","service":"agent","correlationId":"cbc6f65c-e894-401e-b2a6-dd10e806f909","event":"channel.webhook.invalid_signature","msg":"webhook com assinatura inválida"}
```

> Nos exemplos, o modelo é o stub determinístico dos testes E2E (latências de poucos ms). Com o
> modelo real, `latencyMs`, tokens e custo refletem as chamadas à API da Anthropic.

## Rastreamento por turno (trace)

Além dos logs, cada turno grava um **trace estruturado** no banco do agente (`turn_traces`), sem
dados pessoais:

- caminho de decisão (`llm`, `confirmation`, `deterministic`);
- resultado dos guardrails de entrada e saída;
- ferramentas chamadas, com argumentos não sensíveis e resultado;
- chamadas ao modelo, com latência, tokens, cache e custo estimado;
- versão do prompt.

O simulador mostra esse trace no painel **Bastidores do turno**, o que permite explicar, para
cada resposta, por que ela foi dada.

## Como consultar

```bash
docker compose logs -f agent orders-api                      # tudo
docker compose logs agent | grep '"event":"guardrail'         # guardrails acionados
docker compose logs | grep '"correlationId":"<id>"'           # uma mensagem, ponta a ponta
```

O correlation id volta no header `x-correlation-id` e no corpo dos erros da API. A plataforma de
mensagens (ou o cliente HTTP) pode enviá-lo, e o agente o propaga para a API de pedidos.
