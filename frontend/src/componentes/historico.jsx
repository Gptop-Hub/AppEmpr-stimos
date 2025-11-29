import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useLocation, useNavigate } from "react-router-dom";
import ParcelaList from "./Emprestimos/ParcelaList";
import {
  formatarMoeda,
  formatarData,
  calcularTempoPassado,
  isParcelQuitadaMensagem,
  extractQuitAmountFromExplicacao,
} from "./Emprestimos/helpers.jsx";

export default function Historico() {
  const location = useLocation();
  const navigate = useNavigate();

  const [emprestimo, setEmprestimo] = useState(null);
  const [clienteNome, setClienteNome] = useState("");
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");
  const [canceladasAbertas, setCanceladasAbertas] = useState({});

  const emprestimoId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("emprestimoId") || "";
  }, [location.search]);

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

      try {
        const res = await axios.get(`/emprestimos/${emprestimoId}`);
        if (cancelado) return;

        const emp = res.data || null;
        setEmprestimo(emp);
        setClienteNome(emp?.cliente_nome || "");
      } catch (e) {
        if (cancelado) return;

        const msg =
          e.response?.data?.erro ||
          e.response?.data?.error ||
          e.message ||
          "Erro ao carregar histórico.";

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

  useEffect(() => {
    let cancelado = false;

    const precisaCarregarCliente =
      emprestimo &&
      !clienteNome &&
      emprestimo.cliente_id &&
      emprestimo.cliente_id !== "";

    if (!precisaCarregarCliente) return undefined;

    const carregarNome = async () => {
      try {
        const r = await axios.get(`/clientes/${emprestimo.cliente_id}`);
        if (cancelado) return;
        setClienteNome(r.data?.nome || `Cliente #${emprestimo.cliente_id}`);
      } catch {
        if (!cancelado) {
          setClienteNome(`Cliente #${emprestimo.cliente_id}`);
        }
      }
    };

    carregarNome();

    return () => {
      cancelado = true;
    };
  }, [clienteNome, emprestimo]);

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

  const temHistorico = historicos.length > 0;

  const valorEmprestado = useMemo(() => {
    if (!emprestimo) return 0;
    return (
      emprestimo.valor_emprestado ??
      emprestimo.valor_original ??
      emprestimo.valor_inicial ??
      emprestimo.valor
    );
  }, [emprestimo]);

  const capitalRestante = useMemo(() => {
    if (!emprestimo) return 0;
    return emprestimo.capital_restante ?? emprestimo.valor_atual ?? emprestimo.valor;
  }, [emprestimo]);

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

  const displayId = useMemo(() => {
    if (!emprestimo) return "-";
    return (
      emprestimo.codigo_cliente ||
      emprestimo.emprestimo_num ||
      `${emprestimo.cliente_id ?? "?"}-${emprestimo.id ?? "?"}`
    );
  }, [emprestimo]);

  const tempoPassado = useMemo(() => {
    if (!emprestimo) return "-";
    return calcularTempoPassado(emprestimo.data);
  }, [emprestimo]);

  const handleVoltar = () => navigate("/emprestimos");

  if (!emprestimoId) {
    return (
      <div style={{ padding: 20 }}>
        <h2>Histórico de renegociação</h2>
        <p style={{ marginTop: 12, color: "#444" }}>
          Escolha um empréstimo na tela principal e clique em &quot;Ver
          renegociação&quot; para abrir esta página com o histórico detalhado.
        </p>
        <button
          onClick={handleVoltar}
          style={{
            marginTop: 16,
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            background: "#0ea5e9",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Voltar para Empréstimos
        </button>
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 20 }}>Carregando histórico...</div>;
  }

  if (erro) {
    return (
      <div style={{ padding: 20 }}>
        <h2>Histórico de renegociação</h2>
        <p style={{ color: "#b91c1c", marginTop: 12 }}>{erro}</p>
        <button
          onClick={handleVoltar}
          style={{
            marginTop: 16,
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            background: "#0ea5e9",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Voltar para Empréstimos
        </button>
      </div>
    );
  }

  if (!emprestimo) {
    return (
      <div style={{ padding: 20 }}>
        <h2>Histórico de renegociação</h2>
        <p style={{ marginTop: 12 }}>Empréstimo não encontrado.</p>
        <button
          onClick={handleVoltar}
          style={{
            marginTop: 16,
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            background: "#0ea5e9",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Voltar para Empréstimos
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 20,
        maxWidth: 1100,
        margin: "0 auto",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2>Histórico do Empréstimo</h2>
        <button
          onClick={handleVoltar}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            background: "#0ea5e9",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Voltar para Empréstimos
        </button>
      </div>

      {/* Cabeçalho do empréstimo */}
      <div
        style={{
          marginTop: 16,
          padding: 16,
          borderRadius: 10,
          border: "1px solid var(--border-soft)",
          background: "var(--bg-card)",
          color: "var(--text-main)",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
            gap: 12,
          }}
        >
          <div style={{ color: "var(--text-main)" }}>
            <strong style={{ color: "var(--text-muted)" }}>ID:</strong>{" "}
            {displayId}
          </div>

          <div style={{ color: "var(--text-main)" }}>
            <strong style={{ color: "var(--text-muted)" }}>Cliente:</strong>{" "}
            {clienteNome || `Cliente #${emprestimo.cliente_id}`}
          </div>

          <div style={{ color: "var(--text-main)" }}>
            <strong style={{ color: "var(--text-muted)" }}>Modalidade:</strong>{" "}
            {emprestimo.modalidade === "aberto" ? "Em aberto" : "Parcelado"}
          </div>

          <div style={{ color: "var(--text-main)" }}>
            <strong style={{ color: "var(--text-muted)" }}>
              Valor emprestado:
            </strong>{" "}
            {formatarMoeda(valorEmprestado)}
          </div>

          <div style={{ color: "var(--text-main)" }}>
            <strong style={{ color: "var(--text-muted)" }}>Total pago:</strong>{" "}
            {formatarMoeda(emprestimo.total_pago || 0)}
          </div>

          <div style={{ color: "var(--text-main)" }}>
            <strong style={{ color: "var(--text-muted)" }}>
              Capital restante:
            </strong>{" "}
            {formatarMoeda(capitalRestante)}
          </div>

          <div style={{ color: "var(--text-main)" }}>
            <strong style={{ color: "var(--text-muted)" }}>
              Data de início:
            </strong>{" "}
            {formatarData(emprestimo.data)}
          </div>

          <div style={{ color: "var(--text-main)" }}>
            <strong style={{ color: "var(--text-muted)" }}>
              Tempo passado:
            </strong>{" "}
            {tempoPassado}
          </div>
        </div>
      </div>

      {/* Histórico de renegociações */}
      {!temHistorico ? (
        <div
          style={{
            marginTop: 18,
            padding: 16,
            borderRadius: 8,
            border: "1px solid #fbbf24",
            background: "#fef3c7",
            color: "#92400e",
          }}
        >
          Este empréstimo ainda não possui histórico de renegociação registrado.
          Assim que um pagamento manual gerar uma renegociação, os detalhes
          aparecerão aqui.
        </div>
      ) : (
        <div
          style={{
            marginTop: 18,
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {historicos.map((reneg, idx) => {
            const snap = reneg?.snapshot_emprestimo || {};

            const valorSnapshot =
              reneg?.valor_contrato_visual != null
                ? reneg.valor_contrato_visual
                : snap?.valor_emprestado ??
                  snap?.valor_atual ??
                  snap?.valor ??
                  null;

            const capitalVisual =
              reneg?.capital_restante_visual != null
                ? reneg.capital_restante_visual
                : snap?.capital_restante ??
                  snap?.valor_atual ??
                  snap?.valor ??
                  null;

            const dataSnapshot = snap?.data || reneg?.criado_em || null;

            const parcelasDaReneg = Array.isArray(reneg?.parcelas)
              ? reneg.parcelas
              : [];

            const canceladas = parcelasDaReneg.filter((p) =>
              ehParcelaCancelada(p)
            );
            const ativas = parcelasDaReneg.filter(
              (p) => !ehParcelaCancelada(p)
            );

            const toggleId = reneg?.versao ?? idx;
            const toggleAberto = !!canceladasAbertas[toggleId];

            return (
              <section
                key={`reneg-${reneg?.versao ?? reneg?.criado_em ?? Math.random()}`}
                style={{
                  border: "1px solid var(--border-soft)",
                  borderRadius: 8,
                  padding: 16,
                  background: "var(--bg-card)",
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
                  <h3 style={{ margin: 0 }}>
                    Renegociação #{reneg?.versao ?? "-"}
                  </h3>
                  <div style={{ color: "var(--text-muted)" }}>
                    Registrada em:{" "}
                    {dataSnapshot ? formatarData(dataSnapshot) : "-"}
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
                  {valorSnapshot != null && (
                    <div>
                      Capital na época:{" "}
                      <strong>{formatarMoeda(valorSnapshot)}</strong>
                    </div>
                  )}

                  {capitalVisual != null && (
                    <div style={{ color: "var(--text-main)" }}>
                      Capital restante:{" "}
                      <strong style={{ color: "var(--text-muted)" }}>
                        {formatarMoeda(capitalVisual)}
                      </strong>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 14 }}>
                  <ParcelaList parcelas={ativas} showAntigas={true} />
                </div>

                {canceladas.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <button
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

                    {toggleAberto && (
                      <div
                        style={{
                          marginTop: 10,
                          border: "1px dashed #fbbf24",
                          background: "rgba(250, 250, 255, 0.03)",
                          borderRadius: 8,
                          padding: 12,
                        }}
                      >
                        <ParcelaList parcelas={canceladas} showAntigas={true} />
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}