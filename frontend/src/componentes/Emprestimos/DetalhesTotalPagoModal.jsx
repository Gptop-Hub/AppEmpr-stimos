import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { formatarMoeda, formatarData } from './helpers.jsx';

function tipoLabel(tipo) {
  if (!tipo) return 'Normal';
  const map = {
    normal: 'Normal',
    juros: 'Juros',
    manual: 'Manual',
    desconto_proxima: 'Desconto na próxima',
    recalculo_atraso_desconto: 'Desconto no recálculo',
    quitar: 'Quitar',
    manual_juros_parcial: 'Juros parcial',
  };
  return map[tipo] || tipo;
}

export default function DetalhesTotalPagoModal({
  aberto,
  onClose,
  emprestimoId,
  totalPago,
}) {
  const [estado, setEstado] = useState({ carregando: false, erro: null, pagamentos: [] });

  useEffect(() => {
    if (!aberto || !emprestimoId) return;
    let cancelado = false;

    const carregar = async () => {
      setEstado((prev) => ({ ...prev, carregando: true, erro: null }));
      try {
        const resp = await axios.get(`/emprestimos/${emprestimoId}/pagamentos`);
        if (cancelado) return;
        const pagamentos = resp.data?.pagamentos || [];
        setEstado({ carregando: false, erro: null, pagamentos });
      } catch (err) {
        if (cancelado) return;
        const msg =
          err?.response?.data?.error ||
          err?.message ||
          'Erro ao carregar pagamentos.';
        setEstado({ carregando: false, erro: msg, pagamentos: [] });
      }
    };

    carregar();
    return () => {
      cancelado = true;
    };
  }, [aberto, emprestimoId]);

  const somaLocal = useMemo(
    () => (estado.pagamentos || []).reduce((s, p) => s + Number(p.valor || 0), 0),
    [estado.pagamentos]
  );

  if (!aberto) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          color: 'var(--text-main)',
          borderRadius: 10,
          padding: 16,
          minWidth: 340,
          maxWidth: 540,
          maxHeight: '80vh',
          overflow: 'auto',
          border: '1px solid var(--border-soft)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05em' }}>
              Detalhes do total pago (Empréstimo #{emprestimoId})
            </h3>
            <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: '0.9em' }}>
              Total pago exibido no card: <strong>{formatarMoeda(totalPago || 0)}</strong>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: '1.2em',
              cursor: 'pointer',
              color: 'var(--text-main)',
            }}
            aria-label="Fechar"
          >
            ✖️
          </button>
        </div>

        <div style={{ marginTop: 12 }}>
          {estado.carregando ? (
            <p style={{ color: 'var(--text-muted)' }}>Carregando pagamentos...</p>
          ) : estado.erro ? (
            <div style={{ color: '#b91c1c' }}>
              <p style={{ marginBottom: 8 }}>{estado.erro}</p>
              <button
                onClick={() =>
                  setEstado((prev) => ({ ...prev, erro: null })) ||
                  setEstado((prev) => ({ ...prev, carregando: true })) ||
                  null
                }
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  cursor: 'pointer',
                }}
              >
                Tentar novamente
              </button>
            </div>
          ) : estado.pagamentos.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>Nenhum pagamento registrado.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(estado.pagamentos || []).map((pg) => {
                const numeroParcela =
                  typeof pg.numero_parcela === 'number'
                    ? pg.numero_parcela
                    : typeof pg.parcela_origem === 'number'
                      ? pg.parcela_origem + 1
                      : null;
                const isManualMulti = pg?.tipo_pagamento && String(pg.tipo_pagamento).includes('manual');
                const labelParcela = numeroParcela
                  ? `Parcela #${numeroParcela}`
                  : isManualMulti
                    ? 'Várias parcelas'
                    : 'Parcela não informada';
                const descricao = `Pagamento${numeroParcela ? ` da parcela #${numeroParcela}` : ''
                  } — ${formatarMoeda(pg.valor || 0)} — ${formatarData(pg.data)} — tipo: ${tipoLabel(
                    pg.tipo_pagamento
                  )}`;

                return (
                  <div
                    key={pg.id ?? `${pg.data}-${pg.valor}-${pg.parcela_origem}`}
                    style={{
                      padding: 10,
                      border: '1px solid var(--border-soft)',
                      borderRadius: 8,
                      background: 'var(--bg-card)',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{formatarMoeda(pg.valor || 0)}</span>
                      <span style={{ fontSize: '0.9em', color: 'var(--text-muted)' }}>
                        {formatarData(pg.data)}
                      </span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: '0.95em' }}>{descricao}</div>
                    <div style={{ marginTop: 2, fontSize: '0.85em', color: 'var(--text-muted)' }}>
                      {labelParcela} • Tipo: {tipoLabel(pg.tipo_pagamento)}
                      {pg.observacao ? ` • Obs: ${pg.observacao}` : ''}
                    </div>
                  </div>
                );
              })}

              <div
                style={{
                  marginTop: 6,
                  padding: 10,
                  borderTop: '1px solid var(--border-soft)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontWeight: 700,
                }}
              >
                <span>Soma desta lista:</span>
                <span>{formatarMoeda(somaLocal || 0)}</span>
              </div>
              <div style={{ fontSize: '0.85em', color: 'var(--text-muted)' }}>
                A soma acima deve bater com o total pago do card. Diferenças podem indicar pagamentos
                offline ou ajustes.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
