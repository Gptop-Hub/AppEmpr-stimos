import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';

let catalogoCache = [];
let catalogoCarregadoEm = 0;
let catalogoPromise = null;
const catalogoListeners = new Set();
const CATALOGO_REFRESH_MS = 1000;

function publicarCatalogo(clientes) {
  catalogoCache = Array.isArray(clientes) ? clientes : [];
  catalogoCarregadoEm = Date.now();
  catalogoListeners.forEach((listener) => listener(catalogoCache));
}

function carregarCatalogoCompartilhado() {
  if (
    catalogoCache.length > 0 &&
    Date.now() - catalogoCarregadoEm < CATALOGO_REFRESH_MS
  ) {
    return Promise.resolve(catalogoCache);
  }
  if (catalogoPromise) return catalogoPromise;

  catalogoPromise = axios
    .get('/clientes')
    .then((response) => {
      publicarCatalogo(response.data);
      return catalogoCache;
    })
    .catch((error) => {
      console.error('Erro ao carregar catálogo de clientes:', error);
      return catalogoCache;
    })
    .finally(() => {
      catalogoPromise = null;
    });

  return catalogoPromise;
}

export function atualizarClienteNoCatalogo(clienteAtualizado, idAnterior = clienteAtualizado?.id) {
  if (!clienteAtualizado?.id || catalogoCache.length === 0) return;
  publicarCatalogo(
    catalogoCache.map((cliente) =>
      Number(cliente.id) === Number(idAnterior)
        ? { ...cliente, ...clienteAtualizado }
        : cliente
    )
  );
}

const normalizarNome = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

export default function useClientesCatalogo(clientesFornecidos) {
  const temCatalogoFornecido = Array.isArray(clientesFornecidos);
  const [clientesRemotos, setClientesRemotos] = useState(() => catalogoCache);

  useEffect(() => {
    if (temCatalogoFornecido) return undefined;
    const listener = (clientes) => setClientesRemotos(clientes);
    catalogoListeners.add(listener);
    if (catalogoCache.length > 0) setClientesRemotos(catalogoCache);
    carregarCatalogoCompartilhado();
    return () => {
      catalogoListeners.delete(listener);
    };
  }, [temCatalogoFornecido]);

  const clientes = temCatalogoFornecido ? clientesFornecidos : clientesRemotos;

  const clientesPorId = useMemo(() => {
    const mapa = new Map();
    (clientes || []).forEach((cliente) => {
      const id = String(cliente?.id ?? '').trim();
      if (id) mapa.set(id, cliente);
    });
    return mapa;
  }, [clientes]);

  const clientesPorNome = useMemo(() => {
    const mapa = new Map();
    (clientes || []).forEach((cliente) => {
      const nome = normalizarNome(cliente?.nome);
      if (nome && !mapa.has(nome)) mapa.set(nome, cliente);
    });
    return mapa;
  }, [clientes]);

  const resolverCliente = useCallback(
    (clienteId, clienteNome, dadosExtras = {}) => {
      const id = String(clienteId ?? '').trim();
      const nome = String(clienteNome || '').trim();
      const encontrado =
        (id ? clientesPorId.get(id) : null) ||
        (nome ? clientesPorNome.get(normalizarNome(nome)) : null);

      return {
        ...dadosExtras,
        ...(encontrado || {}),
        id: encontrado?.id ?? (id || null),
        nome: encontrado?.nome || nome || (id ? `Cliente #${id}` : 'Cliente não informado'),
      };
    },
    [clientesPorId, clientesPorNome]
  );

  return { clientes, clientesPorId, resolverCliente };
}
