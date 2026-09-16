import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { createPortal } from "react-dom";
import notify from "../../ui/notify";
import { formatarData, formatarMoeda, pad } from "./helpers.jsx";
import StepperInput from "../common/StepperInput.jsx";

const cardStyle = {
  border: "1px solid rgba(37,99,235,0.22)",
  borderRadius: 10,
  padding: 10,
  background:
    "linear-gradient(135deg, rgba(37,99,235,0.12), rgba(37,99,235,0.04))",
};

function getHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toNumberInput(raw) {
  const txt = String(raw ?? "").trim();
  if (!txt) return 0;
  const hasComma = txt.includes(",");
  const hasDot = txt.includes(".");
  let normalized = txt;
  if (hasComma && hasDot) {
    normalized = txt.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    normalized = txt.replace(",", ".");
  }
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function clampMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Number(n.toFixed(2));
}

function roundMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function clampDiscountToMax(value, maxAllowed) {
  const n = Math.max(0, Number(value || 0));
  const max = Math.max(0, Number(maxAllowed || 0));
  if (!Number.isFinite(n) || !Number.isFinite(max)) return 0;
  return roundMoney(Math.min(n, max));
}

function getMonthEndISO(isoLike) {
  const txt = String(isoLike || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) return "";
  const y = Number(txt.slice(0, 4));
  const m = Number(txt.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "";
  const lastDay = new Date(y, m, 0).getDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(
    lastDay
  ).padStart(2, "0")}`;
}

function isSameMonth(isoA, isoB) {
  const a = String(isoA || "").slice(0, 7);
  const b = String(isoB || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(a) && a === b;
}

function getDayFromISO(isoLike) {
  const txt = String(isoLike || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) return 0;
  const day = Number(txt.slice(8, 10));
  return Number.isFinite(day) && day > 0 ? day : 0;
}

function buildISOFromPeriodAndDay(periodoISO, dayLike) {
  const periodo = String(periodoISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodo)) return "";
  const mesPrefixo = periodo.slice(0, 7);
  const ultimoDia = getDayFromISO(getMonthEndISO(periodo)) || 31;
  const diaInformado = Number(dayLike || 0);
  const diaSeguro = Math.min(
    Math.max(Number.isFinite(diaInformado) ? diaInformado : 1, 1),
    ultimoDia
  );
  return `${mesPrefixo}-${String(diaSeguro).padStart(2, "0")}`;
}

function formatDiaApenas(isoLike) {
  const dia = getDayFromISO(isoLike);
  return dia > 0 ? `dia ${dia}` : "";
}

function formatMoneyInput(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) return "0,00";
  return n.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatMoneyInputFromDigits(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "0,00";
  const cents = Number(digits);
  if (!Number.isFinite(cents) || cents < 0) return "0,00";
  return formatMoneyInput(cents / 100);
}

export default function RecalcularAtrasoModal({
  aberto,
  emprestimo,
  onClose,
  onAplicar,
}) {
  const [carregando, setCarregando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [erro, setErro] = useState("");
  const [preview, setPreview] = useState(null);
  const [valorFinal, setValorFinal] = useState("0,00");
  const [desconto, setDesconto] = useState("0,00");
  const [descontoPeriodo, setDescontoPeriodo] = useState("");
  const [descontoDataPeriodo, setDescontoDataPeriodo] = useState("");
  const [descontoValorPeriodo, setDescontoValorPeriodo] = useState("0,00");
  const [descontoAlocacoes, setDescontoAlocacoes] = useState({});
  const [valorEditadoManualmente, setValorEditadoManualmente] = useState(false);
  const inputValorRef = useRef(null);

  const emprestimoId = Number(emprestimo?.id || 0);

  const resumoPeriodo = useMemo(() => {
    if (!preview?.periodo_inicio || !preview?.periodo_fim) return "-";
    return `${formatarData(preview.periodo_inicio)} até ${formatarData(
      preview.periodo_fim
    )}`;
  }, [preview]);

  const opcoesDescontoPeriodo = useMemo(() => {
    const itens = Array.isArray(preview?.detalhamento_periodos)
      ? preview.detalhamento_periodos
      : [];
    return itens
      .map((item) => ({
        value: String(item?.periodo || "").slice(0, 10),
        label: item?.label || String(item?.periodo || "-"),
        valor: Number(item?.valor || 0),
      }))
      .filter((item) => !!item.value);
  }, [preview]);

  const descontoAtualNum = useMemo(
    () => Math.max(0, toNumberInput(desconto)),
    [desconto]
  );
  const descontoMaximo = useMemo(
    () => roundMoney(Math.max(0, Number(preview?.valor_sugerido || 0))),
    [preview]
  );

  const opcoesDescontoPeriodoDisponiveis = useMemo(() => {
    return opcoesDescontoPeriodo.filter(
      (item) => roundMoney(descontoAlocacoes?.[item.value]?.valor || 0) <= 0
    );
  }, [descontoAlocacoes, opcoesDescontoPeriodo]);

  const totalDescontoAlocado = useMemo(() => {
    return roundMoney(
      Object.values(descontoAlocacoes || {}).reduce(
        (sum, value) => sum + Number(value?.valor || 0),
        0
      )
    );
  }, [descontoAlocacoes]);

  const listaDescontoAlocado = useMemo(() => {
    return opcoesDescontoPeriodo
      .map((item) => ({
        ...item,
        valorAlocado: roundMoney(descontoAlocacoes?.[item.value]?.valor || 0),
        dataPagamento: String(
          descontoAlocacoes?.[item.value]?.data_pagamento || ""
        ).slice(0, 10),
      }))
      .filter((item) => item.valorAlocado > 0);
  }, [descontoAlocacoes, opcoesDescontoPeriodo]);

  const descontoDataMax = useMemo(
    () => getMonthEndISO(descontoPeriodo),
    [descontoPeriodo]
  );
  const descontoDiaPeriodo = useMemo(() => {
    const dia = getDayFromISO(descontoDataPeriodo);
    return dia ? String(dia) : "";
  }, [descontoDataPeriodo]);
  const descontoDiaMax = useMemo(() => {
    const ultimoDia = getDayFromISO(descontoDataMax);
    return ultimoDia || 31;
  }, [descontoDataMax]);

  useEffect(() => {
    if (!aberto) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [aberto]);

  useEffect(() => {
    if (!aberto || !emprestimoId) return;
    setErro("");
    setPreview(null);
    setCarregando(true);
    setDesconto("0,00");
    setDescontoPeriodo("");
    setDescontoDataPeriodo("");
    setDescontoValorPeriodo("0,00");
    setDescontoAlocacoes({});
    setValorFinal("0,00");
    setValorEditadoManualmente(false);

    axios
      .post(
        `/emprestimos/${emprestimoId}/recalcular-atraso/preview`,
        { data_base: getHojeISO() }
      )
      .then((resp) => {
        const data = resp?.data || {};
        setPreview(data);
        const firstPeriodo = Array.isArray(data?.detalhamento_periodos)
          ? String(data.detalhamento_periodos?.[0]?.periodo || "").slice(0, 10)
          : "";
        setDescontoPeriodo(firstPeriodo || "");
        setDescontoDataPeriodo(firstPeriodo || "");
        setDescontoValorPeriodo("0,00");
        setDescontoAlocacoes({});
        const sugerido = Number(data?.valor_sugerido || 0);
        setValorFinal(formatMoneyInput(sugerido));
        requestAnimationFrame(() => {
          inputValorRef.current?.focus?.();
          inputValorRef.current?.select?.();
        });
      })
      .catch((err) => {
        const msg =
          err?.response?.data?.error ||
          err?.response?.data?.erro ||
          err?.message ||
          "Erro ao simular recálculo de atraso.";
        setErro(msg);
      })
      .finally(() => {
        setCarregando(false);
      });
  }, [aberto, emprestimoId]);

  useEffect(() => {
    if (!preview || valorEditadoManualmente) return;
    const sugerido = Number(preview?.valor_sugerido || 0);
    const desc = Math.max(0, toNumberInput(desconto));
    const calculado = Math.max(0, sugerido - desc);
    setValorFinal(formatMoneyInput(calculado));
  }, [desconto, preview, valorEditadoManualmente]);

  useEffect(() => {
    if (!aberto) return;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [aberto, onClose]);

  useEffect(() => {
    if (descontoAtualNum <= 0) return;
    if (opcoesDescontoPeriodoDisponiveis.length === 0) {
      if (descontoPeriodo) setDescontoPeriodo("");
      if (descontoDataPeriodo) setDescontoDataPeriodo("");
      return;
    }
    const selecionadoAindaDisponivel = opcoesDescontoPeriodoDisponiveis.some(
      (item) => item.value === descontoPeriodo
    );
    if (!selecionadoAindaDisponivel) {
      const proximoPeriodo = opcoesDescontoPeriodoDisponiveis[0].value;
      setDescontoPeriodo(proximoPeriodo);
      setDescontoDataPeriodo(proximoPeriodo);
    }
  }, [
    descontoAtualNum,
    descontoDataPeriodo,
    descontoPeriodo,
    opcoesDescontoPeriodoDisponiveis,
  ]);

  useEffect(() => {
    if (!descontoPeriodo) return;
    if (descontoDataPeriodo && isSameMonth(descontoDataPeriodo, descontoPeriodo)) return;
    const diaBase =
      getDayFromISO(descontoDataPeriodo) || getDayFromISO(descontoPeriodo) || 1;
    setDescontoDataPeriodo(buildISOFromPeriodAndDay(descontoPeriodo, diaBase));
  }, [descontoDataPeriodo, descontoPeriodo]);

  if (!aberto) return null;

  const recalculoJaAplicado = Boolean(preview?.recalculo_ja_aplicado);
  const temAtraso = Boolean(preview?.tem_atraso) && !recalculoJaAplicado;
  const descontoRestante = Math.max(
    0,
    roundMoney(descontoAtualNum - totalDescontoAlocado)
  );

  const handleAtribuirDescontoPeriodo = () => {
    if (!descontoPeriodo) {
      notify.warn("Selecione um mês para atribuir o desconto.");
      return;
    }
    if (!descontoDataPeriodo || !isSameMonth(descontoDataPeriodo, descontoPeriodo)) {
      notify.warn("Escolha um dia dentro do mês selecionado.");
      return;
    }
    if (!(descontoAtualNum > 0)) {
      notify.warn("Informe um desconto maior que zero antes de distribuir.");
      return;
    }
    const valorDesejado = roundMoney(Math.max(0, toNumberInput(descontoValorPeriodo)));
    if (!(valorDesejado > 0)) {
      notify.warn("Informe um valor maior que zero para atribuir ao mês.");
      return;
    }
    if (!(descontoRestante > 0)) {
      notify.warn("Todo o desconto informado já foi distribuído.");
      return;
    }

    const valorAplicado = roundMoney(Math.min(valorDesejado, descontoRestante));
    setDescontoAlocacoes((prev) => {
      const atual = roundMoney(prev?.[descontoPeriodo]?.valor || 0);
      return {
        ...prev,
        [descontoPeriodo]: {
          valor: roundMoney(atual + valorAplicado),
          data_pagamento: String(descontoDataPeriodo || "").slice(0, 10),
        },
      };
    });
    setDescontoValorPeriodo("0,00");

    if (valorDesejado > valorAplicado) {
      notify.warn("Valor ajustado para não ultrapassar o desconto restante.");
    }
  };

  const handleAtribuirRestanteAoPeriodo = () => {
    if (!descontoPeriodo) {
      notify.warn("Selecione um mês para atribuir o restante.");
      return;
    }
    if (!descontoDataPeriodo || !isSameMonth(descontoDataPeriodo, descontoPeriodo)) {
      notify.warn("Escolha um dia dentro do mês selecionado.");
      return;
    }
    if (!(descontoRestante > 0)) {
      notify.warn("Não há desconto restante para atribuir.");
      return;
    }
    setDescontoAlocacoes((prev) => {
      const atual = roundMoney(prev?.[descontoPeriodo]?.valor || 0);
      return {
        ...prev,
        [descontoPeriodo]: {
          valor: roundMoney(atual + descontoRestante),
          data_pagamento: String(descontoDataPeriodo || "").slice(0, 10),
        },
      };
    });
    setDescontoValorPeriodo("0,00");
  };

  const handleRemoverAlocacaoPeriodo = (periodoISO) => {
    setDescontoAlocacoes((prev) => {
      const next = { ...(prev || {}) };
      delete next[periodoISO];
      return next;
    });
  };

  const handleAplicar = async () => {
    if (!preview || !temAtraso) return;
    const valorFinalNum = clampMoney(toNumberInput(valorFinal));
    const descontoNum = Math.max(0, Number(toNumberInput(desconto).toFixed(2)));
    const ordemPeriodos = new Map(
      opcoesDescontoPeriodo.map((item, idx) => [item.value, idx])
    );
    const descontoAlocacoesPayload = Object.entries(descontoAlocacoes || {})
      .map(([periodo, item]) => ({
        periodo: String(periodo || "").slice(0, 10),
        valor: roundMoney(item?.valor || 0),
        data_pagamento: String(item?.data_pagamento || "").slice(0, 10),
      }))
      .filter(
        (item) =>
          !!item.periodo &&
          item.valor > 0 &&
          !!item.data_pagamento &&
          isSameMonth(item.data_pagamento, item.periodo)
      )
      .sort(
        (a, b) =>
          (ordemPeriodos.get(a.periodo) ?? 9999) -
          (ordemPeriodos.get(b.periodo) ?? 9999)
      );
    const totalAlocadoPayload = roundMoney(
      descontoAlocacoesPayload.reduce((sum, item) => sum + Number(item.valor || 0), 0)
    );

    if (!(valorFinalNum > 0)) {
      notify.warn("Informe um valor final maior que zero.");
      return;
    }
    if (descontoNum > descontoMaximo + 0.009) {
      notify.warn(`Desconto máximo permitido: ${formatarMoeda(descontoMaximo)}.`);
      return;
    }
    if (descontoNum > 0) {
      if (!descontoAlocacoesPayload.length) {
        notify.warn("Distribua o desconto em pelo menos um mês.");
        return;
      }
      if (Math.abs(totalAlocadoPayload - descontoNum) > 0.009) {
        notify.warn("Distribua 100% do desconto informado antes de aplicar.");
        return;
      }
    }

    setAplicando(true);
    try {
      await axios.post(
        `/emprestimos/${emprestimoId}/recalcular-atraso/aplicar`,
        {
          valor_final: valorFinalNum,
          desconto_informado: descontoNum,
          desconto_periodo:
            descontoNum > 0 ? descontoAlocacoesPayload?.[0]?.periodo || null : null,
          desconto_alocacoes: descontoNum > 0 ? descontoAlocacoesPayload : [],
          data_base: preview?.data_base || getHojeISO(),
          parcela_destino_id: preview?.parcela_destino?.id || null,
        }
      );

      notify.success("Recálculo de atraso aplicado em juros pendentes.");
      if (typeof onAplicar === "function") {
        await onAplicar();
      }
      onClose?.();
    } catch (err) {
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.erro ||
        err?.message ||
        "Erro ao aplicar recálculo de atraso.";
      notify.error(msg);
    } finally {
      setAplicando(false);
    }
  };

  return createPortal(
    <div
      data-modal-recalcular-atraso="true"
      onClick={() => onClose?.()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10070,
        background: "rgba(2, 6, 23, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(680px, 96vw)",
          maxHeight: "92vh",
          overflowY: "auto",
          borderRadius: 12,
          border: "1px solid var(--border-soft)",
          background: "var(--bg-card)",
          color: "var(--text-main)",
          boxShadow: "0 20px 45px rgba(0,0,0,0.38)",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>
            <div style={{ fontSize: "1.05em", fontWeight: 700 }}>
              Recalcular atraso
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.9em" }}>
              Empréstimo #{emprestimoId}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            aria-label="Fechar"
            style={{
              border: "none",
              background: "transparent",
              color: "var(--text-main)",
              fontSize: 22,
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>

        {carregando && (
          <div style={cardStyle}>Analisando parcelas vencidas em aberto...</div>
        )}

        {!carregando && erro && (
          <div style={{ ...cardStyle, borderColor: "rgba(239,68,68,0.55)" }}>
            {erro}
          </div>
        )}

        {!carregando && !erro && preview && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                gap: 10,
              }}
            >
              <div style={cardStyle}>
                <div style={{ color: "var(--text-muted)", fontSize: "0.82em" }}>
                  Períodos vencidos detectados
                </div>
                <strong>{Number(preview?.periodos_detectados || 0)}</strong>
              </div>
              <div style={cardStyle}>
                <div style={{ color: "var(--text-muted)", fontSize: "0.82em" }}>
                  Faixa detectada
                </div>
                <strong>{resumoPeriodo}</strong>
              </div>
              <div style={cardStyle}>
                <div style={{ color: "var(--text-muted)", fontSize: "0.82em" }}>
                  Parcela destino
                </div>
                <strong>
                  {preview?.parcela_destino?.numero
                    ? `${preview.parcela_destino.numero}ª`
                    : "-"}
                </strong>
              </div>
              <div style={cardStyle}>
                <div style={{ color: "var(--text-muted)", fontSize: "0.82em" }}>
                  Valor sugerido
                </div>
                <strong>{formatarMoeda(preview?.valor_sugerido || 0)}</strong>
              </div>
              <div style={cardStyle}>
                <div style={{ color: "var(--text-muted)", fontSize: "0.82em" }}>
                  Ajuste de vencimento
                </div>
                <strong>{Number(preview?.meses_ajuste_datas || 0)} mês(es)</strong>
              </div>
            </div>

            <div
              style={{
                color: "var(--text-muted)",
                fontSize: "0.88em",
                marginTop: -2,
              }}
            >
              Pagamentos registrados no período detectado:{" "}
              <strong style={{ color: "var(--text-main)" }}>
                {formatarMoeda(preview?.pagos_registrados_periodo || 0)}
              </strong>
            </div>
            {preview?.parcela_destino?.vencimento_ajustado ? (
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: "0.85em",
                  marginTop: -4,
                }}
              >
                Vencimento da parcela destino após ajuste:{" "}
                <strong style={{ color: "var(--text-main)" }}>
                  {formatarData(preview.parcela_destino.vencimento_ajustado)}
                </strong>
              </div>
            ) : null}

            {!temAtraso && (
              <div style={cardStyle}>
                {recalculoJaAplicado
                  ? "Este empréstimo já recebeu recálculo de atraso na parcela atual. O botão fica bloqueado para evitar duplicidade."
                  : "Não há parcelas vencidas em aberto para este empréstimo."}
              </div>
            )}

            {temAtraso && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 10,
                }}
              >
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span>Desconto já pago no período (opcional)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={desconto}
                    onChange={(e) => {
                      const valorDigitado = toNumberInput(
                        formatMoneyInputFromDigits(e.target.value)
                      );
                      const valorLimitado = clampDiscountToMax(
                        valorDigitado,
                        descontoMaximo
                      );
                      setDesconto(formatMoneyInput(valorLimitado));
                      setDescontoAlocacoes({});
                      setDescontoValorPeriodo("0,00");
                    }}
                    onBlur={() => {
                      const valorLimitado = clampDiscountToMax(
                        toNumberInput(desconto),
                        descontoMaximo
                      );
                      setDesconto(formatMoneyInput(valorLimitado));
                    }}
                    style={{
                      border: "1px solid var(--border-soft)",
                      borderRadius: 8,
                      padding: "8px 10px",
                      background: "var(--bg-card)",
                      color: "var(--text-main)",
                    }}
                  />
                </label>

                {descontoAtualNum > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      minWidth: 0,
                    }}
                  >
                    <span>Distribuir desconto por mês</span>
                    <select
                      value={descontoPeriodo}
                      onChange={(e) => {
                        const novoPeriodo = e.target.value;
                        setDescontoPeriodo(novoPeriodo);
                        const diaBase =
                          getDayFromISO(descontoDataPeriodo) ||
                          getDayFromISO(novoPeriodo) ||
                          1;
                        setDescontoDataPeriodo(
                          buildISOFromPeriodAndDay(novoPeriodo, diaBase)
                        );
                      }}
                      disabled={opcoesDescontoPeriodoDisponiveis.length === 0}
                      style={{
                        border: "1px solid var(--border-soft)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        background: "var(--bg-card)",
                        color: "var(--text-main)",
                      }}
                    >
                      {opcoesDescontoPeriodoDisponiveis.length === 0 ? (
                        <option value="">Todos os meses já foram atribuídos</option>
                      ) : (
                        opcoesDescontoPeriodoDisponiveis.map((item) => (
                          <option key={item.value} value={item.value}>
                            {item.label}
                          </option>
                        ))
                      )}
                    </select>
                    <span style={{ fontSize: "0.8em", color: "var(--text-muted)" }}>
                      Dia do desconto no mês selecionado
                    </span>
                    <StepperInput
                      value={descontoDiaPeriodo || "1"}
                      onChange={(nextDay) => {
                        if (!descontoPeriodo) return;
                        const iso = buildISOFromPeriodAndDay(descontoPeriodo, nextDay);
                        setDescontoDataPeriodo(iso);
                      }}
                      min={1}
                      max={descontoDiaMax}
                      allowManualInput
                      returnAs="string"
                      inputAriaLabel="Dia do desconto no mês selecionado"
                      disabled={!descontoPeriodo || descontoRestante <= 0}
                      style={{
                        width: "100%",
                        background:
                          !descontoPeriodo || descontoRestante <= 0
                            ? "rgba(148,163,184,0.18)"
                            : "var(--bg-card)",
                      }}
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      value={descontoValorPeriodo}
                      disabled={descontoRestante <= 0}
                      onChange={(e) =>
                        setDescontoValorPeriodo(formatMoneyInputFromDigits(e.target.value))
                      }
                      onBlur={() =>
                        setDescontoValorPeriodo(
                          formatMoneyInput(toNumberInput(descontoValorPeriodo))
                        )
                      }
                      placeholder="0,00"
                      style={{
                        width: "100%",
                        border: "1px solid var(--border-soft)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        background:
                          descontoRestante <= 0
                            ? "rgba(148,163,184,0.18)"
                            : "var(--bg-card)",
                        color: "var(--text-main)",
                        boxSizing: "border-box",
                        cursor: descontoRestante <= 0 ? "not-allowed" : "text",
                      }}
                    />
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 6,
                      }}
                    >
                      <button
                        type="button"
                        onClick={handleAtribuirDescontoPeriodo}
                        disabled={!descontoPeriodo || descontoRestante <= 0}
                        style={{
                          borderRadius: 8,
                          border: "1px solid var(--border-soft)",
                          background: "var(--bg-card)",
                          color: "var(--text-main)",
                          padding: "8px 10px",
                          whiteSpace: "nowrap",
                          cursor:
                            !descontoPeriodo || descontoRestante <= 0
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        Atribuir
                      </button>
                      <button
                        type="button"
                        onClick={handleAtribuirRestanteAoPeriodo}
                        disabled={!descontoPeriodo || descontoRestante <= 0}
                        style={{
                          borderRadius: 8,
                          border: "1px solid var(--border-soft)",
                          background: "var(--bg-card)",
                          color: "var(--text-main)",
                          padding: "8px 10px",
                          whiteSpace: "nowrap",
                          cursor:
                            !descontoPeriodo || descontoRestante <= 0
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        Restante
                      </button>
                    </div>
                    <div
                      style={{
                        fontSize: "0.82em",
                        color: "var(--text-muted)",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ whiteSpace: "nowrap" }}>
                        Alocado:{" "}
                        <strong style={{ color: "var(--text-main)" }}>
                          {formatarMoeda(totalDescontoAlocado)}
                        </strong>
                      </span>
                      <span aria-hidden="true">|</span>
                      <span style={{ whiteSpace: "nowrap" }}>
                        Restante:{" "}
                        <strong style={{ color: "var(--text-main)" }}>
                          {formatarMoeda(descontoRestante)}
                        </strong>
                      </span>
                    </div>
                    {listaDescontoAlocado.length > 0 && (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          maxHeight: 120,
                          overflowY: "auto",
                          border: "1px solid var(--border-soft)",
                          borderRadius: 8,
                          padding: 6,
                        }}
                      >
                        {listaDescontoAlocado.map((item) => (
                          <div
                            key={`alloc-${item.value}`}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <span style={{ fontSize: "0.9em" }}>
                              {item.label}{" "}
                              {item.dataPagamento
                                ? `(${formatDiaApenas(item.dataPagamento)})`
                                : ""}:{" "}
                              <strong>{formatarMoeda(item.valorAlocado)}</strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoverAlocacaoPeriodo(item.value)}
                              style={{
                                border: "1px solid var(--border-soft)",
                                borderRadius: 6,
                                background: "var(--bg-card)",
                                color: "var(--text-main)",
                                padding: "2px 8px",
                                cursor: "pointer",
                              }}
                            >
                              Remover
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span>Valor final para lançar em juros pendentes</span>
                  <input
                    ref={inputValorRef}
                    type="text"
                    inputMode="decimal"
                    value={valorFinal}
                    onChange={(e) => {
                      setValorFinal(e.target.value);
                      setValorEditadoManualmente(true);
                    }}
                    onBlur={() =>
                      setValorFinal(formatMoneyInput(toNumberInput(valorFinal)))
                    }
                    style={{
                      border: "1px solid var(--border-soft)",
                      borderRadius: 8,
                      padding: "8px 10px",
                      background: "var(--bg-card)",
                      color: "var(--text-main)",
                    }}
                  />
                </label>
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={aplicando}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-soft)",
              background: "var(--bg-card)",
              color: "var(--text-main)",
              cursor: "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!preview || !temAtraso || aplicando || carregando}
            onClick={handleAplicar}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "none",
              background:
                !preview || !temAtraso || aplicando || carregando
                  ? "rgba(148,163,184,0.4)"
                  : "#0ea5e9",
              color: "#fff",
              cursor:
                !preview || !temAtraso || aplicando || carregando
                  ? "not-allowed"
                  : "pointer",
              fontWeight: 700,
            }}
          >
            {aplicando ? "Aplicando..." : "Aplicar em juros pendentes"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

