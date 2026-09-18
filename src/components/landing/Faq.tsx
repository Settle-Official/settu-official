"use client";

import { useState } from "react";

const ITEMS = [
  {
    q: "What exactly am I being charged for?",
    a: "Three separate things: a network fee (goes to the blockchain, not us), a bridge fee (only if you're sending from a non-Stellar chain), and a platform fee (covers the rate lock and payout). Every transfer shows all three before you confirm.",
  },
  // TODO(copy): answers 2–5 aren't in the Figma export yet — these describe
  // the product's actual behaviour but should be replaced with the final copy.
  {
    q: "What happens if my transfer fails?",
    a: "If anything fails before your USDC leaves your wallet, nothing moves — you keep your funds and can try again. You'll always see which of these is true, not just a spinner.",
  },
  {
    q: "Do I need a Stellar wallet specifically?",
    a: "No. Connect any supported EVM wallet or Solana wallet and we bridge your USDC onto Stellar for you as part of the flow.",
  },
  {
    q: 'What\'s an "FX lock"?',
    a: "The moment you confirm your amount, we hold the Naira rate for a short window so it can't move against you while you finish entering your bank details.",
  },
  {
    q: "Which banks are supported?",
    a: "All major Nigerian banks and fintech accounts, including GTBank, Access, Zenith, Kuda, and Opay. We verify your account name automatically before you confirm.",
  },
];

function PlusIcon({ open }: { readonly open: boolean }) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`landing-faq-icon shrink-0 ${open ? "is-open" : ""}`}
    >
      <path
        d="M12 3v18M3 12h18"
        stroke="#fff"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section
      id="faq"
      className="flex flex-col items-center gap-[50px] bg-[#121212] p-[100px] max-[720px]:p-[20px]"
    >
      <div className="flex flex-col items-center gap-[20px] text-center">
        <span className="rounded-[20px] border border-white/15 bg-white/10 px-[20px] py-[4px] font-[family-name:var(--font-inter)] text-[18px] leading-[28px] text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl">
          FAQ
        </span>
        <h2 className="font-[family-name:var(--font-sora)] text-[28px] leading-[40px] text-white max-[720px]:text-[24px]">
          Questions people actually ask
        </h2>
      </div>

      <ul className="flex w-full flex-col items-center gap-[20px]">
        {ITEMS.map((item, i) => {
          const open = openIndex === i;
          const panelId = `faq-panel-${i}`;
          return (
            <li
              key={item.q}
              className="landing-faq-item w-[648px] max-w-full rounded-[20px] px-[20px] py-[30px] max-[720px]:py-[16px]"
            >
              <h3>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => setOpenIndex(open ? null : i)}
                  className={`landing-faq-trigger flex w-full items-center justify-between gap-[10px] text-left ${
                    open ? "is-open" : ""
                  }`}
                >
                  <span className="landing-fraunces text-[22px] leading-[28px] text-white max-[720px]:text-[14px]">
                    {item.q}
                  </span>
                  <PlusIcon open={open} />
                </button>
              </h3>
              <div
                id={panelId}
                role="region"
                className={`landing-faq-panel ${open ? "is-open" : ""}`}
              >
                <div className="min-h-0">
                  <p className="pt-[10px] font-[family-name:var(--font-sora)] text-[16px] leading-[28px] text-white max-[720px]:text-[14px] max-[720px]:leading-[22px]">
                    {item.a}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
