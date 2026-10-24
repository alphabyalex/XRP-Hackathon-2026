"""Send clearly labelled simulated demand through the API's inference route."""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import time

import httpx


PROMPTS = [
    "Summarize why a booked GPU slot should preempt public inference.",
    "Extract the main points from this mock GPU marketplace update.",
    "Write a two-sentence status update for a simulated AI request.",
]


async def run(rps: float, duration: int, buyer: str, api_url: str) -> None:
    if rps <= 0:
        raise ValueError("rps must be greater than zero")
    interval = 1 / rps
    deadline = time.monotonic() + duration
    headers = {"X-GB-Buyer": buyer, "X-GB-Simulated": "true"}
    async with httpx.AsyncClient(timeout=90) as client:
        while time.monotonic() < deadline:
            payload = {
                "messages": [{"role": "user", "content": random.choice(PROMPTS)}],
                "max_tokens": 96,
            }
            try:
                # Demand goes through apps/api so its usage enters the revenue ledger.
                response = await client.post(f"{api_url.rstrip('/')}/inference/chat", json=payload, headers=headers)
                print(response.status_code, response.json().get("x_gb", {}).get("request_id", ""))
            except httpx.HTTPError as error:
                print(f"simulated request failed: {error}")
            await asyncio.sleep(interval)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate simulated Groundbreak inference demand")
    parser.add_argument("--rps", type=float, required=True)
    parser.add_argument("--duration", type=int, required=True)
    parser.add_argument("--buyer", default="DEV")
    parser.add_argument("--api-url", default=os.getenv("API_URL", "http://127.0.0.1:4000"))
    return parser.parse_args()


if __name__ == "__main__":
    options = parse_args()
    asyncio.run(run(options.rps, options.duration, options.buyer, options.api_url))
