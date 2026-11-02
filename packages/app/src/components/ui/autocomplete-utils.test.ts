import { describe, expect, it } from "vitest";

import {
  getAutocompleteFallbackIndex,
  orderAutocompleteOptions,
  resolveAutocompleteSelectedIndex,
} from "./autocomplete-utils";

const OPTIONS = ["alpha", "beta", "gamma"];

describe("orderAutocompleteOptions", () => {
  it("keeps first logical option closest to the input by default", () => {
    expect(orderAutocompleteOptions(OPTIONS)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("keeps normal top-down order when below-input is selected", () => {
    expect(orderAutocompleteOptions(OPTIONS, "below-input")).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("getAutocompleteFallbackIndex", () => {
  it("picks the option nearest the input by default", () => {
    expect(getAutocompleteFallbackIndex(3)).toBe(2);
    expect(getAutocompleteFallbackIndex(0)).toBe(-1);
  });

  it("picks top item when below-input ordering is used", () => {
    expect(getAutocompleteFallbackIndex(3, "below-input")).toBe(0);
  });
});

describe("resolveAutocompleteSelectedIndex", () => {
  const builtIns = [{ id: "clear" }, { id: "exit" }];
  // Provider commands arrive later and land above the built-ins (above-input order).
  const withProvider = [{ id: "tdd" }, { id: "help" }, { id: "clear" }, { id: "exit" }];

  it("keeps the highlighted option when more options arrive for the same query", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        previousOptions: builtIns,
        previousIndex: 0,
        options: withProvider,
        queryChanged: false,
      }),
    ).toBe(2);
    expect(
      resolveAutocompleteSelectedIndex({
        previousOptions: builtIns,
        previousIndex: 1,
        options: withProvider,
        queryChanged: false,
      }),
    ).toBe(3);
  });

  it("moves to the option nearest the input when the query changes", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        previousOptions: withProvider,
        previousIndex: 0,
        options: withProvider,
        queryChanged: true,
      }),
    ).toBe(3);
  });

  it("falls back when the highlighted option is gone or nothing was highlighted", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        previousOptions: withProvider,
        previousIndex: 0,
        options: builtIns,
        queryChanged: false,
      }),
    ).toBe(1);
    expect(
      resolveAutocompleteSelectedIndex({
        previousOptions: [],
        previousIndex: -1,
        options: builtIns,
        queryChanged: false,
      }),
    ).toBe(1);
    expect(
      resolveAutocompleteSelectedIndex({
        previousOptions: builtIns,
        previousIndex: 1,
        options: [],
        queryChanged: false,
      }),
    ).toBe(-1);
  });
});
