import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { autorizarProtecao } from '../security/seguranca.js';
import notify from '../ui/notify';
import { formatarData, formatarMoeda } from './Emprestimos/helpers.jsx';
import { carregarResumoELinhasFluxoCaixa } from '../utils/fluxoCaixaApi';
import ClienteIdentity from './common/ClienteIdentity.jsx';
import useClientesCatalogo from './common/useClientesCatalogo.js';

function hojeLocalISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
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

function primeiroDiaSemanaISO(baseISO) {
  const iso = String(baseISO || hojeLocalISO());
  const dt = new Date(`${iso}T00:00:00`);
  const weekDay = dt.getDay(); // 0 = domingo, 1 = segunda
  const diffToMonday = (weekDay + 6) % 7;
  dt.setDate(dt.getDate() - diffToMonday);
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function ultimoDiaSemanaISO(baseISO) {
  const inicioSemana = primeiroDiaSemanaISO(baseISO);
  const dt = new Date(`${inicioSemana}T00:00:00`);
  dt.setDate(dt.getDate() + 6);
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
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

function renderCaixaValue(valor) {
  const n = Number(valor || 0);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return formatarMoeda(n);
}

function upperSafe(value) {
  return String(value || '').trim().toUpperCase();
}

function apenasDigitos(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatarValorMonetarioInput(value) {
  const digits = apenasDigitos(value);
  const n = Number(digits || '0') / 100;
  return n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  });
}

function valorMonetarioInputParaNumero(value) {
  const digits = apenasDigitos(value);
  const n = Number(digits || '0') / 100;
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
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

function normalizarBucketPrevisto(bucket = {}) {
  return {
    total: Number(bucket?.total || 0),
    capital: Number(bucket?.capital || 0),
    juros: Number(bucket?.juros || 0),
  };
}

export default function FluxoCaixaPage() {
  const { resolverCliente } = useClientesCatalogo();
  const hoje = hojeLocalISO();

  const [periodoCaixa, setPeriodoCaixa] = useState('dia');
  const [caixaDe, setCaixaDe] = useState(() => hoje);
  const [caixaAte, setCaixaAte] = useState(() => hoje);
  const [mesReferenciaCaixa, setMesReferenciaCaixa] = useState(() => mesInputValueFromISO(hoje));
  const [loadingCaixa, setLoadingCaixa] = useState(false);
  const [sincronizandoCaixa, setSincronizandoCaixa] = useState(false);
  const [filtroTipoCaixa, setFiltroTipoCaixa] = useState('todos');
  const [filtroCardCaixa, setFiltroCardCaixa] = useState('');
  const [resumoCaixa, setResumoCaixa] = useState(null);
  const [linhasCaixa, setLinhasCaixa] = useState([]);
  const [erroCaixa, setErroCaixa] = useState('');
  const [incluirAtrasadosPrevistos, setIncluirAtrasadosPrevistos] = useState(false);
  const [despesaModalAberto, setDespesaModalAberto] = useState(false);
  const [despesaValorInput, setDespesaValorInput] = useState(() => formatarValorMonetarioInput('0'));
  const [despesaAnotacao, setDespesaAnotacao] = useState('');
  const [despesaData, setDespesaData] = useState(() => hoje);
  const [salvandoDespesa, setSalvandoDespesa] = useState(false);
  const [excluindoDespesaId, setExcluindoDespesaId] = useState(null);

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

  const recebimentosPrevistosCaixa = useMemo(() => {
    const raw = resumoCaixa?.recebimentos_previstos || {};
    return {
      periodo: normalizarBucketPrevisto(raw.periodo),
      atrasados: normalizarBucketPrevisto(raw.atrasados),
      total: normalizarBucketPrevisto(raw.total),
    };
  }, [resumoCaixa]);

  const cardsPrevistosCaixa = useMemo(
    () => [
      {
        key: 'previsto_total',
        label: 'Total que deveria receber',
        value: recebimentosPrevistosCaixa.total.total,
        color: '#34d399',
      },
      {
        key: 'previsto_capital',
        label: 'Capital previsto',
        value: recebimentosPrevistosCaixa.total.capital,
        color: '#60a5fa',
      },
      {
        key: 'previsto_juros',
        label: 'Juros previstos',
        value: recebimentosPrevistosCaixa.total.juros,
        color: '#fbbf24',
      },
    ],
    [recebimentosPrevistosCaixa]
  );

  const filtroCardLabel = useMemo(() => {
    const match = cardsResumoCaixa.find((card) => card.key === filtroCardCaixa);
    return match ? match.label : '';
  }, [cardsResumoCaixa, filtroCardCaixa]);

  const linhasCaixaFiltradas = useMemo(() => {
    const todas = Array.isArray(linhasCaixa) ? linhasCaixa : [];

    const porTipo = (() => {
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
    })();

    if (!filtroCardCaixa) return porTipo;

    return porTipo.filter((item) => {
      const tipo = upperSafe(item?.tipo);
      const categoria = upperSafe(item?.categoria);
      const valorTotal = Number(item?.valor_total || 0);
      const valorJuros = Number(item?.valor_juros || 0);
      const valorCapital = Number(item?.valor_capital || 0);
      const valorEmprestimo = Number(item?.valor_emprestimo || 0);
      const valorDespesa = Number(item?.valor_despesa || 0);

      if (filtroCardCaixa === 'total_recebido') {
        return tipo === 'ENTRADA' && valorTotal > 0;
      }
      if (filtroCardCaixa === 'total_juros_recebido') {
        return tipo === 'ENTRADA' && valorJuros > 0;
      }
      if (filtroCardCaixa === 'total_capital_recebido') {
        return tipo === 'ENTRADA' && valorCapital > 0;
      }
      if (filtroCardCaixa === 'total_emprestimos') {
        return tipo === 'SAIDA' && categoria === 'EMPRESTIMO' && valorEmprestimo > 0;
      }
      if (filtroCardCaixa === 'total_despesas') {
        return tipo === 'SAIDA' && categoria === 'DESPESA' && valorDespesa > 0;
      }
      if (filtroCardCaixa === 'saldo') {
        const entradaValida = tipo === 'ENTRADA' && valorTotal > 0;
        const saidaValida =
          tipo === 'SAIDA' &&
          (categoria === 'EMPRESTIMO' || categoria === 'DESPESA') &&
          valorTotal > 0;
        return entradaValida || saidaValida;
      }
      return true;
    });
  }, [filtroTipoCaixa, linhasCaixa, filtroCardCaixa]);

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

  const modoTabelaDespesas = filtroTipoCaixa === 'despesas' || filtroCardCaixa === 'total_despesas';

  const ocultarColunasSemValor = Boolean(filtroCardCaixa);
  const mostrarDataVencimento = !ocultarColunasSemValor || (linhasCaixaFiltradas || []).some((item) => item?.data_vencimento);
  const mostrarJuros = !ocultarColunasSemValor || (linhasCaixaFiltradas || []).some((item) => Number(item?.valor_juros || 0) > 0);
  const mostrarCapital = !ocultarColunasSemValor || (linhasCaixaFiltradas || []).some((item) => Number(item?.valor_capital || 0) > 0);
  const mostrarEmprestimo = !ocultarColunasSemValor || (linhasCaixaFiltradas || []).some((item) => Number(item?.valor_emprestimo || 0) > 0);
  const mostrarDespesa = !ocultarColunasSemValor || (linhasCaixaFiltradas || []).some((item) => Number(item?.valor_despesa || 0) > 0);
  const totalColunasVisiveis =
    6 +
    (mostrarDataVencimento ? 1 : 0) +
    (mostrarJuros ? 1 : 0) +
    (mostrarCapital ? 1 : 0) +
    (mostrarEmprestimo ? 1 : 0) +
    (mostrarDespesa ? 1 : 0);
  const colSpanDescricaoSubtotalDia = 4 + (mostrarDataVencimento ? 1 : 0);
  const minWidthTabela = Math.max(760, totalColunasVisiveis * 110);

  const carregarFluxoCaixa = useCallback(
    async ({
      periodo = periodoCaixa,
      deParam = caixaDe,
      ateParam = caixaAte,
      incluirAtrasadosParam = incluirAtrasadosPrevistos,
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
      setErroCaixa('');
      try {
        const params = {
          periodo: periodoConsulta,
          incluirAtrasados: incluirAtrasadosParam ? 1 : 0,
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
        const mensagem = parseError(err, 'Erro ao carregar fluxo de caixa.');
        setErroCaixa(mensagem);
        if (mostrarErro) {
          notify.error(mensagem);
        }
      } finally {
        setLoadingCaixa(false);
      }
    },
    [caixaAte, caixaDe, incluirAtrasadosPrevistos, periodoCaixa]
  );

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

    if (periodo === 'semana') {
      const deSemana = primeiroDiaSemanaISO(h);
      const ateSemana = ultimoDiaSemanaISO(h);
      setCaixaDe(deSemana);
      setCaixaAte(ateSemana);
      carregarFluxoCaixa({ periodo, deParam: deSemana, ateParam: ateSemana });
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

  const alternarAtrasadosPrevistos = () => {
    if (loadingCaixa) return;
    const proximoValor = !incluirAtrasadosPrevistos;
    setIncluirAtrasadosPrevistos(proximoValor);
    carregarFluxoCaixa({
      periodo: periodoCaixa,
      deParam: caixaDe,
      ateParam: caixaAte,
      incluirAtrasadosParam: proximoValor,
    });
  };

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

  const abrirModalDespesa = () => {
    setDespesaValorInput(formatarValorMonetarioInput('0'));
    setDespesaAnotacao('');
    setDespesaData(hojeLocalISO());
    setDespesaModalAberto(true);
  };

  const fecharModalDespesa = () => {
    if (salvandoDespesa) return;
    setDespesaModalAberto(false);
  };

  const salvarDespesa = async () => {
    if (salvandoDespesa) return;

    const valorDespesa = valorMonetarioInputParaNumero(despesaValorInput);
    const anotacaoFinal = String(despesaAnotacao || '').trim();
    const dataFinal = String(despesaData || '').trim();

    if (!valorDespesa || valorDespesa <= 0) {
      notify.warn('Informe um valor de despesa maior que zero.');
      return;
    }
    if (!anotacaoFinal) {
      notify.warn('Anotação da despesa é obrigatória.');
      return;
    }
    if (!dataFinal) {
      notify.warn('Informe a data da despesa.');
      return;
    }

    setSalvandoDespesa(true);
    try {
      await axios.post('/caixa/despesa', {
        valor: valorDespesa,
        descricao: anotacaoFinal,
        observacao: anotacaoFinal,
        data: dataFinal,
      });
      notify.success('Despesa adicionada com sucesso.');
      setDespesaModalAberto(false);
      await carregarFluxoCaixa({
        periodo: periodoCaixa,
        deParam: caixaDe,
        ateParam: caixaAte,
        mostrarErro: false,
      });
    } catch (err) {
      notify.error(parseError(err, 'Erro ao adicionar despesa.'));
    } finally {
      setSalvandoDespesa(false);
    }
  };

  const excluirDespesa = async (item) => {
    const despesaId = Number(item?.id);
    if (!despesaId) {
      notify.error('Despesa invalida para exclusao.');
      return;
    }

    const autorizacao = await autorizarProtecao('excluir_despesa');
    if (!autorizacao) return;

    const confirmar = await notify.confirm('Deseja realmente excluir esta despesa?');
    if (!confirmar) return;

    setExcluindoDespesaId(despesaId);
    try {
      await axios.delete(`/caixa/despesa/${despesaId}`, autorizacao);
      notify.success('Despesa excluida com sucesso.');
      await carregarFluxoCaixa({
        periodo: periodoCaixa,
        deParam: caixaDe,
        ateParam: caixaAte,
        mostrarErro: false,
      });
    } catch (err) {
      notify.error(parseError(err, 'Erro ao excluir despesa.'));
    } finally {
      setExcluindoDespesaId(null);
    }
  };

  useEffect(() => {
    carregarFluxoCaixa({ periodo: 'dia', deParam: hoje, ateParam: hoje, mostrarErro: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const recarregarSilencioso = () => {
      carregarFluxoCaixa({
        periodo: periodoCaixa,
        deParam: caixaDe,
        ateParam: caixaAte,
        mostrarErro: false,
      });
    };

    const intervalId = window.setInterval(recarregarSilencioso, 45000);
    window.addEventListener('focus', recarregarSilencioso);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', recarregarSilencioso);
    };
  }, [carregarFluxoCaixa, caixaAte, caixaDe, periodoCaixa]);

  return (
    <div
      className="fluxo-caixa-page"
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
      <h2 style={{ margin: 0 }}>Fluxo de Caixa</h2>

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
            onClick={() => selecionarPeriodoCaixa('semana')}
            style={{
              padding: '7px 12px',
              borderRadius: 999,
              border: '1px solid var(--border-soft)',
              background: periodoCaixa === 'semana' ? '#2563eb' : 'var(--bg-card)',
              color: periodoCaixa === 'semana' ? '#fff' : 'var(--text-main)',
              cursor: 'pointer',
            }}
          >
            Semana
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
          </div>
        </div>

        {loadingCaixa ? (
          <div style={{ color: 'var(--text-muted)' }}>Carregando fluxo de caixa...</div>
        ) : null}

        {erroCaixa ? (
          <div
            role="alert"
            style={{
              padding: '9px 10px',
              borderRadius: 8,
              border: '1px solid rgba(239,68,68,0.42)',
              background: 'rgba(239,68,68,0.08)',
              color: '#ef4444',
              fontSize: '0.88em',
            }}
          >
            {erroCaixa}
          </div>
        ) : null}
      </div>

      <section
        aria-label="Recebimentos previstos"
        aria-busy={loadingCaixa}
        style={{
          border: '1px solid rgba(16,185,129,0.38)',
          borderRadius: 8,
          background: 'rgba(16,185,129,0.055)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <strong style={{ fontSize: '1em' }}>Recebimentos previstos</strong>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.86em' }}>
              Vencimentos de {resumoCaixa?.de ? formatarData(resumoCaixa.de) : formatarData(caixaDe)} ate{' '}
              {resumoCaixa?.ate ? formatarData(resumoCaixa.ate) : formatarData(caixaAte)}
            </span>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={incluirAtrasadosPrevistos}
            onClick={alternarAtrasadosPrevistos}
            disabled={loadingCaixa}
            title={
              incluirAtrasadosPrevistos
                ? 'Remover atrasados com dia de pagamento no periodo'
                : 'Somar atrasados com dia de pagamento no periodo'
            }
            style={{
              minHeight: 36,
              padding: '6px 10px',
              borderRadius: 8,
              border: incluirAtrasadosPrevistos
                ? '1px solid #f59e0b'
                : '1px solid var(--border-soft)',
              background: incluirAtrasadosPrevistos
                ? 'rgba(245,158,11,0.12)'
                : 'var(--bg-card)',
              color: 'var(--text-main)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: loadingCaixa ? 'default' : 'pointer',
              opacity: loadingCaixa ? 0.65 : 1,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 34,
                height: 18,
                padding: 2,
                borderRadius: 9,
                background: incluirAtrasadosPrevistos ? '#f59e0b' : 'rgba(148,163,184,0.45)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: incluirAtrasadosPrevistos ? 'flex-end' : 'flex-start',
                flex: '0 0 auto',
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  background: '#fff',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                }}
              />
            </span>
            <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Incluir atrasados</span>
          </button>
        </div>

        {resumoCaixa ? (
          <div
            aria-live="polite"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              borderTop: '1px solid rgba(16,185,129,0.25)',
            }}
          >
            {cardsPrevistosCaixa.map((card) => (
              <div
                key={card.key}
                style={{
                  minHeight: 76,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 5,
                  borderLeft: `3px solid ${card.color}`,
                }}
              >
                <span style={{ color: 'var(--text-muted)', fontSize: '0.86em' }}>{card.label}</span>
                <strong style={{ fontSize: '1.18em', color: card.color }}>
                  {formatarMoeda(card.value)}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <div
            style={{
              padding: '14px',
              borderTop: '1px solid rgba(16,185,129,0.25)',
              color: 'var(--text-muted)',
            }}
          >
            Resumo previsto indisponivel.
          </div>
        )}

        {incluirAtrasadosPrevistos ? (
          <div
            style={{
              padding: '9px 14px',
              borderTop: '1px solid rgba(245,158,11,0.25)',
              color: 'var(--text-muted)',
              fontSize: '0.84em',
            }}
          >
            {recebimentosPrevistosCaixa.atrasados.total > 0 ? (
              <>
                Atrasados correspondentes ao periodo: {formatarMoeda(recebimentosPrevistosCaixa.atrasados.total)}
                {' '}({formatarMoeda(recebimentosPrevistosCaixa.atrasados.capital)} de capital e{' '}
                {formatarMoeda(recebimentosPrevistosCaixa.atrasados.juros)} de juros).
              </>
            ) : (
              <>Nenhuma parcela atrasada corresponde ao periodo selecionado.</>
            )}
          </div>
        ) : null}
      </section>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 10,
        }}
      >
        {cardsResumoCaixa.map((card) => (
          <button
            type="button"
            key={card.key}
            onClick={() => setFiltroCardCaixa((atual) => (atual === card.key ? '' : card.key))}
            style={{
              textAlign: 'left',
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
              background: 'var(--bg-card)',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow:
                filtroCardCaixa === card.key
                  ? '0 0 0 2px rgba(37,99,235,0.45), 0 10px 24px rgba(37,99,235,0.16)'
                  : 'none',
            }}
            title={
              filtroCardCaixa === card.key
                ? `Remover filtro de ${card.label}`
                : `Filtrar tabela por ${card.label}`
            }
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: '0.86em', color: 'var(--text-muted)' }}>{card.label}</span>
              {card.key === 'total_despesas' ? (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    abrirModalDespesa();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      abrirModalDespesa();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title="Adicionar despesa"
                  style={{
                    width: 22,
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 999,
                    border: '1px solid #2563eb',
                    color: '#60a5fa',
                    fontWeight: 700,
                    fontSize: '1em',
                    lineHeight: 1,
                    userSelect: 'none',
                  }}
                >
                  +
                </span>
              ) : null}
            </div>
            <strong style={{ fontSize: '1.1em' }}>{formatarMoeda(Number(card.value || 0))}</strong>
          </button>
        ))}
      </div>

      {filtroCardCaixa ? (
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'space-between',
            border: '1px solid var(--border-soft)',
            borderRadius: 10,
            background: 'var(--bg-card)',
            padding: '10px 12px',
          }}
        >
          <span style={{ color: 'var(--text-muted)' }}>
            Tabela detalhando: <strong style={{ color: 'var(--text-main)' }}>{filtroCardLabel}</strong>
          </span>
          <button
            type="button"
            onClick={() => setFiltroCardCaixa('')}
            style={{
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid var(--border-soft)',
              background: 'var(--bg-card)',
              color: 'var(--text-main)',
              cursor: 'pointer',
            }}
          >
            Limpar filtro do card
          </button>
        </div>
      ) : null}

      <div style={{ overflowX: 'auto' }}>
        {modoTabelaDespesas ? (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              minWidth: 540,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
            }}
          >
            <thead>
              <tr style={{ background: 'rgba(37,99,235,0.1)' }}>
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  Anotação
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  Valor
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  Data
                </th>
                <th
                  style={{
                    textAlign: 'right',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                    width: 56,
                  }}
                >

                </th>
              </tr>
            </thead>
            <tbody>
              {(linhasCaixaFiltradas || []).length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: 14, color: 'var(--text-muted)' }}>
                    Nenhuma despesa encontrada no periodo selecionado.
                  </td>
                </tr>
              ) : (
                linhasCaixaComSubtotaisDia.map(({ key, item, subtotalDia }) => (
                  <React.Fragment key={key}>
                    <tr>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        <span>{item.descricao || '-'}</span>
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {renderCaixaValue(item.valor_despesa || item.valor_total)}
                      </td>
                      <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                        {item.data_pagamento
                          ? formatarData(item.data_pagamento)
                          : item.data
                            ? formatarData(item.data)
                            : '-'}
                      </td>
                      <td
                        style={{
                          padding: '10px 12px 10px 4px',
                          borderBottom: '1px solid var(--border-soft)',
                          textAlign: 'right',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => excluirDespesa(item)}
                          disabled={excluindoDespesaId === Number(item?.id)}
                          title="Excluir despesa"
                          aria-label="Excluir despesa"
                          style={{
                            padding: '4px 7px',
                            borderRadius: 8,
                            border: '1px solid #ef4444',
                            background: 'transparent',
                            color: '#f87171',
                            cursor: excluindoDespesaId === Number(item?.id) ? 'default' : 'pointer',
                            fontSize: '0.95em',
                            lineHeight: 1,
                          }}
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                    {subtotalDia ? (
                      <tr style={{ background: 'rgba(148,163,184,0.1)', fontWeight: 700 }}>
                        <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                          Total em {formatarDataSubtotalDia(subtotalDia.dataISO)} ({subtotalDia.quantidade})
                        </td>
                        <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                          Despesa: {formatarMoeda(Number(subtotalDia.valor_despesa || subtotalDia.valor_total || 0))}
                        </td>
                        <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>-</td>
                        <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>-</td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              minWidth: minWidthTabela,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
            }}
          >
            <thead>
              <tr style={{ background: 'rgba(37,99,235,0.1)' }}>
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  ID Cliente
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  Nome
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  Tipo
                </th>
                {mostrarDataVencimento ? (
                  <th
                    style={{
                      textAlign: 'left',
                      padding: 10,
                      borderBottom: '1px solid var(--border-soft)',
                      fontSize: '0.88em',
                    }}
                  >
                    Data vencimento
                  </th>
                ) : null}
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  Data pagamento
                </th>
                {mostrarJuros ? (
                  <th
                    style={{
                      textAlign: 'left',
                      padding: 10,
                      borderBottom: '1px solid var(--border-soft)',
                      fontSize: '0.88em',
                    }}
                  >
                    Juros
                  </th>
                ) : null}
                {mostrarCapital ? (
                  <th
                    style={{
                      textAlign: 'left',
                      padding: 10,
                      borderBottom: '1px solid var(--border-soft)',
                      fontSize: '0.88em',
                    }}
                  >
                    Capital
                  </th>
                ) : null}
                {mostrarEmprestimo ? (
                  <th
                    style={{
                      textAlign: 'left',
                      padding: 10,
                      borderBottom: '1px solid var(--border-soft)',
                      fontSize: '0.88em',
                    }}
                  >
                    Emprestimo
                  </th>
                ) : null}
                {mostrarDespesa ? (
                  <th
                    style={{
                      textAlign: 'left',
                      padding: 10,
                      borderBottom: '1px solid var(--border-soft)',
                      fontSize: '0.88em',
                    }}
                  >
                    Despesa
                  </th>
                ) : null}
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  Total
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: 10,
                    borderBottom: '1px solid var(--border-soft)',
                    fontSize: '0.88em',
                  }}
                >
                  Descricao
                </th>
              </tr>
            </thead>
            <tbody>
              {(linhasCaixaFiltradas || []).length === 0 ? (
                <tr>
                  <td colSpan={totalColunasVisiveis} style={{ padding: 14, color: 'var(--text-muted)' }}>
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
                        {mostrarDataVencimento ? (
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {item.data_vencimento ? formatarData(item.data_vencimento) : '-'}
                          </td>
                        ) : null}
                        <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                          {item.data_pagamento ? formatarData(item.data_pagamento) : item.data ? formatarData(item.data) : '-'}
                        </td>
                        {mostrarJuros ? (
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_juros)}
                          </td>
                        ) : null}
                        {mostrarCapital ? (
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_capital)}
                          </td>
                        ) : null}
                        {mostrarEmprestimo ? (
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_emprestimo)}
                          </td>
                        ) : null}
                        {mostrarDespesa ? (
                          <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            {renderCaixaValue(item.valor_despesa)}
                          </td>
                        ) : null}
                        <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                          {renderCaixaValue(item.valor_total)}
                        </td>
                        <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 10,
                              }}
                            >
                              <span>{item.descricao || '-'}</span>
                              {upperSafe(item?.categoria) === 'DESPESA' ? (
                                <button
                                  type="button"
                                  onClick={() => excluirDespesa(item)}
                                  disabled={excluindoDespesaId === Number(item?.id)}
                                  title="Excluir despesa"
                                  aria-label="Excluir despesa"
                                  style={{
                                    padding: '3px 6px',
                                    borderRadius: 8,
                                    border: '1px solid #ef4444',
                                    background: 'transparent',
                                    color: '#f87171',
                                    cursor: excluindoDespesaId === Number(item?.id) ? 'default' : 'pointer',
                                    fontSize: '0.9em',
                                    marginLeft: 'auto',
                                    lineHeight: 1,
                                  }}
                                >
                                  🗑
                                </button>
                              ) : null}
                            </div>
                            {alertaPagamento ? (
                              <small style={{ color: '#fca5a5', fontWeight: 700 }}>{alertaPagamento}</small>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {subtotalDia ? (
                        <tr style={{ background: 'rgba(148,163,184,0.1)', fontWeight: 700 }}>
                          <td colSpan={colSpanDescricaoSubtotalDia} style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                            Total em {formatarDataSubtotalDia(subtotalDia.dataISO)} ({subtotalDia.quantidade})
                            {filtroCardCaixa ? ` - ${filtroCardLabel}` : ''}
                          </td>
                          {mostrarJuros ? (
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Juros: {formatarMoeda(Number(subtotalDia.valor_juros || 0))}
                            </td>
                          ) : null}
                          {mostrarCapital ? (
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Capital: {formatarMoeda(Number(subtotalDia.valor_capital || 0))}
                            </td>
                          ) : null}
                          {mostrarEmprestimo ? (
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Emprestado: {formatarMoeda(Number(subtotalDia.valor_emprestimo || 0))}
                            </td>
                          ) : null}
                          {mostrarDespesa ? (
                            <td style={{ padding: 10, borderBottom: '1px solid var(--border-soft)' }}>
                              Despesa: {formatarMoeda(Number(subtotalDia.valor_despesa || 0))}
                            </td>
                          ) : null}
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
        )}
      </div>

      {despesaModalAberto ? (
        <div
          onClick={fecharModalDespesa}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0, 0, 0, 0.55)',
            display: 'grid',
            placeItems: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 440,
              borderRadius: 12,
              border: '1px solid var(--border-soft)',
              background: 'var(--bg-card)',
              boxShadow: '0 18px 40px rgba(0, 0, 0, 0.35)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <h3 style={{ margin: 0 }}>Adicionar despesa</h3>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span>Valor (R$)</span>
              <input
                type="text"
                inputMode="numeric"
                value={despesaValorInput}
                onChange={(e) => setDespesaValorInput(formatarValorMonetarioInput(e.target.value))}
                placeholder="R$ 0,00"
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-body)',
                  color: 'var(--text-main)',
                }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span>Anotação</span>
              <textarea
                value={despesaAnotacao}
                onChange={(e) => setDespesaAnotacao(e.target.value)}
                placeholder="Descreva a despesa"
                rows={3}
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-body)',
                  color: 'var(--text-main)',
                  resize: 'vertical',
                }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span>Data</span>
              <input
                type="date"
                value={despesaData}
                onChange={(e) => setDespesaData(e.target.value)}
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-body)',
                  color: 'var(--text-main)',
                }}
              />
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={fecharModalDespesa}
                disabled={salvandoDespesa}
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                  cursor: salvandoDespesa ? 'default' : 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={salvarDespesa}
                disabled={salvandoDespesa}
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#2563eb',
                  color: '#fff',
                  cursor: salvandoDespesa ? 'default' : 'pointer',
                  fontWeight: 700,
                }}
              >
                {salvandoDespesa ? 'Salvando...' : 'Salvar despesa'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
