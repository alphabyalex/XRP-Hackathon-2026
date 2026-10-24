# Compute-to-API integration handoff

This document is the implementation handoff for `apps/api`. It does not change
the shared contract source of truth; it explains exactly how this owned service
implements the compute endpoints from that contract.

## Service boundary

The browser must call `apps/api` only. `apps/api` is the only component that
calls this service, at its private `COMPUTE_URL` such as
`http://compute.internal:5000`. Do not expose vLLM or compute directly to the
browser.

Every internal call that creates a booking uses:

```text
X-MS-Internal-Key: <INTERNAL_API_KEY>
```

Compute posts completed usage back to:

```text
POST {API_URL}/internal/usage
X-MS-Internal-Key: <INTERNAL_API_KEY>
```

`request_id` is the idempotency key. The API must accept a retry of the same
event without adding another ledger entry.

## Inference proxy

For `POST /inference/chat`, the API should forward the OpenAI-compatible JSON
body unchanged to `POST {COMPUTE_URL}/v1/chat/completions`, adding:

```text
X-MS-Buyer: DEV | ALICE | BOB | CAROL
X-MS-Booking: <redemptionId>     # only for an active redeemed slot
X-MS-Simulated: true             # only for `sim.load` traffic
```

Return the compute response body unchanged so the web app can show its `x_ms`
block. It contains the routed GPU, measured final token counts, a six-decimal
TDX charge, the route decision, and whether the worker is simulated.

When `stream: true`, proxy the `text/event-stream` response without buffering.
The final event is:

```json
{"object":"moonshift.metadata","x_ms":{"request_id":"..."}}
```

It is followed by the normal `[DONE]` event. The API can record the normal
usage callback rather than attempting to reconstruct charges from stream chunks.

## Booking flow

After the XRPL layer validates a contract redemption, the API calls:

```json
POST {COMPUTE_URL}/bookings
{
  "gpu_id": "gpu-a",
  "slot_start": "2026-10-23T19:00:00Z",
  "slots": 1,
  "redemption_id": "redemptionId-from-xrpl",
  "holder": "ALICE"
}
```

The endpoint returns `{"booking_id":"..."}`. A `409` response has the
standard error shape with code `SLOT_TAKEN`. Treat it as a failed scheduling
reservation and do not present the slot as redeemed. The scheduler serializes
this check with request admission, persists the booking, drains the GPU before
the start time, and gives only the matching `holder` plus `redemption_id` free
access during the interval.

## Reads and live updates

- API `GET /gpus` can merge compute's `GET /gpus` array with pricing NAV and
  share data.
- API `GET /gpus/:id` can request
  `GET /gpus/{id}/calendar?from=<utc>&to=<utc>` alongside its own recent usage
  and revenue records.
- The API should emit its own `usage` and `calendar` SSE events after it
  accepts a usage callback or performs a booking. Compute deliberately does
  not publish directly to the browser.

## Usage callback payload

```json
{
  "request_id": "req_...",
  "gpu_id": "gpu-a",
  "buyer": "DEV",
  "booking_id": null,
  "input_tokens": 12,
  "output_tokens": 34,
  "charge": "0.001008",
  "started_at": "2026-10-23T19:00:00+00:00",
  "finished_at": "2026-10-23T19:00:02+00:00",
  "simulated": false
}
```

For an active booking, `charge` is `"0.000000"`; revenue was paid when the
contract was purchased. For simulator demand, `simulated` is `true` even when
the selected GPU is real, so dashboards can keep synthetic demand distinct.

## Error handling

Errors use:

```json
{"error":{"code":"GPU_BOOKED","message":"..."}}
```

The API should preserve status code and body. Expected route outcomes are
`GPU_BOOKED`, `NO_ELIGIBLE_GPU`, `INSUFFICIENT_RUNWAY`, `PRICE_CAP_EXCEEDED`,
and `UPSTREAM_ERROR`. Validation or internal-key failures use `400` or `401`.
