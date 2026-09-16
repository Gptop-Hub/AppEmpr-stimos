import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import notify from '../ui/notify';
import { formatarData, formatarMoeda } from './Emprestimos/helpers.jsx';
import { carregarResumoELinhasFluxoCaixa } from '../utils/fluxoCaixaApi';
import ClienteIdentity from './common/ClienteIdentity.jsx';
import useClientesCatalogo from './common/useClientesCatalogo.js';

// Troque para false quando quiser liberar a tela para os usuarios.
const RELATORIO_BLOQUEADO = false;

function hojeLocalISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDiasISO(baseISO, dias) {
  const dt = new Date(`${baseISO}T00:00:00`);
  dt.setDate(dt.getDate() + Number(dias || 0));
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

const MES_INPUT_RE = /^\d{4}-\d{2}$/;

function mesInputValueFromISO(baseISO) {
  const [ano, mes] = String(baseISO || hojeLocalISO()).split('-');
  return `${ano}-${mes}`;
}

function ultimoDiaMesISO(baseISO) {
  const [ano, mes] = String(baseISO || `${mesInputValueFromISO(hojeLocalISO())}-01`).split('-');
  const ultimoDia = new Date(Number(ano), Number(mes), 0).getDate();
  return `${ano}-${mes}-${String(ultimoDia).padStart(2, '0')}`;
}

function rangeMesPorReferencia(mesReferencia) {
  const fallback = mesInputValueFromISO(hojeLocalISO());
  const referencia = MES_INPUT_RE.test(String(mesReferencia || '').trim())
    ? String(mesReferencia).trim()
    : fallback;
  const deMes = `${referencia}-01`;
  const ateMes = ultimoDiaMesISO(deMes);
  return { referencia, deMes, ateMes };
}

function primeiroDiaAnoISO(baseISO) {
  const [ano] = String(baseISO || hojeLocalISO()).split('-');
  return `${ano}-01-01`;
}

function parseError(err, fallback) {
  return (
    err?.response?.data?.error ||
    err?.response?.data?.erro ||
    err?.message ||
    fallback ||
    'Erro inesperado.'
  );
}

function statusBadgeStyle(status) {
  switch (status) {
    case 'PAGA':
      return { background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7' };
    case 'VENCIDA':
      return { background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' };
    case 'VENCE_HOJE':
      return { background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' };
    case 'VENCE_EM_BREVE':
      return { background: '#dbeafe', color: '#1d4ed8', border: '1px solid #93c5fd' };
    default:
      return { background: '#e2e8f0', color: '#334155', border: '1px solid #cbd5e1' };
  }
}

function renderCaixaValue(valor) {
  const n = Number(valor || 0);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return formatarMoeda(n);
}

function upperSafe(value) {
  return String(value || '').trim().toUpperCase();
}

function rotuloTipoMovimento(item) {
  const tipo = upperSafe(item?.tipo);
  const categoria = upperSafe(item?.categoria);

  const tipoLabel = tipo === 'ENTRADA' ? 'Entrada' : tipo === 'SAIDA' ? 'Saida' : '-';
  const categoriaLabel = categoria === 'PAGAMENTO'
    ? 'Pagamento'
    : categoria === 'EMPRESTIMO'
      ? 'Emprestimo'
      : categoria === 'DESPESA'
        ? 'Despesa'
        : '-';

  if (tipoLabel === '-' && categoriaLabel === '-') return '-';
  if (tipoLabel === '-') return categoriaLabel;
  if (categoriaLabel === '-') return tipoLabel;
  return `${tipoLabel} - ${categoriaLabel}`;
}

function alertaConferenciaPagamento(item) {
  const categoria = upperSafe(item?.categoria);
  const tipo = upperSafe(item?.tipo);
  if (categoria !== 'PAGAMENTO' || tipo !== 'ENTRADA') return null;

  const valorJuros = Number(item?.valor_juros || 0);
  const valorCapital = Number(item?.valor_capital || 0);
  const valorTotal = Number(item?.valor_total || 0);

  const soma = Number((valorJuros + valorCapital).toFixed(2));
  const diferenca = Number(Math.abs(valorTotal - soma).toFixed(2));
  if (diferenca <= 0.01) return null;

  return `Conferencia: juros + capital (${formatarMoeda(soma)}) difere do total (${formatarMoeda(valorTotal)}).`;
}

function normalizarDataISO(value) {
  const texto = String(value || '').trim();
  if (!texto) return '';
  const match = texto.match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const dt = new Date(texto);
  if (Number.isNaN(dt.getTime())) return '';
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function dataMovimentoISO(item) {
  return normalizarDataISO(item?.data_pagamento || item?.data);
}

function formatarDiaSemana(dataISO) {
  const texto = String(dataISO || '').trim();
  if (!texto) return '';
  const dt = new Date(`${texto}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return '';
  const diaSemana = dt.toLocaleDateString('pt-BR', { weekday: 'long' });
  const base = diaSemana.replace('-feira', '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function formatarDataSubtotalDia(dataISO) {
  if (!dataISO) return 'Sem data';
  const diaSemana = formatarDiaSemana(dataISO);
  const dataLabel = formatarData(dataISO);
  return diaSemana ? `${diaSemana}, ${dataLabel}` : dataLabel;
}

function criarTotaisCaixaVazios() {
  return {
    valor_juros: 0,
    valor_capital: 0,
    valor_emprestimo: 0,
    valor_despesa: 0,
    valor_total: 0,
  };
}

function somarTotaisCaixa(acc, item) {
  acc.valor_juros += Number(item?.valor_juros || 0);
  acc.valor_capital += Number(item?.valor_capital || 0);
  acc.valor_emprestimo += Number(item?.valor_emprestimo || 0);
  acc.valor_despesa += Number(item?.valor_despesa || 0);
  acc.valor_total += Number(item?.valor_total || 0);
  return acc;
}

function escapeCsv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[;"\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default function FluxoCaixaCompleto() {
  const { resolverCliente } = useClientesCatalogo();
  const navigate = useNavigate();
  const hoje = hojeLocalISO();

  const [de, setDe] = useState(() => addDiasISO(hoje, -6));
  const [ate, setAte] = useState(() => hoje);
  const [incluirPagas, setIncluirPagas] = useState(false);
  const [tipo, setTipo] = useState('todas');
  const [abaAtiva, setAbaAtiva] = useState('parcelas');
  const [loading, setLoading] = useState(false);
  const [resumo, setResumo] = useState(null);
  const [parcelas, setParcelas] = useState([]);
  const [recebidos, setRecebidos] = useState({ eventos: [], por_dia: [], totalRecebidoNoPeriodo: 0 });

  const [periodoCaixa, setPeriodoCaixa] = useState('dia');
  const [caixaDe, setCaixaDe] = useState(() => hoje);
  const [caixaAte, setCaixaAte] = useState(() => hoje);
  const [mesReferenciaCaixa, setMesReferenciaCaixa] = useState(() => mesInputValueFromISO(hoje));
  const [loadingCaixa, setLoadingCaixa] = useState(false);
  const [sincronizandoCaixa, setSincronizandoCaixa] = useState(false);
  const [filtroTipoCaixa, setFiltroTipoCaixa] = useState('todos');
  const [resumoCaixa, setResumoCaixa] = useState(null);
  const [linhasCaixa, setLinhasCaixa] = useState([]);

  const cardsResumo = useMemo(() => {
    const base = [
      { key: 'totalParcelasVencidas', label: 'Parcelas vencidas', type: 'count' },
      { key: 'totalParcelasVencendoHoje', label: 'Vencendo hoje', type: 'count' },
      { key: 'totalRecebidoNoPeriodo', label: 'Total recebido no periodo', type: 'money' },
      { key: 'totalContratosComAtraso', label: 'Contratos com atraso', type: 'count' },
    ];

    if (!resumo) return [];

    return base
      .map((item) => ({ ...item, value: resumo[item.key] }))
      .filter((item) => item.value !== null && item.value !== undefined);
  }, [resumo]);

  const cardsResumoCaixa = useMemo(() => {
    if (!resumoCaixa) return [];
    return [
      { key: 'total_recebido', label: 'Total recebido', value: resumoCaixa.total_recebido },
      { key: 'total_juros_recebido', label: 'Total juros recebido', value: resumoCaixa.total_juros_recebido },
      { key: 'total_capital_recebido', label: 'Total capital recebido', value: resumoCaixa.total_capital_recebido },
      { key: 'total_emprestimos', label: 'Total emprestimos', value: resumoCaixa.total_emprestimos },
      { key: 'total_despesas', label: 'Total despesas', value: resumoCaixa.total_despesas },
      { key: 'saldo', label: 'Saldo', value: resumoCaixa.saldo },
    ];
  }, [resumoCaixa]);

  const linhasCaixaFiltradas = useMemo(() => {
    const todas = Array.isArray(linhasCaixa) ? linhasCaixa : [];
    if (filtroTipoCaixa === 'todos') return todas;

    const categoriaDesejada = filtroTipoCaixa === 'pagamentos'
      ? 'PAGAMENTO'
      : filtroTipoCaixa === 'emprestimos'
        ? 'EMPRESTIMO'
        : filtroTipoCaixa === 'despesas'
          ? 'DESPESA'
          : '';

    if (!categoriaDesejada) return todas;
    return todas.filter((item) => upperSafe(item?.categoria) === categoriaDesejada);
  }, [filtroTipoCaixa, linhasCaixa]);

  const linhasCaixaComSubtotaisDia = useMemo(() => {
    const linhas = Array.isArray(linhasCaixaFiltradas) ? linhasCaixaFiltradas : [];
    if (!linhas.length) return [];

    const totaisPorData = linhas.reduce((acc, item) => {
      const chaveData = dataMovimentoISO(item) || '__sem_data__';
      if (!acc[chaveData]) {
        acc[chaveData] = {
          dataISO: dataMovimentoISO(item),
          quantidade: 0,
          ...criarTotaisCaixaVazios(),
        };
      }
      acc[chaveData].quantidade += 1;
      somarTotaisCaixa(acc[chaveData], item);
      return acc;
    }, {});

    const ultimoIndicePorData = linhas.reduce((acc, item, index) => {
      const chaveData = dataMovimentoISO(item) || '__sem_data__';
      acc[chaveData] = index;
      return acc;
    }, {});

    return linhas.map((item, index) => {
      const chaveAtual = dataMovimentoISO(item) || '__sem_data__';
      const exibirSubtotal = ultimoIndicePorData[chaveAtual] === index;

      return {
        key: `${item?.id ?? 'mov'}-${index}`,
        item,
        subtotalDia: exibirSubtotal ? totaisPorData[chaveAtual] : null,
      };
    });
  }, [linhasCaixaFiltradas]);

  const abrirEmprestimo = (linha) => {
    if (!linha?.emprestimo_id) {
      console.log('[relatorio] abrir emprestimo sem id', linha);
      return;
    }
    navigate(`/emprestimos?emprestimo=${linha.emprestimo_id}`);
  };

  const gerarRelatorio = async () => {
    if (!de || !ate) {
      notify.error('Informe data inicial e data final.');
      return;
    }
    if (de > ate) {
      notify.error('Data inicial nao pode ser maior que a data final.');
      return;
    }

    setLoading(true);
    try {
      const paramsComuns = {
        de,
        ate,
        incluirPagas: incluirPagas ? 1 : 0,
      };

      const [respResumo, respParcelas, respRecebidos] = await Promise.all([
        axios.get('/relatorio/resumo', {
          params: {
            ...paramsComuns,
            incluirVencendoEmXDias: 3,
          },
        }),
        axios.get('/relatorio/parcelas', {
          params: {
            ...paramsComuns,
            tipo,
          },
        }),
        axios.get('/relatorio/recebidos', {
          params: {
            de,
            ate,
          },
        }),
      ]);

      setResumo(respResumo?.data || null);
      setParcelas(respParcelas?.data?.parcelas || []);
      setRecebidos({
        eventos: respRecebidos?.data?.eventos || [],
        por_dia: respRecebidos?.data?.por_dia || [],
        totalRecebidoNoPeriodo: Number(respRecebidos?.data?.totalRecebidoNoPeriodo || 0),
      });
    } catch (err) {
      notify.error(parseError(err, 'Erro ao gerar relatorio.'));
    } finally {
      setLoading(false);
    }
  };

  const carregarFluxoCaixa = useCallback(
    async ({
      periodo = periodoCaixa,
      deParam = caixaDe,
      ateParam = caixaAte,
      mostrarErro = true,
    } = {}) => {
      const periodoConsulta = periodo === 'mes' ? 'custom' : periodo;

      if (periodoConsulta === 'custom') {
        if (!deParam || !ateParam) {
          if (mostrarErro) notify.error('Informe data inicial e final para o periodo personalizado.');
          return;
        }
        if (deParam > ateParam) {
          if (mostrarErro) notify.error('Data inicial do fluxo de caixa nao pode ser maior que a final.');
          return;
        }
      }

      setLoadingCaixa(true);
      try {
        const params = {
          periodo: periodoConsulta,
        };

        if (periodoConsulta === 'custom') {
          params.de = deParam;
          params.ate = ateParam;
        }

        const { resumo: resumoData, linhas: linhasData } = await carregarResumoELinhasFluxoCaixa(params);

        setResumoCaixa(resumoData);
        setLinhasCaixa(linhasData);

        if (resumoData?.de) {
          setCaixaDe(resumoData.de);
          if (periodo === 'mes') {
            setMesReferenciaCaixa(mesInputValueFromISO(resumoData.de));
          }
        }
        if (resumoData?.ate) setCaixaAte(resumoData.ate);
      } catch (err) {
        if (mostrarErro) {
          notify.error(parseError(err, 'Erro ao carregar fluxo de caixa.'));
        }
      } finally {
        setLoadingCaixa(false);
      }
    },
    [caixaAte, caixaDe, periodoCaixa]
  );

  const sincronizarHistoricoCaixa = async () => {
    if (sincronizandoCaixa) return;
    setSincronizandoCaixa(true);
    try {
      const resp = await axios.post('/caixa/backfill', {});
      const dados = resp?.data || {};
      const inseridosPag = Number(dados.pagamentos_inseridos || 0);
      const inseridosEmp = Number(dados.emprestimos_inseridos || 0);
      notify.success(`Sincronizacao concluida. Pagamentos: ${inseridosPag} | Emprestimos: ${inseridosEmp}`);
      await carregarFluxoCaixa({
        periodo: periodoCaixa,
        deParam: caixaDe,
        ateParam: caixaAte,
        mostrarErro: false,
      });
    } catch (err) {
      notify.error(parseError(err, 'Erro ao sincronizar historico do caixa.'));
    } finally {
      setSincronizandoCaixa(false);
    }
  };

  const montarLinhasExportacaoCaixa = () => {
    return (linhasCaixaFiltradas || []).map((item) => ({
      id_cliente: item?.id_cliente ?? item?.cliente_id ?? '',
      nome: item?.nome || item?.cliente_nome || '',
      tipo: rotuloTipoMovimento(item),
      data_vencimento: item?.data_vencimento ? formatarData(item.data_vencimento) : '',
      data_pagamento: item?.data_pagamento
        ? formatarData(item.data_pagamento)
        : item?.data
          ? formatarData(item.data)
          : '',
      juros: Number(item?.valor_juros || 0),
      capital: Number(item?.valor_capital || 0),
      emprestimo: Number(item?.valor_emprestimo || 0),
      despesa: Number(item?.valor_despesa || 0),
      total: Number(item?.valor_total || 0),
      descricao: item?.descricao || '',
      alerta: alertaConferenciaPagamento(item) || '',
    }));
  };

  const baixarBlob = (fileName, content, mimeType) => {
    const blob = new Blob([content], { type: mimeType });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  };

  const exportarCaixaCSV = () => {
    const rows = montarLinhasExportacaoCaixa();
    if (!rows.length) {
      notify.error('Nao ha movimentos para exportar em CSV.');
      return;
    }

    const headers = [
      'ID Cliente',
      'Nome',
      'Tipo',
      'Data vencimento',
      'Data pagamento',
      'Juros',
      'Capital',
      'Emprestimo',
      'Despesa',
      'Total',
      'Descricao',
      'Alerta',
    ];

    const body = rows.map((row) => [
      row.id_cliente,
      row.nome,
      row.tipo,
      row.data_vencimento,
      row.data_pagamento,
      row.juros.toFixed(2),
      row.capital.toFixed(2),
      row.emprestimo.toFixed(2),
      row.despesa.toFixed(2),
      row.total.toFixed(2),
      row.descricao,
      row.alerta,
    ]);

    const csv = [headers, ...body]
      .map((linha) => linha.map((item) => escapeCsv(item)).join(';'))
      .join('\n');

    const nome = `fluxo-caixa-${caixaDe || 'inicio'}-${caixaAte || 'fim'}.csv`;
    baixarBlob(nome, `\uFEFF${csv}`, 'text/csv;charset=utf-8;');
  };

  const exportarCaixaExcel = () => {
    const rows = montarLinhasExportacaoCaixa();
    if (!rows.length) {
      notify.error('Nao ha movimentos para exportar em Excel.');
      return;
    }

    const thead = `
      <tr>
        <th>ID Cliente</th>
        <th>Nome</th>
        <th>Tipo</th>
        <th>Data vencimento</th>
        <th>Data pagamento</th>
        <th>Juros</th>
        <th>Capital</th>
        <th>Emprestimo</th>
        <th>Despesa</th>
        <th>Total</th>
        <th>Descricao</th>
        <th>Alerta</th>
      </tr>
    `;

    const tbody = rows
      .map((row) => `
        <tr>
          <td>${escapeHtml(row.id_cliente)}</td>
          <td>${escapeHtml(row.nome)}</td>
          <td>${escapeHtml(row.tipo)}</td>
          <td>${escapeHtml(row.data_vencimento)}</td>
          <td>${escapeHtml(row.data_pagamento)}</td>
          <td>${escapeHtml(row.juros.toFixed(2))}</td>
          <td>${escapeHtml(row.capital.toFixed(2))}</td>
          <td>${escapeHtml(row.emprestimo.toFixed(2))}</td>
          <td>${escapeHtml(row.despesa.toFixed(2))}</td>
          <td>${escapeHtml(row.total.toFixed(2))}</td>
          <td>${escapeHtml(row.descricao)}</td>
          <td>${escapeHtml(row.alerta)}</td>
        </tr>
      `)
      .join('');

    const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Fluxo de Caixa</title>
  </head>
  <body>
    <table border="1" cellspacing="0" cellpadding="4">
      <thead>${thead}</thead>
      <tbody>${tbody}</tbody>
    </table>
  </body>
</html>`;

    const nome = `fluxo-caixa-${caixaDe || 'inicio'}-${caixaAte || 'fim'}.xls`;
    baixarBlob(nome, `\uFEFF${html}`, 'application/vnd.ms-excel;charset=utf-8;');
  };

  const exportarCaixaPDF = () => {
    const rows = montarLinhasExportacaoCaixa();
    if (!rows.length) {
      notify.error('Nao ha movimentos para exportar em PDF.');
      return;
    }

    const win = window.open('', '_blank', 'width=1200,height=900');
    if (!win) {
      notify.error('Nao foi possivel abrir janela de impressao. Verifique o bloqueador de pop-up.');
      return;
    }

    const linhasHtml = rows
      .map((row) => `
        <tr>
          <td>${escapeHtml(row.id_cliente)}</td>
          <td>${escapeHtml(row.nome)}</td>
          <td>${escapeHtml(row.tipo)}</td>
          <td>${escapeHtml(row.data_vencimento)}</td>
          <td>${escapeHtml(row.data_pagamento)}</td>
          <td>${escapeHtml(formatarMoeda(row.juros))}</td>
          <td>${escapeHtml(formatarMoeda(row.capital))}</td>
          <td>${escapeHtml(formatarMoeda(row.emprestimo))}</td>
          <td>${escapeHtml(formatarMoeda(row.despesa))}</td>
          <td>${escapeHtml(formatarMoeda(row.total))}</td>
          <td>${escapeHtml(row.descricao)}</td>
        </tr>
      `)
      .join('');

    const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Fluxo de Caixa</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
      h1 { margin: 0 0 6px; font-size: 24px; }
      .meta { margin-bottom: 14px; color: #334155; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #cbd5e1; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #e2e8f0; }
    </style>
  </head>
  <body>
    <h1>Fluxo de Caixa</h1>
    <div class="meta">Periodo: ${escapeHtml(caixaDe || '-')} ate ${escapeHtml(caixaAte || '-')}</div>
    <table>
      <thead>
        <tr>
          <th>ID Cliente</th>
          <th>Nome</th>
          <th>Tipo</th>
          <th>Data vencimento</th>
          <th>Data pagamento</th>
          <th>Juros</th>
          <th>Capital</th>
          <th>Emprestimo</th>
          <th>Despesa</th>
          <th>Total</th>
          <th>Descricao</th>
        </tr>
      </thead>
      <tbody>${linhasHtml}</tbody>
    </table>
  </body>
</html>`;

    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  };

  const aplicarHoje = () => {
    const h = hojeLocalISO();
    setDe(h);
    setAte(h);
  };

  const aplicarUltimos7Dias = () => {
    const h = hojeLocalISO();
    setDe(addDiasISO(h, -6));
    setAte(h);
  };

  const selecionarPeriodoCaixa = (periodo) => {
    const h = hojeLocalISO();
    setPeriodoCaixa(periodo);

    if (periodo === 'dia') {
      setCaixaDe(h);
      setCaixaAte(h);
      carregarFluxoCaixa({ periodo, deParam: h, ateParam: h });
      return;
    }

    if (periodo === 'mes') {
      const { referencia, deMes, ateMes } = rangeMesPorReferencia(mesInputValueFromISO(h));
      setMesReferenciaCaixa(referencia);
      setCaixaDe(deMes);
      setCaixaAte(ateMes);
      carregarFluxoCaixa({ periodo, deParam: deMes, ateParam: ateMes });
      return;
    }

    if (periodo === 'ano') {
      const deAno = primeiroDiaAnoISO(h);
      setCaixaDe(deAno);
      setCaixaAte(h);
      carregarFluxoCaixa({ periodo, deParam: deAno, ateParam: h });
      return;
    }

    if (periodo === 'total') {
      const deTotal = '1900-01-01';
      setCaixaDe(deTotal);
      setCaixaAte(h);
      carregarFluxoCaixa({ periodo, deParam: deTotal, ateParam: h });
    }
  };

  const selecionarMesCaixa = (mesReferencia) => {
    const { referencia, deMes, ateMes } = rangeMesPorReferencia(mesReferencia);
    setMesReferenciaCaixa(referencia);
    setCaixaDe(deMes);
    setCaixaAte(ateMes);
    carregarFluxoCaixa({ periodo: 'mes', deParam: deMes, ateParam: ateMes });
  };

  const gerarCaixaPersonalizado = () => {
    carregarFluxoCaixa({
      periodo: 'custom',
      deParam: caixaDe,
      ateParam: caixaAte,
    });
  };

  useEffect(() => {
    if (RELATORIO_BLOQUEADO) return;
    gerarRelatorio();
    carregarFluxoCaixa({ periodo: 'dia', deParam: hoje, ateParam: hoje, mostrarErro: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (RELATORIO_BLOQUEADO) return undefined;
    if (abaAtiva !== 'caixa') return undefined;

    const recarregarSilencioso = () => {
      carregarFluxoCaixa({
        periodo: periodoCaixa,
        deParam: caixaDe,
        ateParam: caixaAte,
        mostrarErro: false,
      });
    };

    recarregarSilencioso();
    const intervalId = window.setInterval(recarregarSilencioso, 45000);
    window.addEventListener('focus', recarregarSilencioso);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', recarregarSilencioso);
    };
  }, [abaAtiva, carregarFluxoCaixa, caixaAte, caixaDe, periodoCaixa]);

  if (RELATORIO_BLOQUEADO) {
    return (
      <div
        style={{
          padding: 16,
          maxWidth: 'var(--main-max-effective, var(--main-max))',
          margin: '0 auto',
          color: 'var(--text-main)',
        }}
      >
        <div
          style={{
            position: 'relative',
            border: '1px solid var(--border-soft)',
            borderRadius: 12,
            background: 'var(--bg-card)',
            padding: 28,
            minHeight: 220,
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'repeating-linear-gradient(135deg, rgba(255,255,255,0.02) 0, rgba(255,255,255,0.02) 14px, rgba(255,255,255,0.05) 14px, rgba(255,255,255,0.05) 28px)',
            }}
          />
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              alignItems: 'center',
            }}
          >
            <div
              style={{
                transform: 'rotate(-8deg)',
                border: '2px solid rgba(239,68,68,0.75)',
                color: '#ef4444',
                borderRadius: 10,
                padding: '8px 16px',
                fontWeight: 800,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                boxShadow: '0 0 0 3px rgba(239,68,68,0.18)',
                background: 'rgba(127,29,29,0.12)',
              }}
            >
              Em desenvolvimento
            </div>
            <h2 style={{ margin: 0 }}>Relatorio temporariamente indisponivel</h2>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
              Estamos finalizando esta tela. Em breve ela sera liberada.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 16,
        maxWidth: 'var(--main-max-effective, var(--main-max))',
        margin: '0 auto',
        color: 'var(--text-main)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <h2 style={{ margin: 0 }}>Relatorio</h2>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 10,
          padding: 12,
          border: '1px solid var(--border-soft)',
          borderRadius: 10,
          background: 'var(--bg-card)',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Data inicial</span>
          <input
            type="date"
            value={de}
            onChange={(e) => setDe(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border-soft)' }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Data final</span>
          <input
            type="date"
            value={ate}
            onChange={(e) => setAte(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border-soft)' }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Tipo</span>
          <select
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border-soft)' }}
          >
            <option value="vencidas">Vencidas</option>
            <option value="vencendo">Vencendo</option>
            <option value="todas">Todas</option>
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 24 }}>
          <input
            type="checkbox"
            checked={incluirPagas}
            onChange={(e) => setIncluirPagas(e.target.checked)}
          />
          Incluir pagas
        </label>

        <div style={{ display: 'flex', alignItems: 'end', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={gerarRelatorio}
            disabled={loading}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: 'none',
              background: '#2563eb',
              color: '#fff',
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            {loading ? 'Carregando...' : 'Gerar'}
          </button>
          <button
            type="button"
            onClick={aplicarHoje}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-soft)',
              background: 'var(--bg-card)',
              color: 'var(--text-main)',
              cursor: 'pointer',
            }}
          >
            Hoje
          </button>
          <button
            type="button"
            onClick={aplicarUltimos7Dias}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-soft)',
              background: 'var(--bg-card)',
              color: 'var(--text-main)',
              cursor: 'pointer',
            }}
          >
            Ultimos 7 dias
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 10,
        }}
      >
        {cardsResumo.map((card) => (
          <div
            key={card.key}
            style={{
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
              background: 'var(--bg-card)',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <span style={{ fontSize: '0.86em', color: 'var(--text-muted)' }}>{card.label}</span>
            <strong style={{ fontSize: '1.1em' }}>
              {card.type === 'money'
                ? formatarMoeda(Number(card.value || 0))
                : Number(card.value || 0)}
            </strong>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--border-soft)',
          paddingBottom: 8,
        }}
      >
        <button
          type="button"
          onClick={() => setAbaAtiva('parcelas')}
          style={{
            padding: '7px 12px',
            borderRadius: 999,
            border: '1px solid var(--border-soft)',
            background: abaAtiva === 'parcelas' ? '#1d4ed8' : 'var(--bg-card)',
            color: abaAtiva === 'parcelas' ? '#fff' : 'var(--text-main)',
            cursor: 'pointer',
          }}
        >
          Parcelas
        </button>
        <button
          type="button"
          onClick={() => setAbaAtiva('recebidos')}
          style={{
            padding: '7px 12px',
            borderRadius: 999,
            border: '1px solid var(--border-soft)',
            background: abaAtiva === 'recebidos' ? '#1d4ed8' : 'var(--bg-card)',
            color: abaAtiva === 'recebidos' ? '#fff' : 'var(--text-main)',
            cursor: 'pointer',
          }}
        >
          Recebidos
        </button>
        <button
          type="button"
          onClick={() => setAbaAtiva('caixa')}
          style={{
            padding: '7px 12px',
            borderRadius: 999,
            border: '1px solid var(--border-soft)',
            background: abaAtiva === 'caixa' ? '#1d4ed8' : 'var(--bg-card)',
            color: abaAtiva === 'caixa' ? '#fff' : 'var(--text-main)',
            cursor: 'pointer',
          }}
        >
          Fluxo de Caixa
        </button>
      </div>

      {abaAtiva === 'parcelas' ? (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              minWidth: 920,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
            }}
          >
            <thead>
              <tr style={{ background: 'rgba(37,99,235,0.1)' }}>
                {['Cliente', 'Emprestimo', 'Parcela', 'Vencimento', 'Total devido', 'Pago', 'Status', 'Acao'].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      padding: 10,
                      borderBottom: '1px solid var(--border-soft)',
                      fontSize: '0.88em',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parcelas.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 14, color: 'var(--text-muted)' }}>
                    Nenhuma parcela encontrada para o filtro selecionado.
                  </td>
                </tr>
              ) : (
                parcelas.map((p) => (
                  <tr key={p.parcela_id}>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                      <ClienteIdentity
                        cliente={resolverCliente(p.cliente_id, p.cliente_nome)}
                        avatarSize={30}
                        className="cliente-identity--table"
                      />
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                      {p.emprestimo_id}
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                      {p.numero ?? '-'}
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                      {p.vencimento ? formatarData(p.vencimento) : '-'}
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                      {formatarMoeda(Number(p.total_devido_calculado || 0))}
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                      {formatarMoeda(Number(p.valor_pago || 0))}
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                      <span
                        style={{
                          ...statusBadgeStyle(p.status),
                          padding: '2px 8px',
                          borderRadius: 999,
                          fontSize: '0.76em',
                          fontWeight: 700,
                        }}
                        title={p.dias_atraso > 0 ? `${p.dias_atraso} dia(s) de atraso` : ''}
                      >
                        {p.status || 'ABERTA'}
                      </span>
                    </td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                      <button
                        type="button"
                        onClick={() => abrirEmprestimo(p)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 8,
                          border: 'none',
                          background: '#2563eb',
                          color: '#fff',
                          cursor: 'pointer',
                        }}
                      >
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : abaAtiva === 'recebidos' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
              background: 'var(--bg-card)',
              padding: 12,
            }}
          >
            <strong>Total recebido no periodo: </strong>
            {formatarMoeda(Number(recebidos.totalRecebidoNoPeriodo || 0))}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                minWidth: 760,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-soft)',
                borderRadius: 10,
              }}
            >
              <thead>
                <tr style={{ background: 'rgba(37,99,235,0.1)' }}>
                  {['Data', 'Cliente', 'Valor', 'Tipo', 'Emprestimo ID', 'Parcela origem'].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: 'left',
                        padding: 10,
                        borderBottom: '1px solid var(--border-soft)',
                        fontSize: '0.88em',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(recebidos.eventos || []).length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 14, color: 'var(--text-muted)' }}>
                      Nenhum recebimento no periodo selecionado.
                    </td>
                  </tr>
                ) : (
                  (recebidos.eventos || []).map((ev) => (
                    <tr key={ev.pagamento_id}>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {ev.data ? formatarData(ev.data) : '-'}
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        <ClienteIdentity
                          cliente={resolverCliente(
                            ev.id_cliente ?? ev.cliente_id,
                            ev.cliente_nome
                          )}
                          avatarSize={30}
                          className="cliente-identity--table"
                        />
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {formatarMoeda(Number(ev.valor || 0))}
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {ev.tipo || '-'}
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {ev.emprestimo_id || '-'}
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {ev.parcela_origem_numero ?? ev.parcela_origem ?? '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                minWidth: 420,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-soft)',
                borderRadius: 10,
              }}
            >
              <thead>
                <tr style={{ background: 'rgba(16,185,129,0.12)' }}>
                  <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                    Dia
                  </th>
                  <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                    Total
                  </th>
                  <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                    Qtde eventos
                  </th>
                </tr>
              </thead>
              <tbody>
                {(recebidos.por_dia || []).length === 0 ? (
                  <tr>
                    <td colSpan={3} style={{ padding: 14, color: 'var(--text-muted)' }}>
                      Sem agregacao diaria para este periodo.
                    </td>
                  </tr>
                ) : (
                  (recebidos.por_dia || []).map((item) => (
                    <tr key={item.data}>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {item.data ? formatarData(item.data) : '-'}
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {formatarMoeda(Number(item.total || 0))}
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {Number(item.count || 0)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
              background: 'var(--bg-card)',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => selecionarPeriodoCaixa('dia')}
                style={{
                  padding: '7px 12px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: periodoCaixa === 'dia' ? '#2563eb' : 'var(--bg-card)',
                  color: periodoCaixa === 'dia' ? '#fff' : 'var(--text-main)',
                  cursor: 'pointer',
                }}
              >
                Hoje
              </button>
              <button
                type="button"
                onClick={() => selecionarPeriodoCaixa('mes')}
                style={{
                  padding: '7px 12px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: periodoCaixa === 'mes' ? '#2563eb' : 'var(--bg-card)',
                  color: periodoCaixa === 'mes' ? '#fff' : 'var(--text-main)',
                  cursor: 'pointer',
                }}
              >
                Mes
              </button>
              <button
                type="button"
                onClick={() => selecionarPeriodoCaixa('ano')}
                style={{
                  padding: '7px 12px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: periodoCaixa === 'ano' ? '#2563eb' : 'var(--bg-card)',
                  color: periodoCaixa === 'ano' ? '#fff' : 'var(--text-main)',
                  cursor: 'pointer',
                }}
              >
                Ano
              </button>
              <button
                type="button"
                onClick={() => selecionarPeriodoCaixa('total')}
                style={{
                  padding: '7px 12px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: periodoCaixa === 'total' ? '#2563eb' : 'var(--bg-card)',
                  color: periodoCaixa === 'total' ? '#fff' : 'var(--text-main)',
                  cursor: 'pointer',
                }}
              >
                Total
              </button>
              <button
                type="button"
                onClick={() => setPeriodoCaixa('custom')}
                style={{
                  padding: '7px 12px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: periodoCaixa === 'custom' ? '#2563eb' : 'var(--bg-card)',
                  color: periodoCaixa === 'custom' ? '#fff' : 'var(--text-main)',
                  cursor: 'pointer',
                }}
              >
                Personalizado
              </button>
            </div>

            {periodoCaixa === 'mes' ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>Mes de referencia</span>
                  <input
                    type="month"
                    value={mesReferenciaCaixa}
                    max={mesInputValueFromISO(hojeLocalISO())}
                    onChange={(e) => selecionarMesCaixa(e.target.value)}
                    style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border-soft)' }}
                  />
                </label>
              </div>
            ) : null}

            {periodoCaixa === 'custom' ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>Data inicial</span>
                  <input
                    type="date"
                    value={caixaDe}
                    onChange={(e) => setCaixaDe(e.target.value)}
                    style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border-soft)' }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>Data final</span>
                  <input
                    type="date"
                    value={caixaAte}
                    onChange={(e) => setCaixaAte(e.target.value)}
                    style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border-soft)' }}
                  />
                </label>
                <button
                  type="button"
                  onClick={gerarCaixaPersonalizado}
                  disabled={loadingCaixa}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: 'none',
                    background: '#2563eb',
                    color: '#fff',
                    cursor: loadingCaixa ? 'default' : 'pointer',
                  }}
                >
                  {loadingCaixa ? 'Carregando...' : 'Gerar'}
                </button>
              </div>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
                Periodo aplicado: {caixaDe ? formatarData(caixaDe) : '-'} ate {caixaAte ? formatarData(caixaAte) : '-'}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Mostrar:</span>
                <select
                  value={filtroTipoCaixa}
                  onChange={(e) => setFiltroTipoCaixa(e.target.value)}
                  style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-soft)' }}
                >
                  <option value="todos">Todos</option>
                  <option value="pagamentos">Pagamentos</option>
                  <option value="emprestimos">Emprestimos</option>
                  <option value="despesas">Despesas</option>
                </select>
              </label>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() =>
                    carregarFluxoCaixa({
                      periodo: periodoCaixa,
                      deParam: caixaDe,
                      ateParam: caixaAte,
                    })
                  }
                  disabled={loadingCaixa}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-soft)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-main)',
                    cursor: loadingCaixa ? 'default' : 'pointer',
                  }}
                >
                  Atualizar
                </button>
                <button
                  type="button"
                  onClick={sincronizarHistoricoCaixa}
                  disabled={sincronizandoCaixa}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: '1px solid #2563eb',
                    background: sincronizandoCaixa ? 'rgba(37,99,235,0.4)' : '#2563eb',
                    color: '#fff',
                    cursor: sincronizandoCaixa ? 'default' : 'pointer',
                  }}
                >
                  {sincronizandoCaixa ? 'Sincronizando...' : 'Sincronizar historico'}
                </button>
                <button
                  type="button"
                  onClick={exportarCaixaCSV}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-soft)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-main)',
                    cursor: 'pointer',
                  }}
                >
                  Exportar CSV
                </button>
                <button
                  type="button"
                  onClick={exportarCaixaExcel}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-soft)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-main)',
                    cursor: 'pointer',
                  }}
                >
                  Exportar Excel
                </button>
                <button
                  type="button"
                  onClick={exportarCaixaPDF}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-soft)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-main)',
                    cursor: 'pointer',
                  }}
                >
                  Exportar PDF
                </button>
              </div>
            </div>

            {loadingCaixa ? (
              <div style={{ color: 'var(--text-muted)' }}>Carregando fluxo de caixa...</div>
            ) : null}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 10,
            }}
          >
            {cardsResumoCaixa.map((card) => (
              <div
                key={card.key}
                style={{
                  border: '1px solid var(--border-soft)',
                  borderRadius: 10,
                  background: 'var(--bg-card)',
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span style={{ fontSize: '0.86em', color: 'var(--text-muted)' }}>{card.label}</span>
                <strong style={{ fontSize: '1.1em' }}>{formatarMoeda(Number(card.value || 0))}</strong>
              </div>
            ))}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                minWidth: 1240,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-soft)',
                borderRadius: 10,
              }}
            >
              <thead>
                <tr style={{ background: 'rgba(37,99,235,0.1)' }}>
                  {[
                    'ID Cliente',
                    'Nome',
                    'Tipo',
                    'Data vencimento',
                    'Data pagamento',
                    'Juros',
                    'Capital',
                    'Emprestimo',
                    'Despesa',
                    'Total',
                    'Descricao',
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: 'left',
                        padding: 10,
                        borderBottom: '1px solid var(--border-soft)',
                        fontSize: '0.88em',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(linhasCaixaFiltradas || []).length === 0 ? (
                  <tr>
                    <td colSpan={11} style={{ padding: 14, color: 'var(--text-muted)' }}>
                      Nenhum movimento encontrado no periodo selecionado.
                    </td>
                  </tr>
                ) : (
                  linhasCaixaComSubtotaisDia.map(({ key, item, subtotalDia }) => {
                    const alertaPagamento = alertaConferenciaPagamento(item);
                    return (
                      <React.Fragment key={key}>
                        <tr style={alertaPagamento ? { background: 'rgba(239,68,68,0.08)' } : undefined}>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {item.id_cliente ?? item.cliente_id ?? '-'}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            <ClienteIdentity
                              cliente={resolverCliente(
                                item.id_cliente ?? item.cliente_id,
                                item.nome || item.cliente_nome
                              )}
                              avatarSize={30}
                              className="cliente-identity--table"
                            />
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {rotuloTipoMovimento(item)}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {item.data_vencimento ? formatarData(item.data_vencimento) : '-'}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {item.data_pagamento ? formatarData(item.data_pagamento) : item.data ? formatarData(item.data) : '-'}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_juros)}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_capital)}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_emprestimo)}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_despesa)}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_total)}
                          </td>
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span>{item.descricao || '-'}</span>
                              {alertaPagamento ? (
                                <small style={{ color: '#fca5a5', fontWeight: 700 }}>{alertaPagamento}</small>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                        {subtotalDia ? (
                          <tr style={{ background: 'rgba(148,163,184,0.1)', fontWeight: 700 }}>
                            <td colSpan={5} style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Total em {formatarDataSubtotalDia(subtotalDia.dataISO)} ({subtotalDia.quantidade})
                            </td>
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Juros: {formatarMoeda(Number(subtotalDia.valor_juros || 0))}
                            </td>
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Capital: {formatarMoeda(Number(subtotalDia.valor_capital || 0))}
                            </td>
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Emprestado: {formatarMoeda(Number(subtotalDia.valor_emprestimo || 0))}
                            </td>
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Despesa: {formatarMoeda(Number(subtotalDia.valor_despesa || 0))}
                            </td>
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }} />
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }} />
                          </tr>
                        ) : null}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
