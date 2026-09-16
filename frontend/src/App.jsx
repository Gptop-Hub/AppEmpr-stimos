// frontend/src/App.jsx
import React, { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Menu, { AppIcon, MENU_ITEMS } from './componentes/menu';
import DialogHost from './ui/DialogHost.jsx';
import GerenciadorSeguranca from './security/GerenciadorSeguranca.jsx';
import { API_BASE_URL } from './axios-setup';

const HEALTH_URL = `${API_BASE_URL}/health`;
const API_BASE = API_BASE_URL;
const HEALTH_FAILS_BEFORE_ALERT = 3;
const APP_ACCESS_PASSWORD = '1otimodia';
const APP_UNLOCK_SESSION_KEY = 'app.unlock.session';
const LEFT_MENU_ITEMS = MENU_ITEMS.slice(0, 5);
const RIGHT_MENU_ITEMS = MENU_ITEMS.slice(5);
const MAIN_MAX = 1480;
const GAP = 24;
const DOCK_W_NORMAL = 96;
const DOCK_W_COMPACT = 64;
const SQUEEZE_MAX = 48;
const DOCK_SPREAD_MAX = 120;

export default function App({ theme, onToggleTheme }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [segurancaAberta, setSegurancaAberta] = useState(false);
  // A tela de senha inicial está temporariamente desativada: o sistema abre direto.
  const [isUnlocked, setIsUnlocked] = useState(true);
  const [senhaAcesso, setSenhaAcesso] = useState('');
  const [mostrarSenhaAcesso, setMostrarSenhaAcesso] = useState(false);
  const [erroAcesso, setErroAcesso] = useState('');
  const [mostrarEsqueciSenha, setMostrarEsqueciSenha] = useState(false);
  const [healthError, setHealthError] = useState(null);
  const [healthFailCount, setHealthFailCount] = useState(0);
  const [pendentesNotif, setPendentesNotif] = useState(null);
  const [showDock, setShowDock] = useState(false);
  const [dockMode, setDockMode] = useState('normal');
  const [mainMaxEffective, setMainMaxEffective] = useState(MAIN_MAX);
  const [dockSpread, setDockSpread] = useState(0);
  const toolbarRef = useRef(null);
  const topMenuRef = useRef(null);
  const senhaInputRef = useRef(null);
  const isDark = theme === 'dark';
  const isDashboardRoute =
    location?.pathname === '/' || location?.pathname === '/dashboard';

  useEffect(() => {
    const onGlobalEscape = (event) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      if (event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLElement) {
        const tag = activeEl.tagName;
        if (
          activeEl.isContentEditable ||
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT'
        ) {
          return;
        }
      }

      const hasModalAberto = Boolean(
        document.querySelector(
          '[data-dialog-overlay="true"], .modal-overlay, [data-modal-recalcular-atraso="true"]'
        )
      );
      if (hasModalAberto) return;

      event.preventDefault();
      if (window.history.length > 1) {
        navigate(-1);
      } else {
        navigate('/dashboard', { replace: true });
      }
    };

    window.addEventListener('keydown', onGlobalEscape);
    return () => window.removeEventListener('keydown', onGlobalEscape);
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(HEALTH_URL, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const health = await res.json();
        if (
          health?.ok !== true ||
          health?.service !== 'app-emprestimos-backend' ||
          !health?.dbPath ||
          !health?.appDataDir
        ) {
          throw new Error('Resposta de health invalida.');
        }
        if (!cancelled) {
          setHealthError(null);
          setHealthFailCount(0);
        }
      } catch (err) {
        if (!cancelled) {
          setHealthError(err?.message ?? String(err));
          setHealthFailCount((prev) => prev + 1);
        }
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelado = false;

    const hojeLocalISO = () => {
      const d = new Date();
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 10);
    };

    const carregarNotif = async () => {
      try {
        const resp = await fetch(`${API_BASE}/notificacoes`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const hoje = hojeLocalISO();
        const total = Array.isArray(data?.notificacoes)
          ? data.notificacoes.filter(
              (n) =>
                n?.tipo === 'parcela_vence_hoje' &&
                String(n?.data_referencia || '') === hoje
            ).length
          : 0;
        if (!cancelado) setPendentesNotif(total);
      } catch (_) {
        if (!cancelado) setPendentesNotif(null);
      }
    };

    carregarNotif();
    const id = setInterval(carregarNotif, 60_000);
    window.addEventListener('notificacoes-cobranca-atualizadas', carregarNotif);
    return () => {
      cancelado = true;
      clearInterval(id);
      window.removeEventListener('notificacoes-cobranca-atualizadas', carregarNotif);
    };
  }, []);

  useEffect(() => {
    const updateDockVisibility = () => {
      const toolbarH = toolbarRef.current?.offsetHeight || 0;
      const topMenuH = topMenuRef.current?.offsetHeight || 0;
      const headerHeight = toolbarH + topMenuH;
      setShowDock(window.scrollY > headerHeight);
    };

    let rafId = null;
    const onScroll = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        updateDockVisibility();
      });
    };

    updateDockVisibility();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', updateDockVisibility);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', updateDockVisibility);
    };
  }, []);

  useEffect(() => {
    const updateDockLayout = () => {
      const width = window.innerWidth || 0;
      const normalNeeded = MAIN_MAX + 2 * (DOCK_W_NORMAL + GAP);
      const compactNeeded = (MAIN_MAX - SQUEEZE_MAX) + 2 * (DOCK_W_COMPACT + GAP);

      if (width >= normalNeeded) {
        setDockMode('normal');
        setMainMaxEffective(MAIN_MAX);
        const baseLeft = width / 2 - MAIN_MAX / 2 - GAP - DOCK_W_NORMAL;
        const extra = Math.max(0, Math.min(DOCK_SPREAD_MAX, baseLeft - 12));
        setDockSpread(extra);
        return;
      }

      if (width >= compactNeeded) {
        const targetMain = width - 2 * (DOCK_W_COMPACT + GAP);
        const clampedMain = Math.max(
          MAIN_MAX - SQUEEZE_MAX,
          Math.min(MAIN_MAX, targetMain)
        );
        setDockMode('compact');
        setMainMaxEffective(clampedMain);
        const baseLeft = width / 2 - clampedMain / 2 - GAP - DOCK_W_COMPACT;
        const extra = Math.max(0, Math.min(DOCK_SPREAD_MAX, baseLeft - 12));
        setDockSpread(extra);
        return;
      }

      setDockMode('hidden');
      setMainMaxEffective(MAIN_MAX);
      setDockSpread(0);
    };

    updateDockLayout();
    window.addEventListener('resize', updateDockLayout);
    return () => window.removeEventListener('resize', updateDockLayout);
  }, []);

  const dockIsVisible = showDock && dockMode !== 'hidden';

  const handleUnlockSubmit = (e) => {
    e.preventDefault();
    if (String(senhaAcesso) === APP_ACCESS_PASSWORD) {
      try {
        sessionStorage.setItem(APP_UNLOCK_SESSION_KEY, '1');
      } catch {}
      setIsUnlocked(true);
      setSenhaAcesso('');
      setMostrarSenhaAcesso(false);
      setErroAcesso('');
      setMostrarEsqueciSenha(false);
      return;
    }
    setErroAcesso('Senha incorreta.');
    setMostrarEsqueciSenha(false);
  };

  if (!isUnlocked) {
    return (
      <>
        <DialogHost />
        <div
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: 20,
            background: 'var(--bg-body)',
            color: 'var(--text-main)',
          }}
        >
          <form
            onSubmit={handleUnlockSubmit}
            style={{
              width: '100%',
              maxWidth: 420,
              padding: 20,
              borderRadius: 12,
              border: '1px solid var(--border-soft)',
              background: 'var(--bg-card)',
              boxShadow: '0 14px 34px rgba(0, 0, 0, 0.25)',
            }}
          >
            <h2 style={{ margin: '0 0 8px 0', fontSize: '1.5em' }}>
              Sistema de Empréstimos
            </h2>
            <p style={{ margin: '0 0 14px 0', color: 'var(--text-muted)' }}>
              Digite a senha para acessar.
            </p>

            <div style={{ position: 'relative', marginBottom: 10 }}>
              <input
                ref={senhaInputRef}
                type={mostrarSenhaAcesso ? 'text' : 'password'}
                value={senhaAcesso}
                onChange={(ev) => {
                  setSenhaAcesso(ev.target.value);
                  if (erroAcesso) setErroAcesso('');
                  if (mostrarEsqueciSenha) setMostrarEsqueciSenha(false);
                }}
                placeholder="Senha de acesso"
                autoComplete="current-password"
                style={{
                  width: '100%',
                  padding: '11px 86px 11px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-body)',
                  color: 'var(--text-main)',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                onClick={() => setMostrarSenhaAcesso((prev) => !prev)}
                aria-label={mostrarSenhaAcesso ? 'Ocultar senha' : 'Mostrar senha'}
                title={mostrarSenhaAcesso ? 'Ocultar senha' : 'Mostrar senha'}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {mostrarSenhaAcesso ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>

            {erroAcesso ? (
              <>
                <div
                  style={{
                    marginBottom: 10,
                    color: '#fecaca',
                    background: 'rgba(127, 29, 29, 0.8)',
                    border: '1px solid rgba(248, 113, 113, 0.6)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: '0.9em',
                  }}
                >
                  {erroAcesso}
                </div>
                <button
                  type="button"
                  onClick={() => setMostrarEsqueciSenha(true)}
                  style={{
                    marginBottom: 10,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--border-soft)',
                    background: 'var(--bg-body)',
                    color: 'var(--text-main)',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  Esqueci minha senha
                </button>
                {mostrarEsqueciSenha ? (
                  <div
                    style={{
                      marginBottom: 10,
                      color: 'var(--text-main)',
                      background: 'rgba(37, 99, 235, 0.14)',
                      border: '1px solid rgba(37, 99, 235, 0.35)',
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: '0.9em',
                    }}
                  >
                    esqueceu a senha ? liga pro Vitor ! e tenha 1 otimo dia .
                  </div>
                ) : null}
              </>
            ) : null}

            <button
              type="submit"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: 'none',
                background: '#2563eb',
                color: '#fff',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Entrar
            </button>
          </form>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Host de toasts e modais do sistema */}
      <DialogHost />
      {segurancaAberta && <GerenciadorSeguranca onClose={() => setSegurancaAberta(false)} />}

      <div
        className={`app-shell${dockIsVisible ? ' dock-visible' : ''}${
          dockMode === 'compact' ? ' dock--compact' : ''
        }${dockMode === 'hidden' ? ' dock--hidden' : ''}`}
        style={{
          '--main-max-effective': `${mainMaxEffective}px`,
          '--dock-spread': `${dockSpread}px`,
        }}
      >
        {/* Botão de tema (claro/escuro) */}
        <div className="app-toolbar" ref={toolbarRef}>
          <button
            type="button"
            className="theme-switch"
            data-theme={theme}
            onClick={onToggleTheme}
            aria-label={isDark ? 'Alternar para modo claro' : 'Alternar para modo escuro'}
          >
            <span className="theme-switch__icon" aria-hidden="true">
              <AppIcon name="light_mode" className="app-control-icon" />
            </span>
            <span className="theme-switch__track" aria-hidden="true">
              <span className="theme-switch__thumb" />
            </span>
            <span className="theme-switch__icon" aria-hidden="true">
              <AppIcon name="dark_mode" className="app-control-icon" />
            </span>
          </button>
          <button type="button" className="seguranca-access" onClick={() => setSegurancaAberta(true)} aria-label="Abrir gerenciador de segurança" title="Gerenciador de segurança">
            <AppIcon name="seguranca" className="app-control-icon" />
          </button>
        </div>

        {/* Menu do topo (aparece no início do scroll) */}
        {isDashboardRoute ? (
          <div className="app-topmenu app-topmenu--dashboard" ref={topMenuRef} />
        ) : (
          <div className="app-topmenu" ref={topMenuRef}>
            <Menu variant="top" items={MENU_ITEMS} notifCount={pendentesNotif} />
          </div>
        )}

        {/* Dock flutuante (aparece quando o topo sai da viewport) */}
        <div
          className={`nav-dock nav-dock--left${dockIsVisible ? ' is-visible' : ''}`}
          aria-hidden={!dockIsVisible}
        >
          <button
            type="button"
            className={`dock-theme-toggle${theme === 'light' ? ' is-active' : ''}`}
            title="Modo claro"
            aria-label="Ativar modo claro"
            onClick={() => {
              if (theme === 'dark') onToggleTheme();
            }}
          >
            <AppIcon name="light_mode" className="app-control-icon" />
          </button>
          <Menu variant="dock" items={LEFT_MENU_ITEMS} notifCount={pendentesNotif} />
        </div>
        <div
          className={`nav-dock nav-dock--right${dockIsVisible ? ' is-visible' : ''}`}
          aria-hidden={!dockIsVisible}
        >
          <Menu variant="dock" items={RIGHT_MENU_ITEMS} notifCount={pendentesNotif} />
          <button
            type="button"
            className={`dock-theme-toggle${theme === 'dark' ? ' is-active' : ''}`}
            title="Modo escuro"
            aria-label="Ativar modo escuro"
            onClick={() => {
              if (theme === 'light') onToggleTheme();
            }}
          >
            <AppIcon name="dark_mode" className="app-control-icon" />
          </button>
        </div>

        <main className="app-content">
          {healthError && healthFailCount >= HEALTH_FAILS_BEFORE_ALERT && (
            <div
              style={{
                background: '#b00020',
                color: '#ffffff',
                padding: '8px 12px',
                margin: '12px 0',
              }}
            >
              <strong>Backend offline:</strong> não foi possível contactar {HEALTH_URL}.
              Detalhes: {healthError}
            </div>
          )}

          <Outlet />
        </main>
      </div>
    </>
  );
}
