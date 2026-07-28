import React, { useEffect, useState } from "react";
import { subscribeToast } from "../lib/toast.js";

// ToastHost — one instance at the app root. Auto-dismisses after 4s.

const TTL = 4000;

export default function ToastHost() {
  const [toasts, setToasts] = useState([]);

  useEffect(
    () =>
      subscribeToast((t) => {
        setToasts((cur) => [...cur, t]);
        setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), TTL);
      }),
    [],
  );

  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
