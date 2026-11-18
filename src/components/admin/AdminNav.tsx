"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Recovery" },
  { href: "/admin/bridge", label: "Bridge explorer" },
  { href: "/admin/bridge/settings", label: "Bridge settings" },
] as const;

/** The admin pages' shared nav: recovery console, bridge explorer, bridge settings. */
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex flex-wrap gap-[8px]">
      {LINKS.map(({ href, label }) => {
        const on = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={on ? "page" : undefined}
            style={{
              border: "1px solid rgba(255,255,255,0.14)",
              backgroundColor: on ? "rgba(201,169,98,0.25)" : "transparent",
            }}
            className="rounded-full px-[14px] py-[6px] font-[family-name:var(--font-sora)] text-[13px] text-white transition-colors hover:bg-white/[0.06]"
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
