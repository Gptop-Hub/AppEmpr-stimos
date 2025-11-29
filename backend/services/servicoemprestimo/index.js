const consultas = require('./consultas');
const comandos = require('./comandos');

module.exports = {
  ...consultas,
  ...comandos,
};
