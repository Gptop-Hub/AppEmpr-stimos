/**
 * Contrato de tipos transportaveis do Motor de Acoes.
 *
 * `tipo` e imutavel no historico. Por isso aliases anteriores nao sao
 * regravados: a leitura informa seu tipo canonico e novas acoes ja nascem
 * com o identificador compartilhado pelo PC e pelo celular.
 */
const ACTION_TYPES = Object.freeze({
  PARCELAS_REAGENDADAS: 'PARCELAS_REAGENDADAS',
  DESPESA_CRIADA: 'DESPESA_CRIADA',
  DESPESA_EXCLUIDA: 'DESPESA_EXCLUIDA',
  EMPRESTIMO_CRIADO: 'EMPRESTIMO_CRIADO',
  EMPRESTIMO_EDITADO: 'EMPRESTIMO_EDITADO',
  CAPITAL_ADICIONADO: 'CAPITAL_ADICIONADO',
  EMPRESTIMO_RENEGOCIADO: 'EMPRESTIMO_RENEGOCIADO',
  PAGAMENTO_NORMAL_REGISTRADO: 'PAGAMENTO_NORMAL_REGISTRADO',
  PAGAMENTO_MANUAL_REGISTRADO: 'PAGAMENTO_MANUAL_REGISTRADO',
  JUROS_REGISTRADOS: 'JUROS_REGISTRADOS',
  JUROS_PARCIAIS_REGISTRADOS: 'JUROS_PARCIAIS_REGISTRADOS',
  EMPRESTIMO_QUITADO: 'EMPRESTIMO_QUITADO',
  CLIENTE_CRIADO: 'CLIENTE_CRIADO',
  CLIENTE_EDITADO: 'CLIENTE_EDITADO',
  CLIENTE_EXCLUIDO: 'CLIENTE_EXCLUIDO',
  CLIENTE_TELEFONE_ADICIONADO: 'CLIENTE_TELEFONE_ADICIONADO',
  CLIENTE_FOTO_ATUALIZADA: 'CLIENTE_FOTO_ATUALIZADA',
  CLIENTE_MAL_PAGADOR_ATUALIZADO: 'CLIENTE_MAL_PAGADOR_ATUALIZADO',
  CLIENTE_PREFERENCIA_COBRANCA_ATUALIZADA: 'CLIENTE_PREFERENCIA_COBRANCA_ATUALIZADA',
  NOTIFICACOES_GERADAS: 'NOTIFICACOES_GERADAS',
  CONFIG_NOTIFICACOES_ATUALIZADA: 'CONFIG_NOTIFICACOES_ATUALIZADA',
  JUROS_ADICIONAIS_ADICIONADOS: 'JUROS_ADICIONAIS_ADICIONADOS',
  EMPRESTIMO_EXCLUIDO: 'EMPRESTIMO_EXCLUIDO',
});

const LEGACY_TO_CANONICAL = Object.freeze({
  despesa_criada: ACTION_TYPES.DESPESA_CRIADA,
  despesa_excluida: ACTION_TYPES.DESPESA_EXCLUIDA,
  reagendamento_parcela: ACTION_TYPES.PARCELAS_REAGENDADAS,
  reagendamento_cascata: ACTION_TYPES.PARCELAS_REAGENDADAS,
  alteracao_dia_vencimento: ACTION_TYPES.PARCELAS_REAGENDADAS,
});

const aliasesByCanonical = Object.freeze(Object.keys(LEGACY_TO_CANONICAL).reduce((result, legacy) => {
  const canonical = LEGACY_TO_CANONICAL[legacy];
  result[canonical].push(legacy);
  return result;
}, Object.values(ACTION_TYPES).reduce((result, canonical) => {
  result[canonical] = [canonical];
  return result;
}, {})));

function canonicalActionType(type) {
  const value = String(type || '').trim();
  return LEGACY_TO_CANONICAL[value] || value;
}

function compatibleActionTypes(type) {
  const canonical = canonicalActionType(type);
  return aliasesByCanonical[canonical] || [canonical];
}

module.exports = {
  ACTION_TYPES,
  LEGACY_TO_CANONICAL,
  canonicalActionType,
  compatibleActionTypes,
};
