"use client";

import Link from "next/link";
import { AppSelect } from "./AppSelect";
import { AppDatePicker } from "./AppDatePicker";
import {
  buildOnrampKyc,
  type OnrampIdType,
  type OnrampKycInput,
} from "@/lib/onramp/kyc";

/** What the fields hold while the user is typing. Never persisted. */
export interface OnrampKycDraft {
  readonly birthDate: string;
  readonly idType: OnrampIdType;
  readonly idNumber: string;
  readonly bvn: string;
}

export const EMPTY_KYC_DRAFT: OnrampKycDraft = {
  birthDate: "",
  idType: "nin",
  idNumber: "",
  bvn: "",
};

const ID_TYPES: ReadonlyArray<{ code: OnrampIdType; name: string }> = [
  { code: "nin", name: "NIN (National ID)" },
  { code: "passport", name: "International passport" },
  { code: "driverLicense", name: "Driver's licence" },
];

const ID_NUMBER_LABEL: Record<OnrampIdType, string> = {
  nin: "NIN",
  passport: "Passport number",
  driverLicense: "Licence number",
};

/** The draft as the order route expects it. */
export function kycDraftToInput(draft: OnrampKycDraft): OnrampKycInput {
  return {
    birthDate: draft.birthDate,
    idType: draft.idType,
    idNumber: draft.idNumber,
    ...(draft.idType === "nin" ? {} : { bvn: draft.bvn }),
  };
}

/**
 * Null when the draft would pass the server's own check, else what to fix.
 * Runs the same function the order route does, so the two can't disagree.
 */
export function kycDraftError(draft: OnrampKycDraft, fullName: string): string | null {
  const result = buildOnrampKyc(kycDraftToInput(draft), fullName);
  return result.ok ? null : result.error;
}

/** The latest birth date that makes someone 18 today, for the date picker. */
function latestAdultBirthDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 18);
  return d.toISOString().slice(0, 10);
}

interface OnrampKycFieldsProps {
  readonly value: OnrampKycDraft;
  readonly onChange: (next: OnrampKycDraft) => void;
  /** The verified refund account's holder name, used as the legal name. */
  readonly fullName: string;
  /** The agent's confirmation card: smaller fields, one column. */
  readonly compact?: boolean;
  readonly disabled?: boolean;
}

/**
 * The identity details the payment provider requires on every onramp:
 * date of birth and an ID. Shared by the onramp form and Agent Mode's
 * confirmation card, where they are typed into these fields rather than the
 * chat (chat text goes to the AI model; this must not).
 */
export function OnrampKycFields({
  value,
  onChange,
  fullName,
  compact = false,
  disabled = false,
}: OnrampKycFieldsProps) {
  const set = (patch: Partial<OnrampKycDraft>) => onChange({ ...value, ...patch });
  const isNin = value.idType === "nin";

  // Only nag about a field once it has something in it.
  const touched = !!value.birthDate && !!value.idNumber && (isNin || !!value.bvn);
  const error = touched ? kycDraftError(value, fullName || "-") : null;

  const label = compact
    ? "font-[family-name:var(--font-sora)] text-[13px] leading-[17px] text-[#bdbcbc]"
    : "font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-[#bdbcbc] max-[720px]:text-[15px] max-[720px]:leading-[19px]";
  const box = compact
    ? "flex h-[48px] w-full items-center rounded-[12px] border border-[#d7d6d6]/50 px-[14px] font-[family-name:var(--font-sora)] text-[16px] leading-[20px] text-white transition-colors focus-within:border-[#d7d6d6]"
    : "flex h-[70px] w-full items-center gap-[10px] rounded-[20px] border border-[#d7d6d6]/70 px-[20px] font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-white transition-colors focus-within:border-[#d7d6d6] max-[720px]:h-[54px] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:text-[16px] max-[720px]:leading-[20px]";
  const field = compact
    ? "flex flex-col gap-[6px]"
    : "flex flex-col gap-[14px] max-[720px]:gap-[10px]";
  const grid = compact
    ? "flex flex-col gap-[12px]"
    : "grid grid-cols-2 gap-x-[106px] gap-y-[30px] max-[1100px]:grid-cols-1 max-[1100px]:gap-x-[20px] max-[720px]:gap-y-[22px]";
  // 16px minimum on inputs: iOS zooms the page into anything smaller.
  const input =
    "min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#8d8c8c] disabled:opacity-60";

  return (
    <div className={compact ? "flex flex-col gap-[12px]" : "flex flex-col gap-[30px] max-[720px]:gap-[22px]"}>
      <p
        className={
          compact
            ? "font-[family-name:var(--font-sora)] text-[13px] leading-[19px] text-[#bdbcbc]"
            : "rounded-[20px] bg-[#2b2a2a] px-[30px] py-[16px] font-[family-name:var(--font-sora)] text-[14px] leading-[22px] text-[#bdbcbc] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:text-[12px] max-[720px]:leading-[18px]"
        }
      >
        Our payment partner must verify who is paying before it can accept your
        transfer. These details go to them with this order only. Settu does not
        store them.{" "}
        <Link
          href="/privacy"
          target="_blank"
          className="text-[#ecc56f] underline underline-offset-2"
        >
          Privacy policy
        </Link>
      </p>

      <div className={grid}>
        <div className={field}>
          <span className={label}>Date of birth</span>
          <AppDatePicker
            aria-label="Date of birth"
            value={value.birthDate}
            onChange={(birthDate) => set({ birthDate })}
            // Nobody under 18 can be selected at all.
            max={latestAdultBirthDate()}
            minYear={1906}
            compact={compact}
            disabled={disabled}
          />
        </div>

        <div className={field}>
          <span className={label}>ID type</span>
          {compact ? (
            <span className={box}>
              <select
                value={value.idType}
                onChange={(e) =>
                  set({ idType: e.target.value as OnrampIdType, idNumber: "", bvn: "" })
                }
                disabled={disabled}
                aria-label="ID type"
                className={`${input} [color-scheme:dark]`}
              >
                {ID_TYPES.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </select>
            </span>
          ) : (
            <AppSelect
              aria-label="ID type"
              value={value.idType}
              onChange={(code) =>
                set({ idType: code as OnrampIdType, idNumber: "", bvn: "" })
              }
              options={ID_TYPES}
              disabled={disabled}
            />
          )}
        </div>

        <label className={field}>
          <span className={label}>{ID_NUMBER_LABEL[value.idType]}</span>
          <span className={box}>
            <input
              type="text"
              inputMode={isNin ? "numeric" : "text"}
              autoCapitalize={isNin ? undefined : "characters"}
              autoComplete="off"
              spellCheck={false}
              value={value.idNumber}
              onChange={(e) =>
                set({
                  idNumber: isNin
                    ? e.target.value.replace(/\D/g, "").slice(0, 11)
                    : e.target.value.slice(0, 20),
                })
              }
              maxLength={isNin ? 11 : 20}
              placeholder={isNin ? "11 digits" : "As printed on your ID"}
              disabled={disabled}
              className={input}
            />
          </span>
        </label>

        {!isNin && (
          <label className={field}>
            <span className={label}>BVN</span>
            <span className={box}>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={value.bvn}
                onChange={(e) =>
                  set({ bvn: e.target.value.replace(/\D/g, "").slice(0, 11) })
                }
                maxLength={11}
                placeholder="11 digits"
                disabled={disabled}
                className={input}
              />
            </span>
          </label>
        )}
      </div>

      <p
        className={
          compact
            ? "font-[family-name:var(--font-sora)] text-[13px] leading-[19px] text-[#8d8c8c]"
            : "font-[family-name:var(--font-sora)] text-[14px] leading-[22px] text-[#8d8c8c] max-[720px]:text-[12px] max-[720px]:leading-[18px]"
        }
      >
        {fullName ? (
          <>
            Verifying as <span className="text-white">{fullName}</span>, the name on
            your refund account. Use your own bank account: the name must match your ID.
          </>
        ) : (
          "Your name is taken from your refund account. Use your own bank account: the name must match your ID."
        )}
      </p>

      {error && (
        <p
          role="alert"
          className={
            compact
              ? "font-[family-name:var(--font-sora)] text-[13px] leading-[19px] text-[#e07a7e]"
              : "font-[family-name:var(--font-sora)] text-[15px] leading-[22px] text-[#e07a7e] max-[720px]:text-[13px] max-[720px]:leading-[19px]"
          }
        >
          {error}
        </p>
      )}
    </div>
  );
}
