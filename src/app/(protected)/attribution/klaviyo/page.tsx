import { KlaviyoAccessGate } from "@/components/blocks/attribution/klaviyo/klaviyo-access-gate";
import { KlaviyoPlayground } from "@/components/blocks/attribution/klaviyo/klaviyo-playground";

export default function KlaviyoPage() {
  return (
    <KlaviyoAccessGate>
      <KlaviyoPlayground />
    </KlaviyoAccessGate>
  );
}
