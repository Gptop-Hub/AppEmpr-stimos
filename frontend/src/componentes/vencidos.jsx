import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { getTotalDevidoParcela } from './Emprestimos/helpers.jsx';
import ClienteIdentity from './common/ClienteIdentity.jsx';
import useClientesCatalogo from './common/useClientesCatalogo.js';

const Vencidos = () => {
  const { resolverCliente } = useClientesCatalogo();
  const [vencidos, setVencidos] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchVencidos = async () => {
      try {
        const response = await axios.get('/vencidos');
        setVencidos(Array.isArray(response.data) ? response.data : []);
      } catch (err) {
        console.error('Erro ao buscar vencidos:', err);
        setVencidos([]);
      } finally {
        setLoading(false);
      }
    };

    fetchVencidos();
  }, []);

  if (loading) {
    return <p>Carregando emprestimos vencidos...</p>;
  }

  if (vencidos.length === 0) {
    return <p>Nao ha parcelas vencidas no momento.</p>;
  }

  return (
    <div>
      <h1>Emprestimos Vencidos</h1>
      <table border="1" cellPadding="5">
        <thead>
          <tr>
            <th>ID Emprestimo</th>
            <th>Cliente</th>
            <th>Parcela</th>
            <th>Valor Total</th>
            <th>Data de Pagamento</th>
          </tr>
        </thead>
        <tbody>
          {vencidos.map((v) => (
            <tr key={v.parcela_id}>
              <td>{v.emprestimo_id}</td>
              <td>
                <ClienteIdentity
                  cliente={resolverCliente(v.cliente_id, v.cliente_nome)}
                  avatarSize={32}
                  secondary={`ID ${v.cliente_id ?? '-'}`}
                  className="cliente-identity--table"
                />
              </td>
              <td>{v.numero}</td>
              <td>R$ {getTotalDevidoParcela(v).toFixed(2)}</td>
              <td>{v.data_pagamento}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default Vencidos;
