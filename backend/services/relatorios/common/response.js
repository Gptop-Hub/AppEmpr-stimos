function ok(payload = {}) {
  return {
    success: true,
    ...payload,
  };
}

function fail(error, extra = {}) {
  return {
    success: false,
    error: error || 'Erro inesperado.',
    ...extra,
  };
}

function sendBadRequest(res, error, extra = {}) {
  return res.status(400).json(fail(error, extra));
}

function sendServerError(res, error, fallbackMessage, extra = {}) {
  const message =
    (error && error.message) ||
    error ||
    fallbackMessage ||
    'Erro interno no servidor.';
  return res.status(500).json(fail(message, extra));
}

module.exports = {
  ok,
  fail,
  sendBadRequest,
  sendServerError,
};

