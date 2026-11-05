# Decisões e limitações

## Decisões

Cada decisão registra o contexto, a escolha e o custo dela.

### D1. O modelo interpreta e conversa; o código decide e executa

**Contexto.** As regras 2 a 6 envolvem uma ação irreversível sobre o dinheiro do cliente. Um
modelo de linguagem é não determinístico e pode ser manipulado por texto.
**Decisão.** O modelo não tem capacidade de cancelar. Ele inicia o processo
(`solicitar_cancelamento`); a confirmação é interpretada por código; a API revalida e executa; o
resultado é comunicado por template.
**Custo.** Menos "naturalidade" em três mensagens (pergunta, sucesso e falha da execução), que
são fixas. É uma troca deliberada, porque essas três precisam ser exatas.

### D2. Agente com ferramentas dentro de um harness, sem framework e sem vários agentes

**Contexto.** Duas operações, um domínio estreito. A recomendação da Anthropic para esses casos
("Building effective agents") é começar pelo mais simples que resolva.
**Decisão.** Um único modelo com quatro ferramentas e um laço explícito (`runModel`, cerca de 150
linhas), sem LangChain/LangGraph, sem multiagente e sem RAG.
**Por quê.** Os pontos de controle que importam (encerrar o turno na confirmação, guardrail antes
de persistir, limite de iterações, transação do turno) ficam visíveis e testáveis. O SDK tem um
_tool runner_, mas o controle que este caso exige é mais fino que os ganchos dele.
**Custo.** Mais código próprio no laço, compensado por testes que validam cada requisição contra
as regras da API.

### D3. Claude Haiku 5.5 como modelo padrão

**Contexto.** Conversa por WhatsApp pede latência baixa; volume de atendimento pede custo baixo.
As garantias não dependem da capacidade do modelo.
**Decisão.** `claude-haiku-5-5` com `effort: low`, configurável por variável de ambiente.
**Validação.** A suíte de evals compara modelos em acerto, latência e custo
(`--models claude-haiku-5-5,claude-sonnet-5-5`). Se o Haiku falhar em cenários de red team ou de
condução da conversa, trocar o modelo é uma variável de ambiente. A configuração aceita só os
modelos que suportam tudo o que a requisição usa (mensagens de sistema no meio da conversa,
`effort`, ferramentas `strict`): `claude-haiku-5-5`, `claude-sonnet-5-5` e `claude-opus-5-5`. Um
modelo sem esse suporte (o `claude-sonnet-5`, por exemplo) teria toda chamada recusada.

### D4. Identidade vem do canal, e a API é escopada por cliente

**Contexto.** O enunciado não fala de autenticação, mas "proteger os dados do cliente" exige
saber **quem** pergunta. Sem isso, qualquer pessoa que digite um número de pedido veria dados de
outra (BOLA, primeiro item do OWASP API Top 10).
**Decisão.** A plataforma de mensagens verifica o telefone, o agente identifica o cliente por ele
e toda operação na API leva o `customerId`. Pedido alheio responde 404 igual ao inexistente.
**Custo.** Uma chamada a mais na primeira mensagem. A dúvida 10 (segundo fator) fica para o
negócio.

### D5. PostgreSQL para os dois serviços, sem Redis

**Contexto.** O cancelamento precisa de atomicidade, idempotência e auditoria; o agente precisa
de estado confiável (confirmações pendentes, histórico, dedup).
**Decisão.** Um banco por serviço, no mesmo PostgreSQL, com usuários separados (o agente não lê o
banco de pedidos). Cache do catálogo em memória.
**Por que não Redis.** Confirmações expiram por `expires_at`, a dedup é uma chave única e o cache
é pequeno. Redis seria mais um componente para operar sem um problema que o justifique. Ele
passa a fazer sentido com várias instâncias (lock por conversa, cache compartilhado), o que está
registrado como evolução.

### D6. Fake Store no agente, como camada anticorrupção

**Decisão.** O catálogo é consultado pelo agente, nunca pela API de pedidos. O preço do catálogo
é descartado. O conteúdo é tratado como dado não confiável.
**Por quê.** A API principal não depende de terceiros para cumprir as regras; a contradição de
preços é eliminada na origem; uma queda do catálogo só remove os nomes dos itens.

### D7. Resultado incerto é um estado próprio

**Contexto.** Timeout na chamada de cancelamento não significa que o cancelamento falhou.
**Decisão.** Estado `outcome_unknown`: o agente diz que não conseguiu **confirmar**, e a nova
tentativa reutiliza a mesma `Idempotency-Key`. Assim, a regra 6 é cumprida sem mentir em nenhuma
das duas direções.

### D8. Histórico só cresce e o prompt é estável

**Contexto.** O Haiku 5.5 devolve raciocínio assinado, que só vale se tudo antes dele for idêntico.
Além disso, o cache de prompt é por prefixo.
**Decisão.** Histórico guardado byte a byte e nunca editado. Estado dinâmico entra por mensagens
de sistema no meio da conversa. Canary derivado de segredo + versão, então o texto é o mesmo em
qualquer réplica. Troca de prompt ou modelo encerra a conversa.

### D9. Testes em camadas, com simulação na fronteira

**Decisão.** Unitários e integração com o modelo roteirizado (erra de propósito); E2E com a stack
real e stubs HTTP no lugar do modelo e da Fake Store; evals com o modelo real.
**Por quê.** Cada camada responde a uma pergunta diferente. "O código impõe as regras?" é
determinístico e roda no CI. "O modelo conduz bem a conversa?" é estatístico e precisa de
repetição (`pass^k`).

### D10. Revisão adversarial das partes críticas

A API, o núcleo do agente e o guardrail de saída foram revisados procurando, de propósito, um jeito
de quebrar as regras. Cada problema encontrado virou um commit `fix(...)` com um teste que o
reproduz. Exemplos: um "sim" respondendo outra pergunta confirmava um cancelamento antigo (AG-14);
o canary aleatório quebraria o histórico após um reinício (AG-33); conexões derrubadas pelo banco
encerravam o processo (API-28); depois de listar os pedidos, "seu pedido foi cancelado" sem número
passava pelo guardrail (AG-17).

## Limitações

| Limitação                                                     | Impacto                                                                                                                                        | Caminho                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A suíte de evals ainda não foi executada contra o modelo real | Os números de acerto do modelo real não estão registrados                                                                                      | `npm run eval` com `ANTHROPIC_API_KEY` (veja `08-exemplos-de-conversa.md`)   |
| Fila por conversa em memória                                  | Com várias instâncias, mensagens simultâneas da mesma conversa podem ser processadas em paralelo. A execução do cancelamento continua atômica. | `pg_advisory_lock` por conversa ou fila particionada                         |
| Webhook síncrono                                              | Plataformas reais esperam 200 rápido e resposta por API de envio                                                                               | Responder 200 de imediato e processar numa fila (com o mesmo `AgentService`) |
| Detecção de afirmações e de manipulação por regras            | Paráfrases criativas podem escapar; frases genéricas podem ser bloqueadas                                                                      | Evals para calibrar; classificador dedicado como sinal adicional             |
| Identidade só pelo telefone                                   | Telefone compartilhado vê os pedidos daquele cadastro                                                                                          | Segundo fator para ações sensíveis (dúvida 10)                               |
| Sem política de retenção de conversas e traces                | Dados ficam até serem apagados manualmente                                                                                                     | Expurgo agendado conforme a política definida (dúvida 12)                    |
| Atendimento humano simulado                                   | O protocolo não chega a uma fila real                                                                                                          | Integração com a ferramenta de atendimento (Zendesk, Intercom…)              |
| Catálogo em inglês                                            | Nomes de produtos aparecem em inglês                                                                                                           | Catálogo localizado (fora do alcance da Fake Store)                          |
| Migrations rodam na inicialização                             | Adequado a uma instância; arriscado com várias                                                                                                 | Job de migração separado no deploy                                           |
| Métricas e tracing distribuído                                | Há logs estruturados com correlation id e traces por turno, mas não há OpenTelemetry nem dashboards                                            | Exportar spans OTel (o SDK da Anthropic suporta) e métricas por evento       |
