# Roadmap de desenvolvimento

O projeto é construído em fases incrementais. Cada fase termina com lint, checagem de tipos e
testes passando, revisão do código e commit.

| Fase | Entrega                                                                                        | Status       |
| ---- | ---------------------------------------------------------------------------------------------- | ------------ |
| 0    | Monorepo TypeScript, qualidade de código, logger estruturado, Postgres isolado por serviço, CI | Concluída    |
| 1    | API principal de pedidos: regras, persistência, OpenAPI/Swagger, idempotência, auditoria       | Em andamento |
| 2    | Integração resiliente com a Fake Store API                                                     | Pendente     |
| 3    | Núcleo do agente: modelo de IA, ferramentas, confirmação determinística, guardrails            | Pendente     |
| 4    | Canal de mensagens simulado e simulador web                                                    | Pendente     |
| 5    | Testes ponta a ponta                                                                           | Pendente     |
| 6    | Avaliações com o modelo real e testes adversariais                                             | Pendente     |
| 7    | Documentação final, decisões e limitações                                                      | Pendente     |

## Princípios que guiam as decisões

1. **O modelo interpreta e conversa; o código decide e executa.** Nenhuma regra de negócio depende
   apenas das instruções do modelo.
2. **Defesa em profundidade.** Instruções, desenho das ferramentas, máquina de estados de
   confirmação, validação na API e verificação das respostas são camadas independentes.
3. **Menor privilégio.** O modelo não tem ferramenta capaz de cancelar diretamente; a identidade do
   cliente vem do canal, nunca da conversa; cada serviço só acessa o próprio banco.
4. **Minimização de dados.** O modelo recebe apenas o necessário; logs não contêm dados pessoais.
5. **Simplicidade deliberada.** Sem componentes que o problema não exige.
