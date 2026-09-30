/**
 * Waits for a burn the WALLET broadcasts, without depending on the wallet's
 * reply.
 *
 * On Solana and the EVM chains the wallet sends the burn itself and reports
 * the signature back over WalletConnect. If the user switches back from
 * their wallet app while iOS has the relay socket suspended, that reply is
 * lost: the burn landed, but the page would wait forever and never register
 * it. So the page also asks the server (which searches the chain) each time
 * it becomes visible again, and on a timer, and continues with whichever
 * answer arrives first. Stellar doesn't need this: its wallets only sign and
 * the page broadcasts, so a lost reply there means nothing was burned.
 */

export interface VisibilityDocument {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface BurnRaceOptions {
  /** The wallet's signAndSend call, resolving to the burn's hash. */
  readonly wallet: Promise<string>;
  /** Asks the server for this order's burn; null when not found yet. */
  readonly check: () => Promise<string | null>;
  readonly doc: VisibilityDocument;
  /** Give the wallet this long to answer before polling the server. */
  readonly firstCheckAfterMs: number;
  readonly intervalMs: number;
  /**
   * True once the user has cancelled this flow: checks stop and the race is
   * left unsettled, so nothing the cancelled flow was waiting on resumes.
   */
  readonly abandoned?: () => boolean;
}

// The user said no: nothing was sent, so there is nothing to look for.
const USER_REJECTION = /reject|denied|cancel|4001/i;

export interface BurnRaceResult {
  readonly burnTxHash: string;
  /** "server" means the page must not register it: the server already has. */
  readonly via: "wallet" | "server";
}

export function raceBurnAgainstRecovery(
  opts: BurnRaceOptions,
): Promise<BurnRaceResult> {
  return new Promise<BurnRaceResult>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      settled = true;
      clearTimeout(timer);
      opts.doc.removeEventListener("visibilitychange", onVisible);
    };

    const finish = (outcome: () => void) => {
      if (settled) return;
      stop();
      outcome();
    };

    const isAbandoned = () => {
      if (!opts.abandoned?.()) return false;
      stop();
      return true;
    };

    const check = async () => {
      if (settled || checking || isAbandoned()) return;
      checking = true;
      try {
        const hash = await opts.check();
        if (hash) finish(() => resolve({ burnTxHash: hash, via: "server" }));
      } catch {
        // A failed check says nothing about the burn. Try again next time.
      } finally {
        checking = false;
      }
    };

    const tick = async () => {
      if (isAbandoned()) return;
      // A hidden page is usually one whose user is still in the wallet app:
      // nothing to show them, and the visibility listener covers the return.
      if (opts.doc.visibilityState === "visible") await check();
      if (!settled) timer = setTimeout(tick, opts.intervalMs);
    };

    function onVisible() {
      if (opts.doc.visibilityState === "visible") void check();
    }

    opts.wallet.then(
      (hash) => finish(() => resolve({ burnTxHash: hash, via: "wallet" })),
      // A rejection that arrives after the server already won is the lost
      // reply finally failing: ignored, not an unhandled rejection.
      async (err) => {
        if (settled) return;
        const message = String((err as { message?: unknown })?.message ?? err);
        // Anything but a refusal (our own "didn't hear back" timeout, a
        // dropped relay) may have followed a burn that landed: ask once more
        // before telling the user it failed.
        if (!USER_REJECTION.test(message)) {
          const hash = await opts.check().catch(() => null);
          if (hash) {
            finish(() => resolve({ burnTxHash: hash, via: "server" }));
            return;
          }
        }
        finish(() => reject(err));
      },
    );
    opts.doc.addEventListener("visibilitychange", onVisible);
    timer = setTimeout(tick, opts.firstCheckAfterMs);
  });
}
