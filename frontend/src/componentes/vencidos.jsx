import React, { useEffect, useState } from 'react';
import axios from 'axios';

const Vencidos = () => {
  const [vencidos, setVencidos] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchVencidos = async () => {
      try {
        const response = await axios.get('http://localhost:3000/vencidos'); // ajuste a porta se necessário
        setVencidos(response.data);
      } catch (err) {
        console.error('Erro ao buscar vencidos:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchVencidos();
  }, []);

  if (loading) {
    return <p>Carregando empréstimos vencidos...</p>;
  }

  if (vencidos.length === 0) {
    return <p>Não há parcelas vencidas no momento.</p>;
  }

  return (
    <div>
      <h1>Empréstimos Vencidos</h1>
      <table border="1" cellPadding="5">
        <thead>
          <tr>
            <th>ID Empréstimo</th>
            <th>ID Cliente</th>
            <th>Parcela</th>
            <th>Valor Total</th>
            <th>Data de Pagamento</th>
          </tr>
        </thead>
        <tbody>
          {vencidos.map((v) => (
            <tr key={v.parcela_id}>
              <td>{v.emprestimo_id}</td>
              <td>{v.cliente_id}</td>
              <td>{v.numero}</td>
              <td>R$ {v.valor_total.toFixed(2)}</td>
              <td>{v.data_pagamento}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default Vencidos;