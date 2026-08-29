import { PrimeSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { PRIME_ACP_PROFILE } from "../acp/PrimeAcpProfile.ts";
import { makeAcpAgentDriver, type AcpAgentDriverEnv } from "./AcpAgentDriver.ts";

const decodePrimeSettings = Schema.decodeSync(PrimeSettings);

export type PrimeDriverEnv = AcpAgentDriverEnv;
export const PrimeDriver = makeAcpAgentDriver({
  profile: PRIME_ACP_PROFILE,
  configSchema: PrimeSettings,
  defaultConfig: () => decodePrimeSettings({}),
});
