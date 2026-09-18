export function HowItWorks() {
  return (
    <section id="how-it-works" className="px-[100px] py-[100px] max-[1100px]:px-[24px]">
      <div className="mx-auto flex w-[636px] max-w-full flex-col gap-[20px] pb-[100px] text-center">
        <div className="flex items-center justify-center gap-[10px]">
          <span className="h-[13px] w-[28px] rounded-[10px] border border-[#484747]" />
          <h2 className="landing-fraunces text-[30px] text-white">
            How $ettu actually moves your money
          </h2>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[16px] text-[#a9a5a5]">
          Three steps, and we tell you where things stand at each one, not just at the end.
        </p>
      </div>
      <div className="mx-auto flex w-[1240px] max-w-full flex-wrap justify-center gap-[77px]">
        {/* Task 8: Connect wallet card */}
        {/* Task 8: FX lock card */}
        {/* Task 9: Naira lands in bank card */}
      </div>
    </section>
  );
}
