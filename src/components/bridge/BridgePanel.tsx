"use client";

import { useEffect, useReducer, useState } from "react";
import { useActiveWallet } from "@/components/app/ActiveWallet";
import { BridgeIcon } from "@/components/app/icons";
import { formatAtomic } from "@/lib/bridge/admin-units";
import {
  BRIDGE_CHAINS,
  type BridgeChainKey,
  type ChainFamily,
} from "@/lib/bridge/chains";
import { estimatedTime } from "@/lib/bridge/eta";
import {
  MIN_BRIDGE_USDC,
  addressError,
  bridgeFormReducer,
  destWalletOf,
  disableReason,
  initialBridgeForm,
  isFirstTimeAddress,
  sourceWalletOf,
  type BridgeFormState,
} from "@/lib/bridge/form-state";
import { BridgeLegCard } from "./BridgeLegCard";
import { BridgeReceiveCard } from "./BridgeReceiveCard";
import { SpeedToggle } from "./SpeedToggle";
import { useBridgeQuote } from "./useBridgeQuote";

const fieldBox =
  "flex h-[70px] w-full items-center gap-[10px] rounded-[20px] border border-[#d7d6d6]/70 px-[20px] font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-white transition-colors focus-within:border-[#d7d6d6] max-[720px]:h-[54px] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:text-[16px] max-[720px]:leading-[20px]";

/** The localStorage key for addresses a user has bridged to before (spec §8). */
export const knownAddressesKey = (user: string) => `settu:bridge-known:${user}`;

function readKnown(user: string): string[] {
  try {
    const raw = window.localStorage.getItem(knownAddressesKey(user));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return []; // unavailable storage: every pasted address is first-time
  }
}

interface Balance {
  readonly atomic: string;
  readonly decimals: number;
}

export function BridgePanel({
  onSubmit,
}: {
  /** Task 20: starts signing with the current form. */
  readonly onSubmit?: (state: BridgeFormState) => void;
} = {}) {
  const wallets = useActiveWallet();
  const [state, dispatch] = useReducer(bridgeFormReducer, undefined, () =>
    initialBridgeForm("solana", "base"),
  );
  const [balance, setBalance] = useState<Balance | null>(null);

  const evmAddress = wallets.evm.address ?? undefined;
  const stellarAddress = wallets.stellar.wallet?.publicKey;
  const solanaAddress = wallets.solana.address ?? undefined;
  useEffect(() => {
    dispatch({
      type: "walletsChanged",
      wallets: {
        evm: evmAddress,
        stellar: stellarAddress,
        solana: solanaAddress,
      },
    });
  }, [evmAddress, stellarAddress, solanaAddress]);

  const familyOf = (c: BridgeChainKey) => BRIDGE_CHAINS[c].family;
  const connectors: Record<
    ChainFamily,
    { connect: () => void; disconnect: () => void; connecting: boolean }
  > = {
    evm: {
      connect: () => wallets.evm.openConnect(),
      disconnect: () => void wallets.evm.disconnect(),
      connecting: wallets.evm.isConnecting,
    },
    stellar: {
      connect: () => void wallets.stellar.connect().catch(() => {}),
      disconnect: () => void wallets.stellar.disconnect(),
      connecting: wallets.stellar.isConnecting,
    },
    solana: {
      connect: () => void wallets.solana.connect().catch(() => {}),
      disconnect: () => void wallets.solana.disconnect(),
      connecting: wallets.solana.isConnecting,
    },
  };

  const user = sourceWalletOf(state);
  useEffect(() => {
    dispatch({
      type: "knownAddressesLoaded",
      addresses: user ? readKnown(user) : [],
    });
  }, [user]);

  useEffect(() => {
    setBalance(null);
    if (!user) return;
    let cancelled = false;
    fetch(
      `/api/bridge/balance?chain=${state.source}&address=${encodeURIComponent(user)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!cancelled && b && typeof b.atomic === "string") setBalance(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.source, user]);

  useBridgeQuote(state, dispatch);

  const src = BRIDGE_CHAINS[state.source];
  const dst = BRIDGE_CHAINS[state.dest];
  const reason = disableReason(state);
  const badAddress = addressError(state);
  const balanceText = balance
    ? formatAtomic(balance.atomic, balance.decimals)
    : null;
  const short =
    balanceText !== null && Number(state.amount) > Number(balanceText);
  const adjusted = state.quote?.breakdown.adjustedAmount;
  const isQuoting =
    !state.quote && !state.quoteError && reason === "Getting your price…";

  return (
    <div className="flex flex-col gap-[30px] max-[720px]:gap-[24px]">
      <h2 className="font-[family-name:var(--font-inter)] text-[22px] leading-[27px] text-white max-[720px]:text-[16px] max-[720px]:leading-[20px]">
        Bridge USDC
      </h2>

      {/* Two columns on desktop: the From/To cards on the left, the speed,
          fee, receive card and button on the right. One column below 1100px. */}
      <div className="grid grid-cols-2 items-start gap-x-[64px] gap-y-[30px] max-[1300px]:gap-x-[40px] max-[1100px]:grid-cols-1 max-[720px]:gap-y-[24px]">
        <div>
          <BridgeLegCard
            side="From"
            chain={state.source}
            onChainChange={(chain) => dispatch({ type: "setSource", chain })}
            wallet={user}
            isConnecting={connectors[familyOf(state.source)].connecting}
            onConnect={connectors[familyOf(state.source)].connect}
            onDisconnect={connectors[familyOf(state.source)].disconnect}
          >
            <div className={fieldBox}>
              <input
                type="number"
                inputMode="decimal"
                value={state.amount}
                onChange={(e) =>
                  dispatch({ type: "setAmount", amount: e.target.value })
                }
                onWheel={(e) => e.currentTarget.blur()}
                min={MIN_BRIDGE_USDC}
                step="0.000001"
                placeholder="0"
                aria-label="Amount in USDC"
                className="min-w-0 flex-1 bg-transparent font-[family-name:var(--font-inter)] text-[20px] leading-[24px] text-white outline-none placeholder:text-[#8d8c8c] max-[720px]:text-[16px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              {balanceText !== null && (
                <button
                  type="button"
                  onClick={() =>
                    dispatch({ type: "setAmount", amount: balanceText })
                  }
                  className="font-[family-name:var(--font-inter)] text-[14px] text-[#c9a962]"
                >
                  Max
                </button>
              )}
              <span className="rounded-full bg-[rgba(201,169,98,0.35)] px-[12px] py-[5px] font-[family-name:var(--font-inter)] text-[14px] leading-[17px] text-white">
                USDC
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-[10px] font-[family-name:var(--font-inter)] text-[16px] leading-[19px] text-white max-[720px]:gap-[8px] max-[720px]:text-[13px] max-[720px]:leading-[16px]">
              <span>Min {MIN_BRIDGE_USDC} USDC</span>
              <span
                className="size-[6px] rounded-full bg-[#c4c4c4]"
                aria-hidden="true"
              />
              <span>
                Balance:{" "}
                {!user
                  ? "—"
                  : balanceText === null
                    ? "checking…"
                    : `${Number(balanceText).toFixed(2)} USDC`}
              </span>
              {short && (
                <>
                  <span
                    className="size-[6px] rounded-full bg-[#c4c4c4]"
                    aria-hidden="true"
                  />
                  <span className="text-[#e07a7e]">More than your balance</span>
                </>
              )}
            </div>
          </BridgeLegCard>

          <button
            type="button"
            onClick={() => dispatch({ type: "swap" })}
            aria-label="Swap From and To"
            title="Swap From and To"
            className="relative z-[2] mx-auto -my-[22px] flex size-[52px] items-center justify-center rounded-full border border-white/15 bg-[#1e1c1c] text-[#c9a962] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] transition-transform duration-300 hover:rotate-180"
          >
            <BridgeIcon size={22} />
          </button>

          <BridgeLegCard
            side="To"
            chain={state.dest}
            onChainChange={(chain) => dispatch({ type: "setDest", chain })}
            wallet={state.useConnectedDest ? destWalletOf(state) : undefined}
            isConnecting={connectors[familyOf(state.dest)].connecting}
            onConnect={() => {
              dispatch({ type: "useConnectedDest" });
              connectors[familyOf(state.dest)].connect();
            }}
            onDisconnect={connectors[familyOf(state.dest)].disconnect}
          >
            <label
              className="text-center font-[family-name:var(--font-inter)] text-[13px] text-[#8d8c8c]"
              htmlFor="bridge-dest-address"
            >
              or paste a {dst.label} address
            </label>
            <input
              id="bridge-dest-address"
              value={state.useConnectedDest ? "" : state.pastedAddress}
              onChange={(e) =>
                e.target.value
                  ? dispatch({
                      type: "setPastedAddress",
                      address: e.target.value,
                    })
                  : dispatch({ type: "useConnectedDest" })
              }
              spellCheck={false}
              autoComplete="off"
              placeholder={`${dst.label} address`}
              className={`h-[56px] w-full rounded-[16px] border bg-transparent px-[16px] font-mono text-[14px] text-white outline-none placeholder:text-[#8d8c8c] ${
                badAddress
                  ? "border-[#e07a7e]"
                  : "border-[#d7d6d6]/70 focus:border-[#d7d6d6]"
              }`}
            />
            {badAddress && (
              <p className="font-[family-name:var(--font-sora)] text-[14px] leading-[21px] text-[#e07a7e]">
                {badAddress}
              </p>
            )}
            {!state.useConnectedDest &&
              state.pastedAddress.trim() &&
              !badAddress && (
                <div className="rounded-[16px] border border-[rgba(224,122,126,0.55)] bg-[#232222] px-[16px] py-[12px] font-[family-name:var(--font-sora)] text-[14px] leading-[21px] text-[#f1d6d7]">
                  <b className="font-semibold text-white">
                    Check this address carefully.
                  </b>{" "}
                  Bridged USDC can&apos;t be recalled or redirected. If this
                  isn&apos;t your {dst.label} address, the funds are lost for
                  good.
                  {isFirstTimeAddress(state) && (
                    <label className="mt-[10px] flex items-center gap-[10px] text-white">
                      <input
                        type="checkbox"
                        checked={state.firstTimeConfirmed}
                        onChange={() => dispatch({ type: "confirmFirstTime" })}
                        disabled={state.firstTimeConfirmed}
                        className="size-[18px] accent-[#c9a962]"
                      />
                      I&apos;ve checked this address
                    </label>
                  )}
                </div>
              )}
          </BridgeLegCard>
        </div>

        <div className="flex flex-col gap-[30px] rounded-[20px] bg-[#2b2a2a] p-[24px] max-[720px]:gap-[24px] max-[720px]:rounded-[14px] max-[720px]:p-[16px]">
          <SpeedToggle
            label="Transfer speed"
            value={state.speed}
            onChange={(speed) => dispatch({ type: "setSpeed", speed })}
            options={[
              {
                value: "standard",
                label: "Standard",
                detail: `0.3% · ${estimatedTime(state.source, "standard")}`,
              },
              {
                value: "fast",
                label: "Fast",
                detail: `0.6% · ${estimatedTime(state.source, "fast")}`,
              },
            ]}
          />
          {state.notice && (
            <p className="-mt-[16px] font-[family-name:var(--font-inter)] text-[14px] text-[#c9a962]">
              {state.notice}
            </p>
          )}

          <SpeedToggle
            label="Pay network fee"
            value={state.networkFeeMode}
            onChange={(mode) => dispatch({ type: "setNetworkFeeMode", mode })}
            options={[
              { value: "usdc", label: "From my USDC" },
              {
                value: "native",
                label: `In ${src.nativeSymbol}`,
                detail: "paid separately",
              },
            ]}
          />

          <BridgeReceiveCard
            source={state.source}
            dest={state.dest}
            quote={state.quote}
            isLoading={isQuoting}
            eta={estimatedTime(state.source, state.speed)}
          />
          {adjusted && (
            <p className="-mt-[16px] font-[family-name:var(--font-inter)] text-[14px] text-[#c9a962]">
              USDC bridges in steps of 0.000001, so this bridges {adjusted}{" "}
              USDC.
            </p>
          )}

          <div className="flex flex-col gap-[10px]">
            <button
              type="button"
              disabled={reason !== null || short || !onSubmit}
              onClick={() => onSubmit?.(state)}
              className="h-[80px] w-full rounded-[40px] font-[family-name:var(--font-sora)] text-[20px] font-semibold leading-[25px] text-[#111010] disabled:cursor-not-allowed disabled:opacity-50 max-[720px]:h-[58px] max-[720px]:text-[16px]"
              style={{ backgroundColor: "#ecc56f" }}
            >
              {state.amount && Number(state.amount) > 0
                ? `Bridge ${state.amount} USDC`
                : "Bridge USDC"}
            </button>
            {(reason || short) && (
              <p
                className="text-center font-[family-name:var(--font-inter)] text-[14px] text-[#a19d9d]"
                aria-live="polite"
              >
                {short ? "That's more than your balance" : reason}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
