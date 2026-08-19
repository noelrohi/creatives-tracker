import { PrivilegedAccessGate } from "@/components/blocks/attribution/privileged-access-gate";
import { GoogleAdsLab } from "@/components/blocks/attribution/google-ads/google-ads-lab";

export default function GoogleAdsLabPage() {
  return (
    <PrivilegedAccessGate>
      <GoogleAdsLab />
    </PrivilegedAccessGate>
  );
}
