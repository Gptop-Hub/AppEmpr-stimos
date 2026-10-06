// NovoEmprestimo.jsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import notify from '../ui/notify';
import { calcularPreviewParcelas, renderLinhaJuros } from './Emprestimos/helpers.jsx';
import StepperInput from './common/StepperInput.jsx';
import ClienteIdentity from './common/ClienteIdentity.jsx';

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

const normalizeSearchText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const getMatchScore = (query, nomeCliente) => {
  const q = normalizeSearchText(query);
  const nome = normalizeSearchText(nomeCliente);

  if (!q) return 3;
  if (!nome) return -1;
  if (nome.startsWith(q)) return 0;
  if (nome.split(/\s+/).some((parte) => parte.startsWith(q))) return 1;
  return -1;
};

export default function NovoEmprestimo({ clienteId: clienteIdInicial = '', onSalvo, onCancelar }) {
  const navigate = useNavigate();
  const [clientes, setClientes] = useState([]);
  const modalidade = 'parcelado';
  const [clienteId, setClienteId] = useState(clienteIdInicial);
  const [valor, setValor] = useState('');
  const [data, setData] = useState(hojeLocalISO()); // data de inicio do emprestimo
  const [parcelas, setParcelas] = useState('5');
  const [taxaJuros, setTaxaJuros] = useState('10');
  const [observacao, setObservacao] = useState('');
  const [dataPagamento, setDataPagamento] = useState(''); // data de vencimento da 1a parcela (base das proximas)

  const [buscaCliente, setBuscaCliente] = useState('');
  const [buscaClienteId, setBuscaClienteId] = useState('');
  const [mostrarListaClientes, setMostrarListaClientes] = useState(false);

  useEffect(() => {
    axios
      .get('/clientes')
      .then((res) => setClientes(Array.isArray(res.data) ? res.data : []))
      .catch((err) => console.error('Erro ao carregar clientes:', err));
  }, []);

  useEffect(() => {
    setClienteId(clienteIdInicial);
    if (clienteIdInicial) {
      const clienteSelecionado = clientes.find((c) => c.id === clienteIdInicial);
      if (clienteSelecionado) {
        setBuscaCliente(`#${clienteSelecionado.id} - ${clienteSelecionado.nome}`);
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

  const previewParcelas = calcularPreviewParcelas({
    total: desformatarMoeda(valor),
    parcelas,
    taxaPercent: parseFloat(String(taxaJuros || '0').replace(',', '.')),
    primeiroVencimento: dataPagamento,
  });

  const clientesFiltrados = (() => {
    const termoRaw = String(buscaCliente || '').trim();
    const clientesPorId = buscaClienteId
      ? clientes.filter((c) => String(c.id).startsWith(buscaClienteId))
      : clientes;
    if (!termoRaw) return [...clientesPorId].sort((a, b) => Number(a.id) - Number(b.id));

    return clientesPorId
      .map((c) => ({
        cliente: c,
        score: getMatchScore(termoRaw, c.nome),
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.cliente.nome.localeCompare(b.cliente.nome, 'pt-BR');
      })
      .map((item) => item.cliente);
  })();

  const dataPaymentIsValid = () => {
    if (!dataPagamento) return false;
    const d = parseLocalISO(dataPagamento);
    return !!(d && !isNaN(d.getTime()));
  };

  const registrarEmprestimo = async () => {
    const valorNumerico = desformatarMoeda(valor);

    // validacoes especificas (mensagens claras)
    if (!clienteId) {
      notify.warn('Selecione um cliente antes de registrar o empr\u00e9stimo.');
      return;
    }

    if (!valorNumerico || valorNumerico <= 0) {
      notify.warn('Informe um valor v\u00e1lido para o empr\u00e9stimo.');
      return;
    }

    if (modalidade === 'parcelado' && (!dataPagamento || !String(dataPagamento).trim())) {
      notify.warn('Informe a data de vencimento da primeira parcela.');
      return;
    }

    // validacao generica para os demais campos obrigatorios
    if (
      !data ||
      !taxaJuros ||
      (modalidade === 'parcelado' && (!parcelas || Number(parcelas) <= 0))
    ) {
      notify.warn('Preencha todos os campos obrigat\u00f3rios!');
      return;
    }

    // validacao: data de vencimento nao pode ser antes do inicio do emprestimo
    if (dataPaymentIsValid()) {
      const dEmp = parseLocalISO(data);
      const dPay = parseLocalISO(dataPagamento);
      if (dEmp && dPay && dPay.getTime() < dEmp.getTime()) {
        notify.warn('A data de vencimento n\u00e3o pode ser anterior \u00e0 data de in\u00edcio do empr\u00e9stimo.');
        return;
      }
    }

    try {
      const res = await axios.post('/emprestimos', {
        cliente_id: clienteId,
        valor: valorNumerico,
        data, // inicio do emprestimo (informativo)
        modalidade,
        parcelas: modalidade === 'parcelado' ? parseInt(parcelas, 10) : null,
        taxa_juros: parseFloat(String(taxaJuros).replace(',', '.')),
        observacao,
        // importante: mandar a dataPagamento para o backend gerar parcelas com a MESMA regra
        data_pagamento: modalidade === 'parcelado' && dataPagamento ? dataPagamento : null,
      });
      notify.success(`Emprestimo registrado! ID: ${res.data.id}`);
      setClienteId('');
      setBuscaCliente('');
      setValor('');
      setData(hojeLocalISO());
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
    padding: 20,
    maxWidth: 'min(980px, var(--main-max-effective, var(--main-max)))',
    margin: '0 auto',
    fontFamily: 'sans-serif',
    color: 'var(--text-main)',
  };

  const cardStyle = {
    background: 'var(--bg-card)',
    borderRadius: 8,
    border: '1px solid var(--border-soft)',
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
  };

  const sectionStyle = {
    marginBottom: 20,
    paddingBottom: 14,
    borderBottom: '1px solid var(--border-soft)',
  };

  const sectionTitleStyle = {
    marginTop: 0,
    marginBottom: 10,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-main)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  };

  const fieldWrapperStyle = {
    marginTop: 10,
  };

  const fieldStyle = {
    width: '100%',
    padding: 8,
    borderRadius: 4,
    border: '1px solid var(--border-soft)',
    background: 'var(--bg-body)',
    color: 'var(--text-main)',
    boxSizing: 'border-box',
  };

  const labelStyle = {
    display: 'block',
    marginBottom: 4,
    fontSize: 14,
    color: 'var(--text-main)',
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

  const primaryButtonStyle = {
    marginTop: 16,
    width: '100%',
    padding: '10px 14px',
    borderRadius: 6,
    border: 'none',
    background: '#22c55e',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  };

  const backButtonStyle = {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--border-soft)',
    background: 'var(--bg-body)',
    color: 'var(--text-main)',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 13,
  };

  const voltarTelaOrigem = () => {
    if (onCancelar) {
      onCancelar();
      return;
    }
    navigate('/emprestimos');
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={{ marginBottom: 10 }}>
          <button
            type="button"
            onClick={voltarTelaOrigem}
            style={backButtonStyle}
          >
            ← Voltar para Empréstimos
          </button>
        </div>
        <h2 style={{ textAlign: 'center', marginTop: 0, marginBottom: 20 }}>
          {'\u{1F4C4} Novo Empr\u00e9stimo'}
        </h2>

      {/* Cliente */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>{'\u{1F464} Cliente'}</span>
        </div>

        <div style={fieldWrapperStyle}>
          <label style={labelStyle}>Cliente</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              inputMode="numeric"
              placeholder="ID"
              aria-label="Buscar cliente por ID"
              value={buscaClienteId}
              onChange={(e) => {
                const valor = e.target.value.replace(/\D/g, '');
                setBuscaClienteId(valor);
                setClienteId('');
                setMostrarListaClientes(valor.length > 0 || buscaCliente.trim().length > 0);
              }}
              onFocus={() => {
                if (buscaClienteId || buscaCliente.trim()) setMostrarListaClientes(true);
              }}
              onBlur={() => setTimeout(() => setMostrarListaClientes(false), 200)}
              style={{ ...fieldStyle, width: 82, flex: '0 0 82px' }}
            />
            <input
              type="text"
              placeholder="Busque por nome"
              value={buscaCliente}
              onChange={(e) => {
                const valor = e.target.value;
                setBuscaCliente(valor);
                setClienteId('');
                setMostrarListaClientes(valor.trim().length > 0 || buscaClienteId.length > 0);
              }}
              onFocus={() => {
                if (buscaCliente.trim() || buscaClienteId) setMostrarListaClientes(true);
              }}
              onBlur={() => setTimeout(() => setMostrarListaClientes(false), 200)}
              style={{ ...fieldStyle, flex: 1 }}
            />
          </div>

          {clienteId ? (
            <div className="cliente-selection-preview">
              <ClienteIdentity
                cliente={clientes.find((cliente) => Number(cliente.id) === Number(clienteId))}
                clienteId={clienteId}
                avatarSize={40}
                secondary={`ID ${clienteId}`}
              />
            </div>
          ) : null}

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
                      setBuscaCliente(`#${c.id} - ${c.nome}`);
                      setMostrarListaClientes(false);
                    }}
                    style={{
                      padding: '8px 10px',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border-soft)',
                    }}
                  >
                    <ClienteIdentity
                      cliente={c}
                      avatarSize={34}
                      secondary={`ID ${c.id}`}
                    />
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

      {/* Dados principais do emprestimo */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>{'\u{1F4B0} Dados do empr\u00e9stimo'}</span>
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
          <label style={labelStyle}>{'Data de In\u00edcio do Empr\u00e9stimo'}</label>
          <input
            type="date"
            value={data}
            onChange={(e) => setData(e.target.value)}
            style={fieldStyle}
          />
        </div>

        <div style={fieldWrapperStyle}>
          <label style={labelStyle}>{'Observa\u00e7\u00e3o'}</label>
          <input
            type="text"
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="(opcional)"
            style={fieldStyle}
          />
        </div>
      </div>

      {/* Configuracao de parcelas / juros */}
      {modalidade === 'parcelado' && (
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>
            <span>{'\u{1F4D1} Configura\u00e7\u00e3o das parcelas'}</span>
          </div>

          <div style={fieldWrapperStyle}>
            <label style={labelStyle}>Parcelas</label>
            <StepperInput
              value={parcelas}
              onChange={setParcelas}
              min={1}
              inputAriaLabel="Quantidade de parcelas"
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
            {'Essa ser\u00e1 a data da 1\u00aa parcela. As demais seguem m\u00eas a m\u00eas a partir dela.'}
          </div>
          </div>

          <div style={{ marginTop: 18 }}>
          <div style={sectionTitleStyle}>
            <span>{'\u{1F4C6} Pr\u00e9-visualiza\u00e7\u00e3o de parcelas'}</span>
          </div>
            <ul style={{ listStyle: 'none', padding: 0, marginTop: 6 }}>
              {previewParcelas.map((p) => (
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
                    {p.numero}
                    {'\u00aa'} parcela - {formatarMoedaNumero(p.total)}
                  </div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                    {renderLinhaJuros(
                      {
                        valor_capital: p.amortizacao,
                        valor_juros: p.juros,
                        juros_pendentes: 0,
                        juros_adicionais: 0,
                      },
                      formatarMoedaNumero
                    )}
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <strong>Vencimento: {p.vencimento}</strong>
                  </div>
                </li>
              ))}
              {previewParcelas.length === 0 && (
                <li style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Informe valor, parcelas, taxa de juros e data de vencimento para ver a
                  {'simula\u00e7\u00e3o.'}
                </li>
              )}
            </ul>
          </div>
        </div>
      )}

      {/* Botoes */}
      <div style={{ marginTop: 20 }}>
        <button onClick={registrarEmprestimo} style={primaryButtonStyle}>
          {'Registrar empr\u00e9stimo'}
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
              borderRadius: 6,
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
    </div>
  );
}

