// pagamento.jsx
import React, { useEffect, useState, useMemo } from 'react';
import axios from 'axios';
import Manual from './manual';
import notify from '../ui/notify';
import { useLocation } from 'react-router-dom';
import { renderLinhaJuros, getTotalDevidoParcela } from './Emprestimos/helpers.jsx';
import { isEmprestimoClienteMalPagador } from '../utils/clientRisk';
import ClienteIdentity from './common/ClienteIdentity.jsx';
import useClientesCatalogo from './common/useClientesCatalogo.js';

// baseURL
const hojeLocalISO = () => {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};

const parseLocalISO = (value) => {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

/**
 * Formata uma data em DD/MM/YYYY.
 * Caso seja inválida, devolve '–' ou o próprio valor.
 */
function formatDateSimple(d) {
  if (!d) return '-';
  const dt = parseLocalISO(d) || new Date(d);
  if (isNaN(dt.getTime())) return d;
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export default function Pagamento() {
  const location = useLocation();
  const { resolverCliente } = useClientesCatalogo();
  const [emprestimos, setEmprestimos] = useState([]);
  const [pagamentos, setPagamentos] = useState([]);
  const [busca, setBusca] = useState('');
  const [buscaId, setBuscaId] = useState('');
  const [selecionado, setSelecionado] = useState(null);
  const [valor, setValor] = useState('');
  const [tipoPagamento, setTipoPagamento] = useState('normal');
  const [observacao, setObservacao] = useState('');
  const [loading, setLoading] = useState(true);
  const [paymentDate, setPaymentDate] = useState(() => hojeLocalISO());
  const [ajustarDatasFuturas, setAjustarDatasFuturas] = useState(false);
  const [parcelaSelecionadaId, setParcelaSelecionadaId] = useState(null);

  // Carrega empréstimos e pagamentos
  useEffect(() => {
    let mounted = true;
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [rEmp, rPag] = await Promise.all([
          axios.get('/emprestimos'),
          axios.get('/pagamentos'),
        ]);
        if (!mounted) return;
        setEmprestimos(Array.isArray(rEmp.data) ? rEmp.data : []);
        setPagamentos(Array.isArray(rPag.data) ? rPag.data : []);
      } catch (err) {
        console.error('Erro ao buscar dados:', err);
        if (mounted) {
          setEmprestimos([]);
          setPagamentos([]);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    fetchAll();
    return () => {
      mounted = false;
    };
  }, []);

  // util moeda
  const formatarMoeda = (v) =>
    Number(v || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });

  // limparMoeda: trata valores com '.' como separador de milhares e ',' como decimal
  const limparMoeda = (v) => {
    if (v === undefined || v === null) return 0;
    try {
      let s = String(v).trim();
      s = s.replace(/\./g, ''); // remove separador de milhar
      s = s.replace(/[^\d,-]/g, ''); // mantém dígitos, vírgula e sinal
      s = s.replace(/,/g, '.'); // vírgula -> ponto
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  };

  const handleValorChange = (e) => {
    let raw = e.target.value.replace(/[^\d]/g, '');
    if (!raw) return setValor('');
    const num = parseFloat(raw) / 100;
    setValor(
      num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    );
  };

  const getCodigo = (emp) =>
    emp?.emprestimo_num?.trim?.() ||
    emp?.codigo_cliente?.trim?.() ||
    `${emp?.cliente_id || '0'}-${emp?.id || '0'}`;

  const getNome = (emp) => emp?.cliente_nome || emp?.nome || 'Desconhecido';

  // valor emprestado (sempre o original)
  const getValorEmprestado = (emp) =>
    emp?.valor_emprestado ??
    emp?.valor_original ??
    emp?.valor_inicial ??
    emp?.valor;

  const recarregarPagamentosEemprestimos = async (
    mantainSelecionadoId = null
  ) => {
    try {
      const [rEmp, rPag] = await Promise.all([
        axios.get('/emprestimos'),
        axios.get('/pagamentos'),
      ]);
      const empData = Array.isArray(rEmp.data) ? rEmp.data : [];
      const pagData = Array.isArray(rPag.data) ? rPag.data : [];
      setEmprestimos(empData);
      setPagamentos(pagData);

      if (mantainSelecionadoId) {
        const novo = empData.find((e) => e.id === mantainSelecionadoId);
        if (novo) {
          setSelecionado(novo);
          const valorEmp = getValorEmprestado(novo);
          setBusca(
            `${novo.cliente_nome || novo.nome || 'Desconhecido'} — ${getCodigo(
              novo
            )} — ${formatarMoeda(valorEmp)}`
          );
        } else {
          setSelecionado(null);
          setBusca('');
        }
      } else {
        setSelecionado(null);
        setBusca('');
      }
    } catch (err) {
      console.error('Erro ao recarregar:', err);
    }
  };

  // Busca
  const termo = String(busca || '').trim().toLowerCase();
  const termoId = String(buscaId || '').trim();
  const listaFiltrada = (Array.isArray(emprestimos) ? emprestimos : [])
    .filter((emp) => {
      if (!termo && !termoId) return false;
      if (termoId && !String(emp?.id ?? '').startsWith(termoId)) return false;
      if (!termo) return true;
      const codigo = String(getCodigo(emp)).toLowerCase();
      const nome = String(getNome(emp)).toLowerCase();
      return codigo.startsWith(termo) || nome.startsWith(termo);
    })
    .map((emp) => {
      const codigo = String(getCodigo(emp));
      const [c = '0', s = '0'] = codigo.split('-');
      return { ...emp, _c: Number(c || 0), _s: Number(s || 0) };
    })
    .sort((a, b) => a._c - b._c || a._s - b._s);

  // Parcelas ATUAIS (ignora histórico/renegociadas/numero=-1)
  const parcelasAtivasSelecionado = useMemo(() => {
    if (!selecionado || !Array.isArray(selecionado.parcelasDetalhes)) return [];
    return selecionado.parcelasDetalhes.filter(
      (p) => !p.renegociada && Number(p.numero) !== -1
    );
  }, [selecionado]);

  // próxima parcela (somente dentre as ATIVAS)
  const proximaParcela = useMemo(() => {
    if (!selecionado) return null;
    return parcelasAtivasSelecionado.find((x) => !x.pago) || null;
  }, [selecionado, parcelasAtivasSelecionado]);

  const proximaDataVencimentoFmt = useMemo(() => {
    if (!proximaParcela || !proximaParcela.vencimento) return '-';
    return formatDateSimple(proximaParcela.vencimento);
  }, [proximaParcela]);

  // Seleciona automaticamente via querystring (#/pagamento?emprestimo=&parcela=)
  useEffect(() => {
    if (!Array.isArray(emprestimos) || emprestimos.length === 0) return;
    const params = new URLSearchParams(location.search);
    const empParam = params.get('emprestimo');
    const parcelaParam = params.get('parcela');

    setParcelaSelecionadaId(parcelaParam ? Number(parcelaParam) : null);

    if (!empParam) return;
    const empId = Number(empParam);
    if (!empId) return;

    const alvo = emprestimos.find((e) => Number(e.id) === empId);
    if (!alvo) return;

    setSelecionado(alvo);
    const valorEmp = getValorEmprestado(alvo);
    setBusca(
      `${getNome(alvo)} - ${getCodigo(alvo)} - ${formatarMoeda(valorEmp)}`
    );
    setValor('');
    setTipoPagamento('normal');
    setObservacao('');
    setPaymentDate(hojeLocalISO());
  }, [location.search, emprestimos]);

  // valor para quitar (placeholder)
  const calcularValorParaQuitarFrontend = () => {
    try {
      if (!selecionado) return null;
      const capitalRest = Number(selecionado.capital_restante || 0);
      if (!proximaParcela) return null;

      const jurosBase = Number(
        proximaParcela.original_valor_juros ??
          proximaParcela.valor_juros ??
          0
      );
      const jurosPend = Number(proximaParcela.juros_pendentes || 0);
      const jurosAdic = Number(proximaParcela.juros_adicionais || 0);
      const jurosDaParcela = jurosBase + jurosPend + jurosAdic;

      const expected = Number((capitalRest + jurosDaParcela).toFixed(2));
      return expected;
    } catch {
      return null;
    }
  };
  const valorParaQuitarFrontend = calcularValorParaQuitarFrontend();

  const isManual = String(tipoPagamento) === 'manual';
  const totalPagoSelecionado = useMemo(() => {
    if (!selecionado) return 0;
    if (typeof selecionado.total_pago !== 'undefined') {
      return Number(selecionado.total_pago || 0);
    }
    if (!Array.isArray(pagamentos)) return 0;
    return pagamentos
      .filter((p) => p.emprestimo_id === selecionado.id)
      .reduce((s, p) => s + Number(p.valor || 0), 0);
  }, [selecionado, pagamentos]);
  const capitalRestanteSelecionado = Number(
    selecionado?.capital_restante || 0
  );
  const valorProximaParcela = proximaParcela
    ? getTotalDevidoParcela(proximaParcela)
    : null;

  const registrarPagamento = async () => {
    if (!selecionado) {
      notify.warn('Selecione um emprestimo.');
      return;
    }
    const vnum = limparMoeda(valor);
    if (vnum <= 0) {
      notify.warn('Informe um valor valido.');
      return;
    }

    if (isManual) {
      // No modo manual o registro acontece no painel da DIREITA
      notify.info('Distribua e registre pelo painel da direita.');
      return;
    }

    if (!['normal', 'manual', 'juros', 'quitar'].includes(tipoPagamento)) {
      notify.error('Tipo invalido.');
      return;
    }

    const proxima = Array.isArray(parcelasAtivasSelecionado)
      ? parcelasAtivasSelecionado.find((p) => !p.pago)
      : null;

    if (!proxima && tipoPagamento !== 'manual') {
      notify.info(
        'Nao ha parcela pendente (use pagamento manual se necessario).'
      );
      return;
    }

    if (tipoPagamento === 'normal') {
      if (!proxima) {
        notify.error('Parcela alvo nao encontrada.');
        return;
      }
      const parcelaValor = getTotalDevidoParcela(proxima);
      if (Math.abs(vnum - parcelaValor) > 0.001) {
        if (vnum < parcelaValor) {
          notify.warn(
            `Pagamento de parcela exige valor exato da parcela (${formatarMoeda(
              parcelaValor
            )}).`
          );
        } else {
          notify.warn(
            `Valor informado excede o valor da parcela (${formatarMoeda(
              parcelaValor
            )}).`
          );
        }
        return;
      }
    }

    if (tipoPagamento === 'juros') {
      if (!proxima) {
        notify.error('Parcela alvo nao encontrada.');
        return;
      }

      // juros efetivos = juros base + juros adicionais (atraso)
      const jurosBase = Number(
        proxima.original_valor_juros ?? proxima.valor_juros ?? 0
      );
      const jurosPend = Number(proxima.juros_pendentes || 0);
      const jurosAdic = Number(proxima.juros_adicionais || 0);
      const jurosTotal = Number((jurosBase + jurosPend + jurosAdic).toFixed(2));

      if (Math.abs(vnum - jurosTotal) > 0.001) {
        notify.warn(
          `Pagamento de juros exige valor exato (${formatarMoeda(
            jurosTotal
          )}).`
        );
        return;
      }
    }

    const payload = {
      emprestimo_id: selecionado.id,
      valor: vnum,
      tipoPagamento,
      observacao,
      data: paymentDate,
      ajustarDatasFuturas,
    };
    if (proxima && proxima.numero != null) {
      payload.parcela_numero = proxima.numero; // 1-based
    }

    try {
      const res = await axios.post('/pagamentos', payload);
      notify.success(res.data?.info || 'Pagamento registrado!');
      setBusca('');
      setValor('');
      setTipoPagamento('normal');
      setObservacao('');
      setPaymentDate(hojeLocalISO());
      await recarregarPagamentosEemprestimos(selecionado.id);
    } catch (err) {
      console.error('Erro ao registrar:', err);
      const msg =
        err.response?.data?.erro ||
        err.response?.data?.error ||
        err.message ||
        'Erro ao registrar pagamento';
      notify.error(msg);
    }
  };

  // —— UI ————————————————————————————————————————————————————————————————
  return (
    <div
      style={{
        maxWidth: isManual
          ? 'var(--main-max-effective, var(--main-max))'
          : 'min(1200px, var(--main-max-effective, var(--main-max)))',
        margin: 'auto',
        padding: 20,
        fontFamily: 'sans-serif',
      }}
    >
      <h2 style={{ textAlign: 'center', marginBottom: 8 }}>
        Registrar Pagamento
      </h2>

      {loading && <p style={{ textAlign: 'center' }}>Carregando...</p>}

      {/* GRID: quando manual, duas colunas (ESQ: painel atual | DIR: Manual) */}
      <div
        style={
          isManual
            ? {
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) 560px',
                columnGap: 40,
                alignItems: 'start',
              }
            : {}
        }
      >
        {/* COLUNA ESQUERDA */}
        <div
          style={isManual ? { paddingRight: 8, position: 'relative', zIndex: 1 } : {}}
        >
          <label style={{ display: 'block', marginBottom: 6, color: 'var(--text-main)' }}>
            Buscar Empréstimo
          </label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input
              type="text"
              inputMode="numeric"
              placeholder="ID"
              aria-label="Buscar empréstimo por ID"
              value={buscaId}
              onChange={(e) => {
                setBuscaId(e.target.value.replace(/\D/g, ''));
                setSelecionado(null);
              }}
              style={{
                width: 82,
                padding: 8,
                borderRadius: 6,
                border: '1px solid var(--border-soft)',
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
              }}
            />
            <input
              type="text"
              placeholder="Buscar por nome ou código"
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                setSelecionado(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const primeiro = listaFiltrada[0];
                if (!primeiro) return;
                const valorEmp = getValorEmprestado(primeiro);
                setSelecionado(primeiro);
                setBusca(
                  `${getNome(primeiro)} - ${getCodigo(primeiro)} - ${formatarMoeda(
                    valorEmp
                  )}`
                );
                setValor('');
                setTipoPagamento('normal');
                setObservacao('');
                setPaymentDate(hojeLocalISO());
              }}
              style={{
                flex: 1,
                minWidth: 0,
                padding: 8,
                borderRadius: 6,
                border: '1px solid var(--border-soft)',
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
              }}
            />
          </div>

          {(busca || buscaId) && !selecionado && (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                border: '1px solid var(--border-soft)',
                borderRadius: 4,
                maxHeight: 180,
                overflowY: 'auto',
                marginBottom: 12,
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
              }}
            >
              {listaFiltrada.length ? (
                listaFiltrada.map((emp) => {
                  const valorEmp = getValorEmprestado(emp);
                  const empMalPagador = isEmprestimoClienteMalPagador(emp);
                  return (
                    <li
                      key={emp.id}
                      className={empMalPagador ? 'loan-entry--risk' : undefined}
                      onClick={() => {
                        setSelecionado(emp);
                        setBusca(
                          `${getNome(emp)} — ${getCodigo(
                            emp
                          )} — ${formatarMoeda(valorEmp)}`
                        );
                        setValor('');
                        setTipoPagamento('normal');
                        setObservacao('');
                      setPaymentDate(hojeLocalISO());
                      }}
                      style={{
                        padding: 8,
                        cursor: 'pointer',
                        borderBottom: '1px solid var(--border-soft)',
                      }}
                    >
                      <div className="cliente-payment-result">
                        <ClienteIdentity
                          cliente={resolverCliente(emp.cliente_id, getNome(emp))}
                          avatarSize={36}
                          secondary={`${getCodigo(emp)} • ${formatarMoeda(valorEmp)}`}
                        />
                        {empMalPagador ? (
                          <span className="badge-risk badge-risk--inline">
                            Cliente mal pagador
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })
              ) : (
                <li style={{ padding: 8, color: 'var(--text-muted)' }}>Nenhum resultado</li>
              )}
            </ul>
          )}

          {selecionado && (
            <div
              style={{
                marginBottom: 14,
                color: 'var(--text-main)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <section
                className={
                  isEmprestimoClienteMalPagador(selecionado)
                    ? 'loan-entry--risk'
                    : undefined
                }
                style={{
                  border: isEmprestimoClienteMalPagador(selecionado)
                    ? '1px solid var(--risk-border)'
                    : '1px solid var(--border-soft)',
                  borderRadius: 10,
                  background: isEmprestimoClienteMalPagador(selecionado)
                    ? 'var(--risk-bg-soft)'
                    : 'var(--bg-card)',
                  padding: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div
                      style={{
                        color: 'var(--text-muted)',
                        fontSize: 12,
                        letterSpacing: '0.03em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Selecionado
                    </div>
                    <div style={{ marginTop: 4, fontWeight: 700, fontSize: 18, lineHeight: 1.15 }}>
                      <ClienteIdentity
                        cliente={resolverCliente(
                          selecionado.cliente_id,
                          getNome(selecionado)
                        )}
                        avatarSize={48}
                        secondary={`Cliente ID ${selecionado.cliente_id ?? '-'}`}
                      />
                      {isEmprestimoClienteMalPagador(selecionado) ? (
                        <>
                          {' '}
                          <span className="badge-risk badge-risk--inline">
                            Cliente mal pagador
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        padding: '4px 10px',
                        borderRadius: 999,
                        border: '1px solid var(--border-soft)',
                        background: 'var(--bg-body)',
                        fontWeight: 600,
                        fontSize: 12,
                      }}
                    >
                      ID {getCodigo(selecionado)}
                    </span>
                    {parcelaSelecionadaId ? (
                      <span
                        style={{
                          padding: '4px 10px',
                          borderRadius: 999,
                          border: '1px solid rgba(37,99,235,0.35)',
                          background: 'rgba(37,99,235,0.12)',
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                      >
                        Parcela alvo #{parcelaSelecionadaId}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))',
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      border: '1px solid var(--border-soft)',
                      borderRadius: 7,
                      padding: '7px 9px',
                      background: 'var(--bg-body)',
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Modalidade</div>
                    <div style={{ fontWeight: 600, marginTop: 2 }}>
                      {selecionado.modalidade === 'aberto' ? 'Em aberto' : 'Parcelado'}
                    </div>
                  </div>
                  <div
                    style={{
                      border: '1px solid var(--border-soft)',
                      borderRadius: 7,
                      padding: '7px 9px',
                      background: 'var(--bg-body)',
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Valor emprestado</div>
                    <div style={{ fontWeight: 700, marginTop: 2 }}>
                      {formatarMoeda(getValorEmprestado(selecionado))}
                    </div>
                  </div>
                  <div
                    style={{
                      border: '1px solid var(--border-soft)',
                      borderRadius: 7,
                      padding: '7px 9px',
                      background: 'var(--bg-body)',
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Próximo vencimento</div>
                    <div style={{ fontWeight: 600, marginTop: 2 }}>{proximaDataVencimentoFmt}</div>
                  </div>
                  <div
                    style={{
                      border: '1px solid var(--border-soft)',
                      borderRadius: 7,
                      padding: '7px 9px',
                      background: 'var(--bg-body)',
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Observação</div>
                    <div
                      style={{
                        fontWeight: 600,
                        marginTop: 2,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={selecionado.observacao || 'Sem observação'}
                    >
                      {selecionado.observacao || 'Sem observação'}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      border: '1px solid var(--border-soft)',
                      borderRadius: 7,
                      padding: '7px 9px',
                      background: 'var(--bg-body)',
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total pago</div>
                    <div style={{ marginTop: 2, fontSize: 18, fontWeight: 700 }}>
                      {formatarMoeda(totalPagoSelecionado)}
                    </div>
                  </div>
                  <div
                    style={{
                      border: '1px solid var(--border-soft)',
                      borderRadius: 7,
                      padding: '7px 9px',
                      background: 'var(--bg-body)',
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Capital restante</div>
                    <div style={{ marginTop: 2, fontSize: 18, fontWeight: 700 }}>
                      {formatarMoeda(capitalRestanteSelecionado)}
                    </div>
                  </div>
                  <div
                    style={{
                      border: proximaParcela
                        ? '1px solid rgba(37, 99, 235, 0.54)'
                        : '1px solid var(--border-soft)',
                      borderRadius: 7,
                      padding: '7px 9px',
                      background: proximaParcela
                        ? 'linear-gradient(180deg, rgba(59, 130, 246, 0.144), rgba(59, 130, 246, 0.06))'
                        : 'var(--bg-body)',
                      boxShadow: proximaParcela
                        ? 'inset 0 0 0 1px rgba(59, 130, 246, 0.168)'
                        : 'none',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        color: proximaParcela ? '#1e3a8a' : 'var(--text-muted)',
                        fontWeight: proximaParcela ? 700 : 400,
                      }}
                    >
                      Parcela atual
                    </div>
                    <div style={{ marginTop: 2, fontSize: 18, fontWeight: 700 }}>
                      {valorProximaParcela != null
                        ? formatarMoeda(valorProximaParcela)
                        : '-'}
                    </div>
                    {proximaParcela ? (
                      <div style={{ fontSize: 12, marginTop: 2, color: 'var(--text-muted)' }}>
                        Venc.: {formatDateSimple(proximaParcela.vencimento)}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>

              {parcelasAtivasSelecionado.length > 0 && (
                <section
                  style={{
                    border: '1px solid var(--border-soft)',
                    borderRadius: 10,
                    background: 'var(--bg-card)',
                    padding: 10,
                  }}
                >
                  <div
                    style={{
                      marginBottom: 8,
                      fontWeight: 700,
                      fontSize: 15,
                    }}
                  >
                    Parcelas
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                      gap: 8,
                    }}
                  >
                    {parcelasAtivasSelecionado.map((p) => {
                      const totalDevido = getTotalDevidoParcela(p);
                      const parcelaPaga = Boolean(p.pago);
                      const originalBase =
                        p.valor_original ??
                        (p.valor_total != null ? Number(p.valor_total || 0) : null);
                      const mostrarOriginal =
                        originalBase != null &&
                        Number(originalBase) > 0 &&
                        Math.abs(Number(originalBase) - Number(totalDevido || 0)) > 0.009;
                      return (
                        <article
                          key={p.numero}
                          style={{
                            border: parcelaPaga
                              ? '1px solid rgba(22, 163, 74, 0.45)'
                              : '1px solid var(--border-soft)',
                            borderRadius: 7,
                            padding: 8,
                            background: parcelaPaga
                              ? 'linear-gradient(180deg, rgba(34, 197, 94, 0.14), rgba(34, 197, 94, 0.07))'
                              : 'var(--bg-body)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            boxShadow: parcelaPaga
                              ? 'inset 0 0 0 1px rgba(22, 163, 74, 0.07)'
                              : 'none',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            <strong style={{ opacity: parcelaPaga ? 0.58 : 1 }}>
                              {p.numero}ª parcela
                            </strong>
                            {p.pago ? (
                              <span
                                style={{
                                  borderRadius: 999,
                                  padding: '3px 10px',
                                  fontSize: 12,
                                  fontWeight: 800,
                                  letterSpacing: '0.01em',
                                  color: '#f0fdf4',
                                  background: '#15803d',
                                  border: '1px solid #166534',
                                  boxShadow: '0 1px 4px rgba(21, 128, 61, 0.3)',
                                }}
                              >
                                ✓ Pago
                              </span>
                            ) : null}
                          </div>
                          <div style={{ fontSize: 21, fontWeight: 700, opacity: parcelaPaga ? 0.58 : 1 }}>
                            {formatarMoeda(totalDevido)}
                          </div>
                          {mostrarOriginal ? (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', opacity: parcelaPaga ? 0.62 : 1 }}>
                              Original: {formatarMoeda(originalBase)}
                            </div>
                          ) : null}
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', opacity: parcelaPaga ? 0.62 : 1 }}>
                            {renderLinhaJuros(
                              {
                                valor_capital: p.valor_capital,
                                valor_juros: p.valor_juros,
                                juros_pendentes: p.juros_pendentes || 0,
                                juros_adicionais: p.juros_adicionais || 0,
                              },
                              formatarMoeda
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', opacity: parcelaPaga ? 0.62 : 1 }}>
                            Vencimento: {formatDateSimple(p.vencimento)}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* Inputs principais */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 10,
              marginBottom: 8,
            }}
          >
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 13,
                  marginBottom: 6,
                  color: 'var(--text-main)',
                }}
              >
                Cliente está pagando agora
              </label>
              <input
                type="text"
                placeholder={
                  !isManual &&
                  tipoPagamento === 'quitar' &&
                  valorParaQuitarFrontend != null
                    ? formatarMoeda(valorParaQuitarFrontend)
                    : 'R$'
                }
                value={valor}
                onChange={handleValorChange}
                style={{
                  width: '100%',
                  padding: 6,
                  borderRadius: 4,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                }}
              />
            </div>

            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 13,
                  marginBottom: 6,
                  color: 'var(--text-main)',
                }}
              >
                Tipo de pagamento
              </label>
              <select
                value={tipoPagamento}
                onChange={(e) => setTipoPagamento(e.target.value)}
                style={{
                  width: '100%',
                  padding: 6,
                  borderRadius: 4,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                }}
              >
                <option value="normal">Pagamento de parcela</option>
                <option value="manual">Pagamento em aberto</option>
                <option value="juros">Pagamento de juros</option>
                <option value="quitar">Quitar Empréstimo</option>
              </select>
            </div>

            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 13,
                  marginBottom: 6,
                  color: 'var(--text-main)',
                }}
              >
                Data do pagamento
              </label>
              <input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: 6,
                  borderRadius: 4,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                }}
              />
            </div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <label
              style={{
                display: 'block',
                fontSize: 13,
                marginBottom: 6,
              }}
            >
              {isManual ? 'Observação na parcela' : 'Observação'}
            </label>
            <textarea
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder="(opcional)"
              style={{
                width: '100%',
                padding: 8,
                minHeight: 64,
                resize: 'vertical',
                borderRadius: 4,
                border: '1px solid var(--border-soft)',
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
              }}
            />
          </div>

          {/* Botão da ESQUERDA só aparece se NÃO for manual */}
          {!isManual && (
            <button
              onClick={registrarPagamento}
              style={{
                marginTop: 6,
                width: '100%',
                padding: 10,
                background: '#28a745',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Registrar
            </button>
          )}
        </div>

        {/* COLUNA DIREITA – Painel do Manual embutido */}
        {isManual && selecionado && (
          <div
            style={{
              borderLeft: '1px solid var(--border-soft)',
              paddingLeft: 16,
              position: 'sticky',
              top: 16,
              zIndex: 2,
              background: 'var(--bg-card)',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.05)',
            }}
          >
            <Manual
              emprestimoId={selecionado.id}
              valorPagamento={limparMoeda(valor)}
              dataPagamento={paymentDate}
              observacaoParcela={observacao}
              onClose={(dados) => {
                // finalização do fluxo manual (pagamento + novo empréstimo)
                if (dados) {
                  notify.success('Pagamento manual registrado!');
                  recarregarPagamentosEemprestimos(selecionado.id);
                  setSelecionado(null);
                  setValor('');
                  setTipoPagamento('normal');
                  setObservacao('');
                  setPaymentDate(hojeLocalISO());
                  return;
                }
                // cancelado: volta para pagamento de parcela
                setTipoPagamento('normal');
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
