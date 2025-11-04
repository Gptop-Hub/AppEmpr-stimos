import React, { useEffect, useState } from 'react';
import axios from 'axios';

export default function EditarEmprestimo({ emprestimoId, onClose }) {
  const [clientes, setClientes] = useState([]);
  const [modalidade, setModalidade] = useState('parcelado');
  const [clienteId, setClienteId] = useState('');
  const [valor, setValor] = useState('');
  const [data, setData] = useState('');
  const [parcelas, setParcelas] = useState(5);
  const [taxaJuros, setTaxaJuros] = useState(10);
  const [observacao, setObservacao] = useState('');
  const [diaPagamento, setDiaPagamento] = useState(15); // <-- novo estado
  const [senha, setSenha] = useState('');
  const senhaCorreta = 'admin123';

  useEffect(() => {
    axios.get('http://localhost:3001/clientes')
      .then(res => setClientes(res.data))
      .catch(console.error);

    axios.get(`http://localhost:3001/emprestimos/${emprestimoId}`)
      .then(res => {
        const e = res.data;
        setClienteId(e.cliente_id);
        setValor(formatarMoeda(e.valor.toFixed(2)));
        setData(e.data.split('T')[0]);
        setModalidade(e.modalidade);
        setTaxaJuros(e.taxa_juros || 0);
        setObservacao(e.observacao || '');
        setParcelas(e.parcelas || 5);
        setDiaPagamento(e.dia_pagamento || 15); // <-- preencher estado inicial
      })
      .catch(console.error);
  }, [emprestimoId]);

  const formatarMoeda = v => {
    const n = v.toString().replace(/\D/g, '');
    const f = (parseInt(n || '0', 10) / 100).toFixed(2);
    return 'R$ ' + f.replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  };

  const desformatarMoeda = v => parseFloat(v.replace(/\D/g, '')) / 100;

  const salvarAlteracoes = () => {
    if (senha !== senhaCorreta) {
      alert('Senha incorreta!');
      return;
    }

    if (!clienteId || !valor || !data || !taxaJuros || (modalidade === 'parcelado' && !parcelas)) {
      alert('Preencha todos os campos!');
      return;
    }

    axios.put(`http://localhost:3001/emprestimos/${emprestimoId}`, {
      cliente_id: clienteId,
      valor: desformatarMoeda(valor),
      data,
      modalidade,
      parcelas: modalidade === 'parcelado' ? parseInt(parcelas, 10) : null,
      taxa_juros: parseFloat(taxaJuros),
      observacao,
      dia_pagamento: parseInt(diaPagamento, 10) || 15 // <-- enviar no PUT
    })
      .then(() => {
        alert(`Empréstimo #${emprestimoId} atualizado!`);
        onClose();
      })
      .catch(() => alert('Erro ao atualizar.'));
  };

  return (
    <div style={{ maxWidth: 400, margin: 'auto', padding: 20, background: '#eee', borderRadius: 8 }}>
      <h2 style={{ textAlign: 'center' }}>✏️ Editar Empréstimo (ID: {emprestimoId})</h2>

      <label>Cliente:</label>
      <select value={clienteId} onChange={e => setClienteId(e.target.value)} style={{ width: '100%', marginBottom: 10 }}>
        <option value="">Selecione um cliente</option>
        {clientes.map(c => (
          <option key={c.id} value={c.id}>{c.nome}</option>
        ))}
      </select>

      <label>Modalidade:</label>
      <select value={modalidade} onChange={e => setModalidade(e.target.value)} style={{ width: '100%', marginBottom: 10 }}>
        <option value="parcelado">Parcelado</option>
        <option value="aberto">Em aberto</option>
      </select>

      <label>Valor:</label>
      <input
        type="text"
        value={valor}
        onChange={e => setValor(formatarMoeda(e.target.value))}
        placeholder="R$ 0,00"
        style={{ width: '100%', marginBottom: 10 }}
      />

      {modalidade === 'parcelado' && (
        <>
          <label>Parcelas:</label>
          <input
            type="number"
            value={parcelas}
            onChange={e => setParcelas(e.target.value)}
            min={1}
            style={{ width: '100%', marginBottom: 10 }}
          />
        </>
      )}

      <label>Taxa de Juros (%):</label>
      <input
        type="number"
        value={taxaJuros}
        onChange={e => setTaxaJuros(e.target.value)}
        step="0.01"
        style={{ width: '100%', marginBottom: 10 }}
      />

      <label>Data:</label>
      <input
        type="date"
        value={data}
        onChange={e => setData(e.target.value)}
        style={{ width: '100%', marginBottom: 10 }}
      />

      <label>Dia do pagamento:</label>
      <input
        type="number"
        value={diaPagamento}
        onChange={e => setDiaPagamento(e.target.value)}
        min={1}
        max={31}
        style={{ width: '100%', marginBottom: 10 }}
      />

      <label>Observação:</label>
      <textarea
        value={observacao}
        onChange={e => setObservacao(e.target.value)}
        rows={3}
        style={{ width: '100%', marginBottom: 10 }}
      />

      <label>Senha de confirmação:</label>
      <input
        type="password"
        value={senha}
        onChange={e => setSenha(e.target.value)}
        style={{ width: '100%', marginBottom: 10 }}
        placeholder="Digite a senha para salvar"
      />

      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <button onClick={onClose} style={{ padding: '8px 16px' }}>Cancelar</button>
        <button onClick={salvarAlteracoes} style={{ padding: '8px 16px' }}>Salvar</button>
      </div>
    </div>
  );
}