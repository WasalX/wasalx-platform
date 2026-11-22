import type { Named } from "./types.cjs";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Intentional compiler diagnostic.
import { unused } from "./types.cjs";

export const mismatch: number = "text";
export const missing: Named = {};
export type WrongGeneric = Array<string, number>;
