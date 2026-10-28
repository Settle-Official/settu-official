/**
 * The service-notice strip between the header and the content panel.
 *
 * Edit NOTICE to change the message; set it to null to take the strip down.
 * It's a constant rather than anything fetched because a notice goes up and
 * comes down with a deploy anyway, and a strip that pops in after a request
 * would shove the whole screen down a beat after it loads.
 */
export const NOTICE: string | null =
  "LOBSTR is currently experiencing issues that may affect transactions on Settu. The issue originates from LOBSTR and is not caused by Settu. We’re monitoring the situation and will update you when services are restored. Thank you for your patience and understanding.";

export function NoticeBanner() {
  if (!NOTICE) return null;
  // Per the design note the text slides rather than sitting still. The track
  // holds the message twice and slides exactly one copy's width, so the loop
  // seam is invisible. The second copy is decoration: hidden from screen
  // readers, and dropped entirely under reduced motion (see globals.css),
  // where the message just wraps.
  return (
    <div
      role="status"
      className="notice-marquee relative flex h-[60px] shrink-0 items-center overflow-hidden bg-[#242222] px-[20px] py-[10px] max-[720px]:h-auto max-[720px]:min-h-[48px]"
    >
      <div className="notice-marquee-track flex w-max">
        {[0, 1].map((copy) => (
          <p
            key={copy}
            aria-hidden={copy === 1 ? true : undefined}
            className="notice-marquee-copy shrink-0 whitespace-nowrap pr-[80px] font-[family-name:var(--font-geist)] text-[16px] leading-[40px] text-[#fdd0d0] max-[720px]:text-[14px] max-[720px]:leading-[28px]"
          >
            {NOTICE}
          </p>
        ))}
      </div>
    </div>
  );
}
