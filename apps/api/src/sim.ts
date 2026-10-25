// Compatibility names for old operator scripts. Activity is now bounded real
// devnet trading, never synthetic inference, metering, revenue or history.
export { startDevActivity as startSim, stopDevActivity as stopSim, isDevActivityRunning as isSimRunning } from './devActivity.js';
