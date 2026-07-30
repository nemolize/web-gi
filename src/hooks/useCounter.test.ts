import { act, renderHook } from "@testing-library/react";

import { useCounter } from "./useCounter";

describe("useCounter", () => {
  it("should initialize with default value of 0", () => {
    const { result } = renderHook(() => useCounter());

    expect(result.current.count).toBe(0);
  });

  it("should initialize with provided initial value", () => {
    const { result } = renderHook(() => useCounter(5));

    expect(result.current.count).toBe(5);
  });

  it("should increment count", () => {
    const { result } = renderHook(() => useCounter(0));

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(1);
  });

  it("should decrement count", () => {
    const { result } = renderHook(() => useCounter(1));

    act(() => {
      result.current.decrement();
    });

    expect(result.current.count).toBe(0);
  });

  it("should handle multiple increments", () => {
    const { result } = renderHook(() => useCounter(0));

    act(() => {
      result.current.increment();
      result.current.increment();
      result.current.increment();
    });

    expect(result.current.count).toBe(3);
  });

  it("should handle multiple decrements", () => {
    const { result } = renderHook(() => useCounter(5));

    act(() => {
      result.current.decrement();
      result.current.decrement();
    });

    expect(result.current.count).toBe(3);
  });

  it("should handle mixed increment and decrement operations", () => {
    const { result } = renderHook(() => useCounter(10));

    act(() => {
      result.current.increment();
      result.current.decrement();
      result.current.increment();
      result.current.increment();
    });

    expect(result.current.count).toBe(12);
  });
});
