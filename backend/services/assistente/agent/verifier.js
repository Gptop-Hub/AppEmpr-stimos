function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function aggregateMetricSnapshots(sources) {
  const map = new Map();
  const list = Array.isArray(sources) ? sources : [];
  for (const src of list) {
    if (!src || typeof src !== 'object') continue;
    const metrics = src.metrics && typeof src.metrics === 'object' ? src.metrics : null;
    if (!metrics) continue;
    for (const [key, rawValue] of Object.entries(metrics)) {
      const n = toFiniteNumber(rawValue, null);
      if (n == null) continue;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push({
        value: n,
        source: src.source_type || 'unknown',
      });
    }
  }
  return map;
}

function detectMetricConflicts(sources) {
  const metricMap = aggregateMetricSnapshots(sources);
  const conflicts = [];

  for (const [metric, readings] of metricMap.entries()) {
    if (!Array.isArray(readings) || readings.length < 2) continue;
    const min = Math.min(...readings.map((r) => r.value));
    const max = Math.max(...readings.map((r) => r.value));
    const delta = Math.abs(max - min);
    if (delta > 0.01) {
      conflicts.push({
        type: 'metric_conflict',
        metric,
        delta,
        readings,
      });
    }
  }

  return conflicts;
}

function countBySourceType(sources) {
  const counter = {
    database: 0,
    code: 0,
    logs: 0,
    endpoint: 0,
    inference: 0,
    other: 0,
  };

  const list = Array.isArray(sources) ? sources : [];
  for (const src of list) {
    const type = String(src && src.source_type ? src.source_type : '').toLowerCase();
    if (type.startsWith('database')) counter.database += 1;
    else if (type.startsWith('code')) counter.code += 1;
    else if (type.startsWith('log')) counter.logs += 1;
    else if (type.startsWith('endpoint')) counter.endpoint += 1;
    else if (type === 'inference') counter.inference += 1;
    else counter.other += 1;
  }

  return counter;
}

function computeConfidence({ routeCategory, sourceStats, conflicts, executionErrors }) {
  let confidence = 0.45;

  if (sourceStats.database > 0) confidence += 0.33;
  if (sourceStats.endpoint > 0) confidence += 0.08;
  if (sourceStats.code > 0) confidence += 0.2;
  if (sourceStats.logs > 0) confidence += 0.06;
  if (sourceStats.inference > 0 && sourceStats.database === 0 && sourceStats.code === 0) confidence -= 0.08;

  if (routeCategory === 'question_real_data' && sourceStats.database === 0 && sourceStats.endpoint === 0) {
    confidence -= 0.25;
  }
  if ((routeCategory === 'question_architecture_code' || routeCategory === 'question_business_rule') && sourceStats.code === 0) {
    confidence -= 0.2;
  }

  if (Array.isArray(conflicts) && conflicts.length) {
    confidence -= Math.min(0.35, conflicts.length * 0.12);
  }
  if (Array.isArray(executionErrors) && executionErrors.length) {
    confidence -= Math.min(0.25, executionErrors.length * 0.08);
  }

  confidence = Math.max(0, Math.min(0.99, confidence));
  return Number(confidence.toFixed(2));
}

function isValidated({ routeCategory, sourceStats, conflicts }) {
  const hasData = sourceStats.database > 0 || sourceStats.endpoint > 0;
  const hasCode = sourceStats.code > 0;

  if (Array.isArray(conflicts) && conflicts.length > 0) return false;

  if (routeCategory === 'question_real_data') return hasData;
  if (routeCategory === 'question_business_rule' || routeCategory === 'question_architecture_code') {
    return hasCode;
  }
  if (routeCategory === 'action_modification') {
    return hasCode || hasData;
  }

  return hasData || hasCode || sourceStats.logs > 0;
}

function buildVerificationReport({ intentRoute, sources, executionErrors }) {
  const route = intentRoute && typeof intentRoute === 'object' ? intentRoute : {};
  const sourceStats = countBySourceType(sources);
  const conflicts = detectMetricConflicts(sources);

  const confidence = computeConfidence({
    routeCategory: String(route.category || ''),
    sourceStats,
    conflicts,
    executionErrors,
  });

  return {
    validated: isValidated({
      routeCategory: String(route.category || ''),
      sourceStats,
      conflicts,
    }),
    confidence,
    source_stats: sourceStats,
    conflicts,
    execution_errors: Array.isArray(executionErrors) ? executionErrors : [],
  };
}

module.exports = {
  buildVerificationReport,
};
