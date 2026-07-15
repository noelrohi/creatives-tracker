import { router } from "../init";
import { studioBrandProcedures } from "./studio.brand";
import { studioGenerationProcedures } from "./studio.generations";
import { studioPackageProcedures } from "./studio.packages";
import { studioSuggestionProcedures } from "./studio.suggestions";
import { studioSwipeProcedures } from "./studio.swipes";
import { studioTaxonomyProcedures } from "./studio.taxonomy";
import { studioWinnerProcedures } from "./studio.winners";

// One flat `studio.*` namespace assembled from per-domain procedure files so
// client callsites and the tRPC path shape stay unchanged.
export const studioRouter = router({
  ...studioBrandProcedures,
  ...studioTaxonomyProcedures,
  ...studioSwipeProcedures,
  ...studioPackageProcedures,
  ...studioSuggestionProcedures,
  ...studioGenerationProcedures,
  ...studioWinnerProcedures,
});
