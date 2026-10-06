ALTER TABLE parcelas ADD COLUMN parcela_uid TEXT;
UPDATE parcelas
   SET parcela_uid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
 WHERE parcela_uid IS NULL OR trim(parcela_uid) = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_parcelas_parcela_uid_unique ON parcelas(parcela_uid) WHERE parcela_uid IS NOT NULL AND trim(parcela_uid) <> '';
CREATE TRIGGER IF NOT EXISTS trg_parcelas_parcela_uid
AFTER INSERT ON parcelas
WHEN NEW.parcela_uid IS NULL OR trim(NEW.parcela_uid) = ''
BEGIN
  UPDATE parcelas
     SET parcela_uid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
   WHERE rowid = NEW.rowid;
END;
