/** Rótulos em português para os códigos técnicos exibidos no painel de bastidores. */

export const PATH_LABEL: Record<string, string> = {
  llm: 'Modelo de IA + ferramentas',
  confirmation: 'Confirmação determinística',
  deterministic: 'Resposta fixa (sem IA)',
};

export const TOOL_LABEL: Record<string, string> = {
  consultar_pedido: 'Consultar pedido',
  listar_pedidos: 'Listar pedidos',
  solicitar_cancelamento: 'Solicitar cancelamento',
  transferir_para_humano: 'Transferir para humano',
};

export const PII_LABEL: Record<string, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  card: 'Cartão',
  email: 'E-mail',
  phone: 'Telefone',
};

export const SIGNAL_LABEL: Record<string, string> = {
  instruction_override: 'Ignorar instruções',
  prompt_extraction: 'Extrair o prompt',
  role_play: 'Troca de papel / autoridade',
  role_markers: 'Marcadores de sistema',
  action_coercion: 'Coação de ação',
};

export const GUARD_REASON_LABEL: Record<string, string> = {
  empty: 'Resposta vazia',
  prompt_leak: 'Vazamento das instruções',
  unverified_cancellation_claim: 'Afirmou cancelamento não confirmado pela API',
  unverified_handoff_claim: 'Afirmou transferência não realizada',
  refund_promise: 'Promessa de estorno',
  pii_redacted: 'Dado pessoal mascarado',
  too_long: 'Resposta encurtada',
};

export const TEMPLATE_LABEL: Record<string, string> = {
  confirmCancellation: 'Pedido de confirmação',
  cancellationSucceeded: 'Cancelamento confirmado pela API',
  cancellationRejected: 'Cancelamento recusado pela API',
  cancellationOrderNotFound: 'Pedido não encontrado na execução',
  cancellationOutcomeUnknown: 'Resultado incerto (erro técnico)',
  retryDeclined: 'Nova tentativa recusada',
  cancellationDeclined: 'Cliente manteve o pedido',
  handoffInProgress: 'Conversa com atendente humano',
  identityUnavailable: 'Identificação indisponível',
  messageTooLong: 'Mensagem longa demais',
  emptyMessage: 'Mensagem vazia',
  rateLimited: 'Limite de mensagens',
  llmUnavailable: 'Modelo indisponível',
  outputBlocked: 'Resposta bloqueada pelo guardrail',
};

export function sourceLabel(source: string): string {
  if (source === 'llm') return 'Texto do modelo';
  const template = source.replace('template:', '');
  return `Mensagem fixa · ${TEMPLATE_LABEL[template] ?? template}`;
}

export const formatUsd = (value: number): string =>
  value < 0.01 ? `US$ ${value.toFixed(5)}` : `US$ ${value.toFixed(3)}`;

export const formatMs = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1).replace('.', ',')} s` : `${value} ms`;
