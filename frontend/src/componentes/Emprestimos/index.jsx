// frontend/src/componentes/Emprestimos/index.jsx
import React, { useEffect, useState, useRef } from "react";
import axios from "axios";
import EditarEmprestimo from "../editaremprestimo";
import { useLocation, useNavigate } from "react-router-dom";
import notify from "../../ui/notify";
import ParcelaList from "./ParcelaList";
import { formatarMoeda, formatarData, toDateObj, calcularTempoPassado } from "./helpers.jsx";

export default function Emprestimos() {
  const [emprestimos, setEmprestimos] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [expandedClientes, setExpandedClientes] = useState({});
  const [editarId, setEditarId] = useState(null);
  const [busca, setBusca] = useState("");
  const [novoPagamento, setNovoPagamento] = useState({ valor: "", tipo: "adiantamento" });

  const location = useLocation();
  const navigate = useNavigate();
  const mountedRef = useRef(false);

  const [openAtivasByLoan, setOpenAtivasByLoan] = useState({});

  useEffect(() => {
    axios
      .get("http://localhost:3001/clientes")
      .then((r) => setClientes(r.data || []))
      .catch(console.error);
    carregarEmprestimos();
  }, []);

  const carregarEmprestimos = () =>
    axios
      .get("http://localhost:3001/emprestimos")
      .then((r) => setEmprestimos(r.data || []))
      .catch(console.error);

  useEffect(() => {
    if (!clientes || !emprestimos) return;
    const params = new URLSearchParams(location.search);
    const clienteParam = params.get("cliente");
    if (!clienteParam) return;

    const idNum = Number(clienteParam);
    if (!idNum) return;

    if (!mountedRef.current) {
      mountedRef.current = true;
    }

    setExpandedClientes((prev) => ({ ...prev, [idNum]: true }));

    const clienteObj = (clientes || []).find((c) => Number(c.id) === idNum);
    if (clienteObj) {
      setBusca("");
      setTimeout(() => {
        const el = document.querySelector(`[data-cliente-id="${idNum}"]`);
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, clientes, emprestimos]);

  const nomeCliente = (id) => clientes.find((c) => c.id === id)?.nome || "Desconhecido";

  const loansByClient = emprestimos.reduce((acc, e) => {
    (acc[e.cliente_id] = acc[e.cliente_id] || []).push(e);
    return acc;
  }, {});

  const clientesComContagem = clientes.map((c) => ({
    ...c,
    emprestimos: loansByClient[c.id] || [],
  }));

  const termo = (busca || "").trim().toLowerCase();

  const clientesFiltrados = clientesComContagem.filter((c) => {
    if (!termo) return true;
    if ((c.nome || "").toLowerCase().includes(termo)) return true;
    const numBusca = termo.replace(/\D/g, "");
    if (numBusca && String(c.id).startsWith(numBusca)) return true;
    const loans = c.emprestimos || [];
    return loans.some((emp) => {
      const displayId = String(emp.codigo_cliente || emp.emprestimo_num || emp.id).toLowerCase();
      return (
        displayId.includes(termo) ||
        String(emp.observacao || "").toLowerCase().includes(termo)
      );
    });
  });

  const getLastActivityTimestamp = (cliente) => {
    let maxTs = 0;
    const tryFields = (obj, fields) => {
      fields.forEach((f) => {
        if (obj && obj[f]) {
          const dt = toDateObj(obj[f]);
          if (dt) maxTs = Math.max(maxTs, dt.getTime());
        }
      });
    };
    tryFields(cliente, ["updatedAt", "updated_at", "criadoEm", "criado_em", "createdAt", "created_at"]);
    (cliente.emprestimos || []).forEach((emp) =>
      tryFields(emp, [
        "updatedAt",
        "updated_at",
        "criadoEm",
        "criado_em",
        "data",
        "data_pagamento",
        "createdAt",
        "created_at",
        "ultimo_pagamento",
        "ultimo_movimento",
      ])
    );
    if (cliente.lastActivityTimestamp && Number(cliente.lastActivityTimestamp)) {
      maxTs = Math.max(maxTs, Number(cliente.lastActivityTimestamp));
    }
    return maxTs;
  };

  const clienteMatchScore = (cliente) => {
    if (!termo) return 0;
    let score = 0;
    const nome = (cliente.nome || "").toLowerCase();
    if (nome.startsWith(termo)) score += 50;
    else if (nome.includes(termo)) score += 30;

    if (String(cliente.id).startsWith(termo)) score += 40;

    const loans = cliente.emprestimos || [];
    for (const emp of loans) {
      const displayId = String(emp.codigo_cliente || emp.emprestimo_num || emp.id).toLowerCase();
      const obs = String(emp.observacao || "").toLowerCase();
      if (displayId.startsWith(termo)) {
        score += 100;
        break;
      }
      if (displayId.includes(termo)) score += 20;
      if (obs.includes(termo)) score += 10;
    }
    return score;
  };

  const clientesOrdenados = (() => {
    if (!termo) {
      return [...clientesFiltrados].sort(
        (a, b) => getLastActivityTimestamp(b) - getLastActivityTimestamp(a)
      );
    }
    return [...clientesFiltrados].sort((a, b) => {
      const sa = clienteMatchScore(a);
      const sb = clienteMatchScore(b);
      if (sb !== sa) return sb - sa;
      const na = (a.nome || "").toLowerCase();
      const nb = (b.nome || "").toLowerCase();
      return na.localeCompare(nb);
    });
  })();

  const getProximoVencimento = (emp) => {
    try {
      const p = (emp.parcelasDetalhes || []).find((x) => !x.pago);
      return p ? formatarData(p.vencimento) : "-";
    } catch {
      return "-";
    }
  };

  const atualizarVencimento = async (parcelaId, novaISO) => {
    if (!parcelaId || !novaISO) {
      notify.warn("Data invalida.");
      return;
    }
    try {
      await axios.put(`http://localhost:3001/parcelas/${parcelaId}`, { vencimento: novaISO });
      carregarEmprestimos();
      notify.success("Vencimento atualizado com sucesso.");
    } catch (err) {
      console.error(err);
      notify.error("Erro ao atualizar vencimento.");
    }
  };

  const registrarPagamento = async (emprestimo_id) => {
    const valor = parseFloat(novoPagamento.valor);
    if (!valor || valor <= 0) {
      notify.warn("Informe um valor valido.");
      return;
    }
    try {
      await axios.post("http://localhost:3001/pagamentos", {
        emprestimo_id,
        valor,
        tipoPagamento: novoPagamento.tipo,
      });
      notify.success("Pagamento registrado com sucesso.");
      setNovoPagamento({ valor: "", tipo: "adiantamento" });
      await carregarEmprestimos();
    } catch (err) {
      console.error(err);
      const msg =
        err.response?.data?.erro ||
        err.response?.data?.error ||
        err.message ||
        "Erro ao registrar pagamento.";
      notify.error(msg);
    }
  };

  const excluirEmprestimo = async (emprestimoId) => {
    try {
      const confirmar = await notify.confirm(
        "Deseja realmente excluir este emprestimo e todos os dados relacionados (parcelas e pagamentos)? Esta acao e irreversivel."
      );
      if (!confirmar) return;

      const senha = await notify.prompt(
        "Informe a senha para excluir o emprestimo (deixe em branco para cancelar):",
        {
          type: "password",
          okText: "Excluir",
          cancelText: "Cancelar",
        }
      );
      if (senha === null || senha === "") {
        return;
      }

      await axios.delete(`http://localhost:3001/emprestimos/${emprestimoId}`, {
        data: { password: senha },
      });

      notify.success("Emprestimo excluido com sucesso.");
      carregarEmprestimos();
    } catch (err) {
      console.error("Erro ao excluir emprestimo:", err);
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.erro ||
        err?.response?.data ||
        err.message ||
        "Erro desconhecido";
      notify.error("Erro ao excluir emprestimo: " + msg);
    }
  };

  const guessHasRenegLocal = (emp) => {
    const pars = emp?.parcelasDetalhes || [];
    return pars.some((p) => p?.renegociada || Number(p?.numero) === -1);
  };

  const toggleCliente = (id) =>
    setExpandedClientes((p) => ({ ...p, [id]: !p[id] }));

  const loanMatchScore = (loan) => {
    if (!termo) return 0;
    const displayId = String(loan.codigo_cliente || loan.emprestimo_num || loan.id).toLowerCase();
    if (displayId.startsWith(termo)) return 100;
    if (displayId.includes(termo)) return 30;
    if (String(loan.observacao || "").toLowerCase().includes(termo)) return 10;
    return 0;
  };

  return (
    <div
      style={{
        padding: 20,
        maxWidth: 1000,
        margin: "auto",
        fontFamily: "sans-serif",
        color: "var(--text-main)",
      }}
    >
      <h2
        style={{
          textAlign: "center",
          marginBottom: 10,
          color: "var(--text-main)",
        }}
      >
        💰 Lista de Empréstimos
      </h2>

      <input
        type="text"
        placeholder="🔍 Buscar por nome ou ID"
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        style={{
          width: "100%",
          padding: 10,
          fontSize: 16,
          marginBottom: 20,
          borderRadius: 6,
          border: "1px solid var(--border-soft)",
          background: "var(--bg-card)",
          color: "var(--text-main)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
          boxSizing: "border-box",
        }}
      />

      <ul style={{ listStyle: "none", padding: 0 }}>
        {clientesOrdenados.map((cliente) => {
          const loansOrig = cliente.emprestimos || [];
          const loans = termo
            ? [...loansOrig].sort((a, b) => loanMatchScore(b) - loanMatchScore(a))
            : loansOrig;
          const matchesCliente =
            termo &&
            ((cliente.nome || "").toLowerCase().includes(termo) ||
              String(cliente.id).startsWith(termo));
          const matchesLoan = termo && loans.some((l) => loanMatchScore(l) > 0);
          const expanded =
            !!expandedClientes[cliente.id] ||
            (termo && (matchesCliente || matchesLoan));
          return (
            <li
              key={cliente.id}
              data-cliente-id={cliente.id}
              onClick={() => toggleCliente(cliente.id)}
              style={{
                background: "var(--bg-card)",
                color: "var(--text-main)",
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: 12,
                marginBottom: 10,
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <strong style={{ marginRight: 8 }}>👤 {cliente.nome}</strong>
                  <span
                    style={{ color: "var(--text-muted)", fontSize: "0.95em" }}
                  >
                    ({loans.length} empréstimo
                    {loans.length !== 1 ? "s" : ""})
                  </span>
                </div>
                <div
                  style={{
                    fontSize: "0.9em",
                    color: "var(--text-muted)",
                  }}
                >
                  ID {cliente.id}
                </div>
              </div>

              {expanded && (
                <div
                  style={{ marginTop: 12, paddingLeft: 6 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {loans.length === 0 ? (
                    <div style={{ color: "var(--text-muted)", padding: 8 }}>
                      Nenhum empréstimo para este cliente.
                    </div>
                  ) : (
                    loans.map((emp) => {
                      const displayId =
                        emp.codigo_cliente || emp.emprestimo_num || emp.id;

                      const hasRenegLocal = guessHasRenegLocal(emp);
                      const showRenegButton = hasRenegLocal;

                      const valorEmprestado =
                        emp.valor_emprestado ??
                        emp.valor_original ??
                        emp.valor_inicial ??
                        emp.valor;

                      const capitalRestante =
                        emp.capital_restante ??
                        emp.valor_atual ??
                        emp.valor;

                      return (
                        <div
                          key={emp.id}
                          style={{
                            marginBottom: 12,
                            padding: 10,
                            borderRadius: 6,
                            border: "1px solid #eee",
                            background: "var(--bg-card)",
                            color: "var(--text-main)",
                          }}
                        >
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr",
                              gap: 8,
                            }}
                          >
                            <div>
                              <strong>ID:</strong> {displayId}
                            </div>
                            <div>
                              <strong>Cliente:</strong>{" "}
                              {nomeCliente(emp.cliente_id)}
                            </div>

                            <div>
                              <strong>Modalidade:</strong>{" "}
                              {emp.modalidade === "aberto"
                                ? "Em aberto"
                                : "Parcelado"}
                            </div>
                            <div>
                              <strong>Valor emprestado:</strong>{" "}
                              {formatarMoeda(valorEmprestado)}
                            </div>

                            <div>
                              <strong>Total pago:</strong>{" "}
                              {formatarMoeda(emp.total_pago || 0)}
                            </div>
                            <div>
                              <strong>Capital restante:</strong>{" "}
                              {formatarMoeda(capitalRestante || 0)}
                            </div>

                            <div>
                              <strong>Data de início do empréstimo:</strong>{" "}
                              {formatarData(emp.data)}
                            </div>
                            <div>
                              <strong>Tempo passado:</strong>{" "}
                              {calcularTempoPassado(emp.data)}
                            </div>

                            {emp.observacao ? (
                              <div>
                                <strong>Observação:</strong>{" "}
                                {emp.observacao}
                              </div>
                            ) : (
                              <div />
                            )}

                            <div>
                              <strong>Próximo vencimento:</strong>{" "}
                              {getProximoVencimento(emp)}
                            </div>
                          </div>

                          <div
                            style={{
                              marginTop: 10,
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                              alignItems: "center",
                            }}
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenAtivasByLoan((prev) => ({
                                  ...prev,
                                  [emp.id]: !prev[emp.id],
                                }));
                              }}
                              style={{
                                padding: "6px 10px",
                                background: "#007bff",
                                color: "#fff",
                                border: "none",
                                borderRadius: 4,
                                cursor: "pointer",
                              }}
                            >
                              {openAtivasByLoan[emp.id]
                                ? "🔽 Ocultar parcelas"
                                : "📄 Mostrar parcelas"}
                            </button>

                            {showRenegButton && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(
                                    `/historico?emprestimoId=${emp.id}`
                                  );
                                }}
                                title="Ver renegociação completa"
                                style={{
                                  padding: "6px 10px",
                                  background: "#6f42c1",
                                  color: "#fff",
                                  border: "none",
                                  borderRadius: 4,
                                  cursor: "pointer",
                                }}
                              >
                                📘 Ver renegociação
                              </button>
                            )}

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditarId(emp.id);
                              }}
                              style={{
                                padding: "6px 10px",
                                background: "#ffc107",
                                color: "#000",
                                border: "none",
                                borderRadius: 4,
                              }}
                            >
                              ✏️ Editar
                            </button>

                            <div style={{ marginLeft: "auto" }}>
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await excluirEmprestimo(emp.id);
                                }}
                                title="Excluir empréstimo"
                                style={{
                                  padding: "6px 10px",
                                  background: "#dc3545",
                                  color: "#fff",
                                  border: "none",
                                  borderRadius: 4,
                                  cursor: "pointer",
                                }}
                              >
                                🗑️ Excluir
                              </button>
                            </div>
                          </div>

                          {openAtivasByLoan[emp.id] && (
                            <div
                              style={{
                                marginTop: 12,
                                background: "var(--bg-card)",
                                color: "var(--text-main)",
                                borderRadius: 6,
                                padding: 10,
                                border: "1px solid #eee",
                              }}
                            >
                              <ParcelaList
                                parcelas={emp.parcelasDetalhes}
                                showAntigas={false}
                                onAtualizarVencimento={atualizarVencimento}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {editarId && (
        <EditarEmprestimo
          emprestimoId={editarId}
          onClose={() => {
            setEditarId(null);
            carregarEmprestimos();
          }}
        />
      )}
    </div>
  );
}