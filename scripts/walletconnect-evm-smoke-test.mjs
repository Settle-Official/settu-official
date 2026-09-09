// scripts/walletconnect-evm-smoke-test.mjs
// Throwaway diagnostic: confirms a real WalletConnect v2 EVM pairing
// completes against the relay this project is configured to use, before
// any application code is built around it. Run manually, watch the
// console output and (if a wallet is available) approve the pairing on
// your phone/extension.
import { SignClient } from "@walletconnect/sign-client";
import QRCode from "qrcode";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

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

const qrPath = join(tmpdir(), "wc-evm-smoke-qr.png");
await QRCode.toFile(qrPath, uri, { width: 512, margin: 2 });

console.log("\n=== QR code saved. Open it and scan with your phone wallet: ===\n");
console.log(`    ${qrPath}\n`);
try {
  execSync(`xdg-open "${qrPath}"`, { stdio: "ignore" });
  console.log("(tried to open it in your default image viewer automatically)");
} catch {
  console.log(`(open it manually: xdg-open "${qrPath}")`);
}
console.log("\nMetaMask mobile: tap the scan icon (top-left of the home screen),");
console.log("point it at the image on your screen, approve the connection.\n");
console.log("Terminal QR fallback (if your terminal renders ANSI backgrounds):\n");
console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
console.log("Raw URI:\n" + uri);
console.log("\nWaiting up to 180s for approval...\n");

const timeout = setTimeout(() => {
  console.error(
    "TIMED OUT after 180s. If you never got the approval prompt in your\n" +
    "wallet, that's a relay/pairing issue. If you just ran out of time,\n" +
    "re-run and approve faster.",
  );
  process.exit(1);
}, 180_000);

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
