const { ACTION_TYPES, canonicalActionType } = require('./actionTypeContract');

/**
 * Catálogo do futuro canal de sincronização. Ele é separado do catálogo do
 * Motor de Ações porque o canal pode conhecer tipos emitidos por outro
 * dispositivo antes de o PC passar a emiti-los localmente.
 */
const SYNC_DOMAIN_TYPES = Object.freeze([
  ACTION_TYPES.PARCELAS_REAGENDADAS,
  ACTION_TYPES.DESPESA_CRIADA,
  ACTION_TYPES.DESPESA_EXCLUIDA,
  ACTION_TYPES.EMPRESTIMO_CRIADO,
  ACTION_TYPES.EMPRESTIMO_EDITADO,
  ACTION_TYPES.CAPITAL_ADICIONADO,
  ACTION_TYPES.EMPRESTIMO_RENEGOCIADO,
  ACTION_TYPES.PAGAMENTO_NORMAL_REGISTRADO,
  ACTION_TYPES.PAGAMENTO_MANUAL_REGISTRADO,
  'PAGAMENTO_MANUAL_RENEGOCIADO',
  ACTION_TYPES.JUROS_REGISTRADOS,
  ACTION_TYPES.JUROS_PARCIAIS_REGISTRADOS,
  ACTION_TYPES.EMPRESTIMO_QUITADO,
  ACTION_TYPES.CLIENTE_CRIADO,
  ACTION_TYPES.CLIENTE_EDITADO,
  ACTION_TYPES.CLIENTE_EXCLUIDO,
  ACTION_TYPES.CLIENTE_TELEFONE_ADICIONADO,
  ACTION_TYPES.CLIENTE_FOTO_ATUALIZADA,
  ACTION_TYPES.CLIENTE_MAL_PAGADOR_ATUALIZADO,
  ACTION_TYPES.CLIENTE_PREFERENCIA_COBRANCA_ATUALIZADA,
  ACTION_TYPES.JUROS_ADICIONAIS_ADICIONADOS,
  ACTION_TYPES.EMPRESTIMO_EXCLUIDO,
]);

const LOCAL_ONLY_TYPES = Object.freeze([
  ACTION_TYPES.NOTIFICACOES_GERADAS,
  'NOTIFICACAO_MARCADA_LIDA',
  ACTION_TYPES.CONFIG_NOTIFICACOES_ATUALIZADA,
]);

const SYNC_DOMAIN_SET = new Set(SYNC_DOMAIN_TYPES);
const LOCAL_ONLY_SET = new Set(LOCAL_ONLY_TYPES);

function classifyActionType(type) {
  const canonical = canonicalActionType(type);
  if (SYNC_DOMAIN_SET.has(canonical)) return 'SYNC_DOMAIN';
  if (LOCAL_ONLY_SET.has(canonical)) return 'LOCAL_ONLY';
  return null;
}

function isCanonicalPortableType(type) {
  const value = String(type || '').trim();
  return Boolean(value) && value === canonicalActionType(value) && classifyActionType(value) !== null;
}

module.exports = {
  SYNC_DOMAIN_TYPES,
  LOCAL_ONLY_TYPES,
  classifyActionType,
  isCanonicalPortableType,
};
