import type { CreditProfile } from "@moonshift/shared";
import { cookies } from "next/headers";
import { apiFetch, getPortfolio, ApiUnreachableError } from "@/lib/api";
import { fetchAllGpus } from "@/lib/fetchAllGpus";
import type { ConnectedWallet } from "@/lib/lendingApi";
import { BorrowContent } from "@/components/BorrowContent";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";

const DEFAULT_SHARES = "100";
const GPU_ID = "gpu-a";

// The signed-in account's profile and largest approved amount are rendered on
// the server (the browser's session cookie is passed on to the api), so the
// score is in the first paint. Signed out, or the api slow: the page fetches
// them itself. (lendingApi is client-only, so these call the api directly.)
async function sessionInit(): Promise<RequestInit> {
  const cookie = (await cookies()).toString();
  return { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(1500) };
}

export default async function BorrowPage() {
  try {
    const init = await sessionInit();
    const [portfolio, { gpus }, profile, max, me] = await Promise.all([
      getPortfolio(init).catch(() => null),
      fetchAllGpus(),
      apiFetch<CreditProfile>("/loans/profile/me", init).catch(() => null),
      apiFetch<{ maxPrincipal: string; collateralValue: string; termSeconds: number }>("/loans/max", {
        ...init,
        method: "POST",
        body: JSON.stringify({ gpuId: GPU_ID, collateralShares: DEFAULT_SHARES }),
      }).catch(() => null),
      apiFetch<{ wallet: ConnectedWallet | null }>("/wallet/me", init).catch(() => null),
    ]);
    const gpu = gpus[GPU_ID] ?? Object.values(gpus)[0];
    return (
      <BorrowContent
        initialPortfolio={portfolio}
        initialProfile={profile}
        initialMax={gpu.id === GPU_ID ? max : null}
        initialWallet={me?.wallet ?? null}
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
