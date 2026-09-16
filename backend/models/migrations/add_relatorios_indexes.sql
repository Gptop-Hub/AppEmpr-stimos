CREATE INDEX IF NOT EXISTS idx_parcelas_emprestimo_numero_versao_id
  ON parcelas (emprestimo_id, numero, versao, id);

CREATE INDEX IF NOT EXISTS idx_parcelas_vencimento_pago
  ON parcelas (vencimento, pago);

CREATE INDEX IF NOT EXISTS idx_pagamentos_data_emprestimo
  ON pagamentos (data, emprestimo_id);

CREATE INDEX IF NOT EXISTS idx_emprestimos_cliente_id
  ON emprestimos (cliente_id);
