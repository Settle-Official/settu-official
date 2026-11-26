"use client";

import { useState } from "react";
import { BUILDING, CHAINS, MARKETS, NEEDS, VOLUMES, type FieldErrors } from "@/lib/waitlist/schema";

type Opt = readonly { readonly value: string; readonly label: string }[];

const fieldBase =
  "w-full rounded-[14px] border bg-[#1b1a1a] px-[16px] py-[14px] font-[family-name:var(--font-sora)] text-[16px] text-white placeholder:text-[#6f6b6b] outline-none transition-colors focus:border-[#c9a962]";

function Label({ children, required, htmlFor }: { children: React.ReactNode; required?: boolean; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="font-[family-name:var(--font-sora)] text-[15px] text-[#e6e2e2]">
      {children}
      {required && <span className="text-[#c9a962]"> *</span>}
    </label>
  );
}

function Err({ msg }: { msg?: string }) {
  return msg ? <p role="alert" className="text-[13px] text-[#ff8a7a]">{msg}</p> : null;
}

/** Toggle chips. Buttons get their colours inline — globals.css resets button bg/border unlayered. */
function Chips({ opts, value, onChange, multi, name }: { opts: Opt; value: string[]; onChange: (v: string[]) => void; multi: boolean; name: string }) {
  return (
    <div role={multi ? "group" : "radiogroup"} aria-label={name} className="flex flex-wrap gap-[10px]">
      {opts.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            onClick={() => onChange(multi ? (on ? value.filter((v) => v !== o.value) : [...value, o.value]) : [o.value])}
            style={{
              backgroundColor: on ? "rgba(201,169,98,0.18)" : "#1b1a1a",
              border: `1px solid ${on ? "#c9a962" : "rgba(255,255,255,0.12)"}`,
            }}
            className={`rounded-[40px] px-[16px] py-[10px] font-[family-name:var(--font-sora)] text-[14px] transition-colors ${on ? "text-[#f3dfa6]" : "text-[#cfcaca] hover:text-white"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function WaitlistForm() {
  const [f, setF] = useState({ email: "", name: "", company: "", need: "", building: "", volume: "", useCase: "", heardFrom: "", website: "" });
  const [markets, setMarkets] = useState<string[]>([]);
  const [chains, setChains] = useState<string[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending"); setErrors({}); setMessage("");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, markets, chains }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: FieldErrors };
      if (res.ok) { setState("done"); return; }
      setErrors(data.fields ?? {});
      setMessage(data.error ?? "Something went wrong. Please try again.");
      setState("error");
      // On a phone the first problem is usually off-screen: take the user to it.
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>("form [aria-invalid='true'], form [role='alert']")?.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
    } catch {
      setMessage("Couldn't reach us. Check your connection and try again.");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className="flex flex-col items-center gap-[18px] rounded-[24px] bg-[#1b1a1a] px-[32px] py-[56px] text-center" role="status">
        <div className="flex size-[64px] items-center justify-center rounded-full bg-[rgba(201,169,98,0.16)]">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#e5bd71" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </div>
        <h2 className="landing-fraunces text-[30px] text-white">You&rsquo;re on the list.</h2>
        <p className="max-w-[420px] font-[family-name:var(--font-sora)] text-[16px] leading-[26px] text-[#cfcaca]">
          Thanks, {f.name.split(" ")[0] || "friend"}. We&rsquo;ll email <span className="text-[#f3dfa6]">{f.email.trim().toLowerCase()}</span> as soon as API access opens.
        </p>
        <a href="/" className="mt-[6px] font-[family-name:var(--font-sora)] text-[15px] text-[#c9a962] underline-offset-4 hover:underline">Back to settu.xyz</a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-[26px] rounded-[24px] bg-[#1b1a1a]/60 p-[32px] ring-1 ring-white/10 max-[720px]:p-[20px]">
      {/* Honeypot — hidden from people and screen readers, filled by bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}>
        <label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} /></label>
      </div>

      <div className="grid grid-cols-2 gap-[18px] max-[720px]:grid-cols-1">
        <div className="flex flex-col gap-[8px]">
          <Label htmlFor="wl-email" required>Work email</Label>
          <input id="wl-email" type="email" autoComplete="email" value={f.email} onChange={set("email")} placeholder="you@company.com" aria-invalid={!!errors.email} className={`${fieldBase} ${errors.email ? "border-[#ff8a7a]" : "border-white/10"}`} />
          <Err msg={errors.email} />
        </div>
        <div className="flex flex-col gap-[8px]">
          <Label htmlFor="wl-name" required>Your name</Label>
          <input id="wl-name" autoComplete="name" value={f.name} onChange={set("name")} placeholder="Ada Okafor" aria-invalid={!!errors.name} className={`${fieldBase} ${errors.name ? "border-[#ff8a7a]" : "border-white/10"}`} />
          <Err msg={errors.name} />
        </div>
      </div>

      <div className="flex flex-col gap-[8px]">
        <Label htmlFor="wl-company">Company or project</Label>
        <input id="wl-company" autoComplete="organization" value={f.company} onChange={set("company")} placeholder="Acme Pay" className={`${fieldBase} border-white/10`} />
      </div>

      <div className="flex flex-col gap-[10px]">
        <Label required>What do you need the API for?</Label>
        <Chips name="What you need" opts={NEEDS} value={f.need ? [f.need] : []} onChange={(v) => setF((s) => ({ ...s, need: v[0] ?? "" }))} multi={false} />
        <Err msg={errors.need} />
      </div>

      <div className="flex flex-col gap-[10px]">
        <Label required>What are you building?</Label>
        <Chips name="What you're building" opts={BUILDING} value={f.building ? [f.building] : []} onChange={(v) => setF((s) => ({ ...s, building: v[0] ?? "" }))} multi={false} />
        <Err msg={errors.building} />
      </div>

      <div className="flex flex-col gap-[10px]">
        <Label>Which markets?</Label>
        <Chips name="Markets" opts={MARKETS} value={markets} onChange={setMarkets} multi />
      </div>

      <div className="flex flex-col gap-[10px]">
        <Label>Which chains?</Label>
        <Chips name="Chains" opts={CHAINS} value={chains} onChange={setChains} multi />
      </div>

      <div className="flex flex-col gap-[10px]">
        <Label>Expected monthly volume</Label>
        <Chips name="Monthly volume" opts={VOLUMES} value={f.volume ? [f.volume] : []} onChange={(v) => setF((s) => ({ ...s, volume: v[0] ?? "" }))} multi={false} />
      </div>

      <div className="flex flex-col gap-[8px]">
        <Label htmlFor="wl-usecase">Tell us about your use case</Label>
        <textarea id="wl-usecase" rows={4} maxLength={2000} value={f.useCase} onChange={set("useCase")} placeholder="Who are your users, and where does the money need to go?" className={`${fieldBase} resize-y border-white/10`} />
      </div>

      <div className="flex flex-col gap-[8px]">
        <Label htmlFor="wl-heard">How did you hear about us?</Label>
        <input id="wl-heard" value={f.heardFrom} onChange={set("heardFrom")} placeholder="X, a friend, Drips Wave…" className={`${fieldBase} border-white/10`} />
      </div>

      {message && <p role="alert" className="font-[family-name:var(--font-sora)] text-[14px] text-[#ff8a7a]">{message}</p>}

      <button
        type="submit"
        disabled={state === "sending"}
        style={{ backgroundColor: "#c9a962", border: "0" }}
        className="h-[56px] rounded-[40px] font-[family-name:var(--font-sora)] text-[17px] font-semibold text-[#141212] transition-[filter] hover:brightness-110 disabled:cursor-wait disabled:opacity-70"
      >
        {state === "sending" ? "Joining…" : "Join the waitlist"}
      </button>
      <p className="text-center font-[family-name:var(--font-sora)] text-[13px] text-[#8f8b8b]">
        We&rsquo;ll only use your details to contact you about Settu API access.
      </p>
    </form>
  );
}
