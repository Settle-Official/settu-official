import { cn } from "@/lib/cn";
import type { WalletFlowState } from "@/types/stellaramp";

export interface StateSwitcherProps {
  readonly value: WalletFlowState;
  readonly onChange: (state: WalletFlowState) => void;
}

const OPTIONS: ReadonlyArray<{ key: WalletFlowState; label: string }> = [
  { key: "pre_connect", label: "Pre Connect" },
  { key: "connecting", label: "Connecting" },
  { key: "connected", label: "Connected" },
];

export function StateSwitcher({ value, onChange }: Readonly<StateSwitcherProps>) {
  return (
    <div className="inline-flex gap-1 border border-[var(--line)] bg-[var(--surface)] p-1" role="tablist" aria-label="Wallet state">
      {OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={value === option.key}
          onClick={() => onChange(option.key)}
          className={cn(
            "px-[0.8rem] py-[0.45rem] text-[0.75rem] uppercase text-[var(--muted)]",
            value === option.key && "bg-[var(--accent)] text-[var(--accent-contrast)]",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
