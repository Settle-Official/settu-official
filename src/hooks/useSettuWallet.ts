"use client";

import { useCallback, useEffect, useState } from "react";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  addressFromMnemonic as solanaAddressFromMnemonic,
  keypairFromMnemonic as solanaKeypairFromMnemonic,
  signMessage as signSolanaMessage,
} from "@/lib/settu-wallet/solana";
import {
  addUnlockMethod,
  createSealedWallet,
  resealFromMnemonic,
  unsealMnemonic,
  unsealSecret,
  type SealedWallet,
  type UnlockWith,
} from "@/lib/settu-wallet/keys";
import {
  isPasskeySupported,
  registerPasskey,
  unlockWithPasskey,
} from "@/lib/settu-wallet/passkey";
import { STELLAR_HORIZON_URL } from "@/lib/settu-wallet/account";
import {
  isUnlocked,
  lockWallet,
  unlockWallet,
  unlockedAddress,
} from "@/lib/settu-wallet/session";
import {
  getKeyBlob,
  putKeyBlob,
  requestChallenge,
  submitSignature,
} from "@/lib/api/wallets";

export interface PreparedWallet {
  sealed: SealedWallet;
  publicKey: string;
  mnemonic: string;
}

interface CreateResult {
  address: string;
  walletId: string;
  /** Shown once. The only way back in without the password, and the only way out. */
  mnemonic: string;
}

// Created, sealed and signed in the browser. Anything that crosses the
// network is already encrypted.
export function useSettuWallet() {
  const [address, setAddress] = useState<string | null>(unlockedAddress());
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Local only: nothing exists on-chain yet, so a failure here costs nothing.
  const prepare = useCallback(
    async (password: string): Promise<PreparedWallet> => {
      setIsBusy(true);
      setError(null);
      try {
        return await createSealedWallet(password);
      } catch (err: any) {
        setError(err?.message ?? "Could not prepare your wallet");
        throw err;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  // Runs only after the user has the phrase, so anything that fails from here
  // leaves an account they can still recover.
  const finalize = useCallback(
    async (prepared: PreparedWallet, password: string): Promise<CreateResult> => {
      setIsBusy(true);
      setError(null);
      const { sealed, publicKey, mnemonic } = prepared;
      try {
        const secret = await unsealSecret(sealed, {
          type: "password",
          secret: password,
        });

        const res = await fetch("/api/wallet/sponsor-account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey }),
        });

        // 409 means the account is already on-chain from an attempt that failed
        // later; resume from linking rather than stranding it.
        if (res.status !== 409) {
          if (!res.ok) {
            throw new Error(
              (await res.json().catch(() => ({})))?.error ??
                "Could not create your wallet",
            );
          }
          const { xdr } = (await res.json()) as { xdr: string };
          const tx = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC);
          tx.sign(Keypair.fromSecret(secret));
          // The sponsor is this transaction's source, so it already pays the fee.
          await submitToHorizon(tx.toXDR());
        }

        const walletId = await linkToAccount(publicKey, secret);
        await putKeyBlob(walletId, sealed);

        await unlockWallet(sealed, { type: "password", secret: password });
        setAddress(publicKey);
        return { address: publicKey, walletId, mnemonic };
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

  // Derives the Solana address from the same phrase and links it, so a user
  // backs up one phrase and gets every chain.
  const deriveSolana = useCallback(
    async (walletId: string, password: string): Promise<string> => {
      setIsBusy(true);
      setError(null);
      try {
        const { sealed } = await getKeyBlob(walletId);
        const phrase = await unsealMnemonic(sealed as SealedWallet, {
          type: "password",
          secret: password,
        });
        const solanaAddress = solanaAddressFromMnemonic(phrase);

        // Linked through the same challenge/verify path, so control is proved
        // rather than asserted.
        const { nonce, challenge } = await requestChallenge(
          "solana",
          solanaAddress,
        );
        await submitSignature(
          nonce,
          signSolanaMessage(solanaKeypairFromMnemonic(phrase), challenge),
        );
        return solanaAddress;
      } catch (err: any) {
        setError(err?.message ?? "Could not add your Solana wallet");
        throw err;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  // Forgotten password. The phrase yields the key but not the DEK, so the
  // envelope is rebuilt under a new password; the Stellar key is untouched.
  const recoverWithPhrase = useCallback(
    async (
      walletId: string,
      phrase: string,
      newPassword: string,
    ): Promise<string> => {
      setIsBusy(true);
      setError(null);
      try {
        const { sealed } = await getKeyBlob(walletId);
        const resealed = await resealFromMnemonic(phrase, newPassword);

        // A valid phrase for a different wallet would otherwise overwrite this
        // one's blob with key material that cannot open it.
        if (resealed.publicKey !== (sealed as SealedWallet).publicKey) {
          throw new Error("That phrase belongs to a different wallet.");
        }

        await putKeyBlob(walletId, resealed);
        const opened = await unlockWallet(resealed, {
          type: "password",
          secret: newPassword,
        });
        setAddress(opened);
        return opened;
      } catch (err: any) {
        setError(err?.message ?? "Could not recover your wallet");
        throw err;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  // Adds a passkey to an unlocked wallet, proving the password first.
  const addPasskey = useCallback(
    async (walletId: string, password: string, label: string) => {
      setIsBusy(true);
      setError(null);
      try {
        const { sealed } = await getKeyBlob(walletId);
        const { credentialId, secret } = await registerPasskey(walletId, label);
        const updated = await addUnlockMethod(
          sealed as SealedWallet,
          { type: "password", secret: password },
          { type: "passkey", secret, credentialId, label },
        );
        await putKeyBlob(walletId, updated);
      } catch (err: any) {
        setError(err?.message ?? "Could not add a passkey");
        throw err;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  // Finds the wrap this device registered, then unlocks with its PRF secret.
  const unlockByPasskey = useCallback(
    async (walletId: string): Promise<string> => {
      setIsBusy(true);
      setError(null);
      try {
        const { sealed } = await getKeyBlob(walletId);
        const wrap = (sealed as SealedWallet).wraps.find(
          (candidate) => candidate.type === "passkey" && candidate.credentialId,
        );
        if (!wrap?.credentialId) {
          throw new Error("No passkey is registered for this wallet");
        }
        const secret = await unlockWithPasskey(wrap.credentialId);
        const opened = await unlockWallet(sealed as SealedWallet, {
          type: "passkey",
          secret,
        });
        setAddress(opened);
        return opened;
      } catch (err: any) {
        setError(err?.message ?? "Could not unlock with your passkey");
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
    prepare,
    finalize,
    unlock,
    recoverWithPhrase,
    deriveSolana,
    unlockByPasskey,
    addPasskey,
    canUsePasskey: isPasskeySupported(),
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
