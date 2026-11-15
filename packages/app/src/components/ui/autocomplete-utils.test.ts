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
  const fewer = [{ id: "clear" }, { id: "exit" }];
  // A refetch adds commands above the chosen one (above-input order).
  const more = [{ id: "tdd" }, { id: "help" }, { id: "clear" }, { id: "exit" }];

  it("keeps the chosen option when more options arrive for the same query", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        choice: { id: "clear", query: "" },
        query: "",
        options: more,
      }),
    ).toBe(2);
    expect(
      resolveAutocompleteSelectedIndex({
        choice: { id: "exit", query: "" },
        query: "",
        options: more,
      }),
    ).toBe(3);
  });

  it("moves to the option nearest the input when the query changes", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        choice: { id: "tdd", query: "" },
        query: "t",
        options: more,
      }),
    ).toBe(3);
  });

  it("falls back when the chosen option is gone or nothing was chosen", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        choice: { id: "tdd", query: "" },
        query: "",
        options: fewer,
      }),
    ).toBe(1);
    expect(
      resolveAutocompleteSelectedIndex({
        choice: null,
        query: "",
        options: fewer,
      }),
    ).toBe(1);
    expect(
      resolveAutocompleteSelectedIndex({
        choice: { id: "exit", query: "" },
        query: "",
        options: [],
      }),
    ).toBe(-1);
  });
});
