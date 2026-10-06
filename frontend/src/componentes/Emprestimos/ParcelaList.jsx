// frontend/src/componentes/Emprestimos/ParcelaList.jsx
import React, { useEffect, useState } from "react";
import axios from "axios";
import notify from "../../ui/notify";
import JurosAdicionaisModal from "./JurosAdicionaisModal.jsx";
import ReagendarVencimentoModal from "./ReagendarVencimentoModal.jsx";
import {
  formatarMoeda,
  formatarData,
  toDateObj,
  renderLinhaJuros,
  getTotalDevidoParcela,
  toNum,
  renderHighlightedText,
  getExpLineType,
  isParcelFantasma,
  isParcelQuitadaMensagem,
  extractQuitAmountFromExplicacao,
  extractDateFromExplicacao,
  parseObservacoes,
  tipoLabel,
} from "./helpers.jsx";

const ParcelaList = ({
  parcelas = [],
  showAntigas = false,
  onAtualizarVencimento,
  usarVisualNovo = false,
  somenteLeitura = false,
  parcelaDestaqueId = null,
}) => {
  const [showMoreInfo, setShowMoreInfo] = useState({});
  const [jurosModal, setJurosModal] = useState({
    aberto: false,
    parcela: null,
  });
  const [parcelasAtualizadas, setParcelasAtualizadas] = useState({});
  const [abriuJurosParam, setAbriuJurosParam] = useState(false);
  const [mostrarPagamento, setMostrarPagamento] = useState(null);
  const [reagendamentoModal, setReagendamentoModal] = useState(null);
  const usaParcelaVisualNovo = Boolean(usarVisualNovo);

  // Popover para decidir se aplica o novo DIA a todo o empréstimo
  const [popoverDia, setPopoverDia] = useState({
    aberto: false,
    parcela: null,
    novaDataISO: "",
  });

  const toggleMoreInfo = (parcelaId) => {
    setShowMoreInfo((prev) => ({ ...prev, [parcelaId]: !prev[parcelaId] }));
  };

  const abrirJurosModal = (parcela) => {
    setJurosModal({ aberto: true, parcela });
  };

  const fecharJurosModal = () => {
    setJurosModal({ aberto: false, parcela: null });
  };

  useEffect(() => {
    if (abriuJurosParam) return;
    const hash = window.location.hash || "";
    const query = hash.includes("?") ? hash.split("?")[1] : "";
    const params = new URLSearchParams(query);
    if (params.get("juros") !== "1") return;
    const parcelaParam = Number(
      params.get("parcela") ||
        params.get("parcelaId") ||
        params.get("parcela_id")
    );
    if (!Number.isFinite(parcelaParam)) return;
    const alvo = (parcelas || []).find(
      (p) => Number(p?.id || p?.parcela_id) === parcelaParam
    );
    if (!alvo) return;
    setJurosModal({ aberto: true, parcela: alvo });
    setAbriuJurosParam(true);
  }, [abriuJurosParam, parcelas]);

  const fecharPopoverDia = () => {
    setPopoverDia({
      aberto: false,
      parcela: null,
      novaDataISO: "",
    });
  };

  const abrirJurosComSenha = async (parcela, isAtual) => {
    if (isAtual) {
      abrirJurosModal(parcela);
      return;
    }
    const alvoNumero = parcela?.numero ?? parcela?.parcela_numero ?? "-";
    const atualNumero =
      parcelaAtualNumero != null && parcelaAtualNumero !== ""
        ? parcelaAtualNumero
        : "-";
    const mensagem =
      "Voce esta tentando adicionar juros em uma parcela futura.\n\n" +
      `Parcela atual do emprestimo: ${atualNumero}\n` +
      `Parcela que voce quer adicionar juros: ${alvoNumero}\n\n` +
      "Deseja continuar?";
    const confirmado = await notify.confirm(mensagem, {
      okText: "Continuar",
      title: "Confirmar juros futuros",
    });
    if (!confirmado) return;
    abrirJurosModal(parcela);
  };

  const navegarParaPagamento = (parcela) => {
    if (!parcela) return;
    const emprestimoId = parcela.emprestimo_id;
    if (!emprestimoId) return;
    const params = new URLSearchParams();
    params.set("emprestimo", emprestimoId);
    const parcelaNum = parcela.numero ?? parcela.parcela_numero;
    if (parcelaNum != null && parcelaNum !== "") {
      params.set("parcela", parcelaNum);
    }
    window.location.hash = `#/pagamento?${params.toString()}`;
  };

  /**
   * CONFIRMAR no popover:
   *  - chama POST /parcelas/emprestimo/:emprestimo_id/alterar-dia-vencimento
   *  - backend aplica o DIA de novaDataISO em TODAS as parcelas NÃO PAGAS
   *  - não mexe em arrays locais; o pai recarrega os dados
   *  - avisa o pai via onAtualizarVencimento(null, norm, { tipo: 'alterar-dia-todas', emprestimoId })
   */
  const confirmarAplicarDiaEmTodoEmprestimo = async () => {
    const { parcela, novaDataISO } = popoverDia;
    if (!parcela || !novaDataISO) {
      fecharPopoverDia();
      return;
    }

    try {
      const emprestimoId = parcela.emprestimo_id;

      if (!emprestimoId || parcela.origem === "snapshot") {
        notify.error(
          "Sistema Empréstimos: não é possível aplicar este dia a todas as parcelas a partir desta linha."
        );
        // fallback: trata como alteração de uma única parcela
        handleVencimentoChange(parcela, novaDataISO);
        fecharPopoverDia();
        return;
      }

      console.log("[DEBUG alterar-dia-todas] parcela.id, emprestimo_id =>", {
        parcelaId: parcela.id || parcela.parcela_id,
        emprestimo_id_raw: parcela.emprestimo_id,
      });

      if (!emprestimoId) {
        notify.error(
          "Sistema Empréstimos: não foi possível identificar o empréstimo desta parcela."
        );
        fecharPopoverDia();
        return;
      }

      // Garante formato "YYYY-MM-DD" puro vindo do input type="date"
      const norm = String(novaDataISO).trim().slice(0, 10);

      await axios.post(
        `/parcelas/emprestimo/${emprestimoId}/alterar-dia-vencimento`,
        { novaDataISO: norm }
      );

      notify.success(
        "Sistema Empréstimos: dia de vencimento atualizado em todas as parcelas não pagas do empréstimo."
      );

      if (onAtualizarVencimento) {
        onAtualizarVencimento(null, norm, {
          tipo: "alterar-dia-todas",
          emprestimoId,
        });
      }
    } catch (err) {
      console.error(err);
      const msg =
        err.response?.data?.error ||
        err.response?.data?.erro ||
        err.message ||
        "Erro ao atualizar o dia de vencimento em todo o empréstimo.";
      notify.error("Sistema Empréstimos: " + msg);
    } finally {
      fecharPopoverDia();
    }
  };

  /**
   * Regra de mudança de vencimento com opção de "empurrar todas" (mês em cascata).
   * Usa POST /parcelas/:id/reagendar com { novaDataISO, modo }.
   */
  const handleVencimentoChange = (parcela, novaDataISO) => {
    const parcelaId = parcela.parcela_id || parcela.id;

    if (!novaDataISO) {
      if (onAtualizarVencimento) {
        onAtualizarVencimento(parcelaId, "");
      }
      return;
    }

    const novaData = new Date(novaDataISO);
    if (isNaN(novaData.getTime())) {
      notify.error("Sistema Empréstimos: data inválida.");
      return;
    }

    const antigaData = parcela.vencimento ? new Date(parcela.vencimento) : null;

    const novoMes = novaData.getMonth();
    const novoAno = novaData.getFullYear();
    const antigoMes = antigaData ? antigaData.getMonth() : null;
    const antigoAno = antigaData ? antigaData.getFullYear() : null;

    const mudouMesOuAno =
      antigoMes === null ||
      antigoAno === null ||
      antigoMes !== novoMes ||
      antigoAno !== novoAno;

    // já existe outra parcela no mesmo mês/ano?
    const existeNoMesmoMesAno = (parcelas || []).some((p) => {
      if (!p) return false;
      const pid = p.parcela_id || p.id;
      if (pid === parcelaId) return false;
      if (p.emprestimo_id !== parcela.emprestimo_id) return false;
      if (!p.vencimento) return false;
      const d = new Date(p.vencimento);
      if (isNaN(d.getTime())) return false;
      return d.getMonth() === novoMes && d.getFullYear() === novoAno;
    });

    // existem parcelas posteriores (numero > atual) neste empréstimo?
    const haProximas = (parcelas || []).some((p) => {
      if (!p) return false;
      if (p.emprestimo_id !== parcela.emprestimo_id) return false;
      return Number(p.numero) > Number(parcela.numero);
    });

    let modo = "single";

    if (haProximas && (mudouMesOuAno || existeNoMesmoMesAno)) {
      const cabecalho = "[Sistema Empréstimos]\n\n";
      const detalhe = existeNoMesmoMesAno
        ? "Já existe uma parcela com vencimento neste mesmo mês.\n\n"
        : "Este novo vencimento pode alterar o cronograma das próximas parcelas.\n\n";

      const escolha =
        "O que você deseja fazer?\n\n" +
        "Cancelar → altera só esta parcela.\n" +
        "OK → altera esta e TODAS as próximas parcelas, empurrando mês a mês.";

      const querCascade = false;
      modo = querCascade ? "cascade" : "single";
    }

    axios
      .post(`/parcelas/${parcelaId}/reagendar`, {
        novaDataISO,
        modo,
      })
      .then(() => {
        if (modo === "cascade") {
          notify.success(
            "Sistema Empréstimos: vencimentos das próximas parcelas foram atualizados em cadeia."
          );
        } else {
          notify.success(
            "Sistema Empréstimos: vencimento desta parcela foi atualizado."
          );
        }

        if (onAtualizarVencimento) {
          onAtualizarVencimento(parcelaId, novaDataISO);
        }
      })
      .catch((err) => {
        console.error(err);
        const msg =
          err.response?.data?.error ||
          err.response?.data?.erro ||
          err.message ||
          "Erro ao reagendar vencimento das parcelas.";
        notify.error("Sistema Empréstimos: " + msg);
      });
  };

  /**
   * Wrapper do onChange do input de vencimento:
   * - se mudou só o DIA (mesmo mês/ano) → abre popover (Confirmar/Cancelar).
   * - caso contrário → segue para handleVencimentoChange (single/cascade mês).
   */
  const onChangeVencimentoInput = (parcela, novaDataISO) => {
    if (!novaDataISO) {
      handleVencimentoChange(parcela, novaDataISO);
      return;
    }

    const nova = new Date(novaDataISO);
    const antiga = parcela.vencimento ? new Date(parcela.vencimento) : null;

    if (!antiga || isNaN(nova.getTime()) || isNaN(antiga.getTime())) {
      handleVencimentoChange(parcela, novaDataISO);
      return;
    }

    const diaNovo = nova.getDate();
    const diaAntigo = antiga.getDate();
    const mesNovo = nova.getMonth();
    const anoNovo = nova.getFullYear();
    const mesAntigo = antiga.getMonth();
    const anoAntigo = antiga.getFullYear();

    const mudouDia = diaNovo !== diaAntigo;
    const mesmoMesAno = mesNovo === mesAntigo && anoNovo === anoAntigo;

    if (mudouDia && mesmoMesAno) {
      // só mudou o DIA → pergunta se quer aplicar o dia em todas as parcelas
      setPopoverDia({
        aberto: true,
        parcela,
        novaDataISO,
      });
    } else {
      handleVencimentoChange(parcela, novaDataISO);
    }
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
        {otherLines.map((ln, idx) => {
          const lineText = ln.includes("Pagamento parcial de juros:")
            ? `⏳ ${ln}`
            : ln;
          return (
            <div
              key={`${parcelaId}-other-${idx}`}
              style={{ display: "block", marginTop: idx === 0 ? 0 : 6 }}
            >
              {renderHighlightedText(lineText, {
                boldCurrency: true,
                currencyWeight: 600,
              })}
            </div>
          );
        })}

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
                    {renderHighlightedText(ln, {
                      boldCurrency: true,
                      currencyWeight: 600,
                    })}
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
              <div
                className={
                  usaParcelaVisualNovo ? "parcela-card__meta-item" : undefined
                }
              >
                <div>{o.texto}</div>
                <div style={{ marginTop: 4 }}>
                  <small
                    style={{ color: "var(--text-muted)", fontSize: "0.8em" }}
                  >
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
    return (
      <p style={{ color: "var(--text-muted)" }}>Nenhuma parcela registrada.</p>
    );
  }

  const baseParcelas = parcelas;

  const lista = baseParcelas.filter((p) => {
    if (!p) return false;
    if (showAntigas) {
      return !!p.renegociada || Number(p.numero) === -1;
    }
    return !p.renegociada && Number(p.numero) !== -1;
  });

  const permitirPagamento = !showAntigas && !somenteLeitura;
  const destaqueIdNum = Number(parcelaDestaqueId);
  const hasParcelaDestaque = Number.isFinite(destaqueIdNum) && destaqueIdNum > 0;

  const parcelaAtualInfo = (() => {
    for (const p of lista) {
      if (!p) continue;
      const pid = p.parcela_id || p.id;
      const pago = p.pago === 1 || p.pago === true;
      const valorPago = Number(p.valor_pago || 0);
      if (!pago && valorPago <= 0) {
        return {
          id: pid,
          numero: p.numero ?? p.parcela_numero ?? null,
        };
      }
    }
    return { id: null, numero: null };
  })();
  const parcelaAtualId = parcelaAtualInfo.id;
  const parcelaAtualNumero = parcelaAtualInfo.numero;

  return (
    <>
      <ul style={{ listStyle: "none", paddingLeft: 0 }}>
      {lista.map((parcelaRaw) => {
        const parcelaId = parcelaRaw.parcela_id || parcelaRaw.id;
        let p = parcelaRaw;
        const atualizada = parcelasAtualizadas[parcelaId];
        if (atualizada) {
          p = { ...p, ...atualizada };
        }

        const totalDevido = getTotalDevidoParcela(p);
        const totalExibido = p.valor_com_desconto || totalDevido;
        const baseContrato = toNum(p.valor_total);
        const jurosAdicNum = toNum(p.juros_adicionais);
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

        const valorPagoReal = Number(p.valor_pago || 0);
        let totalPago = valorPagoReal;

        if (quitadaMsg && quitAmount) {
          totalPago = Number(quitAmount);
        }

        const excedente = Math.max(0, totalPago - totalExibido);

        const totalBase = Math.max(totalExibido || 0, 0);
        const pagoFlag = p.pago === 1 || p.pago === true;
        const pagoCompleto =
          pagoFlag || (totalBase > 0 && totalPago >= totalBase);
        const parcial =
          !pagoCompleto &&
          totalBase > 0 &&
          totalPago > 0 &&
          totalPago < totalBase;
        const paga = pagoCompleto || parcial || !!quitadaMsg;
        let fantasma = false;

        if (showAntigas) {
          const tevePagamento = pagoCompleto || parcial;

          if (Number(p.numero) === -1) {
            fantasma = true;
          } else {
            fantasma = !tevePagamento;
          }
        } else {
          // Na aba de empréstimos: fantasma só se for parcela fantasma/cancelada.
          fantasma = isParcelFantasma(p);
        }

        // Para estilo: pago ou fantasma fica opaco; apenas fantasma recebe cor/itálico.
        const isAtual =
          permitirPagamento &&
          parcelaAtualId != null &&
          parcelaAtualId === parcelaId;
        const isParcelaDestaque =
          hasParcelaDestaque && Number(parcelaId) === destaqueIdNum;
        const opaco = !isAtual && (paga || fantasma);

        const numeroLabel =
          Number(p.numero) === -1 ? "Parcela fantasma" : `${p.numero}ª parcela`;
        const origemLabel =
          Number(p.numero) === -1
            ? ""
            : showAntigas
            ? " (Anterior)"
            : p.renegociada
            ? " (Renegociada)"
            : "";

        const popoverAtivo =
          popoverDia.aberto &&
          popoverDia.parcela &&
          (popoverDia.parcela.parcela_id || popoverDia.parcela.id) ===
            parcelaId;
        const diaOrig = (() => {
          const d = toDateObj(p.vencimento);
          return d ? String(d.getDate()).padStart(2, "0") : "?";
        })();
        const diaNovo = (() => {
          const d = toDateObj(popoverDia.novaDataISO);
          return d ? String(d.getDate()).padStart(2, "0") : "?";
        })();

        const estiloBaseParcela = usaParcelaVisualNovo
          ? {
              marginBottom: 10,
              padding: 10,
              border: "1px solid var(--border-soft)",
              borderRadius: 12,
              backgroundColor: p.renegociada
                ? "rgba(255,255,255,0.04)"
                : "var(--bg-card)",
              opacity: opaco ? 0.55 : 1,
              color: fantasma ? "var(--text-muted)" : "var(--text-main)",
              fontStyle: fantasma ? "italic" : "normal",
              position: "relative",
              cursor: isAtual ? "pointer" : "default",
            }
          : {
              marginBottom: 14,
              padding: 12,
              border: "1px solid var(--border-soft)",
              borderRadius: 10,
              backgroundColor: p.renegociada
                ? "rgba(255,255,255,0.05)"
                : "var(--bg-card)",
              opacity: opaco ? 0.45 : 1,
              color: fantasma ? "var(--text-muted)" : "var(--text-main)",
              fontStyle: fantasma ? "italic" : "normal",
              position: "relative",
              cursor: isAtual ? "pointer" : "default",
            };

        const estiloParcela = isParcelaDestaque
          ? {
              ...estiloBaseParcela,
              border: "1px solid rgba(255, 205, 72, 0.95)",
              boxShadow:
                "0 0 0 2px rgba(255, 205, 72, 0.35), 0 0 22px rgba(255, 205, 72, 0.45)",
            }
          : estiloBaseParcela;

        return (
          <li
            key={parcelaId}
            className={`parcela-card${isAtual ? " parcela-atual" : ""}${
              usaParcelaVisualNovo ? " parcela-card--modern" : ""
            }${fantasma ? " parcela-card--ghost" : ""}${
              paga && !isAtual ? " parcela-card--settled" : ""
            }${isParcelaDestaque ? " parcela-card--notif-highlight" : ""}`}
            onClick={(e) => {
              if (!permitirPagamento || !isAtual) return;
              const alvo = e.target;
              if (alvo?.closest?.("button, input, textarea, select, a")) {
                return;
              }
              setMostrarPagamento((prev) =>
                prev === parcelaId ? null : parcelaId
              );
            }}
            style={estiloParcela}
          >
            <div
              className={
                usaParcelaVisualNovo ? "parcela-card__header" : undefined
              }
            >
              <strong>
                {numeroLabel}
                {origemLabel}
                :
              </strong>{" "}
              <span
                className={
                  usaParcelaVisualNovo ? "parcela-card__total" : undefined
                }
                style={{ fontWeight: 600 }}
              >
                {formatarMoeda(totalExibido)}
              </span>
              {Math.abs(totalDevido - baseContrato) > 0.009 && (
                <span
                  style={{
                    fontSize: "0.9em",
                    color: "var(--text-muted)",
                    opacity: 0.6,
                    marginLeft: 8,
                  }}
                >
                  (Original:{" "}
                  {formatarMoeda(baseContrato)}
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

            <div
              className={
                usaParcelaVisualNovo ? "parcela-card__juros" : undefined
              }
              style={usaParcelaVisualNovo ? undefined : { marginTop: 6 }}
            >
              <small style={{ color: "var(--text-main)" }}>
                {renderLinhaJuros(p, formatarMoeda, {
                  renderJurosAdicionais: (valor) =>
                    !somenteLeitura && !paga && !fantasma ? (
                      <button
                        type="button"
                        onClick={() => abrirJurosComSenha(p, isAtual)}
                        className={`juros-adicionais-btn${
                          usaParcelaVisualNovo
                            ? " juros-adicionais-btn--modern"
                            : ""
                        }`}
                        style={{
                          border: "1px solid rgba(56,189,248,0.35)",
                          background: "rgba(56,189,248,0.12)",
                          color: "var(--text-main)",
                          padding: "2px 6px",
                          cursor: "pointer",
                          fontSize: "inherit",
                          fontWeight: 600,
                          borderRadius: 6,
                          textDecoration: "none",
                          lineHeight: 1.2,
                        }}
                      >
                        Juros Adicionais:{" "}
                        {jurosAdicNum > 0 ? (
                          <strong>{valor}</strong>
                        ) : (
                          <span>{valor}</span>
                        )}
                      </button>
                    ) : (
                      <>
                        Juros Adicionais:{" "}
                        {jurosAdicNum > 0 ? (
                          <strong>{valor}</strong>
                        ) : (
                          <span>{valor}</span>
                        )}
                      </>
                    ),
                })}
              </small>
            </div>

            <div
              className={
                usaParcelaVisualNovo ? "parcela-card__vencimento" : undefined
              }
              style={
                usaParcelaVisualNovo
                  ? undefined
                  : {
                      marginTop: 8,
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                    }
              }
            >
              <div
                className={usaParcelaVisualNovo ? "parcela-card__vencimento-label" : undefined}
                style={usaParcelaVisualNovo ? undefined : { display: "flex", alignItems: "center", gap: 8 }}
              >
                <strong>Vencimento:</strong>
                {!somenteLeitura && (
                  <button
                    type="button"
                    onClick={() => setReagendamentoModal(p)}
                    style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid var(--border-soft)", background: "transparent", color: "var(--text-main)", cursor: "pointer" }}
                  >
                    Alterar vencimento
                  </button>
                )}
              </div>
              <div
                className={
                  usaParcelaVisualNovo
                    ? "parcela-card__vencimento-date"
                    : undefined
                }
                style={
                  usaParcelaVisualNovo
                    ? undefined
                    : { fontSize: "0.95em", color: "var(--text-main)" }
                }
              >
                {formatarData(p.vencimento)}
              </div>
            </div>

            {/* POPOVER: confirmar aplicar DIA em todo o empréstimo */}
            {false && popoverAtivo && (
              <div
                style={{
                  position: "absolute",
                  top: 50,
                  right: 10,
                  zIndex: 10,
                  background: "var(--bg-card)",
                  border: "1px solid var(--border-soft)",
                  borderRadius: 8,
                  padding: 10,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
                  maxWidth: 280,
                  fontSize: "0.85em",
                }}
              >
                <div style={{ marginBottom: 6 }}>
                  Você alterou o <strong>DIA</strong> do vencimento desta
                  parcela de <strong>{diaOrig}</strong> para{" "}
                  <strong>{diaNovo}</strong>.
                </div>
                <div style={{ marginBottom: 6 }}>
                  Deseja aplicar este mesmo <strong>DIA</strong> de vencimento
                  para <strong>todas as parcelas</strong> deste empréstimo?
                </div>
                <div style={{ marginBottom: 8, opacity: 0.8 }}>
                  Cancelar → altera só esta parcela
                  <br />
                  Confirmar → altera o dia em todas as parcelas
                </div>
                <div
                  style={{
                    marginTop: 6,
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                  }}
                >
                  <button
                    onClick={() => {
                      const { parcela, novaDataISO } = popoverDia;
                      if (parcela && novaDataISO) {
                        // Cancelar = só esta parcela (respeita lógica de mês/cascade se necessário)
                        handleVencimentoChange(parcela, novaDataISO);
                      }
                      fecharPopoverDia();
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border-soft)",
                      background: "transparent",
                      color: "var(--text-main)",
                      cursor: "pointer",
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={confirmarAplicarDiaEmTodoEmprestimo}
                    style={{
                      padding: "4px 12px",
                      borderRadius: 6,
                      border: "none",
                      background: "#2563eb",
                      color: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    Confirmar
                  </button>
                </div>
              </div>
            )}

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

            {fantasma && !quitadaMsg && Number(p.numero) === -1 && (
              <div
                style={{
                  marginTop: 8,
                  fontStyle: "italic",
                  color: "var(--text-muted)",
                }}
              >
                Empréstimo quitado
              </div>
            )}

            {!quitadaMsg &&
              !fantasma &&
              renderExpLinesWithToggle(explicLines, parcelaId)}

            {(pagoCompleto || quitadaMsg) && <div
              className={
                usaParcelaVisualNovo ? "parcela-card__meta-grid" : undefined
              }
              style={{ marginTop: usaParcelaVisualNovo ? 8 : valorPagoMarginTop }}
            >
              <div
                className={
                  usaParcelaVisualNovo ? "parcela-card__meta-item" : undefined
                }
              >
                Valor Pago:{" "}
                {totalPago > 0 ? (
                  <strong>{formatarMoeda(totalPago)}</strong>
                ) : (
                  "-"
                )}
              </div>
              {!showAntigas && p.tipo_pagamento && paga && (
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
            </div>}

            {(pagoCompleto || quitadaMsg) && <div
              className={
                usaParcelaVisualNovo ? "parcela-card__meta-item" : undefined
              }
              style={usaParcelaVisualNovo ? { marginTop: 8 } : { marginTop: 8 }}
            >
              Data Pagamento:{" "}
              {fantasma
                ? "-"
                : quitadaMsg
                ? dataQuitacao
                  ? formatarData(dataQuitacao)
                  : p.data_pagamento
                  ? formatarData(p.data_pagamento)
                  : "-"
                : paga
                ? formatarData(p.data_pagamento)
                : "-"}
            </div>}

            {!fantasma && !quitadaMsg && renderObservations(p, parcelaId)}

            <div
              className={
                usaParcelaVisualNovo
                  ? "parcela-card__meta-item parcela-card__meta-item--status"
                  : undefined
              }
              style={usaParcelaVisualNovo ? { marginTop: 8 } : { marginTop: 6 }}
            >
              {pagoCompleto ? (
                <span
                  className={
                    usaParcelaVisualNovo
                      ? "parcela-status parcela-status--ok"
                      : undefined
                  }
                  style={usaParcelaVisualNovo ? undefined : { color: "green" }}
                >
                  ✅ Pago
                </span>
              ) : parcial ? (
                <span
                  className={
                    usaParcelaVisualNovo
                      ? "parcela-status parcela-status--warn"
                      : undefined
                  }
                  style={usaParcelaVisualNovo ? undefined : { color: "orange" }}
                >
                  ⚠️ Parcialmente pago
                </span>
              ) : (
                <span
                  className={
                    usaParcelaVisualNovo
                      ? "parcela-status parcela-status--pending"
                      : undefined
                  }
                  style={usaParcelaVisualNovo ? undefined : { color: "red" }}
                >
                  ❌ Pendente
                </span>
              )}
            </div>

            {permitirPagamento && isAtual && mostrarPagamento === parcelaId && (
              <div
                className={
                  usaParcelaVisualNovo ? "parcela-card__action-row" : undefined
                }
                style={
                  usaParcelaVisualNovo
                    ? undefined
                    : { marginTop: 10, display: "flex" }
                }
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navegarParaPagamento(p);
                  }}
                  className={
                    usaParcelaVisualNovo ? "parcela-card__pay-btn" : undefined
                  }
                  style={
                    usaParcelaVisualNovo
                      ? undefined
                      : {
                          padding: "6px 12px",
                          borderRadius: 8,
                          border: "none",
                          background: "#16a34a",
                          color: "#fff",
                          cursor: "pointer",
                          fontWeight: 700,
                          fontSize: "0.85em",
                        }
                  }
                >
                  Ir para pagamento
                </button>
              </div>
            )}
          </li>
        );
      })}
      </ul>
      <ReagendarVencimentoModal
        parcela={reagendamentoModal}
        parcelas={lista}
        onClose={() => setReagendamentoModal(null)}
        onConcluido={async () => {
          await onAtualizarVencimento?.();
        }}
      />
      <JurosAdicionaisModal
        aberto={jurosModal.aberto}
        parcela={jurosModal.parcela}
        onClose={fecharJurosModal}
        onSalvar={(parcelaAtualizada) => {
          if (parcelaAtualizada) {
            const pid = parcelaAtualizada.id || parcelaAtualizada.parcela_id;
            if (pid) {
              setParcelasAtualizadas((prev) => ({
                ...prev,
                [pid]: parcelaAtualizada,
              }));
            }
          }
          fecharJurosModal();
        }}
      />
    </>
  );
};

export default ParcelaList;
