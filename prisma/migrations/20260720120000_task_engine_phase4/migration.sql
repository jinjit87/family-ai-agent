-- Phase 4: Task Engine — extend Task model and enums

-- Rename dueAt → dueDate
ALTER TABLE "Task" RENAME COLUMN "dueAt" TO "dueDate";
ALTER INDEX "Task_dueAt_idx" RENAME TO "Task_dueDate_idx";

-- Add new columns
ALTER TABLE "Task" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "source" TEXT;
ALTER TABLE "Task" ADD COLUMN "conversationId" TEXT;

-- Create TaskSource enum and set column type with default
CREATE TYPE "TaskSource" AS ENUM ('MANUAL', 'EMAIL', 'WHATSAPP', 'CALENDAR', 'AI');
UPDATE "Task" SET "source" = 'MANUAL' WHERE "source" IS NULL;
ALTER TABLE "Task" ALTER COLUMN "source" SET DATA TYPE "TaskSource" USING "source"::"TaskSource";
ALTER TABLE "Task" ALTER COLUMN "source" SET DEFAULT 'MANUAL';
ALTER TABLE "Task" ALTER COLUMN "source" SET NOT NULL;

-- Migrate TaskPriority: add URGENT
ALTER TYPE "TaskPriority" ADD VALUE IF NOT EXISTS 'URGENT';

-- Migrate TaskStatus values via a new enum
-- Map: PENDING→OPEN, IN_PROGRESS→IN_PROGRESS, DONE→COMPLETED, CANCELLED→ARCHIVED
CREATE TYPE "TaskStatus_new" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'ARCHIVED');

ALTER TABLE "Task" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Task"
  ALTER COLUMN "status" TYPE "TaskStatus_new"
  USING (
    CASE "status"::text
      WHEN 'PENDING' THEN 'OPEN'::"TaskStatus_new"
      WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'::"TaskStatus_new"
      WHEN 'DONE' THEN 'COMPLETED'::"TaskStatus_new"
      WHEN 'CANCELLED' THEN 'ARCHIVED'::"TaskStatus_new"
      ELSE 'OPEN'::"TaskStatus_new"
    END
  );

DROP TYPE "TaskStatus";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";
ALTER TABLE "Task" ALTER COLUMN "status" SET DEFAULT 'OPEN'::"TaskStatus";

-- Foreign key for conversationId
ALTER TABLE "Task" ADD CONSTRAINT "Task_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "Task_priority_idx" ON "Task"("priority");
CREATE INDEX "Task_source_idx" ON "Task"("source");
CREATE INDEX "Task_conversationId_idx" ON "Task"("conversationId");
CREATE INDEX "Task_updatedAt_idx" ON "Task"("updatedAt");
