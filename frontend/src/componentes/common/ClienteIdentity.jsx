import React from 'react';
import ClientePhotoZoom from './ClientePhotoZoom.jsx';

export default function ClienteIdentity({
  cliente,
  clienteId,
  nome,
  avatarSize = 36,
  secondary,
  className = '',
  nameClassName = '',
}) {
  const clienteExibido = {
    ...(cliente || {}),
    id: cliente?.id ?? clienteId ?? null,
    nome:
      cliente?.nome ||
      nome ||
      (clienteId !== null && clienteId !== undefined
        ? `Cliente #${clienteId}`
        : 'Cliente não informado'),
  };

  return (
    <span className={`cliente-identity${className ? ` ${className}` : ''}`}>
      <ClientePhotoZoom cliente={clienteExibido} size={avatarSize} />
      <span className="cliente-identity__text">
        <span className={`cliente-identity__name${nameClassName ? ` ${nameClassName}` : ''}`}>
          {clienteExibido.nome}
        </span>
        {secondary ? <span className="cliente-identity__secondary">{secondary}</span> : null}
      </span>
    </span>
  );
}
