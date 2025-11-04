import React, { useEffect, useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import EditarCliente from "./editarcliente";
import EditarEmprestimo from "./editaremprestimo";
import notify from "../ui/notify";

export default function Clientes() {
  const navigate = useNavigate();

  const [clientes, setClientes] = useState([]);
  const [emprestimos, setEmprestimos] = useState([]);
  const [selecionadoId, setSelecionadoId] = useState(null);
  const [clienteEditando, setClienteEditando] = useState(null);
  const [emprestimoEditando, setEmprestimoEditando] = useState(null);
  const [mostrar, setMostrar] = useState(false);
  const [busca, setBusca] = useState("");
  const [mostrarDetalhes, setMostrarDetalhes] = useState({});
  const [clickTimeout, setClickTimeout] = useState(null);
  const [ordenacao, setOrdenacao] = useState("idCrescente");

  useEffect(() => {
    carregarDados();
  }, []);

  function carregarDados() {
    axios.get("http://localhost:3001/clientes")
      .then(res => setClientes(res.data))
      .catch(err => console.error(err));
    axios.get("http://localhost:3001/emprestimos")
      .then(res => setEmprestimos(res.data))
      .catch(err => console.error(err));
  }

  async function excluirCliente(clienteId, clienteNome) {
    const senha = await notify.prompt("Digite a senha para excluir:", {
      type: "password",
      okText: "Confirmar",
    });
    if (senha !== "admin123") {
      notify.error("Senha incorreta.");
      return;
    }
    const confirmarExclusao = await notify.confirm(`Deseja excluir "${clienteNome}"?`);
    if (!confirmarExclusao) return;
    try {
      await axios.delete(`http://localhost:3001/clientes/${clienteId}`);
      notify.success("Cliente excluido.");
      carregarDados();
      setSelecionadoId(null);
    } catch (err) {
      console.error(err);
      notify.error("Erro ao excluir.");
    }
  }

  async function abrirEdicao(clienteId) {
    const senha = await notify.prompt("Digite a senha para editar:", {
      type: "password",
      okText: "Confirmar",
    });
    if (senha !== "admin123") {
      notify.error("Senha incorreta.");
      return;
    }
    const cliente = clientes.find((c) => c.id === clienteId);
    setClienteEditando(cliente);
  }

  function formatarData(dataStr) {
    if (!dataStr) return "Não informado";
    return new Date(dataStr).toLocaleDateString("pt-BR", {
      day: "2-digit", month: "long", year: "numeric"
    });
  }

  function contarEmprestimos(clienteId) {
    return emprestimos.filter(e => e.cliente_id === clienteId).length;
  }

  function irParaEmprestimos(clienteId) {
    navigate(`/emprestimos?cliente=${clienteId}`);
  }

  const filtrar = clientes
    .filter(c => {
      const b = busca.trim().toLowerCase();
      if (!b) return true;
      const numBusca = Number(b);
      if (!isNaN(numBusca) && b === numBusca.toString()) {
        return c.id.toString().startsWith(b);
      }
      return c.nome.toLowerCase().includes(b);
    })
    .sort((a, b) => {
      const termo = busca.trim().toLowerCase();
      const isBuscaNumero = !isNaN(Number(termo)) && termo !== "";

      const aIdStr = a.id.toString();
      const bIdStr = b.id.toString();

      const aIdComeca = isBuscaNumero ? aIdStr.startsWith(termo) : false;
      const bIdComeca = isBuscaNumero ? bIdStr.startsWith(termo) : false;

      const aNomeComeca = a.nome.toLowerCase().startsWith(termo);
      const bNomeComeca = b.nome.toLowerCase().startsWith(termo);

      if (aIdComeca && !bIdComeca) return -1;
      if (!aIdComeca && bIdComeca) return 1;

      if (aNomeComeca && !bNomeComeca) return -1;
      if (!aNomeComeca && bNomeComeca) return 1;

      switch (ordenacao) {
        case "idCrescente": return a.id - b.id;
        case "nomeAZ": return a.nome.toLowerCase().localeCompare(b.nome.toLowerCase());
        case "nomeZA": return b.nome.toLowerCase().localeCompare(a.nome.toLowerCase());
        case "maisAntigos": return new Date(a.criadoEm) - new Date(b.criadoEm);
        case "maisNovos": return new Date(b.criadoEm) - new Date(a.criadoEm);
        case "maiorValor": return contarEmprestimos(b.id) - contarEmprestimos(a.id);
        case "menorValor": return contarEmprestimos(a.id) - contarEmprestimos(b.id);
        default: return a.id - b.id;
      }
    });

  const mostrarLista = mostrar || busca.trim() !== "";

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: "auto", fontFamily: "'Segoe UI', sans-serif" }}>
      <h2 style={{ textAlign: "center", marginBottom: 20, color: "#333" }}>Clientes</h2>

      {clienteEditando ? (
        <EditarCliente
          cliente={clienteEditando}
          onCancel={() => setClienteEditando(null)}
          onSalvo={() => { setClienteEditando(null); carregarDados(); }}
        />
      ) : emprestimoEditando ? (
        <EditarEmprestimo
          emprestimoId={emprestimoEditando}
          onClose={() => { setEmprestimoEditando(null); carregarDados(); }}
        />
      ) : (
        <>
          {/* Barra de busca e filtros */}
          <div style={{
            display: "flex",
            gap: 10,
            marginBottom: 20,
            flexWrap: "wrap",
            alignItems: "center"
          }}>
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
              placeholder="🔍 Buscar por nome ou ID..."
              value={busca}
              onChange={e => setBusca(e.target.value)}
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid #ccc",
                fontSize: 16
              }}
            />

            <select
              value={ordenacao}
              onChange={e => setOrdenacao(e.target.value)}
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid #ccc",
                fontSize: 16
              }}
            >
              <option value="idCrescente">ID Crescente</option>
              <option value="nomeAZ">Nome A-Z</option>
              <option value="nomeZA">Nome Z-A</option>
              <option value="maisAntigos">Clientes mais antigos</option>
              <option value="maisNovos">Clientes mais novos</option>
              <option value="maiorValor">Maior valor emprestado</option>
              <option value="menorValor">Menor valor emprestado</option>
            </select>
          </div>

          {/* Lista de clientes */}
          {mostrarLista && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }}>
              {filtrar.map(c => (
                <div
                  key={c.id}
                  onClick={() => {
                    if (clickTimeout) {
                      clearTimeout(clickTimeout);
                      setClickTimeout(null);
                      setSelecionadoId(null);
                    } else {
                      const t = setTimeout(() => {
                        setSelecionadoId(c.id);
                        setMostrarDetalhes(prev => ({ ...prev, [c.id]: false }));
                        setClickTimeout(null);
                      }, 200);
                      setClickTimeout(t);
                    }
                  }}
                  style={{
                    backgroundColor: "#fff",
                    borderRadius: 12,
                    boxShadow: selecionadoId === c.id ? "0 4px 15px rgba(0,123,255,0.25)" : "0 2px 6px rgba(0,0,0,0.1)",
                    padding: 16,
                    cursor: "pointer",
                    transition: "0.3s",
                    border: selecionadoId === c.id ? "2px solid #007bff" : "1px solid #eee"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h3 style={{ margin: 0, fontSize: 18, color: "#333" }}>{c.nome}</h3>
                    <span style={{ fontWeight: 600, color: "#555" }}>ID: {c.id}</span>
                  </div>

                  {/* CPF e Telefone sempre visíveis */}
                  <p style={{ margin: "6px 0", color: "#666" }}><strong>CPF:</strong> {c.cpf}</p>
                  <p style={{ margin: "6px 0", color: "#666" }}><strong>Telefone:</strong> {c.telefone}</p>

                  {/* Toggle detalhes pessoais */}
                  <button
                    onClick={e => { e.stopPropagation(); setMostrarDetalhes(prev => ({ ...prev, [c.id]: !prev[c.id] })); }}
                    style={{
                      fontSize: 14,
                      padding: "6px 10px",
                      cursor: "pointer",
                      border: "1px solid #007bff",
                      borderRadius: 6,
                      backgroundColor: "transparent",
                      color: "#007bff",
                      marginTop: 6
                    }}
                  >
                    {mostrarDetalhes[c.id] ? "Ocultar detalhes pessoais" : "Mostrar detalhes pessoais"}
                  </button>

                  {mostrarDetalhes[c.id] && (
                    <div style={{ marginTop: 10, lineHeight: 1.5, color: "#444" }}>
                      <div>
                        <h4 style={{ marginBottom: 4 }}>📍 Endereço</h4>
                        {c.endereco ? c.endereco.split(",").map((p,i) => <p key={i}>{p.trim()}</p>) : <p style={{ color: "gray" }}>Nenhuma informação</p>}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <h4 style={{ marginBottom: 4 }}>💼 Trabalho</h4>
                        {c.trabalho ? c.trabalho.split(",").map((p,i) => <p key={i}>{p.trim()}</p>) : <p style={{ color: "gray" }}>Nenhuma informação</p>}
                      </div>
                      <p><strong>Referência:</strong> {c.referencia}</p>
                      <p><strong>Observação:</strong> {c.observacao}</p>
                      <p><strong>Cliente desde:</strong> {formatarData(c.criadoEm)}</p>
                    </div>
                  )}

                  {/* Botões ação */}
                  {selecionadoId === c.id && (
                    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await abrirEdicao(c.id);
                        }}
                        style={{
                          flex: 1, padding: "8px 10px", borderRadius: 6,
                          border: "none", backgroundColor: "#007bff", color: "#fff", cursor: "pointer"
                        }}
                      >
                        ✏️ Editar
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await excluirCliente(c.id, c.nome);
                        }}
                        style={{
                          flex: 1, padding: "8px 10px", borderRadius: 6,
                          border: "none", backgroundColor: "#ff4b5c", color: "#fff", cursor: "pointer"
                        }}
                      >
                        🗑️ Excluir
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); irParaEmprestimos(c.id); }}
                        style={{
                          flex: 1, padding: "8px 10px", borderRadius: 6,
                          border: "none", backgroundColor: "#28a745", color: "#fff", cursor: "pointer"
                        }}
                      >
                        💰 Empréstimos: {contarEmprestimos(c.id)}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
