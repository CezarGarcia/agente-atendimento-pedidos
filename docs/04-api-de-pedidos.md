# API principal de pedidos

Node.js 22, TypeScript, Express 5, PostgreSQL 17 (Kysely) e Zod. É a **fonte da verdade** do
status dos pedidos e das regras de cancelamento. O agente consulta e solicita; quem decide é ela.

- Swagger UI: <http://localhost:3001/docs>. Use **Authorize** com a chave de desenvolvimento
  `dev-swagger-key-change-me`.
- OpenAPI 3.1: <http://localhost:3001/openapi.json> (cópia em [`api/openapi.json`](api/openapi.json))

O documento OpenAPI é **gerado dos mesmos schemas Zod que validam as requisições**, então
documentação e código não divergem.

## Endpoints

| Método e rota                                                   | Descrição                                   | Respostas                                        |
| --------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `POST /v1/customers/lookup`                                     | Identifica o cliente pelo telefone do canal | 200, 400, 401, 404, 429, 5xx                     |
| `GET /v1/customers/{customerId}/orders?limit=5`                 | Lista os pedidos recentes                   | 200, 400, 401, 429, 5xx                          |
| `GET /v1/customers/{customerId}/orders/{orderId}`               | Consulta um pedido                          | 200, 400, 401, 404, 429, 5xx                     |
| `POST /v1/customers/{customerId}/orders/{orderId}/cancellation` | Solicita o cancelamento (`Idempotency-Key`) | 200, 400, 401, 404, 409, 413, 415, 422, 429, 5xx |
| `GET /health/live`, `GET /health/ready`                         | Liveness e readiness (banco)                | 200, 503                                         |

Com `DEMO_MODE` (somente local), existem também `POST /internal/demo/reset` e
`POST /internal/demo/orders/{orderId}/ship`, usadas pelo simulador para recriar os dados e
simular o despacho de um pedido.

**Por que o cliente está no caminho.** Toda operação é escopada por cliente: a API nunca busca um
pedido "solto". Um pedido de outro cliente responde **404 idêntico** ao de um pedido inexistente,
para não revelar que ele existe (proteção contra BOLA/IDOR). O `customerId` vem da identificação
pelo telefone verificado pelo canal, nunca do que o cliente digita.

## Resultados distinguíveis

Todos os erros seguem a RFC 9457 (`application/problem+json`) com um `code` estável. O agente
decide o que dizer a partir do `code`, nunca do texto.

| Resultado             | HTTP            | `code`                                                                                        | Exemplo                                                   |
| --------------------- | --------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Sucesso               | 200             | —                                                                                             | `{ "order": { "status": "CANCELLED", … } }`               |
| Pedido não encontrado | 404             | `ORDER_NOT_FOUND`                                                                             | Inexistente ou de outro cliente                           |
| Pedido não cancelável | 409             | `ORDER_NOT_CANCELLABLE`                                                                       | `"currentStatus": "SHIPPED", "reason": "ALREADY_SHIPPED"` |
| Entrada inválida      | 400 / 413 / 415 | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | `errors: [{ path, message }]`                             |
| Erro técnico          | 500 / 503       | `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`                                                       | 503 traz `Retry-After`; nenhum detalhe interno exposto    |

```json
{
  "type": "/problems/order-not-cancellable",
  "title": "Pedido não pode ser cancelado",
  "status": 409,
  "code": "ORDER_NOT_CANCELLABLE",
  "detail": "O pedido já foi enviado e não pode ser cancelado pelo fluxo automatizado.",
  "instance": "/v1/customers/11111111-1111-4111-8111-111111111111/orders/100102/cancellation",
  "correlationId": "73ba7bb6-9e9a-409b-ac85-d3ba6267bcd8",
  "orderId": "100102",
  "currentStatus": "SHIPPED",
  "reason": "ALREADY_SHIPPED"
}
```

## Garantias do cancelamento

1. **A regra fica no domínio.** O mapa de elegibilidade é exaustivo por tipo
   (`Record<OrderStatus, …>`). Um status novo não compila sem que alguém decida se ele é
   cancelável, e em tempo de execução qualquer status desconhecido é negado.
2. **Sem corrida.** Verificação e mudança de status acontecem na mesma transação, com
   `SELECT … FOR UPDATE`. Em teste, 10 requisições simultâneas resultam em exatamente 1 sucesso.
   O lock tem `lock_timeout` de 3 s: em vez de segurar a conexão, a API responde 503.
3. **Idempotência.** `Idempotency-Key` é obrigatória e vale 24 h. Repetir a mesma chave com o
   mesmo corpo devolve a resposta original (`Idempotent-Replayed: true`) sem executar de novo; com
   outro corpo, 422. A concorrência com a mesma chave é serializada pela unicidade no banco. O
   agente usa como chave o id da ação pendente, então o retry após um timeout é seguro.
4. **Auditoria.** Toda transição de status vai para `order_status_history` com o ator (nome da
   chave de API, ex.: `agent-service`), o motivo (com dados pessoais mascarados), o horário e o
   correlation id.
5. **Integridade no banco.** `CHECK`, `FOREIGN KEY` e `UNIQUE` repetem as invariantes do domínio.

## Segurança e operação

- Autenticação serviço-a-serviço por chave nomeada (`cliente:segredo`), comparada em tempo
  constante. Várias chaves permitem rotação sem indisponibilidade. Segredos de desenvolvimento são
  recusados em produção.
- Rate limit após a autenticação, por cliente da API **e** por cliente final.
- `helmet`, corpo limitado a 16 KB, corpo não-JSON recusado (415), objetos de entrada estritos
  (campos desconhecidos são rejeitados).
- Falhas do banco: o listener de erro do pool evita que uma conexão derrubada encerre o processo,
  e falhas transitórias respondem 503 (que pode ser repetido).
- Migrations e seed na inicialização (adequado ao ambiente local; em produção seria um job
  separado).
- Imagem Docker multi-stage, só com dependências de produção, usuário não-root e healthcheck.

## Dados de demonstração

| Cliente      | Telefone         | Pedidos                                                                       |
| ------------ | ---------------- | ----------------------------------------------------------------------------- |
| Ana Souza    | `+5551990000001` | 100101 em processamento · 100102 enviado (rastreio) · 100103 entregue         |
| Bruno Lima   | `+5551990000002` | 100201 em processamento · 100202 cancelado                                    |
| Carla Mendes | `+5551990000003` | 100301 aguardando pagamento · 100302 em processamento (item fora do catálogo) |
| Diego Rocha  | `+5551990000004` | nenhum                                                                        |

Os `customerId` são fixos (`11111111-1111-4111-8111-111111111111` para a Ana, `2222…` para o
Bruno, e assim por diante), o que facilita testar pelo Swagger.

## Exemplos com curl

```bash
KEY=dev-swagger-key-change-me
ANA=11111111-1111-4111-8111-111111111111

curl -s localhost:3001/v1/customers/$ANA/orders/100101 -H "x-api-key: $KEY"

curl -s -X POST localhost:3001/v1/customers/$ANA/orders/100101/cancellation \
  -H "x-api-key: $KEY" -H "idempotency-key: teste-$(date +%s)" \
  -H 'content-type: application/json' -d '{"reason":"comprei errado"}'
```
