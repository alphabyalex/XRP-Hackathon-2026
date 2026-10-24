import unittest
from unittest.mock import patch
from decimal import Decimal
import fund


class FundingTests(unittest.TestCase):
    def test_above_minimum_is_untouched(self):
        with patch.object(fund, "balance", return_value=Decimal(150)), patch.object(fund, "post") as post:
            self.assertEqual(fund.fund("rPublic", Decimal(100), Decimal(300), 1), (150, 150))
            post.assert_not_called()

    def test_repeats_until_target_and_verifies_ledger(self):
        with patch.object(fund, "balance", side_effect=map(Decimal, [0, 100, 200, 300])), patch.object(fund, "post", return_value={}) as post, patch.object(fund.time, "sleep"):
            self.assertEqual(fund.fund("rPublic", Decimal(100), Decimal(300), 1), (0, 300))
            self.assertEqual(post.call_count, 3)
            post.assert_called_with(fund.FAUCET, {"destination": "rPublic"})

    def test_rate_limit_backoff(self):
        from urllib.error import HTTPError
        error = HTTPError(fund.FAUCET, 429, "limited", {"Retry-After": "8"}, None)
        with patch.object(fund, "urlopen", side_effect=[error, RuntimeError("stop")]), patch.object(fund.time, "sleep") as sleep:
            with self.assertRaises(RuntimeError):
                fund.post(fund.FAUCET, {"destination": "rPublic"})
            sleep.assert_called_once_with(8)


if __name__ == "__main__":
    unittest.main()
