import { useCallback, useEffect, type ReactElement } from "react";
import { FilePathMenu, useFilePathMenuPaths, type FilePathMenuPoint } from "@/file-path-menu/menu";
import type { TerminalLocalFileLinkTarget } from "./terminal-local-link-provider";

export interface TerminalFileLinkMenuRequest {
  /** Distinguishes two right clicks on the same link, so each one reopens the menu. */
  id: number;
  target: TerminalLocalFileLinkTarget;
  point: FilePathMenuPoint;
}

/**
 * The file menu for a right-clicked terminal file link. Mount it keyed by `request.id`: it opens
 * once, at the click, when it mounts.
 */
export function TerminalFileLinkMenu({
  serverId,
  cwd,
  request,
}: {
  serverId: string;
  cwd: string;
  request: TerminalFileLinkMenuRequest;
}): ReactElement | null {
  const paths = useFilePathMenuPaths({ serverId, workspaceRoot: cwd, path: request.target.path });
  const { target } = request;
  const resolveTarget = useCallback(async () => target, [target]);
  if (!paths) {
    return null;
  }
  return (
    <FilePathMenu
      serverId={serverId}
      workspaceRoot={cwd}
      paths={paths}
      resolveTarget={resolveTarget}
    >
      {(openAtPoint) => <OpenAtPointOnMount openAtPoint={openAtPoint} point={request.point} />}
    </FilePathMenu>
  );
}

function OpenAtPointOnMount({
  openAtPoint,
  point,
}: {
  openAtPoint: (point: FilePathMenuPoint) => void;
  point: FilePathMenuPoint;
}): null {
  useEffect(() => {
    openAtPoint(point);
    // Opens once per mount; the parent remounts this for every new right click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
