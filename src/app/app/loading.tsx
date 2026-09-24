import { SettuLoader } from "@/components/brand/SettuLoader";

/**
 * Shown inside the app shell while a /app route segment loads — the shell,
 * sidebar and header stay put and only the content area waits.
 */
export default function Loading() {
  return (
    <div className="flex min-h-[40vh] flex-1 items-center justify-center">
      <SettuLoader className="h-16 w-auto" />
    </div>
  );
}
