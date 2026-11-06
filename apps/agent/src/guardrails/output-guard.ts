import { redactPii } from '@agente/shared';

import { shingles } from '../agent/prompt.js';
import { securityNormalize, stripInvisible } from './normalize.js';

/**
 * Guardrail de saída: confere a resposta do modelo ANTES de enviá-la ao cliente.
 *
 * O ponto central é a regra 5 ("só informar que cancelou se a API retornou sucesso"):
 * qualquer afirmação de cancelamento só passa se a API principal confirmou, nesta conversa, que
 * aquele pedido está cancelado. A lista de padrões é deliberadamente ampla: um falso positivo
 * custa uma resposta genérica; um falso negativo custa uma informação errada ao cliente.
 */

export interface OutputGuardContext {
  /** Pedidos que a API principal mostrou cancelados nesta conversa (consulta ou cancelamento). */
  readonly verifiedCancelledOrderIds: ReadonlySet<string>;
  /**
   * Pedidos consultados um a um neste turno (consultar_pedido ou solicitar_cancelamento) que a API
   * mostrou cancelados. Uma afirmação sem número só passa se houver exatamente um: uma lista de
   * pedidos não diz a qual deles a frase se refere.
   */
  readonly verifiedThisTurn: ReadonlySet<string>;
  readonly handoffCreated: boolean;
  /** Marcador secreto presente no prompt: se aparecer na resposta, houve vazamento. */
  readonly canary: string;
  /** Sequências de 8 palavras das instruções (sem os exemplos). */
  readonly promptFingerprint?: ReadonlySet<string>;
}

export type OutputGuardReason =
  | 'empty'
  | 'prompt_leak'
  | 'unverified_cancellation_claim'
  | 'unverified_handoff_claim'
  | 'refund_promise'
  | 'unverified_action_claim'
  | 'pii_redacted'
  | 'link_removed'
  | 'too_long';

export interface OutputGuardResult {
  readonly action: 'pass' | 'modified' | 'blocked';
  readonly text: string;
  readonly reasons: readonly OutputGuardReason[];
}

export const MAX_OUTPUT_LENGTH = 1_000;

/**
 * Janelas de 8 palavras das instruções que precisam aparecer na resposta para caracterizar
 * vazamento. Vazar instruções reproduz trechos longos (várias janelas); uma única coincidência de
 * 8 palavras costuma ser o modelo usando uma expressão que as próprias instruções sugerem (visto
 * nos evals: "use o botão Sim, cancelar da mensagem anterior").
 */
const MIN_PROMPT_SHINGLES = 2;

/**
 * Marcadores internos do prompt. Comparados com os separadores colapsados ("seguranca-e-limites",
 * "seguranca\_e\_limites"). Os nomes das ferramentas também são internos: o cliente não precisa
 * deles e eles ajudam a montar ataques.
 */
const INTERNAL_MARKERS =
  /<\s*\/?\s*(contexto|escopo|exemplos?)\s*>|(regras|protocolo|contexto|uso|seguranca|estilo|aviso|incertezas)[_\-\\]+(de|da|das|do|e)[_\-\\]+(negocio|cancelamento|sessao|ferramentas|limites|comunicacao|sistema|falhas)|consultar[_\-\\]+pedido|listar[_\-\\]+pedidos|solicitar[_\-\\]+cancelamento|transferir[_\-\\]+para[_\-\\]+humano|pode[_\-\\]+cancelar|numero[_\-\\]+pedido/;

/*
 * Afirmações de cancelamento. Vocabulário amplo (inclusive inglês e o que vem com o cancelamento:
 * estorno, reembolso, "não vai mais ser cobrado"), e a exceção estreita: negação ou hipótese
 * coladas na afirmação. Um falso positivo custa uma resposta genérica; um falso negativo, uma
 * informação errada ao cliente.
 */
const CANCELLATION_CLAIMS = [
  /\b(cancelad|anulad|estornad|reembolsad|desfeit|revertid)[oa]s?\b/g,
  /\b(cancel|anul|estorn|reembols)(ei|amos|ou|aram)\b/g,
  /\b(processei|efetuei|realizei|fiz|concluí|conclui|finalizei|registrei|processamos|efetuamos|realizamos|fizemos|concluimos|finalizamos|registramos)\s+(o|seu)?\s*(cancelamento|estorno|reembolso)\b/g,
  /\b(acabei|acabamos|consegui|conseguimos)\s+(de\s+)?cancela(r|lo|la|los|las)\b/g,
  /\bcancell?ed\b|\bvoided\b|\brefunded\b/g,
];

/**
 * Afirmações em duas partes: o substantivo e, adiante na mesma frase, o desfecho ("o cancelamento
 * do pedido 100102, que estava em processamento, foi realizado"). Cada par substantivo-desfecho é
 * avaliado à parte: a negação que vale para um ("não posso dizer que algo foi feito") não cobre
 * outro mais adiante.
 */
interface SpanClaim {
  readonly head: RegExp;
  readonly tail: RegExp;
  /** Distância máxima, em caracteres, entre o fim do substantivo e o desfecho. */
  readonly window: number;
}
const CANCELLATION_SPANS: readonly SpanClaim[] = [
  {
    head: /\bcancelamentos?\b/g,
    tail: /\b(realizad|concluid|efetuad|efetivad|confirmad|feit|aprovad|processad|finalizad|registrad)[oa]s?\b|\b(deu certo|deram certo|com sucesso|ok)\b/g,
    window: 80,
  },
  { head: /\bcancelamentos?\b/g, tail: /✅/g, window: 30 },
  {
    head: /\bcancell?ations?\b/g,
    tail: /\b(successful|complete|completed|confirmed|done|went through|processed|approved|accepted)\b/g,
    window: 40,
  },
  {
    head: /\bcancelacion\b/g,
    tail: /\b(exitosa|realizada|completada|confirmada)\b/g,
    window: 40,
  },
  // "Seu pedido 100102 foi excluído do sistema."
  {
    head: /\b(pedidos?|compras?|orders?)\b/g,
    tail: /\b(excluid|deletad|removid)[oa]s?\b|\b(deleted|removed)\b/g,
    window: 30,
  },
];

/**
 * Consequências que só um cancelamento produz. Numa frase condicional com a condição ANTES ("se
 * confirmar, o pedido não será mais enviado") explicam o efeito; com a condição depois ("não será
 * mais enviado e, se precisar, é só chamar") continuam sendo afirmação.
 */
const CANCELLATION_CONSEQUENCES = [
  /\bnao (sera|vai ser|vai) mais (ser )?(enviad[oa]s?|entregues?|despachad[oa]s?|cobrad[oa]s?|chegar|sair)\b/g,
  /\bnao (sai|saira|chega|chegara) mais\b/g,
  /\bnao precisa(ra)? mais pagar\b/g,
  /\bja era\b/g,
  /\bnao (sera|serao|vai ser) (cobrad[oa]s?|enviad[oa]s?|entregues?|despachad[oa]s?) nem (cobrad[oa]s?|enviad[oa]s?|entregues?|despachad[oa]s?)\b/g,
  /\b(voce\s+)?nao (sera|vai ser) cobrad[oa]s?\b/g,
  /\bnao (sera|serao|vai ser) (enviad[oa]s?|entregues?|despachad[oa]s?)\b[^.!?\n]{0,40}\bnao (sera|vai ser) cobrad[oa]s?\b/g,
  /\b(will not|won't) be (shipped|charged)\b/g,
  /\b(will no longer|won't) (be )?(ship|shipped|delivered|charged|arrive)\b/g,
];
/** Condição no começo da frase ou depois de vírgula ("Se você confirmar, …"); não o "se" reflexivo. */
const CONDITIONAL_CUE =
  /(^|,)\s*(se|caso|quando|apos|depois que|assim que|uma vez|ao (cancelar|confirmar)|if|once|after|when)\b/;
/**
 * Na oração principal, depois da vírgula, o indicativo ou o verbo no passado relatam um fato:
 * "Se quiser conferir, o pedido já aparece como cancelado", "Após a sua confirmação, o pedido foi
 * cancelado", "Assim que recebi sua mensagem, cancelei o pedido".
 */
const INDICATIVE_BEFORE =
  /\b(foi|foram|ja foi|ja foram|ficou|ficaram|esta|estao|ja esta|ja estao|aparece como|aparecem como|consta como|constam como|was|were|is|are|has been|have been)\s+(?:\S+\s+){0,2}$/;
const PAST_VERB_CLAIM = /^[a-z]+(ei|ou|aram|i)\b/;
const SUBJECT_BEFORE = /\b(i|we|they|you)\s+$/;

const PERSON = String.raw`(atendente|atendimento humano|atendimento|humano|pessoa|equipe|especialista|agente|suporte|time de atendimento|setor)`;
const HANDOFF_CLAIMS = [
  new RegExp(
    String.raw`\b(transferi|transferimos|encaminhei|encaminhamos|passei|repassei|direcionei|acionei|chamei)\b[^.!?\n]{0,40}\b${PERSON}\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b(foi|foram|esta sendo|ja foi|ficou|esta)\s+(transferid|encaminhad|direcionad)[oa]s?\b[^.!?\n]{0,30}\b${PERSON}\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b(transferid|encaminhad)[oa]s?\s+(para|pra|ao|a)\s+(um|uma|o|a|nosso|nossa)?\s*${PERSON}\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b((um|uma|o|a|nosso|nossa)\s+${PERSON}|alguem\s+(do|da|de nosso|da nossa)\s+${PERSON})\s+(ja\s+)?(vai|ira|esta indo)\s+(te\s+|lhe\s+)?(falar|atender|continuar|responder|entrar em contato|chamar|ligar|retornar|procurar)`,
    'g',
  ),
  /\b(voce )?(ja )?esta na fila\b/g,
  /\bprotocolo\b[^.!?\n]{0,12}\batd\s?-?\s?\d+/g,
  /\b(i have|i've|we have|we've)\s+(transferred|forwarded|escalated)\b|\btransferred you\b/g,
];

/** Promessas sobre devolução de dinheiro: o agente não tem acesso nem autonomia sobre isso. */
const REFUND_TERM =
  /\b(estorno|estornad|reembols|refund|devolucao do (valor|dinheiro)|dinheiro (de volta|vai voltar|volta)|valor (sera|vai ser) devolvido|credito na fatura)/;
const REFUND_PROMISE =
  /\b(cai|caira|cair|sera|vai|volta|voltar|devolvid|creditad|aprovad|garantid|realizad|efetuad|feit|processad|imediat|automaticamente|em ate \d+|em \d+\s*(dias?|horas?)|\d+\s*dias? uteis|full refund|will get|will be)/;

/*
 * Ações que o agente não tem como executar (não há ferramenta para isso): mudar endereço, dados
 * de pagamento ou itens, reagendar a entrega, aplicar cupom ou desconto. Toda afirmação de que fez
 * é falsa, e o cliente agiria com base nela (esperar a entrega no endereço novo, contar com o
 * desconto). Verbo com objeto direto ("alterei o endereço") ou par substantivo-desfecho
 * ("endereço … atualizado ✅"), com as mesmas exceções de negação, hipótese e citação.
 */
const CHANGEABLE = String.raw`(endereco|cep|cadastro|telefone|email|forma de pagamento|cartao|tamanho|cor|item|itens|produto|data de entrega)`;
const DETERMINERS = String.raw`(?:(?:o|a|os|as|um|uma|seu|sua|seus|suas|para voce|pra voce|novo|nova|aqui|ja|agora|so|apenas|tambem|hoje|no sistema)\s+){0,4}`;
const ACTION_CLAIMS = [
  new RegExp(
    String.raw`\b(alterei|atualizei|mudei|corrigi|editei|troquei|substitui|ajustei|alteramos|atualizamos|mudamos|trocamos|alterou|atualizou|mudou|corrigiu|editou|trocou|substituiu|alteraram|atualizaram|mudaram|corrigiram|trocaram)\s+${DETERMINERS}${CHANGEABLE}\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b(reagendei|remarquei|adiantei|reagendamos)\s+${DETERMINERS}(entrega|data)\b`,
    'g',
  ),
  new RegExp(
    String.raw`\b(apliquei|liberei|emiti|gerei|concedi|aplicamos|liberamos|consegui|conseguimos|garanti|garantimos)\s+${DETERMINERS}(cupom|desconto|frete|nota fiscal|boleto|pix|credito|vale|brinde)\b`,
    'g',
  ),
  /\bnov[oa]\s+(endereco|cartao|forma de pagamento|telefone|email|cep)\b[^.!?\n]{0,20}\b(cadastrad|registrad|salv|confirmad|atualizad|aplicad)[oa]s?\b/g,
  /\b(i|we)(\s+have|'ve)?\s+(updated|changed|corrected|applied|rescheduled)\s+(your|the)\s+(address|payment|delivery|coupon|discount|size|item)\b/g,
];
const ACTION_SPANS: readonly SpanClaim[] = [
  {
    head: new RegExp(String.raw`\b${CHANGEABLE}\b`, 'g'),
    tail: /\b(alterad|atualizad|mudad|trocad|corrigid|editad|substituid|ajustad|reagendad|remarcad)[oa]s?\b/g,
    window: 40,
  },
  {
    head: /\b(entrega|prazo de entrega)\b/g,
    tail: /\b(reagendad|remarcad|adiad|antecipad|alterad|mudad)[oa]s?\b/g,
    window: 40,
  },
  {
    head: /\b(troca|devolucao|desconto|cupom|frete gratis|credito|vale compra)\b/g,
    tail: /\b(aprovad|confirmad|agendad|aplicad|liberad|autorizad|concedid)[oa]s?\b|✅/g,
    window: 30,
  },
  {
    head: /\b(address|delivery date|payment method|coupon|discount)\b/g,
    tail: /\b(updated|changed|corrected|rescheduled|applied)\b/g,
    window: 20,
  },
];

/*
 * Negação e hipótese só valem coladas na afirmação: entre elas, no máximo palavras vazias
 * ("não FOI cancelado", "nenhum DOS SEUS PEDIDOS FOI cancelado"). "Nem esquenta que tá cancelado"
 * e "Não demorou nada e já foi cancelado" afirmam.
 */
const FILLER = String.raw`(?:ainda|mais|te|lhe|me|dele|dela|deles|delas|registra|mostra|exibe|traz|foi|foram|esta|estao|ficou|ficaram|tinha|tem|sido|ser|estar|pode|podem|posso|consigo|o|a|os|as|do|da|dos|das|de|seu|sua|seus|suas|meu|minha|pedido|pedidos|ele|ela|eles|elas|isso|consta|constam|aparece|como|\d{6}|been|was|were|is|are|has|have|the|order|it)`;
const NEGATION_BEFORE = new RegExp(
  String.raw`\b(nao|nem|nunca|jamais|nada|nenhum|nenhuma|not|never|nothing)\s+(?:${FILLER}\s+){0,5}$|\bnao\s+(e|sao)\s+(?:${FILLER}\s+){0,2}$`,
);
/** Antes do substantivo de um par, só a negação do sujeito vale: "nenhum cancelamento foi feito". */
const NEGATED_SUBJECT_BEFORE = new RegExp(
  String.raw`\b(nenhum|nenhuma|nada de|sem)\s+(?:${FILLER}\s+){0,2}$`,
);
/**
 * "Não posso dizer que foi cancelado", "não consigo confirmar que o pedido 100102 está cancelado",
 * "não deveria ter dito que foi cancelado", "eu não disse que…", "não é verdade que…": a afirmação é
 * negada pelo verbo que a introduz. Entre a negação e o verbo, só auxiliares: "nem preciso dizer
 * que" e "não custa confirmar que" afirmam.
 */
/** Emoji e símbolos (pares substitutos e o bloco de símbolos): encerram a oração. */
const EMOJI = `${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdfff)}${String.fromCharCode(0x2600)}-${String.fromCharCode(0x27bf)}`;
const TOKEN = String.raw`(?!(?:mas|porem|porque|pois|e)\b)[^\s,;:!?.${EMOJI}]+`;
/** Fim de oração dentro de um par ou de uma condição. */
const CLAUSE_BREAK = new RegExp(String.raw`[,;:—–${EMOJI}]|\s-\s|\b(mas|porem|porque|pois)\b`);
const REPORT_AUXILIARY = String.raw`(?:posso|consigo|vou|devo|deveria|deveriamos|podemos|conseguimos|tenho|ha|da|como|para|pra|e|possivel|ter|sei|estou|irei|cheguei|a)`;
const NEGATED_REPORT_BEFORE = new RegExp(
  String.raw`\b(nao|nem|nunca)\s+(?:${REPORT_AUXILIARY}\s+){0,3}(dizer|dito|disse|falar|falei|afirmar|afirmado|afirmei|confirmar|confirmado|confirmei|informar|informado|informei|garantir|garanti|escrever|escrito|escrevi|responder|respondi)\s+que(\s+${TOKEN}){0,5}\s*$|\bnao\s+e\s+(verdade|correto|certo)\s+que(\s+${TOKEN}){0,5}\s*$`,
);
/**
 * Recusa de escrever o texto pedido: "não posso escrever uma mensagem dizendo que o pedido 100102
 * foi cancelado" (o modelo recusando o "conto" do atacante; visto nos evals).
 */
const NEGATED_WRITE_BEFORE = new RegExp(
  String.raw`\b(nao|nem|nunca)\s+(?:(?:posso|vou|consigo|devo|irei|podemos|vamos)\s+)?(?:escrever|enviar|mandar|criar|gerar|montar|produzir)\s+(?:(?:um|uma|o|a|esse|essa|este|esta|nenhum|nenhuma)\s+)?(?:mensagem|frase|resposta|texto|nota|historia|conto|json|aviso)\s+(?:dizendo|afirmando|informando|confirmando|falando)\s+que(\s+${TOKEN}){0,5}\s*$`,
);
/**
 * O que um texto recusado diria: "não consigo responder com esse JSON, porque ele afirmaria que o
 * pedido está cancelado". Só com o texto como sujeito: "eu diria que está cancelado" afirma.
 */
const ARTIFACT_WOULD_SAY_BEFORE = new RegExp(
  String.raw`\b(ele|ela|isso|isto|o json|a mensagem|a frase|o texto|a resposta)\s+(afirmaria|diria|significaria|indicaria|informaria|daria a entender)\s+que(\s+${TOKEN}){0,5}\s*$|\b(nao|nem)\s+(?:posso|vou|consigo|devo)\s+[^.!?\n]{0,40}\b(ela|ele|a frase|a mensagem|o texto|essa frase|essa mensagem)\s+(afirma|diz|informa|da a entender|significa)\s+que(\s+${TOKEN}){0,5}\s*$`,
);
/** "Não sei se o endereço foi atualizado", "não tenho como confirmar se…". */
const NEGATED_KNOWLEDGE_BEFORE = new RegExp(
  String.raw`\b(nao|nem)\s+(sei|sabemos|tenho como (saber|confirmar|verificar|ver)|consigo (saber|confirmar|verificar|ver|dizer)|da para (saber|confirmar|dizer)|posso (confirmar|garantir|afirmar|dizer))\s+se\s+(?:${FILLER}\s+){0,4}$`,
);
/** "Vale manter seu endereço atualizado": estado recomendado, não ação feita. */
const MAINTAIN_BEFORE =
  /\b(manter|mantenha|deixar|deixe|ter|tenha|estar com|esteja com)\s+(?:(?:o|a|os|as|seu|sua|seus|suas)\s+)?$/;
/** "O produto veio trocado": a queixa do cliente, não uma ação. */
const ARRIVED_BEFORE = /\b(veio|vieram|chegou|chegaram)\s+$/;
/**
 * Futuro e hipótese colados: "será cancelado", "pode ser cancelado", "quer que seja cancelado",
 * "para ser cancelado, o pedido precisa…". "Teve que ser cancelado", "levou um minuto pra ser
 * cancelado" e "had to be cancelled" afirmam.
 */
const HYPOTHETICAL_BEFORE =
  /\b(sera|serao|seja|sejam|for|forem|fosse|seria|(pode|podem|possa|poderia|puder|puderem|podendo|vai|vao|deve|devem|precisa|consigo|posso|para|pra)\s+(ser|ficar|seja|fique|sejam)|(will|would|can|could|may|might|should|must) be|needs? to be)\s+$/;
const DURATION_BEFORE =
  /\b(levou|demorou|bastou|bastaram|precisou)\b[^.!?\n]{0,40}\b(para|pra)\s+ser\s+$/;
/**
 * Subjuntivo só vale sob dúvida ou negação ("não tenho informação de que o pedido tenha sido
 * cancelado") ou numa relativa genérica ("um cancelamento que tenha sido confirmado"). "Fico feliz
 * que tenha sido cancelado" e "embora tenha sido cancelado" afirmam.
 */
const SUBJUNCTIVE_BEFORE =
  /\b((tenha|tenham|tiver|tiverem|tivesse|tivessem) sido|esteja|estejam|estivesse|estivessem)\s+$/;
const DOUBT_FRAME = new RegExp(
  String.raw`\b((nao|nem)\s+(?:(?:tenho|temos|ha|existe|consta|recebi|recebemos|vejo|encontrei|encontro|possuo|nenhuma|nenhum|qualquer)\s+){0,3}(informacao|registro|confirmacao|indicacao|sinal|evidencia|prova)\s+(?:de\s+)?que|(nenhum|nenhuma|sem)\s+(informacao|registro|confirmacao|indicacao|sinal|evidencia|prova)\s+(?:de\s+)?que|duvido que|nao consta que|nao parece que|como se)(\s+${TOKEN}){0,7}\s*$`,
);
const INDEFINITE_BEFORE = /\b(um|uma|qualquer|algum|alguma|nenhum|nenhuma)\s+$/;
/** "Ela não corresponde a um cancelamento realizado", "não houve cancelamento". */
const NEGATED_RELATION_BEFORE =
  /\b(nao|nem)\s+(corresponde|correspondem|condiz|condizem|equivale|equivalem|houve|existe|existiu|ha|teve)\s+(?:(?:a|ao|com|de|um|uma|o|algum|alguma|nenhum|nenhuma|qualquer)\s+){0,2}$/;
/**
 * Presente genérico, só com a condição ou o agente logo depois: "o cancelamento só é concluído se
 * você…", "o endereço só é alterado por um atendente". "Solicitado e aprovado" não é presente.
 */
const GENERIC_PRESENT_BEFORE = /\b(e|sao)\s+$/;
const SINGLE_GENERIC_PRESENT_BEFORE = /\b(so|somente|apenas)\s+(e|sao)\s+$/;
const AGENT_AFTER =
  /^\s*(por|pelo|pela)\s+(um|uma|o|a|nosso|nossa)?\s*(atendente|atendimento|equipe|loja|suporte|pessoa)/;
/** Particípios coordenados herdam o auxiliar: "deve ser feito e confirmado". */
const COORDINATED_PARTICIPLE = /\b[a-z]+(ad|id|eit|ert|ost)[oa]s?\s+e\s+$/;
/**
 * Condição restritiva: "só posso considerar o cancelamento confirmado quando você tocar no botão".
 * Vale só com as duas partes: "só posso considerar/dar como/tratar como" antes e a condição logo
 * depois ("se precisar" e "se quiser" não são condição do cancelamento).
 */
const RESTRICTIVE_BEFORE =
  /\b(so|somente|apenas)\s+(?:(?:(?:posso|pode|podemos|vou|consigo|da para|e possivel)\s+(?:considerar|dar como|tratar como)|considero|consideramos)\s+(?:(?:o|a|seu|sua|pedido|\d{6})\s+){0,3}|(?:confirmo|informo|digo|aviso|anuncio)\s+(?:que\s+)?(?:(?:um|uma|o|a|seu|sua|pedido)\s+){0,3}(?:(?:foi|esta|ficou)\s+)?)$/;
/** A condição vem logo depois e não está no passado ("quando você me pediu" é relato). */
const CONDITION_AFTER =
  /^\s*,?\s*(quando|se|depois que|apos|assim que|no momento em que|if|when|once|after)\b(?!\s+(?:voce\s+|vc\s+)?(precisar|quiser|queira|preferir|tiver|desejar|for o caso))(?![^.!?\n]{0,60}?\b\w{3,}(ou|eu|iu|aram|eram|iram)\b)/;
/**
 * A regra explicada, com a condição dentro do par: "só confirmo um cancelamento quando o sistema
 * informa que ele foi feito".
 */
const RULE_BEFORE =
  /\b(so|somente|apenas)\s+(?:(?:posso|consigo|vou)\s+)?(confirmo|informo|digo|aviso|anuncio|confirmar|informar|dizer|avisar|anunciar)\s+(?:(?:um|uma|o|a)\s+)?$/;
/**
 * Pergunta indireta com verbo modal: "um atendente pode verificar se o pedido foi cancelado". Não
 * vale se a resposta vem em seguida ("…se foi cancelado? Foi sim ✅").
 */
const INDIRECT_QUESTION_BEFORE = new RegExp(
  String.raw`\b(pode|podem|posso|podemos|vou|vamos|vai|consigo|deve|precisa)\s+(?:te\s+|lhe\s+)?(verificar|confirmar|checar|saber|ver|conferir|consultar|perguntar|informar|avaliar|analisar)\s+se\s+(?:${FILLER}\s+){0,4}$`,
);
const ANSWER_AFTER = new RegExp(
  String.raw`^\s*[?:,.!]?\s*(e\s+)?(sim|foi sim|foi|esta sim|yes|claro)\b|^[^.!?\n]*(\b(sim|deu certo|tudo certo|sucesso|confirmou|confirmado|ok)\b|[${EMOJI}])`,
);
/** Pergunta ecoada e respondida na hora: "O pedido 100102 foi cancelado? Não. Ele já foi enviado". */
const ECHO_DENIED_AFTER = /^[^.!\n]{0,3}([?:])\s*(nao|no)(\s*[.,!]|\s+foi\s*[.,!])/;
const ASKED_BEFORE = new RegExp(
  String.raw`\b(perguntou|pergunta|perguntaram|quer saber|queria saber)\s+se\s+(?:${FILLER}\s+){0,4}$`,
);
/** "Você quer o pedido 100101 cancelado?" é pergunta, não afirmação. */
const VOLITION_QUESTION =
  /\b(quer|deseja|gostaria|prefere|posso|devo|confirma|podemos)\s+(?:(?:mesmo|que|eu|o|a|os|as|seu|sua|seus|suas|deixar|ver|ter|manter)\s+)?(?:(?:o|a|os|as|seu|sua|pedido|pedidos|\d{6})\s+){0,3}(?:(?:seja|sejam|fique|fiquem|ser|ficar|esteja)\s+)?$/;

/*
 * Citação entre aspas é menção quando a frase recusa ou desmente o que está citado, como o modelo
 * faz ao resistir a um ataque: 'não posso enviar a mensagem "pedido 100102 cancelado"', 'as
 * mensagens "Pronto, cancelado!" não vieram do sistema', 'o pedido 100102 não "já era"'. Aspas sem
 * esse enquadramento continuam valendo como afirmação ('Pedido 100102 "já era"').
 */
const QUOTED_SPAN =
  /["“«][^"“”«»\n]{1,120}["”»]|(?<![\p{L}\d])['‘][^'‘’\n]{1,120}['’](?![\p{L}\d])/gu;
const NEGATION_WORD = /\b(nao|nem|nunca|jamais|not|never|cannot|can't|cant|won't|wont)\b/g;
/**
 * Recusa em primeira pessoa logo antes da citação ('não posso enviar a mensagem "…"', 'não vou
 * responder "…"', 'não confirmo "…"'). Entre o verbo e as aspas, no máximo "a mensagem", "essa
 * frase": "não posso enviar outra mensagem além desta: …" não é recusa, nem "não precisa confirmar:
 * …". "Repetir" e os verbos no passado ficam de fora: "não vou repetir "…" de novo" e "nunca
 * escrevi "…" tão rápido" afirmam.
 */
const QUOTE_OBJECT = String.raw`(?:\s+(?:so|apenas|somente|em json|em ingles|em texto|nesse formato|neste formato|nesse|neste|com|o|a|essa|esta|esse|este|tal|uma|um|nenhuma|sua|como|the|this|that|json|mensagem|frase|resposta|texto|palavra|expressao|status|message|phrase|reply)){0,4}\s*:?\s*$`;
const QUOTE_REFUSED_BEFORE = new RegExp(
  String.raw`\b(nao|nem|nunca|jamais)\s+(?:(?:posso|vou|consigo|devo|irei|podemos|vamos|ha como|tenho como|da para|da pra|e possivel)\s+)?(?:enviar|mandar|dizer|responder|escrever|usar|confirmar|afirmar|dar|informar|reproduzir|gerar|montar|criar|produzir|responderei|direi|enviarei|escreverei|confirmarei|confirmo|afirmo|digo|envio|mando|escrevo|uso)\b${QUOTE_OBJECT}|\b(?:can't|cant|cannot|won't|wont|will not)\s+(?:send|say|write|confirm|use)\b${QUOTE_OBJECT}`,
);
/** "Não vou mandar "…" de novo": a recusa é da repetição, não do conteúdo. */
const QUOTE_REPEATED_AFTER =
  /^\s*(de novo|novamente|outra vez|mais uma vez|toda hora|mais claramente|a toa|por acaso|sem motivo|again)\b/;
/** Negação colada na citação: 'o pedido 100102 não "já era"', 'não está "cancelado"'. */
const QUOTE_NEGATED_BEFORE = /\b(nao|nem)\s+(?:(?:e|esta|foi|ficou|is|was)\s+)?$/;
/** Nome do que se cita, junto da citação: 'as mensagens "…"', '"…" das mensagens acima'. */
const QUOTE_REFERENCE =
  /\b(mensagem|mensagens|resposta|respostas|frase|frases|texto|textos|aviso|avisos|fala|falas|palavra|palavras|termo|termos|messages?|replies)\b/;
/**
 * Desmentido logo depois da citação, sem verbo de ligação no meio: "… dessa conversa não
 * correspondem", "… das mensagens acima não valem", "…": ela é falsa". "A mensagem "…" está
 * certinha, não vale a pena se preocupar" não desmente nada.
 */
const DENIAL = String.raw`(?:\b(?:nao|nem)\s+(?:${FILLER}\s+){0,2}(?:vale(?! a pena)|valem|(?:vieram|veio) (?:do sistema|de mim|daqui|da loja)|correspond\w*|reflet\w*|condiz\w*|(?:e|sao) (?:verdade|real|reais|valida|validas|verdadeira|verdadeiras)|confirmei|confirmamos|executei|executamos|enviei|enviamos|escrevi|registr\w*|aconteceu|aconteceram|ocorreu|procede\w*|(?:enviad|escrit|gerad|mandad)[oa]s? (?:por mim|pelo sistema|pela loja|daqui)|(?:sao|foram) (?:respostas|mensagens) (?:minhas|do sistema|da loja))|\b(?:e|sao|foram|eram)\s+(?:falsa|falsas|falso|falsos|forjad[oa]s?|inventad[oa]s?|golpe|invalid[oa]s?))\b`;
const QUOTE_DENIED_AFTER = new RegExp(
  String.raw`^\s*(?:[:,]?\s*(?:ela|elas|eles|isso|essa|essas|esse|esses)\s+|[:,]\s*eu\s+)?(?:(?!(?:esta|estao|e|sao|foi|ficou|parece|is|was)\s)[^\s;:]+\s+){0,5}?${DENIAL}`,
);
/**
 * Toda recusa real traz o que é verdade ("ele já foi enviado", "não cancelei nada", "é falsa"):
 * sem isso, a citação não é tratada como menção.
 */
const NEGATED_CANCEL = new RegExp(
  String.raw`\b(nao|nem|nunca|nenhum|nenhuma|nada)\s+(?:${FILLER}\s+){0,4}(cancel\w*|executei|executamos|confirmei)`,
);
const FALSITY = /\b(falsa|falsas|falso|falsos|forjad[oa]s?|inventad[oa]s?|golpe)\b/;
/** O status real dito na resposta, com verbo: "ele já foi enviado", "consta como enviado". */
const STATUS_STATEMENT =
  /\b(esta|estao|foi|foram|ja foi|consta|constam|segue|seguem|continua|continuam|aparece|ficou)\s+(?:como\s+|ja\s+|em\s+)?(em processamento|processando|enviad[oa]s?|entregues?|aguardando pagamento|a caminho)\b(?!\s+(por mim|pelo sistema|pela loja|daqui))|\bnao\s+(foi|esta|foram|estao)\s+cancelad/;
/** "…não veio de mim, veio direto do sistema": o desmentido vira confirmação. */
const SOURCE_AFFIRMED =
  /(?<!\b(nao|nem)\s)\b(veio|vieram|foi gerad[oa]|foram gerad[oa]s|saiu|sairam)\s+(direto\s+)?(do|pelo)\s+sistema\b/;
const CONTRAST = /\b(mas|porem|contudo|entretanto|but)\b/;

/**
 * Links: com protocolo, "www." ou qualquer coisa com cara de domínio (o WhatsApp transforma
 * "loja-reembolso.com.br/pix" e "bit.ly/x" em link clicável).
 */
const URL_PATTERN =
  /(?:\bh[tx]{2}ps?:\/\/|\bwww\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|br|io|ly|me|app|xyz|info|site|online|link|co|gov|edu|shop|store|top|club|vip|click|biz)\b(?:\/\S*)?|\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\S*)?/gi;

/** O trecho antes de `index`, sem atravessar o começo da frase nem uma quebra de linha. */
const precededBy = (text: string, index: number, pattern: RegExp, window = 60): boolean => {
  const { start } = sentenceAround(text, index);
  return pattern.test(text.slice(Math.max(0, start, index - window), index));
};

/**
 * Fim de frase: . ! ? ; ou quebra de linha, exceto o ponto entre dígitos ("R$ 3.475,00"). Tratar o
 * separador de milhar como fim de frase separava o número do pedido da afirmação (visto nos evals).
 */
const SENTENCE_END = /[!?;\n]|\.(?!\d)|(?<!\d)\./g;

function sentenceAround(text: string, index: number): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(SENTENCE_END)) {
    if (match.index < index) start = match.index + 1;
    else {
      end = match.index;
      break;
    }
  }
  return { start, end };
}

/** Uma afirmação candidata: onde começa, onde termina e onde está a palavra que a fecha. */
interface Claim {
  readonly index: number;
  readonly end: number;
  /** Início do desfecho ("realizado" em "cancelamento … realizado"); igual a `index` nas simples. */
  readonly tailIndex: number;
}

function regexClaims(text: string, patterns: readonly RegExp[]): Claim[] {
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((m) => ({
      index: m.index,
      end: m.index + m[0].length,
      tailIndex: m.index,
    })),
  );
}

/** Todos os pares substantivo-desfecho da mesma frase, não só o primeiro de cada substantivo. */
function spanClaims(text: string, spans: readonly SpanClaim[]): Claim[] {
  return spans.flatMap(({ head, tail, window }) =>
    [...text.matchAll(head)].flatMap((h) => {
      const from = h.index + h[0].length;
      const raw = text.slice(from, from + window + 20);
      // Mesmo fim de frase do resto do guardrail: o ponto de "R$ 1.299,90" não corta o par.
      const cut = raw.search(/[!?;\n]|\.(?!\d)|(?<!\d)\./);
      const region = cut < 0 ? raw : raw.slice(0, cut);
      return [...region.matchAll(tail)]
        .filter((t) => t.index <= window)
        .map((t) => ({
          index: h.index,
          end: from + t.index + t[0].length,
          tailIndex: from + t.index,
        }));
    }),
  );
}

const lastSentenceOf = (text: string): string => text.split(/[.!?\n]/).at(-1) ?? '';
const firstSentenceOf = (text: string): { text: string; question: boolean } => {
  const cut = text.search(/[.!?\n]/);
  return cut < 0
    ? { text, question: false }
    : { text: text.slice(0, cut), question: text[cut] === '?' };
};
const edgeWords = (text: string, count: number, from: 'start' | 'end'): string => {
  const words = text.trim().split(/\s+/);
  return (from === 'end' ? words.slice(-count) : words.slice(0, count)).join(' ');
};

function corroboratesDenial(text: string): boolean {
  const outside = text.replace(QUOTED_SPAN, ' ');
  if (SOURCE_AFFIRMED.test(outside)) return false;
  return STATUS_STATEMENT.test(outside) || NEGATED_CANCEL.test(outside) || FALSITY.test(outside);
}

/** A afirmação está inteira dentro de uma citação que a resposta recusa ou desmente. */
function isQuotedMention(text: string, claim: Claim): boolean {
  for (const quote of text.matchAll(QUOTED_SPAN)) {
    const quoteEnd = quote.index + quote[0].length;
    if (claim.index < quote.index || claim.end > quoteEnd) continue;
    if (!corroboratesDenial(text)) return false;
    const before = lastSentenceOf(text.slice(Math.max(0, quote.index - 100), quote.index));
    const after = firstSentenceOf(text.slice(quoteEnd, quoteEnd + 140));
    const lastClause = before.split(/[,;:]/).at(-1) ?? '';
    const negations = lastClause.match(NEGATION_WORD)?.length ?? 0;
    const refused =
      negations === 1 &&
      (QUOTE_REFUSED_BEFORE.test(lastClause) || QUOTE_NEGATED_BEFORE.test(lastClause)) &&
      !QUOTE_REPEATED_AFTER.test(after.text);
    if (refused) return true;
    const named =
      QUOTE_REFERENCE.test(edgeWords(before, 8, 'end')) ||
      QUOTE_REFERENCE.test(edgeWords(after.text, 4, 'start'));
    return (
      negations === 0 &&
      named &&
      !after.question &&
      !CONTRAST.test(after.text) &&
      QUOTE_DENIED_AFTER.test(after.text)
    );
  }
  return false;
}

const isHypothetical = (prefix: string): boolean =>
  HYPOTHETICAL_BEFORE.test(prefix) && !DURATION_BEFORE.test(prefix);

/** O desfecho de um par: "o cancelamento NÃO FOI feito", "… só PODE SER feito e confirmado". */
function leadExcuses(lead: string): boolean {
  const uncoordinated = lead.replace(COORDINATED_PARTICIPLE, '');
  if (uncoordinated !== lead) return leadExcuses(uncoordinated);
  return (
    NEGATION_BEFORE.test(lead) ||
    NEGATED_REPORT_BEFORE.test(lead) ||
    isHypothetical(lead) ||
    ARRIVED_BEFORE.test(lead)
  );
}

/** Duas negações na mesma oração afirmam: "não é verdade que o pedido não foi cancelado". */
function doubleNegated(text: string, claim: Claim): boolean {
  const { start } = sentenceAround(text, claim.index);
  const clause =
    text
      .slice(start, claim.tailIndex)
      // "e" separa orações, mas "não e" é "não é" depois da normalização.
      .split(/[,;:]|\b(?:mas|porque|pois|nem)\b|(?<!\bnao )\be\b/)
      .at(-1) ?? '';
  return (clause.match(/\b(nao|nem|nunca|jamais)\b/g)?.length ?? 0) >= 2;
}

/** A condição fecha a frase, sem outra oração depois ("…quando ele é real, e o do 100102 foi"). */
function conditionClosesSentence(after: string): boolean {
  if (!CONDITION_AFTER.test(after)) return false;
  const rest = firstSentenceOf(after.replace(/^\s*,/, '')).text;
  return !CLAUSE_BREAK.test(rest) && !/\be\s+(o|a|esse|essa|este|esta)\b/.test(rest);
}

function subjunctiveExcused(text: string, claim: Claim): boolean {
  const prefix = text.slice(Math.max(0, claim.tailIndex - 160), claim.tailIndex);
  if (!SUBJUNCTIVE_BEFORE.test(prefix)) return false;
  if (DOUBT_FRAME.test(prefix)) return true;
  // Relativa genérica: "um cancelamento que tenha sido confirmado pelo sistema".
  const lead = text.slice(claim.index, claim.tailIndex);
  return (
    claim.tailIndex > claim.index &&
    /^\S+\s+que\s+\S+(\s+sido)?\s+$/.test(lead) &&
    INDEFINITE_BEFORE.test(text.slice(Math.max(0, claim.index - 20), claim.index))
  );
}

/** Afirmativa: nem negada nem hipotética (conferindo só o que está colado), nem citação recusada. */
function isAffirmative(text: string, claim: Claim): boolean {
  const { index } = claim;
  const isPair = claim.tailIndex > index;
  const lead = text.slice(index, claim.tailIndex);
  const after = text.slice(claim.end);
  // Num par, o que vem antes do substantivo só cobre o desfecho se não houver outra oração no meio.
  const headCovers = !isPair || !CLAUSE_BREAK.test(lead);
  if (!doubleNegated(text, claim)) {
    const negation = isPair ? NEGATED_SUBJECT_BEFORE : NEGATION_BEFORE;
    if (precededBy(text, index, negation)) return false;
    if (headCovers && precededBy(text, index, NEGATED_REPORT_BEFORE, 100)) return false;
    if (headCovers && precededBy(text, index, NEGATED_WRITE_BEFORE, 120)) return false;
    if (headCovers && precededBy(text, index, NEGATED_KNOWLEDGE_BEFORE, 80)) return false;
    if (subjunctiveExcused(text, claim)) return false;
    // A relação negada só cobre o desfecho colado: "não corresponde a um cancelamento realizado".
    if (precededBy(text, index, NEGATED_RELATION_BEFORE) && /^\S*\s*$/.test(lead)) return false;
    if (isPair && leadExcuses(lead)) return false;
  }
  if (headCovers && precededBy(text, index, ARTIFACT_WOULD_SAY_BEFORE, 100)) return false;
  if (isHypothetical(text.slice(Math.max(0, index - 30), index))) return false;
  if (headCovers && isPair && precededBy(text, index, MAINTAIN_BEFORE, 30)) return false;
  if (
    headCovers &&
    precededBy(text, index, INDIRECT_QUESTION_BEFORE) &&
    !ANSWER_AFTER.test(after)
  ) {
    return false;
  }
  const genericPresent = isPair
    ? GENERIC_PRESENT_BEFORE.test(lead) && !COORDINATED_PARTICIPLE.test(lead)
    : precededBy(text, index, SINGLE_GENERIC_PRESENT_BEFORE, 15);
  if (genericPresent && (conditionClosesSentence(after) || AGENT_AFTER.test(after))) return false;
  if (precededBy(text, index, RESTRICTIVE_BEFORE) && conditionClosesSentence(after)) return false;
  const ruleExplained =
    isPair &&
    precededBy(text, index, RULE_BEFORE) &&
    /\bquando\b/.test(lead) &&
    !CLAUSE_BREAK.test(lead) &&
    !/\b\w{3,}(ou|eu|iu|aram|eram|iram)\b/.test(lead);
  if (ruleExplained) return false;
  const echo = ECHO_DENIED_AFTER.exec(after);
  if (echo && (echo[1] === '?' || precededBy(text, index, ASKED_BEFORE))) return false;
  const { start, end } = sentenceAround(text, index);
  const volition = VOLITION_QUESTION.test(text.slice(start, index));
  if (text[end] === '?' && volition && !ANSWER_AFTER.test(text.slice(end))) return false;
  // Particípios coordenados herdam a exceção do primeiro: "afirma que foi cancelado e estornado".
  const coordinated = /\b([a-z]+(?:ad|id|eit|ert|ost)[oa]s?)\s+e\s+$/.exec(
    text.slice(Math.max(start, index - 40), index),
  );
  if (!isPair && coordinated) {
    const previous = index - coordinated[0].length;
    const inherited = {
      index: previous,
      end: previous + (coordinated[1]?.length ?? 0),
      tailIndex: previous,
    };
    if (!isAffirmative(text, inherited)) return false;
  }
  return !isQuotedMention(text, claim);
}

/** Número de pedido: 6 dígitos, inclusive escrito "100 102" ou "100.102". */
const ORDER_ID = /(?<![\d.,])\d{3}[.\s]?\d{3}(?!\d|[.,]\d)/g;
const NON_CANCELLED_STATUS =
  /\b(em processamento|processando|enviad[oa]|entregue|aguardando|ativo|continua|segue|a caminho|nao (foi|esta) cancelad)/;

interface OrderMention {
  readonly id: string;
  readonly index: number;
}

function orderMentions(text: string): OrderMention[] {
  return [...text.matchAll(ORDER_ID)].map((m) => ({ id: m[0].replace(/\D/g, ''), index: m.index }));
}

/**
 * Pedidos a que uma afirmação se refere. Na frase, todos os números citados, menos os que trazem
 * o próprio status ("o 100201 (em processamento) e o 100202 (cancelado)"): "O 100202 foi
 * cancelado, e o 100102 também" afirma sobre os dois. Sem número na frase, o mais próximo antes
 * dela na resposta (cabeçalho "*Pedido 100102*" e a linha "Status: cancelado"), ou o primeiro depois.
 */
function ordersReferencedBy(text: string, claim: Claim, mentions: OrderMention[]): string[] {
  const { index, end: claimEnd } = claim;
  const { start, end } = sentenceAround(text, index);
  const inSentence = mentions.filter((m) => m.index >= start && m.index < end);
  if (inSentence.length > 0) {
    return inSentence
      .filter((mention, i) => {
        const segmentEnd = inSentence[i + 1]?.index ?? end;
        const coversClaim = mention.index < claimEnd && segmentEnd > index;
        // "o 100102, que estava em processamento": status anterior, o pedido continua citado.
        const segment = text
          .slice(mention.index, segmentEnd)
          .replace(/\bque\s+estava(m)?\b[^,;.]*/g, ' ');
        return coversClaim || !NON_CANCELLED_STATUS.test(segment);
      })
      .map((m) => m.id);
  }
  const before = mentions.filter((m) => m.index < start).at(-1);
  if (before) return [before.id];
  const after = mentions.find((m) => m.index >= end);
  return after ? [after.id] : [];
}

/**
 * "Pedidos enviados, entregues ou cancelados não podem…": particípio no plural sem verbo antes e
 * sem número de pedido descreve uma categoria, não um pedido. "Seus pedidos FORAM cancelados" afirma.
 */
function isGenericCategory(text: string, claim: Claim): boolean {
  if (!text.slice(claim.index, claim.end).endsWith('s')) return false;
  const { start } = sentenceAround(text, claim.index);
  const before = text.slice(Math.max(start, claim.index - 40), claim.index);
  const after = text.slice(claim.end, claim.end + 30);
  const specific =
    /\b(foram|estao|ficaram|sao|tiveram|seus|suas|todos|dois|duas|tres|quatro|cinco|ambos|ambas|\d+|were|are|have been|your|both)\b/;
  // Categoria é sujeito de uma regra: "pedidos … cancelados NÃO PODEM ser…". Sozinho, é afirmação.
  const predicate =
    /^[^.!?\n]{0,60}\b(nao|podem|pode|sao|fica|ficam|segue|seguem|tem|precisa|precisam|devem|vale|valem|depende|dependem|cannot|can't|are)\b/;
  // "O estorno de pedidos cancelados…": o particípio qualifica outro substantivo.
  const modifier = /\bde\s+(pedidos|compras)\s+$/.test(before);
  return (
    !specific.test(before) && !/com sucesso|✅/.test(after) && (modifier || predicate.test(after))
  );
}

/** "O 100202 está cancelado. O 100102 também.": a frase elíptica seguinte herda a afirmação. */
const ELLIPSIS = /\b(tambem|igualmente|idem|too|as well)\b/;

/**
 * Explicação condicional ("assim que você confirmar, o cancelamento é concluído") não afirma. Com o
 * verbo no passado é relato: "depois que você confirmou, o pedido foi cancelado".
 */
const TEMPORAL_PAST =
  /\b(quando|apos|depois que|assim que|uma vez que|after|once|when)\b[^.!?\n]*?(\b\w{3,}(ou|eu|iu|aram|eram|iram)\b|\b(you|i|we)\s+\w+ed\b)/;
function isAssertion(text: string, claim: Claim): boolean {
  const { start } = sentenceAround(text, claim.index);
  const before = text.slice(start, claim.index);
  const cue = CONDITIONAL_CUE.exec(before);
  let conditional = cue !== null && !TEMPORAL_PAST.test(before);
  if (cue && conditional) {
    // Afirmação na oração principal (depois da vírgula que fecha a condição).
    const afterCue = before.slice(cue.index + cue[0].length);
    const inMainClause = afterCue.includes(',');
    const claimText = text.slice(claim.index, claim.end);
    const reported =
      INDICATIVE_BEFORE.test(text.slice(start, claim.tailIndex)) ||
      PAST_VERB_CLAIM.test(claimText) ||
      SUBJECT_BEFORE.test(before);
    if (inMainClause && reported) conditional = false;
  }
  return isAffirmative(text, claim) && !conditional;
}

function cancellationClaimsAreVerified(text: string, context: OutputGuardContext): boolean {
  const mentions = orderMentions(text);
  const claims = [
    ...regexClaims(text, CANCELLATION_CLAIMS),
    ...spanClaims(text, CANCELLATION_SPANS),
    ...regexClaims(text, CANCELLATION_CONSEQUENCES),
  ].filter((claim) => isAssertion(text, claim));
  return claims.every((claim) => {
    const referenced = ordersReferencedBy(text, claim, mentions);
    const { end } = sentenceAround(text, claim.index);
    const next = sentenceAround(text, end + 1);
    const nextSentence = text.slice(next.start, next.end);
    if (
      end < text.length &&
      ELLIPSIS.test(nextSentence) &&
      !NON_CANCELLED_STATUS.test(nextSentence)
    ) {
      referenced.push(
        ...mentions.filter((m) => m.index >= next.start && m.index < next.end).map((m) => m.id),
      );
    }
    if (referenced.length === 0 && isGenericCategory(text, claim)) return true;
    // O modelo nunca executa um cancelamento: uma afirmação sem número só pode se referir a um
    // pedido que ele acabou de consultar individualmente e que a API mostrou cancelado.
    if (referenced.length === 0) return context.verifiedThisTurn.size === 1;
    return referenced.every((id) => context.verifiedCancelledOrderIds.has(id));
  });
}

/** Estorno como assunto, não promessa: "decisão sobre reembolso", "política de estorno". */
const NEUTRAL_REFUND =
  /\b(decisao|decisoes|analise|avaliacao|verificacao|politica|regras?|duvidas?|detalhes)\s+(sobre|de|do|da|dos|das)\s+(o\s+|a\s+|qualquer\s+)?(reembolso|estorno|devolucao)/;

/**
 * Promessa de estorno, avaliada por oração: a negação só protege a oração em que está ("Não se
 * preocupe, o estorno cai em 5 dias úteis" promete).
 */
function hasRefundPromise(text: string): boolean {
  return text
    .split(/[.!?\n,;:]+/)
    .some(
      (clause) =>
        REFUND_TERM.test(clause) &&
        REFUND_PROMISE.test(clause) &&
        !/\b(nao|nem|nunca|sem)\b/.test(clause) &&
        !/^\s*(se|caso|quando|assim que)\b/.test(clause) &&
        !NEUTRAL_REFUND.test(clause),
    );
}

/** O canary não pode sair nem ofuscado: minúsculas, separado, invertido ou em base64. */
function leaksCanary(raw: string, normalized: string, canary: string): boolean {
  const code = canary
    .replace(/^CANARY-/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (code.length < 6) return raw.includes(canary);
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  if (compact.includes(code) || compact.includes(code.split('').reverse().join(''))) return true;
  return (raw.match(/[A-Za-z0-9+/]{12,}={0,2}/g) ?? []).some((token) => {
    const decoded = Buffer.from(token, 'base64').toString('utf8').toLowerCase();
    return decoded.replace(/[^a-z0-9]/g, '').includes(code);
  });
}

/** Ajustes de formato para mensagens de texto (WhatsApp/SMS). */
function normalizeFormat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  const cut = text.slice(0, MAX_OUTPUT_LENGTH);
  const lastSentence = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('! '),
  );
  return lastSentence > MAX_OUTPUT_LENGTH / 2
    ? cut.slice(0, lastSentence + 1)
    : `${cut.trimEnd()}…`;
}

export function guardOutput(raw: string, context: OutputGuardContext): OutputGuardResult {
  const blocked = (reason: OutputGuardReason): OutputGuardResult => ({
    action: 'blocked',
    text: '',
    reasons: [reason],
  });

  const formatted = normalizeFormat(raw);
  if (formatted === '') return blocked('empty');
  // As verificações valem para o que o cliente vai ler: o corte de tamanho vem antes delas (um
  // corte poderia tirar o "se você confirmar" de uma frase condicional).
  const shortened = truncate(formatted);

  const normalized = securityNormalize(shortened);
  const promptShingles = [...shingles(normalized)].filter((shingle) =>
    context.promptFingerprint?.has(shingle),
  );
  if (
    promptShingles.length >= MIN_PROMPT_SHINGLES ||
    leaksCanary(shortened, normalized, context.canary) ||
    INTERNAL_MARKERS.test(normalizeKeepingSeparators(shortened))
  ) {
    return blocked('prompt_leak');
  }
  if (!cancellationClaimsAreVerified(normalized, context)) {
    return blocked('unverified_cancellation_claim');
  }
  if (!context.handoffCreated) {
    const handoffClaims = regexClaims(normalized, HANDOFF_CLAIMS).filter((claim) =>
      isAssertion(normalized, claim),
    );
    if (handoffClaims.length > 0) return blocked('unverified_handoff_claim');
  }
  if (hasRefundPromise(normalized)) return blocked('refund_promise');
  const actionClaims = [
    ...regexClaims(normalized, ACTION_CLAIMS),
    ...spanClaims(normalized, ACTION_SPANS),
  ].filter((claim) => isAssertion(normalized, claim));
  if (actionClaims.length > 0) return blocked('unverified_action_claim');

  const reasons: OutputGuardReason[] = [];
  // O agente não envia links: um link na resposta só pode ter vindo de dado externo (phishing).
  // Dados pessoais antes dos links: o domínio de um e-mail não pode virar "[link removido]".
  const pii = redactPii(stripInvisible(shortened.normalize('NFKC')));
  if (pii.detected.length > 0) reasons.push('pii_redacted');
  const text = pii.text.replace(URL_PATTERN, '[link removido]');
  if (text !== pii.text) reasons.push('link_removed');
  if (shortened !== formatted) reasons.push('too_long');

  return { action: reasons.length > 0 ? 'modified' : 'pass', text, reasons };
}

/** Para os marcadores: normalizado, mas mantendo "_", "-" e "\" (separadores dos nomes internos). */
function normalizeKeepingSeparators(text: string): string {
  return stripInvisible(text.normalize('NFKC'))
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}
