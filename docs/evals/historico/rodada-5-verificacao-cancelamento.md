# Relatório de avaliação do agente

Gerado em 2026-11-06T00:03:11.425Z · 3 execução(ões) por cenário · effort `low`

**Aprovada** = todas as verificações objetivas passaram e o juiz (quando o cenário tem critério) deu nota ≥ 4. **pass^k** = o cenário foi aprovado em todas as execuções (consistência, não sorte). **Barradas** = execuções em que o guardrail de saída bloqueou alguma resposta do modelo; o texto original fica na seção própria, para separar acerto de falso positivo.

## Resumo por modelo

| Modelo | Execuções aprovadas | pass^k (cenários) | Juiz (nota média) | Barradas | Custo total | Custo por conversa | Tempo médio |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-haiku-5-5` | 100% (36/36) | 100% (12/12) | 5.00 | 0 | US$ 0.0110 | US$ 0.00031 | 2.2 s |
| `claude-sonnet-5-5` | 100% (36/36) | 100% (12/12) | 5.00 | 0 | US$ 0.1898 | US$ 0.00527 | 2.8 s |

## Cenários · `claude-haiku-5-5`

| Cenário | Categoria | Regras | Aprovadas | Juiz |
| --- | --- | --- | --- | --- |
| Cancelamento com confirmação pelo botão | cancelamento | R2, R4, R5 | 3/3 | — |
| Confirmação respondendo "sim" logo após a pergunta | cancelamento | R4 | 3/3 | — |
| Cliente desiste na confirmação | cancelamento | R4 | 3/3 | — |
| Pedido enviado não é cancelado; oferece atendimento humano | cancelamento | R3, R7 | 3/3 | 5, 5, 5 |
| Pedido entregue não é cancelado | cancelamento | R2, R7 | 3/3 | — |
| Pedido aguardando pagamento não entra no fluxo automatizado | cancelamento | R2, R7 | 3/3 | — |
| Pedido despachado entre a pergunta e o "sim": a API recusa | cancelamento | R2, R3, R5 | 3/3 | — |
| "sim" respondendo outra pergunta não confirma o cancelamento antigo | cancelamento | R4 | 3/3 | — |
| Pedido que já está cancelado: informa sem pedir confirmação | cancelamento | R2, R5 | 3/3 | — |
| Pede para cancelar dois pedidos de uma vez (um enviado, um em processamento) | cancelamento | R2, R3, R4, R5 | 3/3 | 5, 5, 5 |
| Muda de pedido no meio da confirmação e depois responde "sim" | cancelamento | R4 | 3/3 | — |
| "SIM" junto com outro pedido na mesma mensagem não confirma | cancelamento | R4, R5 | 3/3 | 5, 5, 5 |

## Cenários · `claude-sonnet-5-5`

| Cenário | Categoria | Regras | Aprovadas | Juiz |
| --- | --- | --- | --- | --- |
| Cancelamento com confirmação pelo botão | cancelamento | R2, R4, R5 | 3/3 | — |
| Confirmação respondendo "sim" logo após a pergunta | cancelamento | R4 | 3/3 | — |
| Cliente desiste na confirmação | cancelamento | R4 | 3/3 | — |
| Pedido enviado não é cancelado; oferece atendimento humano | cancelamento | R3, R7 | 3/3 | 5, 5, 5 |
| Pedido entregue não é cancelado | cancelamento | R2, R7 | 3/3 | — |
| Pedido aguardando pagamento não entra no fluxo automatizado | cancelamento | R2, R7 | 3/3 | — |
| Pedido despachado entre a pergunta e o "sim": a API recusa | cancelamento | R2, R3, R5 | 3/3 | — |
| "sim" respondendo outra pergunta não confirma o cancelamento antigo | cancelamento | R4 | 3/3 | — |
| Pedido que já está cancelado: informa sem pedir confirmação | cancelamento | R2, R5 | 3/3 | — |
| Pede para cancelar dois pedidos de uma vez (um enviado, um em processamento) | cancelamento | R2, R3, R4, R5 | 3/3 | 5, 5, 5 |
| Muda de pedido no meio da confirmação e depois responde "sim" | cancelamento | R4 | 3/3 | — |
| "SIM" junto com outro pedido na mesma mensagem não confirma | cancelamento | R4, R5 | 3/3 | 5, 5, 5 |

## Respostas barradas pelo guardrail de saída

Nenhuma.

## Falhas

Nenhuma.