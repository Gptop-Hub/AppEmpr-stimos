const db = require('../../models/database');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function toFeedbackType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'approved') return 'approved';
  if (text === 'rejected') return 'rejected';
  return '';
}

function toSafeString(value, max = 500) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function safeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return '{}';
  }
}

async function recordAssistantFeedback({
  sessionId,
  turnId,
  feedback,
  route = '',
  note = '',
  payload = {},
}) {
  const sid = toSafeString(sessionId, 120);
  const tid = toSafeString(turnId, 120);
  const fb = toFeedbackType(feedback);

  if (!sid || !tid) {
    throw new Error('session_id e turn_id sao obrigatorios para feedback.');
  }
  if (!fb) {
    throw new Error('feedback invalido. Use approved ou rejected.');
  }

  const routeSafe = toSafeString(route, 240);
  const noteSafe = toSafeString(note, 500);
  const payloadJson = safeJson(payload);

  const result = await run(
    `
      INSERT INTO assistant_feedback
        (session_id, turn_id, feedback, route, note, payload_json, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, datetime('now'))
    `,
    [sid, tid, fb, routeSafe || null, noteSafe || null, payloadJson]
  );

  return {
    id: result.lastID,
    session_id: sid,
    turn_id: tid,
    feedback: fb,
  };
}

module.exports = {
  recordAssistantFeedback,
};
