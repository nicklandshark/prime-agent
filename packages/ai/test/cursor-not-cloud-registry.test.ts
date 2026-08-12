import { describe, expect, it } from "vitest";
import { getApiProvider, resetApiProviders } from "../src/index.js";

describe("cursor provider registry coexistence", () => {
	it("keeps cloud and subscription APIs distinct before and after reset", () => {
		for (let pass = 0; pass < 2; pass++) {
			const cloud = getApiProvider("cursor-cloud-agents");
			const subscription = getApiProvider("cursor-not-cloud");
			expect(cloud?.api).toBe("cursor-cloud-agents");
			expect(subscription?.api).toBe("cursor-not-cloud");
			expect(cloud?.stream).not.toBe(subscription?.stream);
			expect(cloud?.streamSimple).not.toBe(subscription?.streamSimple);
			resetApiProviders();
		}
	});
});
