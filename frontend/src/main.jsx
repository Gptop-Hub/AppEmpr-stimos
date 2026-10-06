import './axios-setup';
import './theme.css';
import React, { Suspense, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';

const App           = React.lazy(() => import('./App'));
const Dashboard     = React.lazy(() => import('./componentes/dashboard'));
const Clientes      = React.lazy(() => import('./componentes/clientes'));
const NovoCliente   = React.lazy(() => import('./componentes/novocliente'));
const NovoEmprestimo= React.lazy(() => import('./componentes/novoemprestimo'));
const Pagamento     = React.lazy(() => import('./componentes/pagamento'));
const Emprestimos   = React.lazy(() => import('./componentes/Emprestimos'));
const Vencidos      = React.lazy(() => import('./componentes/vencidos'));
const Backup        = React.lazy(() => import('./componentes/backup'));
const Historico     = React.lazy(() => import('./componentes/historico'));
const Acoes         = React.lazy(() => import('./componentes/acoes'));
const Atualizacoes  = React.lazy(() => import('./componentes/atualizacoes'));
const Notificacoes  = React.lazy(() => import('./componentes/notificacoes'));
const FluxoCaixa    = React.lazy(() => import('./componentes/fluxoCaixa'));
const Simulacao     = React.lazy(() => import('./componentes/Simulacao/Simulacao'));
const NotFound      = React.lazy(() => import('./componentes/notfound'));

const BLOQUEIOS_ACESSO = Object.freeze({
  historico: false,
  acoes: true,
});

function BannerAcessoBloqueado({ modulo }) {
  return (
    <div style={{ padding: 16, color: 'var(--text-main)' }}>
      <div
        style={{
          position: 'relative',
          border: '1px solid var(--border-soft)',
          borderRadius: 12,
          background: 'var(--bg-card)',
          minHeight: 290,
          overflow: 'hidden',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'repeating-linear-gradient(135deg, rgba(148,163,184,0.08) 0, rgba(148,163,184,0.08) 14px, rgba(148,163,184,0.13) 14px, rgba(148,163,184,0.13) 28px)',
            filter: 'blur(0.5px)',
          }}
        />

        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            zIndex: 2,
          }}
        >
          <div
            style={{
              width: 'min(820px, 100%)',
              borderRadius: 12,
              border: '1px solid rgba(239,68,68,0.55)',
              background: 'rgba(127,29,29,0.32)',
              boxShadow: '0 0 0 3px rgba(239,68,68,0.12)',
              padding: '14px 16px',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontWeight: 800,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                color: '#fecaca',
                marginBottom: 6,
              }}
            >
              Acesso Temporariamente Bloqueado
            </div>
            <div style={{ fontSize: 19, fontWeight: 700 }}>{modulo}</div>
            <div style={{ marginTop: 6, color: '#fecaca' }}>
              Este modulo esta oculto nesta atualizacao.
            </div>
          </div>
        </div>

        <div
          aria-hidden="true"
          style={{
            position: 'relative',
            zIndex: 1,
            padding: 20,
            opacity: 0.28,
            filter: 'grayscale(1) blur(1px)',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          <h2 style={{ marginTop: 0, marginBottom: 10 }}>{modulo}</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 10,
            }}
          >
            <div style={{ height: 74, borderRadius: 10, border: '1px solid var(--border-soft)' }} />
            <div style={{ height: 74, borderRadius: 10, border: '1px solid var(--border-soft)' }} />
            <div style={{ height: 74, borderRadius: 10, border: '1px solid var(--border-soft)' }} />
            <div style={{ height: 74, borderRadius: 10, border: '1px solid var(--border-soft)' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(p){ super(p); this.state={hasError:false,error:null,info:null}; }
  static getDerivedStateFromError(error){ return {hasError:true,error}; }
  componentDidCatch(error, info){ this.setState({info}); console.error('ErrorBoundary:', error, info); }
  render(){
    if(this.state.hasError){
      return (
        <div style={{ padding: 20, fontFamily: 'sans-serif' }}>
          <h2>Ocorreu um erro ao carregar a aplicação</h2>
          <p style={{ color: 'red' }}>{String(this.state.error?.message ?? this.state.error)}</p>
          <details style={{ whiteSpace: 'pre-wrap' }}>{this.state.info?.componentStack ?? 'Sem stack info'}</details>
        </div>
      );
    }
    return this.props.children;
  }
}

const AppWrapper = ({ theme, onToggleTheme }) => (
  <ErrorBoundary>
    <Suspense fallback={<div style={{ padding: 20 }}>Carregando aplicação...</div>}>
      <HashRouter>
        <Routes>
          <Route path="/" element={<App theme={theme} onToggleTheme={onToggleTheme} />}>
            <Route index element={<Dashboard />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="clientes" element={<Clientes />} />
            <Route path="novocliente" element={<NovoCliente />} />
            <Route path="novoemprestimo" element={<NovoEmprestimo />} />
            <Route path="pagamento" element={<Pagamento />} />
            <Route path="emprestimos" element={<Emprestimos />} />
            <Route
              path="historico"
              element={
                BLOQUEIOS_ACESSO.historico ? (
                  <BannerAcessoBloqueado modulo="Historico" />
                ) : (
                  <Historico />
                )
              }
            />
            <Route
              path="acoes"
              element={
                BLOQUEIOS_ACESSO.acoes ? (
                  <BannerAcessoBloqueado modulo="Ações" />
                ) : (
                  <Acoes />
                )
              }
            />
            <Route path="vencidos" element={<Vencidos />} />
            <Route path="backup" element={<Backup />} />
            <Route path="atualizacoes" element={<Atualizacoes />} />
            <Route path="notificacoes" element={<Notificacoes />} />
            <Route path="fluxo-caixa" element={<FluxoCaixa />} />
            <Route path="simulacao" element={<Simulacao />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </HashRouter>
    </Suspense>
  </ErrorBoundary>
);

function ThemedApp() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    const zoomApi = window.appZoom;
    if (!zoomApi || typeof zoomApi.step !== 'function') return undefined;

    const WHEEL_STEP_THRESHOLD = 100;
    const GESTURE_SCALE_THRESHOLD = 0.04;
    let wheelAccumulator = 0;
    let gestureLastScale = null;

    const requestZoomStep = (direction, source) => {
      if (direction !== 'in' && direction !== 'out') return;
      try {
        void zoomApi.step(direction, source).catch(() => {});
      } catch (_) {}
    };

    const applyWheelDelta = (deltaY) => {
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      wheelAccumulator += deltaY;

      while (Math.abs(wheelAccumulator) >= WHEEL_STEP_THRESHOLD) {
        if (wheelAccumulator > 0) {
          requestZoomStep('out', 'wheel');
          wheelAccumulator -= WHEEL_STEP_THRESHOLD;
        } else {
          requestZoomStep('in', 'wheel');
          wheelAccumulator += WHEEL_STEP_THRESHOLD;
        }
      }
    };

    const onWheel = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      applyWheelDelta(event.deltaY);
    };

    const onGestureStart = (event) => {
      gestureLastScale =
        typeof event.scale === 'number' && Number.isFinite(event.scale)
          ? event.scale
          : 1;
      event.preventDefault();
    };

    const onGestureChange = (event) => {
      if (typeof event.scale !== 'number' || !Number.isFinite(event.scale)) {
        return;
      }
      event.preventDefault();
      if (gestureLastScale == null) {
        gestureLastScale = event.scale;
        return;
      }
      const delta = event.scale - gestureLastScale;
      if (Math.abs(delta) < GESTURE_SCALE_THRESHOLD) return;
      requestZoomStep(delta > 0 ? 'in' : 'out', 'pinch');
      gestureLastScale = event.scale;
    };

    const onGestureEnd = () => {
      gestureLastScale = null;
    };

    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('gesturestart', onGestureStart, { passive: false });
    window.addEventListener('gesturechange', onGestureChange, { passive: false });
    window.addEventListener('gestureend', onGestureEnd, { passive: true });

    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('gesturestart', onGestureStart);
      window.removeEventListener('gesturechange', onGestureChange);
      window.removeEventListener('gestureend', onGestureEnd);
    };
  }, []);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  return <AppWrapper theme={theme} onToggleTheme={toggleTheme} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>
);
