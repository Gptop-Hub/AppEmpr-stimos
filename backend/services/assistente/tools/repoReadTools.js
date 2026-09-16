const fs = require('fs');
const path = require('path');
const {
  REPO_READ_TOOL_NAMES,
  isPlainObject,
  validateToolCall,
} = require('../contracts');
const {
  getRepoRoot,
  getScopeRoots,
  normalizeAndAssertSafePath,
  redactSensitiveText,
  isTextFilePath,
} = require('../repoReadSecurity');

const MAX_FILE_SCAN = 2500;
const MAX_CONTENT_CHARS = 6000;

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function makeRepoError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function safeStat(absPath) {
  try {
    return fs.statSync(absPath);
  } catch {
    return null;
  }
}

function walkDirectory(absStart, options = {}) {
  const maxDepth = Number(options.maxDepth || 2);
  const maxEntries = Number(options.maxEntries || 120);
  const repoRoot = getRepoRoot();
  const queue = [{ absPath: absStart, depth: 0 }];
  const entries = [];
  let truncated = false;

  while (queue.length) {
    const item = queue.shift();
    const stat = safeStat(item.absPath);
    if (!stat || !stat.isDirectory()) continue;

    let dirItems = [];
    try {
      dirItems = fs.readdirSync(item.absPath);
    } catch {
      continue;
    }

    for (const name of dirItems) {
      const absChild = path.join(item.absPath, name);
      const st = safeStat(absChild);
      if (!st) continue;

      const rel = toPosixPath(path.relative(repoRoot, absChild));
      if (!rel || rel.startsWith('..')) continue;

      entries.push({
        path: rel,
        type: st.isDirectory() ? 'dir' : 'file',
      });
      if (entries.length >= maxEntries) {
        truncated = true;
        return { entries, truncated };
      }

      if (st.isDirectory() && item.depth < maxDepth) {
        queue.push({ absPath: absChild, depth: item.depth + 1 });
      }
    }
  }

  return { entries, truncated };
}

function collectSearchFiles(scope, maxFiles = MAX_FILE_SCAN) {
  const roots = getScopeRoots(scope);
  const out = [];
  const seen = new Set();
  const queue = roots.slice();

  while (queue.length && out.length < maxFiles) {
    const abs = queue.shift();
    const st = safeStat(abs);
    if (!st) continue;
    if (st.isDirectory()) {
      let children = [];
      try {
        children = fs.readdirSync(abs);
      } catch {
        continue;
      }
      for (const child of children) {
        queue.push(path.join(abs, child));
      }
      continue;
    }
    if (!st.isFile()) continue;
    if (!isTextFilePath(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }

  return out;
}

function sliceTextLimit(text, maxChars = MAX_CONTENT_CHARS) {
  const input = String(text || '');
  if (input.length <= maxChars) return { text: input, truncated: false };
  return {
    text: input.slice(0, maxChars),
    truncated: true,
  };
}

async function repoList(args = {}) {
  const scope = String(args.scope || 'project');
  const maxDepth = Number(args.max_depth || 2);
  const maxEntries = Number(args.max_entries || 120);
  const relPath = String(args.rel_path || '').trim();

  if (relPath) {
    const safe = normalizeAndAssertSafePath(relPath, scope);
    const stat = safeStat(safe.absPath);
    if (!stat) throw makeRepoError('ERR_NOT_FOUND', `Path nao encontrado: ${safe.relPath}`);
    if (stat.isFile()) {
      return {
        scope,
        rel_path: safe.relPath,
        total_found: 1,
        truncated: false,
        entries: [{ path: safe.relPath, type: 'file' }],
      };
    }
    const walked = walkDirectory(safe.absPath, { maxDepth, maxEntries });
    return {
      scope,
      rel_path: safe.relPath,
      total_found: walked.entries.length,
      truncated: walked.truncated,
      entries: walked.entries,
    };
  }

  const allEntries = [];
  let truncated = false;
  const roots = getScopeRoots(scope);
  const repoRoot = getRepoRoot();
  for (const root of roots) {
    const st = safeStat(root);
    if (st && st.isFile()) {
      const rel = toPosixPath(path.relative(repoRoot, root));
      allEntries.push({ path: rel, type: 'file' });
      if (allEntries.length >= maxEntries) {
        truncated = true;
        break;
      }
      continue;
    }
    const walked = walkDirectory(root, {
      maxDepth,
      maxEntries: Math.max(1, maxEntries - allEntries.length),
    });
    allEntries.push(...walked.entries);
    if (walked.truncated || allEntries.length >= maxEntries) {
      truncated = true;
      break;
    }
  }

  return {
    scope,
    rel_path: '',
    total_found: allEntries.length,
    truncated,
    entries: allEntries.slice(0, maxEntries),
  };
}

async function repoSearch(args = {}) {
  const scope = String(args.scope || 'project');
  const query = String(args.query || '').trim();
  if (!query) throw makeRepoError('ERR_QUERY_INVALID', 'Query vazia.');
  const isRegex = Boolean(args.is_regex);
  const caseSensitive = Boolean(args.case_sensitive);
  const maxMatches = Number(args.max_matches || 50);
  const files = collectSearchFiles(scope);

  let regex = null;
  if (isRegex) {
    try {
      regex = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } catch {
      throw makeRepoError('ERR_QUERY_INVALID', 'Regex invalida em repo_search.');
    }
  }

  const repoRoot = getRepoRoot();
  const matches = [];
  let truncated = false;

  for (const absFile of files) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    let content = '';
    try {
      content = fs.readFileSync(absFile, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      const line = lines[idx];
      let hasMatch = false;
      let column = 1;
      if (regex) {
        regex.lastIndex = 0;
        const m = regex.exec(line);
        if (m) {
          hasMatch = true;
          column = Number(m.index || 0) + 1;
        }
      } else {
        const haystack = caseSensitive ? line : line.toLowerCase();
        const needle = caseSensitive ? query : query.toLowerCase();
        const foundAt = haystack.indexOf(needle);
        if (foundAt >= 0) {
          hasMatch = true;
          column = foundAt + 1;
        }
      }
      if (!hasMatch) continue;
      const rel = toPosixPath(path.relative(repoRoot, absFile));
      matches.push({
        path: rel,
        line: idx + 1,
        column,
        text: redactSensitiveText(String(line || '').trim()).slice(0, 220),
      });
    }
  }

  return {
    scope,
    query,
    total_matches: matches.length,
    truncated,
    matches,
  };
}

async function repoOpen(args = {}) {
  const scope = String(args.scope || 'project');
  const filePath = String(args.path || '').trim();
  if (!filePath) throw makeRepoError('ERR_PATH_INVALID', 'Path vazio em repo_open.');
  const startLine = Math.max(1, Number(args.start_line || 1));
  const maxLines = Math.max(1, Number(args.max_lines || 80));

  const safe = normalizeAndAssertSafePath(filePath, scope);
  const stat = safeStat(safe.absPath);
  if (!stat || !stat.isFile()) {
    throw makeRepoError('ERR_NOT_FOUND', `Arquivo nao encontrado: ${safe.relPath}`);
  }
  if (!isTextFilePath(safe.absPath)) {
    throw makeRepoError('ERR_PATH_DENIED', `Arquivo nao suportado para leitura: ${safe.relPath}`);
  }

  const raw = fs.readFileSync(safe.absPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;
  const from = Math.min(totalLines, startLine);
  const to = Math.min(totalLines, from + maxLines - 1);
  const selected = lines.slice(Math.max(0, from - 1), to).join('\n');
  const redacted = redactSensitiveText(selected);
  const limited = sliceTextLimit(redacted, MAX_CONTENT_CHARS);

  return {
    path: safe.relPath,
    start_line: from,
    end_line: to,
    total_lines: totalLines,
    content: limited.text,
    truncated: limited.truncated,
  };
}

async function repoSnippets(args = {}) {
  const scope = String(args.scope || 'project');
  const hits = Array.isArray(args.hits) ? args.hits : [];
  const before = Math.max(0, Number(args.context_before || 2));
  const after = Math.max(0, Number(args.context_after || 3));
  const maxSnippets = Math.max(1, Number(args.max_snippets || 3));
  const maxCharsTotal = Math.max(300, Number(args.max_chars_total || 3200));

  const snippets = [];
  let totalChars = 0;
  let truncated = false;

  for (const hit of hits) {
    if (snippets.length >= maxSnippets) {
      truncated = true;
      break;
    }
    if (!isPlainObject(hit)) continue;
    const line = Math.max(1, Number(hit.line || 1));
    const opened = await repoOpen({
      scope,
      path: String(hit.path || ''),
      start_line: Math.max(1, line - before),
      max_lines: before + after + 1,
    });
    const snippetText = redactSensitiveText(String(opened.content || '').trim());
    if (!snippetText) continue;
    if (totalChars + snippetText.length > maxCharsTotal) {
      truncated = true;
      break;
    }
    totalChars += snippetText.length;
    snippets.push({
      path: opened.path,
      start_line: opened.start_line,
      end_line: opened.end_line,
      snippet: snippetText,
      reason: `match_line_${line}`,
    });
  }

  return {
    total_snippets: snippets.length,
    truncated,
    snippets,
  };
}

async function executeRepoReadTool(toolName, args = {}, _ctx = {}) {
  const name = String(toolName || '').trim();
  if (!REPO_READ_TOOL_NAMES.includes(name)) {
    throw makeRepoError('ERR_TOOL_NOT_ALLOWED', `Tool repo_read nao permitida: ${name}`);
  }

  const validation = validateToolCall(name, args);
  if (!validation.ok) {
    throw makeRepoError(
      'ERR_INVALID_ARGS',
      validation.errors && validation.errors.length
        ? validation.errors[0]
        : 'Parametros invalidos.'
    );
  }

  const normalized = validation.normalized_args || {};
  if (name === 'repo_list') return repoList(normalized);
  if (name === 'repo_search') return repoSearch(normalized);
  if (name === 'repo_open') return repoOpen(normalized);
  if (name === 'repo_snippets') return repoSnippets(normalized);

  throw makeRepoError('ERR_TOOL_NOT_ALLOWED', `Tool repo_read nao suportada: ${name}`);
}

module.exports = {
  executeRepoReadTool,
  repoList,
  repoSearch,
  repoOpen,
  repoSnippets,
};
