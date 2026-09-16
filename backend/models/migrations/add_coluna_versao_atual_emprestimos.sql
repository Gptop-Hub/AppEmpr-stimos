ALTER TABLE emprestimos ADD COLUMN versao_atual INTEGER DEFAULT 1;
UPDATE emprestimos SET versao_atual = 1 WHERE versao_atual IS NULL;
