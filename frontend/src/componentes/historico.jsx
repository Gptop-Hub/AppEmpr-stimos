import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useLocation, useNavigate } from "react-router-dom";
import ParcelaList from "./Emprestimos/ParcelaList";
import RenegociacaoInlinePanel from "./Emprestimos/RenegociacaoInlinePanel.jsx";
import {
  formatarMoeda,
  formatarData,
  toDateObj,
  calcularTempoPassado,
  isParcelQuitadaMensagem,
  extractQuitAmountFromExplicacao,
} from "./Emprestimos/helpers.jsx";
import {
  isClienteMalPagador,
  isEmprestimoClienteMalPagador,
} from "../utils/clientRisk";
import ClienteIdentity from "./common/ClienteIdentity.jsx";
import useClientesCatalogo from "./common/useClientesCatalogo.js";

export default function Historico() {
  const location = useLocation();
  const navigate = useNavigate();
  const { resolverCliente } = useClientesCatalogo();

  const [emprestimo, setEmprestimo] = useState(null);
  const [clienteNome, setClienteNome] = useState("");
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");
  const [canceladasAbertas, setCanceladasAbertas] = useState({});

  const [quitadosPorCliente, setQuitadosPorCliente] = useState([]);
  const [loadingQuitados, setLoadingQuitados] = useState(false);
  const [erroQuitados, setErroQuitados] = useState("");
  const [quitadosClientesAbertos, setQuitadosClientesAbertos] = useState({});
  const [parcelasQuitadasAbertas, setParcelasQuitadasAbertas] = useState({});
  const [renegQuitadasAbertas, setRenegQuitadasAbertas] = useState({});
  const [buscaQuitados, setBuscaQuitados] = useState("");
  const [buscaQuitadosId, setBuscaQuitadosId] = useState("");
  const [apenasMalPagadoresQuitados, setApenasMalPagadoresQuitados] =
    useState(false);
  const [filtroDiretoClienteId, setFiltroDiretoClienteId] = useState("");

  const clienteIdFocoQuitados = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return String(params.get("clienteId") || "").trim();
  }, [location.search]);

  const emprestimoId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("emprestimoId") || "";
  }, [location.search]);

  useEffect(() => {
    if (!clienteIdFocoQuitados) {
      setFiltroDiretoClienteId("");
      return;
    }
    setFiltroDiretoClienteId(clienteIdFocoQuitados);
    setBuscaQuitados("");
    setQuitadosClientesAbertos((prev) => ({
      ...prev,
      [clienteIdFocoQuitados]: true,
    }));
  }, [clienteIdFocoQuitados]);

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

  const normalizarValor = (valor) => {
    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
  };

  const getCapitalRestanteEmprestimo = (emp) => {
    if (!emp) return null;
    const raw = emp.capital_restante ?? emp.valor_atual ?? emp.valor;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(2));
  };

  const isEmprestimoQuitadoPorCapital = (emp) => {
    const capital = getCapitalRestanteEmprestimo(emp);
    if (capital == null) return false;
    return capital <= 0.009;
  };

  const formatarCPF = (cpf) => {
    if (!cpf) return "";
    const digits = String(cpf).replace(/\D/g, "");
    if (digits.length !== 11) return String(cpf);
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}-${digits.slice(9)}`;
  };

  const getTelefonesCliente = (cliente) => {
    const valores = [];
    const seen = new Set();
    const push = (valor) => {
      const t = String(valor || "").trim();
      if (!t) return;
      const norm = t.replace(/\D/g, "") || t;
      if (seen.has(norm)) return;
      seen.add(norm);
      valores.push(t);
    };

    push(cliente && cliente.telefone);
    if (Array.isArray(cliente && cliente.telefones_extras)) {
      cliente.telefones_extras.forEach(push);
    }

    return valores;
  };

  const guessHasRenegLocal = (emp) => {
    const historicosLocais = emp?.renegociacoesHistorico;
    if (Array.isArray(historicosLocais) && historicosLocais.length > 0) return true;
    const pars = emp?.parcelasDetalhes || [];
    return pars.some((p) => p?.renegociada || Number(p?.numero) === -1);
  };

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

  const getDisplayId = (emp) => {
    if (!emp) return "-";
    return (
      emp.codigo_cliente ||
      emp.emprestimo_num ||
      `${emp.cliente_id ?? "?"}-${emp.id ?? "?"}`
    );
  };

  const getProximoVencimento = (emp) => {
    const parcelas = Array.isArray(emp?.parcelasDetalhes) ? emp.parcelasDetalhes : [];
    const pendentes = parcelas.filter((p) => {
      if (!p?.vencimento) return false;
      if (Number(p?.numero) === -1) return false;
      const pago = p.pago === 1 || p.pago === true || normalizarValor(p.valor_pago) > 0;
      return !pago;
    });
    if (pendentes.length === 0) return null;
    const ordenadas = [...pendentes].sort((a, b) => {
      const da = toDateObj(a.vencimento)?.getTime() || 0;
      const db = toDateObj(b.vencimento)?.getTime() || 0;
      return da - db;
    });
    return ordenadas[0]?.vencimento || null;
  };

  const getTimestampSeguro = (valor) => {
    if (!valor) return 0;
    const dt = toDateObj(valor);
    if (dt) return dt.getTime();
    const ts = Date.parse(String(valor));
    return Number.isFinite(ts) ? ts : 0;
  };

  const getQuitacaoMaisRecenteTs = (emp) => {
    let maxTs = 0;

    const pagamentos = Array.isArray(emp?.pagamentos) ? emp.pagamentos : [];
    pagamentos.forEach((pg) => {
      const tsPg = getTimestampSeguro(pg?.data || pg?.created_at || pg?.updated_at);
      if (tsPg > maxTs) maxTs = tsPg;
    });

    const parcelas = Array.isArray(emp?.parcelasDetalhes) ? emp.parcelasDetalhes : [];
    parcelas.forEach((p) => {
      const pago = p.pago === 1 || p.pago === true || normalizarValor(p?.valor_pago) > 0;
      if (!pago) return;
      const tsParcela = getTimestampSeguro(p?.data_pagamento);
      if (tsParcela > maxTs) maxTs = tsParcela;
    });

    if (maxTs > 0) return maxTs;

    return Math.max(
      getTimestampSeguro(emp?.last_activity_at),
      getTimestampSeguro(emp?.updated_at),
      getTimestampSeguro(emp?.updatedAt),
      getTimestampSeguro(emp?.data)
    );
  };

  useEffect(() => {
    let cancelado = false;

    const carregarQuitados = async () => {
      setLoadingQuitados(true);
      setErroQuitados("");

      try {
        const [resClientes, resEmprestimos] = await Promise.all([
          axios.get("/clientes"),
          axios.get("/emprestimos"),
        ]);

        if (cancelado) return;

        const clientes = Array.isArray(resClientes?.data) ? resClientes.data : [];
        const emprestimos = Array.isArray(resEmprestimos?.data)
          ? resEmprestimos.data
          : [];

        const clientesPorId = new Map(
          clientes.map((c) => [String(c?.id ?? ""), c])
        );

        const grupos = new Map();

        (emprestimos || [])
          .filter((emp) => isEmprestimoQuitadoPorCapital(emp))
          .forEach((emp) => {
            const clienteId = String(emp?.cliente_id ?? "");
            if (!clienteId) return;

            const cliente = clientesPorId.get(clienteId) || null;
            const clienteMalPagador =
              isClienteMalPagador(cliente) ||
              isEmprestimoClienteMalPagador(emp);
            if (!grupos.has(clienteId)) {
              grupos.set(clienteId, {
                clienteId,
                cliente,
                mal_pagador: clienteMalPagador ? 1 : 0,
                nome:
                  cliente?.nome ||
                  emp?.cliente_nome ||
                  `Cliente #${emp?.cliente_id ?? "?"}`,
                cpf: cliente?.cpf || "",
                telefone: getTelefonesCliente(cliente).join(" | "),
                emprestimos: [],
              });
            }

            if (clienteMalPagador) {
              grupos.get(clienteId).mal_pagador = 1;
            }
            grupos.get(clienteId).emprestimos.push({
              ...emp,
              cliente_mal_pagador: clienteMalPagador ? 1 : emp?.cliente_mal_pagador,
              quitacaoMaisRecenteTs: getQuitacaoMaisRecenteTs(emp),
            });
          });

        const lista = Array.from(grupos.values())
          .map((grupo) => {
            const emprestimosOrdenados = [...grupo.emprestimos].sort((a, b) => {
              const diffQuitacao =
                normalizarValor(b?.quitacaoMaisRecenteTs) -
                normalizarValor(a?.quitacaoMaisRecenteTs);
              if (diffQuitacao !== 0) return diffQuitacao;
              const da = toDateObj(a?.data)?.getTime() || 0;
              const db = toDateObj(b?.data)?.getTime() || 0;
              return db - da;
            });

            const quitacaoMaisRecenteTs = emprestimosOrdenados.reduce((max, emp) => {
              const ts = normalizarValor(emp?.quitacaoMaisRecenteTs);
              return ts > max ? ts : max;
            }, 0);

            return {
              ...grupo,
              quitacaoMaisRecenteTs,
              emprestimos: emprestimosOrdenados,
            };
          })
          .sort((a, b) => {
            const diffQuitacao =
              normalizarValor(b?.quitacaoMaisRecenteTs) -
              normalizarValor(a?.quitacaoMaisRecenteTs);
            if (diffQuitacao !== 0) return diffQuitacao;
            return String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR", {
              sensitivity: "base",
            });
          });

        setQuitadosPorCliente(lista);
      } catch (e) {
        if (cancelado) return;
        const msg =
          e.response?.data?.erro ||
          e.response?.data?.error ||
          e.message ||
          "Erro ao carregar empréstimos quitados.";
        setErroQuitados(msg);
        setQuitadosPorCliente([]);
      } finally {
        if (!cancelado) setLoadingQuitados(false);
      }
    };

    carregarQuitados();

    return () => {
      cancelado = true;
    };
  }, []);

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

  const displayId = useMemo(() => {
    if (!emprestimo) return "-";
    return (
      emprestimo.codigo_cliente ||
      emprestimo.emprestimo_num ||
      `${emprestimo.cliente_id ?? "?"}-${emprestimo.id ?? "?"}`
    );
  }, [emprestimo]);

  const emprestimoDetalheMalPagador = isEmprestimoClienteMalPagador(emprestimo);

  const tempoPassado = useMemo(() => {
    if (!emprestimo) return "-";
    return calcularTempoPassado(emprestimo.data);
  }, [emprestimo]);

  const handleVoltar = () => navigate("/emprestimos");

  const normalizeForSearch = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const quitadosFiltrados = useMemo(() => {
    const base = apenasMalPagadoresQuitados
      ? (quitadosPorCliente || []).filter(isClienteMalPagador)
      : quitadosPorCliente;

    if (filtroDiretoClienteId) {
      return (base || []).filter(
        (grupo) => String(grupo?.clienteId ?? "") === filtroDiretoClienteId
      );
    }

    const filtradosPorId = buscaQuitadosId
      ? (base || []).filter((grupo) =>
          String(grupo?.clienteId ?? "").startsWith(buscaQuitadosId)
        )
      : base;

    const termoRaw = String(buscaQuitados || "").trim();
    if (!termoRaw) return filtradosPorId;

    const termo = normalizeForSearch(termoRaw);

    return (filtradosPorId || []).filter((grupo) => {
      const nomeCliente = normalizeForSearch(grupo?.nome);
      return nomeCliente.startsWith(termo);
    });
  }, [apenasMalPagadoresQuitados, buscaQuitados, buscaQuitadosId, filtroDiretoClienteId, quitadosPorCliente]);

  const renderSecaoQuitados = () => {
    return (
      <section
        style={{
          marginBottom: 20,
          padding: 16,
          borderRadius: 10,
          border: "1px solid var(--border-soft)",
          background: "var(--bg-card)",
          color: "var(--text-main)",
        }}
      >
        <h2 style={{ margin: 0 }}>Empréstimos quitados</h2>
        <p style={{ margin: "8px 0 0", color: "var(--text-muted)" }}>
          Clientes com empréstimos totalmente quitados (capital restante igual a
          zero).
        </p>
        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="text"
            inputMode="numeric"
            value={buscaQuitadosId}
            onChange={(e) => {
              setBuscaQuitadosId(e.target.value.replace(/\D/g, ""));
              if (filtroDiretoClienteId) setFiltroDiretoClienteId("");
            }}
            placeholder="ID"
            aria-label="Buscar cliente por ID"
            style={{
              width: 82,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-soft)",
              background: "var(--bg-app)",
              color: "var(--text-main)",
              outline: "none",
            }}
          />
          <input
            type="text"
            value={buscaQuitados}
            onChange={(e) => {
              setBuscaQuitados(e.target.value);
              if (filtroDiretoClienteId) setFiltroDiretoClienteId("");
            }}
            placeholder="Buscar por nome do cliente"
            style={{
              flex: 1,
              minWidth: 220,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-soft)",
              background: "var(--bg-app)",
              color: "var(--text-main)",
              outline: "none",
            }}
          />
        </div>
        <div>
          <label
            style={{
              marginTop: 10,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "var(--text-main)",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            <input
              type="checkbox"
              checked={apenasMalPagadoresQuitados}
              onChange={(e) =>
                setApenasMalPagadoresQuitados(e.target.checked)
              }
            />
            Apenas mal pagadores
          </label>
        </div>

        {loadingQuitados ? (
          <div style={{ marginTop: 12, color: "var(--text-muted)" }}>
            Carregando empréstimos quitados...
          </div>
        ) : null}

        {!loadingQuitados && erroQuitados ? (
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
            {erroQuitados}
          </div>
        ) : null}

        {!loadingQuitados && !erroQuitados && quitadosFiltrados.length === 0 ? (
          <div style={{ marginTop: 12, color: "var(--text-muted)" }}>
            Nenhum empréstimo quitado encontrado para essa busca.
          </div>
        ) : null}

        {!loadingQuitados && !erroQuitados && quitadosFiltrados.length > 0 ? (
          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 12,
              alignItems: "start",
            }}
          >
            {quitadosFiltrados.map((grupo) => {
              const clienteAberto = !!quitadosClientesAbertos[grupo.clienteId];
              const grupoMalPagador = isClienteMalPagador(grupo);
              return (
                <div
                  key={`quitado-cliente-${grupo.clienteId}`}
                  className={`cliente-card${
                    grupoMalPagador ? " client-card--risk" : ""
                  }`}
                  style={{
                    cursor: "default",
                    borderRadius: 10,
                    background: "rgba(148,163,184,0.08)",
                    padding: 12,
                    gridColumn: clienteAberto ? "1 / -1" : undefined,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "grid", gap: 4 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <ClienteIdentity
                          cliente={grupo.cliente}
                          clienteId={grupo.clienteId}
                          nome={grupo.nome}
                          avatarSize={44}
                          nameClassName="cliente-identity__name--strong"
                        />
                        {grupoMalPagador ? (
                          <span className="badge-risk">Mal pagador</span>
                        ) : null}
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                        ID: {grupo.clienteId}
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                        Empréstimos quitados: {grupo.emprestimos.length}
                      </div>
                      {grupo.cpf ? (
                        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                          CPF: {formatarCPF(grupo.cpf)}
                        </div>
                      ) : null}
                      {grupo.telefone ? (
                        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                          Telefone: {grupo.telefone}
                        </div>
                      ) : null}
                      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                        Último quitado:{" "}
                        {grupo.quitacaoMaisRecenteTs
                          ? formatarData(new Date(grupo.quitacaoMaisRecenteTs))
                          : "-"}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setQuitadosClientesAbertos((prev) => ({
                          ...prev,
                          [grupo.clienteId]: !prev[grupo.clienteId],
                        }))
                      }
                      style={{
                        padding: "8px 12px",
                        borderRadius: 8,
                        border: "1px solid var(--border-soft)",
                        background: "var(--bg-card)",
                        color: "var(--text-main)",
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                    >
                      {clienteAberto
                        ? "Ocultar empréstimos quitados"
                        : "Mostrar empréstimos quitados"}
                    </button>
                  </div>

                  {clienteAberto ? (
                    <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                      {grupo.emprestimos.map((emp, empIdx) => {
                        const empId = String(emp?.id ?? "");
                        const parcelasAbertas = !!parcelasQuitadasAbertas[empId];
                        const hasReneg = guessHasRenegLocal(emp);
                        const proxVenc = getProximoVencimento(emp);
                        const totalPagoEmp =
                          emp?.total_pago ??
                          (Array.isArray(emp?.parcelasDetalhes)
                            ? emp.parcelasDetalhes.reduce((sum, p) => {
                                return sum + normalizarValor(p?.valor_pago);
                              }, 0)
                            : 0);

                        const capitalEmp = getCapitalRestanteEmprestimo(emp);
                        const emprestimoMalPagador =
                          grupoMalPagador || isEmprestimoClienteMalPagador(emp);

                        return (
                          <div
                            key={`quitado-emp-${empId || empIdx}`}
                            className={`loan-entry${
                              emprestimoMalPagador ? " loan-entry--risk" : ""
                            }`}
                            style={{
                              borderRadius: 10,
                              border: emprestimoMalPagador
                                ? "1px solid var(--risk-border)"
                                : "1px solid var(--border-soft)",
                              background: emprestimoMalPagador
                                ? "var(--risk-bg-soft)"
                                : "var(--bg-app)",
                              padding: 14,
                            }}
                          >
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns:
                                  "repeat(auto-fit,minmax(210px,1fr))",
                                gap: 10,
                                color: "var(--text-main)",
                              }}
                            >
                              <div>
                                <ClienteIdentity
                                  cliente={grupo.cliente}
                                  clienteId={grupo.clienteId}
                                  nome={grupo.nome}
                                  avatarSize={30}
                                  secondary="Cliente"
                                />
                                {emprestimoMalPagador ? (
                                  <>
                                    {" "}
                                    <span className="badge-risk badge-risk--inline">
                                      Cliente mal pagador
                                    </span>
                                  </>
                                ) : null}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  ID:
                                </strong>{" "}
                                {getDisplayId(emp)}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Valor emprestado:
                                </strong>{" "}
                                {formatarMoeda(
                                  emp?.valor_emprestado ??
                                    emp?.valor_original ??
                                    emp?.valor_inicial ??
                                    emp?.valor
                                )}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Modalidade:
                                </strong>{" "}
                                {emp?.modalidade === "aberto"
                                  ? "Em aberto"
                                  : "Parcelado"}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Data de início:
                                </strong>{" "}
                                {formatarData(emp?.data)}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Capital restante:
                                </strong>{" "}
                                {formatarMoeda(capitalEmp ?? 0)}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Total pago:
                                </strong>{" "}
                                {formatarMoeda(totalPagoEmp || 0)}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Tempo passado:
                                </strong>{" "}
                                {calcularTempoPassado(emp?.data)}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Próximo vencimento:
                                </strong>{" "}
                                {proxVenc ? formatarData(proxVenc) : "-"}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Parcelas:
                                </strong>{" "}
                                {Array.isArray(emp?.parcelasDetalhes)
                                  ? emp.parcelasDetalhes.length
                                  : 0}
                              </div>
                              <div>
                                <strong style={{ color: "var(--text-muted)" }}>
                                  Quitado em:
                                </strong>{" "}
                                {emp?.quitacaoMaisRecenteTs
                                  ? formatarData(new Date(emp.quitacaoMaisRecenteTs))
                                  : "-"}
                              </div>
                            </div>

                            <div
                              style={{
                                marginTop: 12,
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setParcelasQuitadasAbertas((prev) => ({
                                    ...prev,
                                    [empId]: !prev[empId],
                                  }))
                                }
                                style={{
                                  padding: "8px 12px",
                                  borderRadius: 8,
                                  border: "1px solid var(--border-soft)",
                                  background: "var(--bg-card)",
                                  color: "var(--text-main)",
                                  cursor: "pointer",
                                  fontWeight: 600,
                                }}
                              >
                                {parcelasAbertas ? "Ocultar parcelas" : "Mostrar parcelas"}
                              </button>

                              {hasReneg ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setRenegQuitadasAbertas((prev) => ({
                                      ...prev,
                                      [empId]: !prev[empId],
                                    }))
                                  }
                                  style={{
                                    padding: "8px 12px",
                                    borderRadius: 8,
                                    border: "1px solid rgba(59,130,246,0.5)",
                                    background: "rgba(59,130,246,0.12)",
                                    color: "#1d4ed8",
                                    cursor: "pointer",
                                    fontWeight: 600,
                                  }}
                                >
                                  {renegQuitadasAbertas[empId]
                                    ? "Ocultar renegociação"
                                    : "Ver renegociação"}
                                </button>
                              ) : null}
                            </div>

                            {parcelasAbertas ? (
                              <div style={{ marginTop: 12 }}>
                                <ParcelaList
                                  parcelas={
                                    Array.isArray(emp?.parcelasDetalhes)
                                      ? emp.parcelasDetalhes
                                      : []
                                  }
                                  showAntigas={false}
                                  somenteLeitura={true}
                                />
                              </div>
                            ) : null}

                            {hasReneg && renegQuitadasAbertas[empId] ? (
                              <RenegociacaoInlinePanel emprestimoId={empId} />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  };

  if (!emprestimoId) {
    return (
      <div style={{ padding: 20 }}>
        {renderSecaoQuitados()}
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
    return (
      <div style={{ padding: 20 }}>
        {renderSecaoQuitados()}
        <div style={{ color: "var(--text-muted)" }}>Carregando histórico...</div>
      </div>
    );
  }

  if (erro) {
    return (
      <div style={{ padding: 20 }}>
        {renderSecaoQuitados()}
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
        {renderSecaoQuitados()}
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
      {renderSecaoQuitados()}

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
            <ClienteIdentity
              cliente={resolverCliente(
                emprestimo.cliente_id,
                clienteNome || `Cliente #${emprestimo.cliente_id}`
              )}
              avatarSize={36}
              secondary="Cliente"
            />
            {emprestimoDetalheMalPagador ? (
              <>
                {" "}
                <span className="badge-risk badge-risk--inline">
                  Cliente mal pagador
                </span>
              </>
            ) : null}
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
            const ativas = parcelasDaReneg.filter((p) => !ehParcelaCancelada(p));

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
                  <h3 style={{ margin: 0 }}>Renegociação #{reneg?.versao ?? "-"}</h3>
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
                    <div style={{ color: "var(--text-main)" }}>
                      Capital restante:{" "}
                      <strong style={{ color: "var(--text-muted)" }}>
                        {formatarMoeda(capitalVisual)}
                      </strong>
                    </div>
                  ) : null}
                </div>

                <div style={{ marginTop: 14 }}>
                  <ParcelaList parcelas={ativas} showAntigas={true} />
                </div>

                {canceladas.length > 0 ? (
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
                        <ParcelaList parcelas={canceladas} showAntigas={true} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
