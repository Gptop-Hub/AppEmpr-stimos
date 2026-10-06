import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { autorizarProtecao } from '../security/seguranca.js';
import notify from "../ui/notify";
import { calcularPreviewParcelas, renderLinhaJuros } from "./Emprestimos/helpers.jsx";
import StepperInput from "./common/StepperInput.jsx";
import ClienteIdentity from "./common/ClienteIdentity.jsx";

const normalizeSearchText = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const getMatchScore = (query, nomeCliente) => {
  const q = normalizeSearchText(query);
  const nome = normalizeSearchText(nomeCliente);

  if (!q) return 3;
  if (!nome) return -1;
  if (nome.startsWith(q)) return 0;
  if (nome.split(/\s+/).some((parte) => parte.startsWith(q))) return 1;
  return -1;
};

const parseLocalISO = (value) => {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

const isISODate = (value) => {
  const d = parseLocalISO(value);
  return !!(d && !Number.isNaN(d.getTime()));
};

const toISODateOnly = (value) => {
  if (!value) return "";
  const txt = String(value);
  const first = txt.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(first)) return first;
  const dt = new Date(txt);
  if (Number.isNaN(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const formatarMoedaInput = (valorBruto) => {
  const apenasDigitos = String(valorBruto || "").replace(/\D/g, "");
  const base = (parseInt(apenasDigitos || "0", 10) / 100).toFixed(2);
  return `R$ ${base.replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
};

const desformatarMoedaInput = (valorFormatado) =>
  parseFloat(String(valorFormatado || "").replace(/\D/g, "")) / 100 || 0;

const formatarMoedaNumero = (num) =>
  Number(num || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

function inferirPrimeiroVencimento(emprestimo, dataInicio) {
  if (isISODate(emprestimo?.data_pagamento)) {
    return toISODateOnly(emprestimo.data_pagamento);
  }

  const parcelasDetalhes = Array.isArray(emprestimo?.parcelasDetalhes)
    ? [...emprestimo.parcelasDetalhes]
    : [];

  const comVencimento = parcelasDetalhes
    .filter((p) => isISODate(toISODateOnly(p?.vencimento)))
    .sort((a, b) => {
      const ad = parseLocalISO(toISODateOnly(a?.vencimento));
      const bd = parseLocalISO(toISODateOnly(b?.vencimento));
      return ad.getTime() - bd.getTime();
    });

  if (comVencimento.length > 0) {
    return toISODateOnly(comVencimento[0].vencimento);
  }

  const dia = Number(emprestimo?.dia_pagamento || 0);
  const dataInicioRef = parseLocalISO(dataInicio);
  if (!dataInicioRef || !Number.isFinite(dia) || dia < 1 || dia > 31) return "";

  const y = dataInicioRef.getFullYear();
  const m = dataInicioRef.getMonth();
  const d = Math.min(
    dia,
    new Date(y, m + 1, 0).getDate()
  );
  const dataBase = new Date(y, m, d);

  if (dataBase.getTime() < dataInicioRef.getTime()) {
    const proximoMes = new Date(y, m + 1, 1);
    const d2 = Math.min(
      dia,
      new Date(proximoMes.getFullYear(), proximoMes.getMonth() + 1, 0).getDate()
    );
    const dt2 = new Date(proximoMes.getFullYear(), proximoMes.getMonth(), d2);
    return toISODateOnly(dt2);
  }

  return toISODateOnly(dataBase);
}

function resolverDiaPagamento({ dataPagamento, dataInicio }) {
  if (isISODate(dataPagamento)) {
    return parseLocalISO(dataPagamento).getDate();
  }
  if (isISODate(dataInicio)) {
    return parseLocalISO(dataInicio).getDate();
  }
  return 15;
}

export default function EditarEmprestimo({ emprestimoId, onClose }) {
  const [clientes, setClientes] = useState([]);
  const [clienteId, setClienteId] = useState("");
  const [buscaCliente, setBuscaCliente] = useState("");
  const [buscaClienteId, setBuscaClienteId] = useState("");
  const [mostrarListaClientes, setMostrarListaClientes] = useState(false);

  const modalidade = "parcelado";
  const [valor, setValor] = useState("");
  const [data, setData] = useState("");
  const [parcelas, setParcelas] = useState(5);
  const [taxaJuros, setTaxaJuros] = useState("10");
  const [dataPagamento, setDataPagamento] = useState("");
  const [observacao, setObservacao] = useState("");

  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let ativo = true;

    const carregar = async () => {
      try {
        setCarregando(true);
        const [resClientes, resEmprestimo] = await Promise.all([
          axios.get("/clientes"),
          axios.get(`/emprestimos/${emprestimoId}`),
        ]);

        if (!ativo) return;

        const listaClientes = Array.isArray(resClientes?.data) ? resClientes.data : [];
        const emprestimo = resEmprestimo?.data || {};

        setClientes(listaClientes);
        setClienteId(emprestimo.cliente_id != null ? String(emprestimo.cliente_id) : "");
        setValor(formatarMoedaInput(Number(emprestimo.valor || 0).toFixed(2)));
        setData(toISODateOnly(emprestimo.data));
        setTaxaJuros(String(emprestimo.taxa_juros ?? "0"));
        setObservacao(emprestimo.observacao || "");

        const quantidadeParcelas =
          Array.isArray(emprestimo.parcelasDetalhes) && emprestimo.parcelasDetalhes.length > 0
            ? emprestimo.parcelasDetalhes.length
            : Number(emprestimo.parcelas || 5);
        setParcelas(Number.isFinite(quantidadeParcelas) && quantidadeParcelas > 0 ? quantidadeParcelas : 5);

        const dataInicio = toISODateOnly(emprestimo.data);
        setDataPagamento(inferirPrimeiroVencimento(emprestimo, dataInicio));

        const cliente = listaClientes.find((c) => String(c.id) === String(emprestimo.cliente_id));
        setBuscaCliente(cliente ? `#${cliente.id} - ${cliente.nome}` : "");
      } catch (err) {
        console.error(err);
        notify.error("Nao foi possivel carregar os dados do emprestimo.");
      } finally {
        if (ativo) setCarregando(false);
      }
    };

    carregar();
    return () => {
      ativo = false;
    };
  }, [emprestimoId]);

  const taxaPercentual = parseFloat(String(taxaJuros || "0").replace(",", "."));

  const previewParcelas = useMemo(
    () =>
      calcularPreviewParcelas({
        total: desformatarMoedaInput(valor),
        parcelas,
        taxaPercent: Number.isFinite(taxaPercentual) ? taxaPercentual : 0,
        primeiroVencimento: dataPagamento,
      }),
    [dataPagamento, parcelas, taxaPercentual, valor]
  );

  const clientesFiltrados = useMemo(() => {
    const termoRaw = String(buscaCliente || "").trim();
    const clientesPorId = buscaClienteId
      ? clientes.filter((c) => String(c.id).startsWith(buscaClienteId))
      : clientes;
    if (!termoRaw) return [...clientesPorId].sort((a, b) => Number(a.id) - Number(b.id));

    return clientesPorId
      .map((c) => ({
        cliente: c,
        score: getMatchScore(termoRaw, c.nome),
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.cliente.nome.localeCompare(b.cliente.nome, "pt-BR");
      })
      .map((item) => item.cliente);
  }, [buscaCliente, buscaClienteId, clientes]);

  const salvarAlteracoes = async () => {
    if (salvando) return;
    const valorNumerico = desformatarMoedaInput(valor);
    const taxaNumerica = parseFloat(String(taxaJuros || "").replace(",", "."));
    const qtdParcelas = Number(parcelas || 0);

    if (!clienteId) {
      notify.warn("Selecione um cliente.");
      return;
    }
    if (!valorNumerico || valorNumerico <= 0) {
      notify.warn("Informe um valor valido.");
      return;
    }
    if (!isISODate(data)) {
      notify.warn("Informe a data de inicio do emprestimo.");
      return;
    }
    if (!Number.isFinite(taxaNumerica)) {
      notify.warn("Informe uma taxa de juros valida.");
      return;
    }

    if (modalidade === "parcelado") {
      if (!Number.isFinite(qtdParcelas) || qtdParcelas <= 0) {
        notify.warn("Informe a quantidade de parcelas.");
        return;
      }
      if (!isISODate(dataPagamento)) {
        notify.warn("Informe a data de vencimento da primeira parcela.");
        return;
      }

      const dataInicio = parseLocalISO(data);
      const primeiroVencimento = parseLocalISO(dataPagamento);
      if (
        dataInicio &&
        primeiroVencimento &&
        primeiroVencimento.getTime() < dataInicio.getTime()
      ) {
        notify.warn("A data de vencimento nao pode ser anterior a data de inicio.");
        return;
      }
    }

    try {
      setSalvando(true);
      const autorizacao = await autorizarProtecao('editar_emprestimo');
      if (!autorizacao) return;
      await axios.put(`/emprestimos/${emprestimoId}`, {
        cliente_id: Number(clienteId),
        valor: valorNumerico,
        data,
        modalidade,
        parcelas: modalidade === "parcelado" ? Number(qtdParcelas) : null,
        taxa_juros: taxaNumerica,
        observacao,
        dia_pagamento:
          modalidade === "parcelado"
            ? resolverDiaPagamento({ dataPagamento, dataInicio: data })
            : null,
        data_pagamento: modalidade === "parcelado" && isISODate(dataPagamento) ? dataPagamento : null,
      }, autorizacao);
      notify.success(`Emprestimo #${emprestimoId} atualizado.`);
      onClose();
    } catch (err) {
      console.error(err);
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.erro ||
        err?.message ||
        "Erro ao atualizar.";
      notify.error(msg);
    } finally {
      setSalvando(false);
    }
  };

  const overlayStyle = {
    position: "fixed",
    inset: 0,
    zIndex: 3000,
    background: "rgba(2, 6, 23, 0.72)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  };

  const cardStyle = {
    width: "min(720px, 100%)",
    maxHeight: "calc(100vh - 32px)",
    overflowY: "auto",
    margin: 0,
    padding: 20,
    background: "var(--bg-card)",
    color: "var(--text-main)",
    borderRadius: 10,
    border: "1px solid var(--border-soft)",
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.28)",
    fontFamily: "sans-serif",
  };

  const sectionStyle = {
    marginBottom: 18,
    paddingBottom: 14,
    borderBottom: "1px solid var(--border-soft)",
  };

  const sectionTitleStyle = {
    marginTop: 0,
    marginBottom: 10,
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-main)",
    display: "flex",
    alignItems: "center",
    gap: 6,
  };

  const labelStyle = {
    display: "block",
    marginBottom: 4,
    fontSize: 14,
    color: "var(--text-main)",
  };

  const fieldStyle = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border-soft)",
    background: "var(--bg-body)",
    color: "var(--text-main)",
    boxSizing: "border-box",
  };

  const inputWrapStyle = { marginTop: 10, position: "relative" };

  const secondaryButtonStyle = {
    padding: "10px 14px",
    borderRadius: 6,
    border: "1px solid var(--border-soft)",
    background: "var(--bg-body)",
    color: "var(--text-main)",
    fontWeight: 600,
    cursor: "pointer",
  };

  const primaryButtonStyle = {
    padding: "10px 14px",
    borderRadius: 6,
    border: "none",
    background: "#22c55e",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  };

  return (
    <div style={overlayStyle} onMouseDown={() => !salvando && onClose()}>
      <div style={cardStyle} onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ textAlign: "center", margin: "0 0 18px 0" }}>
          {"\u270F\uFE0F"} Editar Emprestimo (ID: {emprestimoId})
        </h2>

        {carregando ? (
          <div style={{ color: "var(--text-muted)" }}>Carregando dados do emprestimo...</div>
        ) : (
          <>
            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>
                <span>{"\u{1F464} Cliente"}</span>
              </div>

              <div style={inputWrapStyle}>
                <label style={labelStyle}>Cliente</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="ID"
                    aria-label="Buscar cliente por ID"
                    value={buscaClienteId}
                    onChange={(e) => {
                      const valor = e.target.value.replace(/\D/g, "");
                      setBuscaClienteId(valor);
                      setClienteId("");
                      setMostrarListaClientes(valor.length > 0 || buscaCliente.trim().length > 0);
                    }}
                    onFocus={() => {
                      if (buscaClienteId || buscaCliente.trim()) setMostrarListaClientes(true);
                    }}
                    onBlur={() => setTimeout(() => setMostrarListaClientes(false), 200)}
                    style={{ ...fieldStyle, width: 82, flex: "0 0 82px" }}
                  />
                  <input
                    type="text"
                    placeholder="Busque por nome"
                    value={buscaCliente}
                    onChange={(e) => {
                      const txt = e.target.value;
                      setBuscaCliente(txt);
                      setClienteId("");
                      setMostrarListaClientes(txt.trim().length > 0 || buscaClienteId.length > 0);
                    }}
                    onFocus={() => {
                      if (buscaCliente.trim() || buscaClienteId) setMostrarListaClientes(true);
                    }}
                    onBlur={() => setTimeout(() => setMostrarListaClientes(false), 200)}
                    style={{ ...fieldStyle, flex: 1 }}
                  />
                </div>

                {clienteId ? (
                  <div className="cliente-selection-preview">
                    <ClienteIdentity
                      cliente={clientes.find((cliente) => String(cliente.id) === String(clienteId))}
                      clienteId={clienteId}
                      avatarSize={40}
                      secondary={`ID ${clienteId}`}
                    />
                  </div>
                ) : null}

                {mostrarListaClientes && (
                  <ul
                    style={{
                      maxHeight: 180,
                      overflowY: "auto",
                      border: "1px solid var(--border-soft)",
                      borderRadius: 8,
                      marginTop: 4,
                      paddingLeft: 0,
                      listStyle: "none",
                      position: "absolute",
                      backgroundColor: "var(--bg-card)",
                      width: "100%",
                      zIndex: 1000,
                    }}
                  >
                    {clientesFiltrados.length > 0 ? (
                      clientesFiltrados.map((c) => (
                        <li
                          key={c.id}
                          onMouseDown={() => {
                            setClienteId(String(c.id));
                            setBuscaCliente(`#${c.id} - ${c.nome}`);
                            setMostrarListaClientes(false);
                          }}
                          style={{
                            padding: "8px 10px",
                            cursor: "pointer",
                            borderBottom: "1px solid var(--border-soft)",
                          }}
                        >
                          <ClienteIdentity
                            cliente={c}
                            avatarSize={34}
                            secondary={`ID ${c.id}`}
                          />
                        </li>
                      ))
                    ) : (
                      <li style={{ padding: 8, color: "var(--text-muted)" }}>
                        Nenhum cliente encontrado
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>

            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>
                <span>{"\u{1F4B0} Dados do emprestimo"}</span>
              </div>

              <div style={inputWrapStyle}>
                <label style={labelStyle}>Valor (R$)</label>
                <input
                  type="text"
                  value={valor}
                  onChange={(e) => setValor(formatarMoedaInput(e.target.value))}
                  style={fieldStyle}
                />
              </div>

              <div style={inputWrapStyle}>
                <label style={labelStyle}>Data de inicio do emprestimo</label>
                <input
                  type="date"
                  value={data}
                  onChange={(e) => setData(e.target.value)}
                  style={fieldStyle}
                />
              </div>

              <div style={inputWrapStyle}>
                <label style={labelStyle}>Observacao</label>
                <textarea
                  value={observacao}
                  onChange={(e) => setObservacao(e.target.value)}
                  rows={3}
                  style={{ ...fieldStyle, resize: "vertical", minHeight: 84 }}
                  placeholder="(opcional)"
                />
              </div>
            </div>

            {modalidade === "parcelado" && (
              <div style={sectionStyle}>
                <div style={sectionTitleStyle}>
                  <span>{"\u{1F4D1} Configuracao das parcelas"}</span>
                </div>

                <div style={inputWrapStyle}>
                  <label style={labelStyle}>Parcelas</label>
                  <StepperInput
                    value={parcelas}
                    onChange={setParcelas}
                    min={1}
                    inputAriaLabel="Quantidade de parcelas"
                  />
                </div>

                <div style={inputWrapStyle}>
                  <label style={labelStyle}>Taxa de juros (%)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={taxaJuros}
                    onChange={(e) => setTaxaJuros(e.target.value.replace(/[^0-9.,]/g, ""))}
                    style={fieldStyle}
                  />
                </div>

                <div style={inputWrapStyle}>
                  <label style={labelStyle}>Data de vencimento da 1a parcela</label>
                  <input
                    type="date"
                    value={dataPagamento}
                    onChange={(e) => setDataPagamento(e.target.value)}
                    style={fieldStyle}
                  />
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
                    Essa sera a data da 1a parcela. As demais seguem mes a mes a partir dela.
                  </div>
                </div>

                <div style={{ marginTop: 16 }}>
                  <div style={sectionTitleStyle}>
                    <span>{"\u{1F4C6} Pre-visualizacao de parcelas"}</span>
                  </div>

                  <ul style={{ listStyle: "none", padding: 0, marginTop: 6 }}>
                    {previewParcelas.map((p) => (
                      <li
                        key={p.numero}
                        style={{
                          padding: "8px 10px",
                          border: "1px solid var(--border-soft)",
                          borderRadius: 8,
                          marginBottom: 6,
                          background: "var(--bg-card)",
                          fontSize: 13,
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>
                          {p.numero}a parcela - {formatarMoedaNumero(p.total)}
                        </div>
                        <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
                          {renderLinhaJuros(
                            {
                              valor_capital: p.amortizacao,
                              valor_juros: p.juros,
                              juros_pendentes: 0,
                              juros_adicionais: 0,
                            },
                            formatarMoedaNumero
                          )}
                        </div>
                        <div style={{ marginTop: 2 }}>
                          <strong>Vencimento: {p.vencimento}</strong>
                        </div>
                      </li>
                    ))}

                    {previewParcelas.length === 0 && (
                      <li style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        Informe valor, parcelas, taxa de juros e data de vencimento para ver a simulacao.
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            )}

            <div
              style={{
                marginTop: 16,
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={secondaryButtonStyle}
                disabled={salvando}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={salvarAlteracoes}
                style={primaryButtonStyle}
                disabled={salvando}
              >
                {salvando ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
