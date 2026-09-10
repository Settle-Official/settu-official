"use client";

interface AuthFieldProps {
  readonly label: string;
  readonly type: "email" | "password";
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
}

// Mirrors FormCard's InputField so the auth screens look native rather than bolted on.
export function AuthField({
  label,
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
  disabled,
}: AuthFieldProps) {
  return (
    <div className="flex flex-col gap-[0.4rem]">
      <label className="text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
        {label}
      </label>
      <div className="flex h-[46px] items-center border border-[var(--line)] px-[0.8rem]">
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          // Real password inputs with correct autocomplete, so managers work and
          // the value is never rendered in the clear.
          autoComplete={autoComplete}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1 bg-transparent text-[0.95rem] outline-none placeholder:text-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </div>
  );
}

// Accent fills must be inline: the global unlayered `button` reset in
// globals.css beats Tailwind's layered utilities, as the mode switcher documents.
export function AuthButton({
  children,
  disabled,
  type = "submit",
  onClick,
}: {
  readonly children: React.ReactNode;
  readonly disabled?: boolean;
  readonly type?: "submit" | "button";
  readonly onClick?: () => void;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{
        backgroundColor: disabled ? "#2f2f2f" : "#C9A962",
        color: disabled ? "#777777" : "#0a0a0a",
      }}
      className="h-12 w-full font-bold uppercase tracking-[0.08em] text-[0.8rem] transition-colors disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}
