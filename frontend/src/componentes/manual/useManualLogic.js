import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import notify from '../../ui/notify';
import { calcularPreviewParcelas, getTotalDevidoParcela } from '../Emprestimos/helpers.jsx';

export default function useManualLogic({
  emprestimoId,
  valorPagamento,
  dataPagamento,
  observacaoParcela,
  onClose,
}) {
  const valorTotal = (() => {
    if (typeof valorPagamento === 'number') return valorPagamento;
    if (!valorPagamento) return 0;
    const s = String(valorPagamento)
      .replace(/[^\d,.-]/g, '')
      .replace(/\./g, '')
      .replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  })();

  const [emprestimo, setEmprestimo] = useState(null);
  const [parcelas, setParcelas] = useState([]);
  const [capitalOriginalRestante, setCapitalOriginalRestante] = useState(0);
  const [clienteNome, setClienteNome] = useState('');

  const [novoValorStr, setNovoValorStr] = useState('');
  const [novoParcelas, setNovoParcelas] = useState('');
  const [novoTaxa, setNovoTaxa] = useState('');
  const [novoObs, setNovoObs] = useState('');
  const [novoVencimento, setNovoVencimento] = useState('');

  const BRL = (n) =>
    Number(n || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });

  const toNumber = (v) => {
    if (typeof v === 'number') return v;
    if (v == null) return 0;
    const s = String(v || '')
      .replace(/[^\d,.-]/g, '')
      .replace(/\./g, '')
      .replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? 0 : n;
  };

  const inputStyle = {
    width: '100%',
    border: '1px solid var(--border-soft)',
    borderRadius: 6,
    padding: '8px 12px',
    background: 'var(--bg-card)',
    color: 'var(--text-main)',
  };

  const labelMutedStyle = { color: 'var(--text-muted)' };

  function formatBRLFromDigits(digits) {
    const clean = String(digits || '').replace(/\D/g, '');
    if (clean.length === 0) return '';
    const cents = parseInt(clean, 10);
    const num = cents / 100;
    return (
      'R$ ' +
      num.toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  function handleNovoCapitalChange(e) {
    const raw = e.target.value;
    if (!raw || !raw.replace(/\D/g, '')) {
      setNovoValorStr('');
      return;
    }
    setNovoValorStr(formatBRLFromDigits(raw));
  }

  const novoValorNum = useMemo(() => toNumber(novoValorStr), [novoValorStr]);

  const getCodigoEmprestimo = (emp) =>
    emp?.emprestimo_num?.trim?.() ||
    emp?.codigo_cliente?.trim?.() ||
    `${emp?.cliente_id ?? ''}-${emp?.id ?? ''}`;

  function parsePrimeiroVencimento(str) {
    if (!str) return null;
    const s = String(str).trim();
    let y, m, d;

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      [y, m, d] = s.split('-').map(Number);
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
      [d, m, y] = s.split('/').map(Number);
    } else {
      const dt = new Date(s);
      return isNaN(dt.getTime()) ? null : dt;
    }

    if (!y || !m || !d) return null;
    const lastDay = new Date(y, m, 0).getDate();
    const safeDay = Math.min(d, lastDay);
    const dt = new Date(y, m - 1, safeDay);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function primeiroVencimentoUmMesDepois(data) {
    const parsed = parsePrimeiroVencimento(data);
    if (!parsed) return '';

    const nextMonthIndex = parsed.getMonth() + 1;
    const nextYear = parsed.getFullYear() + Math.floor(nextMonthIndex / 12);
    const nextMonth = nextMonthIndex % 12;
    const lastDay = new Date(nextYear, nextMonth + 1, 0).getDate();
    const day = Math.min(parsed.getDate(), lastDay);
    return `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const previewRenegociacao = useMemo(() => {
    const taxaPercent = parseFloat(String(novoTaxa || '0').replace(',', '.'));
    const firstDue = novoVencimento ? parsePrimeiroVencimento(novoVencimento) : null;

    return calcularPreviewParcelas({
      total: novoValorNum,
      parcelas: novoParcelas,
      taxaPercent,
      primeiroVencimento: firstDue,
    });
  }, [novoValorNum, novoParcelas, novoTaxa, novoVencimento]);

  useEffect(() => {
    (async () => {
      try {
        const [empRes, parRes] = await Promise.all([
          axios.get(`/emprestimos/${emprestimoId}`),
          axios.get(`/parcelas/${emprestimoId}`),
        ]);

        const emp = empRes.data || {};
        setEmprestimo(emp);

        const nomeInline = emp.cliente_nome || emp.nome || '';
        setClienteNome(nomeInline);

        if (!nomeInline && emp.cliente_id) {
          try {
            const clienteRes = await axios.get(`/clientes/${emp.cliente_id}`);
            setClienteNome(clienteRes.data?.nome || '');
          } catch (e) {
            console.warn('Não foi possível carregar o nome do cliente:', e);
          }
        }

        const rawParcelas = Array.isArray(parRes.data)
          ? parRes.data
          : Array.isArray(parRes.data?.parcelas)
          ? parRes.data.parcelas
          : [];

        const lista = rawParcelas.map((p, idx) => {
          const valor_total = getTotalDevidoParcela(p);
          const valor_capital = Number(p.valor_capital ?? 0);

          const juros_base = Number(p.valor_juros ?? 0);
          const juros_pendentes = Number(p.juros_pendentes || 0);
          const juros_adicionais = Number(p.juros_adicionais || 0);
          const valor_juros_total = juros_base + juros_pendentes + juros_adicionais;

          const cap_pago = Number(p.capital_pago ?? 0);
          const jur_pago = Number(p.juros_pago ?? 0);

          const quitada =
            Boolean(p.pago) ||
            (p.status || '').toLowerCase() === 'quitada' ||
            Number(p.valor_pago || 0) >= valor_total - 1e-6 ||
            (valor_capital - cap_pago <= 1e-6 &&
              valor_juros_total - jur_pago <= 1e-6);

          const saldoJ = Math.max(valor_juros_total - jur_pago, 0);
          const saldoC = Math.max(valor_capital - cap_pago, 0);

          return {
            id: p.id,
            numero: p.numero || idx + 1,
            vencimento: p.vencimento || null,
            valor_total,
            valor_capital,
            valor_juros: juros_base,
            juros_pendentes,
            juros_adicionais,
            juros_totais: valor_juros_total,
            capital_pago: cap_pago,
            juros_pago: jur_pago,
            quitada,
            saldoJurosBase: quitada ? 0 : saldoJ,
            saldoCapitalBase: quitada ? 0 : saldoC,
            abatJuros: 0,
            abatCapital: 0,
          };
        });

        const capOriginal = lista.reduce(
          (s, p) => (p.quitada ? s : s + Math.max(p.saldoCapitalBase, 0)),
          0
        );
        setCapitalOriginalRestante(Number(capOriginal.toFixed(2)));

        const distribuidas = autoDistribuirAdiantado(lista, valorTotal);
        setParcelas(distribuidas);

        const totalOriginal = Number(emp.parcelas || 0) || lista.length || 0;
        const pagas = lista.filter((x) => x.quitada).length;
        const faltantes = Math.max(totalOriginal - pagas, 1);

        setNovoParcelas(String(faltantes));
        setNovoTaxa(String(emp.taxa_juros ?? 10));
        setNovoObs(emp.observacao || '');

        const sugerido = calcularNovoCapital(distribuidas);
        setNovoValorStr(BRL(sugerido));
      } catch (err) {
        console.error(err);
        notify.error('Erro ao carregar dados do pagamento manual.');
      }
    })();
  }, [emprestimoId, valorTotal]);

  function autoDistribuirAdiantado(lista, montante) {
    const out = lista.map((p) => ({ ...p }));
    let restante = Number(montante || 0);
    if (restante <= 0) return out;

    const abertas = out
      .filter((x) => !x.quitada)
      .sort((a, b) => (a.numero || 0) - (b.numero || 0));
    if (abertas.length === 0) return out;

    const first = abertas[0];
    const faltaJ = Math.max(first.saldoJurosBase - first.abatJuros, 0);
    if (faltaJ > 0 && restante > 0) {
      const usarJ = Math.min(faltaJ, restante);
      first.abatJuros = Number((first.abatJuros + usarJ).toFixed(2));
      restante = Number((restante - usarJ).toFixed(2));
    }
    if (restante > 0) {
      const faltaC = Math.max(first.saldoCapitalBase - first.abatCapital, 0);
      if (faltaC > 0) {
        const usarC = Math.min(faltaC, restante);
        first.abatCapital = Number((first.abatCapital + usarC).toFixed(2));
        restante = Number((restante - usarC).toFixed(2));
      }
    }

    if (restante > 0) {
      for (let i = 1; i < abertas.length && restante > 0; i++) {
        const p = abertas[i];
        const faltaC = Math.max(p.saldoCapitalBase - p.abatCapital, 0);
        if (faltaC <= 0) continue;
        const usar = Math.min(faltaC, restante);
        p.abatCapital = Number((p.abatCapital + usar).toFixed(2));
        restante = Number((restante - usar).toFixed(2));
      }
    }
    return out;
  }

  function calcularNovoCapital(list) {
    return Number(
      list
        .reduce((s, p) => {
          if (p.quitada) return s;
          const capitalRest = Math.max(p.saldoCapitalBase - p.abatCapital, 0);
          return s + capitalRest;
        }, 0)
        .toFixed(2)
    );
  }

  const distribuido = useMemo(
    () =>
      parcelas.reduce(
        (s, p) =>
          s + Number(p.abatJuros || 0) + Number(p.abatCapital || 0),
        0
      ),
    [parcelas]
  );

  const primeirasAbertasOrdenadas = useMemo(
    () =>
      parcelas
        .filter((p) => !p.quitada)
        .sort((a, b) => (a.numero || 0) - (b.numero || 0)),
    [parcelas]
  );
  const primeiraAberta = primeirasAbertasOrdenadas[0] || null;

  useEffect(() => {
    const primeiroVencimento = primeiroVencimentoUmMesDepois(
      primeiraAberta?.vencimento
    );
    if (primeiroVencimento) setNovoVencimento(primeiroVencimento);
  }, [primeiraAberta?.vencimento]);

  const usadoPrimeiraJ = Number(primeiraAberta?.abatJuros || 0);
  const usadoPrimeiraC = Number(primeiraAberta?.abatCapital || 0);
  const usadoPrimeiraTotal = Number(
    (usadoPrimeiraJ + usadoPrimeiraC).toFixed(2)
  );

  const capitalAnterior = Number(
    (
      typeof emprestimo?.capital_restante === 'number'
        ? emprestimo.capital_restante
        : capitalOriginalRestante
    ).toFixed(2)
  );

  const sobraAposParcela = Math.max(
    Number((valorTotal - usadoPrimeiraTotal).toFixed(2)),
    0
  );
  const capitalPosParcela = Number(
    (capitalAnterior - usadoPrimeiraC).toFixed(2)
  );
  const novoCapitalCalculado = useMemo(
    () => calcularNovoCapital(parcelas),
    [parcelas]
  );

  const registrarHabilitado = distribuido > 0;

  const valorTotalParcela = primeiraAberta
    ? Number(primeiraAberta.valor_total || 0)
    : 0;
  const saldoJurosParcela = primeiraAberta
    ? Number(primeiraAberta.saldoJurosBase || 0)
    : 0;
  const capitalParcela = primeiraAberta
    ? Number(primeiraAberta.valor_capital || 0)
    : 0;

  // total de juros da parcela no mês (juros base + adicionais)
  const jurosTotalMes = Math.max(valorTotalParcela - capitalParcela, 0);

  const isJurosParcialPreview =
    valorTotal > 0 &&
    primeiraAberta &&
    jurosTotalMes > 0 &&
    valorTotal < jurosTotalMes - 1e-6;

  const abatExtraCapital = Math.max(capitalPosParcela - novoCapitalCalculado, 0);

  // --- pré-visualização específica para caso de juros parcial ---
  const previewJurosParcial = useMemo(() => {
    if (!isJurosParcialPreview || !primeiraAberta) return [];

    const numeroAtual = primeiraAberta.numero;

    const capital = Number(primeiraAberta.valor_capital || 0);
    const jurosBase = Number(primeiraAberta.valor_juros || 0);
    const jurosPendAntigo = Number(primeiraAberta.juros_pendentes || 0);
    const jurosAdicAtual = Number(primeiraAberta.juros_adicionais || 0);

    // juros totais devidos antes do pagamento (mês + adicionais antigos)
    const jurosTotalAntes = jurosBase + jurosPendAntigo + jurosAdicAtual;

    // valor pago agora em juros (sabemos que é < jurosTotalAntes)
    const pagamento = Number(valorTotal || 0);

    // tudo o que SOBRA de juros continua pendente
    // (inclui base não paga + pendentes antigos + adicionais restantes)
    const jurosPendentes = Math.max(jurosTotalAntes - pagamento, 0);

    // no backend, após o juros parcial:
    // - valor_juros continua sendo o juros base
    // - juros_pendentes = jurosPendentes
          // - valor_total = capital + valor_juros + jurosPendentes + jurosAdicionais
    const novoTotalParcela = capital + jurosBase + jurosPendentes;

    // valor original de contrato (sem adicionais)
    const totalOriginalContratado = capital + jurosBase;

    return parcelas
      .slice()
      .sort((a, b) => (a.numero || 0) - (b.numero || 0))
      .map((p) => {
        const isAtual = p.numero === numeroAtual;

        if (isAtual) {
          return {
            numero: p.numero,
            total: novoTotalParcela,
            total_original: totalOriginalContratado,
            capital,
            juros: jurosBase,
            juros_pendentes: jurosPendentes,
            juros_adicionais: 0,
            juros_adicional: jurosPendentes,
            pago: !!p.quitada,
          };
        }

        // demais parcelas seguem como estão
        return {
          numero: p.numero,
          total: getTotalDevidoParcela(p),
          capital: Number(p.valor_capital || 0),
          juros: Number(p.valor_juros || 0),
          juros_pendentes: Number(p.juros_pendentes || 0),
          juros_adicionais: Number(p.juros_adicionais || 0),
          juros_adicional: Number(p.juros_pendentes || 0),
          pago: !!p.quitada,
        };
      });
  }, [
    isJurosParcialPreview,
    primeiraAberta,
    parcelas,
    valorTotal,
  ]);

  const handleRegistrar = async () => {
    // 🔒 BARREIRA: impedir que o modo MANUAL seja usado para
    // 1) valor exato da parcela
    // 2) valor exato dos juros do mês
    // 3) valor que quita o empréstimo (capital_restante + juros do mês)
    if (primeiraAberta && valorTotal > 0) {
      const epsilon = 0.01;

      const valorParcela = valorTotalParcela; // total da parcela
      const jurosMes = jurosTotalMes; // juros da parcela (base + adicionais)
      const valorQuitar = Number((capitalAnterior + jurosMes).toFixed(2));

      if (Math.abs(valorTotal - valorParcela) < epsilon) {
        notify.warn(
          `Este valor é exatamente o valor da próxima parcela (${BRL(
            valorParcela
          )}). Use o tipo "Pagamento de parcela" em vez do manual.`
        );
        return;
      }

      if (Math.abs(valorTotal - jurosMes) < epsilon) {
        notify.warn(
          `Este valor é exatamente o valor dos juros do mês (${BRL(
            jurosMes
          )}). Use o tipo "Pagamento de juros" em vez do manual.`
        );
        return;
      }

      if (Math.abs(valorTotal - valorQuitar) < epsilon) {
        notify.warn(
          `Este valor quita o empréstimo (capital + juros do mês = ${BRL(
            valorQuitar
          )}). Use o tipo "Quitar Empréstimo" em vez do manual.`
        );
        return;
      }
    }

    // fluxo de juros parcial (valor < juros do mês)
    if (isJurosParcialPreview) {
      try {
        const resp = await axios.post('/pagamentos/manual-juros-parcial', {
          emprestimoId,
          valorPagamento: valorTotal,
          dataPagamento,
          observacaoParcela: observacaoParcela || '',
          parcela_numero: primeiraAberta?.numero ?? null,
        });

        onClose &&
          onClose({
            pagamento_ok: true,
            juros_parcial: true,
            emprestimo_id: emprestimoId,
            parcela: resp?.data?.parcelaAtualizada,
          });

        return;
      } catch (e) {
        notify.error(
          e.response?.data?.erro || 'Erro no pagamento parcial de juros.'
        );
        return;
      }
    }

    try {
      if (!registrarHabilitado) {
        notify.warn('Nada para registrar.');
        return;
      }

      const baseNovoCapital = novoValorNum || novoCapitalCalculado;
      if (!baseNovoCapital || baseNovoCapital <= 0) {
        notify.warn('Informe um novo capital válido (maior que zero).');
        return;
      }

      const qtdParcelas = parseInt(novoParcelas || '0', 10);
      if (!qtdParcelas || qtdParcelas <= 0) {
        notify.warn(
          'Informe uma quantidade válida de parcelas (pelo menos 1).'
        );
        return;
      }

      if (!novoVencimento || !String(novoVencimento).trim()) {
        notify.warn('Informe o 1º vencimento da nova renegociação.');
        return;
      }
      const dtVenc = parsePrimeiroVencimento(novoVencimento);
      if (!dtVenc) {
        notify.warn('Data do 1º vencimento inválida.');
        return;
      }

      const abatimentos = parcelas
        .filter((p) => !p.quitada)
        .map((p) => ({
          parcelaId: p.id,
          numero: p.numero,
          abatJuros: Number(p.abatJuros || 0),
          abatCapital: Number(p.abatCapital || 0),
          abatParcela: Number(
            (Number(p.abatJuros || 0) + Number(p.abatCapital || 0)).toFixed(2)
          ),
        }))
        .filter((i) => i.abatParcela > 0);

      const payloadManual = {
        emprestimoId,
        valorPagamento: valorTotal,
        abatimentos,
        dataPagamento,
        observacao: `Manual auto (adiantado): distrib ${distribuido.toFixed(
          2
        )} de ${valorTotal.toFixed(2)}; juros futuros anulados.`,
        observacaoParcela: observacaoParcela?.trim() || '',
      };

      // Se apenas uma parcela for afetada, envia o numero para vincular no backend
      if (abatimentos.length === 1 && abatimentos[0].numero != null) {
        payloadManual.parcela_numero = abatimentos[0].numero;
      }

      const resPagamento = await axios.post('/pagamentos/manual', payloadManual);
      const pagamentoId = resPagamento?.data?.pagamentoId ?? null;

      if (!emprestimo) {
        notify.warn('Empréstimo base não carregado.');
        return;
      }

      const payloadReneg = {
        valor: baseNovoCapital,
        parcelas: Math.max(parseInt(novoParcelas || '1', 10), 1),
        taxa_juros: toNumber(novoTaxa),
        data: (emprestimo.data || '').slice(0, 10),
        data_pagamento: novoVencimento || null,
        observacao: String(novoObs || ''),
        pagamento_id: pagamentoId,
      };

      const resReneg = await axios.post(
        `/emprestimos/${emprestimoId}/renegociar-inplace`,
        payloadReneg
      );

      if (resReneg?.data?.ok) {
        notify.success(
          `Pagamento registrado e contrato renegociado (ID ${emprestimoId})!`
        );
        onClose &&
          onClose({
            pagamento_ok: true,
            renegociado: true,
            emprestimo_id: emprestimoId,
            versao: resReneg.data?.versao,
          });
      } else {
        throw new Error(resReneg?.data?.erro || 'Falha ao renegociar.');
      }
    } catch (err) {
      console.error(err);
      const msg =
        err.response?.data?.erro ||
        err.response?.data?.error ||
        err.message ||
        'Erro ao registrar.';
      notify.error(msg);
    }
  };

  return {
    valorTotal,
    emprestimo,
    clienteNome,
    inputStyle,
    labelMutedStyle,
    getCodigoEmprestimo,
    isJurosParcialPreview,
    primeiraAberta,
    saldoJurosParcela,
    valorTotalParcela,
    capitalParcela,
    capitalAnterior,
    capitalPosParcela,
    sobraAposParcela,
    abatExtraCapital,
    novoCapitalCalculado,
    usadoPrimeiraJ,
    usadoPrimeiraC,
    BRL,
    novoValorStr,
    handleNovoCapitalChange,
    novoParcelas,
    setNovoParcelas,
    novoTaxa,
    setNovoTaxa,
    novoObs,
    setNovoObs,
    novoVencimento,
    setNovoVencimento,
    previewRenegociacao,
    previewJurosParcial,
    registrarHabilitado,
    distribuido,
    handleRegistrar,
  };
}
