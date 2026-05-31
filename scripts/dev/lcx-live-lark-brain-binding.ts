import { pathToFileURL } from "node:url";

export {
  buildExternalChannelBindingDecision,
  buildLiveLarkBrainBindingDecision,
  runExternalChannelBinding,
} from "./lcx-external-channel-binding.js";

import {
  parseExternalChannelBindingArgs,
  printExternalChannelBindingPayload,
  runExternalChannelBinding,
} from "./lcx-external-channel-binding.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseExternalChannelBindingArgs(process.argv.slice(2));
  const payload = await runExternalChannelBinding(options);
  printExternalChannelBindingPayload(payload, options);
}
