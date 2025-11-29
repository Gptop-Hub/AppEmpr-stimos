import './axios-setup';
import './theme.css';
import React, { Suspense, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';

const App           = React.lazy(() => import('./App'));
const Clientes      = React.lazy(() => import('./componentes/clientes'));
const NovoCliente   = React.lazy(() => import('./componentes/novocliente'));
const NovoEmprestimo= React.lazy(() => import('./componentes/novoemprestimo'));
const Pagamento     = React.lazy(() => import('./componentes/pagamento'));
const Emprestimos   = React.lazy(() => import('./componentes/Emprestimos'));
const Vencidos      = React.lazy(() => import('./componentes/vencidos'));
const Backup        = React.lazy(() => import('./componentes/backup'));
const Historico     = React.lazy(() => import('./componentes/historico'));
const Atualizacoes  = React.lazy(() => import('./componentes/atualizacoes'));
const Notificacoes  = React.lazy(() => import('./componentes/notificacoes'));
const Relatorio     = React.lazy(() => import('./componentes/relatorio'));
const NotFound      = React.lazy(() => import('./componentes/notfound'));

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
            <Route index element={<Clientes />} />
            <Route path="clientes" element={<Clientes />} />
            <Route path="novocliente" element={<NovoCliente />} />
            <Route path="novoemprestimo" element={<NovoEmprestimo />} />
            <Route path="pagamento" element={<Pagamento />} />
            <Route path="emprestimos" element={<Emprestimos />} />
            <Route path="historico" element={<Historico />} />
            <Route path="vencidos" element={<Vencidos />} />
            <Route path="backup" element={<Backup />} />
            <Route path="atualizacoes" element={<Atualizacoes />} />
            <Route path="notificacoes" element={<Notificacoes />} />
            <Route path="relatorio" element={<Relatorio />} />
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

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  return <AppWrapper theme={theme} onToggleTheme={toggleTheme} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>
);
