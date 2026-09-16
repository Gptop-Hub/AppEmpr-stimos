const { createActionGateway } = require('./actionGateway');

// A proposta e a confirmacao precisam consultar exatamente o mesmo cofre de
// tokens em memoria. Este modulo e a unica instancia de processo usada pela UI.
let gateway = null;

function getActionGateway() {
  if (!gateway) gateway = createActionGateway();
  return gateway;
}

module.exports = { getActionGateway };
