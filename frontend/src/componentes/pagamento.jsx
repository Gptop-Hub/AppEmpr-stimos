// pagamento.jsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import Manual from './manual';
import notify from '../ui/notify';

// baseURL
axios.defaults.baseURL = 'http://localhost:3001';

export default function Pagamento() {
  const [emprestimos, setEmprestimos] = useState([]);
  const [pagamentos, setPagamentos] = useState([]);
  const [busca, setBusca] = useState('');
  const [selecionado, setSelecionado] = useState(null);
  const [valor, setValor] = useState('');
  const [tipoPagamento, setTipoPagamento] = useState('normal');
  const [observacao, setObservacao] = useState('');
  const [mostrarManual, setMostrarManual] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Carrega empréstimos e pagamentos
  useEffect(() => {
    let mounted = true;
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [rEmp, rPag] = await Promise.all([axios.get('/emprestimos'), axios.get('/pagamentos')]);
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
    return () => { mounted = false; };
  }, []);

  // util moeda
  const formatarMoeda = v =>
    Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // limparMoeda: trata valores com '.' como separador de milhares e ',' como decimal
  const limparMoeda = v => {
    if (v === undefined || v === null) return 0;
    try {
      let s = String(v).trim();
      // remove "R$", espaços, letras etc, mas preserva dígitos, pontos e vírgulas
      // primeiro: remover pontos de milhares
      s = s.replace(/\./g, '');
      // agora manter apenas dígitos, vírgula, sinal e ponto caso exista (firm fallback)
      s = s.replace(/[^\d,-]/g, '');
      // trocar vírgula por ponto para parseFloat
      s = s.replace(/,/g, '.');
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  };

  const handleValorChange = e => {
    // quando usuário digita, mantemos a lógica atual (entrada por dígitos)
    let raw = e.target.value.replace(/[^\d]/g, '');
    if (!raw) return setValor('');
    const num = parseFloat(raw) / 100;
    setValor(num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  };

  const recarregarPagamentosEemprestimos = async (mantainSelecionadoId = null) => {
    try {
      const [rEmp, rPag] = await Promise.all([axios.get('/emprestimos'), axios.get('/pagamentos')]);
      const empData = Array.isArray(rEmp.data) ? rEmp.data : [];
      const pagData = Array.isArray(rPag.data) ? rPag.data : [];
      setEmprestimos(empData);
      setPagamentos(pagData);

      if (mantainSelecionadoId) {
        const novo = empData.find(e => e.id === mantainSelecionadoId);
        if (novo) {
          setSelecionado(novo);
          setBusca(`${novo.cliente_nome || novo.nome || 'Desconhecido'} — ${(novo.codigo_cliente || novo.emprestimo_num || `${novo.cliente_id}-${novo.id}`)} — ${formatarMoeda(novo.valor)}`);
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

  const getCodigo = emp =>
    (emp?.emprestimo_num?.trim?.()) ||
    (emp?.codigo_cliente?.trim?.()) ||
    `${emp?.cliente_id || '0'}-${emp?.id || '0'}`;

  const getNome = emp => emp?.cliente_nome || emp?.nome || 'Desconhecido';

  // Busca
  const termo = String(busca || '').trim().toLowerCase();
  const listaFiltrada = (Array.isArray(emprestimos) ? emprestimos : [])
    .filter(emp => {
      if (!termo) return false;
      const codigo = String(getCodigo(emp)).toLowerCase();
      const nome   = String(getNome(emp)).toLowerCase();
      return codigo.startsWith(termo) || nome.startsWith(termo);
    })
    .map(emp => {
      const codigo = String(getCodigo(emp));
      const [c = '0', s = '0'] = codigo.split('-');
      return { ...emp, _c: Number(c || 0), _s: Number(s || 0) };
    })
    .sort((a,b)=> a._c - b._c || a._s - b._s);

  // próxima parcela
  const proximaParcela = (() => {
    if (!selecionado || !Array.isArray(selecionado.parcelasDetalhes)) return null;
    return selecionado.parcelasDetalhes.find(x => !x.pago);
  })();

  const formatDateSimple = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  // Computa valor esperado para quitação (usado apenas para mostrar no placeholder)
  const calcularValorParaQuitarFrontend = () => {
    try {
      if (!selecionado) return null;
      const capitalRest = Number(selecionado.capital_restante || 0);
      if (!proximaParcela) return null;
      const jurosDaParcela = Number(proximaParcela.original_valor_juros ?? proximaParcela.valor_juros ?? 0);
      const expected = Number((capitalRest + jurosDaParcela).toFixed(2));
      return expected;
    } catch {
      return null;
    }
  };

  const valorParaQuitarFrontend = calcularValorParaQuitarFrontend();

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

    if (!['normal', 'manual', 'juros', 'quitar'].includes(tipoPagamento)) {
      notify.error('Tipo invalido.');
      return;
    }

    const proxima = Array.isArray(selecionado.parcelasDetalhes)
      ? selecionado.parcelasDetalhes.find((p) => !p.pago)
      : null;

    if (!proxima && tipoPagamento !== 'manual') {
      notify.info('Nao ha parcela pendente (use pagamento manual se necessario).');
      return;
    }

    if (tipoPagamento === 'manual') {
      setMostrarManual(true);
      return;
    }

    if (tipoPagamento === 'normal') {
      if (!proxima) {
        notify.error('Parcela alvo nao encontrada.');
        return;
      }
      const parcelaValor = Number(proxima.valor_total || 0);
      if (Math.abs(vnum - parcelaValor) > 0.001) {
        if (vnum < parcelaValor) {
          notify.warn(`Pagamento comum exige valor exato da parcela (${formatarMoeda(parcelaValor)}).`);
        } else {
          notify.warn(`Valor informado excede o valor da parcela (${formatarMoeda(parcelaValor)}).`);
        }
        return;
      }
    }

    if (tipoPagamento === 'juros') {
      if (!proxima) {
        notify.error('Parcela alvo nao encontrada.');
        return;
      }
      const jurosOrig = Number(proxima.original_valor_juros ?? proxima.valor_juros ?? 0);
      if (Math.abs(vnum - jurosOrig) > 0.001) {
        notify.warn(`Pagamento de juros exige valor exato (${formatarMoeda(jurosOrig)}).`);
        return;
      }
    }

    if (tipoPagamento === 'quitar') {
      console.log('[DEBUG_FRONT] tipo=quitar, vnum=', vnum, 'expected(front)=', valorParaQuitarFrontend);
    }

    const payload = {
      emprestimo_id: selecionado.id,
      valor: vnum,
      tipoPagamento,
      observacao,
      data: paymentDate,
    };

    console.log('[DEBUG_FRONT] payload antes do POST /pagamentos:', payload, 'tipoPagamento=', tipoPagamento);

    try {
      const res = await axios.post('/pagamentos', payload);
      notify.success(res.data?.info || 'Pagamento registrado!');
      setBusca('');
      setValor('');
      setTipoPagamento('normal');
      setObservacao('');
      setPaymentDate(new Date().toISOString().slice(0, 10));
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

  return (
    <div style={{ maxWidth: 420, margin: 'auto', padding: 20, fontFamily: 'sans-serif' }}>
      <h2 style={{ textAlign: 'center', marginBottom: 8 }}>💵 Registrar Pagamento</h2>

      {loading && <p style={{ textAlign: 'center' }}>Carregando...</p>}

      <label style={{ display:'block', marginBottom:6 }}>Buscar Empréstimo</label>
      <input
        type="text"
        placeholder="ID ou Nome"
        value={busca}
        onChange={e => { setBusca(e.target.value); setSelecionado(null); }}
        style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', marginBottom: 10 }}
      />

      {busca && !selecionado && (
        <ul style={{ listStyle:'none', padding:0, border:'1px solid #ccc', borderRadius:4, maxHeight:180, overflowY:'auto', marginBottom:12 }}>
          {listaFiltrada.length ? listaFiltrada.map(emp => (
            <li
              key={emp.id}
              onClick={() => {
                setSelecionado(emp);
                setBusca(`${getNome(emp)} — ${getCodigo(emp)} — ${formatarMoeda(emp.valor)}`);
                setValor('');
                setTipoPagamento('normal');
                setObservacao('');
                setPaymentDate(new Date().toISOString().slice(0,10));
              }}
              style={{ padding:8, cursor:'pointer', borderBottom: '1px solid #eee' }}
            >
              {getNome(emp)} — {getCodigo(emp)} — {formatarMoeda(emp.valor)}
            </li>
          )) : <li style={{ padding:8, color:'#777' }}>Nenhum resultado</li>}
        </ul>
      )}

      {selecionado && (
        <div style={{ marginBottom: 12, lineHeight: 1.4 }}>
          <strong>Selecionado:</strong><br />
          <div style={{ marginTop:6, fontWeight:600 }}>{getNome(selecionado)}</div>
          <div style={{ marginTop:6 }}>
            ID: {getCodigo(selecionado)}<br />
            Modalidade: {selecionado.modalidade === 'aberto' ? 'Em aberto' : 'Parcelado'}<br />
            Valor emprestado: {formatarMoeda(selecionado.valor)}<br />
            Data de início do empréstimo: {selecionado.data ? formatDateSimple(selecionado.data) : '—'}<br />
            Observação: {selecionado.observacao || '—'}<br />
            <div style={{ marginTop:8 }}>
              <strong>Total pago:</strong> {' '}
              {formatarMoeda(
                (typeof selecionado.total_pago !== 'undefined')
                  ? selecionado.total_pago
                  : (Array.isArray(pagamentos) ? pagamentos.filter(p => p.emprestimo_id === selecionado.id).reduce((s,p)=>s+p.valor,0) : 0)
              )}
            </div>
            <div style={{ marginTop:6 }}>
              <strong>💰 Capital restante:</strong> {' '}
              {formatarMoeda(typeof selecionado.capital_restante !== 'undefined' ? selecionado.capital_restante : 0)}
            </div>
          </div>

          {Array.isArray(selecionado.parcelasDetalhes) && selecionado.parcelasDetalhes.length > 0 && (
            <>
              <div style={{ marginTop:10 }}>
                <strong>Parcelas:</strong>
                <ul style={{ paddingLeft: 16, marginTop:8 }}>
                  {selecionado.parcelasDetalhes.map(p => {
                    const jurosOrig = Number(p.original_valor_juros ?? p.valor_juros ?? 0);
                    return (
                      <li key={p.numero} style={{ marginBottom: 10 }}>
                        <div style={{ fontWeight:600 }}>
                          {p.numero}ª: {formatarMoeda(p.valor_total)} {p.pago ? '✅ Pago' : ''}
                        </div>
                        <div style={{ fontSize:13 }}>
                          (Capital: {formatarMoeda(p.valor_capital)}, Juros: {formatarMoeda(jurosOrig)})
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {/* Capital + próxima parcela */}
                <div style={{ marginTop:8, background:'#f7f7f7', padding:8, borderRadius:4 }}>
                  <div style={{ marginBottom: 10 }}>
                    <strong>💰 Capital restante:</strong> {formatarMoeda(selecionado.capital_restante || 0)}
                  </div>
                  {proximaParcela && (
                    <>
                      <div style={{ marginTop: 10 }}>
                        <strong>➡️ Próxima:</strong> {formatarMoeda(proximaParcela.valor_total)}
                      </div>
                      <div style={{ fontSize:13, marginTop: 4 }}>
                        (Capital: {formatarMoeda(proximaParcela.valor_capital)}, Juros: {formatarMoeda(proximaParcela.valor_juros)})
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
        <div style={{ flex: '0 0 170px' }}>
          <label style={{ display:'block', fontSize:13, marginBottom:6 }}>Valor do pagamento</label>
          <input
            type="text"
            placeholder={tipoPagamento === 'quitar' && valorParaQuitarFrontend != null ? formatarMoeda(valorParaQuitarFrontend) : 'R$'}
            value={valor}
            onChange={handleValorChange}
            style={{ width: '100%', padding:6, borderRadius:4, border:'1px solid #ccc' }}
          />
        </div>

        <div style={{ flex: '0 0 160px' }}>
          <label style={{ display:'block', fontSize:13, marginBottom:6 }}>Tipo</label>
          <select
            value={tipoPagamento}
            onChange={e => setTipoPagamento(e.target.value)}
            style={{ width: '100%', padding:6, borderRadius:4, border:'1px solid #ccc' }}
          >
            <option value="normal">Pagamento comum</option>
            <option value="manual">Pagamento manual</option>
            <option value="juros">Pagamento de juros</option>
            <option value="quitar">Quitar Empréstimo</option>
          </select>
        </div>

        <div style={{ flex: '0 0 120px' }}>
          <label style={{ display:'block', fontSize:13, marginBottom:6 }}>Data</label>
          <input
            type="date"
            value={paymentDate}
            onChange={e => setPaymentDate(e.target.value)}
            style={{ width:'100%', padding:6, borderRadius:4, border:'1px solid #ccc' }}
          />
        </div>
      </div>

      <div style={{ marginBottom: 8 }}>
        <label style={{ display:'block', fontSize:13, marginBottom:6 }}>Observação</label>
        <textarea
          value={observacao}
          onChange={e => setObservacao(e.target.value)}
          placeholder="(opcional)"
          style={{ width:'100%', padding:8, minHeight:64, resize:'vertical', borderRadius:4, border:'1px solid #ccc' }}
        />
      </div>

      <button
        onClick={registrarPagamento}
        style={{ marginTop:6, width:'100%', padding:10, background:'#28a745', color:'#fff', border:'none', borderRadius:6, cursor:'pointer' }}
      >
        Registrar
      </button>

      {mostrarManual && selecionado && (
        <Manual
          emprestimoId={selecionado.id}
          valorPagamento={limparMoeda(valor)}
          onClose={(dados) => {
            setMostrarManual(false);
            if (dados) {
              notify.success('Pagamento manual registrado!');
              recarregarPagamentosEemprestimos(selecionado.id);
              setSelecionado(null);
              setValor('');
              setTipoPagamento('normal');
              setPaymentDate(new Date().toISOString().slice(0,10));
            }
          }}
        />
      )}
    </div>
  );
}
