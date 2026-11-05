import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresAdminUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Sobe um PostgreSQL efêmero para a suíte. Se TEST_DATABASE_URL estiver definida (ex.: serviço
 * de banco do CI), usa esse banco em vez de criar um container.
 */
export async function setup(project: TestProject): Promise<void> {
  const external = process.env['TEST_DATABASE_URL'];
  if (external) {
    project.provide('postgresAdminUrl', external);
    return;
  }
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  project.provide('postgresAdminUrl', container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
