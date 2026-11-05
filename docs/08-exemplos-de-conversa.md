# Exemplos de conversa

## 1. Mensagens determinísticas (texto exato do sistema)

Nos momentos críticos, o texto **não** é escrito pelo modelo: vem de templates preenchidos com a
resposta da API. As mensagens abaixo foram capturadas da stack em execução e são idênticas com
qualquer modelo.

### Cancelamento confirmado

> **Cliente:** Quero cancelar o pedido 100101
>
> **Agente:** Só para confirmar: você quer **cancelar o pedido 100101** ("Fjallraven - Foldsack
> No. 1 Backpack" e mais 1 item, total R$ 829,80)? Essa ação não pode ser desfeita.
>
> Responda **SIM** para cancelar ou **NÃO** para manter o pedido.
>
> `[ Sim, cancelar ]` `[ Não, manter ]`
>
> **Cliente:** _(toca em "Sim, cancelar")_
>
> **Agente:** Pronto! O pedido **100101** foi cancelado. ✅ Se houve pagamento, a devolução do
> valor segue a política da loja; um atendente pode te dar detalhes, se precisar. Posso ajudar em
> algo mais?

A pergunta foi enviada pelo sistema depois que o modelo chamou `solicitar_cancelamento`. A
confirmação foi interpretada por código, sem chamar o modelo. A mensagem de sucesso só existe
porque a API respondeu 200 com o pedido `CANCELLED`.

### Pedido despachado entre a pergunta e o "sim"

> **Cliente:** Quero cancelar o pedido 100201
>
> **Agente:** _(pergunta de confirmação)_
>
> _(nesse meio-tempo, a loja despacha o pedido)_
>
> **Cliente:** sim
>
> **Agente:** Não consegui cancelar o pedido **100201**: o pedido já foi enviado, então ele não
> pode mais ser cancelado por aqui. Se quiser, posso te encaminhar para um atendente.

A API revalidou a regra no momento da execução e respondeu 409 `ALREADY_SHIPPED`.

### Falha técnica na hora de executar (resultado incerto)

> **Cliente:** sim
>
> **Agente:** Tive uma instabilidade e **não consegui confirmar** se o cancelamento do pedido
> 100101 foi concluído. Posso tentar de novo com segurança: não existe risco de cancelar duas
> vezes. Quer que eu tente novamente?
>
> `[ Tentar novamente ]` `[ Agora não ]`
>
> **Cliente:** sim
>
> **Agente:** Pronto! O pedido **100101** foi cancelado. ✅ …

A nova tentativa usa a **mesma** `Idempotency-Key`. Se a primeira chamada tivesse cancelado e só
a resposta tivesse se perdido, a API devolveria o resultado original sem cancelar de novo.

### Desistência

> **Cliente:** não
>
> **Agente:** Combinado, o pedido **100201** continua ativo. Posso ajudar em algo mais?

### Conversa encaminhada para atendimento humano

> **Cliente:** oi?
>
> **Agente:** Sua conversa já foi encaminhada para um atendente (protocolo **ATD-990955**). Em
> breve alguém da equipe continua o atendimento por aqui.

### Resposta do modelo bloqueada pelo guardrail

Quando o modelo afirma algo que a API não confirmou (por exemplo, "seu pedido foi cancelado"
sem cancelamento), o cliente recebe:

> **Agente:** Desculpe, não consegui concluir minha resposta com segurança. Pode reformular sua
> pergunta? Se preferir, posso te encaminhar para um atendente.

## 2. Conversas com o modelo real

As conversas conduzidas pelo modelo são geradas pela suíte de avaliação, a partir de cenários
reais (consulta, cancelamento, escopo, falhas e red team), com o relatório de acertos:

```bash
ANTHROPIC_API_KEY=... npm run eval -- --runs 3 --judge claude-sonnet-5-5 --transcripts \
  --out docs/evals
```

O comando grava em `docs/evals/` o relatório (`relatorio-*.md`), os resultados (`resultados-*.json`)
e as transcrições (`conversas-*.md`).

> **Pendente:** a execução com o modelo real requer `ANTHROPIC_API_KEY` e ainda não foi feita. O
> harness foi validado de ponta a ponta contra o stub determinístico (31 cenários executados,
> verificações e relatório gerados).

Para experimentar à mão, use o simulador (<http://localhost:3002>) com `ANTHROPIC_API_KEY` no
`.env`. As sugestões de mensagem de cada cliente simulado cobrem os casos principais, inclusive
tentativas de manipulação.
