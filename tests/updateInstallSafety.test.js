const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createUpdateInstallPlan,
  getWindowsUpdateInstallDecision,
  runUpdateInstallPlan,
} = require('../updateInstallSafety');

const perUserDirectory = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\App Emprestimos';
const perMachineDirectory = 'C:\\Program Files\\App Emprestimos';

function readableFs() {
  return { constants: { W_OK: 2 }, accessSync() {} };
}

test('update interno de instalação per-user usa /S, preserva a pasta e força reabertura', async () => {
  const decision = await getWindowsUpdateInstallDecision({
    platform: 'win32',
    executablePath: `${perUserDirectory}\\App Emprestimos.exe`,
    registryReader: async () => ({ perUser: [perUserDirectory], perMachine: [] }),
    fsImpl: readableFs(),
  });
  assert.deepEqual(decision, { mode: 'silent', scope: 'per-user', installDirectory: perUserDirectory });

  const plan = createUpdateInstallPlan(decision);
  const calls = [];
  const updater = {
    quitAndInstall: (...args) => calls.push(args),
  };
  runUpdateInstallPlan(updater, plan);
  assert.equal(updater.installDirectory, perUserDirectory);
  assert.deepEqual(calls, [[true, true]]);
});

test('instalação per-machine não tenta /S e mantém fallback assistido para UAC', async () => {
  const decision = await getWindowsUpdateInstallDecision({
    platform: 'win32',
    executablePath: `${perMachineDirectory}\\App Emprestimos.exe`,
    registryReader: async () => ({ perUser: [], perMachine: [perMachineDirectory] }),
    fsImpl: readableFs(),
  });
  assert.deepEqual(decision, { mode: 'assisted', scope: 'per-machine', installDirectory: perMachineDirectory });

  const plan = createUpdateInstallPlan(decision);
  const calls = [];
  const updater = { quitAndInstall: (...args) => calls.push(args) };
  runUpdateInstallPlan(updater, plan);
  assert.equal(updater.installDirectory, undefined);
  assert.deepEqual(calls, [[false, true]]);
});

test('registro legado, ausente ou ambíguo não inicia instalador e não cria cópia paralela', async () => {
  const decision = await getWindowsUpdateInstallDecision({
    platform: 'win32',
    executablePath: `${perUserDirectory}\\App Emprestimos.exe`,
    registryReader: async () => ({
      perUser: ['C:\\Users\\Ana\\AppData\\Local\\Programs\\Instalação Antiga'],
      perMachine: [perMachineDirectory],
    }),
    fsImpl: readableFs(),
  });
  assert.equal(decision.mode, 'blocked');
  assert.equal(decision.reason, 'unrecognized-or-ambiguous-installation');
  assert.equal(createUpdateInstallPlan(decision), null);
});
