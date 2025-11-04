// src/componentes/emprestimos.jsx
import React, { useEffect, useState, useRef } from "react";
import axios from "axios";
import EditarEmprestimo from "./editaremprestimo";
import { useLocation } from "react-router-dom";

export default function Emprestimos() {
  const [emprestimos, setEmprestimos] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [expandedClientes, setExpandedClientes] = useState({});
  const [loanOpen, setLoanOpen] = useState(null);
  const [editarId, setEditarId] = useState(null);
  const [busca, setBusca] = useState("");
  const [novoPagamento, setNovoPagamento] = useState({ valor: "", tipo: "adiantamento" });

  const [showMoreInfo, setShowMoreInfo] = useState({}); // por parcela
  const location = useLocation();
  const mountedRef = useRef(false);

  useEffect(() => {
    // carregar clientes e empréstimos
    axios.get("http://localhost:3001/clientes").then((r) => setClientes(r.data || [])).catch(console.error);
    carregarEmprestimos();
  }, []);

  const carregarEmprestimos = () =>
    axios
      .get("http://localhost:3001/emprestimos")
      .then((r) => setEmprestimos(r.data || []))
      .catch(console.error);

  // Quando clientes e emprestimos forem carregados (ou quando a URL mudar),
  // checar se existe ?cliente=ID e abrir o painel desse cliente.
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

    const clienteObj = (clientes || []).find(c => Number(c.id) === idNum);
    if (clienteObj) {
      setBusca("");
      setTimeout(() => {
        const el = document.querySelector(`[data-cliente-id="${idNum}"]`);
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 200);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, clientes, emprestimos]);

  const formatarMoeda = (v) =>
    Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  // ---------- datas ----------
  const mesesNome = [
    "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
    "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
  ];
  const pad = (n) => String(n).padStart(2, "0");

  const toDateObj = (d) => {
    if (!d) return null;
    if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    if (iso) {
      const [y, m, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
      const dt = new Date(y, m - 1, day);
      return isNaN(dt.getTime()) ? null : dt;
    }
    if (typeof d === "string" && d.includes("/")) {
      const parts = d.split("/");
      if (parts.length === 3) {
        const [day, mon, year] = parts.map((x) => Number(x));
        const dt = new Date(year, mon - 1, day);
        return isNaN(dt.getTime()) ? null : dt;
      }
    }
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt;
  };

  const formatarData = (d) => {
    const dt = toDateObj(d);
    if (!dt) return "-";
    return `${pad(dt.getDate())} ${mesesNome[dt.getMonth()]} ${dt.getFullYear()}`;
  };

  const dataParaInput = (d) => {
    const dt = toDateObj(d);
    if (!dt) return "";
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };

  // ---------- util cliente / grouping / busca ----------
  const nomeCliente = (id) => clientes.find((c) => c.id === id)?.nome || "Desconhecido";

  const loansByClient = emprestimos.reduce((acc, e) => {
    (acc[e.cliente_id] = acc[e.cliente_id] || []).push(e);
    return acc;
  }, {});

  const clientesComContagem = clientes.map((c) => ({ ...c, emprestimos: loansByClient[c.id] || [] }));

  const termo = (busca || "").trim().toLowerCase();

  const clientesFiltrados = clientesComContagem.filter((c) => {
    if (!termo) return true;
    if ((c.nome || "").toLowerCase().includes(termo)) return true;
    const numBusca = termo.replace(/\D/g, "");
    if (numBusca && String(c.id).startsWith(numBusca)) return true;
    const loans = c.emprestimos || [];
    return loans.some((emp) => {
      const displayId = String(emp.codigo_cliente || emp.emprestimo_num || emp.id).toLowerCase();
      return displayId.includes(termo) || (String(emp.observacao || "").toLowerCase().includes(termo));
    });
  });

  // ---------- atividades / ordenação ----------
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
    tryFields(cliente, ["updatedAt","updated_at","criadoEm","criado_em","createdAt","created_at"]);
    (cliente.emprestimos || []).forEach((emp) =>
      tryFields(emp, ["updatedAt","updated_at","criadoEm","criado_em","data","data_pagamento","createdAt","created_at","ultimo_pagamento","ultimo_movimento"])
    );
    if (cliente.lastActivityTimestamp && Number(cliente.lastActivityTimestamp)) maxTs = Math.max(maxTs, Number(cliente.lastActivityTimestamp));
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
      if (displayId.startsWith(termo)) { score += 100; break; }
      if (displayId.includes(termo)) score += 20;
      if (obs.includes(termo)) score += 10;
    }
    return score;
  };

  const clientesOrdenados = (() => {
    if (!termo) {
      return [...clientesFiltrados].sort((a,b) => getLastActivityTimestamp(b) - getLastActivityTimestamp(a));
    }
    return [...clientesFiltrados].sort((a,b) => {
      const sa = clienteMatchScore(a);
      const sb = clienteMatchScore(b);
      if (sb !== sa) return sb - sa;
      const na = (a.nome || '').toLowerCase();
      const nb = (b.nome || '').toLowerCase();
      return na.localeCompare(nb);
    });
  })();

  // ---------- tempo passado ----------
  const calcularTempoPassado = (dataInicio) => {
    const inicio = toDateObj(dataInicio);
    if (!inicio) return "-";
    const hoje = new Date();
    let months = (hoje.getFullYear() - inicio.getFullYear()) * 12 + (hoje.getMonth() - inicio.getMonth());
    const anchor = new Date(inicio.getFullYear(), inicio.getMonth() + months, inicio.getDate());
    if (anchor > hoje) months -= 1;
    const anchorAdj = new Date(inicio.getFullYear(), inicio.getMonth() + months, inicio.getDate());
    const days = Math.floor((hoje - anchorAdj) / (1000*60*60*24));
    if (months <= 0) return days <= 0 ? "0 dias" : `${days} ${days===1?'dia':'dias'}`;
    return `${months} ${months===1?'mês':'meses'}${days>0?`, ${days} ${days===1?'dia':'dias'}`:''}`;
  };

  // ---------- parcelas helper ----------
  const getProximoVencimento = (emp) => {
    try {
      const p = (emp.parcelasDetalhes||[]).find(x => !x.pago);
      return p ? formatarData(p.vencimento) : "-";
    } catch { return "-"; }
  };

  const atualizarVencimento = async (parcelaId, novaISO) => {
    if (!parcelaId || !novaISO) return alert("Data inválida");
    try {
      await axios.put(`http://localhost:3001/parcelas/${parcelaId}`, { vencimento: novaISO });
      carregarEmprestimos();
      alert("Vencimento atualizado com sucesso!");
    } catch (err) {
      console.error(err);
      alert("Erro ao atualizar vencimento.");
    }
  };

  const registrarPagamento = async (emprestimo_id) => {
    const valor = parseFloat(novoPagamento.valor);
    if (!valor || valor <= 0) return alert("Informe um valor válido.");
    try {
      await axios.post("http://localhost:3001/pagamentos", { emprestimo_id, valor, tipoPagamento: novoPagamento.tipo });
      alert("✅ Pagamento registrado com sucesso!");
      setNovoPagamento({ valor: "", tipo: "adiantamento" });
      carregarEmprestimos();
    } catch (err) {
      console.error(err);
      alert("Erro ao registrar pagamento.");
    }
  };

  // ---------- função nova: excluir empréstimo (frontend) ----------
  const excluirEmprestimo = async (emprestimoId) => {
    try {
      const confirmar = window.confirm("Deseja realmente excluir este empréstimo e TODOS os dados relacionados (parcelas e pagamentos)? Esta ação é irreversível.");
      if (!confirmar) return;

      const senha = window.prompt("Informe a senha para excluir o empréstimo (deixe em branco para cancelar):");
      if (senha === null || senha === "") {
        return;
      }

      await axios.delete(`http://localhost:3001/emprestimos/${emprestimoId}`, {
        data: { password: senha }
      });

      alert("Empréstimo excluído com sucesso.");
      carregarEmprestimos();
    } catch (err) {
      console.error("Erro ao excluir empréstimo:", err);
      const msg = err?.response?.data?.error || err?.response?.data || err.message || "Erro desconhecido";
      alert("Erro ao excluir empréstimo: " + msg);
    }
  };

  // ---------- destaque em explicações ----------
  const monthAlternatives = mesesNome.join("|");
  const renderHighlightedText = (text) => {
    if (!text) return null;
    const original = String(text);
    const dateSlashRe = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g;
    const dateWordRe = new RegExp(`\\b\\d{1,2}\\s+(?:${monthAlternatives})\\s+\\d{4}\\b`, "gi");
    const parcelaRe = /\bparcela(?:s)?\s*\d+\b/gi;
    const currencyRe = /R\$\s?\d{1,3}(?:[\.\d]{0,})?(?:[.,]\d{2})?/g;

    const all = [];
    const push = (re, type) => {
      let m;
      while ((m = re.exec(original)) !== null) all.push({ i: m.index, len: m[0].length, text: m[0], type });
    };
    push(dateSlashRe, "dateSlash"); push(dateWordRe, "dateWord"); push(parcelaRe, "parcela"); push(currencyRe, "currency");
    if (!all.length) return original;

    all.sort((a,b)=> a.i - b.i || b.len - a.len);
    const nonOverlap = [];
    let last = -1;
    for (const m of all) if (m.i >= last) { nonOverlap.push(m); last = m.i + m.len; }

    const nodes = []; let cur = 0, k = 0;
    for (const m of nonOverlap) {
      if (m.i > cur) nodes.push(<span key={`t${k++}`}>{original.slice(cur, m.i)}</span>);
      let rendered = m.text;
      if (m.type === "dateSlash") {
        const dt = toDateObj(m.text);
        rendered = dt ? formatarData(dt) : m.text;
      } else if (m.type === "dateWord") rendered = m.text;
      nodes.push(<strong key={`h${k++}`}>{rendered}</strong>);
      cur = m.i + m.len;
    }
    if (cur < original.length) nodes.push(<span key={`t${k++}`}>{original.slice(cur)}</span>);
    return nodes;
  };

  const getExpLineType = (line) => {
    if (!line) return "other";
    const t = String(line).trim().toLowerCase();
    if (t.startsWith("➡") || t.startsWith("->") || t.includes("vencimento")) return "venc";
    if (t.startsWith("📌") || t.startsWith("no dia") || t.includes("foram pagos")) return "note";
    return "other";
  };

  // ---------- novas helpers para quitação/fantasma ----------
  const isParcelFantasma = (p) => {
    if (!p) return false;
    try {
      const exp = String(p.explicacao || '').trim().toUpperCase();
      return exp.includes('PARCELA FANTASMA') || exp.includes('EMPRESTIMO QUITADO') && (p.pago === 1 || p.pago === true) && (!p.valor_pago || Number(p.valor_pago) === 0);
    } catch { return false; }
  };
  const isParcelQuitadaMensagem = (p) => {
    if (!p) return false;
    try {
      const exp = String(p.explicacao || '').trim().toUpperCase();
      return exp.startsWith('EMPRESTIMO QUITADO') || exp.includes('EMPRESTIMO QUITADO:');
    } catch { return false; }
  };

  const extractCurrencyFromText = (text) => {
    if (!text) return null;
    const m = /R\$\s?([\d\.\,]+)/.exec(String(text));
    if (!m) return null;
    // transform "1.650,00" => "1650.00"
    const raw = m[1].replace(/\./g, "").replace(",", ".");
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const extractDateFromText = (text) => {
    if (!text) return null;
    // procura dd/mm/yyyy
    let m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(text));
    if (m) {
      const dd = Number(m[1]), mm = Number(m[2]) - 1, yy = Number(m[3]);
      const dt = new Date(yy, mm, dd);
      return isNaN(dt.getTime()) ? null : dt;
    }
    // procura "13 Outubro 2025" estilo
    m = /(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/.exec(String(text));
    if (m) {
      const dd = Number(m[1]), monthName = m[2], yy = Number(m[3]);
      const mi = mesesNome.findIndex(x => x.toLowerCase() === monthName.toLowerCase());
      if (mi >= 0) {
        const dt = new Date(yy, mi, dd);
        return isNaN(dt.getTime()) ? null : dt;
      }
    }
    return null;
  };

  const renderObservations = (p, parcelaId) => {
    // queremos mostrar apenas observações "reais" do usuário:
    // - se p.observacoes[] existe, usamos (filtrando notas automáticas)
    // - se p.observacao string existe, quebramos em linhas e filtramos linhas automáticas (que contenham "EMPRESTIMO QUITADO" ou "PARCELA FANTASMA" que são geradas automaticamente)
    const out = [];

    // util para detectar linha automática de quitação/fantasma
    const isAutoLine = (line) => {
      if (!line) return false;
      const t = String(line).trim().toUpperCase();
      return t.includes('EMPRESTIMO QUITADO') || t.includes('PARCELA FANTASMA') || t.startsWith('QUITER') || t.startsWith('QUITAR');
    };

    if (Array.isArray(p.observacoes) && p.observacoes.length > 0) {
      for (const item of p.observacoes) {
        if (!item) continue;
        if (typeof item === 'string') {
          if (!isAutoLine(item)) out.push({ texto: item, tipo: (p.tipo_pagamento || null), data: (p.data_pagamento || null) });
        } else if (typeof item === 'object') {
          const texto = item.texto || item.observacao || item.obs || item.note || '';
          const tipo = item.tipo || item.tipo_pagamento || item.paymentType || null;
          const data = item.data || item.data_pagamento || item.date || null;
          if (texto && !isAutoLine(texto)) out.push({ texto, tipo, data });
        }
      }
      if (out.length === 0) return null;
      return (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>📝 Observações:</div>
          <ul style={{ marginTop: 6, paddingLeft: 14 }}>
            {out.map((o, i) => (
              <li key={`${parcelaId}-obs-${i}`} style={{ marginBottom: 6, color: '#222' }}>
                <div>
                  <div>{o.texto}</div>
                  <div style={{ marginTop: 4 }}>
                    <small style={{ color: '#666', fontSize: '0.8em' }}>
                      {o.tipo ? tipoLabel(o.tipo) : ''}
                      {o.tipo && o.data ? ' · ' : ''}
                      {o.data ? formatarData(o.data) : ''}
                    </small>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    // fallback para p.observacao string
    if (p.observacao) {
      const lines = String(p.observacao).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const useful = lines.filter(l => !isAutoLine(l));
      if (useful.length === 0) return null;
      return (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>📝 Observações:</div>
          <ul style={{ marginTop: 6, paddingLeft: 14 }}>
            {useful.map((line, idx) => (
              <li key={`${parcelaId}-obs-${idx}`} style={{ marginBottom: 6, color: '#222' }}>
                <div>
                  <div>{line}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    return null;
  };

  const tipoLabel = (tipo) => {
    if (!tipo) return '';
    if (tipo === 'normal') return 'comum';
    if (tipo === 'juros') return 'juros';
    if (tipo === 'manual') return 'manual';
    if (tipo === 'desconto_proxima') return 'desconto na próxima';
    if (tipo === 'quitar') return 'quitar';
    return tipo;
  };

  // ---------- toggles ----------
  const toggleCliente = (id) => setExpandedClientes((p) => ({ ...p, [id]: !p[id] }));
  const toggleLoan = (id) => setLoanOpen((p) => (p === id ? null : id));

  const toggleMoreInfo = (parcelaId) => {
    setShowMoreInfo(prev => ({ ...prev, [parcelaId]: !prev[parcelaId] }));
  };

  // Helper para ordenar loans dentro do cliente quando há busca
  const loanMatchScore = (loan) => {
    if (!termo) return 0;
    const displayId = String(loan.codigo_cliente || loan.emprestimo_num || loan.id).toLowerCase();
    if (displayId.startsWith(termo)) return 100;
    if (displayId.includes(termo)) return 30;
    if ((String(loan.observacao || "").toLowerCase()).includes(termo)) return 10;
    return 0;
  };

  const renderExpLinesWithToggle = (explicLines, parcelaId) => {
    if (!explicLines || explicLines.length === 0) return null;
    const vencLines = explicLines.filter(l => getExpLineType(l) === 'venc');
    const otherLines = explicLines.filter(l => getExpLineType(l) !== 'venc');
    const open = !!showMoreInfo[parcelaId];

    return (
      <div style={{ marginTop: 8, fontSize: "0.85em", color: "#555", whiteSpace: "pre-line" }}>
        {otherLines.map((ln, idx) => (
          <div key={`${parcelaId}-other-${idx}`} style={{ display: "block", marginTop: idx === 0 ? 0 : 6 }}>
            {renderHighlightedText(ln)}
          </div>
        ))}

        {vencLines.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <button
              onClick={(e) => { e.stopPropagation(); toggleMoreInfo(parcelaId); }}
              style={{
                background: "transparent",
                border: "none",
                color: "#007bff",
                cursor: "pointer",
                padding: 0,
                fontSize: "0.95em",
                fontWeight: 600
              }}
            >
              {open ? "Ocultar informações ▲" : "Mais informações ▼"}
            </button>

            {open && (
              <div style={{ marginTop: 8 }}>
                {vencLines.map((ln, idx) => (
                  <div key={`${parcelaId}-venc-${idx}`} style={{ display: "block", marginTop: idx === 0 ? 0 : 6 }}>
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

  // ---------- Observações (reuso de função alterada acima) ----------
  const getObservationsForParcela = (p) => {
    // mantive para compatibilidade com outras partes do código (mas renderObservations agora faz filtragem)
    const out = [];

    if (Array.isArray(p.observacoes) && p.observacoes.length > 0) {
      for (const item of p.observacoes) {
        if (!item) continue;
        if (typeof item === 'string') {
          out.push({ texto: item, tipo: (p.tipo_pagamento || null), data: (p.data_pagamento || null) });
        } else if (typeof item === 'object') {
          const texto = item.texto || item.observacao || item.obs || item.note || '';
          const tipo = item.tipo || item.tipo_pagamento || item.paymentType || null;
          const data = item.data || item.data_pagamento || item.date || null;
          if (texto) out.push({ texto, tipo, data });
        }
      }
      return out;
    }

    if (p.observacao) {
      const lines = String(p.observacao).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        let texto = line;
        let tipo = null;
        let dataIso = null;

        const parts = line.split(/\s*—\s*/);
        if (parts.length > 1) {
          texto = parts[0].trim();
          const suffix = parts.slice(1).join(' — ').trim();
          const suffixParts = suffix.split('·').map(s => s.trim());
          if (suffixParts[0]) tipo = suffixParts[0];
          if (suffixParts[1]) {
            const s2 = suffixParts[1];
            const mSlash = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s2);
            if (mSlash) {
              const dd = Number(mSlash[1]), mm = Number(mSlash[2]) - 1, yy = Number(mSlash[3]);
              const dt = new Date(yy, mm, dd);
              if (!isNaN(dt.getTime())) dataIso = dt.toISOString();
            } else {
              const re2 = /^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})$/;
              const m2 = re2.exec(s2);
              if (m2) {
                const dd = Number(m2[1]);
                const monthName = m2[2];
                const yy = Number(m2[3]);
                const monthIndex = mesesNome.findIndex(x => x.toLowerCase() === monthName.toLowerCase());
                if (monthIndex >= 0) {
                  const dt = new Date(yy, monthIndex, dd);
                  if (!isNaN(dt.getTime())) dataIso = dt.toISOString();
                }
              }
            }
          }
        }

        out.push({ texto, tipo, data: dataIso });
      }
    }

    return out;
  };

  // ---------- UI ----------
  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: "auto", fontFamily: "sans-serif" }}>
      <h2 style={{ textAlign: "center", marginBottom: 10 }}>💰 Lista de Empréstimos</h2>

      <input
        type="text"
        placeholder="🔍 Buscar por nome ou ID"
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        style={{ width: "100%", padding: 10, fontSize: 16, marginBottom: 20, borderRadius: 6, border: "1px solid #ccc" }}
      />

      <ul style={{ listStyle: "none", padding: 0 }}>
        {clientesOrdenados.map((cliente) => {
          const loansOrig = cliente.emprestimos || [];
          const loans = termo ? [...loansOrig].sort((a,b) => loanMatchScore(b) - loanMatchScore(a)) : loansOrig;
          const matchesCliente = termo && ((cliente.nome || "").toLowerCase().includes(termo) || String(cliente.id).startsWith(termo));
          const matchesLoan = termo && loans.some(l => loanMatchScore(l) > 0);
          const expanded = !!expandedClientes[cliente.id] || (termo && (matchesCliente || matchesLoan));
          return (
            <li
              key={cliente.id}
              data-cliente-id={cliente.id}
              onClick={() => toggleCliente(cliente.id)}
              style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.04)", cursor: "pointer" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div><strong style={{ marginRight: 8 }}>👤 {cliente.nome}</strong><span style={{ color: "#666", fontSize: "0.95em" }}>({loans.length} empréstimo{loans.length!==1?'s':''})</span></div>
                <div style={{ fontSize: "0.9em", color: "#666" }}>ID {cliente.id}</div>
              </div>

              {expanded && (
                <div style={{ marginTop: 12, paddingLeft: 6 }} onClick={(e) => e.stopPropagation()}>
                  {loans.length === 0 ? (
                    <div style={{ color: "#666", padding: 8 }}>Nenhum empréstimo para este cliente.</div>
                  ) : (
                    loans.map((emp) => {
                      const displayId = emp.codigo_cliente || emp.emprestimo_num || emp.id;
                      return (
                        <div key={emp.id} style={{ marginBottom: 12, padding: 10, borderRadius: 6, border: "1px solid #eee", background: "#fafafa" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <div><strong>ID:</strong> {displayId}</div>
                            <div><strong>Cliente:</strong> {nomeCliente(emp.cliente_id)}</div>

                            <div><strong>Modalidade:</strong> {emp.modalidade === "aberto" ? "Em aberto" : "Parcelado"}</div>
                            <div><strong>Valor original:</strong> {formatarMoeda(emp.valor)}</div>

                            <div><strong>Total pago:</strong> {formatarMoeda(emp.total_pago || 0)}</div>
                            <div><strong>Capital restante:</strong> {formatarMoeda(emp.capital_restante || 0)}</div>

                            <div><strong>Data de início do empréstimo:</strong> {formatarData(emp.data)}</div>
                            <div><strong>Tempo passado:</strong> {calcularTempoPassado(emp.data)}</div>

                            <div><strong>Observação:</strong> {emp.observacao || "-"}</div>
                            <div><strong>Próximo vencimento:</strong> {getProximoVencimento(emp)}</div>
                          </div>

                          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                            <button onClick={(e) => { e.stopPropagation(); toggleLoan(emp.id); }} style={{ padding: "6px 10px", background: "#007bff", color: "#fff", border: "none", borderRadius: 4 }}>
                              {loanOpen === emp.id ? "Esconder Parcelas" : "Mostrar Parcelas"}
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setEditarId(emp.id); }} style={{ padding: "6px 10px", background: "#ffc107", color: "#000", border: "none", borderRadius: 4 }}>
                              ✏️ Editar
                            </button>

                            <div style={{ marginLeft: "auto" }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); excluirEmprestimo(emp.id); }}
                                title="Excluir empréstimo"
                                style={{
                                  padding: "6px 10px",
                                  background: "#dc3545",
                                  color: "#fff",
                                  border: "none",
                                  borderRadius: 4,
                                  cursor: "pointer"
                                }}
                              >
                                🗑️ Excluir
                              </button>
                            </div>
                          </div>

                          {loanOpen === emp.id && (
                            <div style={{ marginTop: 12, background: "#fff", borderRadius: 6, padding: 10, border: "1px solid #eee" }}>
                              <h4 style={{ margin: "6px 0" }}>📅 Parcelas</h4>
                              {emp.parcelasDetalhes && emp.parcelasDetalhes.length > 0 ? (
                                <ul style={{ listStyle: "none", paddingLeft: 0 }}>
                                  {emp.parcelasDetalhes.filter(p => p.numero !== -1).map((p) => {
                                    const parcelaId = p.parcela_id || p.id;
                                    const totalExibido = p.valor_com_desconto || p.valor_total;
                                    const totalPago = p.valor_pago || 0;
                                    const excedente = Math.max(0, totalPago - totalExibido);

                                    const explicLines = String(p.explicacao || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                                    const lastExpType = explicLines.length ? getExpLineType(explicLines[explicLines.length - 1]) : null;
                                    const valorPagoMarginTop = lastExpType === "note" ? 16 : 8;

                                    // nova lógica: detectar parcela "fantasma" e parcela quitada
                                    const fantasma = isParcelFantasma(p);
                                    const quitadaMsg = isParcelQuitadaMensagem(p);

                                    // extrai valor de quitação (se existir) a partir da explicacao (ex: "Devido ao pagamento de R$ 880,00")
                                    const valorQuitacao = extractCurrencyFromText(p.explicacao);

                                    // extrai data de quitação a partir da explicacao (se existir), preferir p.data_pagamento quando disponível
                                    const dataQuitacao = toDateObj(p.data_pagamento) || extractDateFromText(p.explicacao);

                                    return (
                                      <li
                                        key={parcelaId}
                                        style={{
                                          marginBottom: 8,
                                          borderBottom: "1px dashed #eee",
                                          paddingBottom: 6,
                                          backgroundColor: p.renegociada ? "#fff7e6" : "transparent",
                                          opacity: fantasma ? 0.45 : 1,
                                          color: fantasma ? '#666' : '#000',
                                          fontStyle: fantasma ? 'italic' : 'normal'
                                        }}
                                      >
                                        <div>
                                          <strong>{p.numero}ª parcela{p.renegociada ? " (Renegociada)" : ""}:</strong>{" "}
                                          <span style={{ fontWeight: 600 }}>{formatarMoeda(totalExibido)}</span>
                                          {p.valor_original && p.valor_original !== totalExibido && (
                                            <span style={{ fontSize: "0.85em", color: "#888", marginLeft: 8 }}>(Original: {formatarMoeda(p.valor_original)})</span>
                                          )}
                                        </div>

                                        <div style={{ marginTop: 6 }}>
                                          <small style={{ color: "#333" }}>
                                            Capital: <strong>{formatarMoeda(p.valor_capital)}</strong> {" | "}
                                            Juros: <strong>{formatarMoeda(p.valor_juros)}</strong> {" | "}
                                            Juros Adicionais: <strong>{formatarMoeda(p.juros_adicionais || 0)}</strong>
                                          </small>
                                        </div>

                                        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12 }}>
                                          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            Vencimento:
                                            <input type="date" value={dataParaInput(p.vencimento)} onChange={(e) => { e.stopPropagation(); atualizarVencimento(parcelaId, e.target.value); }} style={{ padding: 6 }} />
                                          </label>
                                          <div style={{ fontSize: "0.95em", color: "#333" }}>{formatarData(p.vencimento)}</div>
                                        </div>

                                        {/* destaque se foi a parcela onde o empréstimo foi quitado */}
                                        {quitadaMsg && (
                                          <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: '#e6fff0', border: '1px solid #bfe6c9', color: '#064d24', fontWeight: 700 }}>
                                            {/* mostra a explicação completa (curta) */}
                                            {p.explicacao}
                                          </div>
                                        )}

                                        {/* se não for a parcela quitada, renderiza linhas de explicação normais */}
                                        {!quitadaMsg && renderExpLinesWithToggle(explicLines, parcelaId)}

                                        <div style={{ marginTop: valorPagoMarginTop }}>
                                          <div>
                                            Valor Pago: {
                                              // se foi a parcela de quitação, priorizar mostrar o valor da quitação extraído
                                              quitadaMsg && valorQuitacao
                                                ? <strong>{formatarMoeda(valorQuitacao)}</strong>
                                                : totalPago > 0
                                                  ? <strong>{formatarMoeda(totalPago)}</strong>
                                                  : "-"
                                            }
                                          </div>

                                          {/* Se a parcela foi a quitada, mostramos o tipo_quitar; caso contrário mostramos tipo normal se existir */}
                                          {p.tipo_pagamento && (
                                            <div style={{ fontSize: "0.85em", color: "#555", marginTop: 6 }}>
                                              Tipo de pagamento: {
                                                p.tipo_pagamento === "desconto_proxima" ? "Desconto na próxima parcela"
                                                : p.tipo_pagamento === "normal" ? "Pagamento normal"
                                                : p.tipo_pagamento === "quitar" ? "Quitar empréstimo"
                                                : p.tipo_pagamento === "abatimento" ? "Abatimento"
                                                : p.tipo_pagamento
                                              }
                                            </div>
                                          )}

                                          {excedente > 0 && <div style={{ fontSize: "0.85em", color: "#555", marginTop: 6 }}>(inclui {formatarMoeda(excedente)} de excedente)</div>}
                                        </div>

                                        <div style={{ marginTop: 8 }}>
                                          Data Pagamento: {
                                            // Para parcelas "fantasma" deixamos '-' (já não há pagamento por parcela),
                                            // para parcela quitada usamos a data de quitação (p.data_pagamento ou extraída)
                                            fantasma ? '-' : (dataQuitacao ? formatarData(dataQuitacao) : formatarData(p.data_pagamento))
                                          }
                                        </div>

                                        {/* Observações: apenas mostramos observações que não sejam a mensagem automática de quitação/fantasma */}
                                        {renderObservations(p, parcelaId)}

                                        {/* Se for parcela fantasma, mostramos um pequeno rótulo (sem repetir "PARCELA FANTASMA:" cru) */}
                                        {fantasma && !quitadaMsg && (
                                          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "#fafafa", color: "#666", fontSize: "0.95em" }}>
                                            {/* tenta extrair data da explicação para fornecer "Empréstimo quitado em ..." */}
                                            {(() => {
                                              const dt = extractDateFromText(p.explicacao) || toDateObj(p.data_pagamento);
                                              return dt ? `Empréstimo quitado em ${pad(dt.getDate())} ${mesesNome[dt.getMonth()]} ${dt.getFullYear()}.` : `Empréstimo quitado.`;
                                            })()}
                                          </div>
                                        )}

                                        <div style={{ marginTop: 6 }}>{p.pago ? <span style={{ color: "green" }}>✅ Pago</span> : totalPago > 0 ? <span style={{ color: "orange" }}>⚠️ Parcialmente pago</span> : <span style={{ color: "red" }}>❌ Pendente</span>}</div>
                                      </li>
                                    );
                                  })}
                                </ul>
                              ) : (
                                <p style={{ color: "gray" }}>Nenhuma parcela registrada.</p>
                              )}
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

      {editarId && <EditarEmprestimo emprestimoId={editarId} onClose={() => { setEditarId(null); carregarEmprestimos(); }} />}
    </div>
  );
}