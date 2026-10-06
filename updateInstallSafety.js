const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// UUID v5 gerado pelo electron-builder para o appId atual. Ele é a chave que
// o instalador NSIS usa em HKCU/HKLM para guardar a pasta de instalação.
const CURRENT_NSIS_APP_GUID = '025175a5-ceff-5f1f-b522-bb01317a81f5';

function normalizeWindowsPath(value) {
  if (!value || typeof value !== 'string') return '';
  return path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}

function sameWindowsPath(left, right) {
  const normalizedLeft = normalizeWindowsPath(left);
  const normalizedRight = normalizeWindowsPath(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function parseRegistryInstallLocation(output) {
  const match = String(output || '').match(/InstallLocation\s+REG_\w+\s+(.+)$/im);
  return match ? match[1].trim() : null;
}

function queryRegistryInstallLocation(execFileImpl, hive, view) {
  const registryKey = `${hive}\\Software\\${CURRENT_NSIS_APP_GUID}`;
  return new Promise((resolve) => {
    execFileImpl(
      'reg.exe',
      ['query', registryKey, '/v', 'InstallLocation', `/reg:${view}`],
      { windowsHide: true },
      (error, stdout) => resolve(error ? null : parseRegistryInstallLocation(stdout))
    );
  });
}

function uniqueLocations(locations) {
  return [...new Set(locations.filter(Boolean).map(normalizeWindowsPath))];
}

function createWindowsRegistryReader(execFileImpl = execFile) {
  return async () => {
    const [perUser32, perUser64, perMachine32, perMachine64] = await Promise.all([
      queryRegistryInstallLocation(execFileImpl, 'HKCU', '32'),
      queryRegistryInstallLocation(execFileImpl, 'HKCU', '64'),
      queryRegistryInstallLocation(execFileImpl, 'HKLM', '32'),
      queryRegistryInstallLocation(execFileImpl, 'HKLM', '64'),
    ]);
    return {
      perUser: uniqueLocations([perUser32, perUser64]),
      perMachine: uniqueLocations([perMachine32, perMachine64]),
    };
  };
}

function canWriteInstallDirectory(installDirectory, fsImpl = fs) {
  try {
    fsImpl.accessSync(installDirectory, fsImpl.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * O /S só é seguro se a instalação NSIS atual, por usuário, apontar para a
 * mesma pasta do executável em execução. Isso impede que um update legado ou
 * ambíguo escolha outro escopo/pasta sem intervenção do usuário.
 */
async function getWindowsUpdateInstallDecision({
  platform = process.platform,
  executablePath = process.execPath,
  registryReader = createWindowsRegistryReader(),
  fsImpl = fs,
} = {}) {
  if (platform !== 'win32') return { mode: 'blocked', reason: 'not-windows' };

  const installDirectory = path.win32.dirname(executablePath);
  const locations = await registryReader();
  const perUserMatches = locations.perUser.filter((location) => sameWindowsPath(location, installDirectory));
  const perMachineMatches = locations.perMachine.filter((location) => sameWindowsPath(location, installDirectory));

  if (perUserMatches.length === 1 && perMachineMatches.length === 0 &&
      locations.perUser.length === 1 && locations.perMachine.length === 0) {
    if (!canWriteInstallDirectory(installDirectory, fsImpl)) {
      return { mode: 'blocked', reason: 'per-user-directory-not-writable', installDirectory };
    }
    return { mode: 'silent', scope: 'per-user', installDirectory };
  }

  if (perMachineMatches.length === 1 && perUserMatches.length === 0 &&
      locations.perMachine.length === 1 && locations.perUser.length === 0) {
    return { mode: 'assisted', scope: 'per-machine', installDirectory };
  }

  return { mode: 'blocked', reason: 'unrecognized-or-ambiguous-installation', installDirectory };
}

function createUpdateInstallPlan(decision) {
  if (!decision || decision.mode === 'blocked') return null;
  return {
    isSilent: decision.mode === 'silent',
    isForceRunAfter: true,
    // /D é enviado somente no caminho silencioso já validado. Assim ele
    // preserva explicitamente a pasta atual e não escolhe outro escopo.
    installDirectory: decision.mode === 'silent' ? decision.installDirectory : undefined,
  };
}

function runUpdateInstallPlan(updater, plan) {
  if (!updater || !plan) throw new Error('Plano de instalação de atualização indisponível.');
  updater.installDirectory = plan.installDirectory;
  updater.quitAndInstall(plan.isSilent, plan.isForceRunAfter);
}

module.exports = {
  CURRENT_NSIS_APP_GUID,
  createUpdateInstallPlan,
  createWindowsRegistryReader,
  getWindowsUpdateInstallDecision,
  parseRegistryInstallLocation,
  runUpdateInstallPlan,
  sameWindowsPath,
};
