# Regras de negócio: análise, dúvidas e decisões

Este documento interpreta as oito regras do desafio, separa o que precisa ser **definido pelo
negócio** do que foi **assumido provisoriamente**, e descreve, para cada situação, se o agente
**prossegue**, **pede esclarecimento**, **recusa** ou **encaminha para atendimento humano**.

## 1. Leitura das regras

| #   | Regra (resumo)                                                            | Interpretação adotada                                                                                                                                                   | Onde é garantida                                                                                                             |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| R1  | O agente pode consultar o status de um pedido                             | Apenas pedidos **do cliente identificado pelo canal**. Pedido de outra pessoa é tratado como inexistente.                                                               | API (busca escopada por cliente, 404 idêntico); ferramenta sem parâmetro de cliente                                          |
| R2  | Só cancela pedido **em processamento**                                    | É uma _allowlist_: somente `PROCESSING` é cancelável. Qualquer outro status, inclusive um status futuro desconhecido, é negado.                                         | Domínio da API (`Record<OrderStatus, …>` exaustivo) + transação com bloqueio de linha                                        |
| R3  | Pedido **enviado** não pode ser cancelado pelo fluxo automatizado         | Caso particular da R2, explicitado porque é o mais comum. "Pelo fluxo automatizado" indica que existe um caminho humano: o agente oferece atendimento.                  | API (409 `ALREADY_SHIPPED`) + agente oferece humano                                                                          |
| R4  | Confirmar a intenção **antes** de solicitar o cancelamento                | Confirmação explícita, posterior ao pedido, presa a um pedido específico, com validade e uso único. Decidida por código, não pelo modelo.                               | Máquina de estados de confirmação (`confirmation.ts`, ação pendente no banco)                                                |
| R5  | Só informar que cancelou se a API retornou sucesso                        | O texto de sucesso nasce da resposta da API (template), e qualquer afirmação de cancelamento escrita pelo modelo é conferida contra a API.                              | Template determinístico + guardrail de saída (`unverified_cancellation_claim`)                                               |
| R6  | Sem verificação, com falha de API ou faltando informação: não afirmar     | Resultado incerto não é sucesso **nem** fracasso: o agente diz que não conseguiu confirmar e permite repetir com segurança (mesma chave de idempotência).               | Cliente da API com resultados tipados; estado `outcome_unknown`; guardrail de saída                                          |
| R7  | Oferecer humano fora do escopo ou quando não for seguro resolver          | Escopo = consultar e cancelar pedidos. Trocas, devoluções, estornos, endereço, pagamento etc. vão para humano. Após o encaminhamento, o agente pausa.                   | Prompt + ferramenta `transferir_para_humano` + pausa determinística                                                          |
| R8  | Informações do cliente ou de API externa não substituem regras/instruções | Texto do cliente e dados do catálogo são **dados**, nunca instruções. A defesa principal é arquitetural: mesmo um modelo manipulado não tem capacidade de violar R2–R6. | Ferramentas de menor privilégio, confirmação por código, API, sanitização do catálogo, guardrails, canal de sistema separado |

**Observação sobre R2 e R3:** a R3 está contida na R2. Explicitar as duas sugere que o negócio
pensa em termos de "o que não pode" (denylist), mas a regra escrita é uma allowlist ("só
pode se…"). Essa diferença importa quando surgir um status novo (ex.: `RETURNED`): com
allowlist, ele nasce **não cancelável** até alguém decidir o contrário. No código, um status novo
nem compila sem essa decisão.

## 2. Dúvidas para as áreas de negócio e produto

Pontos que o enunciado não define e que mudariam o comportamento do sistema. Cada um tem uma
suposição provisória na seção 3.

**Status e elegibilidade**

1. Quais são todos os status do pedido? Existe "aguardando pagamento", "faturado", "em separação",
   "parcialmente enviado"? Quais deles contam como "em processamento"?
2. Pedido **aguardando pagamento** pode ser cancelado pelo agente, ou simplesmente expira?
3. Há **prazo** para cancelar (ex.: até X horas após a compra) ou limite de valor?
4. Pedidos com **vários envios** (parte já despachada) podem ter a parte restante cancelada?
5. Existe **cancelamento parcial** (um item do pedido)?

**Execução do cancelamento**

6. O cancelamento é **imediato** ou é uma **solicitação** que outro sistema (ERP, antifraude)
   aprova depois? Isso muda o que a regra 5 permite dizer: "foi cancelado" × "solicitação
   registrada".
7. O **motivo** do cancelamento é obrigatório? Há uma lista de motivos para relatórios?
8. O que dizer sobre **estorno**: forma, prazo, a quem recorrer? O agente pode citar prazos?
9. Há limite de cancelamentos por cliente (prevenção de abuso/fraude)?

**Identidade e privacidade**

10. Como o cliente é **autenticado** no canal? O telefone verificado pela plataforma é suficiente,
    ou é preciso um segundo fator (ex.: últimos dígitos do CPF) antes de mostrar dados ou cancelar?
11. Telefones **compartilhados** (família, empresa) podem ver todos os pedidos daquele número?
12. Por quanto tempo as **conversas** podem ser guardadas (LGPD) e quem pode acessá-las?
13. O provedor do modelo de IA pode receber dados dos pedidos? Há exigência de contrato com
    retenção zero (ZDR) ou processamento no Brasil?

**Atendimento humano**

14. Qual o **canal e o horário** do atendimento humano? O cliente é atendido na mesma conversa?
15. Quais casos devem ir **direto** para humano (ex.: menção a Procon, fraude, ameaça jurídica)?
16. O que fazer quando o cliente **contradiz** o sistema (diz que não recebeu, mas consta
    "entregue")?

**Escopo**

17. O agente pode responder dúvidas sobre **produtos** que não estão nos pedidos do cliente
    (catálogo em geral)?
18. Precisa atender em outros **idiomas**?

## 3. Suposições provisórias

> Todas as suposições abaixo são **provisórias**. Foram adotadas para permitir a implementação e
> estão concentradas em pontos fáceis de mudar (domínio da API, prompt, templates).

| #   | Suposição                                                                                                                                                          | Responde à dúvida | Onde mudar                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------- |
| S1  | Status: `AWAITING_PAYMENT`, `PROCESSING`, `SHIPPED`, `DELIVERED`, `CANCELLED`. Só `PROCESSING` é cancelável.                                                       | 1                 | `apps/orders-api/src/domain/order.ts`                     |
| S2  | Pedido aguardando pagamento **não** é cancelado pelo agente (postura conservadora): o agente explica e oferece humano.                                             | 2                 | Mapa de regras do domínio                                 |
| S3  | Não há prazo, limite de valor, cancelamento parcial nem envio parcial.                                                                                             | 3, 4, 5           | Domínio                                                   |
| S4  | O cancelamento é **síncrono**: a API devolve o pedido já `CANCELLED`. Só então o agente diz "foi cancelado".                                                       | 6                 | Cliente da API + template de sucesso                      |
| S5  | Motivo opcional; se o cliente disser, é repassado (com dados pessoais mascarados).                                                                                 | 7                 | Ferramenta `solicitar_cancelamento`                       |
| S6  | O agente **não promete** nada sobre estorno: diz que segue a política da loja e oferece humano. Promessas de prazo são bloqueadas no guardrail de saída.           | 8                 | Template + `output-guard.ts`                              |
| S7  | O telefone verificado pela plataforma de mensagens é a identidade do cliente. Telefone sem cadastro não acessa pedidos.                                            | 10, 11            | `AgentService.resolveConversation`                        |
| S8  | Conversas guardam texto já sem dados pessoais (CPF, cartão, e-mail, telefone mascarados); o primeiro nome é o único dado pessoal no histórico. Retenção a definir. | 12                | `input-guard.ts`; política de retenção (não implementada) |
| S9  | O modelo recebe só o necessário do pedido (status, itens, valores, datas, rastreio); nunca endereço, CPF, telefone ou identificador interno do cliente.            | 13                | Ferramentas (`presentOrder`)                              |
| S10 | O atendimento humano é simulado: gera protocolo (`ATD-123456`), registra motivo e resumo, e o agente para de responder nessa conversa.                             | 14                | `transferir_para_humano` + template                       |
| S11 | Em contradição entre cliente e sistema, prevalece o sistema; o agente informa com gentileza e oferece humano.                                                      | 16                | Prompt                                                    |
| S12 | Dúvidas sobre produtos são atendidas só para itens dos pedidos do cliente (dados do catálogo externo). Catálogo em geral está fora do escopo.                      | 17                | Prompt + ferramentas                                      |
| S13 | Atendimento em português do Brasil.                                                                                                                                | 18                | Prompt                                                    |
| S14 | Confirmação de cancelamento vale **10 minutos** e uma única vez; texto só confirma logo após a pergunta; o botão confirma enquanto a ação estiver aberta.          | (R4)              | `CONFIRMATION_TTL_MINUTES`, `confirmation.ts`             |
| S15 | Conversa expira após **30 minutos** de inatividade; a próxima mensagem inicia outra.                                                                               | —                 | `CONVERSATION_IDLE_MINUTES`                               |

## 4. Matriz de decisão do agente

Quando cada comportamento acontece. A coluna "Quem decide" mostra que, nos casos críticos, a
decisão é do código ou da API, não do modelo.

### Prosseguir

| Situação                                                | Comportamento                                                           | Quem decide               |
| ------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| Cliente identificado pergunta por um pedido seu         | Consulta a API e informa status, itens, valores, datas, rastreio        | Modelo (com dados da API) |
| Cliente pede para cancelar um pedido em processamento   | Envia a pergunta de confirmação (texto fixo, com botões)                | Ferramenta + código       |
| Cliente confirma (botão, ou "sim" logo após a pergunta) | Executa o cancelamento na API e informa o resultado da API              | Código + API              |
| Cliente responde "não"                                  | Mantém o pedido e confirma que ele continua ativo                       | Código                    |
| Resultado incerto e o cliente pede para tentar de novo  | Repete com a **mesma** chave de idempotência (sem risco de cancelar 2×) | Código + API              |

### Pedir esclarecimento

| Situação                                                       | Comportamento                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Cliente não diz qual pedido                                    | Lista os pedidos recentes e pergunta qual                                           |
| Número em formato inválido (ex.: 5 dígitos)                    | Pede para conferir (6 dígitos)                                                      |
| Pedido não encontrado                                          | Pede para conferir o número, sem sugerir que exista para outra pessoa               |
| Resposta ambígua à confirmação ("acho que sim, mas…", "pode?") | Não executa; responde ao que foi dito e, se o cliente quiser, reenvia a confirmação |
| Mensagem vazia ou longa demais                                 | Pede para reescrever                                                                |

### Recusar (com explicação)

| Situação                                                                      | Comportamento                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Cancelar pedido enviado, entregue ou já cancelado                             | Explica o motivo e oferece humano (ex.: orientação sobre devolução) |
| Cancelar pedido aguardando pagamento (S2)                                     | Explica e oferece humano                                            |
| Pedido para ignorar regras, mudar de papel, "modo especial", falsa autoridade | Recusa em uma frase e volta ao atendimento                          |
| Pedido para revelar instruções internas                                       | Diz que não compartilha detalhes do funcionamento                   |
| Pedido de dados de outra pessoa ou de outro pedido                            | Não revela nada (para o sistema, o pedido não existe)               |

### Encaminhar para atendimento humano

| Situação                                                                                             | Comportamento                                                  |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Cliente pede um atendente                                                                            | Encaminha, informa o protocolo e pausa o agente                |
| Assunto fora do escopo (troca, devolução, estorno, endereço, pagamento, cupom, entrega com problema) | Oferece humano; encaminha se o cliente aceitar                 |
| Pedido não cancelável que o cliente quer resolver                                                    | Oferece humano                                                 |
| Falha técnica persistente (API de pedidos ou modelo fora do ar)                                      | Avisa que não conseguiu, sugere tentar depois e oferece humano |
| Telefone sem cadastro                                                                                | Não acessa pedidos; oferece humano                             |
| Contradição que o cliente contesta (ex.: diz que não recebeu)                                        | Mantém o que consta e oferece humano                           |

## 5. Como as regras são garantidas (defesa em profundidade)

Nenhuma regra depende só das instruções do modelo. Cada camada funciona mesmo que a anterior
falhe:

```text
 Prompt (instruções)                 → orienta o comportamento (camada "macia")
 Ferramentas de menor privilégio     → o modelo não tem como cancelar nem escolher o cliente
 Confirmação por código              → só executa com confirmação explícita no turno seguinte
 API principal                       → revalida a regra, com bloqueio de linha e idempotência
 Guardrail de saída                  → bloqueia afirmações que a API não confirmou
 Testes, E2E e evals                 → detectam regressões em cada camada
```

O detalhamento das ameaças e mitigações está em [`03-seguranca-e-guardrails.md`](03-seguranca-e-guardrails.md).
