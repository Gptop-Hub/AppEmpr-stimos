import React from 'react';
import { Link } from 'react-router-dom';
import notify from '../ui/notify';

export default function Notificacoes() {
  return (
    <div style={{ padding: 16, fontFamily: 'Segoe UI, sans-serif' }}>
      <h2 style={{ marginBottom: 8 }}>🔔 Notificações — em construção</h2>
      <p style={{ color: '#6b7280', marginBottom: 16 }}>
        Esta área ainda está em desenvolvimento. Em breve você poderá ver alertas automáticos
        (vencidos, próximos pagamentos, etc.).
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => notify.info('Funcionalidade em construção')}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', cursor: 'pointer' }}
        >
          Testar aviso
        </button>
        <Link to="/clientes" style={{ textDecoration: 'none' }}>
          <button style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', cursor: 'pointer' }}>
            Voltar aos clientes
          </button>
        </Link>
      </div>

      <div style={{ fontSize: 12, color: '#9ca3af' }}>
        Dica: você sempre pode usar o menu superior para navegar para outras seções.
      </div>
    </div>
  );
}