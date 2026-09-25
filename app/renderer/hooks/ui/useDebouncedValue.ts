import { useEffect, useState } from "react";

// The value, once it has held still for `ms`. For a value that moves
// with every keystroke and feeds something worth not doing per key.
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
