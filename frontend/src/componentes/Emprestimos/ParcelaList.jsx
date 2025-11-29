import React, { useState } from "react";
import {
  formatarMoeda,
  formatarData,
  dataParaInput,
  toDateObj,
  renderHighlightedText,
  getExpLineType,
  isParcelFantasma,
  isParcelQuitadaMensagem,
  extractQuitAmountFromExplicacao,
  extractDateFromExplicacao,
  parseObservacoes,
  tipoLabel,
  mascararPagamentosHistorico, // 👈 importante
} from "./helpers.jsx";

const ParcelaList = ({ parcelas = [], showAntigas = false, onAtualizarVencimento }) => {
  const [showMoreInfo, setShowMoreInfo] = useState({});

  const toggleMoreInfo = (parcelaId) => {
    setShowMoreInfo((prev) => ({ ...prev, [parcelaId]: !prev[parcelaId] }));
  };

  const renderExpLinesWithToggle = (explicLines, parcelaId) => {
    if (!explicLines || explicLines.length === 0) return null;
    const vencLines = explicLines.filter((l) => getExpLineType(l) === "venc");
    const otherLines = explicLines.filter((l) => getExpLineType(l) !== "venc");
    const open = !!showMoreInfo[parcelaId];

    return (
      <div
        style={{
          marginTop: 8,
          fontSize: "0.85em",
          color: "var(--text-muted)",
          whiteSpace: "pre-line",
        }}
      >
        {otherLines.map((ln, idx) => (
          (() => {
            const lineText = ln.includes("Pagamento parcial de juros:")
              ? `⏳ ${ln}`
              : ln;
            return (
              <div
                key={`${parcelaId}-other-${idx}`}
                style={{ display: "block", marginTop: idx === 0 ? 0 : 6 }}
              >
                {renderHighlightedText(lineText)}
              </div>
            );
          })()
        ))}

        {vencLines.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleMoreInfo(parcelaId);
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "#007bff",
                cursor: "pointer",
                padding: 0,
                fontSize: "0.95em",
                fontWeight: 600,
              }}
            >
              {open ? "Ocultar informações ▲" : "Mais informações ▼"}
            </button>

            {open && (
              <div style={{ marginTop: 8 }}>
                {vencLines.map((ln, idx) => (
                  <div
                    key={`${parcelaId}-venc-${idx}`}
                    style={{ display: "block", marginTop: idx === 0 ? 0 : 6 }}
                  >
                    {renderHighlightedText(ln)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderObservations = (p, parcelaId) => {
    const obs = parseObservacoes(p);
    if (!obs || obs.length === 0) return null;

    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontWeight: 600 }}>📝 Observações:</div>
        <ul style={{ marginTop: 6, paddingLeft: 14 }}>
          {obs.map((o, i) => (
            <li
              key={`${parcelaId}-obs-${i}`}
              style={{ marginBottom: 6, color: "var(--text-main)" }}
            >
              <div>
                <div>{o.texto}</div>
                <div style={{ marginTop: 4 }}>
                  <small style={{ color: "var(--text-muted)", fontSize: "0.8em" }}>
                    {o.tipo ? tipoLabel(o.tipo) : ""}
                    {o.tipo && o.data ? " · " : ""}
                    {o.data ? formatarData(o.data) : ""}
                  </small>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  if (!Array.isArray(parcelas) || parcelas.length === 0) {
    return <p style={{ color: "var(--text-muted)" }}>Nenhuma parcela registrada.</p>;
  }

  // 🔮 VISÃO BASE:
  // - showAntigas = false  → usamos as parcelas como vieram
  // - showAntigas = true   → aplicamos a MÁSCARA para colar todo valor_pago em 1 parcela
  const baseParcelas = parcelas; // não aplicar mascaramento

  // ➜ showAntigas = false → cronograma atual (parcelas vivas)
  // ➜ showAntigas = true  → histórico de renegociação (parcelas antigas + fantasmas de numero = -1)
  const lista = baseParcelas.filter((p) => {
    if (!p) return false;
    if (showAntigas) {
      // histórico
      return !!p.renegociada || Number(p.numero) === -1;
    }
    // visão atual: apenas parcelas vivas (não renegociadas e numero != -1)
    return !p.renegociada && Number(p.numero) !== -1;
  });

  return (
    <ul style={{ listStyle: "none", paddingLeft: 0 }}>
      {lista.map((p) => {
        const parcelaId = p.parcela_id || p.id;

        const totalExibido = p.valor_com_desconto || p.valor_total;
        const explicLines = String(p.explicacao || "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const lastExpType = explicLines.length
          ? getExpLineType(explicLines[explicLines.length - 1])
          : null;
        const valorPagoMarginTop = lastExpType === "note" ? 16 : 8;

        const quitadaMsg = isParcelQuitadaMensagem(p);
        const quitAmount = quitadaMsg
          ? extractQuitAmountFromExplicacao(p)
          : null;
        const dataQuitacao =
          toDateObj(p.data_pagamento) ||
          extractDateFromExplicacao(p.explicacao);

        // valor pago vindo (já mascarado se showAntigas = true)
        const valorPagoReal = Number(p.valor_pago || 0);

        // valor pago que será exibido
        let totalPago = valorPagoReal;

        // se for parcela da mensagem "empréstimo quitado", prioriza o valor de quitação
        if (quitadaMsg && quitAmount) {
          totalPago = Number(quitAmount);
        }

        // excedente calculado a partir do totalPago exibido
        const excedente = Math.max(0, totalPago - totalExibido);

        // --------- REGRA DE FANTASMA ---------
        let fantasma = false;

        if (showAntigas) {
          const tevePagamento =
            p.pago === 1 ||
            p.pago === true ||
            totalPago > 0;

          if (Number(p.numero) === -1) {
            fantasma = true; // marcador técnico
          } else {
            fantasma = !tevePagamento;
          }
        } else {
          // visão atual: usa helper (caso "quitar empréstimo", etc.)
          fantasma = isParcelFantasma(p);
        }
        // -------------------------------------

        const numeroLabel =
          Number(p.numero) === -1 ? "Parcela fantasma" : `${p.numero}ª parcela`;

        return (
          <li
            key={parcelaId}
            style={{
              marginBottom: 8,
              borderBottom: "1px dashed var(--border-soft)",
              paddingBottom: 6,
              backgroundColor: p.renegociada ? "rgba(255,255,255,0.05)" : "var(--bg-card)",
              opacity: fantasma ? 0.45 : 1,
              color: fantasma ? "var(--text-muted)" : "var(--text-main)",
              fontStyle: fantasma ? "italic" : "normal",
            }}
          >
            <div>
              <strong>
                {numeroLabel}
                {p.renegociada && Number(p.numero) !== -1
                  ? " (Renegociada)"
                  : ""}
                :
              </strong>{" "}
              <span style={{ fontWeight: 600 }}>
                {formatarMoeda(totalExibido)}
              </span>
              {Number(p.juros_adicionais || 0) > 0 && (
                <span
                  style={{
                    fontSize: "0.9em",
                    color: "var(--text-muted)",
                    opacity: 0.6,
                    marginLeft: 8,
                  }}
                >
                  (Original:{" "}
                  {formatarMoeda(
                    Number(p.valor_total || 0) - Number(p.juros_adicionais || 0)
                  )}
                  )
                </span>
              )}
              {showAntigas &&
                p.valor_original &&
                p.valor_original !== totalExibido && (
                  <span
                    style={{
                      fontSize: "0.85em",
                      color: "var(--text-muted)",
                      marginLeft: 8,
                    }}
                  >
                    (Original: {formatarMoeda(p.valor_original)})
                  </span>
                )}
            </div>

            <div style={{ marginTop: 6 }}>
              <small style={{ color: "var(--text-main)" }}>
                Capital: <strong>{formatarMoeda(p.valor_capital)}</strong>{" "}
                {" | "}
                Juros: <strong>{formatarMoeda(p.valor_juros)}</strong>{" "}
                {" | "}
                Juros Adicionais:{" "}
                <strong>{formatarMoeda(p.juros_adicionais || 0)}</strong>{" "}
                <span style={{ opacity: 0.6 }}>(atraso)</span>
              </small>
            </div>

            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <label
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                Vencimento:
                <input
                  type="date"
                  value={dataParaInput(p.vencimento)}
                  onChange={(e) => {
                    e.stopPropagation();
                    onAtualizarVencimento &&
                      onAtualizarVencimento(parcelaId, e.target.value);
                  }}
                  style={{ padding: 6 }}
                />
              </label>
              <div style={{ fontSize: "0.95em", color: "var(--text-main)" }}>
                {formatarData(p.vencimento)}
              </div>
            </div>

            {quitadaMsg && (
              <div
                style={{
                  marginTop: 8,
                  padding: 8,
                  borderRadius: 6,
                  background: "rgba(34,197,94,0.15)",
                  border: "1px solid #bfe6c9",
                  color: "#064d24",
                  fontWeight: 700,
                }}
              >
                Empréstimo quitado
              </div>
            )}

            {/* mensagem de "Empréstimo quitado" em itálico só na parcela fantasma */}
            {fantasma && !quitadaMsg && Number(p.numero) === -1 && (
              <div
                style={{ marginTop: 8, fontStyle: "italic", color: "var(--text-muted)" }}
              >
                Empréstimo quitado
              </div>
            )}

            {!quitadaMsg &&
              !fantasma &&
              renderExpLinesWithToggle(explicLines, parcelaId)}

            <div style={{ marginTop: valorPagoMarginTop }}>
              <div>
                Valor Pago:{" "}
                {totalPago > 0 ? (
                  <strong>{formatarMoeda(totalPago)}</strong>
                ) : (
                  "-"
                )}
              </div>
              {!showAntigas && p.tipo_pagamento && (
                <div
                  style={{
                    fontSize: "0.85em",
                    color: "var(--text-muted)",
                    marginTop: 6,
                  }}
                >
                  Tipo de pagamento:{" "}
                  {p.tipo_pagamento === "desconto_proxima"
                    ? "Desconto na próxima parcela"
                    : p.tipo_pagamento === "normal"
                    ? "Pagamento normal"
                    : p.tipo_pagamento === "abatimento"
                    ? "Abatimento"
                    : p.tipo_pagamento}
                </div>
              )}
              {!showAntigas && excedente > 0 && (
                <div
                  style={{
                    fontSize: "0.85em",
                    color: "var(--text-muted)",
                    marginTop: 6,
                  }}
                >
                  (inclui {formatarMoeda(excedente)} de excedente)
                </div>
              )}
            </div>

            <div style={{ marginTop: 8 }}>
              Data Pagamento:{" "}
              {fantasma
                ? "-"
                : quitadaMsg
                ? dataQuitacao
                  ? formatarData(dataQuitacao)
                  : p.data_pagamento
                  ? formatarData(p.data_pagamento)
                  : "-"
                : formatarData(p.data_pagamento)}
            </div>

            {!fantasma && !quitadaMsg && renderObservations(p, parcelaId)}

            <div style={{ marginTop: 6 }}>
              {p.pago ? (
                <span style={{ color: "green" }}>✅ Pago</span>
              ) : totalPago > 0 ? (
                <span style={{ color: "orange" }}>⚠️ Parcialmente pago</span>
              ) : (
                <span style={{ color: "red" }}>❌ Pendente</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
};

export default ParcelaList;
