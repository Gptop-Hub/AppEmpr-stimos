import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import ParcelaList from "./ParcelaList";
import {
  formatarMoeda,
  formatarData,
  isParcelQuitadaMensagem,
  extractQuitAmountFromExplicacao,
} from "./helpers.jsx";

const obterValorPagoHistorico = (parcela) => {
  if (!parcela) return 0;

  const basePago =
    parcela.valor_pago_visual ??
    parcela.valor_pago ??
    parcela.valor_pago_snapshot ??
    0;

  if (isParcelQuitadaMensagem(parcela)) {
    const quitAmount = extractQuitAmountFromExplicacao(parcela);
    if (quitAmount != null) return Number(quitAmount);
  }

  return Number(basePago);
};

const ehParcelaCancelada = (parcela) => {
  if (!parcela) return false;
  if (Number(parcela.numero) === -1) return true;

  const totalPago = obterValorPagoHistorico(parcela);
  const pagoFlag = parcela.pago === 1 || parcela.pago === true;

  return !(pagoFlag || totalPago > 0);
};

export default function RenegociacaoInlinePanel({ emprestimoId }) {
  const [emprestimo, setEmprestimo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");
  const [canceladasAbertas, setCanceladasAbertas] = useState({});

  useEffect(() => {
    let cancelado = false;

    const carregar = async () => {
      if (!emprestimoId) {
        setEmprestimo(null);
        setErro("");
        return;
      }

      setLoading(true);
      setErro("");
      setCanceladasAbertas({});

      try {
        const res = await axios.get(`/emprestimos/${emprestimoId}`);
        if (cancelado) return;
        setEmprestimo(res.data || null);
      } catch (e) {
        if (cancelado) return;
        const msg =
          e.response?.data?.erro ||
          e.response?.data?.error ||
          e.message ||
          "Erro ao carregar histórico de renegociação.";
        setErro(msg);
        setEmprestimo(null);
      } finally {
        if (!cancelado) setLoading(false);
      }
    };

    carregar();
    return () => {
      cancelado = true;
    };
  }, [emprestimoId]);

  const historicos = useMemo(() => {
    const lista = Array.isArray(emprestimo?.renegociacoesHistorico)
      ? emprestimo.renegociacoesHistorico
      : [];

    return [...lista].sort((a, b) => {
      const va = Number(a?.versao ?? 0);
      const vb = Number(b?.versao ?? 0);
      if (va !== vb) return va - vb;

      const da = a?.criado_em ? new Date(a.criado_em).getTime() : 0;
      const db = b?.criado_em ? new Date(b.criado_em).getTime() : 0;
      return da - db;
    });
  }, [emprestimo]);

  if (!emprestimoId) return null;

  if (loading) {
    return (
      <div
        style={{
          marginTop: 12,
          padding: 12,
          borderRadius: 8,
          border: "1px solid var(--border-soft)",
          background: "var(--bg-card)",
          color: "var(--text-muted)",
        }}
      >
        Carregando histórico de renegociação...
      </div>
    );
  }

  if (erro) {
    return (
      <div
        style={{
          marginTop: 12,
          padding: 12,
          borderRadius: 8,
          border: "1px solid rgba(239,68,68,0.45)",
          color: "#b91c1c",
          background: "rgba(239,68,68,0.08)",
        }}
      >
        {erro}
      </div>
    );
  }

  if (historicos.length === 0) {
    return (
      <div
        style={{
          marginTop: 12,
          padding: 12,
          borderRadius: 8,
          border: "1px solid #fbbf24",
          background: "rgba(254,243,199,0.2)",
          color: "var(--text-main)",
        }}
      >
        Este empréstimo ainda não possui histórico de renegociação registrado.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
      {historicos.map((reneg, idx) => {
        const snap = reneg?.snapshot_emprestimo || {};

        const valorSnapshot =
          reneg?.valor_contrato_visual != null
            ? reneg.valor_contrato_visual
            : snap?.valor_emprestado ?? snap?.valor_atual ?? snap?.valor ?? null;

        const capitalVisual =
          reneg?.capital_restante_visual != null
            ? reneg.capital_restante_visual
            : snap?.capital_restante ?? snap?.valor_atual ?? snap?.valor ?? null;

        const dataSnapshot = snap?.data || reneg?.criado_em || null;

        const parcelasDaReneg = Array.isArray(reneg?.parcelas) ? reneg.parcelas : [];

        const canceladas = parcelasDaReneg.filter((p) => ehParcelaCancelada(p));
        const ativas = parcelasDaReneg.filter((p) => !ehParcelaCancelada(p));

        const toggleId = String(reneg?.versao ?? idx);
        const toggleAberto = !!canceladasAbertas[toggleId];

        return (
          <section
            key={`reneg-inline-${reneg?.id ?? reneg?.versao ?? idx}`}
            style={{
              border: "1px solid var(--border-soft)",
              borderRadius: 8,
              padding: 12,
              background: "var(--bg-card)",
              color: "var(--text-main)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                justifyContent: "space-between",
              }}
            >
              <h4 style={{ margin: 0 }}>Renegociação #{reneg?.versao ?? "-"}</h4>
              <div style={{ color: "var(--text-muted)" }}>
                Registrada em: {dataSnapshot ? formatarData(dataSnapshot) : "-"}
              </div>
            </div>

            <div
              style={{
                marginTop: 10,
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                fontSize: 14,
                color: "var(--text-main)",
              }}
            >
              {valorSnapshot != null ? (
                <div>
                  Capital na época: <strong>{formatarMoeda(valorSnapshot)}</strong>
                </div>
              ) : null}

              {capitalVisual != null ? (
                <div>
                  Capital restante: <strong>{formatarMoeda(capitalVisual)}</strong>
                </div>
              ) : null}
            </div>

            <div style={{ marginTop: 10 }}>
              <ParcelaList parcelas={ativas} showAntigas={true} somenteLeitura={true} />
            </div>

            {canceladas.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() =>
                    setCanceladasAbertas((prev) => ({
                      ...prev,
                      [toggleId]: !prev[toggleId],
                    }))
                  }
                  style={{
                    background: "var(--bg-card)",
                    color: "var(--text-main)",
                    border: "1px solid var(--accent-gold)",
                    padding: "6px 12px",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontWeight: 600,
                    boxShadow: "0 0 0 1px rgba(0,0,0,0.3)",
                  }}
                >
                  {toggleAberto
                    ? "Ocultar parcelas canceladas"
                    : `Parcelas canceladas (${canceladas.length})`}
                </button>

                {toggleAberto ? (
                  <div
                    style={{
                      marginTop: 10,
                      border: "1px dashed #fbbf24",
                      background: "rgba(250, 250, 255, 0.03)",
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <ParcelaList
                      parcelas={canceladas}
                      showAntigas={true}
                      somenteLeitura={true}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
