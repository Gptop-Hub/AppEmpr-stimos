import React, { useEffect, useMemo, useState } from 'react';
import { API_BASE_URL } from '../../axios-setup.js';

export function getClienteFotoUrl(cliente) {
  const fotoUrl = String(cliente?.foto_url || '').trim();
  if (!fotoUrl || !cliente?.foto_cliente) return '';
  if (/^https?:\/\//i.test(fotoUrl)) return fotoUrl;

  const baseUrl = String(API_BASE_URL).replace(/\/+$/, '');
  return `${baseUrl}${fotoUrl.startsWith('/') ? '' : '/'}${fotoUrl}`;
}

export function getClienteIniciais(nome) {
  const partes = String(nome || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (partes.length === 0) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return `${partes[0][0]}${partes[partes.length - 1][0]}`.toUpperCase();
}

export default function ClienteAvatar({
  cliente,
  nome,
  src,
  size = 64,
  className = '',
  style,
}) {
  const [imagemFalhou, setImagemFalhou] = useState(false);
  const nomeExibido = nome ?? cliente?.nome ?? '';
  const imagem = useMemo(
    () => (src === undefined ? getClienteFotoUrl(cliente) : String(src || '')),
    [cliente, src]
  );

  useEffect(() => {
    setImagemFalhou(false);
  }, [imagem]);

  const mostrarImagem = Boolean(imagem) && !imagemFalhou;
  const classes = `cliente-avatar${className ? ` ${className}` : ''}`;

  return (
    <div
      className={classes}
      style={{
        '--cliente-avatar-size': `${size}px`,
        fontSize: `${Math.max(14, Math.round(size * 0.34))}px`,
        ...style,
      }}
      role={mostrarImagem ? undefined : 'img'}
      aria-label={mostrarImagem ? undefined : `Avatar de ${nomeExibido || 'cliente'}`}
    >
      {mostrarImagem ? (
        <img
          src={imagem}
          alt={`Foto de ${nomeExibido || 'cliente'}`}
          onError={() => setImagemFalhou(true)}
          draggable="false"
        />
      ) : (
        <span aria-hidden="true">{getClienteIniciais(nomeExibido)}</span>
      )}
    </div>
  );
}
