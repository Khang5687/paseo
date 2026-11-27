import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SavedLibraryScreen } from "@/offline-files/library-screen";

export default function SavedRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <SavedLibraryScreen />
    </HostRouteBootstrapBoundary>
  );
}
