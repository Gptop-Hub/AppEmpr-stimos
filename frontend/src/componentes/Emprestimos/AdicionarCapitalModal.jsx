import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import notify from "../../ui/notify";
import { createPortal } from "react-dom";
import PreviewParcelas from "../manual/PreviewParcelas";
import StepperInput from "../common/StepperInput.jsx";
import {
  addMonthsAdjust,
  calcularPreviewParcelas,
  dataParaInput,
  formatarMoeda,
  toDateObj,
} from "./helpers.jsx";

const inputStyle = {
  width: "100%",
  border: "1px solid var(--border-soft)",
  borderRadius: 6,
  padding: "8px 12px",
  background: "var(--bg-card)",
  color: "var(--text-main)",
  boxSizing: "border-box",
};

const labelMutedStyle = { color: "var(--text-muted)", fontSize: 12 };

const countDigits = (value, endIndex) => {
  const str = String(value || "");
  const limit = Math.min(endIndex ?? str.length, str.length);
  let count = 0;
  for (let i = 0; i < limit; i += 1) {
    if (/\d/.test(str[i])) count += 1;
  }
  return count;
};

const getCaretPosByDigits = (formatted, digitsBefore) => {
  if (digitsBefore <= 0) return 0;
  let count = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (/\d/.test(formatted[i])) {
      count += 1;
      if (count === digitsBefore) return i + 1;
    }
  }
  return formatted.length;
};

const formatCurrencyBRL = (value) => {
  const cleaned = String(value || "").replace(/[^\d.,]/g, "");
  if (!cleaned) return "";
  const lastSepIndex = Math.max(
    cleaned.lastIndexOf("."),
    cleaned.lastIndexOf(",")
  );
  let intPart = cleaned;
  let decPart = "";
  let hasSep = false;

  if (lastSepIndex !== -1) {
    hasSep = true;
    intPart = cleaned.slice(0, lastSepIndex);
    decPart = cleaned.slice(lastSepIndex + 1);
  }

  const intDigits = intPart.replace(/\D/g, "").replace(/^0+(?=\d)/, "") || "0";
  const intFormatted = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decDigits = decPart.replace(/\D/g, "").slice(0, 2);

  if (!hasSep) return `${intFormatted},00`;
  if (!decDigits) return `${intFormatted},00`;
  if (decDigits.length === 1) return `${intFormatted},${decDigits}0`;
  return `${intFormatted},${decDigits}`;
};

const toNumber = (value) => {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const cleaned = String(value).replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};

const getCapitalAtual = (emp) => {
  const raw = emp?.capital_restante ?? emp?.valor_atual ?? emp?.valor ?? 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
};

const getDefaultParcelas = (emp) => {
  const detalhes = Array.isArray(emp?.parcelasDetalhes)
    ? emp.parcelasDetalhes
    : [];
  const abertas = detalhes.filter(
    (p) => !p?.pago && Number(p?.numero) !== -1
  );
  if (abertas.length > 0) return abertas.length;
  const fallback = Number(emp?.parcelas || 0);
  return fallback > 0 ? fallback : 1;
};

const getDefaultVencimento = (emp) => {
  const direct =
    emp?.primeiro_vencimento ??
    emp?.proximo_vencimento ??
    emp?.vencimento ??
    emp?.data_vencimento ??
    emp?.data_pagamento ??
    emp?.primeiroVencimento;
  if (direct) {
    const dt = toDateObj(direct);
    if (dt) return dataParaInput(dt);
  }

  const detalhes = Array.isArray(emp?.parcelasDetalhes)
    ? emp.parcelasDetalhes
    : [];
  const abertas = detalhes
    .filter((p) => !p?.pago && p?.vencimento)
    .map((p) => ({ ...p, _dt: toDateObj(p.vencimento) }))
    .filter((p) => p._dt);
  if (abertas.length > 0) {
    abertas.sort((a, b) => a._dt.getTime() - b._dt.getTime());
    return dataParaInput(abertas[0]._dt);
  }

  const qualquer = detalhes
    .filter((p) => p?.vencimento)
    .map((p) => ({ ...p, _dt: toDateObj(p.vencimento) }))
    .filter((p) => p._dt);
  if (qualquer.length > 0) {
    qualquer.sort((a, b) => a._dt.getTime() - b._dt.getTime());
    return dataParaInput(qualquer[0]._dt);
  }

  const originais = Array.isArray(emp?.parcelasOriginais)
    ? emp.parcelasOriginais
    : [];
  const origComData = originais
    .filter((p) => p?.vencimento)
    .map((p) => ({ ...p, _dt: toDateObj(p.vencimento) }))
    .filter((p) => p._dt);
  if (origComData.length > 0) {
    origComData.sort((a, b) => a._dt.getTime() - b._dt.getTime());
    return dataParaInput(origComData[0]._dt);
  }

  const baseEmp = toDateObj(emp?.data || emp?.created_at || emp?.criado_em);
  if (baseEmp) return dataParaInput(baseEmp);

  const fallback = addMonthsAdjust(new Date(), 1);
  return fallback ? dataParaInput(fallback) : "";
};

export default function AdicionarCapitalModal({
  aberto,
  emprestimo,
  onClose,
  onAplicar,
}) {
  const [valorAdicionar, setValorAdicionar] = useState("");
  const [motivo, setMotivo] = useState("");
  const [parcelas, setParcelas] = useState("");
  const [taxa, setTaxa] = useState("");
  const [vencimento, setVencimento] = useState("");
  const [preview, setPreview] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const valorRef = useRef(null);
  const caretNextRef = useRef(null);

  const capitalAtual = useMemo(() => getCapitalAtual(emprestimo), [emprestimo]);

  const valorAdicionarNum = useMemo(
    () => toNumber(valorAdicionar),
    [valorAdicionar]
  );
  const parcelasNum = useMemo(
    () => parseInt(parcelas || "0", 10) || 0,
    [parcelas]
  );
  const taxaPercent = useMemo(
    () => parseFloat(String(taxa || "0").replace(",", ".")) || 0,
    [taxa]
  );

  const capitalNovo = useMemo(() => {
    const base = capitalAtual + Math.max(valorAdicionarNum, 0);
    return Number(base.toFixed(2));
  }, [capitalAtual, valorAdicionarNum]);

  useEffect(() => {
    if (!aberto) return;
    const rawTaxa = Number(emprestimo?.taxa_juros ?? emprestimo?.taxa);
    const defaultTaxa = Number.isFinite(rawTaxa) ? rawTaxa : 10;
    setValorAdicionar("");
    setMotivo("");
    setParcelas(String(getDefaultParcelas(emprestimo)));
    setTaxa(String(defaultTaxa));
    setVencimento(getDefaultVencimento(emprestimo));
    setPreview([]);
    setIsLoading(false);
  }, [aberto, emprestimo]);

  useEffect(() => {
    if (!aberto) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const id = requestAnimationFrame(() => {
      valorRef.current?.focus?.();
    });
    return () => {
      document.body.style.overflow = prevOverflow;
      cancelAnimationFrame(id);
    };
  }, [aberto]);

  useEffect(() => {
    if (!aberto) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose && onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aberto, onClose]);

  useEffect(() => {
    if (!aberto) return;
    if (!valorAdicionarNum || valorAdicionarNum <= 0) {
      if (preview.length > 0) setPreview([]);
      return;
    }
    if (!parcelasNum || parcelasNum <= 0) {
      if (preview.length > 0) setPreview([]);
      return;
    }
    const lista = calcularPreviewParcelas({
      total: capitalNovo,
      parcelas: parcelasNum,
      taxaPercent,
      primeiroVencimento: vencimento || null,
    });
    setPreview(lista);
  }, [
    aberto,
    valorAdicionarNum,
    parcelasNum,
    taxaPercent,
    vencimento,
    capitalNovo,
    preview.length,
  ]);

  const handleValorAdicionarChange = (e) => {
    const raw = e.target.value;
    const caretPos = e.target.selectionStart ?? raw.length;
    const lastSepIndex = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
    const caretInDecimal = lastSepIndex !== -1 && caretPos > lastSepIndex;
    const digitsBefore = countDigits(raw, caretPos);
    const intDigitsCount = countDigits(
      raw,
      lastSepIndex === -1 ? raw.length : lastSepIndex
    );
    const formatted = formatCurrencyBRL(raw);
    let caretTarget = getCaretPosByDigits(formatted, digitsBefore);
    if (caretInDecimal && digitsBefore <= intDigitsCount) {
      const commaIndex = formatted.indexOf(",");
      if (commaIndex !== -1) caretTarget = commaIndex + 1;
    }
    caretNextRef.current = caretTarget;
    setValorAdicionar(formatted);
  };

  useEffect(() => {
    if (!valorRef.current) return;
    if (caretNextRef.current == null) return;
    const el = valorRef.current;
    const pos = Math.min(caretNextRef.current, el.value.length);
    caretNextRef.current = null;
    requestAnimationFrame(() => {
      try {
        el.setSelectionRange(pos, pos);
      } catch (err) {
        // ignore selection errors on unsupported inputs
      }
    });
  }, [valorAdicionar]);

  const primeiroVencimentoDate = useMemo(
    () => (vencimento ? toDateObj(vencimento) : null),
    [vencimento]
  );
  const primeiroVencimentoValido =
    !!vencimento && !!primeiroVencimentoDate && !isNaN(primeiroVencimentoDate);

  const previewOk = preview.length > 0;
  const isValid =
    valorAdicionarNum > 0 &&
    parcelasNum >= 1 &&
    taxaPercent >= 0 &&
    primeiroVencimentoValido &&
    previewOk;
  const canApply = isValid && !isLoading;

  const handleAplicar = async () => {
    if (!emprestimo?.id) {
      notify.error("Empréstimo inválido.");
      return;
    }
    if (!isValid) {
      notify.warn("Preencha os campos corretamente antes de aplicar.");
      return;
    }

    setIsLoading(true);
    try {
      const payload = {
        valor_adicionar: Number(valorAdicionarNum),
        qtd_parcelas: Number(parcelasNum),
        juros_mes: Number(taxaPercent),
        primeiro_vencimento: vencimento,
        observacao: motivo || "",
      };

      await axios.post(
        `/emprestimos/${emprestimo.id}/adicionar-capital`,
        payload
      );

      notify.success("Capital adicionado com sucesso.");

      if (typeof onAplicar === "function") {
        await onAplicar();
      }

      if (onClose) onClose();
    } catch (err) {
      console.error(err);
      const msg =
        err.response?.data?.erro ||
        err.response?.data?.error ||
        err.message ||
        "Erro ao adicionar capital.";
      notify.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  if (!aberto) return null;

  console.log("[AdicionarCapitalModal] validar aplicar", {
    canApply,
    isValid,
    isLoading,
    valorAdicionar,
    valorAdicionarNum,
    qtdParcelas: parcelasNum,
    jurosMes: taxaPercent,
    primeiroVencimento: vencimento,
    primeiroVencimentoValido,
    previewOk,
    previewLen: preview.length,
  });

  return createPortal(
    <div
      className="modal-overlay"
      onClick={() => onClose && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 10060,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(780px, 96vw)",
          maxHeight: "92vh",
          overflowY: "auto",
          background: "var(--bg-card)",
          color: "var(--text-main)",
          borderRadius: 12,
          border: "1px solid var(--border-soft)",
          boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 700 }}>Adicionar capital</div>
          <button
            type="button"
            onClick={() => onClose && onClose()}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--text-main)",
              fontSize: 18,
              lineHeight: 1,
            }}
            aria-label="Fechar"
          >
            &times;
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelMutedStyle}>Capital restante atual</span>
            <div style={{ fontWeight: 700, padding: "6px 0" }}>
              {formatarMoeda(capitalAtual)}
            </div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelMutedStyle}>Valor a adicionar</span>
            <div className="money-input">
              <span className="money-prefix" aria-hidden="true">
                R$
              </span>
              <input
                ref={valorRef}
                type="text"
                inputMode="decimal"
                pattern="\\d*[.,]?\\d{0,2}"
                value={valorAdicionar}
                onChange={handleValorAdicionarChange}
                style={{ ...inputStyle, paddingLeft: 38 }}
                className="no-spinner"
                required
              />
            </div>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelMutedStyle}>Quantidade de parcelas</span>
            <StepperInput
              value={parcelas}
              onChange={setParcelas}
              min={1}
              inputAriaLabel="Quantidade de parcelas"
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelMutedStyle}>Juros ao mês (%)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={taxa}
              onChange={(e) => setTaxa(e.target.value)}
              style={inputStyle}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelMutedStyle}>Data do 1º vencimento</span>
            <input
              type="date"
              value={vencimento}
              onChange={(e) => setVencimento(e.target.value)}
              style={inputStyle}
            />
          </label>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={labelMutedStyle}>Observação</span>
          <textarea
            rows={2}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="(opcional)"
            style={{
              ...inputStyle,
              resize: "vertical",
              minHeight: 64,
            }}
            required
          />
        </label>

        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
            padding: "14px 16px",
            fontSize: 14,
            color: "var(--text-main)",
            lineHeight: 1.7,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Resumo da simulação
          </div>
          <div>
            Capital restante anterior:{" "}
            <strong>{formatarMoeda(capitalAtual)}</strong>
          </div>
          <div>
            Capital adicionado:{" "}
            <strong>{formatarMoeda(valorAdicionarNum || 0)}</strong>
          </div>
          <div
            style={{
              marginTop: 8,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid rgba(37, 99, 235, 0.45)",
              background:
                "linear-gradient(120deg, rgba(37, 99, 235, 0.2), rgba(59, 130, 246, 0.08))",
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
                lineHeight: 1.2,
              }}
            >
              Total após adicionar
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 20,
                fontWeight: 700,
                color: "var(--text-main)",
                lineHeight: 1.2,
              }}
            >
              {formatarMoeda(capitalNovo)}
            </div>
          </div>
        </div>

        <PreviewParcelas
          previewRenegociacao={preview}
          BRL={formatarMoeda}
          modoJurosParcial={false}
          previewJurosParcial={[]}
        />

        {preview.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Informe o valor e a quantidade de parcelas para visualizar o
            cronograma automaticamente.
          </div>
        )}

        <div
          className="manual-modal-actions"
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 8,
          }}
        >
          <button
            type="button"
            onClick={() => onClose && onClose()}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-soft)",
              background: "var(--bg-card)",
              cursor: "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={handleAplicar}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-soft)",
              background: canApply
                ? "#2563eb"
                : "rgba(148,163,184,0.4)",
              color: canApply ? "#fff" : "var(--text-muted)",
              cursor: canApply ? "pointer" : "not-allowed",
              fontWeight: 600,
            }}
            title={
              canApply
                ? "Aplicar alteração"
                : "Preencha os campos corretamente para habilitar"
            }
          >
            {isLoading ? "Aplicando..." : "Aplicar"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

