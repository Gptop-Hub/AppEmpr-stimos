import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Menu from './componentes/menu';
import DialogHost from './ui/DialogHost.jsx';

const HEALTH_URL = 'http://127.0.0.1:3001/health';

export default function App() {
  const [healthError, setHealthError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const res = await fetch(HEALTH_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!cancelled) setHealthError(null);
      } catch (err) {
        if (!cancelled) setHealthError(err?.message ?? String(err));
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <>
      {/* Host de toasts e modais do sistema */}
      <DialogHost />

      <div>
        <h1>Sistema de Emprestimos</h1>
        <Menu />
        {healthError && (
          <div style={{ background: '#b00020', color: '#ffffff', padding: '8px 12px', margin: '12px 0' }}>
            <strong>Backend offline:</strong> nao foi possivel contactar {HEALTH_URL}. Detalhes: {healthError}
          </div>
        )}
        <Outlet />
      </div>
    </>
  );
}