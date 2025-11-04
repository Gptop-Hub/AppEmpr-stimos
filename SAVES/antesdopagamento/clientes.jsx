import React, { useEffect, useState } from "react";
import axios from "axios";
import EditarCliente from "./editarcliente";
import NovoEmprestimo from "./novoemprestimo";
import EditarEmprestimo from "./editaremprestimo";

export default function Clientes() {
  const [clientes, setClientes] = useState([]);
  const [emprestimos, setEmprestimos] = useState([]);
  const [selecionadoId, setSelecionadoId] = useState(null);
  const [clienteEditando, setClienteEditando] = useState(null);
  const [emprestimoEditando, setEmprestimoEditando] = useState(null);
  const [mostrar, setMostrar] = useState(false);
  const [busca, setBusca] = useState("");
  const [mostrarDetalhes, setMostrarDetalhes] = useState({});
  const [clickTimeout, setClickTimeout] = useState(null);
  // Novo estado para ordenação
  const [ordenacao, setOrdenacao] = useState("idCrescente"); // padrão alterado para id crescente

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

  function calcularTotal(clienteId) {
    return emprestimos
      .filter(e => e.cliente_id === clienteId)
      .reduce((soma, emp) => soma + (emp.valor || 0), 0);
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
        case "idCrescente": // NOVA opção de ordenação
          return a.id - b.id; // ordenação numérica crescente por ID
        case "nomeAZ":
          return a.nome.toLowerCase().localeCompare(b.nome.toLowerCase());
        case "nomeZA":
          return b.nome.toLowerCase().localeCompare(a.nome.toLowerCase());
        case "maisAntigos":
          return new Date(a.criadoEm) - new Date(b.criadoEm);
        case "maisNovos":
          return new Date(b.criadoEm) - new Date(a.criadoEm);
        case "maiorValor":
          return calcularTotal(b.id) - calcularTotal(a.id);
        case "menorValor":
          return calcularTotal(a.id) - calcularTotal(b.id);
        default:
          return a.id - b.id; // para garantir que padrão é id crescente
      }
    });

  function excluirCliente(clienteId, clienteNome) {
    const senha = prompt("Digite a senha para excluir:");
    if (senha !== "admin123") { alert("Senha incorreta."); return; }
    if (!window.confirm(`⚠️ Deseja excluir "${clienteNome}"?`)) return;
    axios.delete(`http://localhost:3001/clientes/${clienteId}`)
      .then(() => { alert("Cliente excluído."); carregarDados(); setSelecionadoId(null); })
      .catch(() => alert("Erro ao excluir."));
  }

  function abrirEdicao(clienteId) {
    const senha = prompt("Digite a senha para editar:");
    if (senha !== "admin123") { alert("Senha incorreta."); return; }
    const cliente = clientes.find(c => c.id === clienteId);
    setClienteEditando(cliente);
  }

  function formatarData(dataStr) {
    if (!dataStr) return "Não informado";
    return new Date(dataStr).toLocaleDateString("pt-BR", {
      day: "2-digit", month: "long", year: "numeric"
    });
  }

  function formatarMoeda(v) {
    return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function EmprestimosCliente({ clienteId, emprestimosCliente, onEmprestimoSalvo }) {
    const [showForm, setShowForm] = useState(false);

    function totalPago(e) {
      return e.valor_pago || 0;
    }

    return (
      <div style={{ marginTop: 20, borderTop: "1px solid #ccc", paddingTop: 10 }}
        onClick={e => e.stopPropagation()}>
        <h4>
          💰 Empréstimos ({emprestimosCliente.length})
          {!showForm && (
            <button onClick={e => { e.stopPropagation(); setShowForm(true); }}
              style={{ marginLeft: 10, padding: "4px 8px", cursor: "pointer" }}>+ Novo Empréstimo</button>
          )}
          {showForm && (
            <button onClick={e => { e.stopPropagation(); setShowForm(false); }}
              style={{
                marginLeft: 10,
                padding: "4px 8px",
                background: "#dc3545",
                color: "white",
                border: "none",
                borderRadius: 3,
                cursor: "pointer"
              }}>✖ Fechar</button>
          )}
        </h4>

        {showForm && (
          <div style={{
            border: "1px solid #4caf50",
            background: "#e8f5e9",
            borderRadius: 6,
            padding: 15,
            marginBottom: 20,
            maxWidth: 500
          }} onClick={e => e.stopPropagation()}>
            <NovoEmprestimo
              clienteId={clienteId}
              onSalvo={() => { setShowForm(false); onEmprestimoSalvo(); }}
              onCancelar={() => setShowForm(false)}
            />
          </div>
        )}

        <ul style={{ listStyle: "none", padding: 0 }}>
          {emprestimosCliente.map((e, index) => {
            let parcelasParaMostrar = [];

            if (e.parcelasDetalhes && e.parcelasDetalhes.length > 0) {
              parcelasParaMostrar = e.parcelasDetalhes;
            } else if (e.modalidade === "parcelado" && e.parcelas) {
              const preview = [];
              const total = e.valor;
              const taxa = (e.taxa_juros || 0) / 100;
              const m = e.parcelas;
              let saldo = total;
              const amort = total / m;
              for (let i = 1; i <= m; i++) {
                const jurosVal = saldo * taxa;
                const totalParc = amort + jurosVal;
                preview.push({ numero: i, valor_capital: amort, valor_juros: jurosVal, valor_total: totalParc });
                saldo -= amort;
              }
              parcelasParaMostrar = preview;
            }

            return (
              <li key={e.id} style={{
                border: "1px solid #ddd",
                borderRadius: 6,
                padding: 10,
                marginBottom: 12,
                background: "#fafafa",
                position: "relative"
              }}>
                <p><strong>Código do empréstimo:</strong> {index + 1}</p>

                <p><strong>Valor:</strong> {formatarMoeda(e.valor)}</p>

                {e.modalidade === "parcelado" && parcelasParaMostrar.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <h5>Parcelas:</h5>
                    <ul style={{ listStyle: "none", paddingLeft: 0 }}>
                      {parcelasParaMostrar.map(p => (
                        <li key={p.numero} style={{ marginBottom: 4 }}>
                          {p.numero}ª: {formatarMoeda(p.valor_total)}<br />
                          (Capital: {formatarMoeda(p.valor_capital)}, Juros: {formatarMoeda(p.valor_juros)})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p><strong>Data:</strong> {formatarData(e.data)}</p>
                <p><strong>Observação:</strong> {e.observacao || "-"}</p>
                <p><strong>Total pago:</strong> {formatarMoeda(totalPago(e))}</p>

                <button
                  onClick={event => {
                    event.stopPropagation();
                    const senha = prompt("Digite a senha para editar o empréstimo:");
                    if (senha === "admin123") {
                      setEmprestimoEditando(e.id);
                    } else {
                      alert("Senha incorreta.");
                    }
                  }}
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    fontSize: 12,
                    padding: "4px 8px",
                    background: "#ffc107",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer"
                  }}
                >
                  ✏️ Editar Empréstimo
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  const mostrarLista = mostrar || busca.trim() !== "";

  return (
    <div style={{ padding: 20, maxWidth: 700, margin: "auto" }}>
      <h2 style={{ textAlign: "center" }}>Clientes</h2>

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
          <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
            <button onClick={() => setMostrar(!mostrar)}>
              {mostrar ? "Ocultar" : "Mostrar"} Registrados
            </button>
            <input
              type="text"
              placeholder="Buscar..."
              value={busca}
              onChange={e => setBusca(e.target.value)}
              style={{ flex: 1, padding: 8 }}
            />
            {/* Select para escolher ordenação */}
            <select
              value={ordenacao}
              onChange={e => setOrdenacao(e.target.value)}
              style={{ padding: 8, borderRadius: 4 }}
            >
              <option value="idCrescente">ID Crescente (do menor para maior)</option>
              <option value="nomeAZ">Nome A-Z</option>
              <option value="nomeZA">Nome Z-A</option>
              <option value="maisAntigos">Clientes mais antigos</option>
              <option value="maisNovos">Clientes mais novos</option>
              <option value="maiorValor">Maior valor emprestado</option>
              <option value="menorValor">Menor valor emprestado</option>
            </select>
          </div>

          {mostrarLista && (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {filtrar.map(c => (
                <li
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
                      }, 250);
                      setClickTimeout(t);
                    }
                  }}
                  onDoubleClick={() => {
                    if (clickTimeout) {
                      clearTimeout(clickTimeout);
                      setClickTimeout(null);
                    }
                    setSelecionadoId(null);
                  }}
                  style={{
                    padding: 12,
                    marginBottom: 8,
                    backgroundColor: "#f9f9f9",
                    borderRadius: 6,
                    cursor: "pointer",
                    boxShadow: selecionadoId === c.id ? "0 0 0 2px #007bff" : "none"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong>{c.nome} (ID: {c.id})</strong>
                    {selecionadoId === c.id && (
                      <button
                        onClick={e => { e.stopPropagation(); abrirEdicao(c.id); }}
                        style={{
                          fontSize: 12,
                          padding: "4px 8px",
                          background: "#ffc107",
                          border: "none",
                          borderRadius: 4,
                          cursor: "pointer"
                        }}
                      >
                        ✏️ Editar Cliente
                      </button>
                    )}
                  </div>

                  {selecionadoId === c.id && (
                    <div style={{ marginTop: 10, lineHeight: 1.5 }}>
                      <p><strong>CPF:</strong> {c.cpf}</p>
                      <p><strong>Telefone:</strong> {c.telefone}</p>

                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setMostrarDetalhes(prev => ({ ...prev, [c.id]: !prev[c.id] }));
                        }}
                        style={{
                          fontSize: 12,
                          margin: "10px 0",
                          padding: "2px 6px",
                          cursor: "pointer",
                          border: "1px solid #007bff",
                          borderRadius: 4,
                          background: "transparent",
                          color: "#007bff"
                        }}
                      >
                        {mostrarDetalhes[c.id] ? "Ocultar detalhes pessoais" : "Mostrar detalhes pessoais"}
                      </button>

                      {mostrarDetalhes[c.id] && (
                        <>
                          <div>
                            <h4>📍 Endereço</h4>
                            {c.endereco
                              ? c.endereco.split(",").map((p, i) => <p key={i}>{p.trim()}</p>)
                              : <p style={{ color: "gray" }}>Nenhuma informação</p>}
                          </div>
                          <div style={{ marginTop: 10 }}>
                            <h4>💼 Trabalho</h4>
                            {c.trabalho
                              ? c.trabalho.split(",").map((p, i) => <p key={i}>{p.trim()}</p>)
                              : <p style={{ color: "gray" }}>Nenhuma informação</p>}
                          </div>
                          <p><strong>Referência:</strong> {c.referencia}</p>
                          <p><strong>Observação:</strong> {c.observacao}</p>
                          <p><strong>Cliente desde:</strong> {formatarData(c.criadoEm)}</p>
                        </>
                      )}

                      <EmprestimosCliente
                        clienteId={c.id}
                        emprestimosCliente={emprestimos.filter(e => e.cliente_id === c.id)}
                        onEmprestimoSalvo={carregarDados}
                      />

                      <div style={{ textAlign: "right", marginTop: 15 }}>
                        <button
                          onClick={e => { e.stopPropagation(); excluirCliente(c.id, c.nome); }}
                          style={{
                            fontSize: 12,
                            padding: "4px 8px",
                            background: "#ff4d4d",
                            color: "white",
                            border: "none",
                            borderRadius: 4,
                            cursor: "pointer"
                          }}
                        >
                          🗑️ Excluir
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}