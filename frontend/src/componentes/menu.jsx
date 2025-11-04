import React from "react";
import { NavLink } from "react-router-dom";

const menuItens = [
  { nome: "Clientes", to: "/clientes", icone: "👥" },
  { nome: "Novo Cliente", to: "/novocliente", icone: "➕" },
  { nome: "Novo Empréstimo", to: "/novoemprestimo", icone: "💳" },
  { nome: "Pagamento", to: "/pagamento", icone: "💵" },
  { nome: "Empréstimos", to: "/emprestimos", icone: "💰" },
  { nome: "Histórico", to: "/historico", icone: "📜" },
  { nome: "Notificações", to: "/notificacoes", icone: "🔔" },
  { nome: "Relatório", to: "/relatorio", icone: "📈" },
  { nome: "Backup", to: "/backup", icone: "🗄️" },
  { nome: "Atualizações", to: "/atualizacoes", icone: "⚙️" }, // ⬅️ novo item
];

export default function Menu() {
  return (
    <nav
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#1f2937",
        padding: "10px 20px",
        borderRadius: 8,
        fontFamily: "'Segoe UI', sans-serif",
      }}
    >
      <h2
        style={{
          color: "#fff",
          marginBottom: 10,
          textAlign: "center",
          fontSize: 20,
        }}
      >
        Sistema de Empréstimos
      </h2>

      <ul
        style={{
          display: "flex",
          justifyContent: "space-around",
          listStyle: "none",
          padding: 0,
          margin: 0,
          flexWrap: "wrap",
          gap: 4,
        }}
      >
        {menuItens.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              style={({ isActive }) => ({
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                textDecoration: "none",
                padding: "8px 12px",
                borderRadius: 8,
                color: isActive ? "#fff" : "#cbd5e1",
                backgroundColor: isActive ? "#3b82f6" : "transparent",
                fontWeight: 500,
                fontSize: 14,
                transition: "0.3s",
              })}
            >
              <span style={{ fontSize: 20 }}>{item.icone}</span>
              {item.nome}
            </NavLink>
          </li>
        ))}
      </ul>

      <div
        style={{
          marginTop: 10,
          textAlign: "center",
          color: "#94a3b8",
          fontSize: 12,
        }}
      >
        © 2025 Sistema de Empréstimos
      </div>
    </nav>
  );
}