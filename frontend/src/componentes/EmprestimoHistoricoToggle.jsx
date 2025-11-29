import React, { useEffect, useState } from 'react';
import axios from 'axios';

const BRL = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function EmprestimoHistoricoToggle({ emprestimoId }) {
  const [aberto, setAberto] = useState(false);
  const [versoes, setVersoes] = useState([]);
  const [snapshot, setSnapshot] = useState(null);

  const carregarVersoes = async () => {
    try {
      const r = await axios.get(`/emprestimos/${emprestimoId}/versoes`);
      setVersoes(r.data?.versoes || []);
    } catch (e) {
      console.error(e);
    }
  };

  const carregarVersao = async (versao) => {
    try {
      const r = await axios.get(`/emprestimos/${emprestimoId}/versoes/${versao}`);
      setSnapshot(r.data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (aberto) carregarVersoes();
  }, [aberto]);

  return (
    <div style={{ marginBottom: 10 }}>
      <button
        onClick={() => setAberto(!aberto)}
        className="px-3 py-1 rounded-md border"
      >
        {aberto ? 'Ocultar negociações anteriores ▲' : 'Ver negociação anterior ▼'}
      </button>

      {aberto && versoes.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {versoes.map((v) => (
            <div key={v.versao} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>Versão #{v.versao}</strong>
                <button onClick={() => carregarVersao(v.versao)} className="text-blue-600 underline">
                  Ver detalhes
                </button>
              </div>

              {snapshot && snapshot.emprestimo && (
                <ul style={{ marginTop: 8, paddingLeft: 12 }}>
                  {snapshot.parcelas?.map((p, i) => (
                    <li key={i} style={{ borderBottom: '1px dashed #eee', padding: '4px 0' }}>
                      {p.numero}ª — {BRL(p.valor_total)} (Cap: {BRL(p.valor_capital)} | Jur: {BRL(p.valor_juros)})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}