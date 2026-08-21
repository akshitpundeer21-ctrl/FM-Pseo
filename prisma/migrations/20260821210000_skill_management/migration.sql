-- CreateTable
CREATE TABLE "SkillVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "changeSummary" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL,
    "methodologyJson" TEXT NOT NULL DEFAULT '[]',
    "constraintsJson" TEXT NOT NULL DEFAULT '[]',
    "qualityCriteriaJson" TEXT NOT NULL DEFAULT '[]',
    "safetyRulesJson" TEXT NOT NULL DEFAULT '[]',
    "businessRulesJson" TEXT NOT NULL DEFAULT '[]',
    "inputSchemaJson" TEXT NOT NULL DEFAULT '[]',
    "outputSchemaJson" TEXT NOT NULL DEFAULT '[]',
    "outputContractJson" TEXT NOT NULL DEFAULT '{}',
    "examplesJson" TEXT NOT NULL DEFAULT '[]',
    "allowedToolsJson" TEXT NOT NULL DEFAULT '[]',
    "modelGuidanceJson" TEXT NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "activatedAt" DATETIME,
    "archivedAt" DATETIME,
    CONSTRAINT "SkillVersion_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SkillTestCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "inputJson" TEXT NOT NULL DEFAULT '{}',
    "expectationsJson" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SkillTestCase_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SkillTestRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "skillVersionId" TEXT NOT NULL,
    "testCaseId" TEXT,
    "agentKey" TEXT,
    "projectId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "inputJson" TEXT NOT NULL DEFAULT '{}',
    "outputText" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL DEFAULT '',
    "toolsRequestedJson" TEXT NOT NULL DEFAULT '[]',
    "effectiveToolsJson" TEXT NOT NULL DEFAULT '[]',
    "toolsUsedJson" TEXT NOT NULL DEFAULT '[]',
    "validationJson" TEXT NOT NULL DEFAULT '[]',
    "errorsJson" TEXT NOT NULL DEFAULT '[]',
    "confidence" REAL NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillTestRun_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillTestRun_skillVersionId_fkey" FOREIGN KEY ("skillVersionId") REFERENCES "SkillVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillTestRun_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "SkillTestCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);


-- ---------------------------------------------------------------------------
-- Data migration: every pre-versioning skill becomes an immutable v1 version.
-- Nothing is discarded - the old content columns are dropped further down only
-- after their contents have been copied into SkillVersion.
-- ---------------------------------------------------------------------------
INSERT INTO "SkillVersion" (
  "id", "skillId", "version", "status", "changeSummary", "instructions",
  "methodologyJson", "constraintsJson", "qualityCriteriaJson", "safetyRulesJson", "businessRulesJson",
  "inputSchemaJson", "outputSchemaJson", "outputContractJson", "examplesJson", "allowedToolsJson", "modelGuidanceJson",
  "createdBy", "createdAt", "updatedAt", "activatedAt"
)
SELECT
  lower(hex(randomblob(16))),
  "id",
  COALESCE("version", 1),
  CASE WHEN "isActive" = 1 THEN 'ACTIVE' ELSE 'ARCHIVED' END,
  'Initial version migrated from the pre-versioning skill library.',
  "instructions",
  "methodologyJson", "constraintsJson", '[]', '[]', '[]',
  '[]', '[]', "outputContractJson", '[]', '[]', '{}',
  'system', "createdAt", "updatedAt",
  CASE WHEN "isActive" = 1 THEN "createdAt" ELSE NULL END
FROM "Skill";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "pinnedVersionId" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "assignedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSkill_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentSkill_pinnedVersionId_fkey" FOREIGN KEY ("pinnedVersionId") REFERENCES "SkillVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentSkill" ("agentId", "id", "priority", "skillId") SELECT "agentId", "id", "priority", "skillId" FROM "AgentSkill";
DROP TABLE "AgentSkill";
ALTER TABLE "new_AgentSkill" RENAME TO "AgentSkill";
CREATE INDEX "AgentSkill_skillId_idx" ON "AgentSkill"("skillId");
CREATE INDEX "AgentSkill_pinnedVersionId_idx" ON "AgentSkill"("pinnedVersionId");
CREATE UNIQUE INDEX "AgentSkill_agentId_skillId_key" ON "AgentSkill"("agentId", "skillId");
CREATE TABLE "new_Skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "activeVersionId" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Skill_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "SkillVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Skill" ("category", "createdAt", "description", "id", "key", "name", "updatedAt", "status", "createdBy") SELECT "category", "createdAt", "description", "id", "key", "name", "updatedAt", CASE WHEN "isActive" = 1 THEN 'ACTIVE' ELSE 'INACTIVE' END, 'system' FROM "Skill";
DROP TABLE "Skill";
ALTER TABLE "new_Skill" RENAME TO "Skill";
CREATE UNIQUE INDEX "Skill_key_key" ON "Skill"("key");
CREATE UNIQUE INDEX "Skill_activeVersionId_key" ON "Skill"("activeVersionId");
CREATE INDEX "Skill_status_category_idx" ON "Skill"("status", "category");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Resolve each skill to the version migrated above.
UPDATE "Skill" SET "activeVersionId" = (
  SELECT "id" FROM "SkillVersion"
  WHERE "SkillVersion"."skillId" = "Skill"."id" AND "SkillVersion"."status" = 'ACTIVE'
  LIMIT 1
);

-- CreateIndex
CREATE INDEX "SkillVersion_skillId_status_idx" ON "SkillVersion"("skillId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SkillVersion_skillId_version_key" ON "SkillVersion"("skillId", "version");

-- CreateIndex
CREATE INDEX "SkillTestCase_skillId_idx" ON "SkillTestCase"("skillId");

-- CreateIndex
CREATE INDEX "SkillTestRun_skillId_createdAt_idx" ON "SkillTestRun"("skillId", "createdAt");

-- CreateIndex
CREATE INDEX "SkillTestRun_skillVersionId_idx" ON "SkillTestRun"("skillVersionId");

