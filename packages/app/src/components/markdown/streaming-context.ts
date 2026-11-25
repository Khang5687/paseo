import { createContext } from "react";

/** True while the Markdown above a fence is still arriving, so the fence may be incomplete. */
export const MarkdownStreamingContext = createContext(false);
