import { SettuLogo } from "@/components/brand/SettuLogo";

const LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
  { label: "Support", href: "#support" },
];

// TODO(links): point these at the real profiles.
const SOCIALS = [
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/",
    icon: (
      <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3V9Zm7 0h3.8v1.7h.1c.5-1 1.8-2 3.7-2 4 0 4.7 2.6 4.7 6V21h-4v-5.5c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9V21h-4V9Z" />
    ),
  },
  {
    label: "X",
    href: "https://x.com/settu_official1",
    icon: (
      <path d="M17.7 3h3.1l-6.8 7.8L22 21h-6.3l-4.9-6.4L5.2 21H2.1l7.3-8.3L1.7 3h6.4l4.4 5.9L17.7 3Zm-1.1 16.2h1.7L7.2 4.7H5.4l11.2 14.5Z" />
    ),
  },
  {
    label: "Instagram",
    href: "https://www.instagram.com/",
    icon: (
      <path d="M12 2.2c2.7 0 3 0 4 .1 1 0 1.6.2 2 .4.5.2.9.4 1.3.8.4.4.6.8.8 1.3.2.4.3 1 .4 2 .1 1 .1 1.3.1 4s0 3-.1 4c0 1-.2 1.6-.4 2-.2.5-.4.9-.8 1.3-.4.4-.8.6-1.3.8-.4.2-1 .3-2 .4-1 .1-1.3.1-4 .1s-3 0-4-.1c-1 0-1.6-.2-2-.4a3.6 3.6 0 0 1-1.3-.8 3.6 3.6 0 0 1-.8-1.3c-.2-.4-.3-1-.4-2-.1-1-.1-1.3-.1-4s0-3 .1-4c0-1 .2-1.6.4-2 .2-.5.4-.9.8-1.3.4-.4.8-.6 1.3-.8.4-.2 1-.3 2-.4 1-.1 1.3-.1 4-.1ZM12 4c-2.7 0-3 0-4 .1-.9 0-1.4.2-1.7.3-.4.2-.7.4-1 .7-.3.3-.5.6-.7 1-.1.3-.3.8-.3 1.7-.1 1-.1 1.3-.1 4s0 3 .1 4c0 .9.2 1.4.3 1.7.2.4.4.7.7 1 .3.3.6.5 1 .7.3.1.8.3 1.7.3 1 .1 1.3.1 4 .1s3 0 4-.1c.9 0 1.4-.2 1.7-.3.4-.2.7-.4 1-.7.3-.3.5-.6.7-1 .1-.3.3-.8.3-1.7.1-1 .1-1.3.1-4s0-3-.1-4c0-.9-.2-1.4-.3-1.7-.2-.4-.4-.7-.7-1-.3-.3-.6-.5-1-.7-.3-.1-.8-.3-1.7-.3-1-.1-1.3-.1-4-.1Zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 1.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Zm5.2-2.6a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z" />
    ),
  },
];

export function Footer() {
  return (
    <footer
      id="support"
      className="flex flex-col items-center gap-[30px] overflow-x-clip bg-[#121212] py-[20px]"
    >
      {/* Oversized wordmark on the same seamless marquee as the chain logos
          (four copies, track slides -50%), fading into the background at
          both ends via the mask. Slowed right down — it's 300px type. */}
      <div className="landing-footer-wordmark w-full overflow-hidden">
        <div
          className="landing-marquee-track gap-[160px]"
          style={{ animationDuration: "48s" }}
        >
          {Array.from({ length: 4 }, (_, i) => (
            // The first copy is the one screen readers get; the other three
            // only exist to make the loop seamless.
            <span key={i} className="shrink-0" aria-hidden={i > 0}>
              <SettuLogo
                decorative={i > 0}
                className="h-[260px] w-auto max-[720px]:h-[87px]"
              />
            </span>
          ))}
        </div>
      </div>

      <div className="flex w-[1116px] max-w-full flex-wrap items-center justify-between gap-x-[122px] gap-y-[24px] rounded-[40px] p-[20px] max-[720px]:flex-col max-[720px]:justify-center max-[720px]:gap-y-[30px]">
        <nav className="flex flex-wrap items-center justify-center gap-[50px] max-[720px]:gap-[20px]">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="font-[family-name:var(--font-sora)] text-[18px] leading-[23px] text-white transition-colors hover:text-[#c9a962] max-[720px]:text-[14px] max-[720px]:leading-[18px]"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-[22px]">
          {SOCIALS.map((social) => (
            <a
              key={social.label}
              href={social.href}
              target="_blank"
              rel="noreferrer"
              aria-label={social.label}
              className="flex size-[50px] items-center justify-center rounded-full bg-[#b1b1b1] text-black transition-colors hover:bg-[#c9a962]"
            >
              <svg
                width={22}
                height={22}
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                {social.icon}
              </svg>
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
