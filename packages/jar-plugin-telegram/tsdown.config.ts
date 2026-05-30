import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/plugin.ts"],
	format: "esm",
	dts: true,
	clean: true,
	sourcemap: true,
});
