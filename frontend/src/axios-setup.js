// frontend/src/axios-setup.js
import axios from 'axios';

// Deixa um baseURL global pro app inteiro:
axios.defaults.baseURL = 'http://127.0.0.1:3001';
axios.defaults.timeout = 15000;

// Log de erro para facilitar debug no DevTools
axios.interceptors.response.use(
  (resp) => resp,
  (err) => {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error('[API ERROR]', err?.code, err?.message, status, data);
    return Promise.reject(err);
  }
);