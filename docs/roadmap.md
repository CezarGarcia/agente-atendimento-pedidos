# Roadmap de desenvolvimento

O projeto é construído em fases incrementais. Cada fase termina com lint, checagem de tipos e
testes passando, revisão do código e commit.

| Fase | Entrega                                                                                                           | Status    |
| ---- | ----------------------------------------------------------------------------------------------------------------- | --------- |
| 0    | Monorepo TypeScript, qualidade de código, logger estruturado, Postgres isolado por serviço, CI                    | Concluída |
| 1    | API principal de pedidos: regras, persistência, OpenAPI/Swagger, idempotência, auditoria                          | Concluída |
| 2    | Integração resiliente com a Fake Store API                                                                        | Concluída |
| 3    | Núcleo do agente: modelo de IA, ferramentas, confirmação determinística, guardrails                               | Concluída |
| 4    | Canal de mensagens simulado e simulador web                                                                       | Concluída |
| 5    | Testes ponta a ponta                                                                                              | Concluída |
| 6    | Avaliações com o modelo real e testes adversariais                                                                | Concluída |
| 7    | Documentação final, decisões e limitações                                                                         | Concluída |
| 8    | Endurecimento a partir dos evals: guardrail calibrado, filtro do catálogo, confirmação com vários pedidos, prompt | Concluída |

## Como a fase 6 terminou

A suíte rodou contra o Claude Haiku 5.5 e o Claude Sonnet 5.5 em quatro rodadas, três de
diagnóstico e a final, com 3 execuções por cenário e juiz Sonnet 5.5. A primeira usou os 31
cenários originais. As falhas, e 20 cenários novos criados para procurar brechas, levaram às
correções da fase 8. Os relatórios estão em [`evals/`](evals/README.md), com o histórico do que
cada falha mudou.

## Próximos passos

Em ordem de valor para uma operação real:

1. **Evals no ciclo de mudança.** Rodar a suíte (`--runs 5` ou mais) antes de trocar o prompt ou o
   modelo, e transformar conversas reais anonimizadas em cenários novos.
2. **Monitorar bloqueios do guardrail em produção.** A taxa de `guardrail.output.blocked` por
   motivo mostra falsos positivos que o cliente vê como mensagem genérica.
3. **Minimizar o catálogo enviado ao modelo.** Descrição do produto só quando o cliente pedir
   detalhes do item: é a defesa contra injeção declarativa, que heurística não pega.
4. **Calibrar o juiz** com uma amostra rotulada por pessoas, e usar um juiz de outra família de
   modelos para não depender de um modelo avaliando a si mesmo.
5. **Itens de produção** já listados em [`03-seguranca-e-guardrails.md`](03-seguranca-e-guardrails.md)
   e [`09-decisoes-e-limitacoes.md`](09-decisoes-e-limitacoes.md): lock por conversa com várias
   instâncias, webhook assíncrono, segundo fator, retenção de dados, integração com a ferramenta de
   atendimento.

## Princípios que guiam as decisões

1. **O modelo interpreta e conversa; o código decide e executa.** Nenhuma regra de negócio depende
   apenas das instruções do modelo.
2. **Defesa em profundidade.** Instruções, desenho das ferramentas, máquina de estados de
   confirmação, validação na API e verificação das respostas são camadas independentes.
3. **Menor privilégio.** O modelo não tem ferramenta capaz de cancelar diretamente; a identidade do
   cliente vem do canal, nunca da conversa; cada serviço só acessa o próprio banco.
4. **Minimização de dados.** O modelo recebe apenas o necessário; logs não contêm dados pessoais.
5. **Simplicidade deliberada.** Sem componentes que o problema não exige.
