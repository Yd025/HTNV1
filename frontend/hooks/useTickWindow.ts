import { useEffect, useRef, useState } from "react";
import { TickWindow } from "../lib/tickWindow";
import type { SwarmState } from "../lib/types";

/** Keep this in the page so samples accumulate while other tabs are visible. */
export function useTickWindow(state: SwarmState, isFresh: boolean) {
  const window = useRef(new TickWindow());
  const [summary, setSummary] = useState(() => window.current.summarize(0));
  useEffect(() => {
    window.current.add(state, performance.now(), isFresh);
  }, [state, isFresh]);
  useEffect(() => {
    const update = () => setSummary(window.current.summarize(performance.now()));
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, []);
  return summary;
}
