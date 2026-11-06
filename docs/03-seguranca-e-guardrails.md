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
| Ação que o agente não tem como executar                      | Bloqueia: endereço, dados de pagamento ou itens alterados, entrega reagendada, cupom ou desconto aplicado. Não há ferramenta para nada disso, então toda afirmação de que foi feito é falsa                                                                                      |
| Canary, marcadores internos ou trecho literal das instruções | Bloqueia (vazamento de prompt). Trecho literal = duas janelas de 8 palavras das instruções, sem atravessar o fim de uma frase. Escopo, regras de negócio e exemplos ficam de fora: são públicos e o agente deve explicá-los                                                      |
| Dados pessoais                                               | Mascara                                                                                                                                                                                                                                                                          |
| Links                                                        | Remove                                                                                                                                                                                                                                                                           |
| Markdown, tamanho                                            | Converte para WhatsApp e corta no fim de uma frase                                                                                                                                                                                                                               |

A detecção de afirmações é deliberadamente ampla, porque os dois erros não custam o mesmo: um
falso positivo custa uma resposta genérica, e um falso negativo custa uma informação errada sobre
dinheiro do cliente. Depois de uma revisão adversarial white-box e de duas rodadas de red team com
o modelo real, o guardrail funciona assim:

- **Normalização antes de toda checagem** ([`normalize.ts`](../apps/agent/src/guardrails/normalize.ts)):
  caracteres invisíveis (soft hyphen, zero-width, tags Unicode), homóglifos cirílicos e gregos,
  largura total, formatação do WhatsApp dentro da palavra e letras espaçadas. "cаncelado" com "а"
  cirílico, "_cancelado_" e "c-a-n-c-e-l-a-d-o" são a mesma palavra.
- **Vocabulário amplo**: cancelado, anulado, estornado, desfeito, cancelou, "o cancelamento foi
  efetivado/ok ✅", inglês ("canceled", "refunded"), e consequências ("não será mais enviado",
  "não vai mais ser cobrado", "já era").
- **Exceção estreita**: negação e hipótese só valem coladas na afirmação ("não FOI cancelado",
  "pode SER cancelado", "não consigo confirmar que o pedido está cancelado"). "Nem esquenta que tá
  cancelado" e "Não se preocupe, foi cancelado" são afirmações. Cada exceção vale só na forma em
  que o modelo recusa: o relato negado exige um auxiliar ("não posso dizer que", não "nem preciso
  dizer que"); o subjuntivo, dúvida ou negação ("não tenho informação de que tenha sido
  cancelado", não "fico feliz que tenha sido"); a oração temporal, verbo no futuro ("assim que
  você confirmar", não "depois que você confirmou").
- **Pares substantivo-desfecho** ("o cancelamento do pedido 100102, que estava em processamento,
  foi realizado"): cada par da frase é avaliado à parte, então a negação de um ("não posso dizer
  que algo foi feito") não cobre o seguinte ("…não foi feito por mim, foi feito pelo sistema").
- **Citação** só é menção quando a frase recusa ou desmente o que está entre aspas e a resposta
  diz o que é verdade: 'não posso enviar a mensagem "pedido 100102 cancelado", porque ele já foi
  enviado', 'as mensagens "Pronto, cancelado!" não vieram do sistema; nenhum pedido foi
  cancelado'. 'Pedido 100102 "já era"', 'não vou repetir "pedido 100102 cancelado" de novo' e
  'a mensagem "…" está certinha' continuam bloqueadas.
- **Atribuição por pedido**: a afirmação vale para todos os pedidos da frase, menos os que trazem o
  próprio status ("o 100201 (em processamento) e o 100202 (cancelado)"). "O 100202 foi cancelado,
  e o 100102 também" não pega carona no pedido verificado. Sem número na frase, vale o pedido
  citado antes na resposta (cabeçalho "_Pedido 100102_") ou, se não houver, o único pedido
  consultado no turno. O ponto de milhar ("R$ 3.475,00") não é fim de frase.
- **Encaminhamento** só conta com uma pessoa como destino ("encaminhado para a transportadora" não
  é encaminhamento); **promessa de estorno** é avaliada por oração.
- **Ações sem ferramenta**: "alterei o endereço", "endereço atualizado ✅", "apliquei um cupom",
  "reagendei a entrega", "a troca foi confirmada". "Não consigo alterar o endereço por aqui" e "o
  endereço só pode ser alterado por um atendente" passam.
- **Vazamento**: canary em qualquer forma (minúsculas, separado, invertido, base64), marcadores
  com outros separadores, nomes das ferramentas e duas janelas de 8 palavras das instruções.
- **Links** com ou sem protocolo (domínio, encurtador, IP) são removidos, e as checagens valem
  para o texto já cortado no limite de tamanho.

O corpus das revisões está em
[`output-guard.redteam.test.ts`](../apps/agent/src/guardrails/output-guard.redteam.test.ts): os
ataques que passavam (GU-22, GU-25, GU-26) e as recusas reais do modelo que eram barradas (GU-23,
GU-24, tiradas das rodadas de avaliação). Cada exceção foi atacada por mais duas revisões
white-box, e o que passava virou teste (GU-25). Antes de cada mudança, as respostas barradas de
todas as rodadas são reaplicadas ao guardrail novo: das 46 registradas, 42 passam a sair. Das
quatro restantes, uma está certa (o modelo dizendo "Recebi seu SIM" sobre uma confirmação que não
valia), duas repetem "seu pedido cancelado" da fala do cliente sem ter consultado, e uma só é
barrada fora do contexto real (falava de um encaminhamento que tinha acontecido). Regras continuam sendo regras: uma paráfrase nova pode
escapar. A defesa que não depende de nada disso continua sendo a arquitetura: o modelo não tem
como cancelar, e o sucesso só é anunciado por template a partir da API.

### Confirmação ([`confirmation.ts`](../apps/agent/src/agent/confirmation.ts))

O ponto mais sensível do sistema, inteiramente sem IA:

- o botão confirma (ele carrega o id da ação: é inequívoco);
- o texto só confirma se a última mensagem enviada foi a própria pergunta, e se for curto e
  inequívoco ("sim", "pode cancelar"). Um "sim" que responde outra pergunta não cancela nada;
- respostas com "?" (de qualquer alfabeto: "？", "¿", "❓"), emoji de dúvida ou recusa ("sim 🤔",
  "sim 👎"), reticências, citação, ambíguas ou com outro assunto não confirmam;
- qualquer resposta que não seja a pergunta, inclusive as fixas (mensagem longa demais, vazia,
  limite de mensagens), fecha a janela do texto; depois dela, só o botão confirma;
- a pergunta mostra só dados da API (pedido, quantidade de itens, total): o título do catálogo,
  dado externo, ficava dentro da pergunta que o "sim" responde;
- no máximo uma ação aberta por conversa, garantida por índice único no banco;
- a ação vale 10 minutos, uma vez, para um pedido; uma nova solicitação substitui a anterior;
- a execução é reservada atomicamente (`executing`), então confirmação e recusa simultâneas não
  divergem;
- a regra é revalidada pela API, então um pedido despachado entre a pergunta e o "sim" é recusado.

### Situação de risco

Se o cliente fala em se machucar, em suicídio ou em outro risco à vida, o modelo encaminha a
conversa com o motivo `situacao_sensivel`, e a resposta deixa de ser dele: o sistema envia uma
mensagem fixa (`sensitiveHandoff`) com acolhimento, o CVV (188, 24 horas, gratuito), o SAMU (192)
em perigo imediato e o protocolo do atendente que continua a conversa. O pedido não é mencionado.
Nas avaliações, o modelo encaminhava sempre, mas em metade das execuções do Haiku abria com o
protocolo e esquecia o acolhimento ou o CVV; uma mensagem dessas não pode depender de sorteio.

## 4. Proteção de dados (LGPD)

| Princípio       | Aplicação                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimização     | O modelo recebe só dados do pedido necessários à resposta. A identificação devolve só o primeiro nome (saneado: só letras). Dados pessoais digitados pelo cliente são removidos, inclusive com separadores e formatos variados (SH-06), e mensagens recusadas não entram no histórico. |
| Pseudonimização | O banco do agente não guarda o telefone, só o HMAC dele. Logs usam `customerRef`/`conversationId`, nunca telefone ou ID real do cliente.                                                                                                                                               |
| Segurança       | Bancos separados por serviço (o agente **não** acessa o banco de pedidos), usuários de banco com menor privilégio, chaves de serviço, webhook assinado.                                                                                                                                |
| Transparência   | Trilha de auditoria de cada mudança de status (quem, quando, por quê e correlation id).                                                                                                                                                                                                |
| Retenção        | A definir com o negócio (dúvida 12). Ponto de evolução: expurgo automático de conversas e traces.                                                                                                                                                                                      |

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
- Classificador semântico (um modelo pequeno com saída estruturada) como segunda opinião do
  guardrail de saída: pega paráfrases que regra nenhuma prevê. Só pode bloquear, nunca liberar o
  que as regras bloquearam.
- Manter o agente pausado enquanto o atendimento humano estiver aberto, mesmo depois da
  inatividade da conversa (hoje, após 30 minutos, uma conversa nova recomeça com o agente).
- mTLS ou tokens de curta duração entre serviços.
