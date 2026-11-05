import { CONFIRM_PAYLOAD_PREFIX, DECLINE_PAYLOAD_PREFIX } from './confirmation.js';
import { BLOCK_REASON_LABEL } from './presentation.js';
import type { OutgoingMessage, PendingAction } from './types.js';

/**
 * Mensagens determinísticas. Usadas nos momentos em que o texto precisa ser exato e não pode
 * depender do modelo: pedido de confirmação, resultado do cancelamento e falhas. O resultado de
 * uma ação irreversível é sempre comunicado a partir da resposta da API, nunca "redigido" pela IA.
 */

const text = (value: string): OutgoingMessage => ({ text: value });

export const templates = {
  confirmCancellation(action: PendingAction): OutgoingMessage {
    return {
      text:
        `Só para confirmar: você quer *cancelar o pedido ${action.orderId}* (${action.orderSummary})? ` +
        'Essa ação não pode ser desfeita.\n\nResponda *SIM* para cancelar ou *NÃO* para manter o pedido.',
      quickReplies: [
        { payload: `${CONFIRM_PAYLOAD_PREFIX}${action.id}`, title: 'Sim, cancelar' },
        { payload: `${DECLINE_PAYLOAD_PREFIX}${action.id}`, title: 'Não, manter' },
      ],
    };
  },

  cancellationSucceeded: (orderId: string) =>
    text(
      `Pronto! O pedido *${orderId}* foi cancelado. ✅\n` +
        'Se houve pagamento, a devolução do valor segue a política da loja; um atendente pode ' +
        'te dar detalhes, se precisar. Posso ajudar em algo mais?',
    ),

  /** A regra foi revalidada pela API no momento da execução (ex.: o pedido foi enviado). */
  cancellationRejected(orderId: string, reason: string): OutgoingMessage {
    if (reason === 'ALREADY_CANCELLED') {
      return text(`O pedido *${orderId}* já está cancelado. Posso ajudar em algo mais?`);
    }
    const why = BLOCK_REASON_LABEL[reason] ?? BLOCK_REASON_LABEL['UNKNOWN_STATUS'] ?? '';
    return text(
      `Não consegui cancelar o pedido *${orderId}*: ${why}, então ele não pode mais ser ` +
        'cancelado por aqui. Se quiser, posso te encaminhar para um atendente.',
    );
  },

  cancellationOrderNotFound: (orderId: string) =>
    text(
      `Não encontrei o pedido *${orderId}* no momento da confirmação, então nada foi cancelado. ` +
        'Pode conferir o número?',
    ),

  /** Regra 6: resultado incerto nunca é apresentado como sucesso (nem como fracasso). */
  cancellationOutcomeUnknown(action: PendingAction): OutgoingMessage {
    return {
      text:
        `Tive uma instabilidade e *não consegui confirmar* se o cancelamento do pedido ${action.orderId} ` +
        'foi concluído. Posso tentar de novo com segurança: não existe risco de cancelar duas vezes. ' +
        'Quer que eu tente novamente?',
      quickReplies: [
        { payload: `${CONFIRM_PAYLOAD_PREFIX}${action.id}`, title: 'Tentar novamente' },
        { payload: `${DECLINE_PAYLOAD_PREFIX}${action.id}`, title: 'Agora não' },
      ],
    };
  },

  retryDeclined: (orderId: string) =>
    text(
      `Tudo bem. Como não consegui confirmar a situação do pedido ${orderId}, você pode me pedir ` +
        'para consultá-lo daqui a pouco ou falar com um atendente.',
    ),

  cancellationDeclined: (orderId: string) =>
    text(`Combinado, o pedido *${orderId}* continua ativo. Posso ajudar em algo mais?`),

  handoffInProgress: (protocol: string) =>
    text(
      `Sua conversa já foi encaminhada para um atendente (protocolo *${protocol}*). ` +
        'Em breve alguém da equipe continua o atendimento por aqui.',
    ),

  identityUnavailable: () =>
    text(
      'Estou com uma instabilidade para acessar os pedidos agora. Pode tentar de novo em alguns ' +
        'minutos? Se preferir, digite *atendente* para falar com uma pessoa.',
    ),

  messageTooLong: () =>
    text('Sua mensagem ficou um pouco longa. Pode me contar em poucas linhas como posso ajudar?'),

  emptyMessage: () => text('Não consegui ler sua mensagem. Pode escrever como posso te ajudar?'),

  rateLimited: () =>
    text('Recebi muitas mensagens em sequência. Aguarde um instante e me conte como posso ajudar.'),

  llmUnavailable: () =>
    text(
      'Desculpe, estou com uma instabilidade e não consegui processar sua mensagem. Pode tentar de ' +
        'novo em instantes? Se preferir, digite *atendente* para falar com uma pessoa.',
    ),

  outputBlocked: () =>
    text(
      'Desculpe, não consegui concluir minha resposta com segurança. Pode reformular sua pergunta? ' +
        'Se preferir, posso te encaminhar para um atendente.',
    ),
} as const;
