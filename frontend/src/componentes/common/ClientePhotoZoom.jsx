import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import ClienteAvatar, { getClienteFotoUrl } from './ClienteAvatar.jsx';

export default function ClientePhotoZoom({
  cliente,
  nome,
  src,
  size = 64,
  className = '',
  style,
}) {
  const [aberto, setAberto] = useState(false);
  const nomeExibido = nome ?? cliente?.nome ?? 'Cliente';
  const imagem = useMemo(
    () => (src === undefined ? getClienteFotoUrl(cliente) : String(src || '')),
    [cliente, src]
  );

  useEffect(() => {
    if (!aberto) return undefined;
    const fecharComEscape = (event) => {
      if (event.key === 'Escape') setAberto(false);
    };
    window.addEventListener('keydown', fecharComEscape);
    return () => window.removeEventListener('keydown', fecharComEscape);
  }, [aberto]);

  const avatar = (
    <ClienteAvatar
      cliente={cliente}
      nome={nomeExibido}
      src={src}
      size={size}
      className={className}
      style={style}
    />
  );

  if (!imagem) return avatar;

  const abrir = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setAberto(true);
  };

  return (
    <>
      <span
        className="cliente-avatar-button"
        role="button"
        tabIndex={0}
        title="Visualizar foto"
        aria-label={`Visualizar foto de ${nomeExibido}`}
        onClick={abrir}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') abrir(event);
        }}
      >
        {avatar}
      </span>
      {aberto && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="cliente-photo-viewer-backdrop"
              role="dialog"
              aria-modal="true"
              aria-label={`Foto ampliada de ${nomeExibido}`}
              onClick={() => setAberto(false)}
            >
              <div
                className="cliente-photo-viewer"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="cliente-photo-viewer__header">
                  <h3>{nomeExibido}</h3>
                  <button
                    type="button"
                    className="cliente-photo-viewer__close"
                    title="Fechar"
                    aria-label="Fechar foto ampliada"
                    onClick={() => setAberto(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="cliente-photo-viewer__image-wrap">
                  <img src={imagem} alt={`Foto ampliada de ${nomeExibido}`} />
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
