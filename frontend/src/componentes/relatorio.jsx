import React from 'react';
import { Link } from 'react-router-dom';

export default function Relatorio() {
  return (
    <div style={{ padding: 16, fontFamily: 'Segoe UI, sans-serif' }}>
      <h2 style={{ marginBottom: 8 }}>📈 Relatório — em construção</h2>
      <p style={{ color: '#6b7280', marginBottom: 16 }}>
        Em breve você poderá gerar relatórios de clientes, empréstimos, pagamentos e juros.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Link to="/clientes" style={{ textDecoration: 'none' }}>
          <button style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', cursor: 'pointer' }}>
            Voltar aos clientes
          </button>
        </Link>
        <Link to="/backup" style={{ textDecoration: 'none' }}>
          <button style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', cursor: 'pointer' }}>
            Ir para Backup
          </button>
        </Link>
      </div>

      <ul style={{ fontSize: 14, color: '#374151', lineHeight: 1.6 }}>
        <li>Relatório por período (mensal, semanal)</li>
        <li>Relatório por cliente</li>
        <li>Sumário de juros vs. capital</li>
      </ul>
    </div>
  );
}