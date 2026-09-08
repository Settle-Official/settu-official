"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface WalletConnectPairingModalProps {
  /** The `wc:` pairing URI, or null when there's nothing to pair. */
  readonly uri: string | null;
  readonly onCancel: () => void;
}

/**
 * Renders the WalletConnect pairing URI as a scannable QR plus copy / deep-link
 * fallbacks. The app has no wallet-picker SDK on the EVM side (deliberately —
 * it only needs sign-client), so this is the one surface that turns a pairing
 * URI into something a user can actually approve.
 */
export function WalletConnectPairingModal({
  uri,
  onCancel,
}: Readonly<WalletConnectPairingModalProps>) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!uri) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(uri, { width: 320, margin: 2 })
      .then((data) => {
        if (!cancelled) setQrDataUrl(data);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!uri) return null;

  const metamaskDeepLink = `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-[92vw] max-w-[400px] border border-[var(--line)] bg-[#0c0c0c] p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="m-0 font-space-grotesk text-[1.05rem] font-bold tracking-[-0.02em]">
            CONNECT EVM WALLET
          </h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="text-[1.1rem] leading-none text-[var(--muted)] hover:text-white"
          >
            ✕
          </button>
        </div>

        <p className="mt-0 mb-3 text-[0.75rem] text-[var(--muted)]">
          Scan with your wallet&apos;s in-app scanner, or use a link below.
        </p>

        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrDataUrl}
            alt="WalletConnect pairing QR code"
            className="mx-auto block h-[280px] w-[280px] bg-white p-2"
          />
        ) : (
          <div className="mx-auto flex h-[280px] w-[280px] items-center justify-center text-[0.8rem] text-[var(--muted)]">
            Generating QR…
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(uri).then(
                () => setCopied(true),
                () => {},
              );
            }}
            className="h-10 border border-[var(--line)] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--foreground)] hover:border-[#666]"
          >
            {copied ? "Copied ✓" : "Copy pairing link"}
          </button>
          <a
            href={metamaskDeepLink}
            target="_blank"
            rel="noreferrer noopener"
            className="flex h-10 items-center justify-center border border-[var(--line)] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--foreground)] hover:border-[#666]"
          >
            Open in MetaMask
          </a>
        </div>

        <p className="mt-3 mb-0 text-[0.65rem] text-[var(--muted)]">
          Waiting for you to approve the connection in your wallet…
        </p>
      </div>
    </div>
  );
}
