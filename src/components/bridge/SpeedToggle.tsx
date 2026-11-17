"use client";

/**
 * Two labelled options in the offramp's USDC/NGN switch style. Used for the
 * transfer speed and for how the network fee is paid.
 */
export interface ToggleOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly detail?: string;
}

export function SpeedToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly ToggleOption<T>[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-[14px] max-[720px]:gap-[10px]">
      <span className="font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-[#bdbcbc] max-[720px]:text-[15px] max-[720px]:leading-[19px]">
        {label}
      </span>
      <div role="group" aria-label={label} className="flex gap-[4px] rounded-full bg-white/5 p-[4px]">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => !on && onChange(o.value)}
              style={{ backgroundColor: on ? "rgba(201,169,98,0.35)" : "transparent" }}
              className={`flex-1 rounded-full px-[10px] py-[12px] font-[family-name:var(--font-inter)] text-[15px] leading-[18px] transition-colors max-[720px]:py-[10px] max-[720px]:text-[14px] ${
                on ? "text-white" : "text-[#bdbcbc]"
              }`}
            >
              {o.label}
              {o.detail && <small className="mt-[2px] block text-[12px] leading-[15px] text-[#a19d9d]">{o.detail}</small>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
