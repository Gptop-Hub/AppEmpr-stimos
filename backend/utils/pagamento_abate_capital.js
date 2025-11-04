// utils/pagamento_abate_capital.js

const db = require('../models/database');
const { renegociarEmprestimo } = require('./renegociar');

module.exports = async function calcularAbateCapital({
  emprestimo_id,
  parcelaAtual: parcelaId,
  valorPago,
  data,
  observacao
}) {
  console.log('[DEBUG] calcularAbateCapital - parâmetros recebidos:', {
    emprestimo_id,
    parcelaId,
    valorPago,
    data,
    observacao
  });

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM parcelas WHERE emprestimo_id = ? ORDER BY numero ASC`,
      [emprestimo_id],
      async (err, parcelas) => {
        if (err) {
          console.error('[ERRO] Consulta parcelas:', err);
          return reject(err);
        }

        console.log(`[DEBUG] Parcelas encontradas para emprestimo_id ${emprestimo_id}:`, parcelas.length);

        // encontra a parcela atual
        const atual = parcelas.find(p => p.id === parcelaId);
        if (!atual) {
          const msg = 'Parcela atual não encontrada.';
          console.error('[ERRO]', msg);
          return reject(new Error(msg));
        }

        console.log('[DEBUG] Parcela atual encontrada:', atual);

        const updates = [];

        // 1) Quita a parcela atual
        const pagoHoje = +valorPago.toFixed(2);
        const restanteParcela = +(pagoHoje - atual.valor_total).toFixed(2);
        const quitouAtual = pagoHoje >= atual.valor_total;

        console.log(`[DEBUG] pagoHoje: ${pagoHoje}, restanteParcela: ${restanteParcela}, quitouAtual: ${quitouAtual}`);

        updates.push({
          ...atual,
          valor_pago: pagoHoje,
          pago: quitouAtual ? 1 : 0,
          data_pagamento: data,
          observacao: observacao || atual.observacao || '',
          valor_excedente: restanteParcela > 0 ? restanteParcela : 0,
          tipo_pagamento: 'abate_capital'
        });

        // Se não quitou ou não sobrou excesso, encerra aqui
        if (!quitouAtual || restanteParcela <= 0) {
          console.log('[INFO] Parcela não quitada totalmente ou sem excesso. Finalizando aqui.');
          return resolve(updates);
        }

        // 2) Excesso -> amortização de capital das últimas parcelas
        let capitalExcedente = restanteParcela;
        let capitalTotalOriginal = parcelas.reduce((sum, p) => sum + p.valor_capital, 0);

        console.log(`[DEBUG] capitalTotalOriginal antes do ajuste: ${capitalTotalOriginal}`);

        // Subtrai capital quitado hoje
        capitalTotalOriginal = +(capitalTotalOriginal - atual.valor_capital).toFixed(2);

        console.log(`[DEBUG] capitalTotalOriginal após subtrair capital da parcela atual: ${capitalTotalOriginal}`);

        // Agora aplica o excesso sobre o capital total
        const novoCapitalTotal = +(capitalTotalOriginal - capitalExcedente).toFixed(2);

        console.log(`[DEBUG] novoCapitalTotal após aplicar excesso: ${novoCapitalTotal}`);

        // Calcula quantas parcelas sobrariam (descarta parcelaAtual já paga)
        const parcelasRestantes = parcelas.filter(p => !p.pago && p.id !== parcelaId);
        const qtdRestante = parcelasRestantes.length;

        console.log(`[DEBUG] Quantidade de parcelas restantes para renegociar: ${qtdRestante}`);

        // 3) Remove logicamente as parcelas antigas ainda não pagas (mantém histórico)
        //    e gera novas parcelas via renegociação
        try {
          console.log('[INFO] Iniciando renegociarEmprestimo...');
          await renegociarEmprestimo({
            emprestimoId: emprestimo_id,
            novoCapital: novoCapitalTotal,
            novaQtdParcelas: qtdRestante,
            novaTaxaJuros: atual.juros_adicionais || 0, // ou use taxa do empréstimo
            dataInicio: data,
            diaPagamento: atual.vencimento.split('-')[2] // extrai o dia do vencimento atual
          });
          console.log('[INFO] renegociarEmprestimo finalizado com sucesso.');
        } catch (e) {
          console.error('[ERRO] Renegociação falhou:', e);
          // mas ainda retorna os updates para a parcela atual
          return resolve(updates);
        }

        // devolve apenas o update da parcela atual; 
        // as novas parcelas são criadas em renegociarEmprestimo()
        resolve(updates);
      }
    );
  });
};