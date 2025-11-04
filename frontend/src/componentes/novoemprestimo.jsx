// NovoEmprestimo.jsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';

export default function NovoEmprestimo({ clienteId: clienteIdInicial = '', onSalvo, onCancelar }) {
  const [clientes, setClientes] = useState([]);
  const [modalidade, setModalidade] = useState('parcelado');
  const [clienteId, setClienteId] = useState(clienteIdInicial);
  const [valor, setValor] = useState('');
  const [data, setData] = useState(new Date().toISOString().split('T')[0]); // data de início do empréstimo
  const [parcelas, setParcelas] = useState('5');
  const [taxaJuros, setTaxaJuros] = useState('10');
  const [observacao, setObservacao] = useState('');
  const [dataPagamento, setDataPagamento] = useState(''); // data escolhida para o dia do pagamento (date input)

  const [buscaCliente, setBuscaCliente] = useState('');
  const [mostrarListaClientes, setMostrarListaClientes] = useState(false);

  useEffect(() => {
    axios.get('http://localhost:3001/clientes')
      .then(res => setClientes(res.data || []))
      .catch(err => console.error('Erro ao carregar clientes:', err));
  }, []);

  useEffect(() => {
    setClienteId(clienteIdInicial);
    if (clienteIdInicial) {
      const clienteSelecionado = clientes.find(c => c.id === clienteIdInicial);
      if (clienteSelecionado) {
        setBuscaCliente(`#${clienteSelecionado.id} – ${clienteSelecionado.nome}`);
      }
    }
  }, [clienteIdInicial, clientes]);

  const formatarMoeda = v => {
    const n = String(v || '').replace(/\D/g, '');
    const f = (parseInt(n || '0', 10) / 100).toFixed(2);
    return 'R$ ' + f.replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  };
  const desformatarMoeda = v => parseFloat(String(v || '').replace(/\D/g, '')) / 100 || 0;

  const formatarMoedaNumero = num =>
    Number(num || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // ajusta dia para último dia do mês válido
  const ajustarData = (ano, mes, diaEscolhido) => {
    const ultimoDia = new Date(ano, mes + 1, 0).getDate(); // último dia do mês
    const diaFinal = Math.min(diaEscolhido, ultimoDia);
    return new Date(ano, mes, diaFinal);
  };

  /**
   * calcularPreviewParcelas
   * Usa a MESMA regra do backend:
   *  - dataInicio é apenas o ponto de referência (visual)
   *  - dataPagamento define o dia do mês (se não preenchido mostramos placeholder "dd mm aaaa")
   *  - a primeira parcela é a primeira ocorrência desse dia que seja >= dataInicio,
   *    caso contrário é no mês seguinte.
   */
  const calcularPreviewParcelas = () => {
    const total = desformatarMoeda(valor);
    const taxa = parseFloat(taxaJuros || '0') / 100;
    const m = parseInt(parcelas || '0', 10);

    if (!m || m <= 0 || total <= 0) return [];

    let saldo = total;
    const preview = [];

    // resolve diaPagamentoNum (se vazio, definimos null para indicar placeholder)
    let diaPagamentoNum = null;
    if (dataPagamento) {
      const ddp = new Date(dataPagamento);
      if (!isNaN(ddp.getTime())) diaPagamentoNum = ddp.getDate();
    }
    // se dataPagamento vazia => diaPagamentoNum permanece null (mostra placeholder nas datas)

    const baseDate = new Date(data); // data de início do empréstimo
    if (isNaN(baseDate.getTime())) return [];

    // calcula firstMonthOffset apenas se tivermos dia (caso contrário não faz diferença visual)
    let firstMonthOffset = 0;
    if (diaPagamentoNum !== null) {
      const candidata = new Date(baseDate.getFullYear(), baseDate.getMonth(), diaPagamentoNum);
      firstMonthOffset = (candidata.getTime() >= baseDate.getTime()) ? 0 : 1;
    }

    for (let i = 1; i <= m; i++) {
      const amort = m > 0 ? total / m : 0;
      const jurosVal = saldo * taxa;
      const valorParc = amort + jurosVal;

      let vencFormatado;
      if (diaPagamentoNum === null) {
        // se não tiver data de pagamento definida, mostramos placeholder
        vencFormatado = 'dd mm aaaa';
      } else {
        // vencimento: mês = baseMonth + firstMonthOffset + (i-1)
        const targetMonthIndex = baseDate.getMonth() + firstMonthOffset + (i - 1);
        const targetYear = baseDate.getFullYear() + Math.floor(targetMonthIndex / 12);
        const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
        const ajustada = ajustarData(targetYear, targetMonth, diaPagamentoNum);
        vencFormatado = `${('0' + ajustada.getDate()).slice(-2)}/${('0' + (ajustada.getMonth() + 1)).slice(-2)}/${ajustada.getFullYear()}`;
      }

      preview.push({
        numero: i,
        amortizacao: isNaN(amort) ? 0 : amort,
        juros: isNaN(jurosVal) ? 0 : jurosVal,
        total: isNaN(valorParc) ? 0 : valorParc,
        vencimento: vencFormatado
      });

      saldo -= amort;
    }
    return preview;
  };

  const clientesFiltrados = clientes
    .filter(c => {
      const termo = buscaCliente.trim().toLowerCase();
      if (!termo) return true;

      const numBusca = Number(termo.replace(/\D/g, ''));
      if (!isNaN(numBusca) && termo === numBusca.toString()) {
        return c.id.toString().startsWith(numBusca.toString());
      }

      return c.nome.toLowerCase().includes(termo);
    })
    .sort((a, b) => {
      const termo = buscaCliente.trim().toLowerCase();
      const numBusca = Number(termo.replace(/\D/g, ''));
      if (!isNaN(numBusca) && termo === numBusca.toString()) {
        return a.id - b.id;
      }
      return a.nome.localeCompare(b.nome);
    });

  const dataPaymentIsValid = () => {
    if (!dataPagamento) return false;
    const d = new Date(dataPagamento);
    return !isNaN(d.getTime());
  };

  const registrarEmprestimo = async () => {
    // agora dataPagamento NÃO é obrigatória; apenas valida parcelas quando parcelado
    if (!clienteId || !valor || !data || !taxaJuros || (modalidade === 'parcelado' && (!parcelas || Number(parcelas) <= 0))) {
      notify.warn('Preencha todos os campos obrigatorios!');
      return;
    }

    try {
      const res = await axios.post('http://localhost:3001/emprestimos', {
        cliente_id: clienteId,
        valor: desformatarMoeda(valor),
        data,
        modalidade,
        parcelas: modalidade === 'parcelado' ? parseInt(parcelas, 10) : null,
        taxa_juros: parseFloat(taxaJuros),
        observacao,
        data_pagamento: modalidade === 'parcelado' && dataPagamento ? dataPagamento : null,
      });
      notify.success(`Emprestimo registrado! ID: ${res.data.id}`);
      setModalidade('parcelado');
      setClienteId('');
      setBuscaCliente('');
      setValor('');
      setData(new Date().toISOString().split('T')[0]);
      setParcelas('5');
      setTaxaJuros('10');
      setObservacao('');
      setDataPagamento('');
      setMostrarListaClientes(false);
      if (onSalvo) onSalvo();
    } catch (err) {
      console.error(err);
      const msg = err.response?.data?.erro || err.response?.data?.error || err.message || 'Erro ao registrar.';
      notify.error(msg);
    }
  };

  return (
    <div style={{ maxWidth: 400, margin: 'auto', padding: 20 }}>
      <h2 style={{ textAlign: 'center' }}>📄 Novo Empréstimo</h2>

      <label>Modalidade:</label>
      <div>
        <label>
          <input
            type="radio"
            checked={modalidade === 'parcelado'}
            onChange={() => setModalidade('parcelado')}
          /> Parcelado
        </label>
        <label style={{ marginLeft: 10 }}>
          <input
            type="radio"
            checked={modalidade === 'aberto'}
            onChange={() => setModalidade('aberto')}
          /> Em aberto
        </label>
      </div>

      <label style={{ display: 'block', marginTop: 10 }}>Cliente</label>
      <input
        type="text"
        placeholder="Busque por nome ou ID"
        value={buscaCliente}
        onChange={e => {
          const valor = e.target.value;
          setBuscaCliente(valor);
          setClienteId('');
          setMostrarListaClientes(valor.trim().length > 0);
        }}
        onFocus={() => {
          if (buscaCliente.trim().length > 0) setMostrarListaClientes(true);
        }}
        onBlur={() => setTimeout(() => setMostrarListaClientes(false), 200)}
        style={{ width: '100%', padding: 8 }}
      />

      {mostrarListaClientes && (
        <ul
          style={{
            maxHeight: 150,
            overflowY: 'auto',
            border: '1px solid #ccc',
            borderRadius: 4,
            marginTop: 0,
            paddingLeft: 0,
            listStyle: 'none',
            position: 'absolute',
            backgroundColor: 'white',
            width: 'calc(100% - 40px)',
            zIndex: 1000,
          }}
        >
          {clientesFiltrados.length > 0 ? (
            clientesFiltrados.map(c => (
              <li
                key={c.id}
                onMouseDown={() => {
                  setClienteId(c.id);
                  setBuscaCliente(`#${c.id} – ${c.nome}`);
                  setMostrarListaClientes(false);
                }}
                style={{
                  padding: '8px 10px',
                  cursor: 'pointer',
                  borderBottom: '1px solid #eee'
                }}
              >
                #{c.id} – {c.nome}
              </li>
            ))
          ) : (
            <li style={{ padding: 8, color: 'gray' }}>Nenhum cliente encontrado</li>
          )}
        </ul>
      )}

      <label style={{ display: 'block', marginTop: 10 }}>Valor (R$)</label>
      <input
        type="text"
        value={formatarMoeda(valor)}
        onChange={e => setValor(e.target.value)}
        style={{ width: '100%', padding: 8 }}
      />

      <label style={{ display: 'block', marginTop: 10 }}>Data de Início do Empréstimo</label>
      <input
        type="date"
        value={data}
        onChange={e => setData(e.target.value)}
        style={{ width: '100%', padding: 8 }}
      />

      <label style={{ display: 'block', marginTop: 10 }}>Observação</label>
      <input
        type="text"
        value={observacao}
        onChange={e => setObservacao(e.target.value)}
        placeholder="(opcional)"
        style={{ width: '100%', padding: 8 }}
      />

      {modalidade === 'parcelado' && (
        <>
          <label style={{ display: 'block', marginTop: 10 }}>Parcelas</label>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d*"
            value={parcelas}
            onChange={e => {
              const raw = e.target.value.replace(/\D/g, '');
              const normalized = raw === '' ? '' : String(Number(raw));
              setParcelas(normalized);
            }}
            onBlur={() => {
              if (parcelas === '' || Number(parcelas) < 1) setParcelas('1');
            }}
            style={{ width: '100%', padding: 8 }}
          />

          <label style={{ display: 'block', marginTop: 10 }}>Taxa de Juros (%)</label>
          <input
            type="text"
            inputMode="decimal"
            value={taxaJuros}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9.,]/g, '');
              setTaxaJuros(raw);
            }}
            style={{ width: '100%', padding: 8 }}
          />

          <label style={{ display: 'block', marginTop: 10 }}>Data de início de pagamento</label>
          <input
            type="date"
            value={dataPagamento}
            onChange={e => setDataPagamento(e.target.value)}
            style={{ width: '100%', padding: 8 }}
          />

          <div style={{ marginTop: 20 }}>
            <h4>Pré-visualização de Parcelas</h4>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {calcularPreviewParcelas().map(p => (
                <li key={p.numero} style={{ padding: 6 }}>
                  {p.numero}ª: {formatarMoedaNumero(p.total)}<br />
                  (Capital: {formatarMoedaNumero(p.amortizacao)}, Juros: {formatarMoedaNumero(p.juros)})<br />
                  <strong>Vencimento: {p.vencimento}</strong>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {modalidade === 'aberto' && (
        <>
          <label style={{ display: 'block', marginTop: 10 }}>Taxa de Juros (%)</label>
          <input
            type="text"
            inputMode="decimal"
            value={taxaJuros}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9.,]/g, '');
              setTaxaJuros(raw);
            }}
            style={{ width: '100%', padding: 8 }}
          />
          <p style={{ marginTop: 10, color: 'gray' }}>
            Após salvar, utilize a aba de pagamentos para registrar valores livres.
          </p>
        </>
      )}

      <button
        onClick={registrarEmprestimo}
        style={{ marginTop: 20, width: '100%', padding: 10 }}
      >
        Registrar
      </button>

      {onCancelar && (
        <button
          onClick={onCancelar}
          style={{
            marginTop: 10,
            width: '100%',
            padding: 10,
            backgroundColor: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer'
          }}
        >
          Cancelar
        </button>
      )}
    </div>
  );
}
