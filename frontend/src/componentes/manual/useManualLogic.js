import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import notify from '../../ui/notify';

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

  const addMonthsAdjust = (date, months) => {
    const d = new Date(date.getTime());
    const targetMonth = d.getMonth() + months;
    const y = d.getFullYear() + Math.floor(targetMonth / 12);
    const m = ((targetMonth % 12) + 12) % 12;
    const day = d.getDate();
    const lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(day, lastDay));
  };

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

  const previewRenegociacao = useMemo(() => {
    const total = novoValorNum;
    const taxa = parseFloat(String(novoTaxa || '0').replace(',', '.')) / 100;
    const m = parseInt(novoParcelas || '0', 10);

    if (!m || m <= 0 || total <= 0) return [];

    let saldo = total;
    const preview = [];

    let firstDue = null;
    if (novoVencimento) {
      const dp = parsePrimeiroVencimento(novoVencimento);
      if (dp) firstDue = dp;
    }

    for (let i = 1; i <= m; i++) {
      const amort = total / m;
      const jurosVal = saldo * taxa;
      const valorParc = amort + jurosVal;

      let vencFormatado;
      if (!firstDue) {
        vencFormatado = 'dd mm aaaa';
      } else {
        const venc = i === 1 ? firstDue : addMonthsAdjust(firstDue, i - 1);
        vencFormatado = `${String(venc.getDate()).padStart(2, '0')}/${String(
          venc.getMonth() + 1
        ).padStart(2, '0')}/${venc.getFullYear()}`;
      }

      preview.push({
        numero: i,
        amortizacao: isNaN(amort) ? 0 : amort,
        juros: isNaN(jurosVal) ? 0 : jurosVal,
        total: isNaN(valorParc) ? 0 : valorParc,
        vencimento: vencFormatado,
      });

      saldo -= amort;
    }
    return preview;
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
          const valor_total = Number(p.valor_total ?? 0);
          const valor_capital = Number(p.valor_capital ?? 0);
          const valor_juros = Number(p.valor_juros ?? 0);
          const cap_pago = Number(p.capital_pago ?? 0);
          const jur_pago = Number(p.juros_pago ?? 0);

          const quitada =
            Boolean(p.pago) ||
            (p.status || '').toLowerCase() === 'quitada' ||
            Number(p.valor_pago || 0) >= valor_total - 1e-6 ||
            (valor_capital - cap_pago <= 1e-6 &&
              valor_juros - jur_pago <= 1e-6);

          const saldoJ = Math.max(valor_juros - jur_pago, 0);
          const saldoC = Math.max(valor_capital - cap_pago, 0);

          return {
            id: p.id,
            numero: p.numero || idx + 1,
            valor_total,
            valor_capital,
            valor_juros,
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

  const isJurosParcialPreview =
    valorTotal > 0 &&
    primeiraAberta &&
    saldoJurosParcela > 0 &&
    valorTotal < saldoJurosParcela - 1e-6;

  const abatExtraCapital = Math.max(capitalPosParcela - novoCapitalCalculado, 0);

  // --- NOVO: pré-visualização específica para caso de juros parcial ---
  const previewJurosParcial = useMemo(() => {
    if (!isJurosParcialPreview || !primeiraAberta) return [];

    const numeroAtual = primeiraAberta.numero;
    const jurosParcela = saldoJurosParcela;
    const jurosRestante = Math.max(jurosParcela - usadoPrimeiraJ, 0);
    const jurosAdicional = jurosRestante;
    const totalAtualComAdicional =
      capitalParcela + jurosParcela + jurosAdicional;

    return parcelas
      .slice()
      .sort((a, b) => (a.numero || 0) - (b.numero || 0))
      .map((p) => {
        const isAtual = p.numero === numeroAtual;

        if (isAtual) {
          return {
            numero: p.numero,
            total: totalAtualComAdicional,
            capital: capitalParcela,
            juros: jurosParcela,
            juros_adicional: jurosAdicional,
            pago: !!p.quitada,
          };
        }

        return {
          numero: p.numero,
          total: p.valor_total,
          capital: p.valor_capital,
          juros: p.valor_juros,
          juros_adicional: 0,
          pago: !!p.quitada,
        };
      });
  }, [
    isJurosParcialPreview,
    primeiraAberta,
    parcelas,
    saldoJurosParcela,
    usadoPrimeiraJ,
    capitalParcela,
  ]);

  const handleRegistrar = async () => {
    if (isJurosParcialPreview) {
      try {
        const resp = await axios.post('/pagamentos/manual-juros-parcial', {
          emprestimoId,
          valorPagamento: valorTotal,
          dataPagamento,
          observacaoParcela: observacaoParcela || ''
        });

        onClose &&
          onClose({
            pagamento_ok: true,
            juros_parcial: true,
            emprestimo_id: emprestimoId,
            parcela: resp?.data?.parcelaAtualizada
          });

        return;
      } catch (e) {
        notify.error(e.response?.data?.erro || 'Erro no pagamento parcial de juros.');
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
        notify.warn('Informe uma quantidade válida de parcelas (pelo menos 1).');
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
          abatJuros: Number(p.abatJuros || 0),
          abatCapital: Number(p.abatCapital || 0),
          abatParcela: Number(
            (Number(p.abatJuros || 0) + Number(p.abatCapital || 0)).toFixed(2)
          ),
        }))
        .filter((i) => i.abatParcela > 0);

      await axios.post('/pagamentos/manual', {
        emprestimoId,
        valorPagamento: valorTotal,
        abatimentos,
        dataPagamento,
        observacao: `Manual auto (adiantado): distrib ${distribuido.toFixed(
          2
        )} de ${valorTotal.toFixed(2)}; juros futuros anulados.`,
        observacaoParcela: observacaoParcela?.trim() || '',
      });

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
    // NOVO: pré-visualização específica para juros parcial
    previewJurosParcial,
    registrarHabilitado,
    distribuido,
    handleRegistrar,
  };
}
