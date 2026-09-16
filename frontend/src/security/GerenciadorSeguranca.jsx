import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { alterarEstadoProtecao, definirSenhaProtecao, listarProtecoes } from './seguranca.js';
import ProtecaoItem from './ProtecaoItem.jsx';
import './seguranca.css';

export default function GerenciadorSeguranca({ onClose }) {
  const [protecoes, setProtecoes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [formulario, setFormulario] = useState(null);
  const [senhas, setSenhas] = useState({ atual: '', nova: '', confirmacao: '' });
  const panelRef = useRef(null);
  const atualizarItem = item => setProtecoes(items => items.map(p => p.chave === item.chave ? item : p));

  useEffect(() => {
    let vivo = true;
    listarProtecoes().then(items => { if (vivo) setProtecoes(items); })
      .catch(() => { if (vivo) setErro('Não foi possível carregar as proteções. Feche e tente novamente.'); })
      .finally(() => { if (vivo) setCarregando(false); });
    const anterior = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => { vivo = false; document.body.style.overflow = overflow; anterior?.focus(); };
  }, []);
  useEffect(() => { if (formulario) panelRef.current?.querySelector('form input')?.focus(); }, [formulario]);

  const abrirFormulario = (item, acao, ativar = false) => {
    setErro('');
    setSenhas({ atual: '', nova: '', confirmacao: '' });
    setFormulario({ item, acao, ativar });
  };
  const cancelarFormulario = () => {
    setFormulario(null);
    setSenhas({ atual: '', nova: '', confirmacao: '' });
    setErro('');
    panelRef.current?.focus();
  };
  const alternar = async item => {
    if (item.ativo) { abrirFormulario(item, 'desligar'); return; }
    if (!item.temSenha) { abrirFormulario(item, 'senha', true); return; }
    setOcupado(true); setErro('');
    try { atualizarItem(await alterarEstadoProtecao(item.chave, { ativo: true })); }
    catch (error) { setErro(error?.response?.data?.error || 'Não foi possível ligar a proteção.'); }
    finally { setOcupado(false); }
  };
  const salvarFormulario = async event => {
    event.preventDefault();
    if (ocupado) return;
    const { item, acao, ativar } = formulario;
    if (acao === 'senha' && (!senhas.nova.trim() || senhas.nova !== senhas.confirmacao)) {
      setErro(!senhas.nova.trim() ? 'Informe uma nova senha não vazia.' : 'A confirmação da nova senha está diferente.'); return;
    }
    setOcupado(true); setErro('');
    try {
      const resultado = acao === 'desligar'
        ? await alterarEstadoProtecao(item.chave, { ativo: false, senhaAtual: senhas.atual })
        : await definirSenhaProtecao(item.chave, { senhaAtual: senhas.atual, novaSenha: senhas.nova, confirmacao: senhas.confirmacao, ativar });
      atualizarItem(resultado);
      cancelarFormulario();
    } catch (error) {
      setErro(error?.response?.data?.error || 'Não foi possível salvar a configuração.');
      setSenhas({ atual: '', nova: '', confirmacao: '' });
    } finally { setOcupado(false); panelRef.current?.focus(); }
  };
  const teclado = event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (!ocupado) formulario ? cancelarFormulario() : onClose();
    }
    if (event.key !== 'Tab') return;
    const elements = [...panelRef.current.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
    const primeiro = elements[0], ultimo = elements[elements.length - 1];
    if (!primeiro) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === primeiro || document.activeElement === panelRef.current)) { event.preventDefault(); ultimo.focus(); }
    else if (!event.shiftKey && document.activeElement === ultimo) { event.preventDefault(); primeiro.focus(); }
  };

  return createPortal(
    <div className="seguranca-overlay" data-dialog-overlay="true" onClick={() => { if (!ocupado) onClose(); }}>
      <section className="seguranca-panel" role="dialog" aria-modal="true" aria-labelledby="seguranca-titulo" tabIndex={-1} ref={panelRef} onClick={e => e.stopPropagation()} onKeyDown={teclado}>
        <header className="seguranca-header">
          <div><h2 id="seguranca-titulo">Gerenciador de segurança</h2><p>Cada operação tem sua própria senha. Desligar remove apenas a exigência de senha.</p></div>
          <button type="button" onClick={onClose} disabled={ocupado} aria-label="Fechar gerenciador">✕</button>
        </header>
        {carregando && <p role="status">Carregando proteções…</p>}
        {erro && <p className="seguranca-erro" role="alert">{erro}</p>}
        {!carregando && protecoes.map(item => (
          <ProtecaoItem key={item.chave} {...{ item, ocupado, formulario, senhas, setSenhas, alternar, abrirFormulario, salvarFormulario, cancelarFormulario }} />
        ))}
      </section>
    </div>, document.body,
  );
}
