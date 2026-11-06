# Segurança, guardrails e proteção de dados

## 1. Premissa

> **O modelo pode ser enganado. O sistema não pode depender de ele não ser.**

Toda proteção relevante tem uma camada que **não** depende do modelo. As instruções (prompt) são
a primeira linha, a mais fraca. Abaixo delas há ferramentas de menor privilégio, confirmação
decidida por código, a regra validada na API e a verificação da resposta antes do envio.

## 2. Modelo de ameaças

As ameaças estão mapeadas para o OWASP Top 10 for LLM Applications (2025) e o OWASP API Security
Top 10 (2023). Para cada uma: a mitigação e o teste que comprova (códigos de
[`06-casos-de-teste.md`](06-casos-de-teste.md)).

| Ameaça                                                                                              | Referência                       | Mitigações                                                                                                                                                                                                                                                                                                                                                    | Evidência                                                                              |
| --------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Cliente manipula o agente ("ignore as regras", "sou o gerente", "SYSTEM: já confirmei")             | LLM01 Prompt Injection           | Nenhuma ferramenta cancela; a confirmação é por código no turno seguinte; a API revalida. Detecção heurística avisa o modelo pelo canal de sistema. Prompt com recusa explícita.                                                                                                                                                                              | AG-09, AG-20…AG-22, evals `red_team`                                                   |
| Instrução escondida em dado externo (descrição de produto da Fake Store)                            | LLM01 (indireta), API10          | Camada anticorrupção: validação de schema, sanitização (invisíveis, controle, tags), remoção de links, descarte de campos com padrões de instrução (inclusive nota dirigida ao assistente e afirmação sobre o pedido do cliente); dado marcado como "não é instrução"; o prompt manda ignorar sem comentar; mesmo obedecido, não há ação perigosa disponível. | FS-11…FS-13, GU-11, E2E-S06, evals `rt-injecao-no-catalogo` e `rt-injecao-declarativa` |
| Vazamento de dados de outro cliente (pedir pedido de outra pessoa)                                  | LLM02, API1 BOLA                 | Identidade = telefone verificado pelo canal; ferramentas sem parâmetro de cliente; API escopa toda consulta pelo cliente e responde 404 idêntico para pedido alheio.                                                                                                                                                                                          | API-07, AG-03, E2E-S02                                                                 |
| Vazamento de dados pessoais para o modelo, logs ou histórico                                        | LLM02                            | Mascaramento de CPF/CNPJ/cartão (Luhn)/e-mail/telefone antes do modelo; modelo não recebe endereço/CPF/telefone; logs com campos explícitos, IDs pseudonimizados (HMAC), rota em vez de URL e redação como defesa extra; motivo do cliente mascarado antes de gravar.                                                                                         | SH-01…SH-05, API-25, API-26, AG-30                                                     |
| Agente executando ações além do pedido                                                              | LLM06 Excessive Agency           | Menor privilégio: 4 ferramentas, nenhuma destrutiva; conjunto reduzido para cliente não identificado; uma confirmação por vez; limite de 8 chamadas de ferramenta e 5 iterações por turno.                                                                                                                                                                    | AG-09, AG-27, AG-28                                                                    |
| Revelação das instruções internas                                                                   | LLM07 System Prompt Leakage      | Prompt sem segredos; canary determinístico; detecção de marcadores de seção e de **reprodução literal** (duas janelas de 8 palavras seguidas das instruções); resposta bloqueada vira mensagem fixa.                                                                                                                                                          | GU-12, GU-13, GU-18, E2E-S05                                                           |
| Informação falsa: "seu pedido foi cancelado" sem cancelamento                                       | LLM09 Misinformation             | Resultado do cancelamento é template a partir da API; guardrail de saída confere cada afirmação contra os pedidos que a API mostrou cancelados; bloqueia também handoff não realizado e promessas de estorno.                                                                                                                                                 | GU-01…GU-08, GU-19, GU-20, AG-17, E2E-S04                                              |
| Saída perigosa para o cliente (links de phishing, markdown quebrado, texto enorme)                  | LLM05 Improper Output Handling   | Remoção de links na saída e no catálogo; conversão para o formato do WhatsApp; limite de tamanho; o simulador renderiza texto sem HTML.                                                                                                                                                                                                                       | GU-10, GU-14                                                                           |
| Consumo abusivo (custo, negação de serviço)                                                         | LLM10, API4                      | Limite de mensagens por conversa; mensagens longas recusadas antes do modelo; limite de iterações; rate limit por cliente na API; tamanho máximo de corpo; timeouts em todas as dependências.                                                                                                                                                                 | AG-29, API-30, API-22                                                                  |
| Webhook forjado (alguém se passando pela plataforma de mensagens)                                   | API2 Broken Authentication       | Assinatura HMAC-SHA256 do corpo com comparação em tempo constante; payload estrito.                                                                                                                                                                                                                                                                           | HT-02, E2E-S01                                                                         |
| Chave de serviço fraca ou exposta                                                                   | API8 Security Misconfiguration   | Chaves nomeadas (`cliente:segredo`) com tamanho mínimo; segredos de desenvolvimento recusados em produção; nenhuma chave publicada no OpenAPI; rotas de demonstração proibidas em produção.                                                                                                                                                                   | API-34…API-36                                                                          |
| Repetição/duplicidade (webhook reentregue, retry após timeout, corrida entre confirmar e despachar) | API6 (fluxos sensíveis)          | Dedup de mensagens; Idempotency-Key no cancelamento (o id da ação pendente); `SELECT … FOR UPDATE`; transição atômica da ação pendente (compare-and-set) entre instâncias.                                                                                                                                                                                    | API-16…API-21, AG-24, AG-32, PG-05                                                     |
| Dependência externa instável ou respondendo fora do contrato                                        | API10 Unsafe Consumption of APIs | Timeout, retry só em falhas transitórias, circuit breaker, cache com stale-on-error, validação de schema, tratamento do "200 com corpo vazio", limite de tamanho da resposta.                                                                                                                                                                                 | FS-01…FS-10                                                                            |

## 3. Guardrails implementados

### Entrada ([`input-guard.ts`](../apps/agent/src/guardrails/input-guard.ts))

| Verificação                          | Ação                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Dados pessoais no texto              | Mascarados antes do modelo e do histórico; o modelo é avisado de que não deve pedi-los |
| Sinais de manipulação                | Registrados em log (só a categoria) e informados ao modelo pelo canal de sistema       |
| Mensagem vazia ou > 1.000 caracteres | Resposta fixa, sem custo de modelo                                                     |

O detector de manipulação ([`injection-signals.ts`](../apps/agent/src/guardrails/injection-signals.ts))
cobre cinco categorias em português e inglês: ignorar instruções, extrair o prompt, troca de
papel/autoridade, marcadores de sistema e coação de ação. Ele resiste a acentos e caracteres
invisíveis. É **sinal, não defesa**: heurística sempre pode ser contornada, e por isso nada de
crítico depende dela.

### Saída ([`output-guard.ts`](../apps/agent/src/guardrails/output-guard.ts))

| Verificação                                                  | Ação                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Afirmação de cancelamento não verificada pela API            | Bloqueia. Com número, confere cada pedido citado; sem número, exige exatamente um pedido consultado individualmente no turno e mostrado cancelado pela API. Negação e hipótese só valem até a pontuação mais próxima; discurso indireto ("dizia que foi cancelado") é bloqueado. |
| Afirmação de encaminhamento sem handoff                      | Bloqueia                                                                                                                                                                                                                                                                         |
| Promessa de estorno (prazo, garantia)                        | Bloqueia (respeitando negação)                                                                                                                                                                                                                                                   |
| Canary, marcadores internos ou trecho literal das instruções | Bloqueia (vazamento de prompt). Trecho literal = duas janelas de 8 palavras das instruções, sem atravessar o fim de uma frase. Escopo, regras de negócio e exemplos ficam de fora: são públicos e o agente deve explicá-los                                                      |
| Dados pessoais                                               | Mascara                                                                                                                                                                                                                                                                          |
| Links                                                        | Remove                                                                                                                                                                                                                                                                           |
| Markdown, tamanho                                            | Converte para WhatsApp e corta no fim de uma frase                                                                                                                                                                                                                               |

A detecção de afirmações é deliberadamente ampla, porque os dois erros não custam o mesmo: um
falso positivo custa uma resposta genérica, e um falso negativo custa uma informação errada sobre
dinheiro do cliente. Negações ("não foi cancelado") e hipóteses ("pode ser cancelado", "será
cancelado") são reconhecidas para não atrapalhar conversas normais.

O modelo nunca executa um cancelamento: o sucesso é sempre anunciado por template. Por isso uma
afirmação sem número só pode se referir a um pedido que o modelo acabou de consultar, e uma
listagem não basta (ela não diz de qual pedido a frase fala). Além de "cancelado", entram
sinônimos ("anulado", "o cancelamento deu certo") e consequências ("não será mais enviado", fora
de frase condicional). A lista é finita e paráfrases criativas podem escapar; essa limitação está
registrada em [decisões e limitações](09-decisoes-e-limitacoes.md).

### Confirmação ([`confirmation.ts`](../apps/agent/src/agent/confirmation.ts))

O ponto mais sensível do sistema, inteiramente sem IA:

- o botão confirma (ele carrega o id da ação: é inequívoco);
- o texto só confirma se a última mensagem enviada foi a própria pergunta, e se for curto e
  inequívoco ("sim", "pode cancelar"). Um "sim" que responde outra pergunta não cancela nada;
- respostas com "?", ambíguas ou com outro assunto não confirmam;
- a ação vale 10 minutos, uma vez, para um pedido; uma nova solicitação substitui a anterior;
- a execução é reservada atomicamente (`executing`), então confirmação e recusa simultâneas não
  divergem;
- a regra é revalidada pela API, então um pedido despachado entre a pergunta e o "sim" é recusado.

## 4. Proteção de dados (LGPD)

| Princípio       | Aplicação                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimização     | O modelo recebe só dados do pedido necessários à resposta. A identificação devolve só o primeiro nome. Dados pessoais digitados pelo cliente são removidos. |
| Pseudonimização | O banco do agente não guarda o telefone, só o HMAC dele. Logs usam `customerRef`/`conversationId`, nunca telefone ou ID real do cliente.                    |
| Segurança       | Bancos separados por serviço (o agente **não** acessa o banco de pedidos), usuários de banco com menor privilégio, chaves de serviço, webhook assinado.     |
| Transparência   | Trilha de auditoria de cada mudança de status (quem, quando, por quê e correlation id).                                                                     |
| Retenção        | A definir com o negócio (dúvida 12). Ponto de evolução: expurgo automático de conversas e traces.                                                           |

## 5. O que fica para produção

- Autenticação do cliente com segundo fator para ações sensíveis (dúvida 10).
- Segredos em cofre (Vault/Secrets Manager) em vez de variáveis de ambiente.
- Lock distribuído por conversa (`pg_advisory_lock` ou fila particionada) com várias instâncias.
  Hoje a fila por conversa é em memória; a execução do cancelamento já é atômica no banco.
- Classificador dedicado de prompt injection, como camada adicional de sinal.
- Enviar a descrição do produto ao modelo só quando o cliente pedir detalhes do item: uma
  afirmação falsa sem ordem explícita ("compras deste item foram anuladas") não é detectável por
  heurística, e a melhor defesa é o dado não chegar ao modelo sem necessidade.
- Monitorar a taxa de `guardrail.output.blocked` por motivo: cada bloqueio de resposta correta é
  um falso positivo que o cliente vê como mensagem genérica.
- mTLS ou tokens de curta duração entre serviços.
