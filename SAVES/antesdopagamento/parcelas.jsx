import React, { useEffect, useState } from 'react';
import axios from 'axios';

export default function Parcelas({ emprestimoId }) {
  const [parcelas, setParcelas] = useState([]);
  const [nova, setNova] = useState({
    numero: '', valor_capital: '', valor_juros: '', vencimento: '', observacao: ''
  });

  useEffect(() => {
    if (emprestimoId) carregarParcelas();
  }, [emprestimoId]);

  const carregarParcelas = () => {
    axios.get(`http://localhost:3001/parcelas/${emprestimoId}`)
      .then(res => setParcelas(res.data))
      .catch(err => console.error(err));
  };

  const formatarMoeda = (v) =>
    Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const registrarParcela = () => {
    const { numero, valor_capital, valor_juros, vencimento } = nova;
    if (!numero || !valor_capital || !valor_juros || !vencimento) {
      alert('Preencha todos os campos!');
      return;
    }

    axios.post('http://localhost:3001/parcelas', {
      emprestimo_id: emprestimoId,
      numero,
      capital: valor_capital,
      juros: valor_juros,
      vencimento,
      observacao: nova.observacao || ''
    }).then(() => {
      setNova({ numero: '', valor_capital: '', valor_juros: '', vencimento: '', observacao: '' });
      carregarParcelas();
    }).catch(err => {
      console.error(err);
      alert('Erro ao registrar parcela');
    });
  };

  const atualizarParcela = (id, campo, valor) => {
    const atualizada = parcelas.find(p => p.id === id);
    if (!atualizada) return;

    const dadosAtualizados = {
      capital: atualizada.valor_capital,
      juros: atualizada.valor_juros,
      vencimento: atualizada.vencimento,
      pago: atualizada.pago,
      observacao: atualizada.observacao,
      valor_pago: atualizada.valor_pago,
      data_pagamento: atualizada.data_pagamento,
      juros_adicionais: atualizada.juros_adicionais,

      ...(campo === 'valor_capital' && { capital: valor }),
      ...(campo === 'valor_juros' && { juros: valor }),
      ...(campo === 'vencimento' && { vencimento: valor }),
      ...(campo === 'pago' && { pago: valor }),
      ...(campo === 'observacao' && { observacao: valor }),
      ...(campo === 'valor_pago' && { valor_pago: valor }),
      ...(campo === 'data_pagamento' && { data_pagamento: valor }),
      ...(campo === 'juros_adicionais' && { juros_adicionais: valor }),
    };

    axios.put(`http://localhost:3001/parcelas/${id}`, dadosAtualizados)
      .then(() => carregarParcelas())
      .catch(err => console.error(err));
  };

  return (
    <div style={{ marginTop: 20 }}>
      <h3>📆 Parcelas do Empréstimo</h3>

      <div style={{ marginBottom: 20, padding: 10, background: '#f1f1f1', borderRadius: 6 }}>
        <h4>➕ Nova Parcela</h4>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            type="number"
            placeholder="Nº"
            value={nova.numero}
            onChange={e => setNova({ ...nova, numero: e.target.value })}
          />
          <input
            type="number"
            placeholder="Capital"
            value={nova.valor_capital}
            onChange={e => setNova({ ...nova, valor_capital: e.target.value })}
          />
          <input
            type="number"
            placeholder="Juros"
            value={nova.valor_juros}
            onChange={e => setNova({ ...nova, valor_juros: e.target.value })}
          />
          <input
            type="date"
            value={nova.vencimento}
            onChange={e => setNova({ ...nova, vencimento: e.target.value })}
          />
          <input
            type="text"
            placeholder="Observação"
            value={nova.observacao}
            onChange={e => setNova({ ...nova, observacao: e.target.value })}
          />
          <button onClick={registrarParcela}>Salvar</button>
        </div>
      </div>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {parcelas.map(parcela => (
          <li key={parcela.id} style={{ marginBottom: 10, background: '#fafafa', padding: 10, borderRadius: 6 }}>
            <div><strong>Parcela {parcela.numero}</strong></div>
            <div>💸 Capital: {formatarMoeda(parcela.valor_capital)}</div>
            <div>📈 Juros: {formatarMoeda(parcela.valor_juros)}</div>
            <div>📅 Vencimento: {new Date(parcela.vencimento).toLocaleDateString()}</div>

            <div>
              ✅ Pago:{' '}
              <input
                type="checkbox"
                checked={!!parcela.pago}
                onChange={e => atualizarParcela(parcela.id, 'pago', e.target.checked ? 1 : 0)}
              />
            </div>

            <div>
              💰 Valor pago:
              <input
                type="number"
                value={parcela.valor_pago || ''}
                placeholder="R$"
                onChange={e => atualizarParcela(parcela.id, 'valor_pago', e.target.value)}
              />
            </div>

            <div>
              📆 Data do pagamento:
              <input
                type="date"
                value={parcela.data_pagamento || ''}
                onChange={e => atualizarParcela(parcela.id, 'data_pagamento', e.target.value)}
              />
            </div>

            <div>
              🔺 Juros adicionais:
              <input
                type="number"
                value={parcela.juros_adicionais || ''}
                placeholder="R$"
                onChange={e => atualizarParcela(parcela.id, 'juros_adicionais', e.target.value)}
              />
            </div>

            <div>
              📝 Observação:
              <input
                type="text"
                value={parcela.observacao}
                onChange={e => atualizarParcela(parcela.id, 'observacao', e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}