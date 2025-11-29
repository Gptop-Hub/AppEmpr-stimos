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
  const [dataPagamento, setDataPagamento] = useState(''); // data de vencimento da 1ª parcela (base das próximas)

  const [buscaCliente, setBuscaCliente] = useState('');
  const [mostrarListaClientes, setMostrarListaClientes] = useState(false);

  useEffect(() => {
    axios
      .get('http://localhost:3001/clientes')
      .then((res) => setClientes(res.data || []))
      .catch((err) => console.error('Erro ao carregar clientes:', err));
  }, []);

  useEffect(() => {
    setClienteId(clienteIdInicial);
    if (clienteIdInicial) {
      const clienteSelecionado = clientes.find((c) => c.id === clienteIdInicial);
      if (clienteSelecionado) {
        setBuscaCliente(`#${clienteSelecionado.id} – ${clienteSelecionado.nome}`);
      }
    }
  }, [clienteIdInicial, clientes]);

  const formatarMoeda = (v) => {
    const n = String(v || '').replace(/\D/g, '');
    const f = (parseInt(n || '0', 10) / 100).toFixed(2);
    return 'R$ ' + f.replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  };
  const desformatarMoeda = (v) => parseFloat(String(v || '').replace(/\D/g, '')) / 100 || 0;

  const formatarMoedaNumero = (num) =>
    Number(num || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // --- helpers de data -------------------------------------------------------

  // ajusta dia para último dia do mês válido
  const ajustarData = (ano, mes, diaEscolhido) => {
    const ultimoDia = new Date(ano, mes + 1, 0).getDate();
    const diaFinal = Math.min(diaEscolhido, ultimoDia);
    return new Date(ano, mes, diaFinal);
  };

  // soma meses mantendo o dia; se não existir, usa último dia do mês
  function addMonthsAdjust(date, months) {
    const d = new Date(date.getTime());
    const targetMonth = d.getMonth() + months;
    const y = d.getFullYear() + Math.floor(targetMonth / 12);
    const m = ((targetMonth % 12) + 12) % 12;
    const day = d.getDate();
    const lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(day, lastDay));
  }

  /**
   * calcularPreviewParcelas
   * Regra:
   *  - Se `dataPagamento` for válida: 1º vencimento = essa data (dia/mês/ano).
   *    As seguintes = +1 mês sucessivamente (ajustando dia quando necessário).
   *  - Se `dataPagamento` estiver vazia: mostra placeholder "dd mm aaaa".
   *  - `data` (início do empréstimo) é apenas informativa aqui.
   */
  const calcularPreviewParcelas = () => {
    const total = desformatarMoeda(valor);
    const taxa = parseFloat(String(taxaJuros || '0').replace(',', '.')) / 100;
    const m = parseInt(parcelas || '0', 10);

    if (!m || m <= 0 || total <= 0) return [];

    let saldo = total;
    const preview = [];

    // 1º vencimento (quando informado)
    let firstDue = null;
    if (dataPagamento) {
      const dp = new Date(dataPagamento);
      if (!isNaN(dp.getTime())) firstDue = dp;
    }

    for (let i = 1; i <= m; i++) {
      const amort = m > 0 ? total / m : 0;
      const jurosVal = saldo * taxa;
      const valorParc = amort + jurosVal;

      let vencFormatado;
      if (!firstDue) {
        vencFormatado = 'dd mm aaaa';
      } else {
        const venc = i === 1 ? firstDue : addMonthsAdjust(firstDue, i - 1);
        vencFormatado = `${('0' + venc.getDate()).slice(-2)}/${('0' + (venc.getMonth() + 1)).slice(
          -2
        )}/${venc.getFullYear()}`;
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
  };

  const clientesFiltrados = clientes
    .filter((c) => {
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
    const valorNumerico = desformatarMoeda(valor);

    // validações específicas (mensagens claras)
    if (!clienteId) {
      notify.warn('Selecione um cliente antes de registrar o empréstimo.');
      return;
    }

    if (!valorNumerico || valorNumerico <= 0) {
      notify.warn('Informe um valor válido para o empréstimo.');
      return;
    }

    if (modalidade === 'parcelado' && (!dataPagamento || !String(dataPagamento).trim())) {
      notify.warn('Informe a data de vencimento da primeira parcela.');
      return;
    }

    // validação genérica para os demais campos obrigatórios
    if (
      !data ||
      !taxaJuros ||
      (modalidade === 'parcelado' && (!parcelas || Number(parcelas) <= 0))
    ) {
      notify.warn('Preencha todos os campos obrigatórios!');
      return;
    }

    // validação: data de vencimento não pode ser antes do início do empréstimo
    if (dataPaymentIsValid()) {
      const dEmp = new Date(data);
      const dPay = new Date(dataPagamento);
      if (dPay.getTime() < dEmp.getTime()) {
        notify.warn('A data de vencimento não pode ser anterior à data de início do empréstimo.');
        return;
      }
    }

    try {
      const res = await axios.post('http://localhost:3001/emprestimos', {
        cliente_id: clienteId,
        valor: valorNumerico,
        data, // início do empréstimo (informativo)
        modalidade,
        parcelas: modalidade === 'parcelado' ? parseInt(parcelas, 10) : null,
        taxa_juros: parseFloat(String(taxaJuros).replace(',', '.')),
        observacao,
        // importante: mandar a dataPagamento para o backend gerar parcelas com a MESMA regra
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
      const msg =
        err.response?.data?.erro ||
        err.response?.data?.error ||
        err.message ||
        'Erro ao registrar.';
      notify.error(msg);
    }
  };

  // ---------- ESTILOS VISUAIS (apenas layout/visual) -------------------------

  const containerStyle = {
    maxWidth: 560,
    margin: '0 auto',
    padding: 24,
    background: 'var(--bg-card)',
    color: 'var(--text-main)',
    border: '1px solid var(--border-soft)',
    borderRadius: 12,
    boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
  };

  const sectionStyle = {
    marginTop: 18,
  };

  const sectionTitleStyle = {
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 8,
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  };

  const fieldWrapperStyle = {
    marginTop: 10,
  };

  const fieldStyle = {
    width: '100%',
    padding: '9px 11px',
    borderRadius: 8,
    border: '1px solid var(--border-soft)',
    background: 'var(--bg-card)',
    color: 'var(--text-main)',
    fontSize: 14,
  };

  const labelStyle = {
    display: 'block',
    marginBottom: 4,
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-muted)',
  };

  const smallHelpText = {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 4,
  };

  const radioLabelStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginRight: 16,
    fontSize: 13,
    color: 'var(--text-main)',
  };

  return (
    <div style={containerStyle}>
      {/* Cabeçalho */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-main)' }}>
          📄 Novo Empréstimo
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          Preencha os dados do cliente, configure o valor e as parcelas antes de registrar.
        </div>
      </div>

      {/* Modalidade + Cliente */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>👤 Cliente & Modalidade</span>
        </div>

        <div style={fieldWrapperStyle}>
          <span style={labelStyle}>Modalidade</span>
          <div>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                checked={modalidade === 'parcelado'}
                onChange={() => setModalidade('parcelado')}
              />
              Parcelado
            </label>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                checked={modalidade === 'aberto'}
                onChange={() => setModalidade('aberto')}
              />
              Em aberto
            </label>
          </div>
        </div>

        <div style={fieldWrapperStyle}>
          <label style={labelStyle}>Cliente</label>
          <input
            type="text"
            placeholder="Busque por nome ou ID"
            value={buscaCliente}
            onChange={(e) => {
              const valor = e.target.value;
              setBuscaCliente(valor);
              setClienteId('');
              setMostrarListaClientes(valor.trim().length > 0);
            }}
            onFocus={() => {
              if (buscaCliente.trim().length > 0) setMostrarListaClientes(true);
            }}
            onBlur={() => setTimeout(() => setMostrarListaClientes(false), 200)}
            style={fieldStyle}
          />

          {mostrarListaClientes && (
            <ul
              style={{
                maxHeight: 170,
                overflowY: 'auto',
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                marginTop: 4,
                paddingLeft: 0,
                listStyle: 'none',
                position: 'absolute',
                backgroundColor: 'var(--bg-card)',
                width: 'calc(100% - 48px)',
                color: 'var(--text-main)',
                zIndex: 1000,
              }}
            >
              {clientesFiltrados.length > 0 ? (
                clientesFiltrados.map((c) => (
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
                      borderBottom: '1px solid var(--border-soft)',
                    }}
                  >
                    #{c.id} – {c.nome}
                  </li>
                ))
              ) : (
                <li style={{ padding: 8, color: 'var(--text-muted)' }}>
                  Nenhum cliente encontrado
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {/* Dados principais do empréstimo */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>💰 Dados do empréstimo</span>
        </div>

        <div style={fieldWrapperStyle}>
          <label style={labelStyle}>Valor (R$)</label>
          <input
            type="text"
            value={formatarMoeda(valor)}
            onChange={(e) => setValor(e.target.value)}
            style={fieldStyle}
          />
        </div>

        <div style={fieldWrapperStyle}>
          <label style={labelStyle}>Data de Início do Empréstimo</label>
          <input
            type="date"
            value={data}
            onChange={(e) => setData(e.target.value)}
            style={fieldStyle}
          />
        </div>

        <div style={fieldWrapperStyle}>
          <label style={labelStyle}>Observação</label>
          <input
            type="text"
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="(opcional)"
            style={fieldStyle}
          />
        </div>
      </div>

      {/* Configuração de parcelas / juros */}
      {modalidade === 'parcelado' && (
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>
            <span>📑 Configuração das parcelas</span>
          </div>

          <div style={fieldWrapperStyle}>
            <label style={labelStyle}>Parcelas</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d*"
              value={parcelas}
              onChange={(e) => {
                const raw = e.target.value.replace(/\D/g, '');
                const normalized = raw === '' ? '' : String(Number(raw));
                setParcelas(normalized);
              }}
              onBlur={() => {
                if (parcelas === '' || Number(parcelas) < 1) setParcelas('1');
              }}
              style={fieldStyle}
            />
          </div>

          <div style={fieldWrapperStyle}>
            <label style={labelStyle}>Taxa de Juros (%)</label>
            <input
              type="text"
              inputMode="decimal"
              value={taxaJuros}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.,]/g, '');
                setTaxaJuros(raw);
              }}
              style={fieldStyle}
            />
          </div>

          <div style={fieldWrapperStyle}>
            <label style={labelStyle}>Data de vencimento</label>
            <input
              type="date"
              value={dataPagamento}
              onChange={(e) => setDataPagamento(e.target.value)}
              style={fieldStyle}
            />
            <div style={smallHelpText}>
              Essa será a data da 1ª parcela. As demais seguem mês a mês a partir dela.
            </div>
          </div>

          <div style={{ marginTop: 18 }}>
            <div style={sectionTitleStyle}>
              <span>📆 Pré-visualização de parcelas</span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, marginTop: 6 }}>
              {calcularPreviewParcelas().map((p) => (
                <li
                  key={p.numero}
                  style={{
                    padding: '8px 10px',
                    color: 'var(--text-main)',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 8,
                    marginBottom: 6,
                    background: 'var(--bg-card)',
                    fontSize: 13,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {p.numero}ª parcela – {formatarMoedaNumero(p.total)}
                  </div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                    Capital: {formatarMoedaNumero(p.amortizacao)} · Juros:{' '}
                    {formatarMoedaNumero(p.juros)}
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <strong>Vencimento: {p.vencimento}</strong>
                  </div>
                </li>
              ))}
              {calcularPreviewParcelas().length === 0 && (
                <li style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Informe valor, parcelas, taxa de juros e data de vencimento para ver a
                  simulação.
                </li>
              )}
            </ul>
          </div>
        </div>
      )}

      {modalidade === 'aberto' && (
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>
            <span>📑 Juros para empréstimo em aberto</span>
          </div>

          <div style={fieldWrapperStyle}>
            <label style={labelStyle}>Taxa de Juros (%)</label>
            <input
              type="text"
              inputMode="decimal"
              value={taxaJuros}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.,]/g, '');
                setTaxaJuros(raw);
              }}
              style={fieldStyle}
            />
            <p style={smallHelpText}>
              Após salvar, utilize a aba de pagamentos para registrar valores livres.
            </p>
          </div>
        </div>
      )}

      {/* Botões */}
      <div style={{ marginTop: 24 }}>
        <button
          onClick={registrarEmprestimo}
          style={{
            width: '100%',
            padding: 11,
            background: '#22c55e',
            color: '#fff',
            border: 'none',
            borderRadius: 999,
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          Registrar empréstimo
        </button>

        {onCancelar && (
          <button
            onClick={onCancelar}
            style={{
              marginTop: 10,
              width: '100%',
              padding: 10,
              backgroundColor: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: 999,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}