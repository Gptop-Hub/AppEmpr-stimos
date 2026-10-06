const fs = require('fs');
const db = require('../models/database');
const { allAsync, runAsync } = require('../utils/sqliteAsync');
const { ensureActionContractReady } = require('./actionIdentityService');
const {
  iniciarAcao,
  registrarSnapshot,
  finalizarAcaoAplicada,
} = require('./actionService');
const { ACTION_TYPES } = require('./actionTypeContract');
const { gerarNotificacoesParaData } = require('./notificacoesService');
const { lerConfig, salvarConfig, getConfigPath } = require('../config/notificacoesConfig');

function normalizarNotificacao(row) {
  return {
    id: Number(row.id),
    tipo: row.tipo,
    status: row.status,
    parcela_id: row.parcela_id == null ? null : Number(row.parcela_id),
    emprestimo_id: row.emprestimo_id == null ? null : Number(row.emprestimo_id),
    data_referencia: row.data_referencia,
  };
}

async function lerEstadoNotificacoes() {
  const rows = await allAsync(
    db,
    `SELECT id, tipo, status, parcela_id, emprestimo_id, data_referencia
       FROM notificacoes ORDER BY id ASC`
  );
  return rows.map(normalizarNotificacao);
}

function resumirNotificacoes(rows) {
  const porStatus = {};
  const porTipo = {};
  for (const row of rows) {
    porStatus[row.status] = (porStatus[row.status] || 0) + 1;
    porTipo[row.tipo] = (porTipo[row.tipo] || 0) + 1;
  }
  return { total: rows.length, por_status: porStatus, por_tipo: porTipo };
}

function diferenciarNotificacoes(antes, depois) {
  const antesPorId = new Map(antes.map((item) => [item.id, item]));
  const depoisPorId = new Map(depois.map((item) => [item.id, item]));
  const criadas = depois.filter((item) => !antesPorId.has(item.id));
  const removidas = antes.filter((item) => !depoisPorId.has(item.id));
  const atualizadas = depois.filter((item) => {
    const anterior = antesPorId.get(item.id);
    return anterior && (
      anterior.tipo !== item.tipo ||
      anterior.status !== item.status ||
      anterior.parcela_id !== item.parcela_id ||
      anterior.emprestimo_id !== item.emprestimo_id ||
      anterior.data_referencia !== item.data_referencia
    );
  });
  return { criadas, removidas, atualizadas };
}

async function registrarAcaoGlobal({ tipo, resumo, antes, depois, metadata, entidade = 'notificacoes_execucao' }) {
  const action = await iniciarAcao({ tipo, origem: 'interface', resumo, metadata }, { dbHandle: db });
  // Não há entidade de notificacao/configuracao com UID transportável. O ID do
  // contexto é o da própria ação e não cria vínculo em `acao_entidades`.
  await registrarSnapshot(action, {
    momento: 'antes', entidade, entidade_id: action.actionId, dados: antes,
  });
  await registrarSnapshot(action, {
    momento: 'depois', entidade, entidade_id: action.actionId, dados: depois,
  });
  return finalizarAcaoAplicada(action);
}

async function gerarNotificacoesExplicitamente(dataBaseISO) {
  await ensureActionContractReady(db);
  let emTransacao = false;
  try {
    await runAsync(db, 'BEGIN IMMEDIATE');
    emTransacao = true;
    const [notificacoesAntes, configUtilizada] = await Promise.all([
      lerEstadoNotificacoes(), lerConfig(),
    ]);
    const resultado = await gerarNotificacoesParaData(dataBaseISO);
    const notificacoesDepois = await lerEstadoNotificacoes();
    const alteracoes = diferenciarNotificacoes(notificacoesAntes, notificacoesDepois);
    const entrada = {
      data_solicitada: dataBaseISO || null,
      data_utilizada: resultado.dataBase,
      parametros: {
        incluir_clientes_com_notificacoes_desligadas: false,
        configuracao: configUtilizada,
      },
    };
    await registrarAcaoGlobal({
      tipo: ACTION_TYPES.NOTIFICACOES_GERADAS,
      resumo: `Notificacoes geradas para ${resultado.dataBase}`,
      antes: { estado: resumirNotificacoes(notificacoesAntes), entrada },
      depois: {
        estado: resumirNotificacoes(notificacoesDepois),
        resultado: {
          ...resultado,
          criadas: alteracoes.criadas.map((item) => item.id),
          removidas: alteracoes.removidas.map((item) => item.id),
          atualizadas: alteracoes.atualizadas.map((item) => item.id),
          contagens: {
            criadas: alteracoes.criadas.length,
            removidas: alteracoes.removidas.length,
            atualizadas: alteracoes.atualizadas.length,
          },
        },
      },
      metadata: { entrada },
    });
    await runAsync(db, 'COMMIT');
    emTransacao = false;
    return resultado;
  } catch (error) {
    if (emTransacao) await runAsync(db, 'ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function capturarArquivoConfig() {
  const arquivo = getConfigPath();
  try {
    return { arquivo, existe: true, conteudo: await fs.promises.readFile(arquivo) };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { arquivo, existe: false, conteudo: null };
    throw error;
  }
}

async function restaurarArquivoConfig(backup) {
  if (backup.existe) {
    await fs.promises.writeFile(backup.arquivo, backup.conteudo);
    return;
  }
  await fs.promises.unlink(backup.arquivo).catch((error) => {
    if (!error || error.code !== 'ENOENT') throw error;
  });
}

async function salvarConfiguracaoNotificacoesComAcao(configSolicitada, operacao) {
  const backup = await capturarArquivoConfig();
  let arquivoAlterado = false;
  let emTransacao = false;
  try {
    await ensureActionContractReady(db);
    await runAsync(db, 'BEGIN IMMEDIATE');
    emTransacao = true;
    const antes = await lerConfig();
    const depois = await salvarConfig(configSolicitada);
    arquivoAlterado = true;
    const entrada = { configuracao: configSolicitada, operacao };
    await registrarAcaoGlobal({
      tipo: ACTION_TYPES.CONFIG_NOTIFICACOES_ATUALIZADA,
      resumo: operacao === 'restaurar_padrao'
        ? 'Configuracoes de notificacoes restauradas para o padrao'
        : 'Configuracoes de notificacoes atualizadas',
      antes: { configuracao: antes, entrada },
      depois: { configuracao: depois },
      metadata: { operacao, configuracao_solicitada: configSolicitada },
      entidade: 'configuracoes_notificacoes',
    });
    await runAsync(db, 'COMMIT');
    emTransacao = false;
    return depois;
  } catch (error) {
    if (emTransacao) await runAsync(db, 'ROLLBACK').catch(() => undefined);
    if (arquivoAlterado) {
      try {
        await restaurarArquivoConfig(backup);
      } catch (restoreError) {
        console.error('[notificacoes/config] falha ao compensar arquivo:', restoreError.message);
      }
    }
    throw error;
  }
}

module.exports = {
  gerarNotificacoesExplicitamente,
  salvarConfiguracaoNotificacoesComAcao,
  __test: { diferenciarNotificacoes, resumirNotificacoes },
};
