import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isXrplClassicAddress,
  parseXrplIssuedAsset,
  xrplCanonicalCurrency,
  xrplCurrencyId,
  xrplIssuedAsset,
  xrplUnitsToValue,
  xrplValueToUnits,
} from "./xrpl.js";

const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

describe("xrplValueToUnits (issued value → integer 10^-15 units)", () => {
  it.each([
    ["0.25", "250000000000000"],
    ["1", "1000000000000000"],
    ["100", "100000000000000000"],
    ["1e-2", "10000000000000"],
    ["1E-2", "10000000000000"],
    ["1.5e3", "1500000000000000000"],
    ["1.5e+3", "1500000000000000000"],
    ["25e-2", "250000000000000"],
    ["0.000000000000001", "1"], // 10^-15: the smallest unit
    ["1e-15", "1"],
    ["1000000000000000e-30", "1"], // rippled's mantissa/exponent spelling
    ["0.1000000000000000", "100000000000000"], // trailing zeros are not significant
    ["000.5", "500000000000000"],
    ["1234567890.123456", "1234567890123456000000000"], // 16 significant digits
    ["9999999999999999e80", "9999999999999999" + "0".repeat(95)], // ledger maximum
  ])("%s → %s", (value, units) => expect(xrplValueToUnits(value)).toBe(units));

  it.each(["0", "0.0", "0e5", "000", "0.000e-3"])("zero: %s → 0", (value) =>
    expect(xrplValueToUnits(value)).toBe("0"),
  );

  it.each(["0.0000000000000001", "1e-16", "1.5e-15", "0.1234567890123456"])(
    "refuses %s: finer than 10^-15",
    (value) => expect(() => xrplValueToUnits(value)).toThrow(/10\^-15/),
  );

  it.each(["12345678901234567", "1.0000000000000001e5", "10000.000000000001"])(
    "refuses %s: more than 16 significant digits",
    (value) => expect(() => xrplValueToUnits(value)).toThrow(/significant digits/),
  );

  it.each(["1e97", "1e1000000000", "1e-200"])("refuses %s: outside the ledger range", (value) =>
    expect(() => xrplValueToUnits(value)).toThrow(RangeError),
  );

  it.each([
    "-1",
    "-0.25",
    "+1",
    ".5",
    "1.",
    "1e",
    "0x10",
    "1,5",
    " 1",
    "1 ",
    "",
    "NaN",
    "Infinity",
  ])("refuses malformed %j", (value) => expect(() => xrplValueToUnits(value)).toThrow(TypeError));
});

describe("xrplUnitsToValue (integer 10^-15 units → issued value)", () => {
  it.each([
    ["250000000000000", "0.25"],
    ["1", "0.000000000000001"],
    ["1000000000000000", "1"],
    ["1500000000000000000", "1500"],
    ["0", "0"],
    ["1234567890123456000000000", "1234567890.123456"],
  ])("%s → %s", (units, value) => expect(xrplUnitsToValue(units)).toBe(value));

  it("round-trips through xrplValueToUnits", () => {
    for (const units of ["1", "7", "250000000000000", "999999999999999", "1234567890123456"])
      expect(xrplValueToUnits(xrplUnitsToValue(units))).toBe(units);
  });

  it("refuses integers with no exact XRPL amount", () => {
    expect(() => xrplUnitsToValue("12345678901234567")).toThrow(/significant digits/);
    expect(() => xrplUnitsToValue("1" + "0".repeat(111))).toThrow(/range/);
    expect(xrplUnitsToValue("1" + "0".repeat(110))).toBe("1" + "0".repeat(95));
  });

  it.each(["-1", "01", "1.5", "1e3", "", " 1"])("refuses non-integer %j", (units) =>
    expect(() => xrplUnitsToValue(units)).toThrow(TypeError),
  );
});

describe("issued-token assets", () => {
  it("validates classic addresses by checksum", () => {
    expect(isXrplClassicAddress(ISSUER)).toBe(true);
    expect(isXrplClassicAddress("rrrrrrrrrrrrrrrrrrrrrhoLvTp")).toBe(true); // ACCOUNT_ZERO
    expect(isXrplClassicAddress(ISSUER.slice(0, -1) + "W")).toBe(false);
    expect(isXrplClassicAddress("XVLhHMPHU98es4dbozjVtdWzVrDjtV5fdx1mHp98tDMoQXb")).toBe(false);
    expect(isXrplClassicAddress("0x" + "00".repeat(20))).toBe(false);
  });

  it("writes and reads `<currency>.<issuer>` with the on-ledger currency spelling", () => {
    expect(xrplIssuedAsset("USD", ISSUER)).toBe(`USD.${ISSUER}`);
    expect(xrplIssuedAsset("0000000000000000000000005553440000000000", ISSUER)).toBe(
      `USD.${ISSUER}`,
    );
    expect(xrplIssuedAsset("524c555344000000000000000000000000000000", ISSUER)).toBe(
      `524C555344000000000000000000000000000000.${ISSUER}`,
    );
    expect(parseXrplIssuedAsset(`usd.${ISSUER}`)).toEqual({
      currency: "0000000000000000000000007573640000000000",
      issuer: ISSUER,
    });
    expect(xrplCanonicalCurrency("usd")).toBe("usd");
  });

  it("refuses display symbols, XRP and bad issuers", () => {
    expect(() => xrplCurrencyId("RLUSD")).toThrow(TypeError);
    expect(() => parseXrplIssuedAsset(`RLUSD.${ISSUER}`)).toThrow(TypeError);
    expect(() => parseXrplIssuedAsset(`XRP.${ISSUER}`)).toThrow(TypeError);
    expect(() => parseXrplIssuedAsset("USD")).toThrow(TypeError);
    expect(() => parseXrplIssuedAsset("USD.rNotAnAddress")).toThrow(TypeError);
    expect(() => xrplIssuedAsset("USD", "rNotAnAddress")).toThrow(TypeError);
  });
});

describe("spec/vectors/xrpl-issued-amount-v1.json", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL("../../../spec/vectors/xrpl-issued-amount-v1.json", import.meta.url),
      "utf8",
    ),
  ) as {
    values: { value: string; units: string | null }[];
    units: { units: string; value: string | null }[];
  };
  it.each(doc.values)("value $value → $units", ({ value, units }) => {
    if (units === null) expect(() => xrplValueToUnits(value)).toThrow();
    else expect(xrplValueToUnits(value)).toBe(units);
  });
  it.each(doc.units)("units $units → $value", ({ units, value }) => {
    if (value === null) expect(() => xrplUnitsToValue(units)).toThrow();
    else expect(xrplUnitsToValue(units)).toBe(value);
  });
});
