#!/bin/sh
# Executado uma única vez, na criação do volume do Postgres.
# Cada serviço tem o próprio banco e o próprio usuário (menor privilégio):
# o agente NÃO tem acesso ao banco de pedidos; ele só enxerga pedidos pela API principal.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE orders_app LOGIN PASSWORD '${ORDERS_DB_PASSWORD}';
  CREATE DATABASE orders OWNER orders_app;
  REVOKE ALL ON DATABASE orders FROM PUBLIC;

  CREATE ROLE agent_app LOGIN PASSWORD '${AGENT_DB_PASSWORD}';
  CREATE DATABASE agent OWNER agent_app;
  REVOKE ALL ON DATABASE agent FROM PUBLIC;
EOSQL
