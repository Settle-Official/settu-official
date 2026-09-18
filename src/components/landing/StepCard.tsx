import Image from "next/image";
import type { ReactNode } from "react";

interface StepCardProps {
  readonly icon: string;
  readonly iconAlt: string;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function StepCard({ icon, iconAlt, title, description, children }: StepCardProps) {
  return (
    <div className="flex h-[483px] w-[362px] max-w-full flex-col justify-between rounded-[40px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[30px_50px]">
      <div>{children}</div>
      <div className="flex flex-col gap-[20px]">
        <div className="flex items-center gap-[10px]">
          <Image src={icon} alt={iconAlt} width={24} height={24} />
          <h3 className="landing-fraunces text-[20px] text-white">{title}</h3>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[14px] leading-[24px] text-[#aba8a8]">
          {description}
        </p>
      </div>
    </div>
  );
}
