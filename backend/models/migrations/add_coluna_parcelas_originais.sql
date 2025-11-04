CREATE TABLE IF NOT EXISTS parcelas_originais ( 
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parcela_id INTEGER,
  emprestimo_id INTEGER,
  numero INTEGER,
  valor_total REAL,
  valor_capital REAL,
  valor_juros REAL,
  valor_pago REAL,
  valor_excedente REAL,
  pago INTEGER,
  data_pagamento TEXT
);