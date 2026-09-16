// frontend/src/componentes/Emprestimos/index.jsx
import React, { useEffect, useMemo, useState, useRef } from "react";
import axios from "axios";
import { autorizarProtecao } from '../../security/seguranca.js';
import EditarEmprestimo from "../editaremprestimo";
import { useLocation, useNavigate } from "react-router-dom";
import notify from "../../ui/notify";
import ParcelaList from "./ParcelaList";
import {
  formatarMoeda,
  formatarData,
  toDateObj,
  calcularTempoPassado,
  obterComposicaoValorEmprestado,
} from "./helpers.jsx";
import DetalhesTotalPagoModal from "./DetalhesTotalPagoModal.jsx";
import AdicionarCapitalModal from "./AdicionarCapitalModal.jsx";
import RecalcularAtrasoModal from "./RecalcularAtrasoModal.jsx";
import RenegociacaoInlinePanel from "./RenegociacaoInlinePanel.jsx";
import ValorEmprestadoToggle from "../common/ValorEmprestadoToggle.jsx";
import ClientePhotoZoom from "../common/ClientePhotoZoom.jsx";
import ClienteIdentity from "../common/ClienteIdentity.jsx";
import { AppIcon } from "../menu.jsx";
import {
  isClienteMalPagador,
  isEmprestimoClienteMalPagador,
} from "../../utils/clientRisk";

const EMPRESTIMOS_LAYOUT_KEY = "emprestimos.layoutMode";
const TIPOS_NOTIFICACAO_WHATSAPP = new Set([
  "parcela_atrasada",
  "parcela_muito_atrasada",
]);
const WHATSAPP_ENVIO_HABILITADO = false;

const temNotificacoesDesligadas = (cliente) =>
  Number(cliente?.receber_notificacoes_cobranca ?? 1) !== 1;

const normalizarTelefoneParaWhatsApp = (telefoneRaw) => {
  const bruto = String(telefoneRaw || "").replace(/\D/g, "");
  if (!bruto) return null;

  let numero = bruto.replace(/^0+/, "");
  if (!numero) return null;

  if (/^\d{10,11}$/.test(numero)) {
    numero = `55${numero}`;
  }

  if (!/^\d{12,15}$/.test(numero)) {
    return null;
  }

  return numero;
};

const montarMensagemWhatsAppCobranca = ({ tipoNotificacao, clienteNome }) => {
  const nomeFinal = String(clienteNome || "cliente").trim() || "cliente";
  if (tipoNotificacao === "parcela_atrasada") {
    return `Ola, ${nomeFinal}. Tudo bem? Consta no sistema uma parcela em atraso referente ao seu emprestimo. Se voce ja realizou o pagamento, por favor desconsidere esta mensagem. Caso queira, me responda por aqui para regularizarmos.`;
  }

  if (tipoNotificacao === "parcela_muito_atrasada") {
    return `Ola, ${nomeFinal}. Tudo bem? Consta no sistema uma parcela em atraso ha mais tempo referente ao seu emprestimo. Se voce ja realizou o pagamento, por favor desconsidere esta mensagem. Caso queira, me responda por aqui para regularizarmos.`;
  }

  return null;
};

const montarLinkWhatsApp = (numero, mensagem) => {
  if (!numero || !mensagem) return null;
  return `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
};

const logWhatsAppRenderer = (mensagem, data) => {
  if (data !== undefined) {
    console.info(`[renderer][whatsapp] ${mensagem}`, data);
    return;
  }
  console.info(`[renderer][whatsapp] ${mensagem}`);
};

export default function Emprestimos() {
  const [emprestimos, setEmprestimos] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [expandedClientes, setExpandedClientes] = useState({});
  const [editarId, setEditarId] = useState(null);
  const [busca, setBusca] = useState("");
  const [buscaId, setBuscaId] = useState("");
  const ORDENACAO_KEY = "emprestimos.ordenacao";
  const FOCUS_MODE_KEY = "emprestimos.focusMode";
  const [ordenacao, setOrdenacao] = useState(
    () => localStorage.getItem(ORDENACAO_KEY) || "idCrescente"
  );
  const [isFocusModeEnabled, setIsFocusModeEnabled] = useState(
    () => localStorage.getItem(FOCUS_MODE_KEY) === "1"
  );
  const [novoPagamento, setNovoPagamento] = useState({
    valor: "",
    tipo: "adiantamento",
  });
  const [emprestimoSelecionado, setEmprestimoSelecionado] = useState(null);
  const [adicionarCapitalEmprestimo, setAdicionarCapitalEmprestimo] =
    useState(null);
  const [recalcularAtrasoEmprestimo, setRecalcularAtrasoEmprestimo] =
    useState(null);
  const [modoExibicao, setModoExibicao] = useState(() => {
    try {
      const salvo = localStorage.getItem(EMPRESTIMOS_LAYOUT_KEY);
      return salvo === "grade" ? "grade" : "lista";
    } catch {
      return "lista";
    }
  });

  const location = useLocation();
  const navigate = useNavigate();
  const mountedRef = useRef(false);
  const hashHandledRef = useRef(null);
  const veioDeNotificacoes = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get("from") === "notificacoes";
  }, [location.search]);
  const emprestimoOrigemId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get("emprestimo");
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [location.search]);
  const parcelaOrigemId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get("parcela");
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [location.search]);
  const tipoNotificacaoOrigem = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const tipo = String(params.get("tipoNotificacao") || "").trim();
    return tipo || null;
  }, [location.search]);
  const origemNotificacaoSuportaWhatsapp = useMemo(
    () =>
      WHATSAPP_ENVIO_HABILITADO &&
      veioDeNotificacoes &&
      !!tipoNotificacaoOrigem &&
      TIPOS_NOTIFICACAO_WHATSAPP.has(tipoNotificacaoOrigem),
    [veioDeNotificacoes, tipoNotificacaoOrigem]
  );

  const [openAtivasByLoan, setOpenAtivasByLoan] = useState({});
  const [renegAbertasByLoan, setRenegAbertasByLoan] = useState({});
  const [mostrarDiagnosticoWhatsApp, setMostrarDiagnosticoWhatsApp] =
    useState(false);

  const parseLastActivityMs = (value) => {
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    const raw = String(value).trim();
    if (!raw) return 0;
    const normalized = raw.includes(" ") && !raw.includes("T")
      ? raw.replace(" ", "T")
      : raw;
    const ts = Date.parse(normalized);
    if (!Number.isNaN(ts)) return ts;
    const dt = toDateObj(raw);
    return dt ? dt.getTime() : 0;
  };

  useEffect(() => {
    axios
      .get("/clientes")
      .then((r) => {
        if (!Array.isArray(r.data)) {
          throw new TypeError("A API de clientes nao retornou uma lista.");
        }
        setClientes(r.data);
      })
      .catch((error) => {
        console.error(error);
        setClientes([]);
        notify.error("Erro ao carregar clientes dos emprestimos.");
      });
    carregarEmprestimos();
  }, []);

  useEffect(() => {
    const hasOpenWhatsAppBridge = Boolean(
      window.appExternal &&
        typeof window.appExternal.openWhatsApp === "function"
    );
    const hasExternalOpen = Boolean(
      window.appExternal &&
        typeof window.appExternal.open === "function"
    );
    logWhatsAppRenderer("bridge status inicial", {
      hasOpenWhatsAppBridge,
      hasExternalOpen,
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(ORDENACAO_KEY, ordenacao);
  }, [ordenacao]);

  useEffect(() => {
    localStorage.setItem(FOCUS_MODE_KEY, isFocusModeEnabled ? "1" : "0");
  }, [isFocusModeEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(EMPRESTIMOS_LAYOUT_KEY, modoExibicao);
    } catch {}
  }, [modoExibicao]);


  const carregarEmprestimos = () =>
    axios
      .get("/emprestimos")
      .then((r) => {
        if (!Array.isArray(r.data)) {
          throw new TypeError("A API de emprestimos nao retornou uma lista.");
        }
        setEmprestimos(r.data);
      })
      .catch((error) => {
        console.error(error);
        setEmprestimos([]);
        notify.error("Erro ao carregar emprestimos.");
      });

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
        if (el && el.scrollIntoView)
          el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, clientes, emprestimos]);

  // Abre emprestimo/parcela vindo da hash (#/emprestimos?emprestimo=&parcela=)
  useEffect(() => {
    if (!Array.isArray(emprestimos) || emprestimos.length === 0) return;
    const params = new URLSearchParams(location.search);
    const empParam = params.get("emprestimo");
    if (!empParam) return;
    const empId = Number(empParam);
    if (!empId) return;

    const parcelaParam = params.get("parcela");
    const parcelaId = parcelaParam ? Number(parcelaParam) : null;

    const handledKey = `${empId}-${parcelaId || ""}`;
    if (hashHandledRef.current === handledKey) return;

    const emprestimoAlvo = emprestimos.find((e) => Number(e.id) === empId);
    if (!emprestimoAlvo) return;

    hashHandledRef.current = handledKey;

    setExpandedClientes((prev) => ({
      ...prev,
      [emprestimoAlvo.cliente_id]: true,
    }));
    setOpenAtivasByLoan((prev) => ({ ...prev, [empId]: true }));

    // Scroll para o card do emprestimo, se possivel
    setTimeout(() => {
      const el = document.querySelector(
        `[data-emprestimo-id="${empId}"]`
      );
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 200);
  }, [location.search, emprestimos]);

  const nomeCliente = (id) =>
    (Array.isArray(clientes) ? clientes : []).find((c) => c.id === id)?.nome || "Desconhecido";

  const getCapitalRestanteEmprestimo = (emp) => {
    if (!emp) return null;
    const raw = emp.capital_restante ?? emp.valor_atual ?? emp.valor;
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    return Number(num.toFixed(2));
  };

  const isEmprestimoQuitadoPorCapital = (emp) => {
    const capitalRestante = getCapitalRestanteEmprestimo(emp);
    if (capitalRestante == null) return false;
    return capitalRestante <= 0.009;
  };

  const emprestimosAtivos = (Array.isArray(emprestimos) ? emprestimos : []).filter(
    (emp) => !isEmprestimoQuitadoPorCapital(emp)
  );

  const loansByClient = emprestimosAtivos.reduce((acc, e) => {
    (acc[e.cliente_id] = acc[e.cliente_id] || []).push(e);
    return acc;
  }, {});

  const clientesComContagem = (Array.isArray(clientes) ? clientes : []).map((c) => {
    const emprestimosCliente = loansByClient[c.id] || [];
    const marcadoComoMalPagador =
      isClienteMalPagador(c) ||
      emprestimosCliente.some(isEmprestimoClienteMalPagador);
    return {
      ...c,
      mal_pagador: marcadoComoMalPagador ? 1 : c.mal_pagador,
      emprestimos: emprestimosCliente,
    };
  });

  const termoRaw = (busca || "").trim();
  const termoIsNumeric = termoRaw !== "" && /^\d+$/.test(termoRaw);
  const normalizeForSearch = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const toSafeNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };

  const clientesFiltrados = clientesComContagem.filter((c) => {
    if (ordenacao === "malPagadores" && !isClienteMalPagador(c)) {
      return false;
    }
    if (
      ordenacao === "notificacoesDesligadas" &&
      !temNotificacoesDesligadas(c)
    ) {
      return false;
    }
    if (buscaId && !String(c.id).startsWith(buscaId)) return false;
    if (!termoRaw) return true;
    const term = normalizeForSearch(termoRaw);
    const nome = normalizeForSearch(c.nome);
    const nomeMatch = nome.startsWith(term);
    if (termoIsNumeric) {
      return nomeMatch || String(c.id).startsWith(termoRaw);
    }
    return nomeMatch;
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
    tryFields(cliente, [
      "updatedAt",
      "updated_at",
      "criadoEm",
      "criado_em",
      "createdAt",
      "created_at",
    ]);
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
    (cliente.emprestimos || []).forEach((emp) => {
      const parcelas = emp.parcelasDetalhes || [];
      parcelas.forEach((p) =>
        tryFields(p, ["data_pagamento", "vencimento", "updatedAt", "updated_at"])
      );
      const pagamentos = emp.pagamentos || [];
      pagamentos.forEach((pg) =>
        tryFields(pg, ["data", "createdAt", "created_at", "updatedAt", "updated_at"])
      );
    });
    if (cliente.lastActivityTimestamp && Number(cliente.lastActivityTimestamp)) {
      maxTs = Math.max(maxTs, Number(cliente.lastActivityTimestamp));
    }
    return maxTs;
  };

  const getClienteCreatedTimestamp = (cliente) => {
    const fields = ["criadoEm", "criado_em", "createdAt", "created_at"];
    for (const f of fields) {
      if (cliente && cliente[f]) {
        const dt = toDateObj(cliente[f]);
        if (dt) return dt.getTime();
      }
    }
    return 0;
  };

  const getClienteTotalEmprestado = (cliente) => {
    const loans = cliente.emprestimos || [];
    return loans.reduce((sum, emp) => {
      const base =
        emp.valor_emprestado ??
        emp.valor_original ??
        emp.valor_inicial ??
        emp.valor;
      const num = Number(base || 0);
      return sum + (Number.isFinite(num) ? num : 0);
    }, 0);
  };

  const getClienteLastActivityFromLoans = (cliente) => {
    const loans = cliente.emprestimos || [];
    let maxTs = parseLastActivityMs(cliente.last_activity_at);
    let hasAny = !!cliente.last_activity_at;
    loans.forEach((emp) => {
      if (emp && emp.last_activity_at) hasAny = true;
      const ts = parseLastActivityMs(emp.last_activity_at);
      if (ts) maxTs = Math.max(maxTs, ts);
    });
    return { maxTs, hasAny };
  };

  const ordenarClientes = (a, b) => {
    switch (ordenacao) {
      case "idCrescente":
        return a.id - b.id;
      case "idDecrescente":
        return b.id - a.id;
      case "nomeAZ":
        return (a.nome || "").toLowerCase().localeCompare((b.nome || "").toLowerCase());
      case "nomeZA":
        return (b.nome || "").toLowerCase().localeCompare((a.nome || "").toLowerCase());
      case "maisAntigos":
        return getClienteCreatedTimestamp(a) - getClienteCreatedTimestamp(b);
      case "maisNovos":
        return getClienteCreatedTimestamp(b) - getClienteCreatedTimestamp(a);
      case "maiorValor":
        return getClienteTotalEmprestado(b) - getClienteTotalEmprestado(a);
      case "menorValor":
        return getClienteTotalEmprestado(a) - getClienteTotalEmprestado(b);
      case "ultimoTrabalhado":
        {
          const aInfo = getClienteLastActivityFromLoans(a);
          const bInfo = getClienteLastActivityFromLoans(b);
          if (aInfo.hasAny || bInfo.hasAny) return bInfo.maxTs - aInfo.maxTs;
          return getLastActivityTimestamp(b) - getLastActivityTimestamp(a);
        }
      case "malPagadores":
      case "notificacoesDesligadas":
        return (a.nome || "").localeCompare(b.nome || "", "pt-BR", {
          sensitivity: "base",
        });
      default:
        return a.id - b.id;
    }
  };

  const clientesOrdenados = (() => {
    if (!termoRaw) {
      return [...clientesFiltrados].sort(ordenarClientes);
    }

    if (termoIsNumeric) {
      return [...clientesFiltrados].sort((a, b) => {
        const idA = String(a?.id ?? "");
        const idB = String(b?.id ?? "");
        const idMatchA = idA.startsWith(termoRaw);
        const idMatchB = idB.startsWith(termoRaw);

        if (idMatchA !== idMatchB) return idMatchA ? -1 : 1;

        if (idMatchA && idMatchB) {
          const diff = toSafeNumber(idA) - toSafeNumber(idB);
          if (diff !== 0) return diff;
          return idA.localeCompare(idB, "pt-BR", { numeric: true });
        }

        const nomeA = normalizeForSearch(a?.nome);
        const nomeB = normalizeForSearch(b?.nome);
        const nomeDiff = nomeA.localeCompare(nomeB, "pt-BR", {
          sensitivity: "base",
        });
        if (nomeDiff !== 0) return nomeDiff;

        return toSafeNumber(idA) - toSafeNumber(idB);
      });
    }

    return [...clientesFiltrados].sort((a, b) =>
      (a.nome || "").localeCompare(b.nome || "", "pt-BR", {
        sensitivity: "base",
      })
    );
  })();

  const getProximoVencimento = (emp) => {
    try {
      const p = (emp.parcelasDetalhes || []).find(
        (x) => !x.pago && !x.renegociada && Number(x.numero) !== -1
      );
      return p ? formatarData(p.vencimento) : "-";
    } catch {
      return "-";
    }
  };


  /**
   * Atualiza vencimento de UMA parcela ou reage a "alterar dia em todas".
   *
   * - fluxo normal (uma parcela):
   *   atualizarVencimento(parcelaId, novaISO)
   *
   * - fluxo "aplicar dia em todas" (chamado pelo ParcelaList):
   *   atualizarVencimento(null, norm, { tipo: "alterar-dia-todas", emprestimoId })
   */
  const atualizarVencimento = async (parcelaId, novaISO, meta) => {
    // Caso especial: operacao "alterar dia em todas" (ja tratada no backend)
    if (meta && meta.tipo === "alterar-dia-todas") {
      try {
        await carregarEmprestimos();
      } catch (err) {
        console.error("Erro ao recarregar emprestimos apos alterar dia:", err);
        notify.error("Erro ao recarregar emprestimos apos alterar dia.");
      }
      return;
    }

    // Fluxo normal: atualizar apenas uma parcela
    if (!parcelaId || !novaISO) {
      notify.warn("Data invalida.");
      return;
    }

    try {
      await axios.put(`/parcelas/${parcelaId}`, {
        vencimento: novaISO,
      });
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
      await axios.post("/pagamentos", {
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
        "Deseja realmente excluir este empréstimo e todos os dados relacionados (parcelas e pagamentos)? Esta ação é irreversível."
      );
      if (!confirmar) return;

      const autorizacao = await autorizarProtecao('excluir_emprestimo');
      if (!autorizacao) return;

      await axios.delete(
        `/emprestimos/${emprestimoId}`,
        autorizacao
      );

      notify.success("Emprestimo excluido com sucesso.");
      carregarEmprestimos();
    } catch (err) {
      console.error("Erro ao excluir emprestimo:", err);
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.erro ||
        err?.response?.data ||
        err.message ||
        "Erro ao excluir empr\u00E9stimo.";
      notify.error(String(msg));
    }
  };

  const guessHasRenegLocal = (emp) => {
    const historicos = emp?.renegociacoesHistorico;
    if (Array.isArray(historicos) && historicos.length > 0) return true;
    const pars = emp?.parcelasDetalhes || [];
    return pars.some((p) => p?.renegociada || Number(p?.numero) === -1);
  };

  const toggleCliente = (id) =>
    setExpandedClientes((p) => ({ ...p, [id]: !p[id] }));

  const isInteractiveLoanEntryTarget = (target) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest(
      'button, a, input, select, textarea, label, [role="button"], [role="link"], [contenteditable="true"]'
    );
  };

  const excluirTodosEmprestimos = async () => {
    try {
      const autorizacao = await autorizarProtecao('excluir_todos_emprestimos');
      if (!autorizacao) return;

      const confirmar = await notify.confirm(
        "Tem certeza que deseja EXCLUIR TODOS OS EMPRÉSTIMOS? Esta ação remove parcelas (pagas ou não), pagamentos, renegociações, notificações e movimentos de caixa ligados aos empréstimos. Esta ação é irreversível.",
        {
          okText: "Sim, excluir tudo",
          cancelText: "Não",
        }
      );
      if (!confirmar) return;

      const resp = await axios.post(
        "/emprestimos/reset-all",
        {},
        autorizacao
      );

      const removidos = (resp && resp.data && resp.data.removidos) || {};
      notify.success(
        `Exclusao concluida. Emprestimos: ${Number(removidos.emprestimos || 0)} | Parcelas: ${Number(removidos.parcelas || 0)} | Pagamentos: ${Number(removidos.pagamentos || 0)}`
      );

      setExpandedClientes({});
      setOpenAtivasByLoan({});
      await carregarEmprestimos();
    } catch (err) {
      console.error("Erro ao excluir todos os emprestimos:", err);
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.erro ||
        err?.response?.data ||
        err.message ||
        "Erro desconhecido";
      notify.error("Erro ao excluir todos os emprestimos: " + msg);
    }
  };

  const inicioDoDia = (value = new Date()) => {
    const dt = toDateObj(value);
    if (!dt) return null;
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  };

  const parcelaEstaQuitada = (parcela) => {
    if (!parcela) return false;
    if (Number(parcela.pago || 0) === 1) return true;
    const valorTotal = Number(parcela.valor_total || 0);
    const valorPago = Number(parcela.valor_pago || 0);
    return valorTotal > 0 && valorPago >= valorTotal - 0.009;
  };

  const parcelaTemRecalculoAplicado = (parcela) => {
    const explicacao = String(parcela?.explicacao || "");
    return /recalculo de atraso aplicado/i.test(explicacao);
  };

  const getParcelaAtualAberta = (emp) => {
    const abertas = (emp?.parcelasDetalhes || [])
      .filter((parcela) => {
        if (!parcela) return false;
        if (Number(parcela.numero) === -1) return false;
        if (parcela?.renegociada) return false;
        return !parcelaEstaQuitada(parcela);
      })
      .sort((a, b) => {
        const na = Number(a?.numero ?? 0);
        const nb = Number(b?.numero ?? 0);
        if (na !== nb) return na - nb;
        return Number(a?.id || 0) - Number(b?.id || 0);
      });
    return abertas[0] || null;
  };

  const temParcelaVencidaEmAberto = (emp) => {
    const hoje = inicioDoDia(new Date());
    if (!hoje) return false;
    const parcelaAtual = getParcelaAtualAberta(emp);
    if (!parcelaAtual) return false;
    if (parcelaTemRecalculoAplicado(parcelaAtual)) return false;
    const vencimento = inicioDoDia(parcelaAtual.vencimento);
    if (!vencimento) return false;
    return vencimento.getTime() < hoje.getTime();
  };

  const handleLoanEntryDoubleClick = (event, clienteId) => {
    if (isInteractiveLoanEntryTarget(event.target)) return;
    toggleCliente(clienteId);
  };

  const openedLoanId = useMemo(() => {
    const openedIds = Object.keys(expandedClientes).filter(
      (id) => !!expandedClientes[id]
    );
    if (openedIds.length === 0) return null;
    return Number(openedIds[openedIds.length - 1]);
  }, [expandedClientes]);

  const hasOpenedLoan =
    openedLoanId != null && !!expandedClientes[String(openedLoanId)];

  const handleBuscaKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
    }
    e.stopPropagation();
  };

  const abrirWhatsAppDesktopFirst = async ({
    numero,
    mensagem,
    linkWeb,
    mode = "desktop",
    disableFallback = false,
  }) => {
    if (!numero || !mensagem) {
      throw new Error("Dados invalidos para abrir WhatsApp.");
    }

    const hasOpenWhatsAppBridge = Boolean(
      window.appExternal &&
        typeof window.appExternal.openWhatsApp === "function"
    );
    const hasExternalOpen = Boolean(
      window.appExternal &&
        typeof window.appExternal.open === "function"
    );
    logWhatsAppRenderer("antes de abrir WhatsApp", {
      mode,
      disableFallback,
      hasOpenWhatsAppBridge,
      hasExternalOpen,
      phoneDigits: String(numero || "").length,
      messageLength: String(mensagem || "").length,
    });

    if (hasOpenWhatsAppBridge) {
      const result = await window.appExternal.openWhatsApp({
        phone: numero,
        message: mensagem,
        mode,
        disableFallback,
      });
      logWhatsAppRenderer("retorno openWhatsApp", result);
      if (!result?.ok) {
        throw new Error(result?.error || "Falha ao abrir WhatsApp.");
      }
      return;
    }

    logWhatsAppRenderer(
      "openWhatsApp indisponivel no bridge. Usando fallback do renderer."
    );
    if (hasExternalOpen) {
      logWhatsAppRenderer("chamando appExternal.open(linkWeb) no renderer");
      const result = await window.appExternal.open(linkWeb);
      logWhatsAppRenderer("retorno appExternal.open", result);
      if (!result?.ok) {
        throw new Error(result?.error || "Falha ao abrir link externo.");
      }
      return;
    }

    logWhatsAppRenderer("window.open(linkWeb) no renderer");
    const popup = window.open(linkWeb, "_blank", "noopener,noreferrer");
    if (!popup) {
      throw new Error("Nao foi possivel abrir nova janela.");
    }
  };

  const montarPayloadWhatsAppEmprestimo = (emp) => {
    if (!emp) return;

    const cliente = clientes.find((c) => Number(c.id) === Number(emp.cliente_id));
    if (!cliente) {
      notify.error("Nao foi possivel localizar o cliente deste emprestimo.");
      return null;
    }

    const numero = normalizarTelefoneParaWhatsApp(cliente.telefone);
    if (!numero) {
      notify.warn("Cliente sem numero de telefone/WhatsApp cadastrado.");
      return null;
    }

    const mensagem = montarMensagemWhatsAppCobranca({
      tipoNotificacao: tipoNotificacaoOrigem,
      clienteNome: cliente.nome,
    });
    if (!mensagem) {
      notify.warn("Tipo de notificacao sem mensagem de WhatsApp nesta versao.");
      return null;
    }

    const link = montarLinkWhatsApp(numero, mensagem);
    if (!link) {
      notify.error("Nao foi possivel montar o link do WhatsApp.");
      return null;
    }

    return { numero, mensagem, link, cliente };
  };

  const enviarMensagemWhatsApp = async (emp) => {
    const payload = montarPayloadWhatsAppEmprestimo(emp);
    if (!payload) {
      return;
    }

    try {
      await abrirWhatsAppDesktopFirst({
        numero: payload.numero,
        mensagem: payload.mensagem,
        linkWeb: payload.link,
        mode: "desktop",
        disableFallback: false,
      });
    } catch (err) {
      console.error("[whatsapp-cobranca-v1] erro ao abrir link:", err);
      notify.error("Nao foi possivel abrir o WhatsApp.");
    }
  };

  const abrirWhatsAppDesktopTeste = async (emp) => {
    const payload = montarPayloadWhatsAppEmprestimo(emp);
    if (!payload) return;
    try {
      await abrirWhatsAppDesktopFirst({
        numero: payload.numero,
        mensagem: payload.mensagem,
        linkWeb: payload.link,
        mode: "desktop",
        disableFallback: true,
      });
      notify.success("Tentativa de abertura via WhatsApp Desktop executada.");
    } catch (err) {
      console.error("[whatsapp-cobranca-v1][teste-desktop] erro:", err);
      notify.error("Falha ao abrir via WhatsApp Desktop.");
    }
  };

  const abrirWhatsAppWebTeste = async (emp) => {
    const payload = montarPayloadWhatsAppEmprestimo(emp);
    if (!payload) return;
    try {
      await abrirWhatsAppDesktopFirst({
        numero: payload.numero,
        mensagem: payload.mensagem,
        linkWeb: payload.link,
        mode: "web",
        disableFallback: true,
      });
      notify.success("Tentativa de abertura via WhatsApp Web executada.");
    } catch (err) {
      console.error("[whatsapp-cobranca-v1][teste-web] erro:", err);
      notify.error("Falha ao abrir via WhatsApp Web.");
    }
  };

  const voltarParaNotificacoes = () => {
    navigate("/notificacoes?retornoNotificacoes=1");
  };

  return (
    <>
      <div
        style={{
          padding: 20,
          maxWidth: "var(--main-max-effective, var(--main-max))",
          margin: "auto",
          fontFamily: "sans-serif",
          color: "var(--text-main)",
        }}
      >
      <div className="emprestimos-header-row">
        <button
          type="button"
          className={`focus-mode-toggle${isFocusModeEnabled ? " is-active" : ""}`}
          onClick={() => setIsFocusModeEnabled((prev) => !prev)}
          title={
            isFocusModeEnabled
              ? "Modo foco ativado (outros empréstimos ficam borrados)"
              : "Modo foco desativado"
          }
          aria-label={
            isFocusModeEnabled
              ? "Desativar modo foco"
              : "Ativar modo foco"
          }
          aria-pressed={isFocusModeEnabled}
        >
          <span className="focus-mode-toggle__icon" aria-hidden="true">
            <AppIcon name="focus_mode" className="app-control-icon" />
          </span>
          <span className="focus-mode-toggle__label">
            {isFocusModeEnabled ? "Foco ligado" : "Foco desligado"}
          </span>
        </button>

        <h2 className="emprestimos-header-title">Lista de Empréstimos</h2>

        <div className="focus-mode-toggle-spacer" aria-hidden="true" />
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          placeholder="ID"
          aria-label="Buscar cliente por ID"
          value={buscaId}
          onChange={(e) => setBuscaId(e.target.value.replace(/\D/g, ""))}
          onKeyDown={handleBuscaKeyDown}
          style={{
            width: 82,
            padding: 10,
            fontSize: 16,
            borderRadius: 6,
            border: "1px solid var(--border-soft)",
            background: "var(--bg-card)",
            color: "var(--text-main)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
            boxSizing: "border-box",
          }}
        />
        <input
          type="text"
          placeholder="Buscar por nome"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          onKeyDown={handleBuscaKeyDown}
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            padding: 10,
            fontSize: 16,
            borderRadius: 6,
            border: "1px solid var(--border-soft)",
            background: "var(--bg-card)",
            color: "var(--text-main)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
            boxSizing: "border-box",
          }}
        />

        <select
          value={ordenacao}
          onChange={(e) => setOrdenacao(e.target.value)}
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid var(--border-soft)",
            fontSize: 16,
            background: "var(--bg-card)",
            color: "var(--text-main)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
          }}
        >
          <option value="idCrescente">ID Crescente</option>
          <option value="idDecrescente">ID Decrescente</option>
          <option value="nomeAZ">Nome A-Z</option>
          <option value="nomeZA">Nome Z-A</option>
          <option value="maisAntigos">Clientes mais antigos</option>
          <option value="maisNovos">Clientes mais novos</option>
          <option value="maiorValor">Maior valor emprestado</option>
          <option value="menorValor">Menor valor emprestado</option>
          <option value="ultimoTrabalhado">Último trabalhado</option>
          <option value="malPagadores">Mal pagadores</option>
          <option value="notificacoesDesligadas">Notificações desligadas</option>
        </select>

        <button
          type="button"
          onClick={() => navigate("/novoemprestimo")}
          style={{
            border: "none",
            background: "#1f8f4a",
            color: "#fff",
            padding: "9px 14px",
            borderRadius: 8,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Novo Empréstimo
        </button>

        <div
          style={{
            display: "inline-flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <button
            type="button"
            onClick={() => setModoExibicao("lista")}
            title="Exibir em lista"
            aria-label="Exibir em lista"
            aria-pressed={modoExibicao === "lista"}
            style={{
              width: 32,
              height: 30,
              borderRadius: 8,
              border:
                modoExibicao === "lista"
                  ? "1px solid rgba(37,99,235,0.6)"
                  : "1px solid var(--border-soft)",
              background:
                modoExibicao === "lista"
                  ? "rgba(37,99,235,0.22)"
                  : "var(--bg-card)",
              color: "var(--text-main)",
              cursor: "pointer",
              fontSize: "0.95em",
              lineHeight: 1,
              fontWeight: 700,
            }}
          >
            {"\u2630"}
          </button>
          <button
            type="button"
            onClick={() => setModoExibicao("grade")}
            title="Exibir lado a lado"
            aria-label="Exibir lado a lado"
            aria-pressed={modoExibicao === "grade"}
            style={{
              width: 32,
              height: 30,
              borderRadius: 8,
              border:
                modoExibicao === "grade"
                  ? "1px solid rgba(37,99,235,0.6)"
                  : "1px solid var(--border-soft)",
              background:
                modoExibicao === "grade"
                  ? "rgba(37,99,235,0.22)"
                  : "var(--bg-card)",
              color: "var(--text-main)",
              cursor: "pointer",
              fontSize: "0.95em",
              lineHeight: 1,
              fontWeight: 700,
            }}
          >
            {"\u25A6"}
          </button>
        </div>
      </div>

      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "grid",
          gridTemplateColumns:
            modoExibicao === "grade"
              ? "repeat(auto-fit, minmax(420px, 1fr))"
              : "1fr",
          gap: 10,
        }}
      >
        {clientesOrdenados.map((cliente) => {
          const loans = cliente.emprestimos || [];
          const expanded = !!expandedClientes[cliente.id];
          const clienteMalPagador =
            isClienteMalPagador(cliente) ||
            loans.some(isEmprestimoClienteMalPagador);
          const isBlurred =
            isFocusModeEnabled &&
            hasOpenedLoan &&
            Number(cliente.id) !== Number(openedLoanId);
          return (
            <li
              key={cliente.id}
              data-cliente-id={cliente.id}
              className={`loan-card${expanded ? " is-expanded" : ""}${
                isBlurred ? " loan-blurred" : ""
              }${clienteMalPagador ? " loan-card--risk" : ""}`}
              onClick={() => toggleCliente(cliente.id)}
              style={
                modoExibicao === "grade" && expanded
                  ? { gridColumn: "1 / -1" }
                  : undefined
              }
            >
              <div
                className="loan-card__header"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div className="loan-card__client-summary">
                  <ClientePhotoZoom
                    cliente={cliente}
                    size={48}
                    className="loan-card__client-avatar"
                  />
                  <div
                    className="loan-card__toggle-name"
                    title="Clique para abrir ou fechar este cliente"
                  >
                    <strong style={{ marginRight: 8 }}>{cliente.nome}</strong>
                    {clienteMalPagador ? (
                      <span className="badge-risk">Mal pagador</span>
                    ) : null}
                    <span
                      style={{
                        color: "var(--text-muted)",
                        fontSize: "0.95em",
                      }}
                    >
                      ({loans.length} empréstimo
                      {loans.length !== 1 ? "s" : ""})
                    </span>
                  </div>
                </div>
                <div className="loan-card__client-id">
                  <span className="loan-card__client-id-label">ID</span>{" "}
                  <span className="loan-card__client-id-value">
                    {cliente.id}
                  </span>
                </div>
              </div>

              {expanded && (
                <div
                  style={{ marginTop: 12, paddingLeft: 6 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {loans.length === 0 ? (
                    <div
                      style={{
                        color: "var(--text-muted)",
                        padding: 8,
                      }}
                    >
                      Nenhum empréstimo para este cliente.
                    </div>
                  ) : (
                    loans.map((emp, idx) => {
                      const displayId =
                        emp.codigo_cliente ||
                        emp.emprestimo_num ||
                        emp.id;

                      const hasRenegLocal = guessHasRenegLocal(emp);
                      const showRenegButton = hasRenegLocal;
                      const hasParcelaPaga = (emp.parcelasDetalhes || []).some((p) => {
                        if (!p) return false;
                        if (Number(p.pago || 0) === 1) return true;
                        if (Number(p.valor_pago || 0) > 0) return true;
                        return false;
                      });
                      const podeRecalcularAtraso = temParcelaVencidaEmAberto(emp);

                      const valorEmprestado =
                        emp.valor_emprestado ??
                        emp.valor_original ??
                        emp.valor_inicial ??
                        emp.valor;

                      const composicaoEmprestado =
                        obterComposicaoValorEmprestado(emp);
                      const valorEmprestadoParts = composicaoEmprestado.length
                        ? composicaoEmprestado
                        : [valorEmprestado];

                      const capitalRestante =
                        emp.capital_restante ??
                        emp.valor_atual ??
                        emp.valor;
                      const showBotaoVoltarNotificacoes =
                        veioDeNotificacoes &&
                        (emprestimoOrigemId
                          ? Number(emp.id) === Number(emprestimoOrigemId)
                          : idx === 0);
                      const emprestimoMalPagador =
                        clienteMalPagador || isEmprestimoClienteMalPagador(emp);

                      return (
                        <div
                          key={emp.id}
                          className={`loan-entry loan-entry--notify-modern${
                            emprestimoMalPagador ? " loan-entry--risk" : ""
                          }`}
                          data-emprestimo-id={emp.id}
                          onDoubleClick={(e) =>
                            handleLoanEntryDoubleClick(e, cliente.id)
                          }
                        >
                          {showBotaoVoltarNotificacoes ? (
                            <div
                              className="loan-notify-toolbar"
                            >
                              {origemNotificacaoSuportaWhatsapp ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      await enviarMensagemWhatsApp(emp);
                                    }}
                                    title="Abrir WhatsApp com mensagem pronta"
                                    className="loan-notify-btn loan-notify-btn--whatsapp"
                                  >
                                    Enviar mensagem
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setMostrarDiagnosticoWhatsApp((prev) => !prev);
                                    }}
                                    title="Mostrar/ocultar botoes de diagnostico de abertura"
                                    className="loan-notify-btn loan-notify-btn--ghost"
                                  >
                                    {mostrarDiagnosticoWhatsApp
                                      ? "Ocultar diagnostico"
                                      : "Diagnostico WhatsApp"}
                                  </button>
                                  {mostrarDiagnosticoWhatsApp ? (
                                    <>
                                      <button
                                        type="button"
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          await abrirWhatsAppDesktopTeste(emp);
                                        }}
                                        title="Teste: forcar somente tentativa no WhatsApp Desktop"
                                        className="loan-notify-btn loan-notify-btn--subtle"
                                      >
                                        Abrir WhatsApp Desktop
                                      </button>
                                      <button
                                        type="button"
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          await abrirWhatsAppWebTeste(emp);
                                        }}
                                        title="Teste: forcar somente WhatsApp Web"
                                        className="loan-notify-btn loan-notify-btn--subtle"
                                      >
                                        Abrir WhatsApp Web
                                      </button>
                                      <span
                                        className="loan-notify-bridge"
                                      >
                                        Bridge:
                                        {" "}
                                        {window.appExternal &&
                                        typeof window.appExternal.openWhatsApp ===
                                          "function"
                                          ? "openWhatsApp ativa"
                                          : "openWhatsApp ausente"}
                                      </span>
                                    </>
                                  ) : null}
                                </>
                              ) : null}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  voltarParaNotificacoes();
                                }}
                                title="Voltar para notificações"
                                className="loan-notify-btn loan-notify-btn--back"
                              >
                                Voltar às notificações
                              </button>
                            </div>
                          ) : null}
                          <div
                            className="loan-summary-grid"
                          >
                            <div className="loan-summary-column loan-summary-column--left">
                              <div className="loan-summary-item loan-summary-item--cliente">
                                <strong className="loan-summary-label">Cliente:</strong>{" "}
                                <span className="loan-summary-value">
                                  <ClienteIdentity
                                    cliente={cliente}
                                    avatarSize={28}
                                  />
                                </span>
                                {emprestimoMalPagador ? (
                                  <span className="badge-risk badge-risk--inline">
                                    Cliente mal pagador
                                  </span>
                                ) : null}
                              </div>
                              <div className="loan-summary-item loan-summary-item--id">
                                <strong className="loan-summary-label">ID:</strong>{" "}
                                <span className="loan-summary-value">{displayId}</span>
                              </div>
                              <div
                                className="loan-summary-item loan-summary-item--valor"
                              >
                                <strong
                                  className="loan-summary-label"
                                  style={{ whiteSpace: "nowrap" }}
                                >
                                  Valor emprestado:
                                </strong>
                                <div
                                  className="loan-summary-value"
                                  style={{ flex: "1 1 180px", minWidth: 0 }}
                                >
                                  <ValorEmprestadoToggle
                                    parts={valorEmprestadoParts}
                                    formatar={formatarMoeda}
                                    storageKey={`ui.valorEmprestado.${emp.id}`}
                                  />
                                </div>
                              </div>
                              <div className="loan-summary-item loan-summary-item--modalidade">
                                <strong className="loan-summary-label">Modalidade:</strong>{" "}
                                <span className="loan-summary-value">
                                  {emp.modalidade === "aberto"
                                    ? "Em aberto"
                                    : "Parcelado"}
                                </span>
                              </div>
                              <div className="loan-summary-item loan-summary-item--inicio">
                                <strong className="loan-summary-label">
                                  {"Data de in\u00EDcio do empr\u00E9stimo:"}
                                </strong>{" "}
                                <span className="loan-summary-value">
                                  {formatarData(emp.data)}
                                </span>
                              </div>
                            </div>
                            <div className="loan-summary-column loan-summary-column--right">
                              <div className="loan-summary-item loan-summary-item--capital capital-restante-row">
                                <span className="capital-restante-info">
                                  <strong className="loan-summary-label">
                                    Capital restante:
                                  </strong>{" "}
                                  <span className="loan-summary-value">
                                    {formatarMoeda(capitalRestante || 0)}
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  className="capital-restante-action-btn"
                                  title="Adicionar capital / Refinanciar"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAdicionarCapitalEmprestimo(emp);
                                  }}
                                >
                                  Adicionar capital
                                </button>
                              </div>
                              <div
                                className="loan-summary-item loan-summary-item--total-pago"
                              >
                                <strong className="loan-summary-label">Total pago:</strong>{" "}
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEmprestimoSelecionado({
                                      id: emp.id,
                                      totalPago: emp.total_pago || 0,
                                      clienteNome: nomeCliente(emp.cliente_id),
                                    })
                                  }
                                  className="loan-total-paid-btn"
                                >
                                  <span>{formatarMoeda(emp.total_pago || 0)}</span>
                                  <span
                                    className="loan-total-paid-btn__hint"
                                  >
                                    Ver detalhes
                                  </span>
                                </button>
                              </div>
                              <div className="loan-summary-item loan-summary-item--tempo">
                                <strong className="loan-summary-label">Tempo passado:</strong>{" "}
                                <span className="loan-summary-value">
                                  {calcularTempoPassado(emp.data)}
                                </span>
                              </div>
                              <div className="loan-summary-item loan-summary-item--proximo">
                                <strong className="loan-summary-label">
                                  {"Pr\u00F3ximo vencimento:"}
                                </strong>{" "}
                                <span className="loan-summary-value">
                                  {getProximoVencimento(emp)}
                                </span>
                              </div>
                            </div>
                            {emp.observacao ? (
                              <div className="loan-summary-item loan-summary-item--observacao">
                                <strong className="loan-summary-label">
                                  {"Observa\u00E7\u00E3o:"}
                                </strong>{" "}
                                <span className="loan-summary-value">
                                  {emp.observacao}
                                </span>
                              </div>
                            ) : null}
                          </div>

                          <div
                            className="loan-action-row"
                          >
                            <div
                              className="loan-action-row__main"
                            >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenAtivasByLoan((prev) => ({
                                  ...prev,
                                  [emp.id]: !prev[emp.id],
                                }));
                              }}
                              className="loan-action-btn loan-action-btn--primary"
                            >
                              {openAtivasByLoan[emp.id]
                                ? "Ocultar parcelas"
                                : "Mostrar parcelas"}
                            </button>

                            {showRenegButton && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRenegAbertasByLoan((prev) => ({
                                    ...prev,
                                    [emp.id]: !prev[emp.id],
                                  }));
                                }}
                                title="Mostrar histórico de renegociação"
                                className="loan-action-btn loan-action-btn--violet"
                              >
                                {renegAbertasByLoan[emp.id]
                                  ? "Ocultar renegociação"
                                  : "Ver renegociação"}
                              </button>
                            )}

                            {!hasParcelaPaga && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditarId(emp.id);
                                }}
                                className="loan-action-btn loan-action-btn--warning"
                              >
                                Editar
                              </button>
                            )}

                            {podeRecalcularAtraso && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRecalcularAtrasoEmprestimo(emp);
                                }}
                                title="Detectar períodos vencidos em aberto e lançar em juros pendentes"
                                className="loan-action-btn loan-action-btn--info"
                              >
                                Recalcular atraso
                              </button>
                            )}
                            </div>

                            <div
                              className="loan-action-row__danger"
                            >
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await excluirEmprestimo(emp.id);
                                }}
                                title="Excluir emprestimo"
                                className="loan-action-btn loan-action-btn--danger"
                              >
                                Excluir
                              </button>
                            </div>
                          </div>

                          {openAtivasByLoan[emp.id] && (
                            <div
                              className="loan-parcelas-shell"
                            >
                              <ParcelaList
                                parcelas={emp.parcelasDetalhes}
                                showAntigas={false}
                                onAtualizarVencimento={atualizarVencimento}
                                usarVisualNovo={true}
                                parcelaDestaqueId={
                                  veioDeNotificacoes ? parcelaOrigemId : null
                                }
                              />
                            </div>
                          )}

                          {renegAbertasByLoan[emp.id] ? (
                            <div className="loan-parcelas-shell">
                              <RenegociacaoInlinePanel emprestimoId={emp.id} />
                            </div>
                          ) : null}
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

      <DetalhesTotalPagoModal
        aberto={!!emprestimoSelecionado}
        onClose={() => setEmprestimoSelecionado(null)}
        emprestimoId={emprestimoSelecionado?.id}
        totalPago={emprestimoSelecionado?.totalPago || 0}
      />

      <AdicionarCapitalModal
        aberto={!!adicionarCapitalEmprestimo}
        emprestimo={adicionarCapitalEmprestimo}
        onClose={() => setAdicionarCapitalEmprestimo(null)}
        onAplicar={async () => {
          await carregarEmprestimos();
        }}
      />

      <RecalcularAtrasoModal
        aberto={!!recalcularAtrasoEmprestimo}
        emprestimo={recalcularAtrasoEmprestimo}
        onClose={() => setRecalcularAtrasoEmprestimo(null)}
        onAplicar={async () => {
          await carregarEmprestimos();
        }}
      />
    </>
  );
}
