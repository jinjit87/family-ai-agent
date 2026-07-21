-- AlterEnum
ALTER TYPE "Urgency" ADD VALUE IF NOT EXISTS 'CRITICAL';

-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM (
  'BILL',
  'RECEIPT',
  'PACKAGE',
  'TRAVEL',
  'WORK',
  'PERSONAL',
  'LEGAL',
  'FINANCIAL',
  'SECURITY',
  'MARKETING',
  'OTHER'
);

-- AlterTable
ALTER TABLE "InboxItem"
  ADD COLUMN IF NOT EXISTS "category" "EmailCategory",
  ADD COLUMN IF NOT EXISTS "requiresAction" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "dueDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suggestedTask" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InboxItem_category_idx" ON "InboxItem"("category");
CREATE INDEX IF NOT EXISTS "InboxItem_requiresAction_idx" ON "InboxItem"("requiresAction");
CREATE INDEX IF NOT EXISTS "InboxItem_dueDate_idx" ON "InboxItem"("dueDate");
