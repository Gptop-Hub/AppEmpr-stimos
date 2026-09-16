import React from 'react';

export default function ProtecaoItem({ item, ocupado = false, formulario = null, senhas, setSenhas, alternar, abrirFormulario, salvarFormulario, cancelarFormulario }) {
  return (
    <article className="seguranca-item" data-protecao={item.chave}>
      <h3>{item.nome}</h3>
      <div className="seguranca-controls">
        <div className="seguranca-estados" data-ativo={item.ativo}>
          <span className="seguranca-ligado">Ligado</span>
          <button className="seguranca-switch" role="switch" type="button" aria-checked={item.ativo} aria-label={`Proteção: ${item.nome}`} disabled={ocupado || Boolean(formulario)} onClick={() => alternar(item)}><span /></button>
          <span className="seguranca-desligado">Desligado</span>
        </div>
        <button type="button" disabled={ocupado || Boolean(formulario)} onClick={() => abrirFormulario(item, 'senha')}>{item.temSenha ? 'Alterar senha' : 'Definir senha'}</button>
      </div>
      {formulario?.item.chave === item.chave && (
        <form className="seguranca-form" onSubmit={salvarFormulario}>
          <p>{formulario.acao === 'desligar' ? 'Informe a senha desta proteção para desligá-la.' : formulario.ativar ? 'Defina uma senha para ligar a proteção.' : item.temSenha ? 'Alterar a senha desta proteção' : 'Definir a senha desta proteção'}</p>
          {(item.temSenha || formulario.acao === 'desligar') && <label>Senha atual<input type="password" autoComplete="current-password" required maxLength={1024} disabled={ocupado} value={senhas.atual} onChange={e => setSenhas(s => ({ ...s, atual: e.target.value }))} /></label>}
          {formulario.acao === 'senha' && <>
            <label>Nova senha<input type="password" autoComplete="new-password" required maxLength={1024} disabled={ocupado} value={senhas.nova} onChange={e => setSenhas(s => ({ ...s, nova: e.target.value }))} /></label>
            <label>Confirmar nova senha<input type="password" autoComplete="new-password" required maxLength={1024} disabled={ocupado} value={senhas.confirmacao} onChange={e => setSenhas(s => ({ ...s, confirmacao: e.target.value }))} /></label>
          </>}
          <div className="seguranca-form-actions"><button type="button" onClick={cancelarFormulario} disabled={ocupado}>Cancelar</button><button type="submit" disabled={ocupado}>{ocupado ? 'Salvando…' : formulario.acao === 'desligar' ? 'Desligar proteção' : 'Salvar senha'}</button></div>
        </form>
      )}
    </article>
  );
}
