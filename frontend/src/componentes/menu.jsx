import React, { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";

import { API_BASE_URL } from "../axios-setup.js";

const API_BASE = API_BASE_URL;

const ICONS = {
  seguranca: (
    <><path d="M12 3 4.5 6v5.2c0 4.2 3 7.7 7.5 9.8 4.5-2.1 7.5-5.6 7.5-9.8V6L12 3Z" /><path d="m8.5 12 2.3 2.3 4.7-4.7" /></>
  ),
  clientes: (
    <>
      <circle cx="9" cy="8" r="2.2" />
      <circle cx="15" cy="8" r="2.2" />
      <path d="M4.5 17c0-2.1 2-3.8 4.5-3.8s4.5 1.7 4.5 3.8" />
      <path d="M10.5 17c.2-1.8 1.9-3.2 4-3.2 2.3 0 4.2 1.4 4.5 3.2" />
    </>
  ),
  pagamento: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2.4" />
      <path d="M3 10.8h18" />
      <path d="M15.8 14h2.7" />
    </>
  ),
  emprestimos: (
    <>
      <path d="M5 13.5h6.2a2 2 0 0 1 0 4H7.3" />
      <path d="M5 17.5h4" />
      <circle cx="16.5" cy="10" r="4.2" />
      <path d="M16.5 7.8v4.4" />
      <path d="M14.8 10h3.4" />
    </>
  ),
  historico: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.4l3 1.8" />
    </>
  ),
  notificacoes: (
    <>
      <path d="M12 4.2c-2.6 0-4.7 2.1-4.7 4.7v2.4L5.8 14v1.1h12.4V14l-1.5-2V8.9c0-2.6-2.1-4.7-4.7-4.7Z" />
      <path d="M10.2 16.5a1.8 1.8 0 0 0 3.6 0" />
    </>
  ),
  fluxo_caixa: (
    <>
      <path d="M4 5.5v13" />
      <path d="M4 18.5h16" />
      <path d="M8 15v-3" />
      <path d="M12 15V8" />
      <path d="M16 15v-5" />
    </>
  ),
  simulacao: (
    <>
      <rect x="6" y="4" width="12" height="16" rx="2" />
      <path d="M9 8.2h6" />
      <path d="M9 12h2" />
      <path d="M13 12h2" />
      <path d="M9 15.8h2" />
      <path d="M13 15.8h2" />
    </>
  ),
  backup: (
    <>
      <ellipse cx="12" cy="6.8" rx="6.7" ry="2.8" />
      <path d="M5.3 6.8v7.6c0 1.5 3 2.8 6.7 2.8s6.7-1.3 6.7-2.8V6.8" />
      <path d="M5.3 11.3c0 1.5 3 2.8 6.7 2.8s6.7-1.3 6.7-2.8" />
    </>
  ),
  atualizacoes: (
    <>
      <path d="M6.4 7.8A7.8 7.8 0 0 1 18 6.8" />
      <path d="M17.9 6.8V4.2" />
      <path d="M17.9 6.8h-2.6" />
      <path d="M17.6 16.2A7.8 7.8 0 0 1 6 17.2" />
      <path d="M6.1 17.2v2.6" />
      <path d="M6.1 17.2h2.6" />
    </>
  ),
  assistente: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M9 10.5h.01M15 10.5h.01" />
      <path d="M9 14c1.7 1.2 4.3 1.2 6 0" />
    </>
  ),
  light_mode: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3.5v2.2" />
      <path d="M12 18.3v2.2" />
      <path d="M3.5 12h2.2" />
      <path d="M18.3 12h2.2" />
      <path d="M5.9 5.9l1.6 1.6" />
      <path d="M16.5 16.5l1.6 1.6" />
      <path d="M18.1 5.9l-1.6 1.6" />
      <path d="M7.5 16.5l-1.6 1.6" />
    </>
  ),
  dark_mode: (
    <>
      <path d="M15.6 5.3a6.7 6.7 0 1 0 3.1 12.2 7.2 7.2 0 0 1-3.1-12.2Z" />
    </>
  ),
  focus_mode: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.1" />
    </>
  ),
  home: (
    <>
      <path d="M3.8 10.4 12 4l8.2 6.4" />
      <path d="M6.4 9.3V20h11.2V9.3" />
      <path d="M10 20v-4.8h4V20" />
    </>
  ),
};

function MenuIcon({ name, className = "" }) {
  const icon = ICONS[name] || ICONS.clientes;
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icon}
    </svg>
  );
}

export const MENU_ITEMS = [
  { nome: "Clientes", to: "/clientes", icon: "clientes" },
  { nome: "Pagamento", to: "/pagamento", icon: "pagamento" },
  { nome: "Empréstimos", to: "/emprestimos", icon: "emprestimos" },
  { nome: "Histórico", to: "/historico", icon: "historico" },
  { nome: "Notificações", to: "/notificacoes", icon: "notificacoes" },
  { nome: "Fluxo de Caixa", to: "/fluxo-caixa", icon: "fluxo_caixa" },
  { nome: "Simulação", to: "/simulacao", icon: "simulacao" },
  { nome: "Backup", to: "/backup", icon: "backup" },
  { nome: "Atualizações", to: "/atualizacoes", icon: "atualizacoes" },
];

export function AppIcon({ name, className = "" }) {
  return <MenuIcon name={name} className={className} />;
}

export default function Menu({ items = MENU_ITEMS, variant = "top", notifCount = null }) {
  const [pendentesNotif, setPendentesNotif] = useState(notifCount);
  const [updateStage, setUpdateStage] = useState(null);

  useEffect(() => {
    // Se o App ja esta fornecendo o contador, nao faz polling aqui.
    if (typeof notifCount === "number" || notifCount === null) {
      setPendentesNotif(notifCount);
      return;
    }

    let cancelado = false;

    const hojeLocalISO = () => {
      const d = new Date();
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 10);
    };

    const carregar = async () => {
      try {
        const resp = await fetch(`${API_BASE}/notificacoes`, { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const hoje = hojeLocalISO();
        const total = Array.isArray(data?.notificacoes)
          ? data.notificacoes.filter(
              (n) =>
                n?.tipo === "parcela_vence_hoje" &&
                String(n?.data_referencia || "") === hoje
            ).length
          : 0;
        if (!cancelado) setPendentesNotif(total);
      } catch (_) {
        if (!cancelado) setPendentesNotif(null);
      }
    };

    carregar();
    const id = setInterval(carregar, 60_000);

    return () => {
      cancelado = true;
      clearInterval(id);
    };
  }, [notifCount]);

  useEffect(() => {
    let unsub = null;
    let alive = true;

    const carregarStatus = async () => {
      try {
        const status = await window?.updates?.getStatus?.();
        if (alive && status && status.stage) setUpdateStage(status.stage);
      } catch (_) {}
    };

    carregarStatus();
    unsub = window?.updates?.onStatus?.((p) => {
      if (p && p.stage) setUpdateStage(p.stage);
    });

    return () => {
      alive = false;
      if (typeof unsub === "function") unsub();
    };
  }, []);

  const updateBadgeStage = updateStage || "";
  const showUpdateBadge =
    updateBadgeStage === "available" ||
    updateBadgeStage === "downloading" ||
    updateBadgeStage === "downloaded";
  const isUpdateDownloaded = updateBadgeStage === "downloaded";

  return (
    <nav className={`menu menu--${variant}`}>
      <h2 className="menu__title">
        <Link
          to="/dashboard"
          className="menu__home-link menu__home-link--icon"
          title="Voltar para a página inicial"
          aria-label="Voltar para a página inicial"
        >
          <MenuIcon name="home" className="menu__home-icon" />
        </Link>
        <span className="menu__title-text">Plataforma de Empréstimos</span>
        <span className="menu__title-spacer" aria-hidden="true" />
      </h2>

      <ul className="menu-list">
        {items.map((item) => (
          <li key={item.to} className="menu-list__item">
            <NavLink
              to={item.to}
              className={({ isActive }) =>
                `menu-item${isActive ? " menu-item--active" : ""}`
              }
              title={variant === "dock" ? item.nome : undefined}
            >
              <span
                className={`menu-item__icon${
                  item.to === "/atualizacoes" && showUpdateBadge
                    ? ` menu-item__icon--update-pending${
                        isUpdateDownloaded ? " is-downloaded" : ""
                      }`
                    : ""
                }`}
                aria-hidden="true"
              >
                <MenuIcon name={item.icon} className="menu-item__icon-glyph" />
              </span>
              <span className="menu-item__label">
                {item.nome}
                {item.to === "/notificacoes" &&
                typeof pendentesNotif === "number" &&
                pendentesNotif > 0 ? (
                  <span className="menu-item__badge" aria-label={`${pendentesNotif} notificações pendentes`}>
                    {pendentesNotif}
                  </span>
                ) : null}
              </span>
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="menu__footer">© 2026 Plataforma de Empréstimos</div>
    </nav>
  );
}


