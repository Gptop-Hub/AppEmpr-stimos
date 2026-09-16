import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import axios from 'axios';
import notify from "../../ui/notify";
import { autorizarProtecao } from '../../security/seguranca.js';
import ClienteIdentity from "../common/ClienteIdentity.jsx";
import useClientesCatalogo from "../common/useClientesCatalogo.js";

const parseValor = (raw) => {
  const txt = String(raw || "")
    .replace(/^R\$\s?/i, "")
    .trim();
  if (!txt) return 0;
  const hasComma = txt.includes(",");
  const hasDot = txt.includes(".");
  let normalized = txt;
  if (hasComma && hasDot) {
    normalized = txt.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = txt.replace(",", ".");
  }
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
};

const formatCurrencyInput = (raw) => {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "R$ 0,00";
  const cents = parseInt(digits, 10);
  if (!Number.isFinite(cents)) return "";
  const formatted = (cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `R$ ${formatted}`;
};

export default function JurosAdicionaisModal({
  aberto,
  parcela,
  onClose,
  onSalvar,
}) {
  const { resolverCliente } = useClientesCatalogo();
  const [valor, setValor] = useState("");
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);
  const valorRef = useRef(null);

  useEffect(() => {
    if (aberto) {
      setValor("R$ 0,00");
      setMotivo("");
    }
  }, [aberto, parcela]);

  useEffect(() => {
    if (!aberto) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (valorRef.current) {
      valorRef.current.focus();
    }
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [aberto]);

  const labelParcela = useMemo(() => {
    const numero = parcela?.numero ?? parcela?.parcela_numero;
    return numero != null ? `${numero}ª parcela` : "Parcela";
  }, [parcela]);
  const clienteLabel = useMemo(() => {
    const nome = parcela?.cliente_nome || parcela?.nome_cliente || "";
    const id = parcela?.cliente_id ?? parcela?.id_cliente;
    if (!nome && (id == null || id === "")) return "";
    if (nome && id != null && id !== "") return `${id} - ${nome}`;
    return nome || String(id);
  }, [parcela]);

  if (!aberto) return null;

  const handleSalvar = async () => {
    if (salvando) return;
    if (!motivo || !String(motivo).trim()) {
      notify.warn("Informe o motivo dos juros adicionais.");
      return;
    }
    const parsed = parseValor(valor);
    if (parsed == null) {
      notify.warn("Valor inválido.");
      return;
    }
    if (parsed <= 0) {
      notify.warn("O valor não pode ser igual a 0.");
      return;
    }
    const parcelaId = Number(parcela?.id || parcela?.parcela_id || 0);
    if (!parcelaId) {
      notify.error("Parcela inválida para aplicar juros adicionais.");
      return;
    }
    console.log("[juros-adicionais] submit parcelaId:", parcelaId);
    setSalvando(true);
    try {
      const autorizacao = await autorizarProtecao('adicionar_juros_parcela', { parcelaId });
      if (!autorizacao) return;
      const resp = await axios.post(`/parcelas/${parcelaId}/juros-adicionais`, {
        valor: parsed,
        motivo: String(motivo).trim(),
        data: new Date().toISOString().slice(0, 10),
      }, autorizacao);
      const data = resp.data;
      if (onSalvar) onSalvar(data?.parcela);
      notify.success("Juros adicionais salvos.");
      onClose();
    } catch (e) {
      notify.error(
        `Falha ao salvar juros adicionais: ${e?.response?.data?.erro || e?.response?.data?.error || e?.message || "erro"}`
      );
    } finally {
      setSalvando(false);
    }
  };

  return createPortal(
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 9998,
      }}
    >
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 9999,
          width: "100%",
          maxWidth: 420,
          background: "var(--bg-card)",
          color: "var(--text-main)",
          borderRadius: 10,
          border: "1px solid var(--border-soft)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 700 }}>
            Juros Adicionais — {labelParcela}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--text-main)",
              fontSize: 16,
              lineHeight: 1,
            }}
            aria-label="Fechar"
          >
            ×
          </button>
        </div>
        {clienteLabel ? (
          <div style={{ color: "var(--text-muted)", fontSize: "0.9em" }}>
            <ClienteIdentity
              cliente={resolverCliente(
                parcela?.cliente_id ?? parcela?.id_cliente,
                parcela?.cliente_nome || parcela?.nome_cliente
              )}
              avatarSize={32}
              secondary="Cliente"
            />
          </div>
        ) : null}

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span>Valor (R$)</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0,00"
            value={valor}
            onChange={(e) => setValor(formatCurrencyInput(e.target.value))}
            ref={valorRef}
            style={{
              padding: 8,
              borderRadius: 6,
              border: "1px solid var(--border-soft)",
              background: "var(--bg-card)",
              color: "var(--text-main)",
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span>Motivo</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            style={{
              padding: 8,
              borderRadius: 6,
              border: "1px solid var(--border-soft)",
              background: "var(--bg-card)",
              color: "var(--text-main)",
              resize: "vertical",
            }}
          />
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={salvando}
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
            onClick={handleSalvar}
            disabled={salvando}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "none",
              background: "#2563eb",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {salvando ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
