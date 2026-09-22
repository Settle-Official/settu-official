import { cn } from "@/lib/cn";

export interface ProgressStepsProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
}

interface Step {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly description: string;
}

export function ProgressSteps({ isConnected, isConnecting }: Readonly<ProgressStepsProps>) {
  const steps: Step[] = [
    {
      id: "s1",
      number: "01",
      title: isConnected ? "CONNECTED ✓" : "CONNECT WALLET",
      description: isConnected 
        ? "Connection successful. Proceed with transfer."
        : "Authorize Settu from your wallet extension.",
    },
    {
      id: "s2",
      number: "02",
      title: isConnecting ? "SIGNATURE PENDING" : "FX LOCK",
      description: isConnecting
        ? "Request is in-flight. Confirm in wallet to lock rate."
        : "Rate locked instantly after confirmation.",
    },
    {
      id: "s3",
      number: "03",
      title: "₦ PAYOUT",
      description: "Settument to your local bank account.",
    },
  ];

  return (
    <section className="grid grid-cols-3 gap-[0.6rem] max-[720px]:grid-cols-1">
      {steps.map((step, index) => {
        const active = (index === 0 && !isConnected) || (index === 1 && isConnecting);
        return (
          <article
            key={step.id}
            className={cn(
              "border border-[var(--line)] p-[0.9rem]",
              active &&
                "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]",
            )}
          >
            <span className="text-[1.5rem] font-bold">{step.number}</span>
            <h4 className="mt-[0.45rem] mb-[0.3rem] text-[0.95rem] font-bold uppercase">
              {step.title}
            </h4>
            <p className="m-0 text-[0.7rem] opacity-[0.85]">
              {step.description}
            </p>
          </article>
        );
      })}
    </section>
  );
}
