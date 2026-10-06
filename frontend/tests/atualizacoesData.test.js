import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionReleaseCatalog, releaseNoteItems } from '../src/componentes/atualizacoesData.js';

const notes = (text) => `## Novidades\n- ${text}`;

test('a versão atual mostra somente as próprias novidades e não duplica o histórico', () => {
  const catalog = partitionReleaseCatalog({
    availableRelease: { version: '0.6.21', releaseNotes: notes('Correção da versão atual') },
    releaseHistory: [
      { version: '0.6.21', releaseNotes: notes('Cópia remota da versão atual') },
      { version: '0.6.20', releaseNotes: notes('Novidade anterior') },
    ],
  });
  assert.equal(catalog.currentRelease.version, '0.6.21');
  assert.deepEqual(releaseNoteItems(catalog.currentRelease.releaseNotes), ['Correção da versão atual']);
  assert.deepEqual(catalog.historyReleases.map((release) => release.version), ['0.6.20']);
  assert.deepEqual(releaseNoteItems(catalog.historyReleases[0].releaseNotes), ['Novidade anterior']);
});

test('histórico mantém múltiplas versões e cada versão conserva apenas suas notas', () => {
  const catalog = partitionReleaseCatalog({
    availableRelease: { version: '0.6.22', releaseNotes: notes('Nova versão') },
    releaseHistory: [
      { version: '0.6.20', releaseNotes: notes('Nota 20') },
      { version: '0.6.21', releaseNotes: notes('Nota 21') },
    ],
  });
  assert.equal(catalog.currentRelease.version, '0.6.22');
  assert.deepEqual(catalog.historyReleases.map((release) => release.version), ['0.6.21', '0.6.20']);
  assert.deepEqual(releaseNoteItems(catalog.historyReleases[0].releaseNotes), ['Nota 21']);
  assert.deepEqual(releaseNoteItems(catalog.historyReleases[1].releaseNotes), ['Nota 20']);
});

test('release sem notas não quebra a tela nem vira uma novidade inventada', () => {
  const catalog = partitionReleaseCatalog({
    availableRelease: { version: '0.6.22', releaseNotes: '' },
    releaseHistory: [
      { version: '0.6.21', releaseNotes: notes('Nota recuperável') },
      { version: '0.6.20', releaseNotes: null },
    ],
  });
  assert.equal(catalog.currentRelease, null);
  assert.deepEqual(catalog.historyReleases.map((release) => release.version), ['0.6.21']);
  assert.deepEqual(releaseNoteItems(''), []);
});

test('sem atualização pendente, a última release publicada ocupa a seção atual', () => {
  const catalog = partitionReleaseCatalog({
    releaseHistory: [
      { version: '0.6.20', releaseNotes: notes('Nota 20') },
      { version: '0.6.21', releaseNotes: notes('Nota 21') },
    ],
  });
  assert.equal(catalog.currentRelease.version, '0.6.21');
  assert.deepEqual(catalog.historyReleases.map((release) => release.version), ['0.6.20']);
});

test('sem atualização pendente, a versão instalada usa suas notas empacotadas', () => {
  const catalog = partitionReleaseCatalog({
    installedRelease: { version: '0.6.21', releaseNotes: notes('Nota da versão instalada') },
    releaseHistory: [
      { version: '0.6.22', releaseNotes: notes('Nota que não pertence ao aplicativo instalado') },
      { version: '0.6.20', releaseNotes: notes('Nota anterior') },
    ],
  });
  assert.equal(catalog.currentRelease.version, '0.6.21');
  assert.deepEqual(releaseNoteItems(catalog.currentRelease.releaseNotes), ['Nota da versão instalada']);
  assert.deepEqual(catalog.historyReleases.map((release) => release.version), ['0.6.22', '0.6.20']);
});
