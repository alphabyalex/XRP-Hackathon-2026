import type { CreditProfile } from "@moonshift/shared";
import type { ConnectedWallet } from "@/lib/lendingApi";
import { apiFetch, getPortfolio, ApiUnreachableError } from "@/lib/api";
import { fetchAllGpus } from "@/lib/fetchAllGpus";
import { ACCOUNT } from "@/lib/session";
import { BorrowContent } from "@/components/BorrowContent";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";

const DEFAULT_SHARES = "100";
const GPU_ID = "gpu-a";

// The credit profile and the largest approved amount are rendered on the
// server, so the score is in the first paint. The api serves both from cache;
// if one is slow, the page fetches it instead. (lendingApi is client-only, so
// these call the api directly.)
const fast = () => ({ signal: AbortSignal.timeout(1500) });

function initialProfile() {
  return apiFetch<CreditProfile>(`/loans/profile/${ACCOUNT}`, fast()).catch(() => null);
}

function initialMax() {
  return apiFetch<{ maxPrincipal: string; collateralValue: string; termSeconds: number }>("/loans/max", {
    ...fast(),
    method: "POST",
    body: JSON.stringify({ borrower: ACCOUNT, gpuId: GPU_ID, collateralShares: DEFAULT_SHARES }),
  }).catch(() => null);
}

function initialWallet() {
  return apiFetch<{ wallet: ConnectedWallet | null }>(`/wallet/${ACCOUNT}`, fast())
    .then((r) => r.wallet)
    .catch(() => null);
}

export default async function BorrowPage() {
  try {
    const [portfolio, { gpus }, profile, max, wallet] = await Promise.all([
      getPortfolio(ACCOUNT),
      fetchAllGpus(),
      initialProfile(),
      initialMax(),
      initialWallet(),
    ]);
    const gpu = gpus[GPU_ID] ?? Object.values(gpus)[0];
    return (
      <BorrowContent
        initialPortfolio={portfolio}
        initialProfile={profile}
        initialMax={gpu.id === GPU_ID ? max : null}
        initialWallet={wallet}
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
