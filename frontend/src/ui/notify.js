import { dialog } from "./DialogHost.jsx";

const DEFAULT_SEPARATOR = " - ";

// --- Som opcional por tipo (não quebra se o arquivo não existir) ---
const sfx = {
  success: "/sfx/success.mp3",
  error:   "/sfx/error.mp3",
  warn:    "/sfx/warn.mp3",
  info:    "/sfx/info.mp3",
};
function play(kind, opts = {}) {
  try {
    if (opts.silent) return;
    const src = sfx[kind];
    if (!src) return;
    const a = new Audio(src);
    a.volume = typeof opts.volume === "number" ? opts.volume : 0.25;
    a.play().catch(() => {/* ignora e segue a vida */});
  } catch {
    /* ignora qualquer erro de áudio */
  }
}

function withPrefix(label, msg, opts = {}) {
  const body = String(msg ?? "");
  if (opts.prefix === false || !label) return body;
  const separator = opts.separator ?? DEFAULT_SEPARATOR;
  if (!body) return label;
  return `${label}${separator}${body}`;
}

const notify = {
  success(msg, opts = {}) {
    play("success", opts);
    return dialog.toast({
      message: withPrefix("Sucesso", msg, opts),
      timeout: opts.timeout,
    });
  },
  info(msg, opts = {}) {
    play("info", opts);
    return dialog.toast({
      message: withPrefix("Info", msg, opts),
      timeout: opts.timeout,
    });
  },
  warn(msg, opts = {}) {
    play("warn", opts);
    return dialog.alert({
      message: withPrefix("Aviso", msg, opts),
      title: opts.title,
    });
  },
  error(msg, opts = {}) {
    play("error", opts);
    return dialog.alert({
      message: withPrefix("Erro", msg, opts),
      title: opts.title,
    });
  },
  confirm(msg, opts = {}) {
    play("info", opts);
    return dialog.confirm({
      message: withPrefix("", msg, opts),
      title: opts.title,
      okText: opts.okText,
      cancelText: opts.cancelText,
    });
  },
  prompt(msg, opts = {}) {
    play("info", opts);
    return dialog.prompt({
      message: withPrefix("", msg, opts),
      title: opts.title,
      okText: opts.okText,
      cancelText: opts.cancelText,
      defaultValue: opts.defaultValue,
      placeholder: opts.placeholder,
      type: opts.type,
      inputMode: opts.inputMode,
      pattern: opts.pattern,
      maxLength: opts.maxLength,
      sanitize: opts.sanitize,
    });
  },
};

export default notify;
