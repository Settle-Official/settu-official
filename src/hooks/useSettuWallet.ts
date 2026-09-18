"use client";

import { useCallback, useState } from "react";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  createSealedWallet,
  unsealSecret,
  type SealedWallet,
  type UnlockWith,
} from "@/lib/stellar/settu-wallet/keys";
import { STELLAR_HORIZON_URL } from "@/lib/stellar/settu-wallet/account";
import {
  isUnlocked,
  lockWallet,
  unlockWallet,
  unlockedAddress,
} from "@/lib/stellar/settu-wallet/session";
import {
  getKeyBlob,
  putKeyBlob,
  requestChallenge,
  submitSignature,
} from "@/lib/api/wallets";

interface CreateResult {
  address: string;
  walletId: string;
  /** Shown once. Losing every unlock method loses the funds. */
  recoveryCode: string;
}

// Created, sealed and signed in the browser. Anything that crosses the
// network is already encrypted.
export function useSettuWallet() {
  const [address, setAddress] = useState<string | null>(unlockedAddress());
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(
    async (password: string): Promise<CreateResult> => {
      setIsBusy(true);
      setError(null);
      try {
        const { sealed, publicKey, recoveryCode } =
          await createSealedWallet(password);

        // Sponsor pays the reserves; we co-sign with the key we just made.
        const res = await fetch("/api/wallet/sponsor-account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey }),
        });
        if (!res.ok) {
          throw new Error(
            (await res.json().catch(() => ({})))?.error ??
              "Could not create your wallet",
          );
        }
        const { xdr } = (await res.json()) as { xdr: string };

        // Unseal rather than keep the secret in a local: the blob is the only
        // copy from here on, so this also proves it opens.
        const secret = await unsealSecret(sealed, {
          type: "password",
          secret: password,
        });
        const tx = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC);
        tx.sign(Keypair.fromSecret(secret));

        // The sponsor is this transaction's source, so it already pays the fee
        // and no fee bump is involved.
        await submitToHorizon(tx.toXDR());

        const walletId = await linkToAccount(publicKey, secret);
        await putKeyBlob(walletId, sealed);

        await unlockWallet(sealed, { type: "password", secret: password });
        setAddress(publicKey);
        return { address: publicKey, walletId, recoveryCode };
      } catch (err: any) {
        setError(err?.message ?? "Could not create your wallet");
        throw err;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  const unlock = useCallback(
    async (walletId: string, method: UnlockWith): Promise<string> => {
      setIsBusy(true);
      setError(null);
      try {
        const { sealed } = await getKeyBlob(walletId);
        const opened = await unlockWallet(sealed as SealedWallet, method);
        setAddress(opened);
        return opened;
      } catch (err: any) {
        setError(err?.message ?? "Could not unlock your wallet");
        throw err;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  const lock = useCallback(() => {
    lockWallet();
    setAddress(null);
  }, []);

  return {
    address,
    isUnlocked: isUnlocked(),
    isBusy,
    error,
    create,
    unlock,
    lock,
  };
}

// Links through the same challenge/verify path an external wallet uses, so
// control is proved by signature and the address cannot be squatted.
async function linkToAccount(publicKey: string, secret: string) {
  const { nonce, challenge } = await requestChallenge("stellar", publicKey);
  const tx = TransactionBuilder.fromXDR(challenge, Networks.PUBLIC);
  tx.sign(Keypair.fromSecret(secret));
  const { id } = await submitSignature(nonce, tx.toXDR());
  return id;
}

async function submitToHorizon(xdr: string): Promise<void> {
  const res = await fetch(`${STELLAR_HORIZON_URL}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: xdr }),
  });
  if (!res.ok) {
    throw new Error("Stellar rejected the account creation");
  }
}
