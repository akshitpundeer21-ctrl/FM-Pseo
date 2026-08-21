/**
 * Internal Linking Agent.
 *
 * Builds the entity graph for the project's pages, proposes links above the
 * configured relevance floor, and reports orphans. Links are persisted as
 * proposals so a human (or the publishing flow) can accept them; nothing is
 * silently injected into live content.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { readJson } from "@/core/db/json";
import { BaseAgent, type AgentOutcome, type AgentRunContext, type ValidationRule } from "@/agents/base";
import { findOrphans, proposeLinks, routeEntities, type LinkablePage } from "@/engine/linking/linker";

const InputSchema = z.object({
  pageId: z.string().optional(),
  projectWide: z.boolean().optional(),
  relevanceFloor: z.number().min(0).max(1).optional(),
});

const OutputSchema = z.object({
  pagesProcessed: z.number(),
  proposed: z.number(),
  persisted: z.number(),
  orphans: z.array(z.string()),
  links: z.array(
    z.object({ fromUrl: z.string(), targetUrl: z.string(), anchorText: z.string(), relevance: z.number(), reason: z.string() }),
  ),
});

export type InternalLinkingInput = z.infer<typeof InputSchema>;
export type InternalLinkingOutput = z.infer<typeof OutputSchema>;

export class InternalLinkingAgent extends BaseAgent<InternalLinkingInput, InternalLinkingOutput> {
  readonly key = "internal_linking";
  readonly inputSchema = InputSchema;
  readonly outputSchema = OutputSchema;

  readonly validationRules: ValidationRule<InternalLinkingOutput>[] = [
    {
      name: "no_links_to_nothing",
      check: (o) => o.links.every((l) => l.targetUrl.startsWith("/") || l.targetUrl.startsWith("http")),
      message: "A proposed link has an invalid target",
    },
  ];

  protected async perform(input: InternalLinkingInput, ctx: AgentRunContext): Promise<AgentOutcome<InternalLinkingOutput>> {
    const floor = input.relevanceFloor ?? ctx.brand?.linkingRules?.relevanceFloor ?? 0.35;
    const maxLinks = ctx.brand?.linkingRules?.maxInternalLinks ?? 12;
    const minLinks = ctx.brand?.linkingRules?.minInternalLinks ?? 3;

    const allPages = await prisma.page.findMany({
      where: { projectId: ctx.projectId },
      select: { id: true, url: true, title: true, status: true, variablesJson: true, pageFamily: { select: { key: true } } },
    });

    const graph: LinkablePage[] = allPages.map((p) => {
      const v = readJson<{ origin?: string; destination?: string; originCity?: string; destinationCity?: string }>(p.variablesJson, {});
      return {
        id: p.id,
        url: p.url,
        title: p.title,
        pageType: p.pageFamily?.key?.toUpperCase().includes("AIRPORT") ? "AIRPORT" : "ROUTE",
        status: p.status,
        entities:
          v.origin && v.destination
            ? routeEntities({
                origin: v.origin,
                destination: v.destination,
                originCity: v.originCity,
                destinationCity: v.destinationCity,
              })
            : [],
      };
    });

    const targets = input.pageId
      ? graph.filter((p) => p.id === input.pageId)
      : input.projectWide
        ? graph
        : graph.filter((p) => p.status !== "REJECTED");

    let proposed = 0;
    let persisted = 0;
    const links: InternalLinkingOutput["links"] = [];

    for (const page of targets) {
      const result = proposeLinks(page, graph, { relevanceFloor: floor, maxLinks });
      proposed += result.proposals.length;

      if (result.proposals.length < minLinks) {
        ctx.logger.warn("page has fewer internal links than the brand minimum", {
          url: page.url,
          proposed: result.proposals.length,
          minLinks,
        });
      }

      for (const p of result.proposals) {
        const existing = await prisma.internalLink.findFirst({
          where: { projectId: ctx.projectId, fromPageId: page.id, targetUrl: p.targetUrl },
        });
        if (existing) {
          await prisma.internalLink.update({
            where: { id: existing.id },
            data: { anchorText: p.anchorText, relevance: p.relevance, reason: p.reason },
          });
        } else {
          await prisma.internalLink.create({
            data: {
              projectId: ctx.projectId,
              fromPageId: page.id,
              toPageId: p.toPageId,
              targetUrl: p.targetUrl,
              anchorText: p.anchorText,
              relevance: p.relevance,
              reason: p.reason,
              status: "PROPOSED",
            },
          });
          persisted++;
        }
        links.push({ fromUrl: page.url, targetUrl: p.targetUrl, anchorText: p.anchorText, relevance: p.relevance, reason: p.reason });
      }
    }

    const existingLinks = await prisma.internalLink.findMany({ where: { projectId: ctx.projectId }, select: { toPageId: true } });
    const orphans = findOrphans(graph, existingLinks).map((p) => p.url);

    return {
      output: { pagesProcessed: targets.length, proposed, persisted, orphans, links: links.slice(0, 100) },
      confidence: targets.length ? 0.85 : 0.5,
      summary: `Proposed ${proposed} link(s) across ${targets.length} page(s); ${persisted} new. ${orphans.length} orphan page(s).`,
      nextAction: orphans.length ? "Add inbound links to the orphaned pages" : "Link graph is connected",
    };
  }
}
