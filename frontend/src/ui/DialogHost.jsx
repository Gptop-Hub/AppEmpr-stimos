import React, { useEffect, useMemo, useRef, useState } from "react";

const TOAST_MIN_TIMEOUT = 1200;

const normalizeToast = (payload) => {
  if (payload && typeof payload === "object") {
    return {
      message: String(payload.message ?? ""),
      timeout: payload.timeout,
    };
  }
  return { message: String(payload ?? "") };
};

const normalizeModal = (payload) => {
  if (payload && typeof payload === "object") {
    return {
      message: String(payload.message ?? ""),
      title: payload.title,
      okText: payload.okText,
      cancelText: payload.cancelText,
      defaultValue: payload.defaultValue,
      placeholder: payload.placeholder,
      typeAttr: payload.type,
    };
  }
  return { message: String(payload ?? "") };
};

export const dialog = {
  _emit: null,
  toast(payload) {
    const evt = normalizeToast(payload);
    return new Promise((resolve) => {
      dialog._emit?.({ type: "toast", ...evt, resolve });
    });
  },
  alert(payload) {
    const evt = normalizeModal(payload);
    return new Promise((resolve) => {
      dialog._emit?.({ type: "alert", ...evt, resolve });
    });
  },
  confirm(payload) {
    const evt = normalizeModal(payload);
    return new Promise((resolve) => {
      dialog._emit?.({ type: "confirm", ...evt, resolve });
    });
  },
  prompt(payload) {
    const evt = normalizeModal(payload);
    return new Promise((resolve) => {
      dialog._emit?.({ type: "prompt", ...evt, resolve });
    });
  },
};

export default function DialogHost() {
  const [toasts, setToasts] = useState([]); // {id, message}
  const [modal, setModal] = useState(null); // {type, message, resolve, ...}
  const [promptValue, setPromptValue] = useState("");
  const idRef = useRef(1);
  const promptInputRef = useRef(null);

  // registra o emissor global
  useEffect(() => {
    dialog._emit = (evt) => {
      if (evt.type === "toast") {
        const id = idRef.current++;
        const timeout = Math.max(TOAST_MIN_TIMEOUT, Number(evt.timeout ?? 3000));
        setToasts((t) => [...t, { id, message: evt.message }]);
        evt.resolve?.(true);
        setTimeout(() => {
          setToasts((t) => t.filter((x) => x.id !== id));
        }, timeout);
      } else if (evt.type === "alert" || evt.type === "confirm" || evt.type === "prompt") {
        setModal({
          type: evt.type,
          message: evt.message,
          title: evt.title,
          okText: evt.okText,
          cancelText: evt.cancelText,
          defaultValue: evt.defaultValue,
          placeholder: evt.placeholder,
          typeAttr: evt.typeAttr,
          resolve: evt.resolve,
        });
      }
    };
    return () => {
      dialog._emit = null;
    };
  }, []);

  useEffect(() => {
    if (modal?.type === "prompt") {
      setPromptValue(String(modal.defaultValue ?? ""));
      const id = requestAnimationFrame(() => {
        promptInputRef.current?.focus();
        promptInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [modal]);

  const closeAlert = () => {
    if (!modal) return;
    modal.resolve?.(true);
    setModal(null);
  };

  const confirmOk = () => {
    if (!modal) return;
    if (modal.type === "prompt") {
      modal.resolve?.(promptValue);
    } else {
      modal.resolve?.(true);
    }
    setModal(null);
  };

  const confirmCancel = () => {
    if (!modal) return;
    if (modal.type === "prompt") {
      modal.resolve?.(null);
    } else {
      modal.resolve?.(false);
    }
    setModal(null);
  };

  // fechar com ESC/ENTER
  useEffect(() => {
    if (!modal) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (modal.type === "alert") closeAlert();
        else confirmCancel();
      }
      if (e.key === "Enter") {
        if (modal.type === "alert") closeAlert();
        else confirmOk();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, promptValue]);

  // estilos inline simples (sem libs)
  const styles = useMemo(
    () => ({
      toastWrap: {
        position: "fixed",
        right: 16,
        bottom: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        pointerEvents: "none",
      },
      toast: {
        pointerEvents: "auto",
        background: "rgba(31,41,55,0.95)",
        color: "#fff",
        padding: "10px 14px",
        borderRadius: 8,
        boxShadow: "0 6px 18px rgba(0,0,0,0.3)",
        maxWidth: 360,
        fontSize: 14,
      },
      overlay: {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9998,
      },
      modal: {
        background: "#fff",
        color: "#111",
        width: "min(520px, 92vw)",
        borderRadius: 12,
        boxShadow: "0 10px 28px rgba(0,0,0,0.3)",
        padding: 18,
      },
      modalTitle: { fontSize: 16, fontWeight: 700, marginBottom: 8 },
      modalMsg: { fontSize: 14, lineHeight: 1.4, marginBottom: 14, whiteSpace: "pre-wrap" },
      modalRow: { display: "flex", gap: 8, justifyContent: "flex-end" },
      btn: {
        border: "1px solid #d1d5db",
        borderRadius: 8,
        background: "#f9fafb",
        padding: "8px 14px",
        cursor: "pointer",
      },
      btnPrimary: {
        border: "1px solid #d97706",
        background: "#f59e0b",
        color: "#111",
      },
      input: {
        width: "100%",
        padding: "8px 10px",
        borderRadius: 6,
        border: "1px solid #d1d5db",
        fontSize: 14,
        marginBottom: 14,
      },
    }),
    []
  );

  const modalTitle =
    modal?.title ??
    (modal?.type === "alert"
      ? "Mensagem"
      : modal?.type === "confirm"
      ? "Confirmacao"
      : "Informe o valor");

  const okLabel = modal?.okText || "OK";
  const cancelLabel = modal?.cancelText || "Cancelar";

  return (
    <>
      <div style={styles.toastWrap}>
        {toasts.map((t) => (
          <div key={t.id} style={styles.toast}>
            {t.message}
          </div>
        ))}
      </div>

      {modal && (
        <div
          style={styles.overlay}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              if (modal.type === "alert") closeAlert();
              else confirmCancel();
            }
          }}
        >
          <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>{modalTitle}</div>
            <div style={styles.modalMsg}>{modal.message}</div>
            {modal.type === "prompt" && (
              <input
                ref={promptInputRef}
                style={styles.input}
                type={modal.typeAttr || "text"}
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                placeholder={modal.placeholder || ""}
              />
            )}
            <div style={styles.modalRow}>
              {modal.type === "alert" ? (
                <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={closeAlert}>
                  OK
                </button>
              ) : (
                <>
                  <button style={styles.btn} onClick={confirmCancel}>
                    {cancelLabel}
                  </button>
                  <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={confirmOk}>
                    {okLabel}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}