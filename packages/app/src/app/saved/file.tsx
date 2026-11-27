import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SavedFileScreen } from "@/offline-files/library-screen";

export default function SavedFileRoute() {
  const { serverId, path } = useLocalSearchParams<{ serverId?: string; path?: string }>();
  return (
    <HostRouteBootstrapBoundary>
      <SavedFileScreen serverId={serverId ?? ""} path={path ?? ""} />
    </HostRouteBootstrapBoundary>
  );
}
