import { Suspense } from "react";
import { HistoryList } from "@/components/app/HistoryList";

// The wallet's transactions, searchable from here or the top bar (`?q=`).
export default function Page() {
  return (
    <Suspense>
      <HistoryList />
    </Suspense>
  );
}
