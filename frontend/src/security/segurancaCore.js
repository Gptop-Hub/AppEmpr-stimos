// Uma única decisão ON/OFF para todos os consumidores, com dependências injetáveis nos testes.
export function criarAutorizador({ obterEstado, validarSenha, prompt, informarErro }) {
  return async function autorizarProtecao(chave, contexto = {}) {
    try {
      const estado = await obterEstado(chave, contexto);
      if (typeof estado?.ativo !== 'boolean' || typeof estado?.temSenha !== 'boolean') throw new Error('Configuração de segurança inválida. Operação bloqueada.');
      if (estado.exigida === false || (estado.exigida == null && estado.ativo === false)) return {};
      if (estado.ativo !== true || !estado.temSenha) throw new Error('Proteção sem configuração válida. Operação bloqueada.');
      const senha = await prompt(`Digite a senha de: ${estado.nome}`, {
        type: 'password', title: 'Proteção de segurança', okText: 'Confirmar', cancelText: 'Cancelar', maxLength: 1024,
      });
      if (senha === null || senha === '') return null;
      const autorizacao = await validarSenha(chave, senha);
      if (!autorizacao?.token) throw new Error('A autorização de segurança não foi recebida.');
      return { headers: { 'X-Protecao-Token': autorizacao.token } };
    } catch (error) {
      await informarErro(error?.response?.data?.error || error.message || 'Não foi possível verificar a segurança. Operação bloqueada.');
      return null;
    }
  };
}
