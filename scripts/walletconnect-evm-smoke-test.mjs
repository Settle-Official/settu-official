// scripts/walletconnect-evm-smoke-test.mjs
// Throwaway diagnostic: confirms a real WalletConnect v2 EVM pairing
// completes against the relay this project is configured to use, before
// any application code is built around it. Run manually, watch the
// console output and (if a wallet is available) approve the pairing on
// your phone/extension.
import { SignClient } from "@walletconnect/sign-client";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
if (!projectId) {
  console.error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set");
  process.exit(1);
}

const client = await SignClient.init({
  projectId,
  metadata: {
    name: "Settu WC EVM smoke test",
    description: "Diagnostic only",
    url: "https://settu.xyz",
    icons: [],
  },
});

console.log("SignClient initialized. Proposing an EVM session...");

const { uri, approval } = await client.connect({
  requiredNamespaces: {
    eip155: {
      methods: ["eth_sendTransaction", "personal_sign", "wallet_switchEthereumChain"],
      chains: ["eip155:1"], // Ethereum mainnet, just to prove the pairing works
      events: ["chainChanged", "accountsChanged"],
    },
  },
});

console.log("Pairing URI (scan with a wallet, or open on mobile):");
console.log(uri);
console.log("Waiting up to 60s for approval...");

const timeout = setTimeout(() => {
  console.error("TIMED OUT waiting for wallet approval — relay or pairing issue.");
  process.exit(1);
}, 60_000);

try {
  const session = await approval();
  clearTimeout(timeout);
  console.log("SUCCESS — session established:");
  console.log(JSON.stringify(session.namespaces, null, 2));
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  console.error("FAILED:", err);
  process.exit(1);
}
