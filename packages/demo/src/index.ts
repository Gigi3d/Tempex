export {
  SCENARIOS,
  DEFAULT_SCENARIO,
  bundleFor,
  caseFor,
  jobFor,
  scenarioById,
  termsFor,
  type DemoParties,
  type Scenario,
  type ScenarioExpectation,
  type ScenarioId,
} from './scenarios.js';

export {
  DEMO_STAGES,
  STAGE_META,
  Transcript,
  type Beat,
  type DemoStage,
} from './transcript.js';

export {
  ARBITRATION_FEE_BPS,
  PREDICT_PARTIES,
  caseHashes,
  predictAll,
  predictScenario,
  renderPredictions,
  type Prediction,
  type PredictedCriterion,
  type PredictedMoney,
} from './predict.js';

export { drill, renderDrill, type DrillProposal, type DrillReport, type DrillRow } from './drill.js';

export {
  runDemo,
  type DemoOptions,
  type DemoResult,
  type DemoRole,
  type DemoSession,
  type ExpectationCheck,
} from './runner.js';
