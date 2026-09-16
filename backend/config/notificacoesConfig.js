const fs = require('fs');
const path = require('path');
const paths = require('../utils/paths');

const DEFAULT_VENCE_EM_BREVE = 3;

const DEFAULT_CONFIG = {
  venceEmBreveDias: DEFAULT_VENCE_EM_BREVE,
};

function getConfigPath() {
  // Usa APP_DATA_DIR/emprestimos-data/notificacoes-config.json
  const dir = paths.getDataDir();
  return path.join(dir, 'notificacoes-config.json');
}

async function lerConfig() {
  const file = getConfigPath();
  try {
    const raw = await fs.promises.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch (err) {
    // Se arquivo não existe ou JSON ruim, retorna padrão
    return { ...DEFAULT_CONFIG };
  }
}

async function salvarConfig(config) {
  const file = getConfigPath();
  const finalConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };
  await fs.promises.writeFile(file, JSON.stringify(finalConfig, null, 2), 'utf-8');
  return finalConfig;
}

module.exports = {
  DEFAULT_VENCE_EM_BREVE,
  DEFAULT_CONFIG,
  lerConfig,
  salvarConfig,
};
