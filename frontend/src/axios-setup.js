// frontend/src/axios-setup.js
import axios from 'axios';

function normalizarBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function resolverApiBaseUrl() {
  const runtimeUrl = normalizarBaseUrl(
    typeof window !== 'undefined' ? window.runtimeConfig?.apiBaseUrl : ''
  );
  if (runtimeUrl) return runtimeUrl;

  const configurada = normalizarBaseUrl(import.meta.env.VITE_API_BASE_URL);
  if (configurada) return configurada;

  // O Vite pode subir na 3001 quando a 3000 esta ocupada. Nesse caso, a API
  // de desenvolvimento fica na 3002 para evitar requisicoes contra o proprio frontend.
  const portaFrontend = typeof window !== 'undefined' ? window.location.port : '';
  const portaApi = import.meta.env.DEV && portaFrontend === '3001' ? '3002' : '3001';
  return `http://127.0.0.1:${portaApi}`;
}

export const API_BASE_URL = resolverApiBaseUrl();

// Deixa um baseURL global pro app inteiro:
axios.defaults.baseURL = API_BASE_URL;
axios.defaults.timeout = 15000;

// Log de erro para facilitar debug no DevTools
axios.interceptors.response.use(
  (resp) => {
    const contentType = String(resp?.headers?.['content-type'] || '').toLowerCase();
    const texto = typeof resp?.data === 'string' ? resp.data.trim().toLowerCase() : '';
    if (contentType.includes('text/html') || texto.startsWith('<!doctype html')) {
      const err = new Error(
        'A porta configurada para a API respondeu com HTML em vez de dados.'
      );
      err.code = 'INVALID_API_RESPONSE';
      err.response = resp;
      return Promise.reject(err);
    }
    return resp;
  },
  (err) => {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error('[API ERROR]', err?.code, err?.message, status, data);
    return Promise.reject(err);
  }
);
