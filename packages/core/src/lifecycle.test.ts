import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminal } from "./lifecycle.js";

describe("job lifecycle", () => {
  it("allows the escrow happy path", () => {
    expect(canTransition("quoted", "escrowed")).toBe(true);
    expect(canTransition("escrowed", "delivered")).toBe(true);
    expect(canTransition("delivered", "released")).toBe(true);
  });

  it("never leaves a terminal state", () => {
    expect(isTerminal("released")).toBe(true);
    expect(() => assertTransition("released", "refunded")).toThrow(/illegal/);
  });

  it("cannot release without delivery", () => {
    expect(canTransition("escrowed", "released")).toBe(false);
  });
});
