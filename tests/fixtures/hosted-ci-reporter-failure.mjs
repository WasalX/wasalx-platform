import test from "node:test";

test("unquarantined fixture", () => {
  throw new Error("intentional reporter fixture failure");
});
