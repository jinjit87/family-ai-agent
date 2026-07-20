-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "company" TEXT;

-- CreateIndex: soft-delete filters use deletedAt IS NULL
CREATE INDEX "Contact_deletedAt_idx" ON "Contact"("deletedAt");

-- CreateIndex: list sort=name and name lookups
CREATE INDEX "Contact_name_idx" ON "Contact"("name");

-- CreateIndex: list sort=updatedAt
CREATE INDEX "Contact_updatedAt_idx" ON "Contact"("updatedAt");
