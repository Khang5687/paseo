import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { NeedsYouScreen } from "@/needs-you/needs-you-screen";

export default function NeedsYouRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <NeedsYouScreen />
    </HostRouteBootstrapBoundary>
  );
}
