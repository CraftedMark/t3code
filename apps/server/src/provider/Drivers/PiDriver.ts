import { PiSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { PI_ACP_PROFILE } from "../acp/PiAcpProfile.ts";
import { makeAcpAgentDriver, type AcpAgentDriverEnv } from "./AcpAgentDriver.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

export type PiDriverEnv = AcpAgentDriverEnv;
export const PiDriver = makeAcpAgentDriver({
  profile: PI_ACP_PROFILE,
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
});
