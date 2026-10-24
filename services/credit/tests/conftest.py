import os
import tempfile

# Set before credit.config is imported. load_dotenv never overrides existing env vars, so empty
# values here keep any real Quicknode URLs in .env out of the tests.
_tmp = tempfile.mkdtemp(prefix="credit-tests-")
os.environ.update(
    {
        "MOCK": "1",
        "INTERNAL_API_KEY": "",
        "QUICKNODE_XRPL_MAINNET_URL": "",
        "QUICKNODE_XRPL_TESTNET_URL": "",
        "QUICKNODE_XRPL_DEVNET_URL": "",
        "STREAMS_NETWORK": "testnet",
        "STREAMS_ALLOW_UNSIGNED": "0",
        "QUICKNODE_STREAMS_TOKEN": "",
        "QUICKNODE_API_KEY": "",
        "MONITOR_MODE": "off",
        "PUBLIC_MIN_INTERVAL_SECONDS": "0",
        "CREDIT_DB_PATH": os.path.join(_tmp, "credit.db"),
        "API_URL": "http://api.test",
        "RISK_URL": "http://risk.test",
    }
)
