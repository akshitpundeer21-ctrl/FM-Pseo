/**
 * PATCH /api/brand — update the project's brand & content knowledge.
 * Agents read this on every run, so a change here changes future output
 * without any prompt being rewritten by hand.
 */
import { z } from "zod";
import { prisma } from "@/core/db/client";
import { writeJson } from "@/core/db/json";
import { activeProject, fail, guard, ok, parseBody } from "@/app/api/_lib/handler";
import { audit } from "@/control-plane/audit";

const Body = z.object({
  brandName: z.string().min(1).optional(),
  voice: z.string().optional(),
  tone: z.string().optional(),
  targetAudience: z.string().optional(),
  writingStyle: z.string().optional(),
  readingLevel: z.string().optional(),
  ctaStyle: z.string().optional(),
  preferredTerms: z.array(z.string()).optional(),
  avoidWords: z.array(z.string()).optional(),
  avoidClaims: z.array(z.string()).optional(),
  editorialRules: z.array(z.string()).optional(),
  seoRules: z.record(z.string(), z.unknown()).optional(),
  aeoRules: z.record(z.string(), z.unknown()).optional(),
  geoRules: z.record(z.string(), z.unknown()).optional(),
  qualityStandards: z.record(z.string(), z.unknown()).optional(),
  linkingRules: z.record(z.string(), z.unknown()).optional(),
  publishingRules: z.record(z.string(), z.unknown()).optional(),
});

export async function PATCH(req: Request) {
  try {
    const auth = await guard("brand:write", 40);
    const body = await parseBody(req, Body);
    const project = await activeProject(auth);

    const data: Record<string, unknown> = {};
    for (const k of ["brandName", "voice", "tone", "targetAudience", "writingStyle", "readingLevel", "ctaStyle"] as const) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    if (body.preferredTerms) data.preferredTermsJson = writeJson(body.preferredTerms);
    if (body.avoidWords) data.avoidWordsJson = writeJson(body.avoidWords);
    if (body.avoidClaims) data.avoidClaimsJson = writeJson(body.avoidClaims);
    if (body.editorialRules) data.editorialRulesJson = writeJson(body.editorialRules);
    if (body.seoRules) data.seoRulesJson = writeJson(body.seoRules);
    if (body.aeoRules) data.aeoRulesJson = writeJson(body.aeoRules);
    if (body.geoRules) data.geoRulesJson = writeJson(body.geoRules);
    if (body.qualityStandards) data.qualityStandardsJson = writeJson(body.qualityStandards);
    if (body.linkingRules) data.linkingRulesJson = writeJson(body.linkingRules);
    if (body.publishingRules) data.publishingRulesJson = writeJson(body.publishingRules);
    data.version = { increment: 1 };

    await prisma.brandProfile.update({ where: { projectId: project.id }, data: data as never });
    await audit({
      organizationId: auth.organizationId,
      projectId: project.id,
      actorType: "USER",
      actorId: auth.userId,
      action: "brand.updated",
      entityType: "BRAND_PROFILE",
      entityId: project.id,
      meta: { fields: Object.keys(body) },
    });

    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
