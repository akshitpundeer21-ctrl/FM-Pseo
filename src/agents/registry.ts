/**
 * Agent factory.
 *
 * Maps an agent key to its implementation. Adding an agent means adding one
 * entry here plus a row in AGENT_DEFINITIONS - the workflow engine, the task
 * system and the dashboard pick it up with no further changes.
 */
import type { ControlPlane } from "@/control-plane/control-plane";
import type { BaseAgent } from "@/agents/base";
import { KeywordResearchAgent } from "@/agents/keyword-research.agent";
import { ProgrammaticOpportunityAgent } from "@/agents/programmatic-opportunity.agent";
import { ContentStrategyAgent } from "@/agents/content-strategy.agent";
import { ContentGenerationAgent } from "@/agents/content-generation.agent";
import { FactVerificationAgent } from "@/agents/fact-verification.agent";
import { SeoOptimizationAgent } from "@/agents/seo-optimization.agent";
import { TechnicalSeoAgent } from "@/agents/technical-seo.agent";
import { InternalLinkingAgent } from "@/agents/internal-linking.agent";
import { PublishingAgent } from "@/agents/publishing.agent";
import { SearchPerformanceAgent } from "@/agents/search-performance.agent";
import { AiVisibilityAgent } from "@/agents/ai-visibility.agent";
import { QualityControlAgent } from "@/agents/quality-control.agent";
import { MasterOrchestratorAgent } from "@/agents/master-orchestrator.agent";

type AnyAgent = BaseAgent<any, any>;
type AgentConstructor = new (cp: ControlPlane) => AnyAgent;

const CONSTRUCTORS: Record<string, AgentConstructor> = {
  master_orchestrator: MasterOrchestratorAgent,
  keyword_research: KeywordResearchAgent,
  programmatic_opportunity: ProgrammaticOpportunityAgent,
  content_strategy: ContentStrategyAgent,
  content_generation: ContentGenerationAgent,
  fact_verification: FactVerificationAgent,
  seo_optimization: SeoOptimizationAgent,
  technical_seo: TechnicalSeoAgent,
  internal_linking: InternalLinkingAgent,
  publishing: PublishingAgent,
  search_performance: SearchPerformanceAgent,
  ai_visibility: AiVisibilityAgent,
  quality_control: QualityControlAgent,
};

export function createAgent(key: string, controlPlane: ControlPlane): AnyAgent {
  const Ctor = CONSTRUCTORS[key];
  if (!Ctor) throw new Error(`No implementation registered for agent "${key}"`);
  return new Ctor(controlPlane);
}

export function implementedAgentKeys(): string[] {
  return Object.keys(CONSTRUCTORS);
}
