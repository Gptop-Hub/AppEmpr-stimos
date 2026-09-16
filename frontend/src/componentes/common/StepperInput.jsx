import React from "react";

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clamp = (value, min, max) => {
  let next = Math.trunc(value);
  if (Number.isFinite(min)) next = Math.max(next, min);
  if (Number.isFinite(max)) next = Math.min(next, max);
  return next;
};

export default function StepperInput({
  value,
  onChange,
  min = 0,
  max = null,
  step = 1,
  disabled = false,
  returnAs,
  allowManualInput = false,
  inputAriaLabel = "Quantidade",
  className = "",
  style,
}) {
  const rawValue = toNumber(value);
  const minValue = Number.isFinite(min) ? min : 0;
  const maxValue = Number.isFinite(max) ? max : null;
  const stepValue = Number.isFinite(step) && step > 0 ? step : 1;
  const safeValue = Number.isFinite(rawValue)
    ? clamp(rawValue, min, maxValue)
    : minValue;

  const [draftValue, setDraftValue] = React.useState(String(safeValue));

  const resolveBaseValue = () => {
    if (!allowManualInput) return safeValue;
    const parsed = Number(String(draftValue || "").replace(/\D/g, ""));
    return Number.isFinite(parsed) ? clamp(parsed, min, maxValue) : safeValue;
  };
  const currentValue = resolveBaseValue();
  const canDecrement = !disabled && (!Number.isFinite(min) || currentValue > min);
  const canIncrement =
    !disabled && (!Number.isFinite(maxValue) || currentValue < maxValue);

  React.useEffect(() => {
    if (!allowManualInput) return;
    setDraftValue(String(safeValue));
  }, [allowManualInput, safeValue]);

  const emit = (nextRaw) => {
    if (typeof onChange !== "function") return;
    const next = clamp(nextRaw, min, maxValue);
    const shouldReturnString =
      returnAs === "string" || (returnAs == null && typeof value === "string");
    onChange(shouldReturnString ? String(next) : next);
  };

  const commitDraft = () => {
    if (!allowManualInput || disabled) return;
    const parsed = Number(String(draftValue || "").replace(/\D/g, ""));
    const next = Number.isFinite(parsed) ? parsed : safeValue;
    emit(next);
    setDraftValue(String(clamp(next, min, maxValue)));
  };

  const handleManualChange = (event) => {
    if (!allowManualInput || disabled) return;
    const raw = String(event?.target?.value || "");
    const digits = raw.replace(/\D/g, "");
    setDraftValue(digits);
  };

  return (
    <div className={`stepper-input ${className}`.trim()} style={style}>
      <button
        type="button"
        className="stepper-input__btn stepper-input__btn--minus"
        onClick={() => emit(resolveBaseValue() - stepValue)}
        disabled={!canDecrement}
        aria-label="Diminuir"
      >
        -
      </button>
      <input
        type="text"
        className="stepper-input__field"
        value={
          allowManualInput
            ? draftValue
            : Number.isFinite(safeValue)
            ? safeValue
            : ""
        }
        readOnly={!allowManualInput || disabled}
        onChange={allowManualInput ? handleManualChange : undefined}
        onBlur={allowManualInput ? commitDraft : undefined}
        onKeyDown={
          allowManualInput
            ? (event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDraft();
                }
              }
            : undefined
        }
        aria-label={inputAriaLabel}
      />
      <button
        type="button"
        className="stepper-input__btn stepper-input__btn--plus"
        onClick={() => emit(resolveBaseValue() + stepValue)}
        disabled={!canIncrement}
        aria-label="Aumentar"
      >
        +
      </button>
    </div>
  );
}
