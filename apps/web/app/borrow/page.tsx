import type { LoanQuoteApiResponse } from "@moonshift/shared";
import { apiFetch, getPortfolio, ApiUnreachableError } from "@/lib/api";
import { fetchAllGpus } from "@/lib/fetchAllGpus";
import { ACCOUNT } from "@/lib/session";
import { BorrowContent } from "@/components/BorrowContent";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";

const DEFAULT_SHARES = "100";
const GPU_ID = "gpu-a";

// The opening quote (largest approved amount for the default shares) is
// rendered on the server, so the score and terms are in the first paint.
// The api serves it from cache; if it is slow, the page fetches it instead.
async function initialQuote(): Promise<LoanQuoteApiResponse | null> {
  // lendingApi is client-only (hooks), so call the api directly.
  return apiFetch<LoanQuoteApiResponse>("/loans/quote", {
    method: "POST",
    body: JSON.stringify({ borrower: ACCOUNT, gpuId: GPU_ID, collateralShares: DEFAULT_SHARES, principal: "max" }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);
}

export default async function BorrowPage() {
  try {
    const [portfolio, { gpus }, quote] = await Promise.all([getPortfolio(ACCOUNT), fetchAllGpus(), initialQuote()]);
    const gpu = gpus[GPU_ID] ?? Object.values(gpus)[0];
    return (
      <BorrowContent
        initialPortfolio={portfolio}
        initialQuote={quote?.gpuId === gpu.id ? quote : null}
        defaultShares={DEFAULT_SHARES}
        gpuId={gpu.id}
        gpuLabel={gpu.id.toUpperCase()}
        sharePrice={Number(gpu.sharePrice) || 0}
      />
    );
  } catch (err) {
    if (err instanceof ApiUnreachableError) {
      return (
        <main className="wrap" style={{ paddingBlock: 120 }}>
          <ApiErrorNotice />
        </main>
      );
    }
    throw err;
  }
}
