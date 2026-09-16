'use strict';
const crypto = require('node:crypto');
const { fs, path, LAB, ROOT, SEED, DATE, mark, guard, open, close, schema, bindReference, fixedClock, invoke, route, run, all } = require('./runtime.cjs');
const { exportState, validateDataset } = require('./state.cjs');
const scenarios = ['recem_criado', 'aberto_futuro', 'vencido_sem_pagamento', 'uma_parcela_paga', 'varias_parcelas_pagas', 'parcial_com_amortizacao', 'juros_pagos', 'juros_parciais_pendentes', 'juros_adicionais', 'proximo_quitacao', 'quitado', 'renegociado', 'capital_adicional', 'capital_adicional_com_pagamento', 'renegociado_com_pagamento', 'juros_parciais_repetidos', 'pagamento_atrasado', 'pagamento_antecipado', 'amortizacao_manual_capital', 'juros_adicionais_parcialmente_pagos'];
async function main() {
  guard();
  console.log('GERAÇÃO DE DADOS DE TESTE: somente banco temporário em .test-lab.');
  fs.mkdirSync(LAB, { recursive: true });
  const dir = fs.mkdtempSync(path.join(LAB, 'generation-'));
  const db = await open(path.join(dir, 'reference.db'));
  const clock = fixedClock();
  try {
    await schema(db);
    bindReference(db);
    const create = require('../../backend/controllers/emprestimosController').criar;
    const addCapital = require('../../backend/controllers/renegociacaoController').adicionarCapital;
    const renegotiate = require('../../backend/services/renegociacaoService').aplicarRenegociacao;
    const paymentRouter = require('../../backend/routes/pagamento');
    const pay = route(paymentRouter, '/');
    const partialInterest = route(paymentRouter, '/manual-juros-parcial');
    const extraInterest = route(require('../../backend/routes/parcelas'), '/:id/juros-adicionais');
    const capitalRule = require('../../backend/services/servicoemprestimo/core').calcularCapitalRestanteComRegra;
    const records = [];
    const f2 = n => Number(n.toFixed(2));
    let counter = 0;
    const randomInt = (min, max) => min + crypto.createHash('sha256').update(`${SEED}:${counter++}`).digest().readUInt32BE(0) % (max - min + 1);
    for (let c = 1; c <= 20; c++) {
      const clientKey = `TEST-C${String(c).padStart(3, '0')}`;
      const client = await run(db, 'INSERT INTO clientes(nome,cpf,telefone,endereco,trabalho,referencia,observacao,criadoEm,receber_notificacoes_cobranca,motivo_notificacoes_cobranca) VALUES(?,?,?,?,?,?,?,?,0,?)', [
        `${clientKey} Pessoa Fictícia ${String.fromCharCode(64 + c)}`, '', '', `Rua de Teste ${c}, Cidade Fictícia`, 'Ocupação fictícia', clientKey, mark(clientKey), '2025-01-01', 'Laboratório fictício sem contato real',
      ]);
      for (let l = 1; l <= 5; l++) {
        const key = `${clientKey}-L${String(l).padStart(2, '0')}`;
        const scenario = scenarios[((c - 1) * 5 + l - 1) % scenarios.length];
        const n = randomInt(3, 10);
        // Multiples of installment count avoid fabricating rounding residuals in the PC generator.
        const principal = n * randomInt(80, 650);
        const day = [1, 5, 10, 14, 15, 20, 25, 28, 31][randomInt(0, 8)];
        const pad = v => String(v).padStart(2, '0');
        const recent = scenario === 'recem_criado';
        const future = scenario === 'aberto_futuro';
        const start = recent ? DATE : future ? '2026-09-01' : '2025-10-01';
        const due = `${recent || future ? '2026-10' : '2025-10'}-${pad(day)}`;
        clock(start);
        const loan = await invoke(create, { cliente_id: client.lastID, valor: principal, taxa_juros: 10, modalidade: 'parcelado', parcelas: n, data: start, data_pagamento: due, observacao: mark(key) });
        await run(db, 'UPDATE emprestimos SET codigo_cliente=? WHERE id=?', [key, loan.id]);
        const current = () => all(db, 'SELECT p.* FROM parcelas p JOIN emprestimos e ON e.id=p.emprestimo_id WHERE e.id=? AND p.versao=e.versao_atual ORDER BY p.numero', [loan.id]);
        const events = [{ tipo: 'criacao', data: start, capital: principal, taxa_juros: 10, parcelas: n, primeiro_vencimento: due }];
        async function payment(type = 'normal', fraction = 1, date = null, manualCapital = false, manualInstallment = false) {
          const p = (await current()).find(p => !p.pago);
          const at = date || p.vencimento;
          clock(at);
          const amount = f2((type === 'juros' || type === 'juros_parcial' ? p.valor_juros + (p.juros_pendentes || 0) + (p.juros_adicionais || 0) : manualCapital ? p.valor_capital : p.valor_total) * fraction);
          if (type === 'juros_parcial') await invoke(partialInterest, { emprestimoId: loan.id, valorPagamento: amount, data: at, parcela_numero: p.numero, observacaoParcela: mark(key) });
          else await invoke(pay, { emprestimo_id: loan.id, valor: amount, tipoPagamento: manualCapital || manualInstallment ? 'manual' : type, data: at, parcela_numero: p.numero, observacao: mark(key), ...(manualCapital || manualInstallment ? { abatimentos: [{ parcelaId: p.id, [manualCapital ? 'abatCapital' : 'abatParcela']: amount }] } : {}) });
          events.push({ tipo: manualCapital ? 'amortizacao_manual_capital' : type, data: at, valor: amount, parcela: p.numero, versao: p.versao });
        }
        if (['uma_parcela_paga','renegociado','capital_adicional','capital_adicional_com_pagamento','renegociado_com_pagamento'].includes(scenario)) await payment();
        if (scenario === 'varias_parcelas_pagas') { await payment(); await payment(); }
        if (scenario === 'parcial_com_amortizacao') { const p = (await current())[0]; await payment('manual', (p.valor_juros + p.valor_capital / 2) / p.valor_total, null, false, true); }
        if (scenario === 'juros_pagos') await payment('juros');
        if (scenario === 'juros_parciais_pendentes' || scenario === 'juros_parciais_repetidos') await payment('juros_parcial', 0.4);
        if (scenario === 'juros_parciais_repetidos') await payment('juros_parcial', 0.3);
        if (scenario.startsWith('juros_adicionais')) {
          const p = (await current())[0];
          await invoke(extraInterest, { valor: 35, motivo: `${mark(key)} Encargo manual fixo do cenário`, data: '2025-10-15' }, { id: p.id });
          events.push({ tipo: 'juros_adicionais', data: '2025-10-15', valor: 35, parcela: p.numero, versao: 1 });
          if (scenario === 'juros_adicionais_parcialmente_pagos') await payment('juros_parcial', 0.25, '2025-11-15');
        }
        if (scenario === 'proximo_quitacao' || scenario === 'quitado') for (let i = 0; i < n - (scenario === 'quitado' ? 0 : 1); i++) await payment();
        if (scenario.startsWith('renegociado') || scenario.startsWith('capital_adicional')) {
          clock('2026-01-15');
          const terms = { data: '2026-01-15', taxa_juros: 10, parcelas: n - 1, primeiro_vencimento: '2026-02-15' };
          if (scenario.startsWith('renegociado')) {
            const loanRow = (await all(db, 'SELECT * FROM emprestimos WHERE id=?', [loan.id]))[0];
            terms.capital = capitalRule(loanRow, await current());
            await renegotiate({ emprestimo_id: loan.id, cliente_id: client.lastID, valor: terms.capital, parcelas: terms.parcelas, taxa_juros: 10, data: terms.data, data_pagamento: terms.primeiro_vencimento, observacao: mark(key) }, null, { dbHandle: db });
          } else {
            terms.capital_adicional = (n - 1) * 100;
            await invoke(addCapital, { valor_adicionar: terms.capital_adicional, qtd_parcelas: terms.parcelas, juros_mes: 10, primeiro_vencimento: terms.primeiro_vencimento, observacao: mark(key) }, { id: loan.id });
          }
          events.push({ tipo: scenario.startsWith('renegociado') ? 'renegociacao' : 'capital_adicional', ...terms });
          if (scenario.endsWith('com_pagamento')) await payment();
        }
        if (scenario === 'pagamento_atrasado') await payment('normal', 1, '2026-03-20');
        if (scenario === 'pagamento_antecipado') await payment('normal', 1, '2025-10-01');
        if (scenario === 'amortizacao_manual_capital') await payment('manual', 0.5, null, true);
        records.push({ id: key, cliente: clientKey, situacao: scenario, eventos: events });
      }
    }
    const dataset = await exportState(db, records);
    validateDataset(dataset);
    const bytes = JSON.stringify(dataset, null, 2) + '\n';
    const destination = path.join(LAB, 'dataset-v1.json');
    fs.writeFileSync(destination, bytes);
    console.log(JSON.stringify({ dataset: destination, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), clientes: 20, emprestimos: 100 }, null, 2));
  } finally { await close(db); }
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
