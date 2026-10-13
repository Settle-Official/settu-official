import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SettuLogo } from "@/components/brand/SettuLogo";
import { SUPPORT_EMAIL } from "@/lib/support/contact";

export const metadata: Metadata = {
  title: "Privacy Policy | Settu",
  description:
    "What personal information Settu collects, why, who it is shared with, and your rights.",
};

// Update whenever the policy's substance changes.
const LAST_UPDATED = "13 October 2026";

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[14px]">
      <h2 className="text-[22px] font-semibold leading-[30px] text-white max-[720px]:text-[18px] max-[720px]:leading-[26px]">
        {title}
      </h2>
      <div className="flex flex-col gap-[14px] text-[16px] leading-[27px] text-[#cfcdcd] max-[720px]:text-[15px] max-[720px]:leading-[25px]">
        {children}
      </div>
    </section>
  );
}

function List({ children }: { readonly children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-[8px] pl-[22px]">{children}</ul>;
}

const strong = "font-semibold text-white";

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-[#121212] font-[family-name:var(--font-sora)] text-white">
      <div
        // Clears the status bar when installed to the home screen.
        style={{ paddingTop: "calc(32px + env(safe-area-inset-top, 0px))" }}
        className="mx-auto flex w-full max-w-[820px] flex-col gap-[40px] px-[24px] pb-[80px] max-[720px]:gap-[30px] max-[720px]:px-[18px] max-[720px]:pb-[56px]"
      >
        <header className="flex items-center justify-between gap-[16px]">
          <Link href="/" aria-label="Settu home">
            <SettuLogo className="h-[28px] w-auto" />
          </Link>
          <Link
            href="/app"
            className="text-[15px] text-[#c9a962] underline-offset-4 hover:underline"
          >
            Open the app
          </Link>
        </header>

        <div className="flex flex-col gap-[12px]">
          <h1 className="text-[40px] font-semibold leading-[48px] max-[720px]:text-[30px] max-[720px]:leading-[38px]">
            Privacy Policy
          </h1>
          <p className="text-[15px] text-[#a19d9d]">Last updated: {LAST_UPDATED}</p>
        </div>

        <Section title="Summary">
          <p>
            Settu lets you convert between USDC and your local currency. To do that we
            handle some personal information: your wallet address, the bank details you
            give for a payout or refund, and, when you buy USDC, identity details our
            payment partner is required to check.
          </p>
          <List>
            <li>We collect only what a transfer needs.</li>
            <li>
              Identity details for buying USDC (date of birth, ID number, BVN) are passed
              to our payment partner with your order. <span className={strong}>Settu does
              not store them.</span>
            </li>
            <li>We do not sell your information, and we do not use it for advertising.</li>
            <li>Settu never holds your funds or your wallet&rsquo;s private keys.</li>
          </List>
        </Section>

        <Section title="Who we are">
          <p>
            &ldquo;Settu&rdquo;, &ldquo;we&rdquo; and &ldquo;us&rdquo; mean the team that
            operates settu.xyz and the Settu app. We decide how the information described
            here is used, which makes us its data controller. You can reach us at{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[#c9a962] underline underline-offset-2">
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <Section title="What we collect">
          <p className={strong}>When you connect a wallet</p>
          <List>
            <li>
              Your public wallet address on Stellar, Solana or an EVM chain. We never see
              or store your private keys or recovery phrase.
            </li>
          </List>

          <p className={strong}>When you sell USDC (offramp)</p>
          <List>
            <li>The amount, currency and exchange rate.</li>
            <li>
              The payout bank account: bank, account number and the account holder&rsquo;s
              name.
            </li>
            <li>The blockchain transaction references for your transfer.</li>
          </List>

          <p className={strong}>When you buy USDC (onramp)</p>
          <List>
            <li>The amount, currency, exchange rate and destination Stellar address.</li>
            <li>
              A refund bank account in your own name: bank, account number and account
              holder&rsquo;s name.
            </li>
            <li>
              Identity details our payment partner is required to verify before it can
              accept a bank transfer: your full name (taken from your refund account), date of
              birth, and either your National Identification Number (NIN), or a passport
              or driver&rsquo;s licence number together with your Bank Verification Number
              (BVN).
            </li>
          </List>
          <p>
            Those identity details are sent to our payment partner with that one order.
            They are not saved on Settu&rsquo;s servers, not kept in your browser, and not
            included in our internal alerts. You are asked for them again on each purchase.
          </p>

          <p className={strong}>When you use the Settu Agent</p>
          <List>
            <li>
              The messages you type, so the agent can understand your request. Please do
              not type ID numbers, BVNs or passwords into the chat: identity details are
              entered in the fields on the confirmation card, which are not part of the
              conversation.
            </li>
          </List>

          <p className={strong}>When you create an account or contact us</p>
          <List>
            <li>Your email address and any wallets you link, if you create an account.</li>
            <li>
              Whatever you send us by email, WhatsApp, Telegram, phone or the in-app
              report form, including a wallet address when you attach one.
            </li>
          </List>

          <p className={strong}>Automatically</p>
          <List>
            <li>
              Basic technical information such as IP address, browser type and request
              logs, which our hosting provider records to run and secure the service.
            </li>
            <li>
              Information saved on your own device (see &ldquo;Storage on your device&rdquo;
              below). We do not use advertising or cross-site tracking cookies.
            </li>
          </List>
        </Section>

        <Section title="Why we use it">
          <List>
            <li>
              <span className={strong}>To carry out your transfers:</span> quoting,
              verifying a bank account, creating the order, bridging USDC and paying out.
              This is necessary to provide the service you asked for.
            </li>
            <li>
              <span className={strong}>To meet verification requirements:</span> the
              payment providers we work with must check the identity of anyone paying in
              by bank transfer.
            </li>
            <li>
              <span className={strong}>To keep transfers safe:</span> detecting and
              recovering stuck transfers, preventing fraud and abuse, and keeping an audit
              trail of administrative actions. This is in our legitimate interest and
              yours.
            </li>
            <li>
              <span className={strong}>To support you:</span> answering questions and
              resolving problems with a transfer.
            </li>
            <li>
              <span className={strong}>To show your history and notifications</span> for
              the wallet you connect.
            </li>
          </List>
        </Section>

        <Section title="Who we share it with">
          <p>
            We share information only with the providers needed to run Settu, and only
            what each one needs:
          </p>
          <List>
            <li>
              <span className={strong}>Paycrest</span>, our payment partner, receives
              order details, the bank account details for the payout or refund, and for
              purchases the identity details described above. Paycrest and the licensed
              payment providers it routes through handle that information under their own
              privacy policies and legal obligations.
            </li>
            <li>
              <span className={strong}>Blockchain networks and Circle.</span> Transfers
              happen on public blockchains (Stellar, Base, Solana and other supported
              networks) using Circle&rsquo;s Cross-Chain Transfer Protocol. Wallet
              addresses, amounts and transaction references on a blockchain are public and
              permanent; we cannot change or delete them.
            </li>
            <li>
              <span className={strong}>Wallet connection providers</span> (WalletConnect /
              Reown) relay the connection between Settu and your wallet app.
            </li>
            <li>
              <span className={strong}>Infrastructure providers</span>: Vercel hosts the
              app, and Upstash stores order and transfer records.
            </li>
            <li>
              <span className={strong}>Google</span> processes the messages you send to
              the Settu Agent, to interpret them.
            </li>
            <li>
              <span className={strong}>Telegram.</span> Our team receives operational
              alerts about each transfer in a private channel (amount, status, wallet
              address and the bank account details for that order), so a stuck transfer is
              noticed and fixed quickly. Identity details are never included.
            </li>
            <li>
              <span className={strong}>Authorities</span>, where the law requires it or to
              protect against fraud.
            </li>
          </List>
          <p>
            Some of these providers process information outside Nigeria. Where that
            happens we rely on the safeguards the law allows for such transfers.
          </p>
        </Section>

        <Section title="How long we keep it">
          <List>
            <li>
              <span className={strong}>Identity details for a purchase:</span> not kept by
              Settu at all.
            </li>
            <li>
              <span className={strong}>Bank details attached to an order:</span> removed
              from our order records within 7 days. Copies in our internal alert channel
              and in support conversations are kept for as long as needed to resolve
              disputes and reconcile payments.
            </li>
            <li>
              <span className={strong}>Transfer records</span> (wallet address, amounts,
              status and blockchain references): kept for the life of the service, as our
              financial audit trail.
            </li>
            <li>
              <span className={strong}>Support messages:</span> kept while they are needed
              to help you and to handle any follow-up.
            </li>
          </List>
        </Section>

        <Section title="Storage on your device">
          <p>
            Settu saves a few things in your browser so the app works between visits: your
            wallet connection, your recent transfers (including the bank details you
            entered for them), which notifications you have read, your chosen source
            chain, and a sign-in token if you have an account. This stays on your device,
            and clearing your browser&rsquo;s site data removes it. Your conversation with
            the Settu Agent is kept only while the app is open.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Information is encrypted in transit, access to administrative tools is
            restricted and logged, and we limit what we keep. No system is perfectly
            secure; if a breach affects your information we will tell you and the
            regulator as the law requires.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            Under the Nigeria Data Protection Act 2023 you can ask us to:
          </p>
          <List>
            <li>tell you what personal information we hold about you and give you a copy;</li>
            <li>correct information that is wrong;</li>
            <li>delete information we no longer need;</li>
            <li>stop or limit a use of your information that you object to;</li>
            <li>give you your information in a portable format.</li>
          </List>
          <p>
            Email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[#c9a962] underline underline-offset-2">
              {SUPPORT_EMAIL}
            </a>{" "}
            from an address we can link to you, or tell us the wallet address concerned.
            We will answer within 30 days. If you are unhappy with our response you can
            complain to the Nigeria Data Protection Commission.
          </p>
          <p>
            For identity details checked by our payment partner, contact us and we will
            help direct your request to them.
          </p>
        </Section>

        <Section title="Age">
          <p>Settu is for people aged 18 or over. We do not knowingly serve anyone younger.</p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            If we change how we handle your information we will update this page and the
            date at the top. For significant changes we will also say so in the app.
          </p>
        </Section>
      </div>
    </main>
  );
}
