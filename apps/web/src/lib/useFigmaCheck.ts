"use client";

import { useCallback, useEffect, useState } from "react";
import { checkFigma, cleanLink, type FigmaCheck } from "./design-tasks";
import { isFigmaDesignUrl } from "./figmaLink";

/** Typing pauses this long before Figma is asked: a link being pasted or edited is not asked about letter by letter. */
export const CHECK_DELAY_MS = 600;

export interface FigmaCheckState {
  /** Figma's answer for exactly this link, or null while it has not been asked or is being asked. */
  checked: FigmaCheck | null;
  checking: boolean;
  /** Ask again for the same link (the designer changed the sharing in Figma). */
  recheck: () => void;
}

/**
 * Asks the server whether Figma can open the link, after a pause. A link that is not a Figma file is not asked about (the
 * form already says so), and an answer for a link that has since been edited is thrown away. A failed request is
 * "unreachable", the same answer as Figma itself not answering: the designer is warned, not blocked.
 */
export function useFigmaCheck(raw: string, enabled = true): FigmaCheckState {
  const link = cleanLink(raw);
  const askable = enabled && isFigmaDesignUrl(link);
  const [answer, setAnswer] = useState<{ link: string; check: FigmaCheck } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!askable) return;
    let live = true;
    const timer = setTimeout(() => {
      checkFigma(link)
        .then((check) => live && setAnswer({ link, check }))
        .catch(() => live && setAnswer({ link, check: { state: "unreachable" } }));
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [askable, link, nonce]);

  const checked = askable && answer && answer.link === link ? answer.check : null;
  const recheck = useCallback(() => {
    setAnswer(null);
    setNonce((n) => n + 1);
  }, []);
  return { checked, checking: askable && !checked, recheck };
}
