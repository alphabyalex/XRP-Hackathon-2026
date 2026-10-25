export interface BookingRange { gpuId: string; slotStart: string; durationSeconds: number }
export interface BookingQuote extends BookingRange { slotEnd: string; totalPrice: string; pricePerHour: string; priceCap: string; updatedAt: string }
export interface BookingChallenge extends BookingRange {
  challengeId: string; message: string; messageHex: string; expiresAt: string; slotEnd: string;
  priceCap: string; quotedAmount: string; wallet: string; account: string;
}
export interface SignedBooking extends BookingRange { priceCap: string; challengeId: string; publicKey: string; signature: string }

export async function signBooking(challenge: BookingChallenge, connectedWallet: string, expected: BookingRange & { priceCap: string; account?: string }): Promise<SignedBooking> {
  if (challenge.wallet !== connectedWallet || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("The booking approval expired or belongs to another wallet.");
  if (challenge.gpuId !== expected.gpuId || challenge.slotStart !== expected.slotStart || challenge.durationSeconds !== expected.durationSeconds
      || challenge.priceCap !== expected.priceCap || (expected.account && challenge.account !== expected.account)) throw new Error("The booking changed. Select the range again.");
  const hex = Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  if (!challenge.message.startsWith("Moonshift GPU booking consent v1\n") || challenge.messageHex.toUpperCase() !== hex) throw new Error("The booking approval could not be verified.");
  const sdk = (await import("@crossmarkio/sdk")).default;
  if (!sdk.sync.isInstalled()) throw new Error("Open Crossmark to approve this booking.");
  const { response } = await sdk.async.signInAndWait(challenge.messageHex);
  const data = response?.data;
  if (data?.address !== connectedWallet || !data.publicKey || !data.signature) throw new Error("Approve the booking with your connected wallet.");
  return { gpuId: challenge.gpuId, slotStart: challenge.slotStart, durationSeconds: challenge.durationSeconds,
    priceCap: challenge.priceCap, challengeId: challenge.challengeId, publicKey: data.publicKey, signature: data.signature };
}
