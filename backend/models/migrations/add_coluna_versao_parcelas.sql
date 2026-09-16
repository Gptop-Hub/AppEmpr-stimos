ALTER TABLE parcelas ADD COLUMN versao INTEGER DEFAULT 1;
UPDATE parcelas SET versao = 1 WHERE versao IS NULL;
