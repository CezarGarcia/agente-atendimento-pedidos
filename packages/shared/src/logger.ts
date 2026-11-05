import { pino, type Logger, type LoggerOptions } from 'pino';

import { getContext } from './context.js';

export type { Logger } from 'pino';

/**
 * Caminhos redigidos como defesa em profundidade. A regra principal é outra:
 * eventos de log são montados com campos explícitos e seguros; dados pessoais,
 * conteúdo de mensagens e credenciais nunca são passados ao logger.
 * A redação cobre o caso de alguém, no futuro, logar um objeto inteiro por engano.
 */
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-signature"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["x-api-key"]',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.token',
  '*.phone',
  '*.email',
  '*.cpf',
  '*.address',
  '*.messageText',
  '*.customerName',
];

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  /** Saída legível para desenvolvimento local (requer pino-pretty). JSON é o padrão. */
  pretty?: boolean;
  /** Destino alternativo (usado nos testes para capturar as linhas emitidas). */
  destination?: pino.DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const config: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
    serializers: { err: pino.stdSerializers.err },
    mixin() {
      const context = getContext();
      return context ? { correlationId: context.correlationId, ...context.fields } : {};
    },
  };

  if (options.destination) {
    return pino(config, options.destination);
  }
  if (options.pretty) {
    return pino({ ...config, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino(config);
}
