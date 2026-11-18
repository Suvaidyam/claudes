import { useLayoutEffect, useRef, type DependencyList, type RefObject } from "react";
import { isNearBottom } from "./composer";

/**
 * Chat-style scrolling: while the owner is at the bottom of `ref`, each change in `deps` scrolls
 * to the new bottom; scrolling up stops that until they scroll back down. `resetKey` (the open
 * idea) starts following again.
 */
export function useFollowBottom(ref: RefObject<HTMLElement>, resetKey: unknown, deps: DependencyList): () => void {
  const follow = useRef(true);
  useLayoutEffect(() => { follow.current = true; }, [resetKey]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [resetKey, ...deps]);
  return () => {
    if (ref.current) follow.current = isNearBottom(ref.current);
  };
}
