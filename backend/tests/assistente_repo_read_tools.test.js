const test = require('node:test');
const assert = require('node:assert/strict');

const { executeRepoReadTool } = require('../services/assistente/tools/repoReadTools');
const { redactSensitiveText } = require('../services/assistente/repoReadSecurity');
const { validateToolCall } = require('../services/assistente/contracts');

test('contrato repo_search: query obrigatoria', () => {
  const validation = validateToolCall('repo_search', { scope: 'backend' });
  assert.equal(validation.ok, false);
  assert.match(String((validation.errors || [])[0] || ''), /query/i);
});

test('repo_search encontra simbolo no backend', async () => {
  const result = await executeRepoReadTool('repo_search', {
    scope: 'backend',
    query: 'runAssistantQuery',
    max_matches: 20,
  });

  assert.equal(typeof result, 'object');
  assert.equal(Array.isArray(result.matches), true);
  assert.equal(result.matches.length > 0, true);
  assert.equal(
    result.matches.some((m) => String(m.path || '').includes('backend/services/assistente/orchestrator.js')),
    true
  );
});

test('repo_open respeita limite de linhas', async () => {
  const opened = await executeRepoReadTool('repo_open', {
    scope: 'backend',
    path: 'backend/services/assistente/orchestrator.js',
    start_line: 3000,
    max_lines: 10,
  });

  assert.equal(typeof opened, 'object');
  assert.equal(Number(opened.end_line) - Number(opened.start_line) + 1 <= 10, true);
});

test('repo_open bloqueia path traversal fora do escopo', async () => {
  await assert.rejects(
    async () => executeRepoReadTool('repo_open', {
      scope: 'backend',
      path: '../package.json',
      start_line: 1,
      max_lines: 5,
    }),
    (err) => {
      const code = String(err && err.code ? err.code : '');
      return code === 'ERR_SCOPE_NOT_ALLOWED' || code === 'ERR_PATH_TRAVERSAL';
    }
  );
});

test('repo_snippets retorna evidencias curtas e limitadas', async () => {
  const search = await executeRepoReadTool('repo_search', {
    scope: 'backend',
    query: 'executeSimpleFlow',
    max_matches: 8,
  });
  const hits = (search.matches || []).slice(0, 5).map((m) => ({
    path: m.path,
    line: m.line,
  }));

  const snippets = await executeRepoReadTool('repo_snippets', {
    scope: 'backend',
    hits,
    context_before: 2,
    context_after: 3,
    max_snippets: 2,
    max_chars_total: 500,
  });

  assert.equal(Array.isArray(snippets.snippets), true);
  assert.equal(snippets.snippets.length <= 2, true);
  const totalChars = snippets.snippets.reduce((acc, item) => acc + String(item.snippet || '').length, 0);
  assert.equal(totalChars <= 500, true);
});

test('redaction mascara tokens sensiveis', () => {
  const input = 'OPENAI_API_KEY=sk-abc1234567890XYZabc1234567890 secret=topsecret';
  const output = redactSensitiveText(input);
  assert.equal(output.includes('sk-abc1234567890XYZabc1234567890'), false);
  assert.equal(output.includes('[REDACTED'), true);
});
