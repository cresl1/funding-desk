// Prints a rates.json snapshot (all venues) to stdout. The agent workflow publishes the same file
// to the data branch on every run; this script is for running a snapshot by hand.
import { fetchRates } from './sources.mjs';
process.stdout.write(JSON.stringify(await fetchRates(), null, 1) + '\n');
