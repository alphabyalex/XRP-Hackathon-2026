import unittest
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("native_prepare", Path(__file__).resolve().parents[1] / "prepare.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

class NativeSecretBudget(unittest.TestCase):
    def test_eight_workers_keep_credentials_private_and_fit_native_budget(self):
        settings = {'INTERNAL_API_KEY':'private-operator', 'MOONSHIFT_ACCOUNT_KEY':'private-encryption', 'DEVNET_DEV_SEED':'private-seed', 'QUICKNODE_XRPL_TESTNET_URL':'https://private.invalid/key'}
        for letter in 'ABCDEFGH':
            settings[f'GPU_{letter}_VLLM_URL'] = f'https://private-node-{letter}.invalid'
            for field in ['MODEL_ID','WIRE_MODEL','CARD','VRAM_GB','VCPU','RAM_GB','STORAGE_GB','PROVIDER','CITY','REGION','LEASE_USD_PER_HOUR','PRICE_UPDATED_AT','PLANNING_MODEL_ID','PLANNING_TOKENS_PER_SEC','PLANNING_SAMPLE_COUNT']:
                settings[f'GPU_{letter}_{field}'] = 'public metadata: quoted safely'
        rendered, secrets = prepare.render_environment('env:\n      - MARKET_MAKER=1',settings)
        self.assertGreater(len(settings),100)
        self.assertLess(len(secrets),100)
        for key,value in secrets.items():
            self.assertNotIn(value,rendered)
            self.assertIn('ac-secret://'+key,rendered)
        self.assertIn('GPU_H_CARD=public metadata: quoted safely',rendered)
        self.assertNotIn('GPU_H_CARD',secrets)
        self.assertEqual(len(secrets),12)

if __name__ == '__main__': unittest.main()
