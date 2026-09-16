import React, { useEffect, useMemo, useState } from "react";

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeParts = (parts) => {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((p) => toNumber(p))
    .filter((p) => p != null && p >= 0);
};

const getStoredBool = (key) => {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
};

const setStoredBool = (key, value) => {
  if (!key) return;
  try {
    localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // ignore
  }
};

export default function ValorEmprestadoToggle({
  parts = [],
  formatar,
  storageKey,
  defaultConsolidado = false,
  className = "",
  style,
}) {
  const valores = useMemo(() => normalizeParts(parts), [parts]);
  const total = useMemo(
    () => valores.reduce((s, v) => s + v, 0),
    [valores]
  );
  const podeToggle = valores.length > 1;

  const [consolidado, setConsolidado] = useState(() => {
    const stored = getStoredBool(storageKey);
    if (stored != null) return stored;
    return defaultConsolidado;
  });

  useEffect(() => {
    if (!storageKey) return;
    setStoredBool(storageKey, consolidado);
  }, [storageKey, consolidado]);

  const formatarValor =
    typeof formatar === "function" ? formatar : (v) => String(v);

  const texto =
    consolidado || !podeToggle
      ? formatarValor(total)
      : valores.map((v) => formatarValor(v)).join(" + ");

  const labelAcao = consolidado ? "Separar" : "Juntar";
  const iconeJoin = (
    <svg viewBox="0 0 24 12" aria-hidden="true" focusable="false">
      <path d="M2 6 L10 6 M8 4 L10 6 L8 8" />
      <path d="M22 6 L14 6 M16 4 L14 6 L16 8" />
    </svg>
  );
  const iconeSplit = (
    <svg viewBox="0 0 24 12" aria-hidden="true" focusable="false">
      <path d="M10 6 L2 6 M4 4 L2 6 L4 8" />
      <path d="M14 6 L22 6 M20 4 L22 6 L20 8" />
    </svg>
  );

  return (
    <span
      className={`valor-emprestado-toggle ${className}`.trim()}
      style={style}
    >
      {podeToggle ? (
        <button
          type="button"
          className="valor-emprestado-toggle__btn"
          onClick={() => setConsolidado((prev) => !prev)}
          title={labelAcao}
          aria-label={labelAcao}
        >
          <span className="valor-emprestado-toggle__icon">
            {consolidado ? iconeSplit : iconeJoin}
          </span>
        </button>
      ) : null}
      <span className="valor-emprestado-toggle__text">{texto}</span>
    </span>
  );
}
