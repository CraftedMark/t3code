import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_DISPLAY_NAMES } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("PROVIDER_DISPLAY_NAMES", () => {
  it("includes fork ACP providers", () => {
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("pi")]).toBe("Pi");
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("prime")]).toBe("Prime Agent");
  });
});
