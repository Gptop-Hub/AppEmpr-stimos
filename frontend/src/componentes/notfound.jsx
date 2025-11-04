import React from 'react';
import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div style={{ padding: 16, fontFamily: 'Segoe UI, sans-serif' }}>
      <h2>😕 Página não encontrada</h2>
      <p style={{ color: '#6b7280' }}>
        O caminho que você acessou não existe. Use o menu ou clique abaixo:
      </p>
      <Link to="/clientes" style={{ textDecoration: 'none' }}>
        <button style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', cursor: 'pointer' }}>
          Voltar aos clientes
        </button>
      </Link>
    </div>
  );
}