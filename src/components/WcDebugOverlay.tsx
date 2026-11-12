"use client";

import { useEffect, useState } from "react";
import { WC_LOG_EVENT, clearWcLog, isWcDebug, readWcLog } from "@/lib/wallet/wc-debug";

/** The ?wcdebug=1 trace panel. Renders nothing unless debugging is on. */
export function WcDebugOverlay() {
  const [enabled, setEnabled] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!isWcDebug()) return;
    setEnabled(true);
    const update = () => setLines([...readWcLog()]);
    update();
    window.addEventListener(WC_LOG_EVENT, update);
    return () => window.removeEventListener(WC_LOG_EVENT, update);
  }, []);

  if (!enabled) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: 8,
        right: 8,
        bottom: 8,
        zIndex: 2147483647,
        maxHeight: collapsed ? 32 : "45vh",
        overflow: "auto",
        background: "rgba(0,0,0,0.88)",
        color: "#9ef29e",
        font: "11px/1.35 ui-monospace, Menlo, monospace",
        padding: 8,
        borderRadius: 8,
        border: "1px solid #3a3a3a",
      }}
    >
      <div style={{ display: "flex", gap: 12, marginBottom: 4, color: "#fff" }}>
        <strong>WalletConnect trace</strong>
        <button type="button" onClick={() => setCollapsed((c) => !c)} style={{ color: "#8cf" }}>
          {collapsed ? "show" : "hide"}
        </button>
        <button type="button" onClick={clearWcLog} style={{ color: "#8cf" }}>
          clear
        </button>
      </div>
      {!collapsed &&
        lines.map((line, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {line}
          </div>
        ))}
    </div>
  );
}
