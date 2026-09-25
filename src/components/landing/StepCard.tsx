import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";

interface StepCardProps {
  readonly icon: string;
  readonly iconAlt: string;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  /** Card 1 (Connect wallet) centers its one content block since it's
   * shorter than its siblings; cards 2 and 3 pin their content to the top
   * and the caption to the bottom via space-between. Matches Figma exactly
   * — these are genuinely different `justify-content`/`align-items` values
   * per card, not a shared default. */
  readonly align?: "center" | "between";
}

export function StepCard({
  icon,
  iconAlt,
  title,
  description,
  children,
  align = "between",
}: StepCardProps) {
  return (
    <div
      style={{ "--glass-tint": "rgba(255,255,255,0.1)" } as CSSProperties}
      className={`landing-step-card liquid-glass relative z-[1] flex h-[483px] w-[362px] max-w-full flex-col gap-[50px] rounded-[40px] p-[50px_30px] max-[720px]:h-[454px] ${
        align === "center"
          ? "justify-center items-start max-[720px]:p-[30px]"
          : "justify-between items-center"
      }`}
    >
      <div className="w-full">{children}</div>
      <div className="flex w-full flex-col gap-[20px]">
        <div className="flex items-center gap-[10px]">
          <Image src={icon} alt={iconAlt} width={24} height={24} />
          <h3 className="landing-fraunces text-[20px] text-white">{title}</h3>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[14px] leading-[24px] text-[#aba8a8] max-[720px]:leading-[22px] max-[720px]:text-[#d5d0d0]">
          {description}
        </p>
      </div>
    </div>
  );
}
