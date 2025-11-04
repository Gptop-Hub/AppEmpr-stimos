// src/componentes/historico.jsx
import React, { useEffect, useState } from "react";
import axios from "axios";

export default function Historico() {
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState(null);
  const [httpStatus, setHttpStatus] = useState(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setErro(null);

    const url = "http://localhost:3001/emprestimos/historico";
    console.info("[Historico] requisitando:", url);

    axios.get(url, { timeout: 8000 })
      .then(res => {
        console.info("[Historico] status:", res.status);
        console.log("[Historico] resposta headers:", res.headers);
        console.log("[Historico] body:", res.data);
        if (!mounted) return;
        setHttpStatus(res.status);
        setDados(res.data || []);
        setLoading(false);
      })
      .catch(err => {
        console.error("[Historico] erro ao requisitar:", err && err.toJSON ? err.toJSON() : err);
        if (!mounted) return;
        if (err.response) {
          // erro retornado pelo servidor (status 4xx/5xx)
          setHttpStatus(err.response.status);
          setErro(`Servidor respondeu ${err.response.status}: ${err.response.data && err.response.data.error ? err.response.data.error : JSON.stringify(err.response.data)}`);
        } else if (err.request) {
          // requisição feita, sem resposta
          setErro("Nenhuma resposta do servidor. Verifique se o backend está rodando e se a URL está correta.");
        } else {
          setErro("Erro ao montar requisição: " + err.message);
        }
        setLoading(false);
      });

    return () => { mounted = false; };
  }, []);

  const formatarMoeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const pad = (n) => String(n).padStart(2, "0");
  const mesesNome = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  const formatarData = (d) => {
    if (!d) return "-";
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "-";
    return `${pad(dt.getDate())} ${mesesNome[dt.getMonth()]} ${dt.getFullYear()}`;
  };

  if (loading) return <div style={{ padding: 20 }}>Carregando histórico...</div>;
  if (erro) return (
    <div style={{ padding: 20 }}>
      <h3 style={{ color: "red" }}>Erro ao carregar histórico</h3>
      <div style={{ color: "#333", marginTop: 8 }}>{erro}</div>
      <div style={{ color: "#666", marginTop: 8 }}>HTTP status: {httpStatus || "—"}</div>
      <div style={{ marginTop: 12, color: "#666" }}>Verifique Console (F12) e Backend.</div>
    </div>
  );

  if (!Array.isArray(dados) || dados.length === 0) {
    return <div style={{ padding: 20, color: "#666" }}>Nenhum empréstimo finalizado encontrado.</div>;
  }

  // agrupamento por cliente
  const agrupado = dados.reduce((acc, e) => {
    const id = e.cliente_id || "desconhecido";
    acc[id] = acc[id] || { cliente_id: id, cliente_nome: e.cliente_nome || "Desconhecido", emprestimos: [] };
    acc[id].emprestimos.push(e);
    return acc;
  }, {});
  const grupos = Object.values(agrupado);

  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: "auto", fontFamily: "'Segoe UI', sans-serif" }}>
      <h2 style={{ textAlign: "center", marginBottom: 16 }}>📜 Histórico de Empréstimos</h2>
      <div style={{ marginBottom: 12, color: "#666" }}>Total clientes com histórico: {grupos.length}</div>

      <div style={{ display: "grid", gap: 12 }}>
        {grupos.map(g => (
          <div key={g.cliente_id} style={{ border: "1px solid #eee", padding: 12, borderRadius: 8, background: "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 16 }}>{g.cliente_nome}</strong>
              <span style={{ color: "#666" }}>ID: {g.cliente_id}</span>
            </div>

            <div style={{ marginTop: 10 }}>
              {g.emprestimos.map(emp => (
                <div key={emp.id} style={{ padding: 10, borderRadius: 6, border: "1px solid #f0f0f0", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div><strong>{emp.codigo_cliente || emp.id}</strong> — {formatarMoeda(emp.valor)}</div>
                    <div style={{ color: "#666" }}>Início: {formatarData(emp.data)}</div>
                  </div>

                  <div style={{ marginTop: 8, fontSize: 14, color: "#333" }}>
                    <div>Total pago: {formatarMoeda(emp.total_pago || 0)}</div>
                    <div>Capital restante: {formatarMoeda(emp.capital_restante || 0)}</div>
                    {emp.parcelasDetalhes && emp.parcelasDetalhes.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <em style={{ color: "#666" }}>Parcelas ({emp.parcelasDetalhes.length}):</em>
                        <ul style={{ marginTop: 6, paddingLeft: 16 }}>
                          {emp.parcelasDetalhes.map(p => (
                            <li key={p.id} style={{ color: p.pago ? '#0a0' : '#444' }}>
                              {p.numero}ª — {formatarMoeda(p.valor_total)} — {p.pago ? 'Pago' : 'Não pago'} {p.data_pagamento ? `(${formatarData(p.data_pagamento)})` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {emp.observacao ? <div style={{ marginTop: 8, color: "#444" }}><strong>Obs:</strong> {emp.observacao}</div> : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}