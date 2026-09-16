import axios from 'axios';

const PREFIXOS_CANDIDATOS = ['/fluxo-caixa', '/relatorio/caixa'];
let prefixoPreferido = PREFIXOS_CANDIDATOS[0];

function isNotFound(err) {
  return Number(err?.response?.status || 0) === 404;
}

function validarPayloadFluxoCaixa(resumo, linhasPayload) {
  const resumoValido =
    resumo &&
    typeof resumo === 'object' &&
    !Array.isArray(resumo) &&
    typeof resumo.de === 'string' &&
    typeof resumo.ate === 'string' &&
    resumo.recebimentos_previstos &&
    typeof resumo.recebimentos_previstos === 'object';
  const linhasValidas =
    linhasPayload &&
    typeof linhasPayload === 'object' &&
    !Array.isArray(linhasPayload) &&
    Array.isArray(linhasPayload.linhas);

  if (!resumoValido || !linhasValidas) {
    throw new Error(
      'A API do Fluxo de Caixa retornou uma resposta invalida ou desatualizada.'
    );
  }
}

async function carregarResumoELinhasNoPrefixo(prefixo, params) {
  const [respResumo, respLinhas] = await Promise.all([
    axios.get(`${prefixo}/resumo`, { params }),
    axios.get(`${prefixo}/linhas`, { params }),
  ]);

  const resumo = respResumo?.data;
  const linhasPayload = respLinhas?.data;
  validarPayloadFluxoCaixa(resumo, linhasPayload);

  return {
    resumo,
    linhas: linhasPayload.linhas,
  };
}

export async function carregarResumoELinhasFluxoCaixa(params = {}) {
  const prefixosOrdenados = [
    prefixoPreferido,
    ...PREFIXOS_CANDIDATOS.filter((item) => item !== prefixoPreferido),
  ];

  let ultimoErro404 = null;

  for (const prefixo of prefixosOrdenados) {
    try {
      const dados = await carregarResumoELinhasNoPrefixo(prefixo, params);
      prefixoPreferido = prefixo;
      return dados;
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
      ultimoErro404 = err;
    }
  }

  throw ultimoErro404 || new Error('Endpoints de fluxo de caixa indisponiveis.');
}
