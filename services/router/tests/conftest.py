import os
import tempfile

# Set before router.config is imported. load_dotenv never overrides existing env vars, so these
# keep real keys and AWS settings in .env out of the tests.
_tmp = tempfile.mkdtemp(prefix="router-tests-")
os.environ.update(
    {
        "INTERNAL_API_KEY": "",
        "FLEET_SOURCE": "mock",
        "STATE_BACKEND": "local",
        "QUEUE_BACKEND": "local",
        "ORCHESTRATOR": "local",
        "PRICE_SOURCES": "none",
        "SETTLEMENT": "off",
        "LEDGER_SIGNER": "api",  # router-signed tests swap in tests/fake_ledger.py; nothing reaches a real ledger
        "AWS_DEPLOY": "0",
        "AWS_LAUNCH": "0",
        "EXTERNAL_LAUNCH": "0",
        "CLOUDWATCH": "0",
        "BEDROCK_EXPLAIN": "0",
        "ROUTER_DB_PATH": os.path.join(_tmp, "router.db"),
        "API_URL": "http://api.test",
        "COMPUTE_URL": "http://compute.test",
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_DEFAULT_REGION": "us-east-2",
        "AWS_PROFILE": "",
        "ENGINE_TIME_SCALE": "2000",
        "RENTAL_TICK_SECONDS": "0.001",
        "RENTAL_TIME_SCALE": "60000",
    }
)
os.environ.pop("AWS_PROFILE", None)
