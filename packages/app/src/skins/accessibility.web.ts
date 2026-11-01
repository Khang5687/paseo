import { useSyncExternalStore } from "react";

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useReduceTransparency(): boolean {
  return useMediaQuery("(prefers-reduced-transparency: reduce)");
}

export function usePrefersMoreContrast(): boolean {
  return useMediaQuery("(prefers-contrast: more)");
}

export function useForcedColors(): boolean {
  return useMediaQuery("(forced-colors: active)");
}

export function useReduceMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
