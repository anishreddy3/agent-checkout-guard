// Prints a fresh AP2 key set (platform Trusted Surface key + one key per
// example seller) as JSON, for the ap2-keys secret. Used once by deploy.sh.
import { generateKeySet } from '../server/ap2/keys.js';

process.stdout.write(JSON.stringify(generateKeySet()));
