import axios from 'axios';
import notify from '../ui/notify';
import { criarAutorizador } from './segurancaCore.js';

const url = chave => `/seguranca/protecoes/${encodeURIComponent(chave)}`;
export const listarProtecoes = async () => (await axios.get('/seguranca/protecoes')).data;
export const obterEstadoProtecao = async (chave, contexto = {}) => (await axios.get(url(chave), { params: contexto })).data;
export const protecaoAtiva = async chave => (await obterEstadoProtecao(chave)).ativo;
export const validarSenhaProtecao = async (chave, senha) => (await axios.post(`${url(chave)}/validar`, { senha })).data;
export const definirSenhaProtecao = async (chave, dados) => (await axios.put(`${url(chave)}/senha`, dados)).data;
export const alterarEstadoProtecao = async (chave, dados) => (await axios.put(`${url(chave)}/estado`, dados)).data;
export const autorizarProtecao = criarAutorizador({
  obterEstado: obterEstadoProtecao, validarSenha: validarSenhaProtecao,
  prompt: notify.prompt, informarErro: notify.error,
});
