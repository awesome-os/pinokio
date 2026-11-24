export const PINOKIO_VERSION = '0.1.0';

export {
  DEFAULT_CAS_INDEX_URL,
  DEFAULT_CAS_RELEASE_BASE_URL,
  DEBLOATED_PYPI_PACKAGES,
  fetchCasIndex,
  getDefaultCasCacheDir,
  hydrateCasWheel,
  interceptPipCommand,
  normalizePackageName,
  resolveCasPythonPackage,
  resolveGhostAbi,
  type CasHit,
  type CasIndex,
  type CasIndexEntry,
  type DebloatedPypiPackage,
  type HydratedArtifact,
  type HydrateOptions,
  type InterceptResult,
} from './cas-interceptor.mts';

export {
  inspectRecipe,
  interpolateTemplate,
  loadRecipe,
  runRecipe,
  type PinokioRecipe,
  type PinokioStep,
  type RecipeEvent,
  type RecipeInspection,
  type RunRecipeOptions,
  type RunRecipeResult,
  type StepTrace,
  type TemplateContext,
} from './recipe-runner.mts';

export {
  getDefaultSectiumPipePath,
  SectiumPinokioSurface,
  type SectiumChannel,
  type SectiumPipeFrame,
  type SectiumSurfaceOptions,
} from './sectium-surface.mts';
