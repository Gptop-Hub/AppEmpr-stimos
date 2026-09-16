import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { autorizarProtecao } from '../security/seguranca.js';
import { useNavigate } from "react-router-dom";
import EditarCliente from "./editarcliente";
import EditarEmprestimo from "./editaremprestimo";
import notify from "../ui/notify";
import { toDateObj } from "./Emprestimos/helpers.jsx";
import { isClienteMalPagador } from "../utils/clientRisk";
import ClienteAvatar, { getClienteFotoUrl } from "./common/ClienteAvatar";
import {
  CLIENT_PHOTO_ACCEPT,
  prepararFotoCliente,
} from "./common/clientePhotoProcessing";
import { atualizarClienteNoCatalogo } from "./common/useClientesCatalogo.js";

const recebeNotificacoesCobranca = (cliente) =>
  Number(cliente?.receber_notificacoes_cobranca ?? 1) === 1;

export default function Clientes() {
  const navigate = useNavigate();

  const [clientes, setClientes] = useState([]);
  const [emprestimos, setEmprestimos] = useState([]);
  const [selecionadoId, setSelecionadoId] = useState(null);
  const [clienteEditando, setClienteEditando] = useState(null);
  const [emprestimoEditando, setEmprestimoEditando] = useState(null);
  const [mostrar, setMostrar] = useState(false);
  const [busca, setBusca] = useState("");
  const [buscaId, setBuscaId] = useState("");
  const [campoBusca, setCampoBusca] = useState("nome");
  const [mostrarDetalhes, setMostrarDetalhes] = useState({});
  const [clickTimeout, setClickTimeout] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [fotoMenu, setFotoMenu] = useState(null);
  const [fotoVisualizadaId, setFotoVisualizadaId] = useState(null);
  const [fotoAtualizandoId, setFotoAtualizandoId] = useState(null);
  const fotoInputRef = useRef(null);
  const clienteFotoAlvoRef = useRef(null);
  const ORDENACAO_KEY = "clientes.ordenacao";
  const [ordenacao, setOrdenacao] = useState(
    () => localStorage.getItem(ORDENACAO_KEY) || "idCrescente"
  );

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

  const normalizeForSearch = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  useEffect(() => {
    carregarDados();
  }, []);

  useEffect(() => {
    localStorage.setItem(ORDENACAO_KEY, ordenacao);
  }, [ordenacao]);

  useEffect(() => {
    if (!contextMenu && !fotoMenu) return undefined;
    const fechar = () => {
      setContextMenu(null);
      setFotoMenu(null);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") fechar();
    };
    window.addEventListener("click", fechar);
    window.addEventListener("resize", fechar);
    window.addEventListener("scroll", fechar, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", fechar);
      window.removeEventListener("resize", fechar);
      window.removeEventListener("scroll", fechar, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu, fotoMenu]);

  useEffect(() => {
    if (!fotoVisualizadaId) return undefined;
    const fecharComEscape = (event) => {
      if (event.key === "Escape") setFotoVisualizadaId(null);
    };
    window.addEventListener("keydown", fecharComEscape);
    return () => window.removeEventListener("keydown", fecharComEscape);
  }, [fotoVisualizadaId]);

  async function carregarDados() {
    try {
      const [clientesResp, emprestimosResp] = await Promise.all([
        axios.get("/clientes"),
        axios.get("/emprestimos"),
      ]);
      if (!Array.isArray(clientesResp.data) || !Array.isArray(emprestimosResp.data)) {
        throw new Error("A API retornou dados invalidos para a tela de clientes.");
      }
      setClientes(clientesResp.data);
      setEmprestimos(emprestimosResp.data);
    } catch (err) {
      console.error("Erro ao carregar clientes e emprestimos:", err);
      setClientes([]);
      setEmprestimos([]);
      notify.error("Nao foi possivel carregar os clientes.");
    }
  }

  async function excluirCliente(clienteId, clienteNome) {
    const autorizacao = await autorizarProtecao('excluir_cliente');
    if (!autorizacao) return;
    const confirmarExclusao = await notify.confirm(
      `Deseja excluir "${clienteNome}"?`
    );
    if (!confirmarExclusao) return;
    try {
      await axios.delete(`/clientes/${clienteId}`, autorizacao);
      notify.success("Cliente excluido.");
      carregarDados();
      setSelecionadoId(null);
    } catch (err) {
      console.error(err);
      notify.error("Erro ao excluir.");
    }
  }

  function abrirEdicao(clienteId) {
    const cliente = clientes.find((c) => c.id === clienteId);
    setClienteEditando(cliente);
  }

  function formatarData(dataStr) {
    if (!dataStr) return "Não informado";
    return new Date(dataStr).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  }

  function formatarCPF(cpf) {
    if (!cpf) return "";
    const digits = String(cpf).replace(/\D/g, "");
    if (digits.length !== 11) return cpf;
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}-${digits.slice(9)}`;
  }

  function formatarTelefoneBrasil(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (digits.length === 10) {
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11) {
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
    }
    return null;
  }

  function formatarTelefoneEntrada(raw) {
    const digits = String(raw || "").replace(/\D/g, "").slice(0, 11);
    if (!digits) return "";
    if (digits.length <= 2) return digits;

    const ddd = digits.slice(0, 2);
    const numero = digits.slice(2);
    if (!numero) return `(${ddd}`;
    if (numero.length <= 4) return `(${ddd}) ${numero}`;
    if (numero.length <= 8) {
      return `(${ddd}) ${numero.slice(0, 4)}-${numero.slice(4)}`;
    }
    return `(${ddd}) ${numero.slice(0, 5)}-${numero.slice(5)}`;
  }

  function getTelefonesCliente(cliente) {
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
  }

  function extrairCampoTexto(texto, campo) {
    if (!texto) return "";
    const regex = new RegExp(`${campo}:([^,]+)`, "i");
    return regex.exec(String(texto))?.[1]?.trim() || "";
  }

  function getCategoriaTrabalho(cliente) {
    return (
      String(cliente?.categoria_trabalho || "").trim() ||
      extrairCampoTexto(cliente?.trabalho, "Categoria")
    );
  }

  function clienteMatchesBusca(cliente, raw, tipoBusca) {
    const term = normalizeForSearch(raw);
    if (!term) return true;

    const rawDigits = String(raw || "").replace(/\D/g, "");

    switch (tipoBusca) {
      case "cpf":
        return (
          !!rawDigits &&
          String(cliente?.cpf || "").replace(/\D/g, "").startsWith(rawDigits)
        );
      case "telefone":
        return (
          !!rawDigits &&
          getTelefonesCliente(cliente).some((telefone) =>
            String(telefone || "").replace(/\D/g, "").startsWith(rawDigits)
          )
        );
      case "empresa": {
        const empresa =
          cliente?.empresa || extrairCampoTexto(cliente?.trabalho, "Empresa");
        return normalizeForSearch(empresa).startsWith(term);
      }
      case "categoria":
        return normalizeForSearch(getCategoriaTrabalho(cliente)).startsWith(term);
      case "nome":
      default:
        return normalizeForSearch(cliente?.nome).startsWith(term);
    }
  }

  async function adicionarTelefoneExtra(cliente) {
    const entrada = await notify.prompt(
      "Digite o telefone adicional com DDD (ex.: 64999998888):",
      {
        okText: "Salvar",
        placeholder: "(64) 99999-8888",
        inputMode: "numeric",
        pattern: "\\d*",
        maxLength: 15,
        sanitize: formatarTelefoneEntrada,
      }
    );
    if (entrada === null) return;

    const telefone = formatarTelefoneBrasil(entrada);
    if (!telefone) {
      notify.warn("Telefone invalido. Informe DDD + numero (10 ou 11 digitos).");
      return;
    }

    try {
      await axios.post(
        `/clientes/${cliente.id}/telefones`,
        { telefone }
      );
      notify.success("Telefone adicional salvo.");
      carregarDados();
    } catch (err) {
      console.error(err);
      if (err?.response?.status === 409) {
        notify.warn("Esse telefone ja esta cadastrado para este cliente.");
        return;
      }
      notify.error("Nao foi possivel salvar o telefone adicional.");
    }
  }

  function atualizarClienteNaLista(clienteAtualizado) {
    if (!clienteAtualizado) return;
    atualizarClienteNoCatalogo(clienteAtualizado);
    setClientes((prev) =>
      prev.map((item) =>
        Number(item.id) === Number(clienteAtualizado.id)
          ? { ...item, ...clienteAtualizado }
          : item
      )
    );
  }

  function abrirMenuFoto(event, cliente) {
    event.preventDefault();
    event.stopPropagation();
    const largura = 220;
    const altura = cliente?.foto_cliente ? 136 : 52;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(
      Math.max(8, rect.right - largura),
      window.innerWidth - largura - 8
    );
    const y = Math.min(rect.bottom + 5, window.innerHeight - altura - 8);

    setContextMenu(null);
    setSelecionadoId(cliente.id);
    setFotoMenu({
      clienteId: cliente.id,
      x,
      y: Math.max(8, y),
    });
  }

  function abrirSeletorFoto(cliente) {
    clienteFotoAlvoRef.current = cliente;
    setFotoMenu(null);
    window.setTimeout(() => fotoInputRef.current?.click(), 0);
  }

  async function trocarFotoPeloCard(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const cliente = clienteFotoAlvoRef.current;
    if (!file || !cliente) return;

    setFotoAtualizandoId(cliente.id);

    try {
      const fotoPreparada = await prepararFotoCliente(file);
      const fotoData = new FormData();
      fotoData.append("foto", fotoPreparada);
      const res = await axios.post(
        `/clientes/${cliente.id}/foto`,
        fotoData
      );
      atualizarClienteNaLista(res.data);
      notify.success(cliente.foto_cliente ? "Foto trocada." : "Foto adicionada.");
    } catch (err) {
      console.error(err);
      notify.error(
        err?.response?.data?.error ||
          err?.message ||
          "Não foi possível salvar a foto."
      );
    } finally {
      clienteFotoAlvoRef.current = null;
      setFotoAtualizandoId(null);
    }
  }

  async function removerFotoPeloCard(cliente) {
    if (!cliente?.foto_cliente) return;
    setFotoMenu(null);
    const confirmado = await notify.confirm(
      `Remover a foto de "${cliente.nome}"?`
    );
    if (!confirmado) return;

    setFotoAtualizandoId(cliente.id);
    try {
      const res = await axios.delete(
        `/clientes/${cliente.id}/foto`
      );
      atualizarClienteNaLista(res.data);
      if (Number(fotoVisualizadaId) === Number(cliente.id)) {
        setFotoVisualizadaId(null);
      }
      notify.success("Foto removida.");
    } catch (err) {
      console.error(err);
      notify.error(err?.response?.data?.error || "Não foi possível remover a foto.");
    } finally {
      setFotoAtualizandoId(null);
    }
  }

  function visualizarFoto(cliente) {
    if (!cliente?.foto_cliente) return;
    setFotoMenu(null);
    setFotoVisualizadaId(cliente.id);
  }

  function abrirMenuContextoCliente(event, cliente) {
    event.preventDefault();
    event.stopPropagation();
    const largura = 240;
    const altura = 220;
    const x = Math.min(event.clientX, window.innerWidth - largura - 8);
    const y = Math.min(event.clientY, window.innerHeight - altura - 8);
    setFotoMenu(null);
    setSelecionadoId(cliente.id);
    setContextMenu({
      clienteId: cliente.id,
      x: Math.max(8, x),
      y: Math.max(8, y),
    });
  }

  async function alternarMalPagador(cliente) {
    if (!cliente) return;
    const proximoValor = !isClienteMalPagador(cliente);
    setContextMenu(null);

    try {
      const res = await axios.patch(
        `/clientes/${cliente.id}/mal-pagador`,
        { mal_pagador: proximoValor }
      );
      const atualizado = res.data || {
        ...cliente,
        mal_pagador: proximoValor ? 1 : 0,
      };

      setClientes((prev) =>
        prev.map((item) =>
          Number(item.id) === Number(cliente.id)
            ? { ...item, ...atualizado, mal_pagador: proximoValor ? 1 : 0 }
            : item
        )
      );
      setEmprestimos((prev) =>
        prev.map((emp) =>
          Number(emp.cliente_id) === Number(cliente.id)
            ? { ...emp, cliente_mal_pagador: proximoValor ? 1 : 0 }
            : emp
        )
      );
      notify.success(
        proximoValor
          ? "Cliente marcado como mal pagador."
          : "Marca de mal pagador removida."
      );
    } catch (err) {
      console.error(err);
      notify.error("Nao foi possivel atualizar a marca do cliente.");
    }
  }

  async function atualizarNotificacoesCobranca(cliente, receber, motivo) {
    const payload = { receber_notificacoes_cobranca: receber };
    if (motivo !== undefined) payload.motivo_notificacoes_cobranca = motivo;

    const res = await axios.patch(
      `/clientes/${cliente.id}/notificacoes-cobranca`,
      payload
    );
    const atualizado = res.data || {
      ...cliente,
      receber_notificacoes_cobranca: receber ? 1 : 0,
      ...(motivo !== undefined ? { motivo_notificacoes_cobranca: motivo } : {}),
    };
    atualizarClienteNaLista(atualizado);
    window.dispatchEvent(new Event("notificacoes-cobranca-atualizadas"));
    return atualizado;
  }

  async function alternarNotificacoesCobranca(cliente) {
    if (!cliente) return;
    const proximoEstado = !recebeNotificacoesCobranca(cliente);
    setContextMenu(null);

    try {
      if (!proximoEstado) {
        const confirmado = await notify.confirm(
          "Este cliente continuará com empréstimos, parcelas e atrasos normalmente registrados, mas não aparecerá mais nas notificações de cobrança.",
          {
            title: "Desligar notificações de cobrança?",
            okText: "Continuar",
            cancelText: "Cancelar",
          }
        );
        if (!confirmado) return;

        const motivo = await notify.prompt("Motivo / observação (opcional)", {
          title: "Notificações de cobrança",
          okText: "Confirmar",
          cancelText: "Cancelar",
          defaultValue: cliente.motivo_notificacoes_cobranca || "",
          placeholder: "Ex.: Cobrança tratada externamente.",
          maxLength: 2000,
        });
        if (motivo === null) return;
        await atualizarNotificacoesCobranca(cliente, false, motivo);
        notify.success("Notificações de cobrança desligadas.");
      } else {
        await atualizarNotificacoesCobranca(cliente, true);
        notify.success("Notificações de cobrança ligadas.");
      }
    } catch (err) {
      console.error(err);
      notify.error("Não foi possível atualizar as notificações de cobrança.");
    }
  }

  async function editarMotivoNotificacoesCobranca(cliente) {
    if (!cliente) return;
    setContextMenu(null);
    const motivo = await notify.prompt("Motivo / observação (opcional)", {
      title: "Editar motivo",
      okText: "Salvar",
      cancelText: "Cancelar",
      defaultValue: cliente.motivo_notificacoes_cobranca || "",
      placeholder: "Ex.: Não entrar em contato por enquanto.",
      maxLength: 2000,
    });
    if (motivo === null) return;

    try {
      await atualizarNotificacoesCobranca(
        cliente,
        recebeNotificacoesCobranca(cliente),
        motivo
      );
      notify.success("Motivo atualizado.");
    } catch (err) {
      console.error(err);
      notify.error("Não foi possível atualizar o motivo.");
    }
  }

  const getCapitalRestanteEmprestimo = (emp) => {
    if (!emp) return null;
    const raw = emp.capital_restante ?? emp.valor_atual ?? emp.valor;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(2));
  };

  const isEmprestimoQuitadoPorCapital = (emp) => {
    const capitalRestante = getCapitalRestanteEmprestimo(emp);
    if (capitalRestante == null) return false;
    return capitalRestante <= 0.009;
  };

  const resumoEmprestimosPorCliente = useMemo(() => {
    const acc = {};
    (Array.isArray(emprestimos) ? emprestimos : []).forEach((emp) => {
      const clienteId = String(emp?.cliente_id ?? "");
      if (!clienteId) return;
      if (!acc[clienteId]) {
        acc[clienteId] = { ativos: 0, quitados: 0 };
      }
      if (isEmprestimoQuitadoPorCapital(emp)) {
        acc[clienteId].quitados += 1;
      } else {
        acc[clienteId].ativos += 1;
      }
    });
    return acc;
  }, [emprestimos]);

  const contarEmprestimosEmAndamento = (clienteId) =>
    resumoEmprestimosPorCliente[String(clienteId)]?.ativos || 0;

  const contarEmprestimosQuitados = (clienteId) =>
    resumoEmprestimosPorCliente[String(clienteId)]?.quitados || 0;

  const emprestimosPorCliente = (Array.isArray(emprestimos) ? emprestimos : []).reduce((acc, emp) => {
    (acc[emp.cliente_id] = acc[emp.cliente_id] || []).push(emp);
    return acc;
  }, {});

  const getLastActivityTimestamp = (cliente) => {
    let maxTs = 0;
    const tryValue = (val) => {
      if (!val) return;
      const dt = toDateObj(val);
      if (dt) maxTs = Math.max(maxTs, dt.getTime());
    };

    ["updatedAt", "updated_at", "criadoEm", "criado_em", "createdAt", "created_at"].forEach(
      (f) => tryValue(cliente && cliente[f])
    );

    const loans = emprestimosPorCliente[cliente.id] || [];
    loans.forEach((emp) => {
      [
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
      ].forEach((f) => tryValue(emp && emp[f]));

      const parcelas = emp.parcelasDetalhes || [];
      parcelas.forEach((p) => {
        ["data_pagamento", "vencimento", "updatedAt", "updated_at"].forEach((f) =>
          tryValue(p && p[f])
        );
      });

      const pagamentos = emp.pagamentos || [];
      pagamentos.forEach((pg) => {
        ["data", "createdAt", "created_at", "updatedAt", "updated_at"].forEach((f) =>
          tryValue(pg && pg[f])
        );
      });
    });

    return maxTs;
  };

  function irParaEmprestimos(clienteId) {
    navigate(`/emprestimos?cliente=${clienteId}`);
  }

  function irParaHistoricoQuitados(clienteId) {
    navigate(`/historico?clienteId=${encodeURIComponent(String(clienteId))}`);
  }

  const handleBuscaKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
    }
    e.stopPropagation();
  };

  const listaClientes = Array.isArray(clientes) ? clientes : [];
  const filtrar = listaClientes
    .filter((c) => {
      if (ordenacao === "malPagadores" && !isClienteMalPagador(c)) {
        return false;
      }
      if (
        ordenacao === "notificacoesDesligadas" &&
        recebeNotificacoesCobranca(c)
      ) {
        return false;
      }
      const raw = busca.trim();
      const correspondeAoId =
        !buscaId || String(c.id).startsWith(buscaId);
      return correspondeAoId && clienteMatchesBusca(c, raw, campoBusca);
    })
    .sort((a, b) => {
      const termo = busca.trim();
      if (termo) {
        return (a.nome || "").localeCompare(b.nome || "", "pt-BR", {
          sensitivity: "base",
        });
      }

      switch (ordenacao) {
        case "idCrescente":
          return a.id - b.id;
        case "idDecrescente":
          return b.id - a.id;
        case "nomeAZ":
          return a.nome.toLowerCase().localeCompare(b.nome.toLowerCase());
        case "nomeZA":
          return b.nome.toLowerCase().localeCompare(a.nome.toLowerCase());
        case "maisAntigos":
          return new Date(a.criadoEm) - new Date(b.criadoEm);
        case "maisNovos":
          return new Date(b.criadoEm) - new Date(a.criadoEm);
        case "maiorValor":
          return (
            contarEmprestimosEmAndamento(b.id) -
            contarEmprestimosEmAndamento(a.id)
          );
        case "menorValor":
          return (
            contarEmprestimosEmAndamento(a.id) -
            contarEmprestimosEmAndamento(b.id)
          );
        case "ultimoTrabalhado": {
          const aHas = !!a.last_activity_at;
          const bHas = !!b.last_activity_at;
          const aTime = parseLastActivityMs(a.last_activity_at);
          const bTime = parseLastActivityMs(b.last_activity_at);
          if (aHas || bHas) return bTime - aTime;
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
    });

  const mostrarLista =
    mostrar ||
    busca.trim() !== "" ||
    buscaId !== "" ||
    ordenacao === "malPagadores" ||
    ordenacao === "notificacoesDesligadas";
  const clienteFotoVisualizada = listaClientes.find(
    (cliente) => Number(cliente.id) === Number(fotoVisualizadaId)
  );

  return (
    <div
      style={{
        padding: 20,
        maxWidth: "var(--main-max-effective, var(--main-max))",
        margin: "auto",
        fontFamily: "'Segoe UI', sans-serif",
        color: "var(--text-main)",
      }}
    >
      <h2
        style={{
          textAlign: "center",
          marginBottom: 20,
          color: "var(--text-main)",
        }}
      >
        Clientes
      </h2>

      <input
        ref={fotoInputRef}
        type="file"
        accept={CLIENT_PHOTO_ACCEPT}
        onChange={trocarFotoPeloCard}
        hidden
      />

      {clienteEditando ? (
        <EditarCliente
          cliente={clienteEditando}
          clientesExistentes={clientes}
          onCancel={() => setClienteEditando(null)}
          onSalvo={() => {
            setClienteEditando(null);
            carregarDados();
          }}
        />
      ) : emprestimoEditando ? (
        <EditarEmprestimo
          emprestimoId={emprestimoEditando}
          onClose={() => {
            setEmprestimoEditando(null);
            carregarDados();
          }}
        />
      ) : (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginBottom: 12,
            }}
          >
            <button
              type="button"
              onClick={() => navigate("/novocliente")}
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
              Novo Cliente
            </button>
          </div>

          {/* Barra de busca e filtros */}
          <div
            style={{
              display: "flex",
              gap: 10,
              marginBottom: 20,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button
              onClick={() => setMostrar(!mostrar)}
              style={{
                backgroundColor: mostrar ? "#ff6b6b" : "#4caf50",
                color: "#fff",
                border: "none",
                padding: "10px 16px",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
                transition: "0.3s",
              }}
            >
              {mostrar ? "Ocultar Todos" : "Mostrar Todos"}
            </button>

            <input
              type="text"
              inputMode="numeric"
              placeholder="ID"
              aria-label="Buscar cliente por ID"
              value={buscaId}
              onChange={(e) => setBuscaId(e.target.value.replace(/\D/g, ""))}
              onKeyDown={handleBuscaKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 82,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border-soft)",
                fontSize: 16,
                background: "var(--bg-card)",
                color: "var(--text-main)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
                boxSizing: "border-box",
              }}
            />

            <input
              type="text"
              placeholder={
                campoBusca === "cpf"
                  ? "Buscar por CPF"
                  : campoBusca === "telefone"
                    ? "Buscar por telefone"
                    : campoBusca === "empresa"
                      ? "Buscar por empresa"
                      : campoBusca === "categoria"
                        ? "Buscar por categoria"
                        : "Buscar por nome"
              }
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              onKeyDown={handleBuscaKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid var(--border-soft)",
                fontSize: 16,
                background: "var(--bg-card)",
                color: "var(--text-main)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
                boxSizing: "border-box",
              }}
            />

            <select
              value={campoBusca}
              onChange={(e) => setCampoBusca(e.target.value)}
              aria-label="Selecionar campo de busca"
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
              <option value="nome">Nome</option>
              <option value="cpf">CPF</option>
              <option value="telefone">Telefone</option>
              <option value="empresa">Empresa</option>
              <option value="categoria">Categoria</option>
            </select>

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
          </div>

          {/* Lista de clientes */}
          {mostrarLista && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: 16,
                alignItems: "start",
              }}
            >
              {filtrar.map((c) => {
                const telefonesCliente = getTelefonesCliente(c);
                const telefonesTexto =
                  telefonesCliente.length > 0
                    ? telefonesCliente.join(" | ")
                    : "Nao informado";
                const categoriaTrabalho = getCategoriaTrabalho(c);
                const clienteMalPagador = isClienteMalPagador(c);
                const clienteSilenciado = !recebeNotificacoesCobranca(c);

                return (
                <div
                  key={c.id}
                  className={`cliente-card${selecionadoId === c.id ? " is-selected" : ""}${
                    clienteMalPagador ? " client-card--risk" : ""
                  }`}
                  style={{
                    boxSizing: "border-box",
                    width: "100%",
                  }}
                  onContextMenu={(e) => abrirMenuContextoCliente(e, c)}
                  onClick={() => {
                    if (clickTimeout) {
                      clearTimeout(clickTimeout);
                      setClickTimeout(null);
                      setSelecionadoId(null);
                    } else {
                      const t = setTimeout(() => {
                        setSelecionadoId(c.id);
                        setMostrarDetalhes((prev) => ({
                          ...prev,
                          [c.id]: false,
                        }));
                        setClickTimeout(null);
                      }, 200);
                      setClickTimeout(t);
                    }
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                        minWidth: 0,
                      }}
                    >
                      <h3
                        style={{
                          margin: 0,
                          fontSize: 18,
                          color: "var(--text-main)",
                        }}
                      >
                        {c.nome}
                      </h3>
                      {clienteMalPagador ? (
                        <span className="badge-risk">Mal pagador</span>
                      ) : null}
                      {clienteSilenciado ? (
                        <span
                          role="img"
                          aria-label="Notificações de cobrança desativadas"
                          title="Notificações de cobrança desativadas"
                          style={{ color: "var(--text-muted)", fontSize: 16 }}
                        >
                          🔕
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "flex-start",
                        gap: 8,
                        flexShrink: 0,
                      }}
                    >
                      {c.foto_cliente ? (
                        <button
                          type="button"
                          className="cliente-avatar-button"
                          title="Visualizar foto"
                          aria-label={`Visualizar foto de ${c.nome}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            visualizarFoto(c);
                          }}
                        >
                          <ClienteAvatar cliente={c} size={64} />
                        </button>
                      ) : (
                        <ClienteAvatar cliente={c} size={64} />
                      )}
                      <div
                        style={{
                          display: "inline-flex",
                          flexDirection: "column",
                          alignItems: "flex-end",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            color: "var(--text-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          ID: {c.id}
                        </span>
                        <button
                          type="button"
                          className="client-card-menu-button"
                          title="Opções da foto"
                          aria-label={`Opções da foto de ${c.nome}`}
                          disabled={Number(fotoAtualizandoId) === Number(c.id)}
                          onClick={(e) => abrirMenuFoto(e, c)}
                        >
                          ⋮
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* CPF e Telefone sempre visíveis */}
                  <p
                    style={{
                      margin: "6px 0",
                      color: "var(--text-muted)",
                    }}
                  >
                    <strong>CPF:</strong> {formatarCPF(c.cpf)}
                  </p>
                  <div
                    style={{
                      margin: "6px 0",
                      color: "var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>
                      <strong>Telefone:</strong> {telefonesTexto}
                    </span>
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await adicionarTelefoneExtra(c);
                      }}
                      title="Adicionar outro telefone"
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        border: "1px solid var(--border-soft)",
                        background: "transparent",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        fontWeight: 600,
                        fontSize: 13,
                        lineHeight: 1,
                        padding: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      +
                    </button>
                  </div>

                  {categoriaTrabalho ? (
                    <p
                      style={{
                        margin: "6px 0",
                        color: "var(--text-muted)",
                      }}
                    >
                      <strong>Categoria:</strong> {categoriaTrabalho}
                    </p>
                  ) : null}

                  {/* Toggle detalhes pessoais */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMostrarDetalhes((prev) => ({
                        ...prev,
                        [c.id]: !prev[c.id],
                      }));
                    }}
                    style={{
                      fontSize: 14,
                      padding: "6px 10px",
                      cursor: "pointer",
                      border: "1px solid #007bff",
                      borderRadius: 6,
                      backgroundColor: "transparent",
                      color: "#007bff",
                      marginTop: 6,
                    }}
                  >
                    {mostrarDetalhes[c.id]
                      ? "Ocultar detalhes pessoais"
                      : "Mostrar detalhes pessoais"}
                  </button>

                  {mostrarDetalhes[c.id] && (
                    <div
                      style={{
                        marginTop: 10,
                        lineHeight: 1.5,
                        color: "var(--text-main)",
                      }}
                    >
                      <div>
                        <h4 style={{ marginBottom: 4 }}>Endereço</h4>
                        {c.endereco ? (
                          c.endereco
                            .split(",")
                            .map((p, i) => <p key={i}>{p.trim()}</p>)
                        ) : (
                          <p style={{ color: "var(--text-muted)" }}>
                            Nenhuma informação
                          </p>
                        )}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <h4 style={{ marginBottom: 4 }}>Trabalho</h4>
                        {categoriaTrabalho ? (
                          <p>
                            <strong>Categoria:</strong> {categoriaTrabalho}
                          </p>
                        ) : null}
                        {c.trabalho ? (
                          c.trabalho
                            .split(",")
                            .filter((p) => !/^categoria\s*:/i.test(p.trim()))
                            .map((p, i) => <p key={i}>{p.trim()}</p>)
                        ) : (
                          <p style={{ color: "var(--text-muted)" }}>
                            Nenhuma informação
                          </p>
                        )}
                      </div>
                      <p>
                        <strong>Referência:</strong> {c.referencia}
                      </p>
                      <p>
                        <strong>Observação:</strong> {c.observacao}
                      </p>
                      <p>
                        <strong>Cliente desde:</strong>{" "}
                        {formatarData(c.criadoEm)}
                      </p>
                    </div>
                  )}

                  {/* Botões ação */}
                  {selecionadoId === c.id && (
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await abrirEdicao(c.id);
                        }}
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: 6,
                          border: "none",
                          backgroundColor: "#007bff",
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        Editar
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await excluirCliente(c.id, c.nome);
                        }}
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: 6,
                          border: "none",
                          backgroundColor: "#ff4b5c",
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        Excluir
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          irParaEmprestimos(c.id);
                        }}
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: 6,
                          border: "none",
                          backgroundColor: "#28a745",
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        Empréstimos: {contarEmprestimosEmAndamento(c.id)}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          irParaHistoricoQuitados(c.id);
                        }}
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: 6,
                          border: "none",
                          backgroundColor: "#64748b",
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        Quitados: {contarEmprestimosQuitados(c.id)}
                      </button>
                    </div>
                  )}
                </div>
              );
              })}
            </div>
          )}
        </>
      )}
      {fotoMenu ? (() => {
        const clienteMenuFoto = clientes.find(
          (cliente) => Number(cliente.id) === Number(fotoMenu.clienteId)
        );
        if (!clienteMenuFoto) return null;
        const temFoto = Boolean(clienteMenuFoto.foto_cliente);
        return (
          <div
            className="context-menu client-photo-context-menu"
            style={{ left: fotoMenu.x, top: fotoMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {temFoto ? (
              <button
                type="button"
                className="context-menu-item"
                onClick={() => visualizarFoto(clienteMenuFoto)}
              >
                Visualizar foto
              </button>
            ) : null}
            <button
              type="button"
              className="context-menu-item"
              onClick={() => abrirSeletorFoto(clienteMenuFoto)}
            >
              {temFoto ? "Trocar foto" : "Adicionar foto"}
            </button>
            {temFoto ? (
              <button
                type="button"
                className="context-menu-item context-menu-item--danger"
                onClick={() => removerFotoPeloCard(clienteMenuFoto)}
              >
                Remover foto
              </button>
            ) : null}
          </div>
        );
      })() : null}
      {contextMenu ? (() => {
        const clienteMenu = clientes.find(
          (cliente) => Number(cliente.id) === Number(contextMenu.clienteId)
        );
        if (!clienteMenu) return null;
        const marcado = isClienteMalPagador(clienteMenu);
        const notificacoesLigadas = recebeNotificacoesCobranca(clienteMenu);
        const motivoNotificacoes = String(
          clienteMenu.motivo_notificacoes_cobranca || ""
        ).trim();
        return (
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="context-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                alternarMalPagador(clienteMenu);
              }}
            >
              {marcado
                ? "Remover marca de mal pagador"
                : "Marcar como mal pagador"}
            </button>
            <div
              style={{
                padding: "8px 12px 4px",
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              <div>
                Notificações de cobrança: {notificacoesLigadas ? "Ligadas" : "Desligadas"}
              </div>
              {!notificacoesLigadas ? (
                <div>Motivo: {motivoNotificacoes || "Não informado"}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="context-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                alternarNotificacoesCobranca(clienteMenu);
              }}
            >
              Receber notificações de cobrança: {notificacoesLigadas ? "Ligado" : "Desligado"}
            </button>
            <button
              type="button"
              className="context-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                editarMotivoNotificacoesCobranca(clienteMenu);
              }}
            >
              Editar motivo
            </button>
          </div>
        );
      })() : null}
      {clienteFotoVisualizada?.foto_cliente ? (
        <div
          className="cliente-photo-viewer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cliente-photo-viewer-title"
          onClick={() => setFotoVisualizadaId(null)}
        >
          <div
            className="cliente-photo-viewer"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="cliente-photo-viewer__header">
              <h3 id="cliente-photo-viewer-title">
                {clienteFotoVisualizada.nome}
              </h3>
              <button
                type="button"
                className="cliente-photo-viewer__close"
                title="Fechar"
                aria-label="Fechar foto ampliada"
                onClick={() => setFotoVisualizadaId(null)}
              >
                ×
              </button>
            </div>
            <div className="cliente-photo-viewer__image-wrap">
              <img
                src={getClienteFotoUrl(clienteFotoVisualizada)}
                alt={`Foto ampliada de ${clienteFotoVisualizada.nome}`}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
