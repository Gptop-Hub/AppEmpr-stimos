const db = require('../models/database');
const { lerConfig, DEFAULT_CONFIG } = require('../config/notificacoesConfig');

const LIMITE_MUITO_ATRASADA = 30; // dias corridos
const TIPO_RECALCULADO_EM_ABERTO = 'recalculado_em_aberto';
const TIPOS_VENCIMENTO = [
  'parcela_vence_hoje',
  'parcela_vence_em_breve',
  'parcela_atrasada',
  'parcela_muito_atrasada',
];

function hojeISO() {
  // Usa data local para evitar adiantamento pelo UTC
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10); // YYYY-MM-DD
}

// diferenÃ§a em dias: vencimento - hoje
function diffDias(vencISO, hojeISO) {
  const d1 = new Date(vencISO + 'T00:00:00');
  const d2 = new Date(hojeISO + 'T00:00:00');
  const ms = d1.getTime() - d2.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function calcularTotalDevido(parcela) {
  const valorTotal = Number(parcela?.valor_total || 0);
  const valorCapital = Number(parcela?.valor_capital || 0);
  const valorJuros = Number(parcela?.valor_juros || 0);
  const jurosAdicionais = Number(parcela?.juros_adicionais || 0);
  const jurosPendentes = Number(parcela?.juros_pendentes || 0);

  if (Number.isFinite(valorTotal) && valorTotal > 0) {
    return valorTotal + (Number.isFinite(jurosAdicionais) ? jurosAdicionais : 0);
  }

  return (
    (Number.isFinite(valorCapital) ? valorCapital : 0) +
    (Number.isFinite(valorJuros) ? valorJuros : 0) +
    (Number.isFinite(jurosAdicionais) ? jurosAdicionais : 0) +
    (Number.isFinite(jurosPendentes) ? jurosPendentes : 0)
  );
}

function isParcelaEmAberto(parcela) {
  const pagoFlag =
    parcela?.pago === 1 ||
    parcela?.pago === '1' ||
    parcela?.pago === true;

  if (pagoFlag) return false;

  const valorPago = Number(parcela?.valor_pago || 0);
  const totalDevido = calcularTotalDevido(parcela);

  if (!Number.isFinite(totalDevido) || totalDevido <= 0) return true;
  if (!Number.isFinite(valorPago)) return true;

  return valorPago + 0.009 < totalDevido;
}

function criarNotificacaoSeNaoExiste({
  tipo,
  titulo,
  mensagem,
  data_referencia,
  emprestimo_id,
  parcela_id,
}) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT OR IGNORE INTO notificacoes
        (tipo, titulo, mensagem, data_referencia, emprestimo_id, parcela_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    db.run(
      sql,
      [tipo, titulo, mensagem, data_referencia, emprestimo_id, parcela_id],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0); // true se inseriu, false se jÃ¡ existia
      }
    );
  });
}

function existeNotificacaoPendente(tipo, parcela_id) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT 1
      FROM notificacoes
      WHERE status = 'pendente'
        AND tipo = ?
        AND parcela_id = ?
      LIMIT 1
    `,
      [tipo, parcela_id],
      (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      }
    );
  });
}

function descartarNotificacaoPendente(tipo, parcela_id) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      UPDATE notificacoes
      SET status = 'descartada'
      WHERE status = 'pendente'
        AND tipo = ?
        AND parcela_id = ?
    `,
      [tipo, parcela_id],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

async function descartarTiposPendentes(tipos = [], parcela_id) {
  if (!parcela_id) return;
  for (const tipo of tipos) {
    await descartarNotificacaoPendente(tipo, parcela_id);
  }
}

/**
 * Gera notificaÃ§Ãµes de parcelas vencendo/atrasadas para uma data base.
 * @param {string} [dataBaseISO] 'YYYY-MM-DD' â€“ se nÃ£o vier, usa hoje real
 */
async function gerarNotificacoesParaData(
  dataBaseISO,
  { incluirClientesComNotificacoesDesligadas = false } = {}
) {
  const hoje = dataBaseISO || hojeISO();
  const config = await lerConfig().catch(() => ({ ...DEFAULT_CONFIG }));

  const clamp = (val, min, max, fallback) => {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };

  const venceEmBreveDias = clamp(
    config.venceEmBreveDias,
    1,
    365,
    DEFAULT_CONFIG.venceEmBreveDias
  );

  return new Promise((resolve, reject) => {
    const sql = `
      SELECT 
        p.id AS parcela_id,
        p.emprestimo_id,
        p.vencimento,
        p.pago,
        p.valor_pago,
        p.valor_total,
        p.valor_capital,
        p.valor_juros,
        p.juros_adicionais,
        p.juros_pendentes,
        p.numero AS parcela_numero,
        c.nome AS cliente_nome,
        COALESCE(c.mal_pagador, 0) AS cliente_mal_pagador,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM recalculos_atraso ra
            WHERE ra.emprestimo_id = p.emprestimo_id
              AND ra.parcela_destino_id = p.id
          ) THEN 1
          ELSE 0
        END AS is_recalculado_em_aberto
      FROM parcelas p
      JOIN emprestimos e ON e.id = p.emprestimo_id
      JOIN clientes c ON c.id = e.cliente_id
      WHERE (p.numero IS NULL OR p.numero != -1)
        ${
          incluirClientesComNotificacoesDesligadas
            ? ''
            : 'AND COALESCE(c.receber_notificacoes_cobranca, 1) = 1'
        }
        AND (p.versao IS NULL OR p.versao = e.versao_atual)
        AND p.id = (
          SELECT MAX(p2.id)
          FROM parcelas p2
          WHERE p2.emprestimo_id = p.emprestimo_id
            AND p2.numero = p.numero
            AND (p2.versao IS NULL OR p2.versao = e.versao_atual)
        )
      ORDER BY p.emprestimo_id, p.numero
    `;

    db.all(sql, async (err, rows) => {
      if (err) return reject(err);

      let criadas = 0;

      for (const p of rows || []) {
        if (Number(p.parcela_numero) === -1) continue;
        if (!isParcelaEmAberto(p)) continue;

        const vencISO = (p.vencimento || '').slice(0, 10);
        if (!vencISO) continue;

        const dDias = diffDias(vencISO, hoje);
        const isRecalculadoEmAberto =
          p.is_recalculado_em_aberto === 1 ||
          p.is_recalculado_em_aberto === '1' ||
          p.is_recalculado_em_aberto === true;

        const notificacoesDesejadas = [];

        if (isRecalculadoEmAberto) {
          notificacoesDesejadas.push({
            tipo: TIPO_RECALCULADO_EM_ABERTO,
            titulo: 'Recalculado em aberto',
            mensagem: `A parcela do emprestimo #${p.emprestimo_id} (cliente ${p.cliente_nome}) foi recalculada e continua em aberto.`,
          });
        }

        if (dDias === 0) {
          notificacoesDesejadas.push({
            tipo: 'parcela_vence_hoje',
            titulo: 'Parcela vence hoje',
            mensagem: `A parcela do emprestimo #${p.emprestimo_id} (cliente ${p.cliente_nome}) vence hoje (${vencISO}).`,
          });
        } else if (dDias > 0 && dDias <= venceEmBreveDias) {
          notificacoesDesejadas.push({
            tipo: 'parcela_vence_em_breve',
            titulo: 'Parcela vence em breve',
            mensagem: `A parcela do emprestimo #${p.emprestimo_id} (cliente ${p.cliente_nome}) vence em ${dDias} dia(s) (${vencISO}).`,
          });
        } else if (dDias < 0) {
          const atraso = Math.abs(dDias);
          if (atraso > LIMITE_MUITO_ATRASADA) {
            notificacoesDesejadas.push({
              tipo: 'parcela_muito_atrasada',
              titulo: 'Parcela muito atrasada',
              mensagem: `A parcela do emprestimo #${p.emprestimo_id} (cliente ${p.cliente_nome}) esta muito atrasada desde ${vencISO} (mais de ${LIMITE_MUITO_ATRASADA} dias).`,
            });
          } else {
            notificacoesDesejadas.push({
              tipo: 'parcela_atrasada',
              titulo: 'Parcela em atraso',
              mensagem: `A parcela do emprestimo #${p.emprestimo_id} (cliente ${p.cliente_nome}) esta atrasada desde ${vencISO}.`,
            });
          }
        }

        if (!notificacoesDesejadas.length) continue;

        try {
          const notifVencimentoAtual = notificacoesDesejadas.find((n) =>
            TIPOS_VENCIMENTO.includes(n.tipo)
          );

          if (p.parcela_id && notifVencimentoAtual) {
            const outrosTiposVencimento = TIPOS_VENCIMENTO.filter(
              (tipoAtual) => tipoAtual !== notifVencimentoAtual.tipo
            );
            await descartarTiposPendentes(outrosTiposVencimento, p.parcela_id);
          }

          for (const notif of notificacoesDesejadas) {
            if (p.parcela_id) {
              const pendenteExiste = await existeNotificacaoPendente(
                notif.tipo,
                p.parcela_id
              );
              if (pendenteExiste) continue;
            }

            const inseriu = await criarNotificacaoSeNaoExiste({
              tipo: notif.tipo,
              titulo: notif.titulo,
              mensagem: notif.mensagem,
              data_referencia: hoje,
              emprestimo_id: p.emprestimo_id,
              parcela_id: p.parcela_id,
            });
            if (inseriu) criadas += 1;
          }
        } catch (e) {
          console.error('[notificacoes] erro ao criar notificacao:', e);
        }
      }

      resolve({ criadas, dataBase: hoje });
    });
  });
}

function addDiasISO(iso, dias) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + Number(dias || 0));
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

async function listarNotificacoesPendentes({
  incluirClientesComNotificacoesDesligadas = false,
} = {}) {
  const hoje = hojeISO();
  const config = await lerConfig().catch(() => ({ ...DEFAULT_CONFIG }));
  const venceEmBreveDias = Number(config.venceEmBreveDias || DEFAULT_CONFIG.venceEmBreveDias || 3);

  return new Promise((resolve, reject) => {
    db.all(
      `
      WITH ativa AS (
        SELECT 
          p.emprestimo_id, 
          p.numero, 
          MAX(p.id) AS parcela_id_ativa
        FROM parcelas p
        JOIN emprestimos e ON e.id = p.emprestimo_id
        WHERE (p.numero IS NULL OR p.numero != -1)
          AND (p.versao IS NULL OR p.versao = e.versao_atual)
        GROUP BY p.emprestimo_id, p.numero
      )
      SELECT 
        n.*,
        c.id AS cliente_id,
        c.nome AS cliente_nome,
        c.telefone AS cliente_telefone,
        c.endereco AS cliente_endereco,
        COALESCE(c.mal_pagador, 0) AS cliente_mal_pagador,
        COALESCE(c.receber_notificacoes_cobranca, 1) AS cliente_receber_notificacoes_cobranca,
        e.observacao AS emprestimo_observacao,
        p.numero AS parcela_numero,
        p.vencimento AS parcela_vencimento,
        p.valor_total AS parcela_valor_total,
        p.valor_pago AS parcela_valor_pago,
        p.pago AS parcela_pago,
        p.valor_capital AS parcela_valor_capital,
        p.valor_juros AS parcela_valor_juros,
        p.juros_pendentes AS parcela_juros_pendentes,
        p.juros_adicionais AS parcela_juros_adicionais,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM recalculos_atraso ra
            WHERE ra.emprestimo_id = p.emprestimo_id
              AND ra.parcela_destino_id = p.id
          ) THEN 1
          ELSE 0
        END AS is_recalculado_em_aberto
      FROM notificacoes n
      JOIN parcelas p ON p.id = n.parcela_id
      JOIN ativa a 
        ON a.emprestimo_id = p.emprestimo_id
       AND (a.numero = p.numero OR (a.numero IS NULL AND p.numero IS NULL))
       AND a.parcela_id_ativa = p.id
      LEFT JOIN emprestimos e ON e.id = n.emprestimo_id
      LEFT JOIN clientes c ON c.id = e.cliente_id
      WHERE n.status = 'pendente'
        ${
          incluirClientesComNotificacoesDesligadas
            ? ''
            : 'AND COALESCE(c.receber_notificacoes_cobranca, 1) = 1'
        }
      ORDER BY 
        c.nome COLLATE NOCASE ASC,
        n.criado_em DESC
    `,
      [],
      (err, rows) => {
        if (err) return reject(err);
        const normalizadas = (rows || []).map((n) => {
          const isRecalculado =
            n.is_recalculado_em_aberto === 1 ||
            n.is_recalculado_em_aberto === '1' ||
            n.is_recalculado_em_aberto === true;
          const tipoNormalizado = n.tipo;

          return {
            ...n,
            tipo: tipoNormalizado,
            is_recalculado_em_aberto: isRecalculado,
            isRecalculado,
          };
        });

        const filtradas = normalizadas.filter((n) => {
          if (
            !isParcelaEmAberto({
              pago: n.parcela_pago,
              valor_pago: n.parcela_valor_pago,
              valor_total: n.parcela_valor_total,
              valor_capital: n.parcela_valor_capital,
              valor_juros: n.parcela_valor_juros,
              juros_adicionais: n.parcela_juros_adicionais,
              juros_pendentes: n.parcela_juros_pendentes,
            })
          ) {
            return false;
          }

          if (n.tipo === TIPO_RECALCULADO_EM_ABERTO) {
            return n.isRecalculado;
          }

          const vencISO = (n.parcela_vencimento || '').slice(0, 10);
          const diff = vencISO ? diffDias(vencISO, hoje) : null;
          if (!vencISO || diff === null || diff === undefined) return false;

          if (n.tipo === 'parcela_vence_hoje') {
            return diff === 0;
          }

          if (n.tipo === 'parcela_vence_em_breve') {
            return diff > 0 && diff <= venceEmBreveDias;
          }

          if (n.tipo === 'parcela_atrasada') {
            return diff < 0 && Math.abs(diff) <= LIMITE_MUITO_ATRASADA;
          }

          if (n.tipo === 'parcela_muito_atrasada') {
            return diff < 0 && Math.abs(diff) > LIMITE_MUITO_ATRASADA;
          }

          return true;
        });
        resolve(filtradas);
      }
    );
  });
}

function marcarComoLida(id) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      UPDATE notificacoes
      SET status = 'lida', lido_em = datetime('now')
      WHERE id = ?
    `,
      [id],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

module.exports = {
  gerarNotificacoesParaData,
  listarNotificacoesPendentes,
  marcarComoLida,
  existeNotificacaoPendente,
};
