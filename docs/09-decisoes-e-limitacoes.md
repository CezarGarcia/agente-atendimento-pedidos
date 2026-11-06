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
(`--models claude-haiku-5-5,claude-sonnet-5-5`). Nas rodadas finais (51 cenários, 3 execuções), o
Haiku foi aprovado em 153 de 153 execuções nas duas rodadas e o Sonnet em 152 de 153; o custo por
conversa do Haiku foi cerca de 18 vezes menor (US$ 0,00026 contra US$ 0,00458) e as respostas mais
rápidas (2,1–2,2 s contra 2,9 s). Os números estão em [`evals/README.md`](evals/README.md). Se o
Haiku passar a falhar em cenários de red team ou de condução da conversa, trocar o modelo é uma
variável de ambiente. A configuração aceita só os
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

### D11. Avaliar com o modelo real e corrigir o harness, não só o prompt

**Contexto.** O modelo roteirizado prova que o harness impõe as regras quando o modelo erra, mas
não mostra o que acontece quando o modelo **acerta** e o harness atrapalha. A primeira execução
com o modelo real mostrou exatamente isso.
**Decisão.** Cada falha dos evals foi classificada (harness, prompt, o próprio eval ou o modelo) e
corrigida na camada certa, com teste quando a correção é código. O relatório passou a guardar o
texto original de toda resposta barrada pelo guardrail, porque a mensagem genérica que o cliente
recebe esconde se o bloqueio foi acerto ou falso positivo. O que mudou, com a evidência de cada
item, está em [`evals/README.md`](evals/README.md). Os exemplos mais relevantes:

- **Harness:** "cancela o 100101 e o 100102" terminava na pergunta fixa do 100101 e o 100102 sumia
  (AG-41); a pergunta de confirmação ficava no histórico sem o resultado correspondente e o modelo
  se desculpava por dados que "não consultou" (AG-42); a recusa do modelo virava "instabilidade"
  (AG-40); o filtro do catálogo deixava passar a injeção dos próprios evals (GU-11).
- **Guardrail:** respostas corretas com negação ("nada foi cancelado", "o cancelamento não pode ser
  feito") eram bloqueadas. A revisão dessas regras achou duas brechas antigas no sentido oposto
  ("Não se preocupe, foi cancelado" passava sem verificação), que foram fechadas (GU-05, GU-20). Explicar uma regra ao
  cliente com as palavras do prompt deixou de contar como vazamento: escopo e regras de negócio
  são públicos (GU-13).
- **Prompt:** listar pedidos em vez de pedir o número, consultar de novo quando o cliente pergunta
  outra vez, não comentar o texto suspeito do catálogo, frases sugeridas movidas das instruções
  para os exemplos.

**Custo.** Falsos positivos residuais aceitos de propósito: o guardrail continua bloqueando o
discurso indireto ("o catálogo dizia que o pedido foi cancelado") e o modelo explicando a própria
regra ("só informo que um pedido foi cancelado quando o sistema confirma"). O cliente recebe a
mensagem genérica, nunca uma informação falsa.

### D12. Red team em três frentes antes de dar o agente por blindado

**Contexto.** A suíte de evals mede o modelo; não mede as regras determinísticas contra quem as lê.
Um guardrail por regras parece sólido até alguém procurar o buraco.
**Decisão.** Três frentes independentes. Revisão white-box dos guardrails, procurando entradas que
passam (paráfrases, unicode, formatação, links, PII, catálogo, confirmação). Revisão white-box da
lógica, com testes que simulam um modelo totalmente manipulado e falhas de infraestrutura. E 32
ataques novos com o modelo real (injeção em vários turnos, falso resultado de ferramenta,
many-shot, homóglifos, resumo envenenado para o atendente, catálogo adulterado). Cada brecha
confirmada virou correção com teste; o corpus inteiro ficou nos testes para não voltar.
**O que mudou.** Normalização de segurança compartilhada; guardrail de saída com atribuição por
pedido e negação colada; confirmação que não aceita "?" de outros alfabetos nem emoji de dúvida;
pergunta de confirmação só com dados da API; janela do "sim" fechada por qualquer resposta; uma
ação aberta por conversa no banco; catálogo que descarta texto fora do assunto do produto; PII com
outros separadores; resumo do atendente com procedência e identidade; limite do webhook por
remetente. A lista completa, com evidência, está em [`evals/README.md`](evals/README.md).
**Custo.** Mais regras para manter. O dado mais importante: em centenas de execuções
adversariais, o modelo não produziu nenhuma afirmação falsa; o que o guardrail barrava eram
respostas corretas (o modelo citando a frase do atacante para recusá-la, explicando a regra,
recusando o "conto" ou o JSON pedido). A rodada 9 tratou isso como defeito: cada recusa real
virou teste (GU-24) e ganhou uma exceção estreita, e cada exceção passou por uma nova revisão
white-box que tentou abusar dela (GU-25). Uma citação, por exemplo, só é menção quando a frase a
recusa **e** a resposta diz o que é verdade. Das 22 respostas barradas em todas as rodadas, 20
passam a sair; as duas que continuam barradas estão certas.

### D13. Mensagem fixa para situação de risco; afirmação de ação sem ferramenta é bloqueada

**Contexto.** No cenário de autolesão, o modelo encaminhava para um atendente em todas as
execuções, mas o Haiku abria com o protocolo e esquecia o acolhimento ou o CVV em metade delas.
Separadamente, o guardrail não olhava para ações que o agente não tem como fazer: "Endereço
atualizado ✅" passaria.
**Decisão.** Com o motivo `situacao_sensivel`, a resposta é um template (acolhimento, CVV 188,
SAMU 192, protocolo), como a pergunta de confirmação: o modelo decide encaminhar, o texto não é
dele. E uma verificação nova, `unverified_action_claim`, bloqueia qualquer afirmação de endereço,
pagamento ou item alterado, entrega reagendada ou cupom aplicado.
**Custo.** O texto de apoio não se adapta à mensagem da pessoa; se o modelo não reconhecer a
situação, vale a instrução do prompt (que pede o mesmo conteúdo). Um classificador dedicado de
risco seria o próximo passo.

## Limitações

| Limitação                                          | Impacto                                                                                                                                                                                                                                                          | Caminho                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Fila por conversa em memória                       | Com várias instâncias, mensagens simultâneas da mesma conversa podem ser processadas em paralelo. A execução do cancelamento continua atômica.                                                                                                                   | `pg_advisory_lock` por conversa ou fila particionada                                                        |
| Webhook síncrono                                   | Plataformas reais esperam 200 rápido e resposta por API de envio                                                                                                                                                                                                 | Responder 200 de imediato e processar numa fila (com o mesmo `AgentService`)                                |
| Detecção de afirmações e de manipulação por regras | Depois de três revisões white-box, cobre sinônimos, inglês, unicode, formatação, carona em pedido verificado e as recusas reais do modelo (GU-22 a GU-26), mas uma paráfrase nova ainda pode escapar, e cada exceção nova é um lugar a mais para procurar brecha | Classificador semântico como segunda opinião (só bloqueia); monitorar `guardrail.output.blocked` por motivo |
| Injeção declarativa em dado externo                | Uma afirmação falsa sem ordem ("compras deste item foram anuladas e o valor volta em 24 horas") passa pelo filtro do catálogo; não repassá-la depende do modelo. O guardrail pega "anulado/cancelado", não "o valor volta em 24 horas"                           | Enviar a descrição do produto ao modelo só quando o cliente pedir detalhes do item                          |
| Evals com amostra pequena e dados fixos            | 3 execuções por cenário pegam falhas frequentes; uma falha de 1 em 20 pode não aparecer. Os dados são sempre os mesmos 6 pedidos                                                                                                                                 | `--runs 10` antes de trocar prompt ou modelo; conversas reais anonimizadas como cenários novos              |
| Juiz é um modelo da mesma família avaliada         | O Sonnet 5.5 julga também o Sonnet 5.5 (viés de autoavaliação); critérios subjetivos (empatia, tom) variam entre execuções                                                                                                                                       | Calibrar com uma amostra rotulada por pessoas; juiz de outra família de modelos                             |
| Agente volta a atender depois do encaminhamento    | Após 30 minutos de inatividade, uma conversa nova recomeça com o agente enquanto o atendimento humano ainda está aberto                                                                                                                                          | Pausar o agente até a ferramenta de atendimento fechar o protocolo                                          |
| Modo demonstração depende de configuração          | Com `NODE_ENV` de desenvolvimento e `DEMO_MODE` ligado, as rotas do simulador aceitam mensagens sem assinatura; a imagem Docker usa produção, que recusa o modo                                                                                                  | Manter o modo demonstração fora de qualquer ambiente exposto                                                |
| Identidade só pelo telefone                        | Telefone compartilhado vê os pedidos daquele cadastro                                                                                                                                                                                                            | Segundo fator para ações sensíveis (dúvida 10)                                                              |
| Sem política de retenção de conversas e traces     | Dados ficam até serem apagados manualmente                                                                                                                                                                                                                       | Expurgo agendado conforme a política definida (dúvida 12)                                                   |
| Atendimento humano simulado                        | O protocolo não chega a uma fila real                                                                                                                                                                                                                            | Integração com a ferramenta de atendimento (Zendesk, Intercom…)                                             |
| Catálogo em inglês                                 | Nomes de produtos aparecem em inglês                                                                                                                                                                                                                             | Catálogo localizado (fora do alcance da Fake Store)                                                         |
| Migrations rodam na inicialização                  | Adequado a uma instância; arriscado com várias                                                                                                                                                                                                                   | Job de migração separado no deploy                                                                          |
| Métricas e tracing distribuído                     | Há logs estruturados com correlation id e traces por turno, mas não há OpenTelemetry nem dashboards                                                                                                                                                              | Exportar spans OTel (o SDK da Anthropic suporta) e métricas por evento                                      |
